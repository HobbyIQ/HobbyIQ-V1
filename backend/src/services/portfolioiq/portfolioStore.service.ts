import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { getUserBySession } from "../authService.js";
import { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { computeEstimate } from "../compiq/compiqEstimate.service.js";
import { resolvePlayer } from "../mlb/playerResolver.service.js";
import { deleteBlobByUrl } from "../photoStorage/photoStorage.service.js";
import { resolveCardsightGradeId } from "../cardsight/cardsightGradesTaxonomy.js";

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
}

interface PortfolioPricePoint {
  at: string;
  value: number;
  confidence?: number;
  compsUsed?: number;
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

async function readUserDoc(userId: string): Promise<UserDoc> {
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

async function writeUserDoc(userId: string, doc: UserDoc): Promise<void> {
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

  // True when the recorded netProceeds is incomplete: at least one granular
  // fee is null AND eBay did not provide an authoritative netPayout. The
  // reconciliation pass should re-fetch the order and update this entry.
  needsReconciliation?: boolean;

  // ----- User-dismissal of reconciliation prompts (CF-PR-E-BACKEND-ENDPOINTS) -
  // dismissedAt is a separate user signal from needsReconciliation: the
  // computed flag stays true (data is genuinely incomplete) but the iOS UI
  // can hide this entry from the "needs your attention" section once the
  // user has acknowledged. Re-setting to null reopens the prompt.
  // dismissedReason is optional free-text the user provided ("don't have
  // the receipt", "doesn't matter for this entry", etc.).
  dismissedAt?: string | null;
  dismissedReason?: string | null;
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
function computePerUnitValue(holding: PortfolioHolding | undefined | null): number | null {
  if (!holding) return null;
  const fmv = (holding as { fairMarketValue?: number }).fairMarketValue;
  return typeof fmv === "number" && Number.isFinite(fmv) ? fmv : null;
}

function computeTotalValue(holding: PortfolioHolding | undefined | null): number | null {
  const perUnit = computePerUnitValue(holding);
  if (perUnit === null) return null;
  const qty = Math.max(1, toNumber(holding?.quantity, 1));
  return perUnit * qty;
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
): Promise<PortfolioHolding> {
  const estimate = await computeEstimate({
    playerName: String(holding.playerName ?? "").trim(),
    cardYear: shimmedCardYear(holding),
    product: shimmedProduct(holding),
    parallel: String(holding.parallel ?? "").trim() || undefined,
    isAuto: Boolean(holding.isAuto),
    gradeCompany: String(holding.gradingCompany ?? holding.gradeCompany ?? "").trim() || undefined,
    gradeValue: toNumber((holding as any).gradeValue, 0) || undefined,
  });

  const confidence = toNumber((estimate as any)?.confidence?.pricingConfidence, 0);
  const compsUsed = toNumber((estimate as any)?.compsUsed, 0);
  const fairValue = toNumber((estimate as any)?.fairMarketValue, toNumber((estimate as any)?.value, toNumber(holding.currentValue, 0)));

  if (fairValue <= 0) {
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
  const __trendIQ = (estimate as any)?.trendIQ ?? null;
  const rawComposite = __trendIQ?.composite;
  const rawImpliedPct = __trendIQ?.impliedPct;
  const movementDirection =
    typeof __trendIQ?.direction === "string" ? __trendIQ.direction : null;
  const movementComposite =
    typeof rawComposite === "number" && Number.isFinite(rawComposite) ? rawComposite : null;
  const movementImpliedPct =
    typeof rawImpliedPct === "number" && Number.isFinite(rawImpliedPct) ? rawImpliedPct : null;
  const movementCoverage =
    typeof __trendIQ?.coverage === "string" ? __trendIQ.coverage : null;
  const movementUpdatedAt = __trendIQ
    ? (__trendIQ.lastUpdated ?? (estimate as any)?.signalsLastUpdated ?? now)
    : null;

  const updated: PortfolioHolding = {
    ...holding,
    currentValue: fairValue,
    fairMarketValue: fairValue,
    quickSaleValue: toNumber((estimate as any)?.quickSaleValue, fairValue * 0.88),
    premiumValue: toNumber((estimate as any)?.premiumValue, fairValue * 1.15),
    suggestedListPrice: toNumber((estimate as any)?.suggestedListPrice, fairValue * 1.05),
    predictedPrice,
    predictedPriceLow,
    predictedPriceHigh,
    predictedPriceMechanism,
    predictedPriceUpdatedAt,
    movementDirection,
    movementComposite,
    movementImpliedPct,
    movementCoverage,
    movementUpdatedAt,
    verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
    recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
    confidence,
    compsUsed,
    marketSpeed: String((estimate as any)?.marketDNA?.speed ?? holding.marketSpeed ?? "Normal"),
    marketPressure: String((estimate as any)?.marketDNA?.marketCondition ?? holding.marketPressure ?? "Balanced Market"),
    freshnessStatus: "Live",
    lastUpdated: now,
  };

  const basis = toNumber(updated.totalCostBasis, toNumber(updated.purchasePrice, 0) * Math.max(1, toNumber(updated.quantity, 1)));
  updated.totalProfitLoss = fairValue - basis;
  updated.totalProfitLossPct = basis > 0 ? ((fairValue - basis) / basis) * 100 : 0;

  appendPriceHistory(doc, holding.id, {
    at: now,
    value: fairValue,
    confidence,
    compsUsed,
    source,
  });

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

  const speed = String(next.marketSpeed ?? "").toLowerCase();
  const pressure = String(next.marketPressure ?? "").toLowerCase();
  if (speed.includes("slow") || pressure.includes("weak")) {
    addAlert(doc, {
      level: "info",
      type: "liquidity-risk",
      holdingId: String(next.id),
      playerName,
      cardTitle,
      message: `${playerName} liquidity risk flagged (${next.marketSpeed ?? "unknown speed"}).`,
      context: { marketSpeed: next.marketSpeed ?? null, marketPressure: next.marketPressure ?? null },
    });
  }
}

function computePortfolioHealth(holdings: PortfolioHolding[]): {
  score: number;
  concentrationRisk: number;
  liquidityRisk: number;
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

  const liquidityCount = valued.filter((h) => String(h.marketSpeed ?? "").toLowerCase().includes("slow")).length;
  const liquidityRisk = valued.length > 0 ? Math.round((liquidityCount / valued.length) * 100) : 0;

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

  const score = Math.max(
    0,
    Math.min(100, 100 - Math.round(concentrationRisk * 0.3 + liquidityRisk * 0.25 + staleDataRisk * 0.2 + downsideRisk * 0.25)),
  );

  return { score, concentrationRisk, liquidityRisk, staleDataRisk, downsideRisk };
}

function buildCalibrationReport(doc: UserDoc) {
  type Sample = { confidence: number; absPctError: number };
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
    const confidence = Math.max(0, Math.min(100, toNumber(anchor?.confidence, 50)));
    samples.push({ confidence, absPctError });
  }

  const bins = [
    { key: "0-40", min: 0, max: 40 },
    { key: "41-60", min: 41, max: 60 },
    { key: "61-80", min: 61, max: 80 },
    { key: "81-100", min: 81, max: 100 },
  ].map((b) => {
    const points = samples.filter((s) => s.confidence >= b.min && s.confidence <= b.max);
    const mae = points.length > 0 ? points.reduce((sum, p) => sum + p.absPctError, 0) / points.length : 0;
    return {
      bucket: b.key,
      count: points.length,
      meanAbsolutePctError: Number(mae.toFixed(2)),
    };
  });

  const overallMae = samples.length > 0
    ? samples.reduce((sum, s) => sum + s.absPctError, 0) / samples.length
    : 0;

  return {
    sampleCount: samples.length,
    meanAbsolutePctError: Number(overallMae.toFixed(2)),
    bins,
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

export async function getHoldings(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const holdings = Object.values(doc.holdings);
  res.json({ userId: auth.userId, count: holdings.length, holdings });
}

// ─── Summary helpers (multi-device dashboard) ────────────────────────────────

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  totalGainLoss: number;
  totalGainLossPct: number;
  cardCount: number;
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
  let totalValue = 0;
  let totalCost = 0;
  let cardCount = 0;
  for (const h of items) {
    const status = String((h as any).cardStatus ?? (h as any).statusCategory ?? "")
      .trim()
      .toLowerCase();
    if (EXCLUDED_STATUS.has(status)) continue;
    const qty = Math.max(1, toNumber(h.quantity, 1));
    totalValue += (computePerUnitValue(h) ?? 0) * qty;
    const basis = toNumber(h.totalCostBasis, 0);
    totalCost += basis > 0
      ? basis
      : toNumber(h.purchasePrice, 0) * qty;
    cardCount += qty;
  }
  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0;
  return {
    totalValue: round2(totalValue),
    totalCost: round2(totalCost),
    totalGainLoss: round2(totalGainLoss),
    totalGainLossPct: round2(totalGainLossPct),
    cardCount,
  };
}

// GET /api/portfolio  — items + summary in one payload for the iOS dashboard.
export async function getPortfolioWithSummary(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const items = Object.values(doc.holdings);
  const summary = summarizeHoldings(items);
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

  doc.ledger[index] = updated;
  await writeUserDoc(auth.userId, doc);

  res.json({ message: "Ledger entry updated", entry: updated });
}

export async function addHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const incoming = (req.body ?? {}) as Record<string, unknown>;
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

  const doc = await readUserDoc(auth.userId);
  const now = new Date().toISOString();
  const value = computePerUnitValue(holding) ?? toNumber(holding.purchasePrice, 0);
  appendPriceHistory(doc, holding.id, {
    at: now,
    value,
    confidence: toNumber(holding.confidence, 0),
    compsUsed: toNumber(holding.compsUsed, 0),
    source: "add",
  });

  holding.lastUpdated = holding.lastUpdated ?? now;
  holding.freshnessStatus = holding.freshnessStatus ?? "Live";
  doc.holdings[holding.id] = { ...doc.holdings[holding.id], ...holding };

  try {
    await autoPriceHolding(doc, doc.holdings[holding.id], undefined, "add");
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
  res.json(holding);
}

export async function updateHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  if (!doc.holdings[id]) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  const previous = doc.holdings[id];
  let next = { ...doc.holdings[id], ...(req.body as PortfolioHolding), id };
  next = normalizeR1CardsightCardId(
    next,
    id,
    "portfolioStore.service.updateHolding",
  );
  next = await populateCardsightGradeId(next);
  const now = new Date().toISOString();
  next.lastUpdated = next.lastUpdated ?? now;

  const prevValue = computePerUnitValue(previous) ?? 0;
  const nextValue = computePerUnitValue(next) ?? 0;
  if (nextValue > 0 && Math.abs(nextValue - prevValue) > 0.0001) {
    appendPriceHistory(doc, id, {
      at: toIso(next.lastUpdated, new Date()),
      value: nextValue,
      confidence: toNumber(next.confidence, 0),
      compsUsed: toNumber(next.compsUsed, 0),
      source: "update",
    });
  }

  doc.holdings[id] = next;

  try {
    await autoPriceHolding(doc, doc.holdings[id], previous, "update");
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
  };

  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    delete doc.holdings[id];
  } else {
    const updatedCostBasis = avgUnitCost * remainingQty;
    const currentValuePerUnit = quantityOwned > 0 ? (computeTotalValue(holding) ?? 0) / quantityOwned : 0;
    const nextCurrentValue = currentValuePerUnit * remainingQty;
    doc.holdings[id] = {
      ...holding,
      quantity: remainingQty,
      purchasePrice: avgUnitCost,
      totalCostBasis: updatedCostBasis,
      currentValue: nextCurrentValue,
      totalProfitLoss: nextCurrentValue - updatedCostBasis,
      totalProfitLossPct: updatedCostBasis > 0 ? ((nextCurrentValue - updatedCostBasis) / updatedCostBasis) * 100 : 0,
      lastUpdated: new Date().toISOString(),
      freshnessStatus: "Updated Today",
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
  };

  // 6. Mutate holding state (mirrors sellHolding).
  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    delete doc.holdings[holdingId];
  } else {
    const updatedCostBasis = avgUnitCost * remainingQty;
    const currentValuePerUnit =
      quantityOwned > 0 ? (computeTotalValue(holding) ?? 0) / quantityOwned : 0;
    const nextCurrentValue = currentValuePerUnit * remainingQty;
    doc.holdings[holdingId] = {
      ...holding,
      quantity: remainingQty,
      purchasePrice: avgUnitCost,
      totalCostBasis: updatedCostBasis,
      currentValue: nextCurrentValue,
      totalProfitLoss: nextCurrentValue - updatedCostBasis,
      totalProfitLossPct:
        updatedCostBasis > 0
          ? ((nextCurrentValue - updatedCostBasis) / updatedCostBasis) * 100
          : 0,
      lastUpdated: new Date().toISOString(),
      freshnessStatus: "Updated Today",
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

export async function refreshHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  const holding = doc.holdings[id];
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  doc.holdings[id] = await populateCardsightGradeId(holding);

  try {
    await autoPriceHolding(doc, doc.holdings[id], doc.holdings[id], "refresh");
  } catch {
    doc.holdings[id].freshnessStatus = "Live";
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
  updates: Array<{ id: string; status: "repriced" | "skipped" | "error" | "fresh"; reason?: string }>;
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
    try {
      const estimate = await computeEstimate({
        playerName: String(holding.playerName ?? "").trim(),
        cardYear: shimmedCardYear(holding),
        product: shimmedProduct(holding),
        parallel: String(holding.parallel ?? "").trim() || undefined,
        isAuto: Boolean(holding.isAuto),
        gradeCompany: String(holding.gradingCompany ?? holding.gradeCompany ?? "").trim() || undefined,
        gradeValue: toNumber((holding as any).gradeValue, 0) || undefined,
      });

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
        doc.holdings[holding.id] = {
          ...holding,
          compsUsed,
          confidence,
          freshnessStatus: "Stale",
          verdict: reasonLabel,
          recommendation: "Hold",
          lastUpdated: now,
        };
        updates.push({
          id: holding.id,
          status: "skipped",
          reason: `confidence-gate: ${failed.join(", ")} (source=${estSource || "ok"}${
            daysSinceNewestComp !== null ? `, daysSinceNewestComp=${daysSinceNewestComp}` : ""
          })`,
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
      const repriceTrendIQ = (estimate as any)?.trendIQ ?? null;
      const repriceRawComposite = repriceTrendIQ?.composite;
      const repriceRawImpliedPct = repriceTrendIQ?.impliedPct;
      const repriceMovementDirection =
        typeof repriceTrendIQ?.direction === "string" ? repriceTrendIQ.direction : null;
      const repriceMovementComposite =
        typeof repriceRawComposite === "number" && Number.isFinite(repriceRawComposite)
          ? repriceRawComposite
          : null;
      const repriceMovementImpliedPct =
        typeof repriceRawImpliedPct === "number" && Number.isFinite(repriceRawImpliedPct)
          ? repriceRawImpliedPct
          : null;
      const repriceMovementCoverage =
        typeof repriceTrendIQ?.coverage === "string" ? repriceTrendIQ.coverage : null;
      const repriceMovementUpdatedAt = repriceTrendIQ
        ? (repriceTrendIQ.lastUpdated ?? (estimate as any)?.signalsLastUpdated ?? now)
        : null;

      const updated: PortfolioHolding = {
        ...holding,
        currentValue: fairValue,
        fairMarketValue: fairValue,
        quickSaleValue: toNumber((estimate as any)?.quickSaleValue, fairValue * 0.88),
        premiumValue: toNumber((estimate as any)?.premiumValue, fairValue * 1.15),
        suggestedListPrice: toNumber((estimate as any)?.suggestedListPrice, fairValue * 1.05),
        predictedPrice: repricePredictedPrice,
        predictedPriceLow: repricePredictedPriceLow,
        predictedPriceHigh: repricePredictedPriceHigh,
        predictedPriceMechanism: repricePredictedPriceMechanism,
        predictedPriceUpdatedAt: repricePredictedPriceUpdatedAt,
        movementDirection: repriceMovementDirection,
        movementComposite: repriceMovementComposite,
        movementImpliedPct: repriceMovementImpliedPct,
        movementCoverage: repriceMovementCoverage,
        movementUpdatedAt: repriceMovementUpdatedAt,
        verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
        recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
        confidence,
        compsUsed,
        marketSpeed: String((estimate as any)?.marketDNA?.speed ?? holding.marketSpeed ?? "Normal"),
        marketPressure: String((estimate as any)?.marketDNA?.marketCondition ?? holding.marketPressure ?? "Balanced Market"),
        freshnessStatus: "Live",
        lastUpdated: now,
      };

      const basis = toNumber(updated.totalCostBasis, toNumber(updated.purchasePrice, 0) * Math.max(1, toNumber(updated.quantity, 1)));
      updated.totalProfitLoss = fairValue - basis;
      updated.totalProfitLossPct = basis > 0 ? ((fairValue - basis) / basis) * 100 : 0;

      appendPriceHistory(doc, holding.id, {
        at: now,
        value: fairValue,
        confidence,
        compsUsed,
        source,
      });

      evaluateHoldingAlerts(doc, previous, updated);
      doc.holdings[holding.id] = updated;
      repriced += 1;
      updates.push({ id: holding.id, status: "repriced" });
    } catch (error: any) {
      skipped += 1;
      updates.push({ id: holding.id, status: "error", reason: error?.message ?? "estimate-failed" });
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
