import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { getUserBySession } from "../authService.js";
import { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { CompIQEstimateRequest } from "../../types/compiq.types.js";
import { computeEstimate } from "../compiq/compiqEstimate.service.js";
// CF-GRADED-RAIL-WIRE-IN (2026-06-14): assemble the same gradedEstimates
// array /price-by-id surfaces, so a graded holding's stored valuation
// can mirror the rail's grounded/insufficient verdict at write time.
import { compileGradedEstimatesForCard } from "../compiq/compileGradedEstimatesForCard.js";
import { getPricing as getPricingForMarketRead } from "../compiq/cardsight.client.js";
import { buildGradeBreakdown } from "../compiq/marketRead.service.js";
import { resolvePlayer } from "../mlb/playerResolver.service.js";
import { deleteBlobByUrl } from "../photoStorage/photoStorage.service.js";
import { resolveCardsightGradeId } from "../cardsight/cardsightGradesTaxonomy.js";
import { composeHoldingWireShape, composePortfolioListResponse } from "./responseAssembly.js";
import {
  tryFinalizeReconciliation,
  type LedgerEntryForErp,
} from "./erpReconciliation.service.js";

// ─── Cosmos DB client (lazy init) ─────────────────────────────────────────────
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

// ─── In-memory fallback for tests only ────────────────────────────────────────
const testMemStore = new Map<string, UserDoc>();
const isTestMode = process.env.NODE_ENV === "test";

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      
      // Test mode: allow in-memory fallback for tests
      if (!endpoint && !connStr) {
        if (isTestMode) {
          console.log("[portfolio] TEST MODE: Using in-memory store (not for production)");
          return null;
        }
        throw new Error("[portfolio] COSMOS configuration is required (COSMOS_ENDPOINT or COSMOS_CONNECTION_STRING must be set)");
      }
      
      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      }
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: "portfolio",
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log("[portfolio] Cosmos DB connected");
      return container;
    } catch (err: any) {
      throw new Error(`[portfolio] Cosmos initialization failed: ${err.message}`);
    }
  })();
  return _initPromise;
}

// ─── In-process 30-second read cache ─────────────────────────────────────────
const readCache = new Map<string, { doc: UserDoc; expiresAt: number }>();

function getCached(userId: string): UserDoc | null {
  const entry = readCache.get(userId);
  if (!entry || Date.now() > entry.expiresAt) { readCache.delete(userId); return null; }
  return entry.doc;
}
function setCache(userId: string, doc: UserDoc) {
  readCache.set(userId, { doc, expiresAt: Date.now() + 30_000 });
}
function invalidateCache(userId: string) { readCache.delete(userId); }

// ─── Cosmos document shape ────────────────────────────────────────────────────
interface UserDoc {
  id: string;
  userId: string;
  holdings: Record<string, PortfolioHolding>;
  ledger: PortfolioLedgerEntry[];
  priceHistoryByHolding: Record<string, PortfolioPricePoint[]>;
  alerts: PortfolioAlert[];
  recommendationFeedback: RecommendationFeedback[];
  // CF-ERP-EXPANSION-#7: trade history. Atomic with ledger + holdings
  // mutations on POST /erp/trades.
  trades?: TradeTransaction[];
}

// ── CF-ERP-EXPANSION-#7 trade transaction shape ─────────────────────────────

export interface TradeTransaction {
  id: string;
  userId: string;
  tradeDate: string;          // ISO timestamp
  counterparty?: string;
  salesChannel?: SalesChannel;
  saleLocation?: SaleLocation;
  cashToMe: number;           // signed; + received, − paid
  cashPaymentMethod?: PaymentMethod;
  note?: string;
  outgoing: TradeOutgoingRecord[];
  incoming: TradeIncomingRecord[];
  totals: {
    fmvOut: number;
    fmvIn: number;
    cashToMe: number;
    amountRealized: number;
    basisGivenUp: number;
    realizedGainLoss: number;
    balanceCheck: number;
  };
  createdAt: string;
}

export interface TradeOutgoingRecord {
  holdingId: string;
  fmvAtTrade: number;
  fmvSource: "compiq" | "manual";
  costBasis: number;
  proceeds: number;
  realizedGainLoss: number;
  ledgerEntryId: string;
}

export interface TradeIncomingRecord {
  holdingId: string;          // new holding id
  cardsightCardId?: string;
  cardTitle: string;
  grade?: string;
  fmvAtTrade: number;
  fmvSource: "compiq" | "manual";
}

interface PortfolioPricePoint {
  at: string;
  value: number;
  source?: string;
}

interface PortfolioAlert {
  id: string;
  level: "info" | "warning" | "critical";
  type: "value-move" | "cost-basis-cross" | "stale-data" | "liquidity-risk";
  createdAt: string;
  holdingId: string;
  playerName: string;
  cardTitle: string;
  message: string;
  context?: Record<string, number | string | boolean | null>;
}

interface RecommendationFeedback {
  id: string;
  holdingId: string;
  recommendation: string;
  actionTaken: "followed" | "ignored" | "partial";
  notes?: string;
  createdAt: string;
}

export async function readUserDoc(userId: string): Promise<UserDoc> {
  const cached = getCached(userId);
  if (cached) return cached;

  const container = await getContainer();
  
  // Test mode: use in-memory store
  if (!container && isTestMode) {
    if (!testMemStore.has(userId)) {
      testMemStore.set(userId, {
        id: userId,
        userId,
        holdings: {},
        ledger: [],
        priceHistoryByHolding: {},
        alerts: [],
        recommendationFeedback: [],
      });
    }
    const doc = testMemStore.get(userId)!;
    setCache(userId, doc);
    return doc;
  }
  
  if (!container) {
    throw new Error("[portfolio] Cosmos container is not available and test mode is not enabled");
  }
  
  try {
    const { resource } = await container.item(userId, userId).read<UserDoc>();
    const doc = resource
      ? {
          ...resource,
          priceHistoryByHolding: resource.priceHistoryByHolding ?? {},
          alerts: resource.alerts ?? [],
          recommendationFeedback: resource.recommendationFeedback ?? [],
        }
      : {
          id: userId,
          userId,
          holdings: {},
          ledger: [],
          priceHistoryByHolding: {},
          alerts: [],
          recommendationFeedback: [],
        };
    setCache(userId, doc);
    return doc;
  } catch (err: any) {
    if (err.code === 404) {
      const doc: UserDoc = {
        id: userId,
        userId,
        holdings: {},
        ledger: [],
        priceHistoryByHolding: {},
        alerts: [],
        recommendationFeedback: [],
      };
      setCache(userId, doc);
      return doc;
    }
    throw err;
  }
}

export async function writeUserDoc(userId: string, doc: UserDoc): Promise<void> {
  invalidateCache(userId);
  const container = await getContainer();

  // Test mode: use in-memory store
  if (!container && isTestMode) {
    testMemStore.set(userId, doc);
    return;
  }

  if (!container) {
    throw new Error("[portfolio] Cosmos container is not available and test mode is not enabled");
  }

  await container.items.upsert(doc);
}

/**
 * CF-ACCOUNT-DELETION (2026-06-04): purge the entire portfolio doc for a
 * user (holdings + ledger + trades + priceHistoryByHolding + alerts +
 * recommendationFeedback). One doc per user, id == userId.
 *
 * Returns a count summary so the /api/account purge response can report
 * exactly what was removed: holdingCount + ledgerCount + tradeCount.
 */
export interface PortfolioDocDeletionSummary {
  existed: boolean;
  holdingCount: number;
  ledgerCount: number;
  tradeCount: number;
  expensesEmbeddedCount: number;
}

export async function deletePortfolioDocForUser(
  userId: string,
): Promise<PortfolioDocDeletionSummary> {
  invalidateCache(userId);
  const container = await getContainer();

  // Test mode in-memory store
  if (!container && isTestMode) {
    const doc = testMemStore.get(userId);
    if (!doc) {
      return { existed: false, holdingCount: 0, ledgerCount: 0, tradeCount: 0, expensesEmbeddedCount: 0 };
    }
    const summary: PortfolioDocDeletionSummary = {
      existed: true,
      holdingCount: Object.keys(doc.holdings ?? {}).length,
      ledgerCount: (doc.ledger ?? []).length,
      tradeCount: (doc.trades ?? []).length,
      expensesEmbeddedCount: 0,
    };
    testMemStore.delete(userId);
    return summary;
  }

  if (!container) {
    return { existed: false, holdingCount: 0, ledgerCount: 0, tradeCount: 0, expensesEmbeddedCount: 0 };
  }

  // Read once to capture counts, then delete.
  let summary: PortfolioDocDeletionSummary = {
    existed: false, holdingCount: 0, ledgerCount: 0, tradeCount: 0, expensesEmbeddedCount: 0,
  };
  try {
    const { resource } = await container.item(userId, userId).read<UserDoc>();
    if (resource) {
      summary = {
        existed: true,
        holdingCount: Object.keys((resource as any).holdings ?? {}).length,
        ledgerCount: ((resource as any).ledger ?? []).length,
        tradeCount: ((resource as any).trades ?? []).length,
        expensesEmbeddedCount: 0,
      };
    }
  } catch (err: any) {
    if (err?.code !== 404) {
      console.error("[portfolio] deletePortfolioDocForUser read failed:", err?.message ?? err);
    }
  }

  try {
    await container.item(userId, userId).delete();
  } catch (err: any) {
    if (err?.code === 404) return summary;
    console.error("[portfolio] deletePortfolioDocForUser delete failed:", err?.message ?? err);
    return summary;
  }
  return summary;
}

interface PortfolioLedgerEntry {
  id: string;
  userId: string;
  holdingId: string;
  playerName: string;
  cardTitle: string;
  quantitySold: number;
  unitSalePrice: number;
  grossProceeds: number;
  fees: number;
  tax: number;
  shipping: number;
  netProceeds: number;
  costBasisSold: number;
  realizedProfitLoss: number;
  realizedProfitLossPct: number;
  soldAt: string;
  notes?: string;

  // ----- eBay sale provenance (PR D.6, populated only for ITEM_SOLD path) -----
  // Manual entries OMIT all of these. Readers MUST treat absent `source` as
  // "manual" and absent `needsReconciliation` as false.
  source?: "manual" | "ebay";
  ebayOrderId?: string;
  ebayOfferId?: string | null;
  ebayListingId?: string | null;
  ebayBuyerUsername?: string | null;
  ebaySaleConfirmedAt?: string;

  // Granular eBay fee fields. NULL = unknown / not yet reported by eBay.
  // NEVER coerced to 0 — that would silently inflate netProceeds.
  // The legacy top-level `fees` aggregate is set to 0 for eBay entries; the
  // reporting layer must read these granular fields when source==="ebay".
  finalValueFee?: number | null;
  paymentProcessingFee?: number | null;
  promotedListingFee?: number | null;
  adFee?: number | null;
  otherFees?: number | null;
  netPayout?: number | null;
  actualShippingCost?: number | null;
  suppliesCost?: number | null;
  gradingCost?: number | null;

  // True when the entry is not yet REconciled across BOTH axes:
  //   axis 1 — eBay fees: all 7 granular fee fields non-null
  //   axis 2 — user costs: userCostsProvidedAt is set (the ACTION of saving,
  //            even with zero values, counts as addressed)
  // Cleared only by tryFinalizeReconciliation when both axes are satisfied.
  // While true, the entry is EXCLUDED from /pnl + /tax-export totals.
  needsReconciliation?: boolean;

  // CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): marker set by save-costs
  // route AND by updateLedgerEntry (PATCH) when the user supplies grading or
  // supplies cost on an unreconciled eBay entry. The TIMESTAMP records the
  // action; the VALUES live in gradingCost / suppliesCost. Independent of
  // dismissedAt (UI-quieting) and of feeSource (provenance of fees).
  userCostsProvidedAt?: string | null;
  userCostsProvidedBy?: string | null;

  // CF-PR-E-TWO-AXIS-RECONCILIATION: provenance of the GRANULAR FEES on this
  // entry. Set by applyFeeEnrichment ("ebay_finances") and applyFeeOverride
  // ("manual_override"). tryFinalizeReconciliation reads this when both axes
  // are met and DERIVES reconciledVia from it — so override-then-save-costs
  // finalizes with reconciledVia="manual_override" (not "ebay_finances").
  // Reuses ReconciledVia enum values; no new enum members.
  feeSource?: ReconciledVia;

  // ----- User-dismissal of reconciliation prompts (CF-PR-E-BACKEND-ENDPOINTS) -
  // dismissedAt is a separate user signal from needsReconciliation: the
  // computed flag stays true (data is genuinely incomplete) but the iOS UI
  // can hide this entry from the "needs your attention" section once the
  // user has acknowledged. Re-setting to null reopens the prompt.
  // dismissedReason is optional free-text the user provided ("don't have
  // the receipt", "doesn't matter for this entry", etc.).
  dismissedAt?: string | null;
  dismissedReason?: string | null;

  // ----- CF-ERP-EXPANSION-#1 sales-tracking (2026-06-03) ---------------------
  // Orthogonal axes — do NOT overload `source`. Manual sales collect from
  // user; eBay webhook auto-populates salesChannel=ebay / paymentMethod=
  // ebay_managed. Legacy entries default-on-read via `source` mapping; no
  // destructive backfill.
  salesChannel?: SalesChannel;
  channelNote?: string;        // required when salesChannel === "other"
  paymentMethod?: PaymentMethod;
  paymentNote?: string;        // required when paymentMethod === "other"
  saleLocation?: SaleLocation;

  // ----- CF-ERP-EXPANSION-#6 manual fee override audit -----------------------
  // reconciledVia identifies HOW the granular fees were established. CPAs
  // need to know which figures are processor-confirmed vs hand-entered.
  reconciledVia?: ReconciledVia;
  // Append-only audit trail of manual fee overrides. Never overwritten —
  // each /unreconciled/:id/override push appends a row. Full prior-state
  // history reconstructable from this array.
  feeAdjustments?: LedgerFeeAdjustment[];
  // Annotation set by POST /unreconciled/:id/refetch — background poller
  // picks up + clears on next sweep. Read-only signal for the iOS queue.
  refetchRequestedAt?: string | null;

  // ----- CF-ERP-EXPANSION-#7 trade attribution -------------------------------
  // Set on a disposal-leg entry created by POST /erp/trades. The atomic
  // trade write creates N such ledger entries (one per outgoing card),
  // each carrying the parent TradeTransaction.id. paymentMethod is forced
  // to "trade" so 1099-K rail joins correctly EXCLUDE the card legs.
  tradeId?: string;
}

// ── CF-ERP-EXPANSION-#1 enums + structured location ─────────────────────────
//
// Closed enums on the wire; "other" is the escape hatch with mandatory
// short note (validated server-side). Free-text on the enum would let
// malformed strings into reporting groupings.

export type SalesChannel =
  | "ebay"
  | "whatnot"
  | "comc"
  | "myslabs"
  | "goldin"
  | "pwcc"
  | "instagram"
  | "facebook"
  | "card_show"
  | "in_person"
  | "other";

export type PaymentMethod =
  | "ebay_managed"
  | "paypal"
  | "venmo"
  | "zelle"
  | "cash"
  | "check"
  | "cashapp"
  | "trade"
  | "other";

export interface SaleLocation {
  venue?: string;   // ≤80 chars  — "National 2026", "Acme Card Shop"
  city?: string;    // ≤60 chars
  state?: string;   // ≤2 chars (US 2-letter, uppercase)
}

// ── CF-ERP-EXPANSION-#6 ─────────────────────────────────────────────────────

export type ReconciledVia =
  | "ebay_finances"     // populated by the eBay Finances API enrichment path
  | "manual_override"   // user supplied via POST /unreconciled/:id/override
  | "manual_entry";     // user supplied at sale time (sellHolding manual path)

export interface LedgerFeeAdjustment {
  adjustmentId: string;
  adjustedAt: string;     // ISO timestamp
  adjustedBy: string;     // userId
  reason: string;         // required, ≤500 chars
  priorValues: {
    finalValueFee: number | null;
    paymentProcessingFee: number | null;
    promotedListingFee: number | null;
    adFee: number | null;
    otherFees: number | null;
    netPayout: number | null;
    actualShippingCost: number | null;
    needsReconciliation: boolean;
    reconciledVia: ReconciledVia | undefined;
    gradingCost?: number | null;
    suppliesCost?: number | null;
    userCostsProvidedAt?: string | null;
  };
  newValues: {
    finalValueFee: number | null;
    paymentProcessingFee: number | null;
    promotedListingFee: number | null;
    adFee: number | null;
    otherFees: number | null;
    netPayout: number | null;
    actualShippingCost: number | null;
    // CF-PR-E-TWO-AXIS-RECONCILIATION: under Model A, a fee-write may NOT
    // finalize (if user costs haven't been addressed). The audit row records
    // the actual post-state — needsReconciliation can stay true, and
    // reconciledVia stays undefined until both axes are met.
    needsReconciliation: boolean;
    reconciledVia: ReconciledVia | undefined;
    // CF-PR-E-TWO-AXIS-RECONCILIATION: cost-touching writes (save-costs +
    // PATCH) emit audit rows too — these fields record the cost mutation.
    // Optional so existing fee-only adjustment shapes stay valid.
    gradingCost?: number | null;
    suppliesCost?: number | null;
    userCostsProvidedAt?: string | null;
  };
}

const VALID_SALES_CHANNELS: ReadonlySet<SalesChannel> = new Set<SalesChannel>([
  "ebay", "whatnot", "comc", "myslabs", "goldin", "pwcc",
  "instagram", "facebook", "card_show", "in_person", "other",
]);
const VALID_PAYMENT_METHODS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>([
  "ebay_managed", "paypal", "venmo", "zelle", "cash", "check",
  "cashapp", "trade", "other",
]);

function trimOrUndefined(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

export interface SalesTrackingFieldsInput {
  salesChannel?: unknown;
  channelNote?: unknown;
  paymentMethod?: unknown;
  paymentNote?: unknown;
  saleLocation?: unknown;
}

export interface SalesTrackingFieldsParsed {
  salesChannel?: SalesChannel;
  channelNote?: string;
  paymentMethod?: PaymentMethod;
  paymentNote?: string;
  saleLocation?: SaleLocation;
}

/**
 * Pure validator shared between sellHolding (POST) and validateLedgerPatch
 * (PATCH). Returns either the parsed shape or a 400-class error message.
 */
export function parseSalesTrackingFields(
  input: SalesTrackingFieldsInput,
): { ok: SalesTrackingFieldsParsed } | { error: string } {
  const out: SalesTrackingFieldsParsed = {};

  if (input.salesChannel !== undefined && input.salesChannel !== null) {
    if (typeof input.salesChannel !== "string"
        || !VALID_SALES_CHANNELS.has(input.salesChannel as SalesChannel)) {
      return { error: `salesChannel must be one of: ${Array.from(VALID_SALES_CHANNELS).join(", ")}` };
    }
    out.salesChannel = input.salesChannel as SalesChannel;
  }
  if (input.channelNote !== undefined && input.channelNote !== null) {
    const t = trimOrUndefined(input.channelNote, 100);
    if (t) out.channelNote = t;
  }
  if (out.salesChannel === "other" && !out.channelNote) {
    return { error: 'channelNote is required when salesChannel === "other"' };
  }

  if (input.paymentMethod !== undefined && input.paymentMethod !== null) {
    if (typeof input.paymentMethod !== "string"
        || !VALID_PAYMENT_METHODS.has(input.paymentMethod as PaymentMethod)) {
      return { error: `paymentMethod must be one of: ${Array.from(VALID_PAYMENT_METHODS).join(", ")}` };
    }
    out.paymentMethod = input.paymentMethod as PaymentMethod;
  }
  if (input.paymentNote !== undefined && input.paymentNote !== null) {
    const t = trimOrUndefined(input.paymentNote, 100);
    if (t) out.paymentNote = t;
  }
  if (out.paymentMethod === "other" && !out.paymentNote) {
    return { error: 'paymentNote is required when paymentMethod === "other"' };
  }

  if (input.saleLocation !== undefined && input.saleLocation !== null) {
    if (typeof input.saleLocation !== "object") {
      return { error: "saleLocation must be an object" };
    }
    const raw = input.saleLocation as Record<string, unknown>;
    const venue = trimOrUndefined(raw.venue, 80);
    const city = trimOrUndefined(raw.city, 60);
    let state: string | undefined;
    if (raw.state !== undefined && raw.state !== null) {
      if (typeof raw.state !== "string") {
        return { error: "saleLocation.state must be a string" };
      }
      const t = raw.state.trim().toUpperCase();
      if (t.length > 2) return { error: "saleLocation.state must be ≤ 2 chars (US 2-letter)" };
      if (t.length > 0) state = t;
    }
    const loc: SaleLocation = {};
    if (venue) loc.venue = venue;
    if (city) loc.city = city;
    if (state) loc.state = state;
    if (venue || city || state) out.saleLocation = loc;
  }

  return { ok: out };
}

// ── CF-PR-E-P&L-COST-RECOMPUTE: shared ledger financials helper ──────────────
//
// Single source of truth for netProceeds + realizedProfitLoss computation.
// Used by sellHolding (manual sale), markHoldingSoldFromEbay (eBay webhook),
// and updateLedgerEntry (PATCH /api/portfolio/ledger/:id).
//
// Formula:
//   netProceeds        = grossProceeds - feesTotal - tax - shipping
//                        - (gradingCost ?? 0) - (suppliesCost ?? 0)
//   realizedProfitLoss = netProceeds - costBasisSold
//   realizedProfitLossPct = (realizedProfitLoss / costBasisSold) * 100
//                           (0 when costBasisSold = 0)
//
// Why include gradingCost + suppliesCost in netProceeds (not just P&L):
//   eBay path already subtracts actualShippingCost (cost of shipping THIS
//   sale) from netProceeds. gradingCost (cost to grade the card before
//   selling) and suppliesCost (cost of packaging supplies for THIS sale)
//   are the same shape — cash out, must reduce cash returned. Treating
//   them as additional sale-cost deductions matches the existing semantic
//   without inventing a new category.
//
// eBay path override:
//   When the eBay path has an authoritative netPayout (eBay told us the
//   exact cash deposited), pass it as `netPayoutOverride` and the helper
//   uses it as the post-fee/post-shipping baseline. gradingCost +
//   suppliesCost still subtract on top, because eBay's netPayout doesn't
//   know about pre-sale grading or buyer's-side supplies.
//
// Null-safety: missing inputs default to 0. Existing entries with
// null gradingCost/suppliesCost compute identically to pre-fix behavior
// (no regression on entries that haven't recorded these costs).
interface LedgerFinancialsInput {
  grossProceeds: number;
  feesTotal: number; // for manual: fees field; for eBay: sum of granular fees
  tax?: number; // manual path only; eBay path passes 0
  shipping?: number; // manual path only; eBay's actualShippingCost is in feesTotal
  gradingCost?: number | null;
  suppliesCost?: number | null;
  costBasisSold: number;
  netPayoutOverride?: number | null; // eBay-authoritative net, pre-cost-deduction
}

interface LedgerFinancialsOutput {
  netProceeds: number;
  realizedProfitLoss: number;
  realizedProfitLossPct: number;
}

export function computeLedgerFinancials(
  input: LedgerFinancialsInput,
): LedgerFinancialsOutput {
  const grading = input.gradingCost ?? 0;
  const supplies = input.suppliesCost ?? 0;
  const tax = input.tax ?? 0;
  const shipping = input.shipping ?? 0;

  let netProceeds: number;
  if (input.netPayoutOverride != null) {
    // eBay-authoritative path: start from netPayout (already excludes
    // platform fees + actualShippingCost), then subtract user-side costs.
    netProceeds = input.netPayoutOverride - grading - supplies;
  } else {
    netProceeds =
      input.grossProceeds -
      input.feesTotal -
      tax -
      shipping -
      grading -
      supplies;
  }

  const realizedProfitLoss = netProceeds - input.costBasisSold;
  const realizedProfitLossPct =
    input.costBasisSold > 0 ? (realizedProfitLoss / input.costBasisSold) * 100 : 0;

  return { netProceeds, realizedProfitLoss, realizedProfitLossPct };
}

function normalizeId(value: unknown): string {
  const id = String(value ?? "").trim();
  return id.length > 0 ? id : randomUUID();
}

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toIso(value: unknown, fallback = new Date()): string {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase A (2026-05-31): compute currentValue
// on read from fairMarketValue (+ quantity). Two helpers because existing
// read sites use inconsistent dimensional conventions (per-unit vs total)
// invisible at quantity=1 (see CF-CURRENTVALUE-DIMENSION-CANONICALIZE
// backlog and the per-site dimension map in this CF's commit message).
// Helpers return null when FMV is absent so each caller preserves its own
// unpriced-case default. Writers continue to populate the cached field
// this phase; readers diverge to compute-on-read.
export function computePerUnitValue(holding: PortfolioHolding | undefined | null): number | null {
  if (!holding) return null;
  const fmv = (holding as { fairMarketValue?: number }).fairMarketValue;
  return typeof fmv === "number" && Number.isFinite(fmv) ? fmv : null;
}

// CF-GRADED-RAIL-WIRE-IN (2026-06-14): observed-only per-unit reader.
// Returns ONLY fairMarketValue — never an estimate. Used by every
// accounting/reporting consumer that cannot tolerate estimated dollars:
// ERP valuation, Schedule D, tax outputs, sell-flow proceeds math, P&L
// aggregation. Structurally identical to computePerUnitValue today; the
// rename exists so call sites declare intent and a future audit can
// grep for "Observed" reads vs "Displayable" reads with zero ambiguity.
export function computeObservedPerUnitValue(holding: PortfolioHolding | undefined | null): number | null {
  return computePerUnitValue(holding);
}

// CF-GRADED-RAIL-WIRE-IN (2026-06-14): wire/dashboard per-unit reader.
// Prefers observed FMV; falls back to graded-rail estimatedValue when the
// holding is graded-estimated (valuationStatus="estimated"); returns null
// when neither (valuationStatus="pending" / no data). Returns the SOURCE
// flag too so the caller can label the displayed value ("observed" /
// "estimated") and surface different UI treatment per the contract.
// NEVER used by ERP / Schedule D / tax math — those go through
// computeObservedPerUnitValue exclusively.
export interface DisplayablePerUnitValue {
  value: number | null;
  source: "observed" | "estimated" | null;
}
export function computeDisplayablePerUnitValue(
  holding: PortfolioHolding | undefined | null,
): DisplayablePerUnitValue {
  if (!holding) return { value: null, source: null };
  const observed = computeObservedPerUnitValue(holding);
  if (observed !== null) return { value: observed, source: "observed" };
  const est = (holding as { estimatedValue?: number | null }).estimatedValue;
  if (typeof est === "number" && Number.isFinite(est) && est > 0) {
    return { value: est, source: "estimated" };
  }
  return { value: null, source: null };
}

export function computeTotalValue(holding: PortfolioHolding | undefined | null): number | null {
  const perUnit = computePerUnitValue(holding);
  if (perUnit === null) return null;
  const qty = Math.max(1, toNumber(holding?.quantity, 1));
  return perUnit * qty;
}

// CF-CURRENTVALUE-DIMENSION-CANONICALIZE Ship 1 (2026-05-31).
// Single source for "total cost basis": stored totalCostBasis when present,
// else purchasePrice × max(1, quantity). Used by the wire-assembly P&L
// recipe AND by computeDisplayValue's unpriced-fallback. Centralizing
// here means a future cost-basis convention change has one site to touch.
export function computeCostBasisTotal(holding: PortfolioHolding | undefined | null): number {
  if (!holding) return 0;
  const qty = Math.max(1, toNumber(holding.quantity, 1));
  return toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * qty);
}

// CF-CURRENTVALUE-DIMENSION-CANONICALIZE Ship 1 — "value-or-cost" display
// value (TOTAL). Resolves the wire-side blast-radius for unpriced holdings:
// previously an FMV-null holding rendered currentValue=0 + totalProfitLoss=
// -basis + totalProfitLossPct=-100% (the user saw their unpriced cards as
// a full-cost loss). Layer-cake fallback:
//   1. FMV × qty when FMV is present and > 0       (priced — TOTAL)
//   2. computeCostBasisTotal when it's > 0          (unpriced-at-cost proxy)
//   3. 0 only when neither FMV nor cost is known    (truly unknown)
// The downstream wire P&L recipe applies its own basis > 0 guard so a
// cost-proxy currentValue nets to 0 P&L (not -100%) for unpriced holdings.
export function computeDisplayValue(holding: PortfolioHolding | undefined | null): number {
  if (!holding) return 0;
  const fmvTotal = computeTotalValue(holding);
  if (fmvTotal !== null && fmvTotal > 0) return fmvTotal;
  const costTotal = computeCostBasisTotal(holding);
  if (costTotal > 0) return costTotal;
  return 0;
}

// CF-AUTOPRICE-FIELD-NAME-SHIM (2026-05-26): iOS write path historically
// sends phantom field names (year, setName, cardName) rather than the
// canonical TS-typed names (cardYear, product, cardTitle). addHolding
// accepts via schemaless ...rest spread, so the data lands under wrong
// names and the pricing read path sees undefined for ~13/24 production
// holdings. These three helpers normalize the read so callers always get
// the canonical name regardless of which name iOS wrote.
//
// EXPLICITLY TEMPORARY — delete these helpers + inline the canonical
// reads once CF-IOS-FIELD-CONTRACT-FIX ships (iOS writes canonical names)
// AND CF-PORTFOLIO-METADATA-BACKFILL ships (existing docs renamed).
export function shimmedCardYear(holding: PortfolioHolding): number | undefined {
  return toNumber(holding.cardYear ?? (holding as any).year, 0) || undefined;
}
export function shimmedProduct(holding: PortfolioHolding): string | undefined {
  // Empty-string product falls through to setName (consistent with the
  // existing String(x ?? "").trim() || undefined pattern elsewhere in
  // this file that normalizes empty-as-missing).
  return (
    String(holding.product ?? "").trim() ||
    String(holding.setName ?? "").trim() ||
    undefined
  );
}
export function shimmedCardTitle(holding: PortfolioHolding): string {
  return (
    String(holding.cardTitle ?? "") ||
    String((holding as any).cardName ?? "") ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-HOLDING-ESTIMATE-INPUT-CONSOLIDATION (2026-06-18): single helper that
// builds a CompIQEstimateRequest from a PortfolioHolding. Three sites used to
// build this request inline — two persistence sites (autoPriceHolding,
// repriceHoldingsForUser) plus the advanced-alerts targetFromHolding — and
// over time the persistence sites drifted from the alerts site on seven
// fields (cardYear shim, product order+trim, parallel trim, isAuto presence,
// gradeCompany fallback order, gradeValue string-coerce, pinned-id +
// authoritative-flag). The next engine-input change should touch ONE place.
//
// Behavior reference: returns EXACTLY the request shape that autoPriceHolding
// (commit 3e7cf30) and repriceHoldingsForUser (commit f6fda5d) already
// produce. Persistence-site callers (sites 1 and 2) see no behavior change.
//
// Site-3 (advancedAlerts.targetFromHolding) adopts the canonical shape via
// this helper as part of CF-HOLDING-ESTIMATE-INPUT-CONSOLIDATION — that's a
// behavior change at the alert site, the SEVEN drift corrections being:
//
//   1. cardYear: shimmedCardYear adds the legacy `year` (string) fallback +
//      coerces 0 → undefined. Site 3 previously read `holding.cardYear`
//      raw, so holdings on the legacy `year` field went into the engine
//      with no year identity.
//   2. product: shimmedProduct prefers canonical `product` over legacy
//      `setName`, both trimmed. Site 3 previously read
//      `holding.setName ?? holding.product` (setName-first, no trim) — for
//      holdings with both populated, the engine got the older field.
//   3. parallel: trimmed + empty-string normalized to undefined. Site 3
//      previously passed `holding.parallel` raw (whitespace-only strings
//      would survive as truthy).
//   4. isAuto: declared as `Boolean(holding.isAuto)`. Site 3 OMITTED this
//      field — the engine's variant-tier-ladder auto-exclusion never fired
//      for alert evaluations, so auto holdings would mix with non-auto
//      comps. THIS IS THE ONLY BEHAVIORALLY MEANINGFUL DRIFT — it makes
//      auto alerts price correctly.
//   5. gradeCompany: persistence fallback is `gradingCompany ?? gradeCompany`
//      (legacy-first); site 3 was canonical-first. For any holding where
//      these two fields disagree (rare; they're meant to be the same),
//      this swaps which one the engine sees.
//   6. gradeValue: `toNumber(.., 0) || undefined` coerces stringified
//      grades (legacy data) to numbers. Site 3's type-narrow
//      (`typeof === "number" ? ... : undefined`) dropped string grades
//      silently.
//   7. cardsightCardId + pinnedAuthoritative: the explicit CF goal. Site 3
//      previously did not pin, so sparse-identity holdings re-resolved by
//      name search in the engine — same mis-resolution shape that hit
//      persistence sites (Trout $331 → $2) until 3e7cf30 + f6fda5d.
//
// Per-site `callContext` (source, userId, holdingId, routedFromHolding) is
// the caller's concern — layered separately at each computeEstimate call.
// ─────────────────────────────────────────────────────────────────────────────
export function buildEstimateRequestFromHolding(
  holding: PortfolioHolding,
): CompIQEstimateRequest {
  const pinnedCardId =
    String(holding.cardsightCardId ?? "").trim() || undefined;
  return {
    playerName: String(holding.playerName ?? "").trim(),
    cardYear: shimmedCardYear(holding),
    product: shimmedProduct(holding),
    parallel: String(holding.parallel ?? "").trim() || undefined,
    isAuto: Boolean(holding.isAuto),
    gradeCompany:
      String(holding.gradingCompany ?? holding.gradeCompany ?? "").trim() ||
      undefined,
    gradeValue: toNumber((holding as any).gradeValue, 0) || undefined,
    cardsightCardId: pinnedCardId,
    pinnedAuthoritative: pinnedCardId !== undefined,
  };
}

// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: write-boundary strip for fields
// dropped from the v1 canonical PortfolioHolding shape per contract §1.3.
// Strip-and-warn mode (NOT 4xx) per §1.5 — after iOS rebuild + 1-week
// monitor, escalate to 4xx in a follow-up CF. Keeps the body-spread from
// re-introducing dropped fields onto stored holdings.
//
// gradingCompany is INTENTIONALLY NOT in the strip set — see
// CF-AUTOPRICE-FIELD-NAME-SHIM at L358-367, owns the rename separately.
// CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2 (2026-05-31): the 6 FMV-derived
// fields below joined the strip set once their writers stopped (Ship 2 of
// the canonicalize CF). Wire computes them via composeHoldingWireShape.
const DEPRECATED_HOLDING_KEYS: readonly string[] = [
  // β detail-only (sourced from estimate response only)
  "confidence",
  "expectedDaysToSell",
  "compsUsed",
  "explanationBullets",
  "movementComposite",
  "movementImpliedPct",
  "movementCoverage",
  // Gate-2 β (alert + concentration consumers dropped)
  "marketSpeed",
  "marketPressure",
  // Computed at response assembly now
  "freshnessStatus",
  // Zero-write zombie / superseded fields
  "netEstimatedValue",
  "parallelDetected",
  "trend",
  "riskLevel",
  // Duplicates / legacy
  "brand",
  "setName",
  "grade",
  "feesPaid",
  "taxPaid",
  "shippingPaid",
  "bowmanFirst",
  "isPatch",
  "statusCategory",
  // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: FMV-derived, writers stopped
  "currentValue",
  "totalProfitLoss",
  "totalProfitLossPct",
  "quickSaleValue",
  "premiumValue",
  "suggestedListPrice",
];

function stripDeprecatedHoldingKeys(
  body: Record<string, unknown>,
  res: Response,
): Record<string, unknown> {
  const deprecated: string[] = [];
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (DEPRECATED_HOLDING_KEYS.includes(k)) {
      deprecated.push(k);
    } else {
      clean[k] = v;
    }
  }
  if (deprecated.length > 0) {
    res.setHeader("X-PortfolioHolding-Deprecated-Keys", deprecated.join(","));
  }
  return clean;
}

// CF-INVENTORYIQ-R1 — write-side normalizer for `cardsightCardId`.
// Applied by addHolding + updateHolding so the stored form is always
// the bare Cardsight UUID regardless of which shape the client sends.
//   - non-string input (undefined / null): pass through unchanged
//   - empty string: normalize to null (treats "" in this field as a
//     client bug, not data)
//   - "cardsight:<uuid>" prefixed form: strip the prefix and emit a
//     structured warn event so post-deploy telemetry can confirm
//     whether iOS picker is sending the bare UUID (event count = 0)
//     or the prefixed form (event count > 0 -> iOS contract drift
//     worth fixing in W5-iOS)
//   - bare UUID (or any other string shape): pass through unchanged
function normalizeR1CardsightCardId<T extends { cardsightCardId?: string | null }>(
  holding: T,
  holdingId: string,
  source: string,
): T {
  const raw = holding.cardsightCardId;
  if (typeof raw !== "string") return holding;

  if (raw === "") {
    return { ...holding, cardsightCardId: null };
  }

  if (raw.startsWith("cardsight:")) {
    console.warn(JSON.stringify({
      event: "portfoliohq_cardsightCardId_prefix_stripped",
      source,
      holdingId,
      prefixedForm: raw.slice(0, 30) + (raw.length > 30 ? "..." : ""),
    }));
    return { ...holding, cardsightCardId: raw.slice("cardsight:".length) };
  }

  return holding;
}

// CF-CARDSIGHT-GRADE-ID-PATTERN R2. Opportunistically populates
// `cardsightGradeId` on the holding by resolving (gradeCompany,
// gradeValue, isAuto) against Cardsight's grades taxonomy.
//
// Additive complementary per the R2 design -- on resolver miss the
// existing value is left untouched (null is a permanent valid state;
// a previously-populated UUID stays even if the resolver no longer
// matches, since that captures an earlier successful resolution).
//
// Never throws -- the resolver swallows network / 4xx / 5xx errors
// and returns null on every miss path.
async function populateCardsightGradeId<T extends PortfolioHolding>(
  holding: T,
): Promise<T> {
  const company =
    String(holding.gradingCompany ?? holding.gradeCompany ?? "").trim();
  const value = toNumber((holding as any).gradeValue, 0);
  const isAuto = Boolean(holding.isAuto);

  const resolved = await resolveCardsightGradeId(
    company.length > 0 ? company : undefined,
    value > 0 ? value : undefined,
    isAuto,
  );

  if (resolved) {
    return { ...holding, cardsightGradeId: resolved };
  }
  return holding;
}

async function autoPriceHolding(
  doc: UserDoc,
  holding: PortfolioHolding,
  previous: PortfolioHolding | undefined,
  source: string,
  userId?: string,
): Promise<PortfolioHolding> {
  // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): map the legacy
  // string source ("add" / "update" / "refresh") to the closed
  // PredictionCorpusSource literal union. Defaults to add for any
  // unknown caller — tsc would have caught a free string at the
  // computeEstimate call site, so this is purely a defensive map.
  const corpusSource =
    source === "update"
      ? "portfolio-autoprice-update"
      : source === "refresh"
      ? "portfolio-autoprice-refresh"
      : "portfolio-autoprice-add";
  // CF-HOLDING-ESTIMATE-INPUT-CONSOLIDATION (2026-06-18): request body built
  // via buildEstimateRequestFromHolding so the holding→engine-input mapping
  // lives in ONE place. The pinned-id wiring + corpus-clean playerName rule
  // shipped at 3e7cf30 are unchanged; this is a pure refactor at this site.
  const estimate = await computeEstimate(
    buildEstimateRequestFromHolding(holding),
    {
      source: corpusSource,
      userId: userId ?? null,
      holdingId: holding.id,
      routedFromHolding: true,
    },
  );

  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase D1: dropped the legacy
  // `toNumber(holding.currentValue, 0)` tail of this fallback chain.
  // currentValue was removed from PortfolioHolding in D1; C2 had
  // already stopped its writer, so this read was dead-after-C2 (no
  // writer fed it → returned 0 → caught by the `fairValue <= 0`
  // short-circuit at the next line).
  const fairValue = toNumber((estimate as any)?.fairMarketValue, toNumber((estimate as any)?.value, 0));

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): graded-rail resolution.
  // Run when the holding is graded (gradeCompany + gradeValue present
  // and well-formed) AND we have a cardsightCardId to fetch pricing
  // for. The rail produces 4 entries per pricing payload; match the
  // holding's grade against them and branch per the resolution tree:
  //   • no match (engine GUARD-skipped the grade because there's ≥1
  //     observed sale in scope) → grade is OBSERVED. Use computeEstimate's
  //     fairValue as before; valuationStatus = "observed".
  //   • match grounded (confidenceTier ∈ {estimate, rough}) →
  //     fairMarketValue = null (no estimate landing in the observed
  //     slot that feeds ERP P&L / Schedule D); populate estimate* fields;
  //     valuationStatus = "estimated".
  //   • match insufficient → fairMarketValue + estimatedValue both null;
  //     estimateBasis = entry.basis (the scope-labeled "why" prose for
  //     iOS tap-state); valuationStatus = "pending".
  // Ungraded holdings or holdings without cardsightCardId skip the rail
  // entirely; their valuation is the existing fairValue path, stamped
  // valuationStatus = "observed" to populate the new field.
  //
  // Grade match is NORMALIZED (uppercase company, Number(value)) on
  // BOTH sides — a lowercase "psa" or string "10" from iOS input must
  // match the engine's "PSA 10" entry; a silent no-match would route
  // a grounded grade to the "observed" branch and surface a null/base
  // FMV instead of the estimate (wrong-valuation bug, no crash).
  const normalizedGradeCompany = String(
    (holding as any).gradingCompany ?? (holding as any).gradeCompany ?? "",
  ).trim().toUpperCase();
  const normalizedGradeValue = (() => {
    const n = Number((holding as any).gradeValue);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const isGraded =
    normalizedGradeCompany.length > 0 && normalizedGradeValue !== null;
  const cardsightCardId =
    typeof holding.cardsightCardId === "string" && holding.cardsightCardId.length > 0
      ? holding.cardsightCardId
      : null;

  let railResolution: {
    fairMarketValueOverride: number | null;  // null when estimated/pending; fairValue when observed
    valuationStatus: "observed" | "estimated" | "pending";
    estimatedValue: number | null;
    estimateLow: number | null;
    estimateHigh: number | null;
    // CF-FINAL-CONSTANTS (2026-06-12): "ballpark" is now a valid
    // estimateConfidence; the engine emits ballpark with a number under
    // CF-ALWAYS-A-NUMBER + CF-CROSS-GRADE-COHERENCE. "insufficient" is
    // RETIRED here too — the engine routes no-anchor to "no-data". Keep
    // both in the type union for back-compat reads of any Cosmos docs
    // written under the prior schema (additive surface).
    estimateConfidence: "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null;
    estimateBasis: string | null;
    isEstimate: boolean;
  } | null = null;

  if (isGraded && cardsightCardId) {
    try {
      const pricing = await getPricingForMarketRead(cardsightCardId);
      if (pricing && !pricing.notFound) {
        const parallelId =
          typeof (holding as { parallelId?: string | null }).parallelId === "string"
          && ((holding as { parallelId?: string | null }).parallelId as string).length > 0
            ? (holding as { parallelId?: string | null }).parallelId as string
            : null;
        const parallelName = String(holding.parallel ?? "").trim() || null;
        const gradeBreakdown = buildGradeBreakdown(pricing, parallelId);
        const compiled = await compileGradedEstimatesForCard({
          pricing,
          estimate: estimate as {
            fairMarketValue?: number | null;
            lastSale?: { price?: number | null } | null;
            daysSinceNewestComp?: number | null;
            recentComps?: ReadonlyArray<unknown>;
            trendIQ?: import("../compiq/trendIQ.types.js").TrendIQResult | null;
          },
          parallelId,
          parallelName,
          // Holding flow is graded-scope (we have gradeCompany+gradeValue),
          // so anchor on parallel-composed for parallel scope; for base
          // scope the anchor is base raw regardless of isRawScope.
          isRawScope: false,
          isThinMarket: !(fairValue > 0),
          gradeBreakdown,
          source: "portfolio.autoPriceHolding",
          cardId: cardsightCardId,
        });
        const targetLabel = `${normalizedGradeCompany} ${normalizedGradeValue}`;
        const match = compiled.estimates.find((e) => {
          // Engine labels are e.g. "PSA 10" or "BGS 9.5" — same shape
          // we built above, normalized to uppercase + numeric value.
          // Defensive normalize the engine side too in case of drift.
          const parts = e.grade.trim().split(/\s+/);
          if (parts.length !== 2) return false;
          const co = parts[0]!.toUpperCase();
          const val = Number(parts[1]);
          return (
            co === normalizedGradeCompany
            && Number.isFinite(val)
            && val === normalizedGradeValue
          );
        });
        if (!match) {
          // No rail entry → GUARD skipped (observed in scope). Existing
          // fairValue path with explicit valuationStatus.
          railResolution = {
            fairMarketValueOverride: fairValue > 0 ? fairValue : null,
            valuationStatus: "observed",
            estimatedValue: null,
            estimateLow: null,
            estimateHigh: null,
            estimateConfidence: null,
            estimateBasis: null,
            isEstimate: false,
          };
        } else if (
          match.confidenceTier === "estimate"
          || match.confidenceTier === "rough"
          || match.confidenceTier === "ballpark"
        ) {
          // CF-FINAL-CONSTANTS (2026-06-12): the rail now emits ballpark
          // with a number (relative-scaled to R = grounded grade in
          // scope). ALL three confidence tiers map to valuationStatus
          // "estimated" with the tier surfaced in estimateConfidence so
          // iOS can render ballpark with a different badge than estimate
          // or rough. fairMarketValue stays NULL on every estimated row
          // — the firewall (no estimate dollar enters ERP/Schedule D/tax)
          // is unchanged from Step 1.
          railResolution = {
            fairMarketValueOverride: null,
            valuationStatus: "estimated",
            estimatedValue: match.estimatedValue,
            estimateLow: match.estimateLow,
            estimateHigh: match.estimateHigh,
            estimateConfidence: match.confidenceTier,
            estimateBasis: match.basis,
            isEstimate: true,
          };
        } else {
          // CF-FINAL-CONSTANTS: no-data marker (was "insufficient" pre-
          // CF-ALWAYS-A-NUMBER). The grade hit the no-anchor floor —
          // no raw, parallel, or release value to multiply by. Show
          // "pending" with the scope-labeled "Can't anchor an estimate"
          // prose; iOS renders a placeholder row.
          railResolution = {
            fairMarketValueOverride: null,
            valuationStatus: "pending",
            estimatedValue: null,
            estimateLow: null,
            estimateHigh: null,
            estimateConfidence: "no-data",
            estimateBasis: match.basis,
            isEstimate: true,
          };
        }
      }
    } catch (err) {
      console.warn(
        `[portfolio.autoPriceHolding] graded-rail resolution failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
      railResolution = null;
    }
  }

  // For ungraded holdings: preserve the existing "abort on fairValue<=0"
  // behavior — the rail wasn't going to fire anyway, and we don't want
  // to start stamping valuationStatus on cases that previously persisted
  // with no value at all.
  if (!railResolution && fairValue <= 0) {
    return holding;
  }

  const now = new Date().toISOString();

  // CF-NEXT-SALE-PREDICTION-LAYER (design d531939) — pull predictedPrice
  // off the estimate. Number-coerce range bounds; pass-through nulls when
  // the estimate didn't populate them (variant-mismatch / no-recent-comps
  // legacy Mechanism 1 paths set predictedPrice but not range bounds; the
  // new trendiq-projection path on the success path sets all three).
  const rawPredicted = (estimate as any)?.predictedPrice;
  const predictedPrice = typeof rawPredicted === "number" && Number.isFinite(rawPredicted) ? rawPredicted : null;
  const rawPredictedLow = (estimate as any)?.predictedPriceRange?.low;
  const rawPredictedHigh = (estimate as any)?.predictedPriceRange?.high;
  const predictedPriceLow =
    typeof rawPredictedLow === "number" && Number.isFinite(rawPredictedLow) ? rawPredictedLow : null;
  const predictedPriceHigh =
    typeof rawPredictedHigh === "number" && Number.isFinite(rawPredictedHigh) ? rawPredictedHigh : null;
  const predictedPriceMechanism =
    (estimate as any)?.predictedPriceAttribution?.mechanism ?? null;
  const predictedPriceUpdatedAt =
    (estimate as any)?.signalsLastUpdated ?? null;

  // CF-AUTOPRICE-PERSIST-TRENDIQ — persist forward-looking TrendIQ
  // movement fields. trendIQ is computed on every estimate call but only
  // present in the success-path response; fallback paths leave the field
  // absent, in which case movement fields land as null. movementUpdatedAt
  // falls back to current time when trendIQ.lastUpdated is null so the
  // dashboard can still surface freshness from this write.
  //
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: only movementDirection +
  // movementUpdatedAt are persisted on the holding. movementComposite /
  // movementImpliedPct / movementCoverage are β detail-only and
  // sourced from the estimate response on POST /api/compiq/* only.
  const __trendIQ = (estimate as any)?.trendIQ ?? null;
  const movementDirection =
    typeof __trendIQ?.direction === "string" ? __trendIQ.direction : null;
  const movementUpdatedAt = __trendIQ
    ? (__trendIQ.lastUpdated ?? (estimate as any)?.signalsLastUpdated ?? now)
    : null;

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): merge railResolution into the
  // stamped holding. Ungraded / no-cardsightCardId path: railResolution
  // is null → fairMarketValue = fairValue (existing behavior),
  // valuationStatus = "observed". Graded with rail match: fields per
  // the resolution tree.
  const resolved = railResolution ?? {
    fairMarketValueOverride: fairValue,
    valuationStatus: "observed" as const,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: null,
    estimateBasis: null,
    isEstimate: false,
  };

  const updated: PortfolioHolding = {
    ...holding,
    fairMarketValue: resolved.fairMarketValueOverride === null
      ? null as any  // null erases the field on display; ERP read coerces null→null
      : resolved.fairMarketValueOverride,
    estimatedValue: resolved.estimatedValue,
    estimateLow: resolved.estimateLow,
    estimateHigh: resolved.estimateHigh,
    estimateConfidence: resolved.estimateConfidence,
    estimateBasis: resolved.estimateBasis,
    isEstimate: resolved.isEstimate,
    valuationStatus: resolved.valuationStatus,
    predictedPrice,
    predictedPriceLow,
    predictedPriceHigh,
    predictedPriceMechanism,
    predictedPriceUpdatedAt,
    movementDirection,
    movementUpdatedAt,
    verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
    recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
    lastUpdated: now,
    // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: writer no longer stamps
    // currentValue / totalProfitLoss / totalProfitLossPct / quickSaleValue /
    // premiumValue / suggestedListPrice. The wire computes all 6 at response
    // assembly from cached fairMarketValue + stored quantity + cost basis
    // via composeHoldingWireShape (responseAssembly.ts). Phase C drops still
    // hold: movement detail β, confidence / compsUsed (holding), marketSpeed /
    // marketPressure (Gate-2 β), freshnessStatus.
  };

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): priceHistory stays observed-
  // only. Estimated and pending holdings do NOT append — the trajectory
  // iOS renders represents real comp-anchored value over time, never
  // estimate points (which would drift as the engine re-anchors) or
  // null gaps. When valuationStatus flips from observed to estimated
  // (e.g., a graded holding refresh where the grade lost its last
  // observed sale), we leave the prior observed trail intact and stop
  // appending — the trajectory pauses honestly.
  if (resolved.valuationStatus === "observed" && resolved.fairMarketValueOverride !== null) {
    appendPriceHistory(doc, holding.id, {
      at: now,
      value: resolved.fairMarketValueOverride,
      source,
    });
  }

  evaluateHoldingAlerts(doc, previous, updated);
  doc.holdings[holding.id] = updated;
  return updated;
}

function appendPriceHistory(
  doc: UserDoc,
  holdingId: string,
  point: PortfolioPricePoint,
): void {
  const existing = doc.priceHistoryByHolding[holdingId] ?? [];
  const prev = existing.length > 0 ? existing[existing.length - 1] : null;
  if (prev && Math.abs(prev.value - point.value) < 0.0001) {
    const prevTime = new Date(prev.at).getTime();
    const currentTime = new Date(point.at).getTime();
    if (Number.isFinite(prevTime) && Number.isFinite(currentTime) && Math.abs(currentTime - prevTime) < 60_000) {
      return;
    }
  }
  existing.push(point);
  // Cap price history per holding so the UserDoc doesn't grow unbounded as the
  // scheduled reprice job + pull-to-refresh both append over time. Override
  // with PORTFOLIO_PRICE_HISTORY_MAX (default 365).
  const maxPoints = Math.max(
    30,
    Math.floor(Number(process.env.PORTFOLIO_PRICE_HISTORY_MAX ?? 365)) || 365,
  );
  doc.priceHistoryByHolding[holdingId] = existing.slice(-maxPoints);
}

function addAlert(doc: UserDoc, alert: Omit<PortfolioAlert, "id" | "createdAt">): void {
  const now = new Date().toISOString();
  const lastSimilar = [...doc.alerts]
    .reverse()
    .find((a) => a.holdingId === alert.holdingId && a.type === alert.type);

  if (lastSimilar) {
    const lastTime = new Date(lastSimilar.createdAt).getTime();
    const currentTime = new Date(now).getTime();
    if (Number.isFinite(lastTime) && Number.isFinite(currentTime) && currentTime - lastTime < 6 * 60 * 60 * 1000) {
      return;
    }
  }

  doc.alerts.push({
    ...alert,
    id: randomUUID(),
    createdAt: now,
  });
  doc.alerts = doc.alerts.slice(-300);
}

function evaluateHoldingAlerts(doc: UserDoc, previous: PortfolioHolding | undefined, next: PortfolioHolding): void {
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): observed→estimated flip
  // guard. A holding whose `valuationStatus` flips from "observed" to
  // anything else (estimated / pending) has fairMarketValue=null on
  // the next state — `nextValue` would be 0 not because the card lost
  // value but because the slot changed. Don't fire threshold alerts
  // on the resulting "100% drop" — that's a UX regression. Same guard
  // covers the reverse flip (estimated → observed) so the synthetic
  // "infinite gain" from 0→fmv doesn't trip either. Real value moves
  // still alert (both sides observed); rail transitions don't.
  const prevStatus = (previous as { valuationStatus?: string } | undefined)?.valuationStatus;
  const nextStatus = (next as { valuationStatus?: string }).valuationStatus;
  const prevObserved = prevStatus === "observed" || prevStatus == null;
  const nextObserved = nextStatus === "observed" || nextStatus == null;
  if (prevObserved !== nextObserved) {
    return;
  }
  const basis = toNumber(next.totalCostBasis, toNumber(next.purchasePrice, 0) * Math.max(1, toNumber(next.quantity, 1)));
  const prevValue = computePerUnitValue(previous) ?? 0;
  const nextValue = computePerUnitValue(next) ?? 0;
  const playerName = String(next.playerName ?? "Unknown");
  const cardTitle = String(next.cardTitle ?? "Card");

  if (prevValue > 0 && nextValue > 0) {
    const movePct = ((nextValue - prevValue) / prevValue) * 100;
    if (Math.abs(movePct) >= 10) {
      addAlert(doc, {
        level: Math.abs(movePct) >= 18 ? "critical" : "warning",
        type: "value-move",
        holdingId: String(next.id),
        playerName,
        cardTitle,
        message: `${playerName} moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}% (${prevValue.toFixed(0)} -> ${nextValue.toFixed(0)}).`,
        context: { previousValue: prevValue, currentValue: nextValue, movePct: Number(movePct.toFixed(2)) },
      });
    }
  }

  if (basis > 0 && prevValue > 0 && nextValue > 0) {
    const prevAbove = prevValue >= basis;
    const nextAbove = nextValue >= basis;
    if (prevAbove !== nextAbove) {
      addAlert(doc, {
        level: nextAbove ? "info" : "warning",
        type: "cost-basis-cross",
        holdingId: String(next.id),
        playerName,
        cardTitle,
        message: `${playerName} ${nextAbove ? "moved above" : "fell below"} cost basis (${basis.toFixed(0)}).`,
        context: { basis, previousValue: prevValue, currentValue: nextValue, crossedAbove: nextAbove },
      });
    }
  }

  const lastUpdatedIso = toIso(next.lastUpdated, new Date(0));
  const ageDays = Math.max(0, (Date.now() - new Date(lastUpdatedIso).getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays >= 7) {
    addAlert(doc, {
      level: "info",
      type: "stale-data",
      holdingId: String(next.id),
      playerName,
      cardTitle,
      message: `${playerName} pricing is ${Math.floor(ageDays)} days stale.`,
      context: { ageDays: Math.floor(ageDays) },
    });
  }

  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C (Gate-2 β): liquidity-risk
  // alert dropped. marketSpeed/marketPressure are no longer cached on
  // holdings; the alert generator AND the consumer in computePortfolioHealth
  // (liquidityRisk component) are removed together. Sell-now alerts return
  // in W2 with their own reshape. PortfolioAlert.type union still includes
  // "liquidity-risk" for backward-compat reads of existing alerts in Cosmos.
}

function computePortfolioHealth(holdings: PortfolioHolding[]): {
  score: number;
  concentrationRisk: number;
  staleDataRisk: number;
  downsideRisk: number;
} {
  const valued = holdings.filter((h) => (computeTotalValue(h) ?? 0) > 0);
  const total = valued.reduce((sum, h) => sum + (computeTotalValue(h) ?? 0), 0);

  let concentrationRisk = 0;
  if (total > 0) {
    const weights = valued.map((h) => (computeTotalValue(h) ?? 0) / total);
    const hhi = weights.reduce((sum, w) => sum + w * w, 0);
    concentrationRisk = Math.min(100, Math.round(hhi * 200));
  }

  const staleCount = valued.filter((h) => {
    const updated = new Date(toIso(h.lastUpdated, new Date(0))).getTime();
    const ageDays = (Date.now() - updated) / (24 * 60 * 60 * 1000);
    return ageDays >= 3;
  }).length;
  const staleDataRisk = valued.length > 0 ? Math.round((staleCount / valued.length) * 100) : 0;

  const downsideCount = valued.filter((h) => {
    const totalValue = computeTotalValue(h) ?? 0;
    const basis = toNumber(h.totalCostBasis, 0);
    const pct = basis > 0 ? ((totalValue - basis) / basis) * 100 : 0;
    return pct <= -10;
  }).length;
  const downsideRisk = valued.length > 0 ? Math.round((downsideCount / valued.length) * 100) : 0;

  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: liquidityRisk dropped (Gate-2 β).
  // Weights renormalized by dividing prior weights by remaining-sum 0.75 so
  // the deduction ceiling recovers to 100 and the score floor stays at 0:
  //   concentration: 0.30 / 0.75 = 0.40
  //   stale:         0.20 / 0.75 = 0.267
  //   downside:      0.25 / 0.75 = 0.333
  const score = Math.max(
    0,
    Math.min(100, 100 - Math.round(concentrationRisk * 0.40 + staleDataRisk * 0.267 + downsideRisk * 0.333)),
  );

  return { score, concentrationRisk, staleDataRisk, downsideRisk };
}

function buildCalibrationReport(doc: UserDoc) {
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: confidence/compsUsed dropped
  // from PortfolioPricePoint schema (no longer a meaningful per-entry
  // signal — provenance lives on the estimate response). Calibration
  // collapses to overall MAE. Per-confidence-band binning would need a
  // re-source from the estimate corpus (CF-PREDICTION-CORPUS) rather
  // than from priceHistory entries.
  type Sample = { absPctError: number };
  const samples: Sample[] = [];

  for (const entry of doc.ledger) {
    const history = (doc.priceHistoryByHolding[entry.holdingId] ?? [])
      .filter((p) => new Date(p.at).getTime() <= new Date(entry.soldAt).getTime())
      .sort((a, b) => a.at.localeCompare(b.at));
    const anchor = history.length > 0 ? history[history.length - 1] : null;
    const predicted = toNumber(anchor?.value, 0);
    const actualNetUnit = entry.quantitySold > 0 ? toNumber(entry.netProceeds, 0) / entry.quantitySold : 0;
    if (predicted <= 0 || actualNetUnit <= 0) continue;

    const absPctError = Math.abs((predicted - actualNetUnit) / actualNetUnit) * 100;
    samples.push({ absPctError });
  }

  const overallMae = samples.length > 0
    ? samples.reduce((sum, s) => sum + s.absPctError, 0) / samples.length
    : 0;

  return {
    sampleCount: samples.length,
    meanAbsolutePctError: Number(overallMae.toFixed(2)),
  };
}

function buildWeeklyNarrative(doc: UserDoc) {
  const holdings = Object.values(doc.holdings);
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const priceMoves = holdings
    .map((h) => {
      const history = (doc.priceHistoryByHolding[h.id] ?? []).sort((a, b) => a.at.localeCompare(b.at));
      const latest = history.length > 0 ? history[history.length - 1] : null;
      const weekAnchor = history.find((p) => new Date(p.at).getTime() >= weekAgo) ?? history[0] ?? null;
      const latestValue = toNumber(latest?.value, computePerUnitValue(h) ?? 0);
      const anchorValue = toNumber(weekAnchor?.value, latestValue);
      const movePct = anchorValue > 0 ? ((latestValue - anchorValue) / anchorValue) * 100 : 0;
      return {
        holdingId: h.id,
        playerName: String(h.playerName ?? "Unknown"),
        cardTitle: String(h.cardTitle ?? "Card"),
        movePct: Number(movePct.toFixed(2)),
        latestValue: Number(latestValue.toFixed(2)),
      };
    })
    .sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));

  const topWinners = priceMoves.filter((m) => m.movePct > 0).slice(0, 3);
  const topLosers = priceMoves.filter((m) => m.movePct < 0).slice(0, 3);

  const recentAlerts = doc.alerts.filter((a) => new Date(a.createdAt).getTime() >= weekAgo);
  const feedbackRecent = doc.recommendationFeedback.filter((f) => new Date(f.createdAt).getTime() >= weekAgo);
  const followed = feedbackRecent.filter((f) => f.actionTaken === "followed").length;
  const feedbackRate = feedbackRecent.length > 0 ? (followed / feedbackRecent.length) * 100 : 0;

  const headline = holdings.length === 0
    ? "No active holdings this week."
    : topWinners.length > 0
    ? `${topWinners[0].playerName} led your weekly move at ${topWinners[0].movePct >= 0 ? "+" : ""}${topWinners[0].movePct}%.`
    : "Portfolio moved sideways this week.";

  const recommendations: string[] = [];
  if (recentAlerts.filter((a) => a.level === "critical").length > 0) {
    recommendations.push("Prioritize critical alerts and review liquidity-risk cards for exit timing.");
  }
  if (topLosers.length > 0) {
    recommendations.push("Review downside names for stop-loss or de-risking actions.");
  }
  if (feedbackRecent.length > 0 && feedbackRate < 40) {
    recommendations.push("Recommendation follow-through is low; tighten decision criteria or review signal clarity.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Maintain current strategy; momentum and risk signals are balanced this week.");
  }

  return {
    period: "7d",
    generatedAt: new Date().toISOString(),
    headline,
    summary: {
      holdings: holdings.length,
      alerts: recentAlerts.length,
      criticalAlerts: recentAlerts.filter((a) => a.level === "critical").length,
      feedbackEvents: feedbackRecent.length,
      recommendationFollowRatePct: Number(feedbackRate.toFixed(2)),
    },
    topWinners,
    topLosers,
    recommendations,
  };
}

async function requireUser(req: Request, res: Response): Promise<{ userId: string } | null> {
  // CF-PAYMENTS-A: prefer the middleware-attached user (set by
  // requireSession) so the request doesn't double-hit Cosmos for the
  // session lookup. Fall back to legacy header-parsing path for any
  // caller that didn't go through requireSession (none today, but kept
  // as a safety net so this helper stays self-contained).
  const attached = req.user;
  if (attached?.userId) return { userId: attached.userId };

  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return { userId: user.userId };
}

/**
 * CF-PAYMENTS-A: count helper exposed for the requireCapacity middleware.
 * Reads UserDoc and returns the current number of holdings keys; used to
 * enforce holdingsCap on POST /api/portfolio/holdings before the new row
 * is created.
 */
export async function countHoldingsForUser(userId: string): Promise<number> {
  const doc = await readUserDoc(userId);
  return Object.keys(doc.holdings ?? {}).length;
}

export async function getHoldings(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const items = Object.values(doc.holdings);
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B: route through anti-corruption
  // layer; explicit wire-shape per contract_freeze_v1 §1.3.
  const holdings = composePortfolioListResponse(items);
  res.json({ userId: auth.userId, count: holdings.length, holdings });
}

// ─── Summary helpers (multi-device dashboard) ────────────────────────────────

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  totalGainLoss: number;
  totalGainLossPct: number;
  cardCount: number;
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): observed/estimated/pending
  // breakdown of the dashboard total. observedValue is the existing
  // observed-FMV portion (what feeds ERP / P&L / tax); estimatedValue is
  // the labeled rail estimate × qty for holdings in valuationStatus=
  // "estimated"; totalValue = observedValue + estimatedValue so the iOS
  // headline shows the full picture with an observedPct badge. pending
  // holdings (insufficient markers, no number) contribute neither to
  // observedValue nor estimatedValue — counted only via pendingCount.
  // ESTIMATED DOLLARS NEVER ENTER any erp* path (Schedule D / tax) —
  // that firewall is enforced in erpValuation by fairMarketValue=null
  // on estimated holdings + counts-only addition there.
  observedValue: number;
  estimatedValue: number;
  estimatedCount: number;
  pendingCount: number;
  observedPct: number | null;
  // CF-HEADLINE-HONEST-TOTAL (2026-06-12): explicit honest fields the
  // iOS dashboard can read directly. Legacy fields above stay observed-
  // or-cost-proxy (existing contract); these surface the real picture:
  //   displayableTotalValue = observedValue + estimatedValue
  //     — the headline matches what iOS shows per-row (Σ displayableValue).
  //   observedCostBasis = Σ costBasis where valuationStatus==="observed"
  //   observedGainLoss / observedGainLossPct  — REAL P&L, computed only
  //     over observed holdings. HARD RULE: no estimated dollar enters any
  //     *GainLoss field. Estimated upside surfaces as VALUE (estimatedValue,
  //     displayableTotalValue), not as a realized-looking gain. Pending
  //     holdings excluded from gain entirely.
  displayableTotalValue: number;
  observedCostBasis: number;
  observedGainLoss: number;
  observedGainLossPct: number | null;
}

const EXCLUDED_STATUS = new Set([
  "sold",
  "archived",
  "watchlist",
  "tradepending",
  "trade pending",
]);

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function summarizeHoldings(items: PortfolioHolding[]): PortfolioSummary {
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): canonical aggregator —
  // single site that produces dashboard totals so observed vs estimated
  // contributions can never drift across duplicate aggregation sites.
  // computePortfolioHealth (L1353+) reads observed-only by design (risk
  // scores never fold in estimates); ERP buildValuation reads
  // h.fairMarketValue directly (null on estimated holdings, so they're
  // already excluded from snapshotValue).
  let totalValue = 0;
  let totalCost = 0;
  let cardCount = 0;
  let observedValue = 0;
  let estimatedValue = 0;
  let estimatedCount = 0;
  let pendingCount = 0;
  // CF-HEADLINE-HONEST-TOTAL (2026-06-12): observed-only cost-basis
  // accumulator so observedGainLoss/Pct can be computed in the same
  // pass without re-iterating the holdings array.
  let observedCostBasis = 0;
  for (const h of items) {
    const status = String((h as any).cardStatus ?? (h as any).statusCategory ?? "")
      .trim()
      .toLowerCase();
    if (EXCLUDED_STATUS.has(status)) continue;
    const qty = Math.max(1, toNumber(h.quantity, 1));
    // CF-CURRENTVALUE-DIMENSION-CANONICALIZE Ship 1: portfolio total uses
    // computeDisplayValue so it agrees with per-row currentValue and
    // unpriced-with-cost holdings show at cost (not $0). The summary's
    // P&L denominator is totalCost (via computeCostBasisTotal-equivalent
    // below), so the cost-proxy contributions cancel out cleanly.
    totalValue += computeDisplayValue(h);
    totalCost += computeCostBasisTotal(h);
    cardCount += qty;

    // CF-VALUATION-TOTALS-SPLIT — bucket by valuationStatus. Estimated
    // and pending holdings carry fairMarketValue=null on disk (Step 1
    // resolution tree). totalValue above falls back to cost for those;
    // observedValue+estimatedValue below tracks the honest split.
    const vs = (h as { valuationStatus?: string }).valuationStatus;
    if (vs === "estimated") {
      const ev = (h as { estimatedValue?: number | null }).estimatedValue;
      if (typeof ev === "number" && Number.isFinite(ev) && ev > 0) {
        estimatedValue += ev * qty;
      }
      estimatedCount += 1;
    } else if (vs === "pending") {
      pendingCount += 1;
    } else {
      // Treat undefined/null/"observed" all as observed (pre-Step-1
      // holdings have no valuationStatus set; they were observed-only).
      const observedTotal = computeTotalValue(h);
      if (observedTotal !== null && observedTotal > 0) {
        observedValue += observedTotal;
      }
      // CF-HEADLINE-HONEST-TOTAL — observed-only cost basis is the
      // observedGainLoss denominator. computeCostBasisTotal already
      // returns 0 for holdings with no purchasePrice/totalCostBasis,
      // so a cost-less observed holding contributes nothing here.
      observedCostBasis += computeCostBasisTotal(h);
    }
  }
  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0;
  const headlineTotal = observedValue + estimatedValue;
  const observedPct = headlineTotal > 0 ? observedValue / headlineTotal : null;
  // CF-HEADLINE-HONEST-TOTAL — observed-only P&L. HARD RULE: no estimated
  // dollar enters either field. The estimated upside (e.g. Leo Blue PSA 10:
  // $3,260.40 estimated vs $1,000 purchase) surfaces as VALUE via
  // estimatedValue + displayableTotalValue, NEVER as a realized-looking
  // gain. observedGainLossPct returns null when there's no observed cost
  // to divide by (don't synthesize a 0% return when nothing observed).
  const observedGainLoss = observedValue - observedCostBasis;
  const observedGainLossPct =
    observedCostBasis > 0 ? observedGainLoss / observedCostBasis : null;
  return {
    totalValue: round2(totalValue),
    totalCost: round2(totalCost),
    totalGainLoss: round2(totalGainLoss),
    totalGainLossPct: round2(totalGainLossPct),
    cardCount,
    observedValue: round2(observedValue),
    estimatedValue: round2(estimatedValue),
    estimatedCount,
    pendingCount,
    observedPct: observedPct === null ? null : Math.round(observedPct * 10000) / 10000,
    displayableTotalValue: round2(headlineTotal),
    observedCostBasis: round2(observedCostBasis),
    observedGainLoss: round2(observedGainLoss),
    observedGainLossPct:
      observedGainLossPct === null
        ? null
        : Math.round(observedGainLossPct * 10000) / 10000,
  };
}

// GET /api/portfolio  — items + summary in one payload for the iOS dashboard.
export async function getPortfolioWithSummary(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const rawItems = Object.values(doc.holdings);
  const summary = summarizeHoldings(rawItems);
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B: route through anti-corruption
  // layer; explicit wire-shape per contract_freeze_v1 §1.3. summary still
  // reads off raw holdings (uses Phase A compute-on-read helpers).
  const items = composePortfolioListResponse(rawItems);
  res.json({ success: true, userId: auth.userId, items, summary });
}

export async function getHoldingPriceHistory(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  if (!doc.holdings[id]) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  const points = doc.priceHistoryByHolding[id] ?? [];
  res.json({ holdingId: id, count: points.length, points });
}

export async function getAlerts(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const limit = Math.max(1, Math.min(100, toNumber(req.query.limit, 30)));
  const alerts = [...doc.alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  res.json({ count: alerts.length, alerts });
}

export async function getPortfolioHealth(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const holdings = Object.values(doc.holdings);
  const health = computePortfolioHealth(holdings);
  res.json({
    totalHoldings: holdings.length,
    ...health,
  });
}

export async function getCalibration(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const report = buildCalibrationReport(doc);
  res.json(report);
}

export async function getWeeklyBrief(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const brief = buildWeeklyNarrative(doc);
  res.json(brief);
}

export async function addRecommendationFeedback(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const holdingId = String(req.body?.holdingId ?? "").trim();
  const recommendation = String(req.body?.recommendation ?? "").trim();
  const actionTaken = String(req.body?.actionTaken ?? "").trim().toLowerCase();

  if (!holdingId || !recommendation || !["followed", "ignored", "partial"].includes(actionTaken)) {
    return res.status(400).json({
      error: {
        code: "INVALID_PAYLOAD",
        message: "holdingId, recommendation and actionTaken(followed|ignored|partial) are required.",
      },
    });
  }

  const doc = await readUserDoc(auth.userId);
  doc.recommendationFeedback.push({
    id: randomUUID(),
    holdingId,
    recommendation,
    actionTaken: actionTaken as RecommendationFeedback["actionTaken"],
    notes: typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined,
    createdAt: new Date().toISOString(),
  });
  doc.recommendationFeedback = doc.recommendationFeedback.slice(-500);
  await writeUserDoc(auth.userId, doc);
  res.status(201).json({ message: "Feedback recorded" });
}

export async function getLedger(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const entries = [...doc.ledger].sort((a, b) => b.soldAt.localeCompare(a.soldAt));
  const totals = entries.reduce((acc, entry) => {
    acc.realizedProfitLoss += entry.realizedProfitLoss;
    acc.grossProceeds += entry.grossProceeds;
    acc.netProceeds += entry.netProceeds;
    acc.costBasisSold += entry.costBasisSold;
    return acc;
  }, { realizedProfitLoss: 0, grossProceeds: 0, netProceeds: 0, costBasisSold: 0 });
  res.json({ userId: auth.userId, count: entries.length, totals, entries });
}

// CF-PR-E-BACKEND-ENDPOINTS — PATCH /api/portfolio/ledger/:id
//
// Allows the iOS / Mac UI to edit the user-supplied annotation fields on a
// recorded ledger entry: gradingCost, suppliesCost, dismissedAt,
// dismissedReason. ALL OTHER FIELDS ARE IMMUTABLE — the eBay-source
// financial fields (granular fees, netPayout, etc.) are authoritative
// from the ITEM_SOLD ingest path and must not be mutated by user PATCH.
//
// needsReconciliation is intentionally NOT in the whitelist: it remains
// computed from the granular-fee state at ingest time. dismissedAt is the
// user's "acknowledge — stop nagging me" signal that the UI layers on top.
//
// Field whitelist semantics:
//   - Unmentioned fields in the request body are ignored (no-op, not reject)
//   - Mentioned fields with `null` value clear the field (allows un-dismiss
//     + un-set of gradingCost/suppliesCost)
//   - Numeric fields must be non-negative finite numbers when not null
//   - dismissedReason must be ≤500 chars when not null
//
// Returns the updated entry on success (200), error object on validation
// or auth failure.
const LEDGER_PATCH_WHITELIST = new Set([
  "gradingCost",
  "suppliesCost",
  "dismissedAt",
  "dismissedReason",
  // CF-ERP-EXPANSION-#1 sales-tracking descriptive fields. NOT
  // financials — same whitelist semantics as `notes`.
  "salesChannel",
  "channelNote",
  "paymentMethod",
  "paymentNote",
  "saleLocation",
]);

const MAX_DISMISSED_REASON_LENGTH = 500;

function validateLedgerPatch(
  body: Record<string, unknown>,
): { ok: true; patch: Partial<PortfolioLedgerEntry> } | { ok: false; error: { message: string; code: string } } {
  // Reject unknown fields rather than silently dropping. Surfaces typos +
  // accidental client-side field renames at the API boundary.
  const incoming = Object.keys(body);
  const unknown = incoming.filter((k) => !LEDGER_PATCH_WHITELIST.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: {
        message: `Fields not allowed: ${unknown.join(", ")}. Allowed: ${[...LEDGER_PATCH_WHITELIST].join(", ")}`,
        code: "FIELD_NOT_ALLOWED",
      },
    };
  }

  const patch: Partial<PortfolioLedgerEntry> = {};

  for (const key of ["gradingCost", "suppliesCost"] as const) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      return {
        ok: false,
        error: {
          message: `${key} must be a non-negative number or null`,
          code: "INVALID_VALUE",
        },
      };
    }
    patch[key] = num;
  }

  if ("dismissedAt" in body) {
    const raw = body.dismissedAt;
    if (raw === null) {
      patch.dismissedAt = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) {
        patch.dismissedAt = null;
      } else {
        const d = new Date(trimmed);
        if (Number.isNaN(d.getTime())) {
          return {
            ok: false,
            error: {
              message: "dismissedAt must be a valid ISO timestamp or null",
              code: "INVALID_VALUE",
            },
          };
        }
        patch.dismissedAt = d.toISOString();
      }
    } else {
      return {
        ok: false,
        error: {
          message: "dismissedAt must be a string or null",
          code: "INVALID_VALUE",
        },
      };
    }
  }

  if ("dismissedReason" in body) {
    const raw = body.dismissedReason;
    if (raw === null) {
      patch.dismissedReason = null;
    } else if (typeof raw === "string") {
      if (raw.length > MAX_DISMISSED_REASON_LENGTH) {
        return {
          ok: false,
          error: {
            message: `dismissedReason must be ≤${MAX_DISMISSED_REASON_LENGTH} characters`,
            code: "INVALID_VALUE",
          },
        };
      }
      const trimmed = raw.trim();
      patch.dismissedReason = trimmed.length > 0 ? trimmed : null;
    } else {
      return {
        ok: false,
        error: {
          message: "dismissedReason must be a string or null",
          code: "INVALID_VALUE",
        },
      };
    }
  }

  // CF-ERP-EXPANSION-#1 sales-tracking fields. Routed through the shared
  // parser so POST /sell and PATCH /ledger/:id stay in lockstep.
  const stKeys = ["salesChannel", "channelNote", "paymentMethod", "paymentNote", "saleLocation"] as const;
  const hasSt = stKeys.some((k) => k in body);
  if (hasSt) {
    const parsed = parseSalesTrackingFields({
      salesChannel: body.salesChannel,
      channelNote: body.channelNote,
      paymentMethod: body.paymentMethod,
      paymentNote: body.paymentNote,
      saleLocation: body.saleLocation,
    });
    if ("error" in parsed) {
      return {
        ok: false,
        error: { message: parsed.error, code: "INVALID_VALUE" },
      };
    }
    if (parsed.ok.salesChannel !== undefined) patch.salesChannel = parsed.ok.salesChannel;
    if (parsed.ok.channelNote !== undefined) patch.channelNote = parsed.ok.channelNote;
    if (parsed.ok.paymentMethod !== undefined) patch.paymentMethod = parsed.ok.paymentMethod;
    if (parsed.ok.paymentNote !== undefined) patch.paymentNote = parsed.ok.paymentNote;
    if (parsed.ok.saleLocation !== undefined) patch.saleLocation = parsed.ok.saleLocation;
  }

  return { ok: true, patch };
}

export async function updateLedgerEntry(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: { message: "Missing ledger entry id", code: "MISSING_ID" } });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const validation = validateLedgerPatch(body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const doc = await readUserDoc(auth.userId);
  const index = doc.ledger.findIndex((e) => e.id === id);
  if (index === -1) {
    return res.status(404).json({ error: { message: "Ledger entry not found", code: "NOT_FOUND" } });
  }

  // Ownership is implicit: readUserDoc(auth.userId) only returns the
  // authenticated user's ledger. Belt-and-suspenders: re-check userId on the
  // entry itself in case future code changes the doc-fetch semantics.
  const existing = doc.ledger[index];
  if (existing.userId && existing.userId !== auth.userId) {
    return res.status(403).json({ error: { message: "Entry not owned by user", code: "FORBIDDEN" } });
  }

  const merged: PortfolioLedgerEntry = { ...existing, ...validation.patch };

  // CF-PR-E-P&L-COST-RECOMPUTE: when gradingCost or suppliesCost change,
  // re-run computeLedgerFinancials so netProceeds + realizedProfitLoss
  // reflect the new costs. Other whitelisted fields (dismissedAt,
  // dismissedReason) don't affect financials — leave the existing
  // derived values unchanged in that case.
  const financialsAffected =
    "gradingCost" in validation.patch || "suppliesCost" in validation.patch;
  let updated: PortfolioLedgerEntry = merged;
  if (financialsAffected) {
    // Reconstruct the helper inputs from the existing entry. eBay path:
    // feesTotal = sum of granular fee fields; netPayoutOverride = netPayout.
    // Manual path: feesTotal = fees aggregate; netPayoutOverride = null.
    const isEbay = existing.source === "ebay";
    let feesTotal: number;
    let netPayoutOverride: number | null;
    if (isEbay) {
      const granularSum =
        (merged.finalValueFee ?? 0) +
        (merged.paymentProcessingFee ?? 0) +
        (merged.promotedListingFee ?? 0) +
        (merged.adFee ?? 0) +
        (merged.otherFees ?? 0) +
        (merged.actualShippingCost ?? 0);
      feesTotal = granularSum;
      netPayoutOverride = merged.netPayout ?? null;
    } else {
      feesTotal = merged.fees;
      netPayoutOverride = null;
    }

    const financials = computeLedgerFinancials({
      grossProceeds: merged.grossProceeds,
      feesTotal,
      tax: isEbay ? 0 : merged.tax,
      shipping: isEbay ? 0 : merged.shipping,
      gradingCost: merged.gradingCost ?? null,
      suppliesCost: merged.suppliesCost ?? null,
      costBasisSold: merged.costBasisSold,
      netPayoutOverride,
    });

    updated = {
      ...merged,
      netProceeds: financials.netProceeds,
      realizedProfitLoss: financials.realizedProfitLoss,
      realizedProfitLossPct: financials.realizedProfitLossPct,
    };
  }

  // CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): cost-touching PATCH on an
  // UNRECONCILED eBay entry sets the axis-2 marker and runs the shared
  // finalize helper — so a user who edits cost basis via PATCH (instead of
  // the dedicated save-costs route) gets the same two-axis semantics.
  //
  // The PATCH whitelist still rejects client-supplied needsReconciliation
  // (smuggle protection — portfolio.ledger.patch.test.ts:288). This is a
  // SERVER-DERIVED flag transition, not a smuggled value.
  //
  // Finalized entries (needsReconciliation !== true) get cost edits without
  // any marker re-write — historical-correction path stays untouched.
  if (
    financialsAffected
    && existing.source === "ebay"
    && existing.needsReconciliation === true
  ) {
    const nowIso = new Date().toISOString();
    updated = {
      ...updated,
      userCostsProvidedAt: nowIso,
      userCostsProvidedBy: auth.userId,
    };
    updated = tryFinalizeReconciliation(
      updated as unknown as LedgerEntryForErp,
    ) as unknown as PortfolioLedgerEntry;
  }

  doc.ledger[index] = updated;
  await writeUserDoc(auth.userId, doc);

  res.json({ message: "Ledger entry updated", entry: updated });
}

/**
 * CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01): identity-gate
 * shared between addHolding and updateHolding.
 *
 * Pre-CF the create + update paths persisted whatever the caller sent,
 * with try/catch around autoPriceHolding and player resolution that
 * tolerated failure ("failure must never block holding creation"). The
 * combined effect was a silent permit on null-identity rows — a POST of
 * `{playerName: "Paul Skenes"}` landed a holding with all identity
 * fields null + 201 OK, then the scheduled reprice ran a Cardsight
 * playerName-only search that either returned `unavailable` (Skenes,
 * 1 comp) or surfaced a wrong-card price (Witt $5, 22 comps from a
 * completely different card). Both shapes are user-visible-wrong; the
 * Witt class is worse because it looks correct.
 *
 * The gate requires non-empty `playerName` AND at least one of:
 *   - `cardsightCardId` alone (covers identify-then-save flows where
 *     iOS holds a Cardsight UUID without text fields), OR
 *   - both `cardYear` AND `product` (free-text identity, no Cardsight UUID).
 *
 * This is an API contract change. iOS must surface a 400 with
 * `code: "MISSING_IDENTITY_FIELDS"` as "missing fields" UX, not a
 * generic crash. Pre-launch tests that previously sent
 * playerName-only payloads will now 400 — intended behavior.
 */
type HoldingIdentityCheck =
  | { ok: true }
  | { ok: false; missing: string[] };

function validateHoldingIdentity(
  holding: Partial<PortfolioHolding>,
): HoldingIdentityCheck {
  const playerName = String(holding.playerName ?? "").trim();
  const cardYearNum = toNumber(holding.cardYear, 0);
  const hasCardYear = holding.cardYear != null && cardYearNum > 0;
  const productRaw =
    typeof holding.product === "string" ? holding.product.trim() : "";
  const hasProduct = productRaw !== "";
  const csidRaw =
    typeof holding.cardsightCardId === "string"
      ? holding.cardsightCardId.trim()
      : "";
  const hasCardsightCardId = csidRaw !== "";

  const missing: string[] = [];
  if (!playerName) missing.push("playerName");
  if (!hasCardsightCardId) {
    if (!hasCardYear) missing.push("cardYear");
    if (!hasProduct) missing.push("product");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function respondMissingIdentity(res: Response, missing: string[]): void {
  // Structured 400 — iOS handoff shape locked here. The `missing` array
  // is sorted in spec order (playerName first, then cardYear, then
  // product) so the UX surface can show them in a stable order.
  const ordered = [
    ...(missing.includes("playerName") ? ["playerName"] : []),
    ...(missing.includes("cardYear") ? ["cardYear"] : []),
    ...(missing.includes("product") ? ["product"] : []),
  ];
  res.status(400).json({
    error: {
      code: "MISSING_IDENTITY_FIELDS",
      message: "Holding requires card identity",
      missing: ordered,
      hint:
        "Provide non-empty playerName plus (cardYear AND product), or alternatively a non-empty cardsightCardId.",
    },
  });
}

export async function addHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const incoming = stripDeprecatedHoldingKeys(
    (req.body ?? {}) as Record<string, unknown>,
    res,
  );
  const { id, ...rest } = incoming;
  let holding: PortfolioHolding = {
    ...(rest as Omit<PortfolioHolding, "id">),
    id: normalizeId(id),
  };
  holding = normalizeR1CardsightCardId(
    holding,
    holding.id,
    "portfolioStore.service.addHolding",
  );
  holding = await populateCardsightGradeId(holding);

  // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION: gate must run AFTER
  // normalizeR1CardsightCardId (which can hoist cardsightCardId from
  // legacy field shapes) AND AFTER populateCardsightGradeId, so the
  // identity check sees the final resolved cardsightCardId. Reject
  // null-identity payloads BEFORE any persistence side-effects.
  const identityCheck = validateHoldingIdentity(holding);
  if (!identityCheck.ok) {
    respondMissingIdentity(res, identityCheck.missing);
    return;
  }

  const doc = await readUserDoc(auth.userId);
  const now = new Date().toISOString();
  const value = computePerUnitValue(holding) ?? toNumber(holding.purchasePrice, 0);
  appendPriceHistory(doc, holding.id, {
    at: now,
    value,
    source: "add",
  });

  holding.lastUpdated = holding.lastUpdated ?? now;
  doc.holdings[holding.id] = { ...doc.holdings[holding.id], ...holding };

  try {
    await autoPriceHolding(doc, doc.holdings[holding.id], undefined, "add", auth.userId);
  } catch {
    // Keep the saved holding even if live pricing fails.
  }

  // PR #68: resolve playerId from playerName on new holdings only. Failure
  // here must never block holding creation — we just leave playerId unset.
  try {
    const name = String(doc.holdings[holding.id]?.playerName ?? "").trim();
    if (name && !doc.holdings[holding.id]?.playerId) {
      const cardYear = toNumber(doc.holdings[holding.id]?.cardYear, 0) || undefined;
      const resolved = await resolvePlayer(name, { year: cardYear });
      if (resolved) {
        doc.holdings[holding.id] = {
          ...doc.holdings[holding.id],
          playerId: resolved.playerId,
          playerIdConfidence: resolved.confidence,
          playerIdResolvedAt: new Date().toISOString(),
        };
      } else {
        console.warn(`[playerResolver] no MLB match for holding playerName="${name}" cardYear=${cardYear ?? "?"}`);
      }
    }
  } catch (err) {
    console.warn(`[playerResolver] resolution failed for holding ${holding.id}:`, err);
  }

  await writeUserDoc(auth.userId, doc);
  res.status(201).json({ message: "Holding saved", id: holding.id });
}

export async function getHoldingById(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  const holding = doc.holdings[id];
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B: route through anti-corruption
  // layer; this endpoint runs no estimate, so β fields are null here too.
  // iOS detail-view β richness comes from POST /api/compiq/*.
  res.json(composeHoldingWireShape(holding));
}

export async function updateHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  if (!doc.holdings[id]) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  const previous = doc.holdings[id];
  const cleanBody = stripDeprecatedHoldingKeys(
    (req.body ?? {}) as Record<string, unknown>,
    res,
  );
  let next = { ...doc.holdings[id], ...(cleanBody as Partial<PortfolioHolding>), id };
  next = normalizeR1CardsightCardId(
    next,
    id,
    "portfolioStore.service.updateHolding",
  );
  next = await populateCardsightGradeId(next);

  // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION: symmetric with addHolding.
  // Validates the merged AFTER-state — an update of an existing legacy
  // null-identity row to {quantity: 5} still blocks (the merged state
  // is still null-identity); an update that ADDS cardYear+product OR
  // cardsightCardId passes (the merged state has identity). Forces
  // legacy null-identity rows to be fixed-by-update or recreated,
  // never silently persisted in another permissive write.
  const identityCheck = validateHoldingIdentity(next);
  if (!identityCheck.ok) {
    respondMissingIdentity(res, identityCheck.missing);
    return;
  }

  const now = new Date().toISOString();
  next.lastUpdated = next.lastUpdated ?? now;

  const prevValue = computePerUnitValue(previous) ?? 0;
  const nextValue = computePerUnitValue(next) ?? 0;
  if (nextValue > 0 && Math.abs(nextValue - prevValue) > 0.0001) {
    appendPriceHistory(doc, id, {
      at: toIso(next.lastUpdated, new Date()),
      value: nextValue,
      source: "update",
    });
  }

  doc.holdings[id] = next;

  try {
    await autoPriceHolding(doc, doc.holdings[id], previous, "update", auth.userId);
  } catch {
    evaluateHoldingAlerts(doc, previous, next);
  }

  await writeUserDoc(auth.userId, doc);
  res.json({ message: "Holding updated", id });
}

export async function deleteHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  if (!doc.holdings[id]) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  // Best-effort: drop any blob photos owned by this holding before discarding
  // the record. A failure here must not block the holding deletion (the photo
  // would otherwise become unreferenceable from the user's surface).
  const photos = Array.isArray(doc.holdings[id].photos) ? (doc.holdings[id].photos as string[]) : [];
  for (const url of photos) {
    if (!url) continue;
    try {
      await deleteBlobByUrl(url);
    } catch (err) {
      console.warn("[portfolio] photo delete failed for", url, err);
    }
  }

  delete doc.holdings[id];
  await writeUserDoc(auth.userId, doc);
  res.json({ message: "Holding removed", id });
}

/**
 * Look up a holding by the iOS-generated stable clientId for a given user.
 * Used by upsert flows that retry adds and need to detect existing rows
 * without trusting server-side ids. Returns null when nothing matches.
 */
export async function findHoldingByClientId(
  userId: string,
  clientId: string,
): Promise<PortfolioHolding | null> {
  const trimmedClientId = String(clientId ?? "").trim();
  if (!userId || !trimmedClientId) return null;

  const doc = await readUserDoc(userId);
  for (const holding of Object.values(doc.holdings)) {
    if (typeof holding?.clientId === "string" && holding.clientId === trimmedClientId) {
      return holding;
    }
  }
  return null;
}

/**
 * Persist eBay listing back-references on a holding after a successful
 * publish flow. Idempotent: re-calling overwrites existing values, which
 * is what the publish flow wants (e.g. relisting after an end). Returns
 * the updated holding, or null if the holding does not exist.
 */
export async function linkEbayListing(
  userId: string,
  holdingId: string,
  link: { offerId: string; listingId: string; publishedAt?: string },
): Promise<PortfolioHolding | null> {
  if (!userId || !holdingId || !link?.offerId || !link?.listingId) return null;
  const doc = await readUserDoc(userId);
  const holding = doc.holdings[holdingId];
  if (!holding) return null;
  const updated: PortfolioHolding = {
    ...holding,
    ebayOfferId: link.offerId,
    ebayListingId: link.listingId,
    ebayListingPublishedAt: link.publishedAt ?? new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
  doc.holdings[holdingId] = updated;
  await writeUserDoc(userId, doc);
  return updated;
}

/**
 * Clear eBay listing back-references on a holding after a successful
 * end-listing flow. Looks the holding up by offerId so the caller does
 * not need to know the holdingId. Returns the cleared holding, or null
 * if no holding for this user references that offerId.
 */
export async function unlinkEbayListingByOfferId(
  userId: string,
  offerId: string,
): Promise<PortfolioHolding | null> {
  if (!userId || !offerId) return null;
  const doc = await readUserDoc(userId);
  let target: { id: string; holding: PortfolioHolding } | null = null;
  for (const [id, h] of Object.entries(doc.holdings)) {
    if (h?.ebayOfferId === offerId) {
      target = { id, holding: h };
      break;
    }
  }
  if (!target) return null;
  const cleared: PortfolioHolding = {
    ...target.holding,
    ebayOfferId: null,
    ebayListingId: null,
    ebayListingPublishedAt: null,
    lastUpdated: new Date().toISOString(),
  };
  doc.holdings[target.id] = cleared;
  await writeUserDoc(userId, doc);
  return cleared;
}

/**
 * Look up a holding by the eBay offerId persisted on it. Used by the
 * webhook ITEM_SOLD handler (PR D.6) to map an eBay sale notification
 * back to a HobbyIQ holding without requiring the caller to know
 * the holdingId.
 */
export async function findHoldingByEbayOfferId(
  userId: string,
  offerId: string,
): Promise<PortfolioHolding | null> {
  if (!userId || !offerId) return null;
  const doc = await readUserDoc(userId);
  for (const holding of Object.values(doc.holdings)) {
    if (holding?.ebayOfferId === offerId) return holding;
  }
  return null;
}

/**
 * Cross-user lookup of a holding by eBay offerId. Used by the webhook
 * ITEM_SOLD dispatcher when only the offerId is known (the webhook does
 * not include the HobbyIQ userId).
 *
 * INVARIANT: an eBay offerId is unique per seller, and a HobbyIQ user is
 * a single eBay seller, so at most ONE holding across the entire portfolio
 * store should ever reference a given offerId. If the cross-partition
 * scan returns more than one match, that is a data-corruption bug — we
 * log loudly to App Insights and pick the first match deterministically
 * (sorted by userId then holdingId) so behaviour is reproducible. We do
 * NOT throw, because failing the webhook would cause eBay to retry
 * forever and we'd lose the sale notification entirely.
 *
 * Implementation note: `holdings` is stored as a JSON object map keyed
 * by holdingId, not as an array, so we can't use Cosmos `JOIN h IN`
 * over an array. Instead we cross-partition project `userId` + `holdings`
 * and filter in JS. Acceptable at current scale; future optimization
 * is a dedicated `ebay_offer_index` container.
 *
 * Returns null when no match is found or when the backing store is
 * unavailable.
 */
export async function findHoldingByEbayOfferIdAcrossUsers(
  offerId: string,
): Promise<{ userId: string; holdingId: string; holding: PortfolioHolding } | null> {
  if (!offerId) return null;

  type Match = { userId: string; holdingId: string; holding: PortfolioHolding };
  const matches: Match[] = [];

  const container = await getContainer();
  if (!container && isTestMode) {
    for (const [userId, doc] of testMemStore.entries()) {
      for (const [holdingId, holding] of Object.entries(doc.holdings)) {
        if (holding?.ebayOfferId === offerId) {
          matches.push({ userId, holdingId, holding });
        }
      }
    }
  } else if (container) {
    try {
      const { resources } = await container.items
        .query<{ userId: string; holdings: Record<string, PortfolioHolding> }>({
          query: "SELECT c.userId, c.holdings FROM c",
        })
        .fetchAll();
      for (const row of resources ?? []) {
        if (!row?.holdings) continue;
        for (const [holdingId, holding] of Object.entries(row.holdings)) {
          if (holding?.ebayOfferId === offerId) {
            matches.push({ userId: row.userId, holdingId, holding });
          }
        }
      }
    } catch (err: any) {
      console.error(
        "[portfolio] findHoldingByEbayOfferIdAcrossUsers query failed:",
        err?.message ?? String(err),
      );
      return null;
    }
  } else {
    return null;
  }

  if (matches.length === 0) return null;

  if (matches.length > 1) {
    // Deterministic ordering so retries pick the same row.
    matches.sort((a, b) =>
      a.userId === b.userId
        ? a.holdingId.localeCompare(b.holdingId)
        : a.userId.localeCompare(b.userId),
    );
    console.error(
      `[portfolio] CRITICAL: ebayOfferId=${offerId} matched ${matches.length} holdings across users — INVARIANT VIOLATED (eBay offerIds are unique per seller). Matches: ${matches
        .map((m) => `userId=${m.userId} holdingId=${m.holdingId}`)
        .join(", ")}. Picking first deterministically: userId=${matches[0].userId} holdingId=${matches[0].holdingId}`,
    );
  }

  return matches[0];
}

/**
 * Cross-user lookup of a holding by eBay listingId. EBAY-POLL-INGESTION-C1
 * (2026-06-01): the Sell Fulfillment getOrders response does NOT carry an
 * `offerId` on line items (only `legacyItemId` + `lineItemId`). The poll
 * path matches against the holding's `ebayListingId` field instead, which
 * is persisted at publish time by `linkEbayListing`.
 *
 * Mirrors `findHoldingByEbayOfferIdAcrossUsers` exactly — same cross-
 * partition Cosmos scan, same multi-match deterministic ordering, same
 * never-throw contract (failing the poll would just retry forever; never
 * lose a sale).
 *
 * INVARIANT: an eBay listingId (the public marketplace item id) is unique
 * per seller and a HobbyIQ user is a single eBay seller, so at most ONE
 * holding should match. Multi-match logs CRITICAL and picks deterministically.
 *
 * Returns null when no match is found or when the backing store is
 * unavailable.
 */
export async function findHoldingByEbayListingIdAcrossUsers(
  listingId: string,
): Promise<{ userId: string; holdingId: string; holding: PortfolioHolding } | null> {
  if (!listingId) return null;

  type Match = { userId: string; holdingId: string; holding: PortfolioHolding };
  const matches: Match[] = [];

  const container = await getContainer();
  if (!container && isTestMode) {
    for (const [userId, doc] of testMemStore.entries()) {
      for (const [holdingId, holding] of Object.entries(doc.holdings)) {
        if (holding?.ebayListingId === listingId) {
          matches.push({ userId, holdingId, holding });
        }
      }
    }
  } else if (container) {
    try {
      const { resources } = await container.items
        .query<{ userId: string; holdings: Record<string, PortfolioHolding> }>({
          query: "SELECT c.userId, c.holdings FROM c",
        })
        .fetchAll();
      for (const row of resources ?? []) {
        if (!row?.holdings) continue;
        for (const [holdingId, holding] of Object.entries(row.holdings)) {
          if (holding?.ebayListingId === listingId) {
            matches.push({ userId: row.userId, holdingId, holding });
          }
        }
      }
    } catch (err: any) {
      console.error(
        "[portfolio] findHoldingByEbayListingIdAcrossUsers query failed:",
        err?.message ?? String(err),
      );
      return null;
    }
  } else {
    return null;
  }

  if (matches.length === 0) return null;

  if (matches.length > 1) {
    matches.sort((a, b) =>
      a.userId === b.userId
        ? a.holdingId.localeCompare(b.holdingId)
        : a.userId.localeCompare(b.userId),
    );
    console.error(
      `[portfolio] CRITICAL: ebayListingId=${listingId} matched ${matches.length} holdings across users — INVARIANT VIOLATED (eBay listingIds are unique per seller). Matches: ${matches
        .map((m) => `userId=${m.userId} holdingId=${m.holdingId}`)
        .join(", ")}. Picking first deterministically: userId=${matches[0].userId} holdingId=${matches[0].holdingId}`,
    );
  }

  return matches[0];
}

export async function sellHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  const holding = doc.holdings[id];
  if (!holding) return res.status(404).json({ error: { message: "Holding not found", code: "NOT_FOUND" } });

  const quantityOwned = Math.max(1, toNumber(holding.quantity, 1));
  const quantitySold = Math.floor(toNumber(req.body?.quantity, 0));
  if (quantitySold <= 0 || quantitySold > quantityOwned) {
    return res.status(400).json({ error: { message: "Invalid sell quantity", code: "INVALID_QUANTITY" } });
  }

  const unitSalePrice = toNumber(req.body?.salePrice, computePerUnitValue(holding) ?? 0);
  if (unitSalePrice <= 0) {
    return res.status(400).json({ error: { message: "Invalid sale price", code: "INVALID_SALE_PRICE" } });
  }

  const fees = toNumber(req.body?.fees, 0);
  const tax = toNumber(req.body?.tax, 0);
  const shipping = toNumber(req.body?.shipping, 0);
  const soldAtRaw = String(req.body?.soldAt ?? "").trim();
  const soldAt = soldAtRaw ? new Date(soldAtRaw).toISOString() : new Date().toISOString();
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;

  const currentCostBasis = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * quantityOwned);
  const avgUnitCost = quantityOwned > 0 ? currentCostBasis / quantityOwned : 0;
  const costBasisSold = avgUnitCost * quantitySold;
  const grossProceeds = unitSalePrice * quantitySold;

  // Manual sale: gradingCost + suppliesCost can be supplied at sale time
  // (iOS PR E Phase 3 entry form sends them via /sell body) or PATCHed later.
  // computeLedgerFinancials treats null/undefined as 0 — entries that don't
  // include these fields compute identically to pre-CF-PR-E-P&L-COST-RECOMPUTE
  // behavior.
  const gradingCost = req.body?.gradingCost != null ? toNumber(req.body.gradingCost, 0) : null;
  const suppliesCost = req.body?.suppliesCost != null ? toNumber(req.body.suppliesCost, 0) : null;

  const financials = computeLedgerFinancials({
    grossProceeds,
    feesTotal: fees,
    tax,
    shipping,
    gradingCost,
    suppliesCost,
    costBasisSold,
  });

  // CF-ERP-EXPANSION-#1 sales-tracking from manual-sale body.
  const stParsed = parseSalesTrackingFields({
    salesChannel: req.body?.salesChannel,
    channelNote: req.body?.channelNote,
    paymentMethod: req.body?.paymentMethod,
    paymentNote: req.body?.paymentNote,
    saleLocation: req.body?.saleLocation,
  });
  if ("error" in stParsed) {
    return res.status(400).json({ error: { message: stParsed.error, code: "INVALID_SALES_TRACKING" } });
  }

  const ledgerEntry: PortfolioLedgerEntry = {
    id: randomUUID(),
    userId: auth.userId,
    holdingId: id,
    playerName: String(holding.playerName ?? ""),
    cardTitle: shimmedCardTitle(holding),
    quantitySold,
    unitSalePrice,
    grossProceeds,
    fees,
    tax,
    shipping,
    netProceeds: financials.netProceeds,
    costBasisSold,
    realizedProfitLoss: financials.realizedProfitLoss,
    realizedProfitLossPct: financials.realizedProfitLossPct,
    soldAt,
    notes: notes && notes.length ? notes : undefined,
    gradingCost,
    suppliesCost,
    // CF-ERP-EXPANSION-#1 + #6: manual entries are reconciled-by-definition.
    // The user IS the authoritative source for their own manual sale.
    reconciledVia: "manual_entry",
    ...stParsed.ok,
  };

  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    delete doc.holdings[id];
  } else {
    const updatedCostBasis = avgUnitCost * remainingQty;
    // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: currentValue / totalProfitLoss
    // / totalProfitLossPct no longer stamped — wire computes them post-sale
    // from cached fairMarketValue × the new quantity (remainingQty) via
    // composeHoldingWireShape (computeDisplayValue + computeCostBasisTotal).
    // The per-unit FMV is preserved through the spread; the wire applies the
    // updated qty so post-sale total currentValue stays correct.
    doc.holdings[id] = {
      ...holding,
      quantity: remainingQty,
      purchasePrice: avgUnitCost,
      totalCostBasis: updatedCostBasis,
      lastUpdated: new Date().toISOString(),
    };
  }

  doc.ledger.push(ledgerEntry);
  await writeUserDoc(auth.userId, doc);

  return res.json({
    message: "Holding sale recorded",
    sold: ledgerEntry,
    holdingRemoved: remainingQty <= 0,
    remainingQuantity: Math.max(0, remainingQty),
  });
}

/**
 * Non-HTTP helper that records an eBay-originated sale on a holding.
 * Used by the ITEM_SOLD webhook handler (PR D.6).
 *
 * KEY GUARANTEES:
 * - Idempotent on (holdingId, ebayOrderId): replaying the same orderId
 *   returns the existing ledger entry without mutating state. This is
 *   required because `markEventProcessed` in the webhook events store is
 *   best-effort, so a future reconciliation pass may replay events whose
 *   handler-result write failed mid-flight.
 * - Never throws. Returns a discriminated result the caller can ack on.
 * - NULL-not-zero for unknown eBay fees: a missing fee field is recorded
 *   as null on the ledger entry, NOT silently treated as 0. When at least
 *   one granular fee is null and no authoritative `netPayout` is given,
 *   the entry is flagged `needsReconciliation: true`.
 * - Manual sale defaults are NOT changed by this helper.
 */
export interface EbaySaleData {
  ebayOrderId: string;
  ebayOfferId?: string | null;
  ebayListingId?: string | null;
  ebayBuyerUsername?: string | null;
  saleConfirmedAt: string;
  quantitySold: number;
  unitSalePrice: number;
  finalValueFee?: number | null;
  paymentProcessingFee?: number | null;
  promotedListingFee?: number | null;
  adFee?: number | null;
  otherFees?: number | null;
  netPayout?: number | null;
  actualShippingCost?: number | null;
  suppliesCost?: number | null;
  gradingCost?: number | null;
}

export type MarkSoldFromEbayResult =
  | {
      status: "marked-sold" | "marked-sold-deduped";
      entry: PortfolioLedgerEntry;
      holdingRemoved: boolean;
      remainingQuantity: number;
    }
  | { status: "holding-not-found" }
  | { status: "invalid-input"; reason: string };

export async function markHoldingSoldFromEbay(
  userId: string,
  holdingId: string,
  data: EbaySaleData,
): Promise<MarkSoldFromEbayResult> {
  const trimmedOrderId = String(data?.ebayOrderId ?? "").trim();
  if (!userId || !holdingId || !trimmedOrderId) {
    return { status: "invalid-input", reason: "missing userId, holdingId, or ebayOrderId" };
  }

  const doc = await readUserDoc(userId);

  // 1. Idempotency check — required per Step 3 decision #3 carry-forward.
  //    Replay must return the existing entry, not mutate, not throw.
  const existing = doc.ledger.find(
    (e) =>
      e.holdingId === holdingId &&
      e.source === "ebay" &&
      e.ebayOrderId === trimmedOrderId,
  );
  if (existing) {
    const currentHolding = doc.holdings[holdingId];
    return {
      status: "marked-sold-deduped",
      entry: existing,
      holdingRemoved: !currentHolding,
      remainingQuantity: currentHolding ? toNumber(currentHolding.quantity, 0) : 0,
    };
  }

  // 2. Holding existence.
  const holding = doc.holdings[holdingId];
  if (!holding) {
    return { status: "holding-not-found" };
  }

  // 3. Validate quantity / price.
  const quantityOwned = Math.max(1, toNumber(holding.quantity, 1));
  const quantitySold = Math.floor(toNumber(data.quantitySold, 0));
  if (quantitySold <= 0 || quantitySold > quantityOwned) {
    return { status: "invalid-input", reason: "invalid quantitySold" };
  }
  const unitSalePrice = toNumber(data.unitSalePrice, 0);
  if (unitSalePrice <= 0) {
    return { status: "invalid-input", reason: "invalid unitSalePrice" };
  }

  // 4. Compute math. Granular fees use NULL-not-zero semantics.
  const currentCostBasis = toNumber(
    holding.totalCostBasis,
    toNumber(holding.purchasePrice, 0) * quantityOwned,
  );
  const avgUnitCost = quantityOwned > 0 ? currentCostBasis / quantityOwned : 0;
  const costBasisSold = avgUnitCost * quantitySold;
  const grossProceeds = unitSalePrice * quantitySold;

  const granularFees = {
    finalValueFee: data.finalValueFee ?? null,
    paymentProcessingFee: data.paymentProcessingFee ?? null,
    promotedListingFee: data.promotedListingFee ?? null,
    adFee: data.adFee ?? null,
    otherFees: data.otherFees ?? null,
    actualShippingCost: data.actualShippingCost ?? null,
  };
  const netPayout = data.netPayout ?? null;
  const allGranularKnown = Object.values(granularFees).every((v) => v !== null);

  // Unknown (null) fees contribute 0 to the sum here, but `needsReconciliation`
  // is set true so downstream readers know the number is incomplete.
  const knownFeeSum = Object.values(granularFees).reduce<number>(
    (acc, v) => acc + (v ?? 0),
    0,
  );

  const needsReconciliation = netPayout === null && !allGranularKnown;

  // CF-PR-E-P&L-COST-RECOMPUTE: gradingCost + suppliesCost subtract from
  // netProceeds (same shape as actualShippingCost in granularFees — they're
  // cash-out costs that reduce returned proceeds). eBay-authoritative
  // netPayout is the post-platform-fee baseline; user-side costs (grading,
  // supplies) still subtract on top because eBay doesn't see them.
  const financials = computeLedgerFinancials({
    grossProceeds,
    feesTotal: knownFeeSum,
    tax: 0,
    shipping: 0,
    gradingCost: data.gradingCost ?? null,
    suppliesCost: data.suppliesCost ?? null,
    costBasisSold,
    netPayoutOverride: netPayout,
  });

  // 5. Build ledger entry. Legacy aggregate fees/tax/shipping are 0 for
  //    eBay entries; the granular fields are the source of truth.
  const ledgerEntry: PortfolioLedgerEntry = {
    id: randomUUID(),
    userId,
    holdingId,
    playerName: String(holding.playerName ?? ""),
    cardTitle: shimmedCardTitle(holding),
    quantitySold,
    unitSalePrice,
    grossProceeds,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: financials.netProceeds,
    costBasisSold,
    realizedProfitLoss: financials.realizedProfitLoss,
    realizedProfitLossPct: financials.realizedProfitLossPct,
    soldAt: data.saleConfirmedAt,
    source: "ebay",
    ebayOrderId: trimmedOrderId,
    ebayOfferId: data.ebayOfferId ?? null,
    ebayListingId: data.ebayListingId ?? null,
    ebayBuyerUsername: data.ebayBuyerUsername ?? null,
    ebaySaleConfirmedAt: data.saleConfirmedAt,
    finalValueFee: granularFees.finalValueFee,
    paymentProcessingFee: granularFees.paymentProcessingFee,
    promotedListingFee: granularFees.promotedListingFee,
    adFee: granularFees.adFee,
    otherFees: granularFees.otherFees,
    netPayout,
    actualShippingCost: granularFees.actualShippingCost,
    suppliesCost: data.suppliesCost ?? null,
    gradingCost: data.gradingCost ?? null,
    needsReconciliation,
    // CF-ERP-EXPANSION-#1 + #6: eBay webhook auto-populates the
    // sales-tracking axes. reconciledVia is "ebay_finances" only when the
    // Finances API has actually delivered the granular fees (i.e.
    // !needsReconciliation); otherwise left undefined and a downstream
    // POST /unreconciled/:id/override or the reconcile-on-enrich path
    // sets it.
    salesChannel: "ebay",
    paymentMethod: "ebay_managed",
    reconciledVia: needsReconciliation ? undefined : "ebay_finances",
  };

  // 6. Mutate holding state (mirrors sellHolding).
  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    delete doc.holdings[holdingId];
  } else {
    const updatedCostBasis = avgUnitCost * remainingQty;
    // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: same currentValue / P&L
    // writer-stop as sellHolding. Wire computes the post-sale display value
    // and P&L from cached fairMarketValue + the decremented quantity.
    doc.holdings[holdingId] = {
      ...holding,
      quantity: remainingQty,
      purchasePrice: avgUnitCost,
      totalCostBasis: updatedCostBasis,
      lastUpdated: new Date().toISOString(),
    };
  }

  doc.ledger.push(ledgerEntry);
  await writeUserDoc(userId, doc);

  return {
    status: "marked-sold",
    entry: ledgerEntry,
    holdingRemoved: remainingQty <= 0,
    remainingQuantity: Math.max(0, remainingQty),
  };
}

// ─── CF-ERP-EXPANSION-#7 atomic trade write ────────────────────────────────

import { allocateTradeProceeds } from "./erpTrades.service.js";

export interface RecordTradeInput {
  userId: string;
  tradeDate: string;          // ISO
  counterparty?: string;
  salesChannel?: SalesChannel;
  saleLocation?: SaleLocation;
  cashToMe: number;
  cashPaymentMethod?: PaymentMethod;
  note?: string;
  outgoing: Array<{
    holdingId: string;
    fmvAtTrade: number;
    fmvSource: "compiq" | "manual";
  }>;
  incoming: Array<{
    cardsightCardId?: string;
    cardTitle: string;
    grade?: string;
    fmvAtTrade: number;
    fmvSource: "compiq" | "manual";
    // Optional metadata to enrich the new holding shape
    playerName?: string;
    cardYear?: number;
    setName?: string;
    parallel?: string;
    gradeCompany?: string;
    gradeValue?: number;
  }>;
}

export interface RecordTradeResult {
  trade: TradeTransaction;
  outgoingHoldingsRemoved: string[];
  incomingHoldingsCreated: string[];
}

/**
 * Record a trade as an ATOMIC user-doc mutation: N disposal ledger entries
 * + N source-holding removals + M new holdings + 1 TradeTransaction record.
 * All in a single writeUserDoc call.
 *
 * Throws on any validation failure (caller catches + maps to HTTP code).
 */
export async function recordTradeTransaction(
  input: RecordTradeInput,
): Promise<RecordTradeResult> {
  const doc = await readUserDoc(input.userId);

  if (input.outgoing.length === 0 && input.incoming.length === 0) {
    throw new Error("trade must have at least one outgoing or incoming card");
  }
  if (input.outgoing.length === 0) {
    throw new Error("trade requires at least one outgoing card (basis must be relinquished)");
  }
  if (input.incoming.length === 0 && input.cashToMe <= 0) {
    throw new Error("trade with no incoming cards must have positive cashToMe");
  }

  // Resolve outgoing holdings and gather cost basis.
  const outgoingResolved: Array<{
    holding: PortfolioHolding;
    fmv: number;
    fmvSource: "compiq" | "manual";
    costBasis: number;
  }> = [];
  for (const leg of input.outgoing) {
    const h = doc.holdings[leg.holdingId];
    if (!h) throw new Error(`outgoing holding not found: ${leg.holdingId}`);
    if (!Number.isFinite(leg.fmvAtTrade) || leg.fmvAtTrade < 0) {
      throw new Error(`outgoing fmvAtTrade must be >= 0 for holding ${leg.holdingId}`);
    }
    const qty = Math.max(1, toNumber(h.quantity, 1));
    const totalCost = toNumber(h.totalCostBasis, toNumber(h.purchasePrice, 0) * qty);
    // Whole-holding disposal in Phase 1 — partial-quantity trades = Phase 2.
    outgoingResolved.push({
      holding: h,
      fmv: leg.fmvAtTrade,
      fmvSource: leg.fmvSource,
      costBasis: totalCost,
    });
  }

  // Run the pure allocation.
  const allocation = allocateTradeProceeds({
    outgoingFmvs: outgoingResolved.map((o) => o.fmv),
    outgoingCostBases: outgoingResolved.map((o) => o.costBasis),
    incomingFmvs: input.incoming.map((i) => i.fmvAtTrade),
    cashToMe: input.cashToMe,
  });

  const now = new Date().toISOString();
  const tradeId = randomUUID();

  // Build disposal ledger entries.
  const outgoingRecords: TradeOutgoingRecord[] = [];
  const ledgerEntries: PortfolioLedgerEntry[] = [];
  for (let i = 0; i < outgoingResolved.length; i += 1) {
    const o = outgoingResolved[i];
    const alloc = allocation.perOutgoing[i];
    const ledgerEntryId = randomUUID();
    const qty = Math.max(1, toNumber(o.holding.quantity, 1));

    const entry: PortfolioLedgerEntry = {
      id: ledgerEntryId,
      userId: input.userId,
      holdingId: o.holding.id,
      playerName: String(o.holding.playerName ?? ""),
      cardTitle: shimmedCardTitle(o.holding),
      quantitySold: qty,
      unitSalePrice: qty > 0 ? alloc.proceeds / qty : alloc.proceeds,
      grossProceeds: alloc.proceeds,
      fees: 0,
      tax: 0,
      shipping: 0,
      netProceeds: alloc.proceeds,
      costBasisSold: o.costBasis,
      realizedProfitLoss: alloc.realizedGainLoss,
      realizedProfitLossPct: o.costBasis > 0
        ? (alloc.realizedGainLoss / o.costBasis) * 100
        : 0,
      soldAt: input.tradeDate,
      // CF-ERP-EXPANSION-#7: disposal-by-trade attribution
      source: "manual",
      salesChannel: input.salesChannel ?? "in_person",
      paymentMethod: "trade",
      saleLocation: input.saleLocation,
      reconciledVia: "manual_entry",
      needsReconciliation: false,
      tradeId,
    };
    ledgerEntries.push(entry);
    outgoingRecords.push({
      holdingId: o.holding.id,
      fmvAtTrade: o.fmv,
      fmvSource: o.fmvSource,
      costBasis: o.costBasis,
      proceeds: alloc.proceeds,
      realizedGainLoss: alloc.realizedGainLoss,
      ledgerEntryId,
    });
  }

  // Build incoming holdings.
  const incomingRecords: TradeIncomingRecord[] = [];
  const newHoldings: PortfolioHolding[] = [];
  for (const inc of input.incoming) {
    if (!Number.isFinite(inc.fmvAtTrade) || inc.fmvAtTrade < 0) {
      throw new Error(`incoming fmvAtTrade must be >= 0 for "${inc.cardTitle}"`);
    }
    const holdingId = randomUUID();
    const acquired = input.tradeDate.slice(0, 10);
    const newH: PortfolioHolding = {
      id: holdingId,
      playerName: inc.playerName,
      cardTitle: inc.cardTitle,
      cardYear: inc.cardYear,
      setName: inc.setName,
      parallel: inc.parallel,
      gradeCompany: inc.gradeCompany,
      gradeValue: inc.gradeValue,
      quantity: 1,
      // Basis of an incoming-via-trade card = its FMV at trade.
      purchasePrice: inc.fmvAtTrade,
      totalCostBasis: inc.fmvAtTrade,
      purchaseDate: acquired,
      purchaseSource: "trade",
      lastUpdated: now,
    } as PortfolioHolding;
    if (inc.cardsightCardId) {
      (newH as any).cardsightCardId = inc.cardsightCardId;
    }
    (newH as any).tradeId = tradeId;
    newHoldings.push(newH);
    incomingRecords.push({
      holdingId,
      cardsightCardId: inc.cardsightCardId,
      cardTitle: inc.cardTitle,
      grade: inc.grade,
      fmvAtTrade: inc.fmvAtTrade,
      fmvSource: inc.fmvSource,
    });
  }

  // Mutate doc atomically.
  for (const o of outgoingResolved) {
    delete doc.holdings[o.holding.id];
  }
  for (const h of newHoldings) {
    doc.holdings[h.id] = h;
  }
  for (const e of ledgerEntries) {
    doc.ledger.push(e);
  }

  const trade: TradeTransaction = {
    id: tradeId,
    userId: input.userId,
    tradeDate: input.tradeDate,
    counterparty: input.counterparty,
    salesChannel: input.salesChannel,
    saleLocation: input.saleLocation,
    cashToMe: input.cashToMe,
    cashPaymentMethod: input.cashPaymentMethod,
    note: input.note,
    outgoing: outgoingRecords,
    incoming: incomingRecords,
    totals: allocation.totals,
    createdAt: now,
  };
  if (!doc.trades) doc.trades = [];
  doc.trades.push(trade);

  await writeUserDoc(input.userId, doc);

  return {
    trade,
    outgoingHoldingsRemoved: outgoingResolved.map((o) => o.holding.id),
    incomingHoldingsCreated: newHoldings.map((h) => h.id),
  };
}

export async function listTradesForUser(userId: string): Promise<TradeTransaction[]> {
  const doc = await readUserDoc(userId);
  return [...(doc.trades ?? [])].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
}

export async function getTradeForUser(userId: string, tradeId: string): Promise<TradeTransaction | null> {
  const doc = await readUserDoc(userId);
  return doc.trades?.find((t) => t.id === tradeId) ?? null;
}

export async function refreshHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  const holding = doc.holdings[id];
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  doc.holdings[id] = await populateCardsightGradeId(holding);

  try {
    await autoPriceHolding(doc, doc.holdings[id], doc.holdings[id], "refresh", auth.userId);
  } catch {
    doc.holdings[id].lastUpdated = new Date().toISOString();
  }
  await writeUserDoc(auth.userId, doc);
  res.json({ message: "Holding refreshed", id });
}

export interface BatchRepriceResult {
  requested: number;
  repriced: number;
  skipped: number;
  reason?: string;
  gates?: { minPricingConfidence: number; minCompsUsed: number };
  updates: Array<{
    id: string;
    status: "repriced" | "skipped" | "error" | "fresh";
    reason?: string;
    /**
     * CF-REPRICE-SKIP-REASON-TELEMETRY (2026-06-01): threaded so the
     * job-level per-holding skip-emit can include it without a Cosmos
     * re-read of the user's doc. Optional — repriced/fresh entries
     * leave it undefined; cardless entries are known-null.
     */
    cardsightCardId?: string | null;
  }>;
  /** Set when the entire request was throttled (no work performed). */
  throttled?: boolean;
  /** Number of holdings skipped because their lastUpdated was within minAgeMs. */
  freshSkipped?: number;
  /** Number of holdings actually examined this run (after stalest-cap, before gates). */
  examined?: number;
}

export interface RepriceOptions {
  /** Skip per-holding work when its lastUpdated is younger than this many ms. */
  minHoldingAgeMs?: number;
  /** Cap how many holdings are repriced this call (oldest lastUpdated first). */
  maxHoldings?: number;
  /** Skip the entire call when the user was repriced more recently than this. */
  userThrottleMs?: number;
}

// In-process per-user reprice timestamps for throttle. Survives only within a
// single Node process; that's intentional — Cosmos already has lastUpdated
// per holding, this is just a cheap guard against pull-to-refresh spam from
// the same client hitting the same instance.
const _lastRepriceAt = new Map<string, number>();

/**
 * Reprice every holding for a single user. Used both by the HTTP batch-reprice
 * endpoint and by the scheduled portfolio-reprice background job.
 *
 * Side effects: writes the updated UserDoc back to Cosmos (including any
 * new alerts / price-history entries) when at least one holding existed.
 */
export async function repriceHoldingsForUser(
  userId: string,
  source = "batch-reprice",
  opts: RepriceOptions = {},
): Promise<BatchRepriceResult> {
  // Per-user throttle — short-circuit before reading Cosmos.
  if (opts.userThrottleMs && opts.userThrottleMs > 0) {
    const last = _lastRepriceAt.get(userId);
    if (last && Date.now() - last < opts.userThrottleMs) {
      return {
        requested: 0,
        repriced: 0,
        skipped: 0,
        reason: "throttled",
        throttled: true,
        updates: [],
      };
    }
  }

  const doc = await readUserDoc(userId);
  const allHoldings = Object.values(doc.holdings);
  if (allHoldings.length === 0) {
    return { requested: 0, repriced: 0, skipped: 0, reason: "no-holdings", updates: [] };
  }

  const minPricingConfidence = Math.max(0, Math.min(100, toNumber(process.env.PORTFOLIO_MIN_PRICING_CONFIDENCE, 55)));
  const minCompsUsed = Math.max(1, toNumber(process.env.PORTFOLIO_MIN_COMPS_USED, 3));

  // Stalest-first ordering so per-call cap and freshness skip both prefer
  // the holdings that need attention most.
  const ageMs = (h: PortfolioHolding) => {
    const lu = h.lastUpdated;
    const t = typeof lu === "string" ? Date.parse(lu) : typeof lu === "number" ? lu : 0;
    return Number.isFinite(t) && t > 0 ? Date.now() - t : Number.MAX_SAFE_INTEGER;
  };
  const ordered = [...allHoldings].sort((a, b) => ageMs(b) - ageMs(a));

  let freshSkipped = 0;
  let candidates: PortfolioHolding[] = ordered;
  if (opts.minHoldingAgeMs && opts.minHoldingAgeMs > 0) {
    const minAge = opts.minHoldingAgeMs;
    const fresh = candidates.filter((h) => ageMs(h) < minAge);
    freshSkipped = fresh.length;
    candidates = candidates.filter((h) => ageMs(h) >= minAge);
  }
  if (opts.maxHoldings && opts.maxHoldings > 0 && candidates.length > opts.maxHoldings) {
    candidates = candidates.slice(0, opts.maxHoldings);
  }

  let repriced = 0;
  let skipped = 0;
  const updates: BatchRepriceResult["updates"] = [];

  for (const holding of candidates) {
    // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01): defense-in-depth
    // safety net. After the validation gate at addHolding/updateHolding, no
    // NEW null-identity rows can be persisted. But legacy/edge rows that
    // existed before the gate (or arrived through a non-validated import
    // path) would still hit computeEstimate with a playerName-only query —
    // the pathway that produced Bobby Witt Jr's wrong-card $5 surface
    // (Cardsight's playerName-only search returns the highest-volume
    // arbitrary card for that player). Skip those rows here and emit a
    // structured warn so legacy null-identity holdings stop generating
    // wrong-card prices even before the user fixes them via update.
    const reprCardYear = shimmedCardYear(holding);
    const reprCsid = String((holding as any).cardsightCardId ?? "").trim();
    if ((reprCardYear == null || !(toNumber(reprCardYear, 0) > 0)) && reprCsid === "") {
      console.warn(JSON.stringify({
        event: "repriceHoldingsForUser_skipped_cardless",
        source: "portfolioStore.service",
        holdingId: holding.id,
        userId,
        reason: "missing_card_identity",
        playerName: String(holding.playerName ?? "").trim() || null,
      }));
      skipped += 1;
      updates.push({
        id: holding.id,
        status: "skipped",
        reason: "missing_card_identity (cardYear=null AND cardsightCardId=null)",
        cardsightCardId: null,
      });
      continue;
    }
    try {
      // CF-HOLDING-ESTIMATE-INPUT-CONSOLIDATION (2026-06-18): request body
      // built via buildEstimateRequestFromHolding so the holding→engine-input
      // mapping lives in ONE place. The pinned-id wiring shipped at f6fda5d
      // is unchanged; this is a pure refactor at this site — sites 1 and 2
      // (autoPriceHolding above + this one) produce byte-identical requests
      // via the same helper.
      const estimate = await computeEstimate(
        buildEstimateRequestFromHolding(holding),
        {
          // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): scheduled +
          // manual batch reprice both flow through here; same source for
          // both — the §4.2/4.3 join distinguishes by userId+holdingId,
          // not by manual-vs-scheduled.
          source: "portfolio-reprice",
          userId,
          holdingId: holding.id,
          routedFromHolding: true,
        },
      );

      const confidence = toNumber((estimate as any)?.confidence?.pricingConfidence, 0);
      const compsUsed = toNumber((estimate as any)?.compsUsed, 0);
      const fairValue = toNumber((estimate as any)?.fairMarketValue, 0);
      const estSource = String((estimate as any)?.source ?? "");
      const daysSinceNewestComp = (estimate as any)?.daysSinceNewestComp ?? null;

      if (confidence < minPricingConfidence || compsUsed < minCompsUsed || fairValue <= 0) {
        skipped += 1;
        const failed: string[] = [];
        if (confidence < minPricingConfidence) failed.push(`confidence=${Math.round(confidence)}<${minPricingConfidence}`);
        if (compsUsed < minCompsUsed) failed.push(`compsUsed=${compsUsed}<${minCompsUsed}`);
        if (fairValue <= 0) failed.push(`fairValue=${fairValue}<=0`);
        // Persist what we DID learn (comp count, source, freshness) so the
        // iOS card row reflects reality — "8 comps on file (variant mismatch)"
        // instead of staying frozen at purchase price with 0 comps shown.
        // currentValue / fairMarketValue / P&L are left untouched so we
        // never invent a price we can't defend.
        const reasonLabel =
          estSource === "variant-mismatch"
            ? "Variant mismatch"
            : estSource === "no-recent-comps"
            ? "Insufficient comps"
            : "Low confidence";
        const now = new Date().toISOString();
        // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: failure-path no longer
        // stamps confidence / compsUsed (holding-level β; sourced from
        // estimate response only) or freshnessStatus ("Stale" intent now
        // surfaces via age-bucket on predictedPriceUpdatedAt /
        // movementUpdatedAt — both FROZEN here since the failure path
        // doesn't bump them, so the wire renders ≥ "Updated Today" by
        // age, never falsely "Live").
        doc.holdings[holding.id] = {
          ...holding,
          verdict: reasonLabel,
          recommendation: "Hold",
          lastUpdated: now,
        };
        const reprCsid =
          typeof (holding as any).cardsightCardId === "string" &&
          ((holding as any).cardsightCardId as string).trim() !== ""
            ? ((holding as any).cardsightCardId as string).trim()
            : null;
        updates.push({
          id: holding.id,
          status: "skipped",
          reason: `confidence-gate: ${failed.join(", ")} (source=${estSource || "ok"}${
            daysSinceNewestComp !== null ? `, daysSinceNewestComp=${daysSinceNewestComp}` : ""
          })`,
          cardsightCardId: reprCsid,
        });
        continue;
      }

      const previous = doc.holdings[holding.id];
      const now = new Date().toISOString();

      // CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — repriceHoldingsForUser
      // is a separate persistence site from autoPriceHolding (lines 389+);
      // both must extract the same prediction-layer fields from the estimate
      // response. iOS pull-to-refresh and the scheduled reprice job route
      // through THIS function, so without these reads the dashboard's
      // predictedPrice column stays null indefinitely.
      const rawPredicted = (estimate as any)?.predictedPrice;
      const repricePredictedPrice =
        typeof rawPredicted === "number" && Number.isFinite(rawPredicted) ? rawPredicted : null;
      const rawPredictedLow = (estimate as any)?.predictedPriceRange?.low;
      const rawPredictedHigh = (estimate as any)?.predictedPriceRange?.high;
      const repricePredictedPriceLow =
        typeof rawPredictedLow === "number" && Number.isFinite(rawPredictedLow) ? rawPredictedLow : null;
      const repricePredictedPriceHigh =
        typeof rawPredictedHigh === "number" && Number.isFinite(rawPredictedHigh) ? rawPredictedHigh : null;
      const repricePredictedPriceMechanism =
        (estimate as any)?.predictedPriceAttribution?.mechanism ?? null;
      const repricePredictedPriceUpdatedAt =
        (estimate as any)?.signalsLastUpdated ?? null;

      // CF-AUTOPRICE-PERSIST-TRENDIQ — mirror the autoPriceHolding (site 1)
      // movement-field extraction. Both persistence sites must agree on the
      // shape iOS reads from GET /api/portfolio. Pull-to-refresh + scheduled
      // reprice route through HERE; addHolding-style flows route through
      // autoPriceHolding.
      //
      // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: composite / impliedPct /
      // coverage are β detail-only (estimate response only); only
      // movementDirection + movementUpdatedAt persist on the holding.
      const repriceTrendIQ = (estimate as any)?.trendIQ ?? null;
      const repriceMovementDirection =
        typeof repriceTrendIQ?.direction === "string" ? repriceTrendIQ.direction : null;
      const repriceMovementUpdatedAt = repriceTrendIQ
        ? (repriceTrendIQ.lastUpdated ?? (estimate as any)?.signalsLastUpdated ?? now)
        : null;

      const updated: PortfolioHolding = {
        ...holding,
        fairMarketValue: fairValue,
        predictedPrice: repricePredictedPrice,
        predictedPriceLow: repricePredictedPriceLow,
        predictedPriceHigh: repricePredictedPriceHigh,
        predictedPriceMechanism: repricePredictedPriceMechanism,
        predictedPriceUpdatedAt: repricePredictedPriceUpdatedAt,
        movementDirection: repriceMovementDirection,
        movementUpdatedAt: repriceMovementUpdatedAt,
        verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
        recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
        lastUpdated: now,
        // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: currentValue / P&L
        // (3 fields) and quickSale / premium / suggestedList (3 fields)
        // no longer stamped — wire computes them via composeHoldingWireShape.
        // Phase C drops still hold (movement detail β, confidence /
        // compsUsed (holding), marketSpeed / marketPressure, freshnessStatus).
      };

      appendPriceHistory(doc, holding.id, {
        at: now,
        value: fairValue,
        source,
      });

      evaluateHoldingAlerts(doc, previous, updated);
      doc.holdings[holding.id] = updated;
      repriced += 1;
      updates.push({ id: holding.id, status: "repriced" });
    } catch (error: any) {
      skipped += 1;
      const errCsid =
        typeof (holding as any).cardsightCardId === "string" &&
        ((holding as any).cardsightCardId as string).trim() !== ""
          ? ((holding as any).cardsightCardId as string).trim()
          : null;
      updates.push({
        id: holding.id,
        status: "error",
        reason: error?.message ?? "estimate-failed",
        cardsightCardId: errCsid,
      });
    }
  }

  await writeUserDoc(userId, doc);
  _lastRepriceAt.set(userId, Date.now());
  return {
    requested: allHoldings.length,
    repriced,
    skipped,
    gates: { minPricingConfidence, minCompsUsed },
    updates,
    freshSkipped,
    examined: candidates.length,
  };
}

/**
 * Enumerate every userId that has at least one document in the portfolio
 * container. Used by the scheduled reprice job to walk all users.
 *
 * Returns an empty array in test mode (uses in-memory keys) when Cosmos is
 * unavailable.
 */
export async function listAllPortfolioUserIds(): Promise<string[]> {
  const container = await getContainer();
  if (!container) {
    if (isTestMode) return Array.from(testMemStore.keys());
    return [];
  }
  const { resources } = await container.items
    .query<{ userId: string }>({
      query: "SELECT VALUE c.userId FROM c WHERE IS_DEFINED(c.userId)",
    })
    .fetchAll();
  // Cosmos `SELECT VALUE` returns raw strings here, not objects.
  return (resources as unknown as string[]).filter((u) => typeof u === "string" && u.length > 0);
}

export async function runBatchReprice(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  // HTTP path (pull-to-refresh) is rate-limited and capped so a spamming
  // client can't burn OpenAI credits.
  const throttleMs = Math.max(
    0,
    Math.floor(Number(process.env.PORTFOLIO_REPRICE_HTTP_THROTTLE_MS ?? 60_000)) || 60_000,
  );
  const minAgeMs = Math.max(
    0,
    Math.floor(Number(process.env.PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS ?? 60_000)) || 60_000,
  );
  const maxHoldings = Math.max(
    1,
    Math.floor(Number(process.env.PORTFOLIO_REPRICE_HTTP_MAX_HOLDINGS ?? 50)) || 50,
  );
  const result = await repriceHoldingsForUser(auth.userId, "batch-reprice", {
    userThrottleMs: throttleMs,
    minHoldingAgeMs: minAgeMs,
    maxHoldings,
  });
  return res.json(result);
}

/**
 * CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01): test-only
 * internals surface. Exposes the private `writeUserDoc` so tests can
 * seed legacy null-identity holdings that BYPASS the new validation
 * gate — exercising the defense-in-depth reprice safety net for
 * exactly the rows it's meant to catch. Mirrors the `__playerScoreInternals`
 * pattern from playerScore.service.ts:663. Do not call from production.
 */
export const __portfolioStoreInternals = {
  writeUserDoc,
  validateHoldingIdentity,
  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): exposed for in-process probe
  // tests that exercise the resolution tree without spinning up the
  // route + auth + Cosmos write path. Do not call from production.
  autoPriceHolding,
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): exposed for direct unit
  // testing of the observed↔estimated alert flip guard. Do not call
  // from production routes — evaluateHoldingAlerts is the alert
  // emitter, called transparently inside autoPriceHolding.
  evaluateHoldingAlerts,
};
