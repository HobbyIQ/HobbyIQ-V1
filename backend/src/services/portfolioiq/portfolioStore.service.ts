import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { isExactPoolRung } from "../compiq/fmvRung.js";
import { getUserBySession } from "../authService.js";
import { PortfolioHolding, type HoldingHeldExpense, type HeldExpenseKind } from "../../types/portfolioiq.types.js";
import type { CompIQEstimateRequest } from "../../types/compiq.types.js";
import { computeEstimate } from "../compiq/compiqEstimate.service.js";
// CF-GRADED-RAIL-WIRE-IN (2026-06-14): assemble the same gradedEstimates
// array /price-by-id surfaces, so a graded holding's stored valuation
// can mirror the rail's grounded/insufficient verdict at write time.
import { compileGradedEstimatesForCard } from "../compiq/compileGradedEstimatesForCard.js";
// CF-RECOMMENDATION-FLIP-ALERT (2026-07-06): action recommendation
// compute for the alert engine — verdict changes drive push notifs.
import { computeAction } from "../compiq/actionRecommendation.service.js";
// CF-GRADING-TIER-CATALOG (2026-07-06): PSA/BGS/SGC/CGC tier lookup
// for the iOS Mark-as-Graded dropdown + server-side cost resolution.
import { GRADING_TIERS, getGradingTierById } from "./gradingTiers.js";
import { getPricing as getPricingForMarketRead } from "../compiq/catalogSource.js";
import { buildGradeBreakdown } from "../compiq/marketRead.service.js";
import { resolvePlayer } from "../mlb/playerResolver.service.js";
import { deleteBlobByUrl } from "../photoStorage/photoStorage.service.js";
import { resolveCardsightGradeId } from "../cardsight/cardsightGradesTaxonomy.js";
import { fillDerivedSlugFromCatalog } from "./holdingSlug.service.js";
import {
  type DeferredOp,
  deferredOpsFor,
  markPending,
  readPending,
  clearOps,
  bumpAttempts,
  MAX_ATTEMPTS,
} from "./holdingSaveDeferredWork.js";
// CF-ONE-VALUATION-PATH (D17, 2026-08-30): the persist site prices the exact
// pool through the ONE valuation entry (holdingValuation → valueIdentity).
import { valueHoldingThroughOneEntry, holdingGrade as holdingGradeOf, costBasisFloorRefusalWrite, costBasisFloor, noBasisRefusalWrite, noBasisReasonFromEngine } from "./holdingValuation.js";
// CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). The legacy
// exact-pool writers below persist prices too — only for identities the
// catalog cannot name, but persist they do. They stamp the same label set
// the one-entry writer does, through the same derivation.
import { persistedLabelsForUnifiedResult } from "../compiq/valuationLabels.js";
// CF-ONE-PERSIST-HELPER (C-7, 2026-09-03): the ONE way a value reaches a
// holding doc. Requires a rung declaration + valueSource in the TYPE, so a
// write that omits either does not compile. See writeHoldingValuation.ts.
import { writeHoldingValuation } from "./writeHoldingValuation.js";
import { tierLabelFor } from "../compiq/oneValuationPath.service.js";
import { isPriceFromOurPoolEnabled, priceHoldingFromOurPool } from "./priceFromOurPool.service.js";
import { composeHoldingWireShape, composePortfolioListResponse, type WireEntitlements } from "./responseAssembly.js";
// CF-PRO-SELLER-GATE (Drew, 2026-09-02): the wire composer gates paid fields
// on the caller's effective plan; these are the single authority for that.
import { effectivePlanFor, hasEntitlement } from "../../config/entitlements.js";
// CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): background-run tracker for the
// dispatched batch reprice. Progress state only — never a price.
import * as repriceJobs from "./repriceJobTracker.js";
// CF-INVENTORY-CATALOG-IMAGE (2026-07-05): shared resolver produces the
// SAME cropped URL /api/compiq/price-by-id emits on cardImageUrl. iOS
// falls back to this behind the user's own uploaded photo.
import { resolveCatalogImageUrl } from "../compiq/cardImageResolver.js";
// CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE (2026-06-30): subscribe holdings
import {
  tryFinalizeReconciliation,
  type LedgerEntryForErp,
} from "./erpReconciliation.service.js";
// CF-EBAY-LINK-INDEX-P0.5 (Drew, 2026-07-26). Prod-readiness audit fix:
// per-webhook cross-partition scan of the portfolio container has been
// replaced by a point-read on a dedicated ebay_link_index container.
// See ebayLinkIndex.service.ts for shape + semantics.
import {
  writeLinkIndex as writeEbayLinkIndex,
  removeLinkIndex as removeEbayLinkIndex,
  findByOfferId as findEbayLinkByOfferId,
  findByListingId as findEbayLinkByListingId,
} from "./ebayLinkIndex.service.js";

// ─── Cosmos DB client (lazy init) ─────────────────────────────────────────────
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
// CF-EXACT-POOL-SUPREMACY (D4 PR 5, 2026-08-29): the persist-site guard.
import {
  EXACT_POOL_WINDOW_DAYS,
  countExactSalesInWindow,
  exactIdentityCandidates,
  isCrossIdentityRung,
  judgeExactPoolSupremacyForHolding,
  priceHoldingFromExactPool,
  type ExactPoolPrice,
  type ExactPoolSupremacyVerdict,
  type HoldingIdentityFields,
} from "./exactPoolSupremacy.js";

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
      // CF-IMPORT-ASYNC (2026-06-21): defaultTtl: -1 means "TTL enabled,
      // no default expiration." User holdings docs don't set `ttl`, so
      // they live forever. Import job docs set `ttl: 86400` per-doc and
      // expire 24h after last modification. This only applies to fresh
      // container creation — the prod portfolio container was updated
      // separately via `az cosmosdb sql container update --ttl -1`
      // 2026-06-21 (audit: 0/4 user docs carried a ttl property before
      // the change; the activation is no-op for them).
      const { container } = await database.containers.createIfNotExists({
        id: "portfolio",
        partitionKey: { paths: ["/userId"] },
        defaultTtl: -1,
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

// CF-IMPORT-ASYNC (2026-06-21): expose the container handle so the
// import-job store can write its own doc shape against the same
// `portfolio` container. Same partition key (/userId), distinct doc ids
// ("import-job-<jobId>"); coexists with the user doc, no race with
// concurrent holding writes. Test-mode null is preserved.
export const getPortfolioContainer = getContainer;
export const isPortfolioTestMode = isTestMode;

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
  // CF-PURCHASE-LEDGER-FOUNDATION (2026-07-12): buy-side counterpart to
  // `ledger` (which tracks sales). Each PortfolioPurchaseEntry records
  // an acquisition event (manual entry, eBay import, break, LCS trip) at
  // the ORDER level — multiple holdings can share one purchase via the
  // holdingIds[] back-reference. Optional so existing user docs load
  // without migration.
  purchases?: PortfolioPurchaseEntry[];
  // D26 (CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE, Drew 2026-08-30). Sold order
  // lines the hourly eBay ACCOUNT sync saw -- including the ones the user never
  // listed through HobbyIQ, which is the whole point. The buy-side counterpart
  // is `purchases`, and this deliberately mirrors it: an array on the user doc,
  // idempotent on the source's own id, no new container. A line whose identity
  // did not clear the 0.9 bar sits here PARKED with its best candidate, which
  // is the D12-a parked-match shape on a sale rather than on a holding.
  // Optional so every existing user doc loads without migration.
  ebayAccountSales?: EbayAccountSaleEntry[];
  // CF-VERDICT-FLIP-PUSH-PREFS (Drew, 2026-07-16, PR #499 follow-up):
  // per-user notification opt-ins. Absent → all defaults (all off).
  // Push worker (backend/scripts/verdict-flip-push-fanout.cjs) only
  // fans out to users where preferences.pushOnMajorFlip === true.
  preferences?: {
    /**
     * True when the user opted in during onboarding (or in Settings) to
     * receive an APNs push when a holding-player's verdict flips across
     * the bull/bear boundary. Only significance="major" flips route to
     * push regardless of this field — mixed-adjacency flips never fire.
     */
    pushOnMajorFlip?: boolean;
    /**
     * CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). True when the user opted
     * in (onboarding or Settings) to receive an APNs push when the
     * cascade detector fires an "insider" or "emerging" signal for a
     * player they hold. "confirmed"-severity events never route to
     * push regardless of this field — those are late-stage and would
     * spam. Separate from pushOnMajorFlip so users can opt into one
     * taxon without the other.
     */
    pushOnCascade?: boolean;
    /**
     * CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). True when the user
     * opted in to receive a daily digest push summarizing which of
     * their watchlist players moved > 10% (up or down) today. One
     * consolidated push per user per day, not per-card. Absent →
     * treated as opted-out (default off). Independent of
     * pushOnMajorFlip / pushOnCascade — the three taxons compose.
     */
    pushOnWatchlistDigest?: boolean;
    /**
     * CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). True when the user
     * opted in to receive a push when one of their holdings crosses
     * the grade-worthy threshold (expectedGain >= $200 AND the
     * per-tier recommendation is "grade_now"). Absent → treated as
     * opted-out (default off). Nightly job scans every user with
     * this flag on, per-holding, and dispatches at most one push per
     * fired holding per night.
     */
    pushOnGradeWorthy?: boolean;
  };
  // CF-VERDICT-FLIP-PUSH-DEVICE (Drew, 2026-07-16, PR #499 follow-up):
  // most-recent APNs device token registered by iOS at app launch.
  // Absent → user hasn't installed the iOS app version that reports
  // it, or the OS denied permission. Empty string / null are equivalent
  // to absent for the fan-out worker's gate. A user with multiple
  // devices only receives on the last-registered one for launch; a
  // deviceTokens[] extension is a follow-up.
  apnsDeviceToken?: string | null;
  apnsDeviceTokenUpdatedAt?: string | null;
  /**
   * CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): ms-epoch of the most
   * recent reprice DISPATCH for this user, persisted on the user doc.
   *
   * WHY DURABLE AND NOT JUST THE IN-PROCESS MAP
   * -------------------------------------------
   * `_lastRepriceAt` is a per-process Map and App Insights shows 2 serving
   * instances. Opening the portfolio now fires a refresh automatically, so
   * the throttle is no longer protecting against a user mashing a button —
   * it is the only thing standing between "Drew opens the tab twice" and
   * two concurrent 68s valuation runs. Round-robin puts open #2 on the
   * OTHER worker roughly half the time, where the in-process map is empty
   * and the throttle silently passes. That is the known in-process-lock
   * caveat ('cycle skipped' on both workers = surviving lock) pointed the
   * other way: here the *absence* of shared state lets work through
   * instead of blocking it.
   *
   * So the marker lives where both workers can see it: the user doc they
   * both already read on every reprice and every portfolio GET. It is
   * stamped at DISPATCH (before the pricing runs), not at completion —
   * a marker written only on success would leave a 68s window in which
   * every open starts another run.
   *
   * This is a throttle marker, never a price and never a cache of one.
   */
  lastRepriceDispatchAt?: number;
}

// ─── CF-PURCHASE-LEDGER-FOUNDATION (2026-07-12) ─────────────────────────────
//
// Buy-side counterpart to PortfolioLedgerEntry. Records acquisition events
// at the ORDER level (one purchase → N holdings). Populated by:
//   - Manual entry via POST /api/portfolio/erp/purchases
//   - eBay import via /erp/purchases/import/ebay (walks /sell/finances/v1/
//     transaction filtered on ORDER/SHIPPING_LABEL/PURCHASE)
//   - Add-holding auto-fill (a future extension: if the user records a
//     purchasePrice on POST /holdings, we can synthesize a stub purchase
//     entry so the analytics stays complete)
//
// Design decisions matching PortfolioLedgerEntry (sale) semantics:
//   - `source` marks provenance (manual | ebay | future: paypal, stripe)
//   - Idempotency is on (userId, source, sourceOrderId) so replay is safe
//   - Per-line costs stay on holdings (holding.purchasePrice); the entry
//     aggregates for period totals + attribution
//   - Non-line-item costs (shipping, tax, other) stay at the purchase
//     level; caller-side allocation is deferred to a follow-up PR (COGS
//     needs proportional allocation for accurate per-holding basis)
export type PurchaseSource = "manual" | "ebay";

export interface PortfolioPurchaseEntry {
  id: string;
  userId: string;
  /** ISO. Source date the user actually paid — NOT when we recorded it. */
  purchaseDate: string;
  source: PurchaseSource;

  // ─── Cost breakdown (dollars, positive) ─────────────────────────────
  /** Sum of per-item costs (subtotal before order-level shipping/tax/fees). */
  subtotal: number;
  /** Sales tax collected at purchase. */
  tax: number;
  /** Shipping paid to receive the order. */
  shipping: number;
  /** Non-shipping non-tax non-item fees (buyer protection, currency conv, etc). */
  otherFees: number;
  /** subtotal + tax + shipping + otherFees. Reader authoritative field. */
  totalCost: number;

  // ─── Attribution (which holdings this purchase acquired) ────────────
  /**
   * holdingIds populated from this purchase. May be empty at creation
   * time (e.g. eBay import lands before user catalogs the cards) and is
   * appended-to as user adds the holdings.
   */
  holdingIds: string[];

  // ─── Vendor / source metadata ───────────────────────────────────────
  /** Free-text vendor name — "eBay seller X", LCS name, break company. */
  vendor?: string;
  /** Free-text invoice reference for user-side reconciliation. */
  invoiceRef?: string;
  notes?: string;

  // ─── eBay-specific provenance (source==="ebay") ─────────────────────
  /** eBay's order ID for the purchase. Idempotency key for import.
   *  Populated from OrderLineItemID, format "itemId-transactionId". */
  ebayOrderId?: string;
  /** eBay Finances transactionId (distinct from orderId). */
  ebayTransactionId?: string;
  /** CF-EBAY-BROWSE-ENRICHMENT (2026-07-12): the listing's item id.
   *  Extractable from ebayOrderId (split on "-") but stored explicitly so
   *  the Browse API lookup + future sold-comps queries don't need to reparse. */
  ebayItemId?: string;

  createdAt: string;
  updatedAt?: string;
}

// CF-D1 (2026-06-20) — case-insensitive holding-key lookup.
//
// VERIFY (Cosmos-wide audit): 14/14 existing holding keys are uniformly
// lowercase. Existing data tolerates a lookup-side case-fold without
// backfill. New writes continue to use the iOS-supplied id verbatim
// (iOS sends lowercase UUIDs consistently); only LOOKUP is case-folded
// so a stray uppercase id from a future caller can't silently miss.
//
// `findHoldingKey` returns the actual stored key (or null), so callers
// that need to mutate via `doc.holdings[<canonicalKey>] = …` get the
// right key — preventing the duplicate-under-different-case write that
// would otherwise happen if the caller did `doc.holdings[incomingId] = …`
// after a successful case-folded lookup.
function findHoldingKey(doc: UserDoc, holdingId: string): string | null {
  if (!holdingId) return null;
  if (Object.prototype.hasOwnProperty.call(doc.holdings, holdingId)) return holdingId;
  const lower = holdingId.toLowerCase();
  if (lower !== holdingId && Object.prototype.hasOwnProperty.call(doc.holdings, lower)) {
    return lower;
  }
  for (const k of Object.keys(doc.holdings)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

function getHolding(doc: UserDoc, holdingId: string): PortfolioHolding | undefined {
  const key = findHoldingKey(doc, holdingId);
  return key ? doc.holdings[key] : undefined;
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
  cardId?: string;
  cardTitle: string;
  grade?: string;
  fmvAtTrade: number;
  fmvSource: "compiq" | "manual";
}

interface PortfolioPricePoint {
  at: string;
  value: number;
  source?: string;
  /** CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01). The valuationStatus the
   *  point was written under. ABSENT means "observed": every point written
   *  before this field existed was observed-only (the append was gated on it),
   *  so absence is not unknown — it is the old guarantee, and every reader
   *  that wants the observed trail reads it through observedPricePoints().
   *  Present and "estimated" = a grade-curve / fallback number, which drifts
   *  as the engine re-anchors and must never be read as a comp-anchored
   *  observation. */
  valuationStatus?: "observed" | "estimated";
  /** CF-A-MOVER-NEEDS-CORROBORATION (2026-09-03). The rung that produced
   *  this point's value, verbatim from the engine (`fmvRung` /
   *  `rungLabel`). An `exact-pool-*` label means the number was read from
   *  the exact (identity, grade) pool: a real sale of THIS card.
   *
   *  ABSENT means unknown — NOT exact-pool. Unlike `valuationStatus`,
   *  whose absence encoded the old append gate's guarantee, this field has
   *  no legacy meaning to inherit: points written before it existed carry
   *  no evidence of their rung, and a reader that needs corroboration
   *  (the weekly digest's movers) must treat them as uncorroborated rather
   *  than assume the best case. History heals forward — every write from
   *  here on carries the label. */
  rungLabel?: string;
}

/**
 * CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01). The observed-only trail —
 * the series priceHistory meant before estimated points were appended.
 *
 * Every existing reader wants THIS, and gets it by construction: points
 * written before the tag existed carry no valuationStatus and were
 * observed-only by the append gate. New estimated points are tagged and
 * filtered out here.
 */
export function observedPricePoints<T extends { valuationStatus?: string }>(points: readonly T[]): T[] {
  return points.filter((p) => p.valuationStatus === undefined || p.valuationStatus === "observed");
}

interface PortfolioAlert {
  id: string;
  level: "info" | "warning" | "critical";
  type:
    | "value-move"
    | "cost-basis-cross"
    | "stale-data"
    | "liquidity-risk"
    // CF-RECOMMENDATION-FLIP-ALERT (2026-07-06): "our SELL_NOW / HOLD
    // / LIST verdict on this holding just changed" — the notification
    // driver that turns action-recommendations into a push-notification
    // product. Fires only on meaningful flips (SELL_NOW / HOLD entry),
    // never on LIST↔LIST or transitions in/out of INSUFFICIENT_DATA.
    | "recommendation-flip"
    // CF-USER-PRICE-ALERTS (Drew, 2026-09-02): rule-driven per-holding move.
    // DISTINCT from "value-move" on purpose. The legacy 10%/18% emitter and
    // this one can both fire on the SAME holding in one reprice pass, and
    // addAlert dedups on (holdingId, type) within 6h — sharing the type let
    // the legacy row win and silently dropped the user's rule row (its rule
    // text, basis and speculative label) from the feed. Own type, own row.
    | "holding-move-rule";
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

// CF-CARDID-RENAME (2026-06-30): existing Cosmos docs store the holding
// catalog id under the legacy field name `cardsightCardId`. Internal code
// reads it via the new `cardId`. Normalize at the data boundary so the
// rest of the codebase never sees the legacy name.
//
// This is a one-way migration helper — written data only emits `cardId`
// (see writeUserDoc); the legacy field is silently dropped at next save.
// Read both, write new: safe rollback if a regression turns up because
// the data path still serves correctly during the transition.
function normalizeHoldingCatalogId(holding: Record<string, unknown> | undefined): void {
  if (!holding) return;
  if (holding.cardId == null && typeof holding.cardsightCardId === "string") {
    holding.cardId = holding.cardsightCardId;
  }
  // CF-GRADEID-RENAME (2026-06-30): companion hoist of legacy
  // cardsightGradeId → gradeId on the same data-boundary pass.
  if (holding.gradeId == null && typeof holding.cardsightGradeId === "string") {
    holding.gradeId = holding.cardsightGradeId;
  }
  // Don't delete legacy fields here — preserve them through the read so a
  // single deploy can be rolled back without losing data; the fields are
  // dropped at write time by writeUserDoc-side normalization.
}

function normalizeUserDocHoldings(doc: UserDoc | null | undefined): void {
  if (!doc?.holdings) return;
  for (const h of Object.values(doc.holdings)) {
    normalizeHoldingCatalogId(h as unknown as Record<string, unknown> | undefined);
  }
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
    normalizeUserDocHoldings(doc);
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
    // CF-CARDID-RENAME (2026-06-30): hoist legacy cardsightCardId → cardId
    // on any holding still carrying the old field name.
    normalizeUserDocHoldings(doc);
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

/**
 * CF-NO-IDENTITY-NO-PRICE-AT-THE-DOOR (Drew, 2026-08-23).
 *
 * CF-NO-IDENTITY-NO-PRICE (2026-08-22) put the rule — a holding we cannot
 * identify must not be quoted a price — inside autoPriceHolding, and that
 * implementation is correct: it blanks the surface and writes
 * fairMarketValue: null. It shipped, and the next day the card it was written
 * for was still wrong.
 *
 * Max Williams "2025 Bowman Draft Gold #CPA-MWI", holding aff3236a, $301.43
 * paid. Re-measured 2026-08-23 18:59Z:
 *
 *     cardId            (absent)          <- no identity at all
 *     catalogMatchSlug  …:cpa-mwi:gold:auto:num-50   <- the RIGHT answer, parked
 *     fairMarketValue   14.29             <- 4.7% of cost basis
 *     valuationStatus   "observed"        <- the strongest claim we can make
 *     verdict           "Variant approximation — parallel unverified"
 *     pricingSource     "legacy-engine"   sourceVendor "cardsight"
 *
 * autoPriceHolding did not write that number — it cannot, its guard runs first.
 * Some other writer did. There are 22 assignments to fairMarketValue in this
 * file alone, and the guard sat on one of them.
 *
 * That is the shape this codebase keeps repeating, named in
 * catalogMatcherCacheInvariant's own header: "a guard that is correct in
 * isolation but runs on only one of the paths the value can travel". The fix
 * for that shape is not a 23rd call site. It is to move the check to the one
 * place every path must pass through.
 *
 * writeUserDoc is that place: one upsert, and the test-mode branch below it.
 * Nothing reaches Cosmos without coming through here.
 *
 * WHAT IT DOES NOT DO. It does not invent a price, does not clear identity, and
 * does not touch a holding whose identity resolves. It withholds the VALUE
 * SURFACE only, and flags the row for review with the same wording
 * autoPriceHolding uses, so the two paths present identically.
 *
 * valuationStatus is cleared with the rest, unlike the 2026-08-22 version. A
 * withheld price cannot simultaneously be an "observed" one, and leaving that
 * word on the row is most of why the number read as authoritative on the card
 * page while the badge said UNVERIFIED.
 */
/**
 * CF-AN-ESTIMATE-IS-NEVER-OBSERVED (Drew, 2026-08-30, holding 7a90172d): a
 * sibling-parallel $3.26 sat on a PSA 9 Blue Refractor /150 with
 * `valuationStatus: "observed"` and `isEstimate: false`. Only an exact-pool
 * rung (the card's own sales at that tier) is observed; every other rung is
 * an estimate and says so — at the write, so no rung writer can forget.
 */
export function estimatesAreNeverObserved(doc: UserDoc): UserDoc {
  const holdings = doc?.holdings;
  if (!holdings || typeof holdings !== "object") return doc;
  let relabelled = 0;
  const next: Record<string, PortfolioHolding> = {};
  for (const [id, holding] of Object.entries(holdings as Record<string, PortfolioHolding>)) {
    if (!holding || typeof holding !== "object") { next[id] = holding; continue; }
    const h = holding as PortfolioHolding & { fmvRung?: string | null; isEstimate?: boolean; valuationStatus?: string | null };
    const rung = typeof h.fmvRung === "string" ? h.fmvRung : null;
    // A priced holding with NO rung is a pre-rung legacy price: it cannot claim
    // "observed" either (Max Williams Gold /50, $32.46, 2026-08-30). Unpriced
    // holdings are left alone.
    const priced = toNumber((h as { fairMarketValue?: unknown }).fairMarketValue, 0) > 0;
    if (!rung && !priced) { next[id] = holding; continue; }
    if (rung && isExactPoolRung(rung)) { next[id] = holding; continue; }
    if (h.isEstimate === true && h.valuationStatus === "estimated") { next[id] = holding; continue; }
    relabelled += 1;
    if (relabelled <= 5) {
      console.warn(JSON.stringify({
        event: rung ? "estimate_relabelled_at_write" : "no_rung_relabelled_at_write",
        source: "portfolioStore.writeUserDoc",
        holdingId: id,
        fmvRung: rung,
        wasValuationStatus: h.valuationStatus ?? null,
        wasIsEstimate: h.isEstimate ?? null,
      }));
    }
    next[id] = { ...(holding as PortfolioHolding), isEstimate: true, valuationStatus: "estimated" } as PortfolioHolding;
  }
  if (relabelled === 0) return doc;
  return { ...doc, holdings: next };
}

export function withholdPricesFromUnidentifiedHoldings(doc: UserDoc): UserDoc {
  const holdings = doc?.holdings;
  if (!holdings || typeof holdings !== "object") return doc;

  let withheld = 0;
  const next: Record<string, PortfolioHolding> = {};

  for (const [id, holding] of Object.entries(holdings as Record<string, PortfolioHolding>)) {
    if (!holding || typeof holding !== "object") { next[id] = holding; continue; }

    const identity = {
      cardId: (holding as { cardId?: string | null }).cardId ?? null,
      hobbyiqCardId: (holding as { hobbyiqCardId?: string | null }).hobbyiqCardId ?? null,
    };
    if (holdingIdentityIsResolved(identity)) { next[id] = holding; continue; }

    const hadPrice =
      toNumber((holding as { fairMarketValue?: unknown }).fairMarketValue, 0) > 0
      || toNumber((holding as { estimatedValue?: unknown }).estimatedValue, 0) > 0;
    if (!hadPrice) { next[id] = holding; continue; }

    withheld += 1;
    if (withheld <= 5) {
      console.warn(JSON.stringify({
        event: "unidentified_holding_price_withheld_at_write",
        source: "portfolioStore.writeUserDoc",
        holdingId: id,
        playerName: (holding as { playerName?: string }).playerName ?? null,
        cardNumber: (holding as { cardNumber?: string }).cardNumber ?? null,
        parallel: (holding as { parallel?: string }).parallel ?? null,
        withheldFairMarketValue: (holding as { fairMarketValue?: unknown }).fairMarketValue ?? null,
        withheldEstimatedValue: (holding as { estimatedValue?: unknown }).estimatedValue ?? null,
        // The answer we already had and did not use, so the log says how close
        // this row was to being right rather than only that it was wrong.
        catalogMatchSlug: (holding as { catalogMatchSlug?: string }).catalogMatchSlug ?? null,
        catalogMatchConfidence: (holding as { catalogMatchConfidence?: number }).catalogMatchConfidence ?? null,
        pricingSource: (holding as { pricingSource?: string }).pricingSource ?? null,
        sourceVendor: (holding as { sourceVendor?: string }).sourceVendor ?? null,
        costBasis: toNumber(
          (holding as { totalCostBasis?: unknown }).totalCostBasis,
          toNumber((holding as { purchasePrice?: unknown }).purchasePrice, 0),
        ),
      }));
    }

    next[id] = {
      ...holding,
      fairMarketValue: null as any,
      fmvRung: null,
      estimatedValue: null,
      estimateLow: null,
      estimateHigh: null,
      isEstimate: false,
      valuationStatus: null as any,
      needsReview: true,
      reviewReason:
        "We could not identify this card, so we are not showing a value. Confirm the set, card number and parallel.",
    } as PortfolioHolding;
  }

  if (!withheld) return doc;
  return { ...doc, holdings: next };
}

export async function writeUserDoc(userId: string, doc: UserDoc): Promise<void> {
  invalidateCache(userId);
  const container = await getContainer();

  // Every write to a portfolio doc passes through here. See
  // CF-NO-IDENTITY-NO-PRICE-AT-THE-DOOR above for why the check lives at the
  // door rather than at each of the 22 places that set a price.
  doc = estimatesAreNeverObserved(withholdPricesFromUnidentifiedHoldings(doc));

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

export interface PortfolioLedgerEntry {
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
  // Manual entries emit `source: "manual"` explicitly (CF-MANUAL-SELL-EXPLICIT-
  // SOURCE, PR #373). All other eBay fields (ebayOrderId, ebayOfferId, etc.)
  // are still omitted on manual entries. Legacy entries written before
  // PR #373 may have `source` absent — readers MUST tolerate absent as
  // synonymous with "manual" and absent `needsReconciliation` as false, so
  // pre-#373 rows aggregate correctly.
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
  // CF-RECONCILE-FINALIZE (2026-07-12): timestamp of the moment the two
  // axes were satisfied and needsReconciliation flipped to false. Set by
  // tryFinalizeReconciliation on the successful path. Present only on
  // finalized rows — absent on rows still awaiting fees or costs.
  reconciledAt?: string;
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

  // ----- CF-REGRADE-LEDGER-LINE-ITEM (2026-07-06) ----------------------------
  // Discriminates SALE ledger entries from REGRADE audit entries so the
  // iOS ledger UI can render grade conversions as their own line item.
  //   action absent OR "sale" → sale entry (legacy + new sale writes)
  //   action === "regrade"    → grade conversion event; sell-side
  //                              financials (grossProceeds, netProceeds,
  //                              realizedProfitLoss) are all 0 and MUST
  //                              be excluded from P&L / tax rollups.
  // erpAnalytics.buildGroup already skips entries with action !== "sale"
  // when accumulating totals so historical entries (no action field) still
  // aggregate correctly.
  action?: "sale" | "regrade";
  // Grading cost rolled into totalCostBasis on the holding at the moment
  // of this regrade. Populated only when action === "regrade". iOS renders
  // this as the line-item amount ("$25 grading — cost basis $200 → $225").
  gradingCostAmount?: number;
  // The grade transition ("Raw" → "PSA 9"). Populated only when
  // action === "regrade". Purely presentational — iOS renders as the
  // ledger entry title.
  regradeFromGrade?: string;
  regradeToGrade?: string;

  // ----- CF-EBAY-SOLD-COMPS-FOUNDATION (2026-07-12) --------------------------
  // Enriched snapshot of the eBay listing at the moment of sale — captured
  // ONCE at ITEM_SOLD time (or on manual reconcile), before the listing
  // ends and Browse API may 404. This is the foundation for our own sold-
  // comps pool: every sale we complete gives us a market data point tied
  // to the same structured aspects downstream matching will key on.
  //
  // enrichedFromEbay=true means the fields below were populated from
  // Browse; absent/false means title-parse only or manual entry with no
  // listing.
  enrichedFromEbay?: boolean;
  // Same shape as the buy-side enrichment fields on PortfolioHolding so
  // iOS + analytics share decoders.
  ebayItemAspects?: Record<string, string>;
  ebayImageUrl?: string | null;
  ebaySoldImages?: string[] | null;
  ebayShortDescription?: string | null;
  ebayCategoryPath?: string | null;
  ebaySellerUsername?: string | null;
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
  | "ebay_finances"        // populated by the eBay Finances API enrichment path
  | "manual_override"      // user supplied via POST /unreconciled/:id/override
  | "manual_entry"         // user supplied at sale time (sellHolding manual path)
  | "manual_user_finalize"; // CF-RECONCILE-FINALIZE (2026-07-12): user chose
                            // to close the row without waiting for eBay's
                            // fees feed; distinguishes forced finalizes from
                            // enrichment-driven ones in P&L audits.

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

/**
 * CF-PRICING-CONFIDENCE-SCALE (2026-09-03).
 *
 * Convert a CompIqEstimate `confidence.pricingConfidence` into the 0..1 scale
 * the holding's flat `confidence` field is declared on.
 *
 * THE CONTRACT, made explicit because getting it wrong is silent:
 *
 *   input  — 0..100. This is the declared type (`compiq.types.ts`:
 *            `confidence.pricingConfidence: number`) and what every producer
 *            in compiqEstimate.service.ts emits: the literal rungs 0, 15, 25,
 *            40, 55, and the calibrated value at ~7491 which is explicitly
 *            clamped `Math.min(100, ...)` then tier-capped. The routes have
 *            always read it as percent (`(pricingConfidence ?? 60) / 100`).
 *   output — 0..1, clamped, or null when the input is not a usable number.
 *
 * We do NOT sniff the scale. A value of 0.37 on the wire is 0.37 PERCENT, not
 * 37% — the one producer that emits a sub-1 value (the variant-mismatch branch
 * at compiqEstimate.service.ts ~6007, `pricingConfidence: 0.2`) means "almost
 * no confidence", so scaling it to 0.002 and letting it fall under every
 * downstream floor is the correct, honest reading. Auto-detecting "looks
 * already scaled" would silently promote that 0.2 to 20% and would make the
 * function's output depend on the magnitude of its input, which is exactly the
 * class of bug this replaces.
 */
export function scalePricingConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw / 100));
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
  // CF-PORTFOLIO-TOTAL-INCLUDE-ESTIMATED (Drew, 2026-08-04). Estimated
  // holdings (graded-rail estimates, ladder fallbacks, sibling-derived
  // FMVs) carry fairMarketValue=null on disk but estimatedValue set —
  // Drew's portfolio was showing under-counted totals because estimated
  // rows fell straight from observed → cost proxy, skipping their real
  // estimated dollar. Roll them in before cost fallback so total value
  // reflects real market signal (~$5,014 including estimates vs $3,124
  // observed-only for Drew's 14 holdings).
  const qty = Math.max(1, toNumber(holding.quantity, 1));
  const est = (holding as { estimatedValue?: number | null }).estimatedValue;
  if (typeof est === "number" && Number.isFinite(est) && est > 0) {
    return est * qty;
  }
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
//   7. cardId + pinnedAuthoritative: the explicit CF goal. Site 3
//      previously did not pin, so sparse-identity holdings re-resolved by
//      name search in the engine — same mis-resolution shape that hit
//      persistence sites (Trout $331 → $2) until 3e7cf30 + f6fda5d.
//
// Per-site `callContext` (source, userId, holdingId, routedFromHolding) is
// the caller's concern — layered separately at each computeEstimate call.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * CF-FINAL-PRICE-COHERENCE (2026-08-22), part 1.
 *
 * An "estimated" holding whose FMV falls outside its own estimate band is
 * internally incoherent whichever number is right. Barry Bonds (holding
 * 46f3dd96) stored fairMarketValue 112.50 against estimateLow 21 /
 * estimateHigh 31 with estimatedValue 26 — the UI rendered 112.50 while the
 * engine's own band said 21-31.
 *
 * Returns the FMV that should be published: unchanged when coherent, else the
 * estimatedValue (the honest answer for an estimated holding), else null.
 * Pure so it can be pinned by tests without Cosmos.
 */
/**
 * CF-NO-IDENTITY-NO-PRICE (2026-08-22).
 *
 * A holding we cannot identify must not be quoted a price. Max Williams
 * "2025 Bowman Draft Gold #CPA-MWI" (holding deced7d3, $301.43 paid) carried
 * NO cardId and NO hobbyiqCardId — catalogMatchedBy "not-found", confidence
 * 0.3 — and still rendered VALUE $13.64 and P&L -95.5%. The $13.64 was the
 * BASE Refractor's price (the sibling holding 98eda1a3 is $14.44) leaking onto
 * a /50 Gold through a fallback pool.
 *
 * Measured 2026-08-22: 18 sports holdings in this state carrying $2,117.19 of
 * cost basis — 23% of the portfolio — every one of them showing a confident
 * number with no warning attached.
 *
 * "Unverified" as a badge is not enough when the number beside it looks real.
 * No identity, no price.
 */
/** CF-ADD-KEEPS-THE-SLUG-YOU-VIEWED (2026-08-22). A re-derivation must clear
 *  this to move a user off a canonical slug they added from. 0.9 is the bar
 *  every other identity-adoption site already uses — ebayAutoHolding,
 *  ebayReviewQueue, resolveCert. */
const ADD_SLUG_OVERRIDE_MIN_CONFIDENCE = Number(
  process.env.ADD_SLUG_OVERRIDE_MIN_CONFIDENCE ?? 0.9,
);

export function holdingIdentityIsResolved(input: {
  cardId?: string | null;
  hobbyiqCardId?: string | null;
}): boolean {
  const vendorId = String(input.cardId ?? "").trim();
  const slug = String(input.hobbyiqCardId ?? "").trim();
  return vendorId !== "" || slug !== "";
}

/**
 * CF-NO-REGRESSION-ON-STARVED-POOL (2026-08-22). Should a reprice that came
 * back with nothing be allowed to erase the price we already had?
 *
 * No — a recompute that produced neither an FMV nor an estimate is a failed
 * query, not an observation that the card became worthless. Ohtani 2018 Bowman
 * Chrome #1 PSA 9 lost a correct $2,341.20 (225 real sales, equal to its own
 * grade-curve tile) to a reprice that ran during a Cosmos throttling event.
 *
 * Deliberately narrow:
 *   - only when the new surface has BOTH no fmv and no estimate. Any number at
 *     all, including a worse one, is a real answer and wins.
 *   - only when a positive value is already stored. Nothing to protect
 *     otherwise.
 *   - only when identity resolves. The unidentified path withholds prices ON
 *     PURPOSE (#1179) and must keep doing so.
 */
export function shouldKeepStoredPriceOnEmptySurface(input: {
  newFairMarketValue: number | null | undefined;
  newEstimatedValue: number | null | undefined;
  storedFairMarketValue: number | null | undefined;
  identityResolved: boolean;
}): boolean {
  if (!input.identityResolved) return false;
  const stored = typeof input.storedFairMarketValue === "number" ? input.storedFairMarketValue : 0;
  if (!Number.isFinite(stored) || stored <= 0) return false;
  const hasFmv = typeof input.newFairMarketValue === "number" && Number.isFinite(input.newFairMarketValue);
  const hasEst = typeof input.newEstimatedValue === "number" && Number.isFinite(input.newEstimatedValue);
  return !hasFmv && !hasEst;
}

export function reconcileEstimatedFmvToBand(input: {
  valuationStatus: string | null | undefined;
  fairMarketValue: number | null | undefined;
  estimateLow: number | null | undefined;
  estimateHigh: number | null | undefined;
  estimatedValue: number | null | undefined;
}): { fmv: number | null; changed: boolean } {
  const { valuationStatus, fairMarketValue, estimateLow, estimateHigh, estimatedValue } = input;
  const fmv = typeof fairMarketValue === "number" && Number.isFinite(fairMarketValue) ? fairMarketValue : null;
  if (valuationStatus !== "estimated") return { fmv, changed: false };
  if (fmv === null) return { fmv, changed: false };
  if (typeof estimateLow !== "number" || typeof estimateHigh !== "number") return { fmv, changed: false };
  if (!Number.isFinite(estimateLow) || !Number.isFinite(estimateHigh)) return { fmv, changed: false };
  if (fmv >= estimateLow && fmv <= estimateHigh) return { fmv, changed: false };
  const replacement =
    typeof estimatedValue === "number" && Number.isFinite(estimatedValue) && estimatedValue > 0
      ? estimatedValue
      : null;
  return { fmv: replacement, changed: true };
}

/**
 * CF-FINAL-PRICE-COHERENCE (2026-08-22), part 2.
 *
 * CF-COST-BASIS-SANITY-FLOOR (2026-08-04) refuses a proposed FMV under 15% of
 * cost for holdings over $50 — but it lived inside the our-pool branch only.
 * Jac Caglianone (holding 9b971b03) arrived with pricingSource=null, so the
 * floor never ran and $9.66 published against $205.48 paid (4.7%). The root
 * cause was an identity error: eBay's Set aspect said "2024 Bowman Draft"
 * while the seller's own title said "2026 Topps Chrome".
 *
 * Flags for review; deliberately does NOT overwrite the price. We have no
 * better number, and silently nulling it would hide a card that genuinely
 * crashed. Re-identifying here was measured and rejected: title-over-aspect
 * precedence would have re-identified 10 of 59 titled eBay holdings (16.9%),
 * only 2 of which were real errors.
 */
export const COST_BASIS_REVIEW_FLOOR_PCT = 0.15;
export const COST_BASIS_REVIEW_MIN_COST = 50;

/** CF-A-REVIEW-FLAG-MUST-BE-RETRACTABLE (Drew, 2026-08-23: "But missing
 *  doesn't go away after I verify it" / "I selected the correct card and it
 *  still does this").
 *
 *  The sentence this check writes, used to prove OWNERSHIP before retracting.
 *
 *  needsReview is written by three different concerns — parse confidence at
 *  import, the unidentified-holding guard, and this cost-basis floor — and
 *  they share one boolean. Clearing it on a healthy price ratio without
 *  checking who set it would silently unflag a holding that is flagged for a
 *  completely different, still-true reason. That is the exact defect shape
 *  this codebase keeps producing: a guard that is correct in isolation,
 *  applied at the wrong scope. The reason string is the only ownership
 *  evidence stored, so it is what we test. */
const COST_BASIS_REVIEW_SUFFIX = "likely a card-identity mismatch, not a price move.";

export function isCostBasisReviewReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.endsWith(COST_BASIS_REVIEW_SUFFIX);
}

/** Flags a holding whose value is implausibly far below what was paid — and,
 *  since 2026-08-23, UNFLAGS it when that stops being true.
 *
 *  The original returned `{}` on a healthy ratio, which reads as "nothing to
 *  say" but spreads as "leave the old flag exactly where it is". So the flag
 *  was a one-way switch: once a holding was flagged, no later reprice could
 *  ever retract it, no matter how completely the underlying problem was fixed.
 *
 *  Measured on holding aff3236a (2025 Bowman Draft Gold Refractor /50 auto,
 *  $301.43 paid). The owner picked the correct catalog card, the identity
 *  pinned cleanly, and the reprice moved the value $13.50 -> $53.77 — from
 *  4.5% of cost to 17.8%, comfortably above the 15% floor. The flag and its
 *  now-false sentence ("FMV $13.50 is 4.48% of $301.43 paid") stayed on the
 *  card anyway, telling the owner their verified card still needed verifying.
 *
 *  Retracts ONLY a flag this check set (see isCostBasisReviewReason). Never
 *  retracts while there is no price to judge: a holding that lost its value
 *  entirely has not been vindicated, it has gone quiet, and dropping the flag
 *  there would hide it. */
export function costBasisReviewPatch(input: {
  costBasis: number | null | undefined;
  fairMarketValue: number | null | undefined;
  quantity?: number | null;
  /** Current stored flag state. Omit and the function only ever sets, which
   *  is the pre-2026-08-23 behaviour and is what every non-pricing caller
   *  wants. */
  needsReview?: boolean | null;
  reviewReason?: string | null;
}): { needsReview?: boolean; reviewReason?: string | null } {
  const qty = Math.max(1, typeof input.quantity === "number" && Number.isFinite(input.quantity) ? input.quantity : 1);
  const cost = typeof input.costBasis === "number" && Number.isFinite(input.costBasis) ? input.costBasis : 0;
  const fmv = typeof input.fairMarketValue === "number" && Number.isFinite(input.fairMarketValue) ? input.fairMarketValue : 0;
  const proposed = fmv > 0 ? fmv * qty : 0;

  // Retraction, available only where this check is the one that flagged.
  const retract = (): { needsReview?: boolean; reviewReason?: string | null } =>
    input.needsReview === true && isCostBasisReviewReason(input.reviewReason)
      ? { needsReview: false, reviewReason: null }
      : {};

  // The check no longer applies to this holding at all (cost fell below the
  // floor's minimum) — so it has no standing to keep asserting anything.
  if (!(cost > COST_BASIS_REVIEW_MIN_COST)) return retract();
  // No price to judge. Say nothing; do NOT retract.
  if (!(proposed > 0)) return {};
  if (proposed / cost >= COST_BASIS_REVIEW_FLOOR_PCT) return retract();

  const pct = Math.round((proposed / cost) * 10000) / 100;
  return {
    needsReview: true,
    reviewReason: `FMV $${proposed.toFixed(2)} is ${pct}% of $${cost.toFixed(2)} paid — ${COST_BASIS_REVIEW_SUFFIX}`,
  };
}

export function buildEstimateRequestFromHolding(
  holding: PortfolioHolding,
): CompIQEstimateRequest {
  const pinnedCardId =
    String(holding.cardId ?? "").trim() || undefined;
  // CF-GRADED-IDENTITY-REQUIRES-VALUE (2026-08-22). A grading company with no
  // numeric grade is not a valid graded identity, and passing the half that
  // exists is worse than passing neither: the comp pool is NOT grade-filtered
  // (that guard requires gradeValue !== undefined) so the anchor stays raw,
  // while gradeCompany still rides into the canonical ladder and pushes it off
  // direct-comp onto a projection rung. Measured 2026-08-22: 3 of 79 live
  // holdings sat in this state. Verified against prod Cosmos for Kurtz P-3 —
  // dropping the orphan company moves canonical from neighbor-parallel
  // $3,724.31 @0.21 to direct-comp $3.0975 @0.90.
  const rawGradeCompany =
    String(holding.gradingCompany ?? holding.gradeCompany ?? "").trim() || undefined;
  const rawGradeValue = toNumber((holding as any).gradeValue, 0) || undefined;
  const hasGradedIdentity = rawGradeCompany !== undefined && rawGradeValue !== undefined;
  if (rawGradeCompany !== undefined && rawGradeValue === undefined) {
    console.warn(JSON.stringify({
      event: "holding_graded_identity_incomplete",
      source: "portfolioStore.buildEstimateRequestFromHolding",
      holdingId: holding.id,
      gradingCompany: rawGradeCompany,
      action: "priced_as_raw",
    }));
  }
  return {
    playerName: String(holding.playerName ?? "").trim(),
    cardYear: shimmedCardYear(holding),
    product: shimmedProduct(holding),
    parallel: String(holding.parallel ?? "").trim() || undefined,
    isAuto: Boolean(holding.isAuto),
    // CF-THE-GUARD-NEVER-SAW-THE-CARD-NUMBER (Drew, 2026-08-23).
    //
    // CF-SIBLING-POOL-SKIP-FOR-AUTOS (compiqEstimate.service.ts:6352) exists
    // to stop exactly one failure: when a Bowman-family auto's own pool is
    // thin, computeEstimate's sibling rescue widens to fetchCompsByPlayer —
    // player + product + year, with NO card number and NO parallel — and
    // prices a /50 auto off hundreds of base commons. It was written after the
    // 2026-07-03 Hartman CPA-EHA trace found 315 sibling sales producing a $9
    // median for a card catalogued at $1038.
    //
    // The guard reads cardIdentity.number. This builder never populated
    // cardNumber, needsParseFallback (compiqEstimate.service.ts:4354) requires
    // !cardYear && !product so the defensive re-parse never fires either, and
    // buildIdentityFromContext (:531) therefore sets number: null. The regex
    // ran against "" on every portfolio reprice, matched nothing, and the
    // rescue it was written to prevent ran anyway — for thirteen months on the
    // one rail where the damage lands on a real person's holdings.
    //
    // Measured on prod at the time of this change: 5 of 92 holdings were being
    // priced by that rescue, every one of them a numbered auto, showing 0.7% to
    // 19.2% of what was paid — CPA-TG at $17.77 against $700, CPA-MWI at
    // $53.77 against $301.43.
    //
    // This does not compute a better price. It stops the engine manufacturing
    // one out of a pool that belongs to different cards.
    cardNumber: String(holding.cardNumber ?? "").trim() || undefined,
    gradeCompany: hasGradedIdentity ? rawGradeCompany : undefined,
    gradeValue: hasGradedIdentity ? rawGradeValue : undefined,
    isBlackLabel: (holding as any).isBlackLabel === true ? true : undefined,
    cardId: pinnedCardId,
    // CF-HOLDING-REFRESH-PARALLELID-THREAD (2026-06-26): thread the
    // holding's stored parallelId into the engine input so the CH
    // bridge canonicalize step fires on every refresh path (autoPrice
    // for add/update/refresh + the repriceHoldingsForUser background
    // job). Without this, only the comp-tap /price-by-id path carried
    // parallelId, and pull-to-refresh on a holding silently bypassed
    // canonicalize — landing on BASE or null for parallel cards whose
    // loose `holding.parallel` string lacked the variant token.
    parallelId: holding.parallelId ?? undefined,
    pinnedAuthoritative: pinnedCardId !== undefined,
    // CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26): thread the
    // holding's purchasePrice so the cardhedge-last-sale signal helper
    // can compute positionSignal (gain/loss vs lastSale + vs expectation).
    // Optional — null when the holding has no purchasePrice; positionSignal
    // is then absent from the response shape.
    purchasePrice:
      typeof holding.purchasePrice === "number" &&
      Number.isFinite(holding.purchasePrice) &&
      holding.purchasePrice > 0
        ? holding.purchasePrice
        : null,
  };
}

/**
 * CF-PHOTO-PATCH-LATENCY (Drew, 2026-08-12): true when `next` differs from
 * `previous` in any field the pricing engine actually reads.
 *
 * Derived by diffing buildEstimateRequestFromHolding's own output rather than
 * a hand-listed field set, so it cannot drift out of sync with the engine
 * input above: the day a new field starts feeding computeEstimate, it starts
 * gating here too. Both sides come from the same object literal, so key order
 * is stable and a JSON compare is sound.
 *
 * Fails OPEN. An absent `previous` or a throwing comparison returns true — we
 * never skip pricing because the check itself failed.
 */
export function estimateInputChanged(
  previous: PortfolioHolding | undefined,
  next: PortfolioHolding,
): boolean {
  if (!previous) return true;
  try {
    // CF-THE-SLUG-IS-A-PRICING-INPUT-TOO (Drew, 2026-08-23: "this consistently
    // drops the price... unless I refresh, the price is wrong").
    //
    // buildEstimateRequestFromHolding is the LEGACY engine's input, and it
    // carries cardId but not hobbyiqCardId. priceHoldingFromOurPool prices from
    // the SLUG. So the our-pool path reads a field this comparison could not
    // see: correct a holding's identity, the slug moves, this returns false,
    // no reprice runs, and the stale number stays on screen until the user
    // hits Refresh by hand.
    //
    // Live case — 2024 Bowman Draft Theo Gillen #CPA-TG Blue Refractor /150,
    // $700 paid. Identity corrected to the Blue Refractor slug; stored FMV
    // stayed at 17.80 and the page read -97.5%. Asked directly at 00:11Z the
    // engine returns 729 for that exact slug (rare-card-anchor, "Last sold $729
    // on 2026-08-20"). The engine was right the whole time and nothing asked it
    // again.
    //
    // This matters MORE after CF-ONE-PIN-GATE-EVERYWHERE: a rebind below 0.9
    // now moves hobbyiqCardId alone, so without this the entire sub-0.9 rebind
    // path silently skips repricing.
    const slugOf = (h: PortfolioHolding) =>
      String((h as { hobbyiqCardId?: unknown }).hobbyiqCardId ?? "").trim();
    if (slugOf(previous) !== slugOf(next)) return true;

    return (
      JSON.stringify(buildEstimateRequestFromHolding(previous)) !==
      JSON.stringify(buildEstimateRequestFromHolding(next))
    );
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-IDENTITY-HYDRATION (2026-06-18): backfill identity fields on a holding
// from the engine's resolved Cardsight catalog identity.
//
// Why: a holding can carry a correct cardId but empty identity
// fields (year/set/product/parallel/cardNumber/isAuto). The pinned-id fix
// (3e7cf30 + f6fda5d + bda96e4) makes PRICING correct on those holdings.
// This helper makes IDENTITY correct too — titles auto-compose, holding
// display stops showing blanks, alerts and Phase-5 reads see complete data.
//
// Trigger: piggyback on the existing reprice writeback (no new Cardsight
// call). The engine already resolves the rich catalog card as part of
// pinned-id pricing and returns it on `estimate.cardIdentity`. Both
// persistence sites (autoPriceHolding + repriceHoldingsForUser) read
// `estimate` already; they just call this helper to compute the patch
// before stamping the writeback.
//
// Source of truth — confirmed live shape at 2026-06-18 pinned-id probe:
//   estimate.cardIdentity = {
//     card_id: string,
//     title:   string | null,   // == player on pinned-id path
//     player:  string | null,
//     set:     string | null,   // SUBSET name ("Base Set", "Chrome Prospects Autographs")
//     release: string | null,   // PRODUCT LINE ("Topps Update", "Bowman")
//     year:    number | null,   // already coerced from set.year string
//     number:  string | null,
//     variant: string | null,
//   }
//
// Safety rules:
//   1. PIN-AUTHORITATIVE GUARD. Hydrate ONLY when the engine's resolved
//      card_id matches the holding's stored cardId. This
//      rejects:
//        - unpinned holdings (engine resolves by name; resolution may
//          land on a different card than the user intends, see the
//          Trout-$2 bug class)
//        - vendor flaps where the engine resolved a different card_id
//          than requested (consistency guard at compiqEstimate.service
//          .ts:1310 already returns stub identity for those, so this
//          extra check is belt-and-suspenders)
//   2. FILL-IF-EMPTY. Each candidate field is filled only when the
//      holding's existing value is undefined / null / empty-after-trim.
//      Never overwrite a user-entered value (Hartman's manually-typed
//      `parallel: "Blue X-Fractor /150"` is preserved by virtue of NOT
//      being a candidate — parallel is not in `cardIdentity` for the
//      base card and we don't hydrate it). The product/setName/cardYear
//      fields ARE candidates and are protected by this rule.
//   3. isAuto TREATMENT. `undefined` → eligible for fill (heuristic from
//      catalog set name + card number prefix matches the engine's own
//      regex in cardQueryParser.ts). `false` → SKIP (we don't know if
//      it was set deliberately or defaults from iOS; safer to under-
//      hydrate than to flip a user's toggle). `true` → SKIP (already
//      set).
//   4. PRODUCT = `release` LITERAL. Hartman's release is `"Bowman"`,
//      not `"Bowman Chrome"`. We store the engine's literal value. Any
//      brand+set qualifier ("Chrome") is encoded in `setName` (the
//      subset, e.g. "Chrome Prospects Autographs") and the eBay title
//      composer's brand-vs-set dedup handles it. Storage stays clean.
//
// Returns the patch (a Partial<PortfolioHolding>) for the caller to merge.
// Empty patch ({}) when nothing changed. Pure function — no side effects.
// ─────────────────────────────────────────────────────────────────────────────

// Mirror cardQueryParser's AUTO_PREFIX_RE (cardQueryParser.ts:319 / 394).
// Inlined rather than imported to avoid a cross-package edge from the
// portfolio store reaching into the compiq parser; both copies will stay
// in lock-step by convention (and they're tested below).
const HYDRATE_AUTO_WORD_RE = /\bauto(graph(s|ed)?|s)?\b/i;
const HYDRATE_AUTO_PREFIX_RE =
  /\b(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa)[-,)\s]/i;

interface ResolvedCardIdentity {
  card_id?: string | null;
  title?: string | null;
  player?: string | null;
  set?: string | null;
  release?: string | null;
  year?: number | null;
  number?: string | null;
  variant?: string | null;
}

function isEmptyString(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim().length === 0);
}

export function hydrateHoldingIdentityFromEstimate(
  holding: PortfolioHolding,
  cardIdentity: ResolvedCardIdentity | null | undefined,
): Partial<PortfolioHolding> {
  // Gate 1 — must have an engine-resolved identity object.
  if (!cardIdentity || typeof cardIdentity !== "object") return {};

  // Gate 2 — pin-authoritative match. Only hydrate when the engine's
  // resolved card_id matches what's stored on the holding. Rejects
  // unpinned holdings (engine resolved by name) AND vendor-flap cases.
  const storedCardId = String(holding.cardId ?? "").trim();
  if (storedCardId.length === 0) return {};
  const resolvedCardId = String(cardIdentity.card_id ?? "").trim();
  if (resolvedCardId.length === 0 || resolvedCardId !== storedCardId) return {};

  const patch: Partial<PortfolioHolding> = {};

  // cardYear: engine already coerces set.year string → number. Fill when
  // holding's cardYear is empty AND neither legacy `year` field is set.
  if (
    isEmptyString((holding as any).cardYear) &&
    isEmptyString((holding as any).year) &&
    typeof cardIdentity.year === "number" &&
    Number.isFinite(cardIdentity.year) &&
    cardIdentity.year > 0
  ) {
    patch.cardYear = cardIdentity.year;
  }

  // setName: the subset name (Cardsight's `set.name`).
  if (
    isEmptyString(holding.setName) &&
    typeof cardIdentity.set === "string" &&
    cardIdentity.set.trim().length > 0
  ) {
    patch.setName = cardIdentity.set.trim();
  }

  // product: the product line / release (Cardsight's `set.release`).
  // LITERAL — no heuristic concat with set.name. See helper doc for why.
  if (
    isEmptyString(holding.product) &&
    typeof cardIdentity.release === "string" &&
    cardIdentity.release.trim().length > 0
  ) {
    patch.product = cardIdentity.release.trim();
  }

  // cardNumber: direct.
  if (
    isEmptyString(holding.cardNumber) &&
    typeof cardIdentity.number === "string" &&
    cardIdentity.number.trim().length > 0
  ) {
    patch.cardNumber = cardIdentity.number.trim();
  }

  // isAuto: undefined → eligible for heuristic fill. false → skip. true → skip.
  // Heuristic: cardIdentity.set name contains an "auto" word OR
  // cardIdentity.number matches the auto-prefix regex. Mirrors the engine's
  // own AUTO detection in cardQueryParser.ts.
  if (holding.isAuto === undefined) {
    const setText = typeof cardIdentity.set === "string" ? cardIdentity.set : "";
    const numberText = typeof cardIdentity.number === "string" ? cardIdentity.number : "";
    const looksAuto =
      HYDRATE_AUTO_WORD_RE.test(setText) ||
      HYDRATE_AUTO_PREFIX_RE.test(numberText);
    if (looksAuto) {
      patch.isAuto = true;
    } else {
      // We can also confidently set isAuto=false when the catalog gives
      // us a clear no-auto signal. This converts undefined → false on
      // base cards (Trout 2011 Topps Update), which is honest. Skip
      // false-set holdings (already done above; undefined gate covers it).
      patch.isAuto = false;
    }
  }

  return patch;
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

// CF-INVENTORY-RAW-CLEAR (2026-07-12): "user picked Raw" normalizer.
//
// iOS can send any of {null, "", "Raw"} to mean "clear the grade."
// Downstream readers (pricing, comps, iOS decoders) all want a truly
// absent field on a Raw holding — no dangling gradeCompany: null.
//
// TWO steps:
//   1. normalizeRawGradeClearSignal — before the {...previous, ...body}
//      spread, convert every clear-signal shape to explicit null AND
//      cascade to gradeValue + gradingCompany + certGrader + certNumber
//      so the next holding shape sees a consistent "grade cleared" state.
//   2. dropClearedGradeFields — after the spread, delete keys whose
//      merged value is null so the persisted shape matches a native
//      Raw holding (never sent grade at all).
//
// undefined is preserved — that's the "don't touch this field" signal
// and must NOT trigger the clear.

const GRADE_CLEAR_FIELDS = [
  "gradeCompany",
  "gradingCompany",
  "gradeValue",
  "certGrader",
  "certNumber",
] as const;

function isRawClearSignal(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  return trimmed === "" || trimmed.toLowerCase() === "raw";
}

function normalizeRawGradeClearSignal(body: Record<string, unknown>): void {
  if ("gradeCompany" in body && isRawClearSignal(body.gradeCompany)) {
    for (const k of GRADE_CLEAR_FIELDS) body[k] = null;
  }
}

function dropClearedGradeFields(holding: Record<string, unknown>): void {
  for (const k of GRADE_CLEAR_FIELDS) {
    if (holding[k] === null) delete holding[k];
  }
}

// CF-GRADE-COMPANY-WITHOUT-VALUE (2026-08-22). A grading company with no grade
// value is not a graded card — it is a half-filled form, and it prices like a
// slab while displaying like one too.
//
// Measured on 2026-08-22: 3 of 79 holdings stored gradingCompany "PSA" with
// gradeValue absent. Nick Kurtz #RA-KG carried fairMarketValue $239.64 against
// $6.85 paid, while his own predictedPrice sat at $3.75 — a 64x spread on a
// card the engine was believed to be pricing as raw. The badge said PSA and so,
// evidently, did some rung of the ladder. Confirmed with Drew 2026-08-22: these
// cards are ungraded and the company is simply wrong.
//
// Absent beats wrong, the same rule #1179 applies to identity: we would rather
// show a raw card than a confident graded price for a slab that does not exist.
//
// THE CERT CARVE-OUT. A holding carrying a certNumber IS slabbed — the grade is
// missing but recoverable via resolveCert. Clearing that would throw away the
// one field that can recover it, so those are left alone for cert lookup and
// only the unrecoverable case is cleared.
//
// Strip-and-warn rather than 4xx, per the FIELD-PRUNE precedent above: iOS is
// shipping into a 9/14 launch and a new hard rejection at the write boundary is
// the wrong thing to introduce first. The telemetry below is what tells us
// whether a client is still producing the shape.
export function clearGradeCompanyWithoutValue(
  holding: Record<string, unknown>,
  ctx: { userId: string; holdingId?: string | null },
): void {
  const rawCompany = holding.gradingCompany ?? holding.gradeCompany;
  const company = typeof rawCompany === "string" ? rawCompany.trim() : "";
  if (!company) return;

  const gv = holding.gradeValue;
  const hasGrade =
    typeof gv === "number"
      ? Number.isFinite(gv)
      : typeof gv === "string"
        ? gv.trim() !== ""
        : false;
  if (hasGrade) return;

  const cert = holding.certNumber;
  const hasCert = typeof cert === "string" ? cert.trim() !== "" : cert != null;
  if (hasCert) return;

  console.warn(JSON.stringify({
    event: "grade_company_without_value_cleared",
    source: "portfolioStore.clearGradeCompanyWithoutValue",
    userId: ctx.userId,
    holdingId: ctx.holdingId ?? null,
    clearedCompany: company,
    detail: "grading company with no grade value and no cert — stored as raw",
  }));

  for (const k of GRADE_CLEAR_FIELDS) delete holding[k];
}

// CF-INVENTORYIQ-R1 — write-side normalizer for `cardId`.
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
function normalizeR1CardsightCardId<T extends { cardId?: string | null }>(
  holding: T,
  holdingId: string,
  source: string,
): T {
  const raw = holding.cardId;
  if (typeof raw !== "string") return holding;

  if (raw === "") {
    return { ...holding, cardId: null };
  }

  if (raw.startsWith("cardsight:")) {
    console.warn(JSON.stringify({
      event: "portfoliohq_cardsightCardId_prefix_stripped",
      source,
      holdingId,
      prefixedForm: raw.slice(0, 30) + (raw.length > 30 ? "..." : ""),
    }));
    return { ...holding, cardId: raw.slice("cardsight:".length) };
  }

  return holding;
}

// CF-CARDSIGHT-GRADE-ID-PATTERN R2. Opportunistically populates
// `gradeId` on the holding by resolving (gradeCompany,
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
    return { ...holding, gradeId: resolved };
  }
  return holding;
}

/**
 * CF-CH-THIN-COMP-PRIMARY (2026-06-26) — build a writeback patch carrying
 * the persisted "last sold" surface when (AND ONLY WHEN) the engine
 * emitted estimateSource === "cardhedge-last-sale".
 *
 * The estimate response carries a single trusted CardHedge sale on the
 * parallel-specific chCardId (see CF commit 1/2). fairMarketValue stays
 * null by design — n=1 isn't FMV-grade data — but the list/detail views
 * still need SOMETHING on the holding doc so they can render
 * "Last sold $X via N comp(s)" instead of "Can't estimate yet."
 *
 * THE GUARD IS SURGICAL — every other estimateSource ("observed",
 * "cardhedge" n>=2, "trend-extrapolated", "last-sale", "no-recent-comps",
 * variant-mismatch, T3 base-auto-floor, low-confidence skip, undefined,
 * null) returns the empty object {}. Callers spread the patch into their
 * writeback; an empty patch is a no-op. This is the source of the
 * ADDITIVE INVARIANT: a non-CH-last-sale row's persisted shape is
 * byte-identical pre/post this CF.
 *
 * The single-source predicate is the engine's `estimateSource` field
 * (set in compiqEstimate.service.ts:4220 — the cardhedge-last-sale ladder
 * arm). The presence of a `lastSale.price` numeric is REQUIRED — when
 * the engine emitted the source but couldn't compute a sale (degenerate
 * shape), we return {} rather than write garbage.
 */
/**
 * CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26) — structural validators
 * for the engine response's modelExpectation + modelSignal blocks.
 * Return the validated object literal (matching the PortfolioHolding
 * shape) or null when the input is malformed or absent.
 *
 * Strict — every numeric field must be a finite number; every enum
 * field must match the literal union; lean must be one of "buy" /
 * "hold" / "sell". A malformed engine response persists as `null` on
 * the holding (clearing any stale prior value), not a partially-
 * populated object that would silently render wrong.
 */
// CF-CH-PERSISTENCE-PATCH (2026-06-26): structural validators for the three
// trend-aware sub-blocks the helper emits on modelExpectation. Each returns
// the validated literal OR `null`; the parent validator ALWAYS includes the
// key in its return (null on missing/malformed), so a writeback CLEARS any
// stale prior sub-block — same pattern as modelExpectation/modelSignal at
// the patch layer. Field shapes mirror the helper's return at
// cardhedgeLastSaleSignal.service.ts:304-381 and the wire-type contract at
// portfolioiq.types.ts:225-246.
type ValidTrendAnchor = NonNullable<
  NonNullable<PortfolioHolding["modelExpectation"]>["trendAnchor"]
>;
type ValidForwardProjection = NonNullable<
  NonNullable<PortfolioHolding["modelExpectation"]>["forwardProjection"]
>;
type ValidPositionSignal = NonNullable<
  NonNullable<PortfolioHolding["modelExpectation"]>["positionSignal"]
>;

function validateTrendAnchor(raw: unknown): ValidTrendAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const direction = t.direction;
  const slopePctPerDay = t.slopePctPerDay;
  const trendConfidence = t.trendConfidence;
  const windowDays = t.windowDays;
  const daysWithSales = t.daysWithSales;
  const projectedBaseAtSale = t.projectedBaseAtSale;
  const projectedBaseToday = t.projectedBaseToday;
  const allTimeBaseMedian = t.allTimeBaseMedian;
  if (
    (direction !== "up" && direction !== "down") ||
    typeof slopePctPerDay !== "number" || !Number.isFinite(slopePctPerDay) ||
    typeof trendConfidence !== "number" || !Number.isFinite(trendConfidence) ||
    typeof windowDays !== "number" || !Number.isFinite(windowDays) || windowDays <= 0 ||
    typeof daysWithSales !== "number" || !Number.isFinite(daysWithSales) || daysWithSales < 0 ||
    typeof projectedBaseAtSale !== "number" || !Number.isFinite(projectedBaseAtSale) || projectedBaseAtSale <= 0 ||
    typeof projectedBaseToday !== "number" || !Number.isFinite(projectedBaseToday) || projectedBaseToday <= 0 ||
    typeof allTimeBaseMedian !== "number" || !Number.isFinite(allTimeBaseMedian) || allTimeBaseMedian <= 0
  ) {
    return null;
  }
  return {
    direction,
    slopePctPerDay,
    trendConfidence,
    windowDays: Math.floor(windowDays),
    daysWithSales: Math.floor(daysWithSales),
    projectedBaseAtSale,
    projectedBaseToday,
    allTimeBaseMedian,
  };
}

function validateForwardProjection(raw: unknown): ValidForwardProjection | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const low = f.low;
  const high = f.high;
  const basis = f.basis;
  const confidence = f.confidence;
  if (
    typeof low !== "number" || !Number.isFinite(low) || low <= 0 ||
    typeof high !== "number" || !Number.isFinite(high) || high <= 0 ||
    high < low ||
    typeof basis !== "string" || basis.length === 0 ||
    typeof confidence !== "number" || !Number.isFinite(confidence)
  ) {
    return null;
  }
  return { low, high, basis, confidence };
}

function validatePositionSignal(raw: unknown): ValidPositionSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const purchasePrice = p.purchasePrice;
  const gainVsLastSale = p.gainVsLastSale;
  const gainVsExpectation = p.gainVsExpectation;
  const gainPct = p.gainPct;
  if (
    typeof purchasePrice !== "number" || !Number.isFinite(purchasePrice) || purchasePrice <= 0 ||
    typeof gainVsLastSale !== "number" || !Number.isFinite(gainVsLastSale) ||
    typeof gainVsExpectation !== "number" || !Number.isFinite(gainVsExpectation) ||
    typeof gainPct !== "number" || !Number.isFinite(gainPct)
  ) {
    return null;
  }
  return { purchasePrice, gainVsLastSale, gainVsExpectation, gainPct };
}

function validateModelExpectation(
  raw: unknown,
): NonNullable<PortfolioHolding["modelExpectation"]> | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const value = m.value;
  const range = m.range;
  const multiplier = m.multiplier;
  const multiplierRange = m.multiplierRange;
  const n = m.n;
  const baseAutoMedian = m.baseAutoMedian;
  const baseAutoCount = m.baseAutoCount;
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    !Array.isArray(range) || range.length !== 2 ||
    typeof range[0] !== "number" || typeof range[1] !== "number" ||
    !Number.isFinite(range[0]) || !Number.isFinite(range[1]) ||
    typeof multiplier !== "number" || !Number.isFinite(multiplier) ||
    !Array.isArray(multiplierRange) || multiplierRange.length !== 2 ||
    typeof multiplierRange[0] !== "number" || typeof multiplierRange[1] !== "number" ||
    !Number.isFinite(multiplierRange[0]) || !Number.isFinite(multiplierRange[1]) ||
    typeof n !== "number" || !Number.isFinite(n) || n <= 0 ||
    typeof baseAutoMedian !== "number" || !Number.isFinite(baseAutoMedian) || baseAutoMedian <= 0 ||
    typeof baseAutoCount !== "number" || !Number.isFinite(baseAutoCount) || baseAutoCount < 0
  ) {
    return null;
  }
  const basis = typeof m.basis === "string" ? m.basis : null;
  // CF-CH-PERSISTENCE-PATCH (2026-06-26): ALWAYS emit the three sub-block
  // keys. Missing-or-malformed → null (not undefined / omitted). The patch
  // layer spreads this object straight onto the holding, so emitting null
  // CLEARS any stale prior sub-block — same writeback semantics as the
  // patch-layer modelExpectation/modelSignal null-clear at buildChLastSalePatch.
  // Omitting the key would leave stale Cosmos sub-blocks intact through
  // the next reprice; emitting null overwrites them.
  return {
    value,
    range: [range[0], range[1]],
    multiplier,
    multiplierRange: [multiplierRange[0], multiplierRange[1]],
    basis,
    n: Math.floor(n),
    baseAutoMedian,
    baseAutoCount: Math.floor(baseAutoCount),
    trendAnchor: validateTrendAnchor(m.trendAnchor),
    forwardProjection: validateForwardProjection(m.forwardProjection),
    positionSignal: validatePositionSignal(m.positionSignal),
  };
}

function validateModelSignal(
  raw: unknown,
): NonNullable<PortfolioHolding["modelSignal"]> | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const lean = s.lean;
  const deltaPct = s.deltaPct;
  const expectation = s.expectation;
  const effectiveMultiplier = s.effectiveMultiplier;
  if (
    (lean !== "buy" && lean !== "hold" && lean !== "sell") ||
    typeof deltaPct !== "number" || !Number.isFinite(deltaPct) ||
    typeof expectation !== "number" || !Number.isFinite(expectation) ||
    typeof effectiveMultiplier !== "number" || !Number.isFinite(effectiveMultiplier)
  ) {
    return null;
  }
  return { lean, deltaPct, expectation, effectiveMultiplier };
}

export function buildChLastSalePatch(
  estimate: unknown,
): Partial<PortfolioHolding> {
  const est = estimate as {
    estimateSource?: string | null;
    lastSale?: { price?: unknown; soldDate?: unknown } | null;
    chCompCount?: unknown;
    modelExpectation?: unknown;
    modelSignal?: unknown;
  } | null | undefined;
  // CF-ESTIMATE-SOURCE-VENDOR-NEUTRAL (2026-07-04): renamed from
  // "cardhedge-last-sale" → "live-market-last-sale". Accept both so
  // historical holdings written pre-rename still resolve correctly.
  if (
    !est
    || (est.estimateSource !== "live-market-last-sale"
        && est.estimateSource !== "cardhedge-last-sale")
  ) return {};
  const rawPrice = est.lastSale?.price;
  if (typeof rawPrice !== "number" || !Number.isFinite(rawPrice) || rawPrice <= 0) {
    return {};
  }
  const rawDate = est.lastSale?.soldDate;
  const date =
    typeof rawDate === "string" && rawDate.trim().length > 0 ? rawDate : null;
  const rawCompCount = est.chCompCount;
  const compCount =
    typeof rawCompCount === "number" && Number.isFinite(rawCompCount) && rawCompCount > 0
      ? Math.floor(rawCompCount)
      : 1;
  // CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): also persist the
  // multiplier-model signal when the engine emitted it. Both fields are
  // ALWAYS set in the patch (to validated value OR explicit null) so the
  // spread CLEARS any stale value from a prior reprice — mirrors the
  // FMV-clear pattern from CF-CH-THIN-COMP-FMV-CLEAR. When the engine
  // didn't emit (helper returned null because the curated row was
  // missing, subset unresolvable, etc.), both persist as null on the
  // holding; iOS shows no buy/sell signal.
  const modelExpectation = validateModelExpectation(est.modelExpectation);
  const modelSignal = validateModelSignal(est.modelSignal);
  // CF-CH-THIN-COMP-FMV-CLEAR (2026-06-26): explicitly clear the FMV-class
  // fields the engine emitted as null on the cardhedge-last-sale path.
  // The writeback sites (autoPriceHolding fairValue<=0 abort + the
  // repriceHoldingsForUser branch) BOTH spread `...holding` before the
  // patch, so any stale FMV from a prior reprice carries forward unless
  // the patch explicitly overrides it. The 2026-06-26 18:38Z sibling-pool
  // rescue write left `fairMarketValue=8.5` on the Hartman BXF /150
  // holding, and the cardhedge-last-sale writeback at 19:03 surfaced
  // lastSaleSurface correctly but didn't clear the residue — the iOS
  // LIST view kept showing $8.50.
  //
  // The clear fields match exactly what the engine emitted (null /
  // false), so this just PERSISTS the engine's intent. `null as any` for
  // fairMarketValue mirrors the precedent at autoPriceHolding's engineT3
  // writeback — PortfolioHolding types it as optional-number, but Cosmos
  // accepts null (and `undefined` would silently get omitted in the
  // spread, leaving the stale value behind). The ADDITIVE INVARIANT
  // holds because this clear ONLY fires inside the cardhedge-last-sale
  // patch — every other source returns {} from the early-exit above; no
  // other holding's FMV is ever touched (locked by the existing 22
  // additive tests in buildChLastSalePatch.test.ts).
  return {
    lastSaleSurface: { price: rawPrice, date, compCount },
    fairMarketValue: null as any,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateBasis: null,
    isEstimate: false,
    modelExpectation,
    modelSignal,
  };
}

/**
 * CF-LADDER-HELPER-EXTRACT (2026-06-29): single home for the
 * deriveGradeLadderAnchor call pattern shared by autoPriceHolding +
 * repriceHoldingsForUser. Both functions had 2 ladder call sites each
 * (4 total), each constructing the same `{cardId, requestedGrade:
 * "Raw", cardClass, cardYear}` request and emitting the same telemetry
 * shape. The 2026-06-29 vintage CF (CF-VINTAGE-GRADER-PREMIUMS) made
 * the maintenance cost visible — threading `cardYear` through all four
 * sites by hand. This helper collapses it to one place.
 *
 * The helper:
 *   - Reads `isAuto` + `cardYear` off the holding
 *   - Calls deriveGradeLadderAnchor
 *   - Emits structured `autoprice_grade_ladder_fallback_applied`
 *     telemetry on success (tagged with the caller's `source`)
 *   - Logs a non-fatal warn on throw
 *   - Returns the projection shape every caller previously built
 *     inline; null on failure or no-derived-FMV
 *
 * Telemetry source tags (preserved from prior inline calls so App
 * Insights queries continue to disambiguate):
 *   "portfolio.autoPriceHolding.pre-early"
 *   "portfolio.autoPriceHolding"
 *   "portfolio.repriceHoldingsForUser.lastSale"
 *   "portfolio.repriceHoldingsForUser"
 */
interface LadderFallbackResult {
  derivedFmv: number;
  confidence: number;
  explanation: string;
  anchorGrade: string;
  anchorPrice: number;
  anchorDaysOld: number;
  anchorSampleSize: number;
}

async function applyGradeLadderFallback(opts: {
  holding: PortfolioHolding;
  cardId: string;
  source: string;
}): Promise<LadderFallbackResult | null> {
  try {
    const { deriveGradeLadderAnchor, getGraderPremium } = await import(
      "../compiq/compiqEstimate.service.js"
    );
    const { inferSportFromContext } = await import(
      "./soldCompsStore.service.js"
    );
    const cardYear =
      typeof (opts.holding as { cardYear?: number }).cardYear === "number"
        ? ((opts.holding as { cardYear?: number }).cardYear as number)
        : null;
    const cardClass = (opts.holding as { isAuto?: boolean }).isAuto === true ? "autograph" : "base";
    const ladder = await deriveGradeLadderAnchor({
      cardId: opts.cardId,
      // Ask the ladder for Raw to get the freshest anchor regardless of
      // the user's grade. If the user's holding is graded, we apply the
      // grade multiplier ourselves below (CF-LADDER-APPLY-USER-GRADE).
      requestedGrade: "Raw",
      cardClass,
      cardYear,
    });
    if (!ladder || ladder.derivedFmv <= 0) return null;

    // CF-LADDER-APPLY-USER-GRADE (Drew, 2026-07-27). Prior code path
    // wrote `ladder.derivedFmv` (= Raw anchor × 1.0 when anchor is Raw)
    // straight into estimatedValue for the graded holding. Comment on
    // the requestedGrade:"Raw" line claimed "the auto-aware multiplier
    // table converts it to the user's grade when applicable" — but no
    // code did the conversion, so a PSA 10 holding with Raw comps
    // persisted at the Raw comp price. Apply getGraderPremium (family
    // + sport + price-band aware post CF-CALIBRATION-LADDER-IN-GRADER-
    // PREMIUM, PR #837) here so PSA 10 / BGS 9.5 / etc. get their real
    // multiplier over the Raw anchor.
    const gradeCompany = String((opts.holding as { gradeCompany?: unknown }).gradeCompany ?? "").trim().toUpperCase();
    const rawGradeVal = (opts.holding as { gradeValue?: unknown }).gradeValue;
    const gradeValueNum = Number(rawGradeVal);
    const hasGrade = gradeCompany.length > 0 && Number.isFinite(gradeValueNum) && gradeValueNum > 0;
    let finalFmv = ladder.derivedFmv;
    let finalExplanation = ladder.explanation;
    // CF-LADDER-APPLY-USER-GRADE-ALL-ANCHORS (Drew, 2026-08-04). Prior
    // branch only converted when the ladder returned a Raw anchor —
    // when the freshest anchor was PSA 10, ladder.derivedFmv was already
    // a Raw estimate (anchor × 0.4× PSA-10→Raw), and the graded user's
    // BGS 9.5 holding got that Raw number verbatim ("Estimated Raw from
    // PSA 10 anchor..." at $902 for a $2,200-range BGS 9.5 card, Bobby
    // Witt Jr. 2020 Bowman Chrome auto).
    //
    // The ladder ALWAYS returns a Raw-tier estimate (requestedGrade="Raw"
    // on line above), regardless of which grade anchored. So the correct
    // rule is: whenever the user has a grade, multiply the ladder's Raw
    // estimate by the user's grade premium.
    if (hasGrade && finalFmv > 0) {
      const productSetHint =
        (opts.holding as { setName?: string }).setName
        ?? (opts.holding as { product?: string }).product
        ?? null;
      const cardTitleHint =
        (opts.holding as { cardTitle?: string }).cardTitle
        ?? null;
      const sportHint =
        (opts.holding as { sport?: string | null }).sport
        ?? inferSportFromContext(productSetHint, cardTitleHint, cardYear);
      const rawEstimate = finalFmv;
      const multiplier = getGraderPremium(
        gradeCompany,
        String(gradeValueNum),
        rawEstimate,
        cardClass,
        cardYear,
        productSetHint,
        null,
        sportHint ?? null,
      );
      // CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (2026-09-03, audit H-7 residual).
      // A null multiplier must REFUSE, not fall through. `rawEstimate` is a
      // Raw-tier number and the holding is graded; leaving it in place is
      // precisely the CF-LADDER-APPLY-USER-GRADE bug this block was written
      // to fix (a BGS 9.5 holding persisted at $902 against a $2,200 market).
      // The caller already accepts null and skips the ladder entirely.
      if (multiplier === null || !Number.isFinite(multiplier) || multiplier <= 0) {
        try {
          console.log(JSON.stringify({
            event: "autoprice_grade_ladder_fallback_refused",
            source: opts.source,
            holdingId: opts.holding.id,
            cardId: opts.cardId,
            reason: "no-empirical-grade-multiplier",
            gradeCompany,
            gradeValue: gradeValueNum,
            sport: sportHint ?? null,
            productSet: productSetHint,
            timestamp: new Date().toISOString(),
          }));
        } catch { /* telemetry must never propagate */ }
        return null;
      }
      if (Math.abs(multiplier - 1) > 0.01) {
        finalFmv = rawEstimate * multiplier;
        finalExplanation =
          `Raw-tier estimate $${Math.round(rawEstimate)} (from ${ladder.anchorGrade} anchor `
          + `$${ladder.anchorPrice}, ${ladder.anchorDaysOld}d, ${ladder.anchorSampleSize} samples) `
          + `× ${multiplier.toFixed(2)} ${gradeCompany} ${gradeValueNum} → $${Math.round(finalFmv)}.`;
      }
    }

    try {
      console.log(JSON.stringify({
        event: "autoprice_grade_ladder_fallback_applied",
        source: opts.source,
        holdingId: opts.holding.id,
        cardId: opts.cardId,
        anchorGrade: ladder.anchorGrade,
        anchorPrice: ladder.anchorPrice,
        anchorDaysOld: ladder.anchorDaysOld,
        derivedFmv: finalFmv,
        gradeConversionApplied: hasGrade && ladder.anchorGrade === "Raw" && finalFmv !== ladder.derivedFmv,
        confidence: ladder.confidence,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // Telemetry must never propagate.
    }
    return {
      derivedFmv: finalFmv,
      confidence: ladder.confidence,
      explanation: finalExplanation,
      anchorGrade: ladder.anchorGrade,
      anchorPrice: ladder.anchorPrice,
      anchorDaysOld: ladder.anchorDaysOld,
      anchorSampleSize: ladder.anchorSampleSize,
    };
  } catch (err) {
    console.warn(
      `[portfolio.applyGradeLadderFallback] ${opts.source} failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}

// CF-ONE-PIN-GATE-FOR-BOTH-FIELDS (2026-08-29, checklist D12a). addHolding
// adopted a catalog match as BOTH hobbyiqCardId and cardId at ANY confidence
// when nothing was pinned — fuzzy-parallel 0.72, family-fallback 0.55 — and
// updateHolding gated cardId at 0.9 but wrote hobbyiqCardId UNGATED, on the
// theory that "nothing prices off it alone". priceFromOurPool prices off it
// alone. One gate (ADD_SLUG_OVERRIDE_MIN_CONFIDENCE), both fields, both
// paths. Below the gate the match is recorded on the holding as a PROPOSAL —
// catalogMatchSlug / catalogMatchConfidence / catalogMatchedBy, the fields
// the eBay import writes and composeHoldingWireShape's proposedIdentity
// already surfaces for the user to accept — never as identity.
type CatalogMatchLike = { slug: string; found: boolean; confidence: number; matchedBy: string };

// CF-PIN-ONLY-A-CHECKLIST-ROW (2026-08-30, D35). Confidence was the only pin
// gate, and confidence is self-confirming: canonicalize SEEDS a
// `user-verified` row for an unmatched identity and then matches its own seed
// at 0.95-0.98 (matchedBy "seeded"), because catalogMatcher hands
// `user-verified` a 0.9 floor by construction. Four of Drew's holdings carry
// exactly that shape — a vendor row minted by the request that then "found"
// it. A match proves nothing unless the row is checklist-backed, so authority
// is now a second, independent gate: above the confidence gate but on a
// vendor / derived / unknown row, the match parks as a proposal exactly as a
// sub-gate match does. Fails CLOSED only on authority, never on a read
// outage — an unreadable row parks rather than pinning blind.
export async function applyCatalogMatchToHolding(
  h: PortfolioHolding,
  match: CatalogMatchLike,
  ctx: {
    source: string; userId: string; holdingId: string; cardIdRule: "fill" | "rebind";
    readRow?: (slug: string) => Promise<{ source?: string | null } | null>;
  },
): Promise<{ pinned: boolean }> {
  const rec = h as unknown as Record<string, unknown>;
  const previousSlug = String(rec.hobbyiqCardId ?? "").trim() || null;
  const hasMatch = match.found && typeof match.slug === "string" && match.slug.length > 0;
  const confident = hasMatch && (match.confidence ?? 0) >= ADD_SLUG_OVERRIDE_MIN_CONFIDENCE;
  rec.catalogMatchSlug = hasMatch ? match.slug : null;
  rec.catalogMatchConfidence = typeof match.confidence === "number" ? match.confidence : null;
  rec.catalogMatchedBy = match.matchedBy ?? null;
  if (!confident) {
    if (hasMatch && match.slug !== previousSlug) {
      console.log(JSON.stringify({
        event: "catalog_match_parked_as_suggestion",
        source: ctx.source,
        userId: ctx.userId,
        holdingId: ctx.holdingId,
        previousSlug,
        suggestedSlug: match.slug,
        matchedBy: match.matchedBy,
        confidence: match.confidence,
        gate: ADD_SLUG_OVERRIDE_MIN_CONFIDENCE,
        detail: previousSlug
          ? "re-derivation disagreed with the pinned slug below the gate; keeping the pin"
          : "match below the pin gate; recorded as a proposal, not as identity",
      }));
    }
    return { pinned: false };
  }
  // AUTHORITY GATE. Read the row the match names and refuse anything a
  // checklist did not vouch for.
  const readRow = ctx.readRow ?? (async (slug: string) => {
    const { readCatalogRowSource } = await import("./checklistBackedIdentity.js");
    return readCatalogRowSource(slug);
  });
  let rowSource: string | null | undefined;
  let rowRead = false;
  try {
    const row = await readRow(match.slug);
    rowRead = Boolean(row);
    rowSource = row?.source ?? null;
  } catch { rowRead = false; }
  const { catalogAuthorityOf } = await import("../catalog/catalogAuthority.service.js");
  const authority = rowRead ? catalogAuthorityOf(rowSource) : "unreadable";
  if (authority !== "checklist") {
    console.log(JSON.stringify({
      event: "catalog_match_parked_not_checklist_backed",
      source: ctx.source,
      userId: ctx.userId,
      holdingId: ctx.holdingId,
      previousSlug,
      suggestedSlug: match.slug,
      matchedBy: match.matchedBy,
      confidence: match.confidence,
      rowSource: rowRead ? rowSource : null,
      authority,
      detail: "confident, but the row is not checklist-backed; recorded as a proposal, not as identity",
    }));
    return { pinned: false };
  }
  rec.hobbyiqCardId = match.slug;
  rec.hobbyiqCardIdSource = match.matchedBy === "seeded" ? "catalog-seeded" : "catalog";
  const currentCardId = String(rec.cardId ?? "").trim();
  if (ctx.cardIdRule === "rebind" || !currentCardId) rec.cardId = match.slug;
  if (match.slug !== previousSlug) {
    console.log(JSON.stringify({
      event: ctx.cardIdRule === "fill" ? "catalog_auto_seed_on_add" : "catalog_resolve_on_update_rebind",
      source: ctx.source,
      userId: ctx.userId,
      holdingId: ctx.holdingId,
      previousSlug,
      resolvedSlug: match.slug,
      matchedBy: match.matchedBy,
      confidence: match.confidence,
      pinned: true,
    }));
  }
  return { pinned: true };
}

// CF-A-SUPPLIED-SLUG-MUST-BE-A-CATALOG-ROW (2026-08-29, checklist D12a). A
// caller may pin hobbyiqCardId in the body — the card page the user added
// from, the picker, an import. updateHolding wrote it as given. A slug is an
// identity only when the catalog holds it, so a supplied slug is accepted
// only when catalogSlugIfExists says so (the catalog's form is written);
// otherwise the previous value stands and the rejection is logged. Fails
// closed on a catalog outage. Absent / cleared values are not gated: an
// explicit clear stays a clear.
async function gateSuppliedSlug(
  h: PortfolioHolding,
  ctx: { source: string; userId: string; holdingId: string; previous: string | null },
): Promise<void> {
  const rec = h as unknown as Record<string, unknown>;
  const supplied = String(rec.hobbyiqCardId ?? "").trim();
  if (!supplied || supplied === ctx.previous) return;
  let found: string | null = null;
  if (supplied.startsWith("hiq:")) {
    try {
      const { catalogSlugIfExists } = await import("../catalog/catalogMatcher.service.js");
      found = await catalogSlugIfExists(supplied);
    } catch {
      found = null;
    }
  }
  if (!found) {
    console.warn(JSON.stringify({
      event: "holding_slug_rejected_not_in_catalog",
      source: ctx.source,
      userId: ctx.userId,
      holdingId: ctx.holdingId,
      suppliedSlug: supplied,
      keptSlug: ctx.previous,
      detail: "a supplied hobbyiqCardId is accepted only when it names a catalog row",
    }));
    rec.hobbyiqCardId = ctx.previous;
    return;
  }
  rec.hobbyiqCardId = found;
  rec.hobbyiqCardIdSource = "pinned";
  if (found !== supplied) {
    console.log(JSON.stringify({
      event: "holding_slug_resolved_to_catalog_row",
      source: ctx.source,
      userId: ctx.userId,
      holdingId: ctx.holdingId,
      suppliedSlug: supplied,
      writtenSlug: found,
      detail: "the catalog's form of the supplied slug is written (its twin)",
    }));
  }
}

// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3 — Max
// Williams 2025 Bowman Draft CPA-MWI Refractor auto). The holding's SECOND
// identity, cardId, was written ungated: the web sends the card page's URL id
// as cardsightCardId -> cardId, so an un-numbered hiq slug whose only catalog
// row is …:num-499 stayed pinned as cardId even after hobbyiqCardId had been
// corrected — two identities on one holding, and every reader keyed on cardId
// found nothing. An hiq cardId now goes through the SAME resolver as
// hobbyiqCardId (catalogSlugIfExists -> catalogIdentityResolver): the
// catalog's row is written — the id itself, or its one twin. A slug the
// catalog cannot place (no row, or two numbered twins) is KEPT and logged,
// never nulled: the identity gate still needs a cardId, and
// exactPoolSupremacy's STARTSWITH count still fails safe on it. A vendor
// cardId is not an hiq slug and is untouched.
async function resolveHiqCardIdToCatalogRow(
  h: PortfolioHolding,
  ctx: { source: string; userId: string; holdingId: string },
): Promise<void> {
  const rec = h as unknown as Record<string, unknown>;
  const cid = String(rec.cardId ?? "").trim();
  if (!cid.startsWith("hiq:")) return;
  let found: string | null = null;
  try {
    const { catalogSlugIfExists } = await import("../catalog/catalogMatcher.service.js");
    found = await catalogSlugIfExists(cid);
  } catch {
    found = null;
  }
  if (!found) {
    console.warn(JSON.stringify({
      event: "holding_cardid_not_a_catalog_row",
      source: ctx.source,
      userId: ctx.userId,
      holdingId: ctx.holdingId,
      cardId: cid,
      detail: "an hiq cardId names no catalog row (none, or two numbered twins); kept as given",
    }));
    return;
  }
  if (found === cid) return;
  rec.cardId = found;
  console.log(JSON.stringify({
    event: "holding_cardid_resolved_to_catalog_row",
    source: ctx.source,
    userId: ctx.userId,
    holdingId: ctx.holdingId,
    previousCardId: cid,
    cardId: found,
  }));
}

// CF-ONE-IDENTITY-IN-THE-POOL (2026-08-29, checklist D12a). A user's SALE or
// PURCHASE is a sold_comps row, and sold_comps is partitioned on cardId.
// Every user-sale writer in this file read `holding.cardId` — which on a
// vendor-sourced holding is a CardHedge bubble.io id or a Cardsight compound
// id — so a real sale by a real user, confidence 1.0, verifiedByUser, landed
// in a VENDOR's partition. The only thing that could reach the canonical pool
// was the hobbyiqCardId the store re-derived from the holding's free text,
// which may or may not agree with the identity the holding had already been
// pinned to. Nothing read `holding.hobbyiqCardId`.
//
// ONE resolution, used by every user-sale emit (purchase, manual sell, eBay
// order poll): the hiq: slug the holding is pinned to — hobbyiqCardId, else
// cardId when it is itself a slug — or nothing. A holding with no hiq
// identity does not emit; the skip is logged as user_comp_withheld_no_identity.
// The vendor id travels as `vendorCardId` metadata and never keys a row. No
// catalog call here: recordSoldComp reconciles the slug against the catalog
// and refuses (D7d, catalog-unmatched) what the catalog cannot place.
export interface HoldingPoolIdentity {
  /** The hiq: slug the row is keyed by, or null when the holding has none. */
  cardId: string | null;
  /** The same slug — the canonical key the row carries. */
  hobbyiqCardId: string | null;
  /** The holding's resolved print run, so a re-emit cannot drop :num-N (D9). */
  printRun: number | null;
  /** The holding's vendor cardId, when it has one. Metadata only. */
  vendorCardId: string | null;
  via: "hobbyiqCardId" | "cardId" | "none";
}

function isHiqSlug(v: unknown): v is string {
  return typeof v === "string" && v.trim().startsWith("hiq:") && v.trim().length > 4;
}

export function poolIdentityForHolding(holding: PortfolioHolding): HoldingPoolIdentity {
  const h = holding as PortfolioHolding & { printRun?: unknown };
  const pinned = String(h.hobbyiqCardId ?? "").trim();
  const cardId = String(h.cardId ?? "").trim();
  const vendorCardId = cardId && !isHiqSlug(cardId) ? cardId : null;
  const printRun = typeof h.printRun === "number" && Number.isInteger(h.printRun) && h.printRun > 0 ? h.printRun : null;
  if (isHiqSlug(pinned)) return { cardId: pinned, hobbyiqCardId: pinned, printRun, vendorCardId, via: "hobbyiqCardId" };
  if (isHiqSlug(cardId)) return { cardId, hobbyiqCardId: cardId, printRun, vendorCardId: null, via: "cardId" };
  return { cardId: null, hobbyiqCardId: null, printRun, vendorCardId, via: "none" };
}

function logUserCompWithheldNoIdentity(
  source: string,
  userId: string,
  holding: PortfolioHolding,
  identity: HoldingPoolIdentity,
): void {
  console.warn(JSON.stringify({
    event: "user_comp_withheld_no_identity",
    source,
    userId,
    holdingId: holding.id,
    vendorCardId: identity.vendorCardId,
    detail: "no hiq: slug on the holding; a user sale or purchase is never pooled under a vendor id",
  }));
}

// CF-USER-EBAY-PURCHASE-AUTO-COMP (Drew, 2026-08-08). Fires from
// addHolding + updateHolding when a user tells us they bought a card
// on eBay. Writes one sold_comps row per holding, keyed the way the eBay
// import keys its purchase row (D9 purchaseSaleIdentity: the order id, then
// the item id, then `holding::<id>`) so re-emissions from either path
// converge on the same doc.
async function emitUserEbayPurchaseComp(
  holding: PortfolioHolding,
  userId: string,
  doc?: { purchases?: ReadonlyArray<unknown> } | null,
): Promise<void> {
  const src = String((holding as { purchaseSource?: string }).purchaseSource ?? "").trim();
  if (!src || !/^ebay/i.test(src)) return;
  const price = Number((holding as { purchasePrice?: unknown }).purchasePrice ?? NaN);
  if (!Number.isFinite(price) || price <= 0) return;
  const purchaseDate = String((holding as { purchaseDate?: string }).purchaseDate ?? "").trim();
  if (!purchaseDate) return;
  const playerName = String((holding as { playerName?: string }).playerName ?? "").trim();
  if (!playerName) return;
  // CF-ONE-IDENTITY-IN-THE-POOL (D12a): the pinned slug, never the vendor id.
  const identity = poolIdentityForHolding(holding);
  if (!identity.cardId) {
    logUserCompWithheldNoIdentity("portfolioStore.emitUserEbayPurchaseComp", userId, holding, identity);
    return;
  }
  const cardId = identity.cardId;
  const soldAt = purchaseDate.includes("T") ? purchaseDate : `${purchaseDate}T00:00:00Z`;
  try {
    const { recordSoldComp } = await import("./soldCompsStore.service.js");
    // D9's key, so the import's row and this one are ONE row: the purchase
    // record's eBay order id, else the ids the holding carries, else
    // `holding::<id>`. Same-id rows supersede in the store.
    const { purchaseSaleIdentity, sourcePurchaseFor } = await import("./ebayAutoHolding.service.js");
    // CF-A-SUBTOTAL-NEVER-REGRESSES-TO-ALL-IN (D38). This call already derives
    // the price AND its derivation; take both. The line above reads
    // holding.purchasePrice, which is the buyer's ALL-IN basis (item + shipping
    // + tax) whenever the purchase record carries a subtotal -- and handing it
    // to the store with no basis defeats BOTH D38 guard layers, because each
    // gates on the INCOMING basis being "all-in". An unmarked all-in write then
    // overwrites 295.95 (the market's price) with 301.43 (what the buyer paid).
    // Prefer the purchase record's subtotal; fall back to the holding price the
    // same way, but say so.
    const { sourceExternalId, price: identityPrice, priceBasis } = purchaseSaleIdentity(
      sourcePurchaseFor(doc ?? null, holding as unknown as Record<string, unknown>),
      holding as unknown as Record<string, unknown>,
    );
    const priceForPool = identityPrice > 0 ? identityPrice : price;
    const sport = (holding as { sport?: unknown }).sport;
    await recordSoldComp({
      cardId,
      // D38: the ruled identity, verified by the store against the catalog.
      pinnedHobbyIqCardId: identity.hobbyiqCardId,
      vendorCardId: identity.vendorCardId,
      playerName,
      cardYear: ((holding as { cardYear?: number }).cardYear ?? null) as number | null,
      setName: ((holding as { setName?: string }).setName ?? null) as string | null,
      parallel: ((holding as { parallel?: string }).parallel ?? null) as string | null,
      cardNumber: ((holding as { cardNumber?: string }).cardNumber ?? null) as string | null,
      isAuto: (holding as { isAuto?: boolean }).isAuto === true,
      printRun: identity.printRun,
      sport: typeof sport === "string" && sport ? sport.toLowerCase() : null,
      gradeCompany: ((holding as { gradeCompany?: string }).gradeCompany ?? null) as string | null,
      gradeValue: ((holding as { gradeValue?: number }).gradeValue ?? null) as number | null,
      price: priceForPool,
      // D38: the derivation travels with the price, so the store can refuse an
      // all-in price over a stored subtotal.
      priceBasis: identityPrice > 0 ? priceBasis : "all-in",
      soldAt,
      source: "ebay-user-purchase",
      sourceExternalId,
      contributorUserId: userId,
      title: ((holding as { cardTitle?: string }).cardTitle ?? null) as string | null,
      imageUrl: ((holding as { photos?: string[] }).photos?.[0] ?? null) as string | null,
      sellerHandle: src.includes(":") ? src.split(":").slice(1).join(":").trim() || null : null,
      // User explicitly typed identity in the Add Card modal — treat as
      // verified per CF-ADD-CARD-VERIFIED convention.
      verifiedByUser: true,
      confidence: 1.0,
    });
    console.log(JSON.stringify({
      event: "user_ebay_purchase_comp_written",
      source: "portfolioStore.emitUserEbayPurchaseComp",
      userId,
      holdingId: holding.id,
      cardId,
      identityVia: identity.via,
      vendorCardId: identity.vendorCardId,
      sourceExternalId,
      price: priceForPool,
      priceBasis: identityPrice > 0 ? priceBasis : "all-in",
      grade: (holding as { gradeCompany?: string }).gradeCompany
        ? `${(holding as { gradeCompany?: string }).gradeCompany} ${(holding as { gradeValue?: number }).gradeValue ?? ""}`.trim()
        : "Raw",
    }));
  } catch (err) {
    // recordSoldComp is soft — never blocks the holding write.
    throw err;
  }
}

/** CF-A-UNION-IS-ONE-CARD (2026-09-01): stamp the refusal breadcrumb onto a
 *  pricingSourceMeta when the pool-twin union was refused, leaving the meta
 *  untouched (same three keys) when it was not. */
function withUnionRefused<T extends object>(meta: T, attempt: { unionRefusedReason?: string }): T & { unionRefused?: string } {
  return attempt.unionRefusedReason ? { ...meta, unionRefused: attempt.unionRefusedReason } : meta;
}

// ─── CF-EXACT-POOL-SUPREMACY (D4 "one valuation path", PR 5 — 2026-08-29) ──
//
// A fallback rung may never outrank an exact pool that has >= 1 sale. Every
// site in this file that persists an ESTIMATE from another identity (a
// sibling × premium, a neighbouring parallel, a family baseline, a vendor
// resolver, a rail, a ladder, an unnamed legacy rung) asks the gate first:
//
//   allowed                 no identity of this holding — hobbyiqCardId,
//                           cardId, their numbered/un-numbered twins — has a
//                           sale in window: the estimate may be written;
//   priced-from-exact-pool  an identity has sales and the unified engine
//                           priced them (hobbyiqCardId ALONE first, so a
//                           wrong cardId cannot dilute the right pool): that
//                           price is written, observed, with its labels;
//   withheld                an identity has sales the engine could not price:
//                           nothing new is written, and a stale estimate
//                           already on the holding is cleared — an estimate
//                           contradicted by exact sales may not stand.
//
// The estimate itself becomes telemetry (estimate_withheld_exact_pool_exists).
// Holding ca7a150b is the case: three exact raw sales under hobbyiqCardId,
// $1,109.44 sibling × 8.00× floor persisted as fairMarketValue.
type EstimateGateOutcome =
  | { outcome: "allowed" }
  | { outcome: "priced-from-exact-pool"; holding: PortfolioHolding; blockingId: string; canonical: number }
  | { outcome: "withheld"; holding: PortfolioHolding; blockingId: string; cleared: boolean };

/** The unified write, in the shape the early exits use — labels included. */
function unifiedHoldingWrite(
  holding: PortfolioHolding,
  exact: ExactPoolPrice,
  nowIso: string,
  /** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the owner
   *  this price is being written for, so a sale THEY contributed is labeled
   *  as theirs. Null on any path that names no user — nothing is "yours". */
  ownerUserId: string | null = null,
): PortfolioHolding {
  const u = exact.u;
  // CF-ONE-PERSIST-HELPER (C-7): the exact pool IS this identity's own comps
  // at this tier — the one branch that may legitimately claim "observed".
  return writeHoldingValuation(holding, {
    fairMarketValue: exact.canonical,
    rung: { rung: u.rungLabel },
    valueSource: "observed",
    nowIso,
    meta: withUnionRefused({
      slug: exact.attempt.cardId,
      compsUsed: u.totalSampleCount,
      confidence: u.confidence,
      // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
      ...persistedLabelsForUnifiedResult(u, tierLabelFor(holdingGradeOf(holding)), ownerUserId),
    }, exact.attempt),
    fields: {
    predictedPrice: u.predictedPrice,
    predictedPriceLow: null,
    predictedPriceHigh: null,
    predictedPriceMechanism: "unified-trend",
    predictedPriceUpdatedAt: nowIso,
    movementDirection: u.trendDirection === "up" ? "up"
      : u.trendDirection === "down" ? "down"
      : null,
    movementUpdatedAt: nowIso,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: null,
    // CF-A-UNION-IS-ONE-CARD (2026-09-01): when the pool-twin union was
    // refused because the halves named different products, the price stands
    // but says so — the pool it came from is narrower than the holding's two
    // identities suggest.
    estimateBasis: `unified: window=${u.windowDays}d median=$${u.fmv?.toFixed(0) ?? "?"} marketValue=$${u.marketValue?.toFixed(0) ?? "?"} predicted=$${u.predictedPrice?.toFixed(0) ?? "?"} trend=${u.trendDirection} ${u.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk conf=${u.confidence.toFixed(2)} id=${exact.attempt.label}${exact.attempt.unionRefusedReason ? ` — ${exact.attempt.unionRefusedReason}` : ""}`,
    isEstimate: false,
    valuationStatus: "observed",
    pricingSource: "unified-pricing",
    nearestGradedAnchor: undefined,
    verdict: "Observed",
    recommendation: holding.recommendation ?? "Hold",
    sourceVendor: "hobbyiq-pool" as any,
    sourceVendorUpdatedAt: nowIso,
    },
  });
}

/**
 * The withhold: no NEW number is published, and the reason SAYS WHAT
 * HAPPENED.
 *
 * CF-A-REFUSAL-STATES-WHAT-ACTUALLY-HAPPENED (Drew, 2026-09-04).
 *
 * This function used to persist, in two places, the sentence
 *
 *     "N exact sales under <id> that the engine could not price"
 *
 * unconditionally — and it was frequently FALSE. The engine had not been
 * asked. On holding 0a9afe09 the one valuation path priced the card at
 * $215.17 (rung player-index-projection) in the same request; what could not
 * price it was the persist WHITELIST upstream, which discarded the valuation
 * before this gate ever ran. The holding then carried prose blaming the
 * engine for a refusal the engine never made, which is the worst kind of
 * wrong: it sends the next reader to debug the pricing engine instead of the
 * layer that actually dropped the number.
 *
 * So the reason is now an argument. The caller states the outcome it
 * actually observed — the entry declined (`entry-unpriced`, carrying the
 * engine's own `reason`), the entry never resolved an identity
 * (`identity-unresolved`), the legacy re-price found nothing
 * (`legacy-unpriced`), or the number failed the cost-basis floor — and the
 * sentence is built from that. No branch of it may claim the engine could
 * not price when the engine was not asked, or priced.
 *
 * Two further changes, same doctrine:
 *
 *   EVIDENCE IS NOT DESTROYED. The old write nulled `estimatedValue` along
 *   with `fairMarketValue`, erasing the number the ladder had produced. A
 *   withhold is a decision not to PUBLISH a value as the card's market
 *   price; it is not a licence to delete what the engine computed. The
 *   proposed estimate is retained in `estimatedValue` (with `isEstimate`
 *   false and `valuationStatus` "pending", so no reader shows it as a
 *   price), and `fairMarketValue` is null exactly as before. A reader — or
 *   the invariant auditor — can now see both what was withheld and why.
 *
 *   THE AUDITOR CAN SEE IT. The old write passed `writeMeta: true` with NO
 *   `meta`, so `pricingSourceMeta` was written as `undefined` — absent.
 *   #1674's whole finding was that a row with no meta is INVISIBLE to every
 *   rung gate and to the invariant auditor. A withhold is precisely the
 *   event an auditor most needs to see, so it now writes a meta naming the
 *   method (`withheld`) and the machine-readable reason.
 */
type WithholdReason =
  /** The one valuation path resolved the identity and declined to price it;
   *  `engineReason` carries the engine's own ValuationReason. */
  | { kind: "entry-unpriced"; engineReason: string | null }
  /** The one valuation path could not name an identity for this holding. */
  | { kind: "identity-unresolved" }
  /** The entry declined AND the legacy exact-pool re-price found nothing. */
  | { kind: "legacy-unpriced" }
  /** A number was produced but failed CF-COST-BASIS-SANITY-FLOOR. */
  | { kind: "cost-basis-floor" };

/** The prose for a withhold: what actually happened, in words that survive
 *  being read six weeks later by someone debugging the wrong layer. */
function withholdReasonProse(reason: WithholdReason, verdict: ExactPoolSupremacyVerdict): string {
  const n = verdict.blockingCount;
  const pool = `${n} exact sale${n === 1 ? "" : "s"} under ${verdict.blockingId} in ${EXACT_POOL_WINDOW_DAYS}d`;
  switch (reason.kind) {
    case "entry-unpriced":
      return `estimate withheld: ${pool} outrank a cross-identity estimate, and the valuation path declined to price this tier${reason.engineReason ? ` (${reason.engineReason})` : ""}`;
    case "identity-unresolved":
      return `estimate withheld: ${pool} outrank a cross-identity estimate, and the catalog holds no identity for this holding to price`;
    case "legacy-unpriced":
      return `estimate withheld: ${pool} outrank a cross-identity estimate, and neither the valuation path nor the legacy exact-pool read produced a number for this tier`;
    case "cost-basis-floor":
      return `estimate withheld: ${pool} outrank a cross-identity estimate, and the exact-pool price that would have replaced it failed the cost-basis sanity floor`;
  }
}

/** A machine-readable form of the same statement, for the auditor. */
function withholdReasonCode(reason: WithholdReason): string {
  return reason.kind;
}

/** No new number is published; the proposed estimate is KEPT as evidence. */
function withholdEstimate(
  holding: PortfolioHolding,
  verdict: ExactPoolSupremacyVerdict,
  nowIso: string,
  reason: WithholdReason,
  /** The estimate this gate refused to publish, preserved rather than erased. */
  proposed: number | null,
): { holding: PortfolioHolding; cleared: boolean } {
  if (holding.isEstimate !== true && proposed === null) return { holding, cleared: false };
  const prose = withholdReasonProse(reason, verdict);
  return {
    cleared: true,
    // CF-ONE-PERSIST-HELPER (C-7): a WITHHOLD is a valuation decision too. It
    // publishes no number, so it names no rung — but it says WHY, and it now
    // writes a meta so the decision is visible to the auditor instead of
    // being an absence nothing can detect.
    holding: writeHoldingValuation(holding, {
      fairMarketValue: null,
      rung: { noRung: prose },
      valueSource: "estimated",
      nowIso,
      meta: {
        // Not a rung — a rung names a price, and this write publishes none.
        // The auditor reads `method` to learn what kind of decision this was.
        compsUsed: verdict.blockingCount,
        confidence: null,
        withheld: { reason: withholdReasonCode(reason), blockingId: verdict.blockingId, blockingCount: verdict.blockingCount, proposed },
      },
      fields: {
        // CF-A-WITHHOLD-DOES-NOT-DESTROY-EVIDENCE (2026-09-04): the number the
        // ladder produced is retained, NOT published. isEstimate:false and
        // valuationStatus "pending" keep every reader off it as a price.
        estimatedValue: proposed,
        estimateLow: null,
        estimateHigh: null,
        estimateConfidence: null,
        estimateBasis: prose,
        isEstimate: false,
        valuationStatus: "pending",
        pricingSource: "legacy-engine",
        nearestGradedAnchor: undefined,
        verdict: "Pending",
      },
    }),
  };
}

async function gateEstimateAgainstExactPool(input: {
  holding: PortfolioHolding;
  userId?: string;
  /** The rung that produced the estimate; null for an unnamed legacy rung. */
  rung: string | null | undefined;
  site: string;
  proposed: number | null;
  basis: string | null;
}): Promise<EstimateGateOutcome> {
  const { holding } = input;
  if (!isCrossIdentityRung(input.rung)) return { outcome: "allowed" };
  let verdict: ExactPoolSupremacyVerdict;
  try {
    verdict = await judgeExactPoolSupremacyForHolding(holding as HoldingIdentityFields);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "exact_pool_supremacy_error",
      source: "portfolioStore.gateEstimateAgainstExactPool",
      site: input.site,
      holdingId: holding.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return { outcome: "allowed" };
  }
  if (verdict.allowed) return { outcome: "allowed" };
  const nowIso = new Date().toISOString();
  console.warn(JSON.stringify({
    event: "estimate_withheld_exact_pool_exists",
    source: "portfolioStore.gateEstimateAgainstExactPool",
    site: input.site,
    userId: input.userId ?? null,
    holdingId: holding.id,
    rung: input.rung ?? null,
    proposedEstimate: input.proposed,
    proposedBasis: input.basis,
    blockingId: verdict.blockingId,
    blockingCount: verdict.blockingCount,
    counts: verdict.counts,
  }));
  // CF-ONE-VALUATION-PATH (D17, 2026-08-30). The exact pool through the ONE
  // entry first: the number that replaces a blocked estimate is the number
  // the card page serves for this holding's slug + grade. A tier with no
  // pool of its own is the entry's empirical fill (grade-curve-estimate,
  // persisted as an estimate) — never the engine's cross-grade rescale off
  // getGraderPremium's tables. When the identity resolved but the entry has
  // no exact-pool number, the legacy re-price below must not run: it could
  // only produce the number the entry declined to. The legacy re-price
  // serves identities the catalog cannot name, exactly as before.
  const entry = await valueHoldingThroughOneEntry(holding, { userId: input.userId ?? null, caller: input.site, nowIso });
  if (entry.outcome === "observed" || entry.outcome === "estimated") {
    console.log(JSON.stringify({
      event: "exact_pool_priced_over_estimate",
      source: "portfolioStore.gateEstimateAgainstExactPool",
      site: input.site,
      userId: input.userId ?? null,
      holdingId: holding.id,
      fair_market_value: entry.valuation.fairMarketValue,
      rung: entry.valuation.rungLabel,
      samples: entry.valuation.compsUsed,
      identityAttempt: entry.valuation.identity.pooledVia,
      pricedId: entry.valuation.identity.pooledAs,
      replacedEstimate: input.proposed,
      oneValuationPath: true,
    }));
    return {
      outcome: "priced-from-exact-pool",
      holding: entry.holding,
      blockingId: verdict.blockingId as string,
      canonical: entry.valuation.fairMarketValue as number,
    };
  }
  const entryDecided = entry.outcome !== "unresolved";
  const gCo = holding.gradeCompany ? String(holding.gradeCompany).trim() : null;
  // CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02): NaN is not a grade.
  // A bare Number(...) here yielded NaN on an unparseable gradeValue, which
  // rendered the tier "PSA NaN", matched nothing, and demoted a real
  // exact-grade pool to cross-grade-fallback. holdingGrade already filters it.
  const gVal = holdingGradeOf(holding as PortfolioHolding)?.value ?? null;
  let exact: ExactPoolPrice | null = null;
  // Whether the LEGACY exact-pool read was actually attempted — the withhold
  // prose distinguishes "the legacy read found nothing" from "there was no
  // identity to read", and only this flag knows which.
  let exactAttempted = false;
  if (!entryDecided) {
    exactAttempted = true;
    try {
      exact = await priceHoldingFromExactPool(holding as HoldingIdentityFields, {
        grade: gCo ? { company: gCo, value: gVal } : null,
        excludeContributorUserId: input.userId ?? null,
        playerName: typeof holding.playerName === "string" ? holding.playerName : null,
        cardYear: shimmedCardYear(holding) ?? null,
      });
    } catch (err) {
      console.warn(JSON.stringify({
        event: "exact_pool_supremacy_price_error",
        source: "portfolioStore.gateEstimateAgainstExactPool",
        site: input.site,
        holdingId: holding.id,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }
  // CF-COST-BASIS-SANITY-FLOOR, as at every other unified write: a price
  // under 15% of a > $50 cost basis is a slug mismatch, not a market.
  if (exact) {
    const qty = Math.max(1, toNumber(holding.quantity, 1));
    const cost = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * qty);
    const proposedTotal = exact.canonical * qty;
    if (cost > 50 && proposedTotal > 0 && proposedTotal / cost < 0.15) {
      console.warn(JSON.stringify({
        event: "exact_pool_supremacy_rejected_cost_basis_floor",
        source: "portfolioStore.gateEstimateAgainstExactPool",
        site: input.site,
        holdingId: holding.id,
        costBasis: cost,
        proposedTotal,
        pricedId: exact.attempt.cardId,
      }));
      exact = null;
    }
  }
  if (exact) {
    console.log(JSON.stringify({
      event: "exact_pool_priced_over_estimate",
      source: "portfolioStore.gateEstimateAgainstExactPool",
      site: input.site,
      userId: input.userId ?? null,
      holdingId: holding.id,
      fair_market_value: exact.canonical,
      rung: exact.u.rungLabel,
      samples: exact.u.totalSampleCount,
      identityAttempt: exact.attempt.label,
      pricedId: exact.attempt.cardId,
      replacedEstimate: input.proposed,
    }));
    return {
      outcome: "priced-from-exact-pool",
      holding: unifiedHoldingWrite(holding, exact, nowIso, input.userId ?? null),
      blockingId: verdict.blockingId as string,
      canonical: exact.canonical,
    };
  }
  // CF-A-REFUSAL-STATES-WHAT-ACTUALLY-HAPPENED (Drew, 2026-09-04): the
  // reason is the outcome this function actually observed, never a blanket
  // assertion about an engine it may not have consulted. `entry` above IS
  // the one valuation path's answer for this holding, so its outcome is the
  // truth about whether the engine could price it.
  const withholdReason: WithholdReason =
    entry.outcome === "cost-basis-floor" ? { kind: "cost-basis-floor" }
    : entry.outcome === "unpriced" ? { kind: "entry-unpriced", engineReason: entry.valuation.reason }
    : entryDecided ? { kind: "entry-unpriced", engineReason: null }
    : exactAttempted ? { kind: "legacy-unpriced" }
    : { kind: "identity-unresolved" };
  const w = withholdEstimate(holding, verdict, nowIso, withholdReason, input.proposed ?? null);
  console.warn(JSON.stringify({
    event: "estimate_withheld_exact_pool_unpriced",
    source: "portfolioStore.gateEstimateAgainstExactPool",
    site: input.site,
    holdingId: holding.id,
    blockingId: verdict.blockingId,
    blockingCount: verdict.blockingCount,
    withholdReason: withholdReason.kind,
    entryOutcome: entry.outcome,
    proposedEstimateRetained: input.proposed ?? null,
    staleEstimateCleared: w.cleared,
  }));
  return { outcome: "withheld", holding: w.holding, blockingId: verdict.blockingId as string, cleared: w.cleared };
}

async function autoPriceHolding(
  doc: UserDoc,
  holding: PortfolioHolding,
  previous: PortfolioHolding | undefined,
  source: string,
  userId?: string,
): Promise<PortfolioHolding> {
  // CF-ONE-VALUATION-PATH (D17, 2026-08-30). FIRST rung: the ONE valuation
  // entry — the same call the card page answers from — so the number
  // persisted here IS the number every pricing route serves for this
  // holding's slug + grade. This replaces CF-GRADE-CURVE-IS-SOURCE-OF-TRUTH
  // (08-06: the legacy curve build on the majority vendor cardId, read for
  // the holding's tile) and, for every identity the catalog names, the
  // unified early exit below: three reads of one pool through three engine
  // calls, and the engine's cross-grade rescale (getGraderPremium's tables,
  // rung cross-grade-fallback) persisted as "observed". The entry's fill for
  // a tier with no pool is this identity's other tiers × the empirical
  // ratio, persisted as an ESTIMATE under its rung name.
  //
  // Not env-flagged — the tile rung never was. The legacy exact-pool reads
  // below run only when the catalog holds no identity for the holding
  // (`unresolved`); when the identity resolved and the entry declined
  // (`unpriced`, or the cost-basis floor), they must not run either — they
  // could only produce the number the entry declined to. The legacy
  // ESTIMATE chain (computeEstimate, the rail, the ladders, our-pool, the
  // sibling) still runs for an unpriced holding, each site behind the
  // supremacy gate.
  const oneEntry = await valueHoldingThroughOneEntry(holding, { userId: userId ?? null, caller: "autoPriceHolding.one-entry" });
  if (oneEntry.outcome === "observed" || oneEntry.outcome === "estimated") {
    const nowIso = (oneEntry.holding.lastUpdated as string) ?? new Date().toISOString();
    // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01): the grade-curve lane is
    // where Verlander (96.34 -> 64.12 -> 96.34) and Judge (131.88 -> 106 ->
    // 131.88) drifted across one day's crons with nothing recorded. Estimated
    // points now append TAGGED; observedPricePoints() keeps every existing
    // reader on the observed trail.
    const oneEntryFmv = oneEntry.valuation.fairMarketValue;
    if (typeof oneEntryFmv === "number" && Number.isFinite(oneEntryFmv)) {
      appendPriceHistory(doc, holding.id, {
        at: nowIso,
        value: oneEntryFmv,
        source,
        ...(oneEntry.outcome === "estimated" ? { valuationStatus: "estimated" as const } : {}),
        // CF-A-MOVER-NEEDS-CORROBORATION: carry the rung onto the point, so a
        // reader can tell a real sale of THIS card from an engine re-anchor
        // without re-deriving anything.
        ...(typeof oneEntry.valuation.rungLabel === "string" && oneEntry.valuation.rungLabel
          ? { rungLabel: oneEntry.valuation.rungLabel }
          : {}),
      });
    }
    evaluateHoldingAlerts(doc, previous, oneEntry.holding);
    doc.holdings[holding.id] = oneEntry.holding;
    return oneEntry.holding;
  }
  // CF-A-REFUSED-PRICE-IS-STILL-A-DECISION (2026-09-04): the on-demand path
  // has the same hole as the batch reprice — a floor rejection wrote nothing
  // and the holding fell through to a lane that re-stated whatever meta was
  // already there. Same shared write, so the two paths cannot drift.
  if (oneEntry.outcome === "cost-basis-floor") {
    const cbf = costBasisFloorRefusalWrite(holding, oneEntry, new Date().toISOString());
    doc.holdings[holding.id] = cbf.holding;
    console.warn(JSON.stringify({
      event: "cost_basis_floor_refusal_persisted",
      source: "portfolioStore.autoPriceHolding",
      holdingId: holding.id,
      summary: cbf.summary,
    }));
    return cbf.holding;
  }
  // CF-A-STALE-VALUE-IS-NOT-A-PRICE (Drew, 2026-09-04): the engine declined
  // for a reason no other lane may paper over — the catalog holds no identity
  // (the $1,850 Bellingham Griffey standing beside an engine that returns
  // identity-not-in-catalog), or the pool is mid-migration (the $240 Maddux).
  // The prior value is kept and LABELLED, and the legacy chain below does NOT
  // run: it could only substitute a number the engine deliberately withheld.
  if (oneEntry.outcome === "no-basis-refusal") {
    const nb = noBasisRefusalWrite(holding, oneEntry.reason, oneEntry.valuation, new Date().toISOString());
    doc.holdings[holding.id] = nb.holding;
    console.warn(JSON.stringify({
      event: "no_basis_refusal_persisted",
      source: "portfolioStore.autoPriceHolding",
      holdingId: holding.id,
      reason: oneEntry.reason,
      summary: nb.summary,
    }));
    return nb.holding;
  }
  const entryDecidedExactPool = oneEntry.outcome !== "unresolved";

  // CF-UNIFIED-PRICING-EARLY-EXIT (Drew, 2026-08-04). ONE function,
  // ONE number, ONE prediction. When computeUnifiedPrice has real
  // data (marketValue > 0 AND confidence >= 0.3) — write it directly
  // and return. Bypass the legacy computeEstimate + graded rail +
  // ladder + our-pool + layered overrides. Every consumer reads
  // fairMarketValue + predictedPrice; both come from unified.
  //
  // Legacy path below stays as the coverage-gap fallback for holdings
  // where unified has no data (thin pool, unknown cardId). Over time
  // the pool fills and this early-exit fires for more holdings.
  // D17: only for identities the catalog cannot name (see above).
  const earlyResolvedId = holding.cardId || (holding as any).hobbyiqCardId || null;
  if (!entryDecidedExactPool && process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true" && earlyResolvedId) {
    try {
      const gCo = (holding as any).gradeCompany
        ? String((holding as any).gradeCompany).trim()
        : null;
      // CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02): NaN is not a grade -- see gateEstimateAgainstExactPool.
      const gVal = holdingGradeOf(holding as PortfolioHolding)?.value ?? null;
      // CF-EXACT-POOL-FIRST-BY-CHECKLIST-ID (D4 PR 5, 2026-08-29). The
      // checklist identity (hobbyiqCardId) ALONE first, then its twin, then
      // the cardId union — exactPoolSupremacy.unifiedIdentityAttempts. The
      // Marconi fixture's cardId was a different card; a union pool let its
      // comps hide the three exact sales under hobbyiqCardId.
      const exact = await priceHoldingFromExactPool(holding as HoldingIdentityFields, {
        grade: gCo ? { company: gCo, value: gVal } : null,
        excludeContributorUserId: userId ?? null,
        // CF-PLAYER-TREND-ADJUSTMENT: pipe playerName + cardYear so
        // unified pricing can lift stale exact-cardId medians by the
        // wider player-pool trend ratio.
        playerName: (holding as any).playerName ?? null,
        cardYear: typeof (holding as any).cardYear === "number"
          ? (holding as any).cardYear
          : null,
      });
      // CF-FMV-IS-PROJECTED-NEXT-SALE (Drew, 2026-08-05). Per the golden
      // rule: "FMV is the projected next sale from a comp pool's trend —
      // NEVER a median or mean."
      // CF-ONE-GRADE-CURVE (D4 PR 4, 2026-08-29). Since CF-TREND-FROM-FIT-
      // NOT-LAST-THREE (08-22) marketValue IS that projection — the fit read
      // at now; predictedPrice is the same fit read at +7d. The grade-curve
      // tile above, hobbyIqFmv (CF-NEVER-A-BARE-MEDIAN, 08-28) and the card
      // page all show marketValue, so a holding priced here must show the
      // SAME number: marketValue first, the +7d read only when the engine
      // could not evaluate at now, the bare median last.
      const u = exact?.u ?? null;
      const canonical = u ? (u.marketValue ?? u.predictedPrice ?? u.fmv) : null;
      // CF-UNIFIED-SAMPLE-FLOOR (Drew, 2026-08-04). Use unified whenever
      // the pool has >= 1 exact-cardId sample and a positive canonical
      // number — trust the pool over sibling rescue even when old.
      // Cost-basis floor (< 15% of cost, > $50 cost) rejects slug-
      // mismatch cases like Verlander PSA 10 $0.25 for a $259 card.
      const earlyQty = Math.max(1, toNumber(holding.quantity, 1));
      const earlyCost = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * earlyQty);
      const earlyProposedTotal = canonical !== null ? canonical * earlyQty : 0;
      const earlySuspiciouslyLow = earlyCost > 50 && earlyProposedTotal > 0 && (earlyProposedTotal / earlyCost) < 0.15;
      if (earlySuspiciouslyLow) {
        console.warn(JSON.stringify({
          event: "portfolio_unified_early_exit_rejected_cost_basis_floor",
          source: "portfolioStore.autoPriceHolding",
          holdingId: holding.id,
          costBasis: earlyCost,
          proposedTotal: earlyProposedTotal,
          proposedPct: Math.round((earlyProposedTotal / earlyCost) * 10000) / 100,
          confidence: u?.confidence ?? null,
          totalSampleCount: u?.totalSampleCount ?? 0,
        }));
        // Fall through to legacy path — legacy has its own guards.
      } else if (u !== null && canonical !== null && canonical > 0 && u.totalSampleCount >= 1) {
        const nowIso = new Date().toISOString();
        console.log(JSON.stringify({
          event: "portfolio_unified_early_exit_applied",
          source: "portfolioStore.autoPriceHolding",
          userId, holdingId: holding.id, cardId: earlyResolvedId,
          identityAttempt: exact?.attempt.label ?? null,
          pricedId: exact?.attempt.cardId ?? null,
          fair_market_value: canonical,
          unified_median: u.fmv,
          unified_market_value: u.marketValue,
          unified_predicted: u.predictedPrice,
          confidence: u.confidence,
          window_days: u.windowDays,
          trend_direction: u.trendDirection,
          trend_pct_per_week: u.trendPctPerWeek,
        }));
        // CF-ONE-PERSIST-HELPER (C-7): exact pool, this identity, this tier —
        // observed, with the rung and the labels the helper composes.
        const unified: PortfolioHolding = writeHoldingValuation(holding as PortfolioHolding, {
          fairMarketValue: canonical,
          rung: { rung: u.rungLabel },
          valueSource: "observed",
          nowIso,
          meta: {
            slug: exact?.attempt.cardId ?? String(earlyResolvedId),
            compsUsed: u.totalSampleCount,
            confidence: u.confidence,
            // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
            ...persistedLabelsForUnifiedResult(u, tierLabelFor(holdingGradeOf(holding as PortfolioHolding)), userId ?? null),
          },
          fields: {
          predictedPrice: u.predictedPrice,
          predictedPriceLow: null,
          predictedPriceHigh: null,
          predictedPriceMechanism: "unified-trend",
          predictedPriceUpdatedAt: nowIso,
          movementDirection: u.trendDirection === "up" ? "up"
            : u.trendDirection === "down" ? "down"
            : null,
          movementUpdatedAt: nowIso,
          estimatedValue: null,
          estimateLow: null,
          estimateHigh: null,
          estimateConfidence: null,
          estimateBasis: `unified: window=${u.windowDays}d median=$${u.fmv?.toFixed(0) ?? "?"} marketValue=$${u.marketValue?.toFixed(0) ?? "?"} predicted=$${u.predictedPrice?.toFixed(0) ?? "?"} trend=${u.trendDirection} ${u.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk conf=${u.confidence.toFixed(2)}`,
          isEstimate: false,
          valuationStatus: "observed",
          pricingSource: "unified-pricing",
          // CF-LABELS-TELL-THE-TRUTH (D4 PR 5): the meta names THIS price's
          // rung and pool; a previous pass's "cross-setkey" cannot survive.
          // Composed by the helper from `meta` above — one vocabulary.
          sourceVendor: "cardhedge" as any,
          sourceVendorUpdatedAt: nowIso,
          },
        });
        // CF-A-MOVER-NEEDS-CORROBORATION: the unified engine names its rung;
        // the point carries it.
        appendPriceHistory(doc, holding.id, { at: nowIso, value: canonical, source, ...(typeof u.rungLabel === "string" && u.rungLabel ? { rungLabel: u.rungLabel } : {}) });
        evaluateHoldingAlerts(doc, previous, unified);
        doc.holdings[holding.id] = unified;
        return unified;
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "portfolio_unified_early_exit_error",
        source: "portfolioStore.autoPriceHolding",
        holdingId: holding.id,
        error: (err as Error)?.message ?? String(err),
      }));
      // Fall through to legacy path
    }
  }

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
  let fairValue = toNumber((estimate as any)?.fairMarketValue, toNumber((estimate as any)?.value, 0));

  // CF-UNIFIED-PRICING (Drew, 2026-08-04). Portfolio + card catalog
  // now read from ONE function so numbers match by construction.
  // computeUnifiedPrice queries sold_comps (our owned pool), applies
  // adaptive window (30d/60d/90d/180d based on comp density), excludes
  // priceAnomaly=true rows, computes weighted-median per grade with
  // recency decay, and projects next sale via 14d-recent-vs-14d-prior
  // trend. Portfolio calls with holding's grade → gets fmv + predicted
  // for THAT tier. Card catalog omits grade → gets full curve. Same
  // rows, same math → same numbers.
  let unifiedResult: {
    fmv: number | null; marketValue: number | null; predictedPrice: number | null;
    method: string; confidence: number;
    trendPctPerWeek: number | null; trendDirection: string;
    windowDays: number;
    rungLabel: string;
    totalSampleCount: number;
    pricedId: string;
    identityAttempt: string;
  } | null = null;
  // CF-UNIFIED-PRICING-HIQ-FALLBACK (Drew, 2026-08-04). Also fire when
  // holding lacks a resolved cardId but HAS a canonical hobbyiqCardId
  // slug. Rare-parallel eBay-auto imports (Victor Figueroa Black & White
  // Red Ink SSP) land in `pending-review` with a hobbyiqCardId set but
  // no vendor cardId — legacy engine's fuzzy fallback then produces
  // wildly wrong numbers ($1.89 for a $278 card). Pass the hobbyiqCardId
  // as both cardId + hobbyiqCardId to unifiedPricing so it can find
  // seeded catalog / self-contributed comps.
  const resolvedIdForPricing = holding.cardId
    || (holding as any).hobbyiqCardId
    || null;
  // D17: only for identities the catalog cannot name — the one entry decided
  // the exact pool for every other holding above.
  if (!entryDecidedExactPool
      && process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true"
      && resolvedIdForPricing) {
    try {
      const gradeCoRaw = (holding as any).gradeCompany;
      const gradeValRaw = (holding as any).gradeValue;
      const gradeCo = gradeCoRaw ? String(gradeCoRaw).trim() : null;
      const gradeVal = typeof gradeValRaw === "number" ? gradeValRaw : (gradeValRaw ? Number(gradeValRaw) : null);
      // CF-EXACT-POOL-FIRST-BY-CHECKLIST-ID (D4 PR 5): hobbyiqCardId alone
      // first, then its twin, then the cardId union.
      const midExact = await priceHoldingFromExactPool(holding as HoldingIdentityFields, {
        grade: gradeCo ? { company: gradeCo, value: gradeVal } : null,
        // CF-EXCLUDE-SELF-COMPS (Drew, 2026-08-04). Symmetric rule: a
        // user's OWN eBay purchase shouldn't feed their own pricing.
        // Fixes Bobby Witt Jr. BGS 9.5 case where the sole $1,260
        // ebay-user-purchase row made confidence stuck at ~0 forcing
        // a fall-through to the Raw estimator ($902). The service
        // internally KEEPS self-comps when the surviving other-pool
        // is < SELF_COMP_MIN_OTHER_SAMPLES — for a rare-parallel SSP
        // where the user's own purchase IS the market, filtering them
        // out leaves nothing (Victor Figueroa case).
        excludeContributorUserId: userId ?? null,
        playerName: (holding as any).playerName ?? null,
        cardYear: typeof (holding as any).cardYear === "number"
          ? (holding as any).cardYear
          : null,
      });
      // CF-PORTFOLIO-VALUE-IS-MARKETVALUE (Drew, 2026-08-04). CURRENT VALUE
      // in a portfolio position is the TREND-LIFTED market value —
      // weightedMedian scaled by the recent-vs-prior trend ratio. This is
      // "where would the next sale clear if the current trend holds?"
      // and matches Grade Curve's MARKET VALUE label.
      //
      // Progression: earlier this session I flipped to unified.fmv (raw
      // weighted median = $2,326 for Ohtani PSA 9) — but that's dragged
      // down by older sales in a hot market. August was clearing $2,700+
      // while the 14d weighted median was still $2,326. marketValue
      // ($2,326 × 1.12 ≈ $2,610) is what the position is actually worth
      // this week — matches Drew's memory rule "FMV = projected next sale
      // from pool trend; never a median".
      //
      // Fall-throughs (CF-ONE-GRADE-CURVE, D4 PR 4): marketValue — the fit
      // read at now, the number the grade-curve tile shows — then the +7d
      // read, then the bare median. When the pool is too thin for a trend
      // signal, all three are equal.
      const unified = midExact?.u ?? null;
      const chosen = unified ? (unified.marketValue ?? unified.predictedPrice ?? unified.fmv) : null;
      // CF-EXACT-POOL-SUPREMACY (D4 PR 5): >= 1 exact sale, as at the early exit.
      if (unified !== null && chosen !== null && chosen > 0 && unified.totalSampleCount >= 1) {
        unifiedResult = {
          totalSampleCount: unified.totalSampleCount,
          pricedId: midExact?.attempt.cardId ?? String(resolvedIdForPricing),
          identityAttempt: midExact?.attempt.label ?? "cardId",
          fmv: unified.fmv,
          marketValue: unified.marketValue,
          predictedPrice: unified.predictedPrice,
          method: unified.method,
          confidence: unified.confidence,
          trendPctPerWeek: unified.trendPctPerWeek,
          trendDirection: unified.trendDirection,
          windowDays: unified.windowDays,
          rungLabel: unified.rungLabel,
        };
        console.log(JSON.stringify({
          event: "portfolio_unified_pricing_applied",
          source: "portfolioStore.autoPriceHolding",
          userId, holdingId: holding.id, cardId: holding.cardId,
          method: unified.method,
          confidence: unified.confidence,
          fair_value_before: fairValue,
          unified_median: unified.fmv,
          unified_market_value: unified.marketValue,
          unified_predicted: unified.predictedPrice,
          window_days: unified.windowDays,
          trend_pct_per_week: unified.trendPctPerWeek,
          trend_direction: unified.trendDirection,
        }));
        fairValue = chosen;
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "portfolio_unified_pricing_error",
        source: "portfolioStore.autoPriceHolding",
        userId, holdingId: holding.id,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): graded-rail resolution.
  // Run when the holding is graded (gradeCompany + gradeValue present
  // and well-formed) AND we have a cardId to fetch pricing
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
  // Ungraded holdings or holdings without cardId skip the rail
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
  const cardId =
    typeof holding.cardId === "string" && holding.cardId.length > 0
      ? holding.cardId
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

  if (isGraded && cardId) {
    try {
      const pricing = await getPricingForMarketRead(cardId);
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
            // CF-CH-GRADED-FROM-COMPOSED-ANCHOR (2026-06-28): Build B
            // composed fallback so thin-parallel holdings get graded
            // estimates persisted on autoPrice.
            estimatedValue?: number | null;
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
          cardId: cardId,
          // CF-EXACT-IDENTITY-SUPREMACY (Drew, 2026-08-28): the holding's
          // canonical slug lets every projected grade tier defer to its own
          // exact (slug, grade) pool when that pool is deep. This is the
          // notify path — the Ohtani refractor prices from its 130-comp
          // exact pool here, never from base's.
          hobbyiqCardId: (holding as { hobbyiqCardId?: string | null }).hobbyiqCardId ?? null,
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

  // CF-IDENTITY-HYDRATION-COMPLETION (2026-06-18): compute the hydration
  // patch BEFORE the no-FMV early return. Engine catalog resolution +
  // cardIdentity construction happen during fetchComps regardless of
  // whether downstream pricing succeeds — the variant-mismatch / thin-
  // data / no-recent-comps branches all return rich cardIdentity (verified
  // against the live deployed dist for Hartman's `source:"variant-mismatch"`
  // shape). Hoisting the patch above the gate lets the skip path hydrate
  // identity even when no FMV lands. The helper's pin-authoritative +
  // card_id-match guards still apply — name-resolved skips or stub
  // identities no-op safely.
  const identityPatch = hydrateHoldingIdentityFromEstimate(
    holding,
    (estimate as any)?.cardIdentity,
  );

  // For ungraded holdings: preserve the existing "abort on fairValue<=0"
  // behavior — the rail wasn't going to fire anyway, and we don't want
  // to start stamping valuationStatus on cases that previously persisted
  // with no value at all. CF-IDENTITY-HYDRATION-COMPLETION: if the
  // hydration patch is non-empty, stamp it back even on the no-FMV path
  // so a sparse-identity holding (e.g. Hartman's variant-mismatch skip)
  // still gains its catalog identity fields on this tick.
  // CF-CH-THIN-COMP-PRIMARY (2026-06-26): build a lastSaleSurface patch
  // when (AND ONLY WHEN) the engine emitted estimateSource ===
  // "cardhedge-last-sale" (single trusted CH sale, parallel-specific
  // chCardId, FMV null by design). Every other estimateSource leaves
  // this patch empty — the additive invariant is preserved by
  // construction: a CS-sourced / observed / trend-extrapolated / variant-
  // mismatch / no-recent-comps holding's persisted shape is byte-identical
  // pre/post this CF.
  const chLastSalePatch = buildChLastSalePatch(estimate);

  // CF-AUTOPRICE-GRADE-LADDER-FALLBACK relocation (2026-06-29): the
  // ungraded-no-FMV early-return at the next branch was bypassing the
  // ladder fallback for the 12 ENGINE_GAP holdings the audit surfaced.
  // Try the ladder HERE so a successful anchor pre-empts the early
  // return; failure falls through to the prior behavior unchanged.
  let preEarlyLadderResult: {
    derivedFmv: number;
    confidence: number;
    explanation: string;
    anchorGrade: string;
    anchorPrice: number;
    anchorDaysOld: number;
    anchorSampleSize: number;
  } | null = null;
  const earlyCardId =
    typeof holding.cardId === "string" && holding.cardId.length > 0
      ? holding.cardId
      : null;
  if (
    earlyCardId &&
    !railResolution &&
    fairValue <= 0
  ) {
    preEarlyLadderResult = await applyGradeLadderFallback({
      holding,
      cardId: earlyCardId,
      source: "portfolio.autoPriceHolding.pre-early",
    });
  }

  if (preEarlyLadderResult) {
    // CF-ONE-PERSIST-HELPER (C-7): the ladder produces an estimate from
    // another grade tier and names no rung — an explicit refusal, not a gap.
    const hydrated: PortfolioHolding = writeHoldingValuation(holding, {
      fairMarketValue: null,  // ladder produces estimate, not observed
      rung: { noRung: `grade-ladder fallback anchored on ${preEarlyLadderResult.anchorGrade}; the ladder names no rung` },
      valueSource: "estimated",
      nowIso: new Date().toISOString(),
      writeMeta: false,
      fields: {
      ...identityPatch,
      ...chLastSalePatch,
      estimatedValue: preEarlyLadderResult.derivedFmv,
      estimateLow: preEarlyLadderResult.anchorPrice * 0.7,
      estimateHigh: preEarlyLadderResult.anchorPrice * 1.3,
      estimateConfidence:
        preEarlyLadderResult.confidence >= 0.5 ? "estimate" :
        preEarlyLadderResult.confidence >= 0.3 ? "rough" : "ballpark",
      estimateBasis: preEarlyLadderResult.explanation,
      isEstimate: true,
      valuationStatus: "estimated",
      nearestGradedAnchor: {
        grade: preEarlyLadderResult.anchorGrade,
        price: preEarlyLadderResult.anchorPrice,
        daysOld: preEarlyLadderResult.anchorDaysOld,
        sampleSize: preEarlyLadderResult.anchorSampleSize,
        confidence: preEarlyLadderResult.confidence,
      },
      // CF-SOURCE-VENDOR (2026-07-13): ladder result is CH-derived.
      sourceVendor: "cardhedge",
      sourceVendorUpdatedAt: new Date().toISOString(),
      },
    });
    doc.holdings[holding.id] = hydrated;
    return hydrated;
  }

  if (!railResolution && fairValue <= 0) {
    // CF-CH-THIN-COMP-PRIMARY (2026-06-26): scoped writeback bypass.
    // When `chLastSalePatch` is non-empty, the engine produced a single
    // trusted CardHedge sale we want to PERSIST so the list view can
    // render "Last sold $X via N comp(s)" instead of "Can't estimate
    // yet." The fairValue<=0 abort still fires for every other source
    // (variant-mismatch, no-recent-comps, low-confidence CS) — exactly
    // as before. The patch merge order matters: identityPatch first
    // (catalog backfill), chLastSalePatch second (the new surface),
    // lastUpdated stamped last so both sites can read the freshness.
    if (
      Object.keys(identityPatch).length > 0 ||
      Object.keys(chLastSalePatch).length > 0
    ) {
      const hydrated: PortfolioHolding = {
        ...holding,
        ...identityPatch,
        ...chLastSalePatch,
        lastUpdated: new Date().toISOString(),
      };
      doc.holdings[holding.id] = hydrated;
      return hydrated;
    }
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
  // stamped holding. Ungraded / no-cardId path: railResolution
  // is null → fall back to engine-classification reading below.
  //
  // CF-A(a) — T3 BASE-AUTO FLOOR RE-BUCKET: when railResolution is null
  // (Raw / non-rail path) AND the engine response carries
  // valuationStatus === "estimated" (set by the engine at T3 — see
  // compiqEstimate.service.ts T3 re-bucket block), persist as an estimate
  // with fairMarketValue=null + estimatedValue=<T3 pool value>. Otherwise
  // keep the pre-CF behavior: stamp fairValue as observed.
  const engineValuationStatus = (estimate as any)?.valuationStatus;
  const resolved = railResolution ?? (
    engineValuationStatus === "estimated"
      ? {
          fairMarketValueOverride: null,
          valuationStatus: "estimated" as const,
          estimatedValue: (estimate as any)?.estimatedValue ?? null,
          estimateLow: (estimate as any)?.estimateLow ?? null,
          estimateHigh: (estimate as any)?.estimateHigh ?? null,
          estimateConfidence: (estimate as any)?.estimateConfidence ?? null,
          estimateBasis: (estimate as any)?.estimateBasis ?? null,
          isEstimate: true,
        }
      : {
          fairMarketValueOverride: fairValue,
          valuationStatus: "observed" as const,
          estimatedValue: null,
          estimateLow: null,
          estimateHigh: null,
          estimateConfidence: null,
          estimateBasis: null,
          isEstimate: false,
        }
  );

  // CF-UNIFIED-PRICING-FORCE-OBSERVED (Drew, 2026-08-04). When
  // computeUnifiedPrice returned a real value with confidence >= 0.3,
  // force fairMarketValue to the projected-next-sale (or median
  // fallback) regardless of what the graded-rail decided. Bypasses
  // the graded-rail's "estimated" branch which was writing null even
  // though unified had a real observed-based number.
  // CF-RUNG-LABEL (D4 PR 1, 2026-08-29). The rung that produced whatever
  // `priceSurface` finally holds. Every producer of the surface below sets
  // it — the engines that name their rung write the name, the legacy paths
  // write null — and the final holding write persists it as `fmvRung`.
  let priceSurfaceRung: string | null = null;
  // CF-ONE-HEADLINE-CHAIN (D12a, 2026-08-29). #1432 aligned the headline to
  // `marketValue ?? predictedPrice ?? fmv` everywhere the unified result is
  // read; this producer and the final-authority one below were the two left
  // reading predictedPrice first, so the same holding could carry a different
  // headline depending on which branch wrote last.
  if (unifiedResult && (unifiedResult.marketValue ?? unifiedResult.predictedPrice ?? unifiedResult.fmv) !== null) {
    const chosen = unifiedResult.marketValue ?? unifiedResult.predictedPrice ?? unifiedResult.fmv!;
    resolved.fairMarketValueOverride = chosen;
    priceSurfaceRung = unifiedResult.rungLabel;
    (resolved as any).valuationStatus = "observed";
    (resolved as any).isEstimate = false;
    (resolved as any).estimatedValue = null;
    (resolved as any).estimateBasis = `unified: window=${unifiedResult.windowDays}d median=$${unifiedResult.fmv?.toFixed(0) ?? "?"} predicted=$${unifiedResult.predictedPrice?.toFixed(0) ?? "?"} trend=${unifiedResult.trendDirection} ${unifiedResult.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk confidence=${unifiedResult.confidence.toFixed(2)}`;
  }

  // CF-AUTOPRICE-GRADE-LADDER-FALLBACK (2026-06-28): when the engine
  // produced null/zero FMV AND we have a cardId, fall through
  // to the grade-ladder anchor mechanism we own end-to-end (same one
  // surfaced at /price-by-id in CF-CH-NEAREST-GRADED-ANCHOR PR #164).
  // This rescues the "CH has prices, engine couldn't anchor" class
  // identified by the 2026-06-28 inventory audit (12 holdings where
  // CH had grade data but engine FMV was null because the user's grade
  // wasn't in CH's pool — e.g. Roman Anthony BGS 8.5 when CH has Raw/
  // PSA 10/PSA 9, or Gage Wood PSA 9 when CH has only Raw).
  //
  // Branches:
  //   - rail "observed" path with fairValue > 0: no change (engine produced
  //     a real FMV, ladder not needed)
  //   - rail "estimated" path: no change (T3 base-auto floor already set
  //     estimatedValue; ladder would compete needlessly)
  //   - everything else with fairValue <= 0 AND cardId: try ladder
  //
  // Synthesizes the same shape as the T3 estimated path so the wire-
  // shape / iOS rendering treats both identically.
  let resolvedAfterLadder = resolved;
  let nearestGradedAnchorSnapshot: {
    grade: string;
    price: number;
    daysOld: number;
    sampleSize: number;
    confidence: number;
  } | null = null;
  const railIsObservedZero =
    resolved.valuationStatus === "observed" && (resolved.fairMarketValueOverride ?? 0) <= 0;
  // CF-AUTOPRICE-GRADE-LADDER-FALLBACK fix (2026-06-29): the rail's
  // "match insufficient" branch sets valuationStatus="estimated" with
  // estimatedValue=null. The prior gate skipped this case incorrectly.
  // New gate: fire the ladder when the rail produced NO usable estimate,
  // regardless of whether valuationStatus was "estimated" or "observed".
  const railNoUsableEstimate =
    !(typeof resolved.estimatedValue === "number" && resolved.estimatedValue > 0);
  const railNoUsableFmv =
    !(typeof resolved.fairMarketValueOverride === "number" && resolved.fairMarketValueOverride > 0);
  if (
    cardId &&
    railNoUsableFmv &&
    railNoUsableEstimate
  ) {
    const ladder = await applyGradeLadderFallback({
      holding,
      cardId: cardId,
      source: "portfolio.autoPriceHolding",
    });
    if (ladder) {
      nearestGradedAnchorSnapshot = {
        grade: ladder.anchorGrade,
        price: ladder.anchorPrice,
        daysOld: ladder.anchorDaysOld,
        sampleSize: ladder.anchorSampleSize,
        confidence: ladder.confidence,
      };
      // Promote to "estimated" so iOS shows the ladder-derived value
      // with low-confidence styling instead of the null FMV.
      priceSurfaceRung = null;  // the ladder does not name its rung
      resolvedAfterLadder = {
        fairMarketValueOverride: null,
        valuationStatus: "estimated" as const,
        estimatedValue: ladder.derivedFmv,
        estimateLow: ladder.anchorPrice * 0.7,  // wide band on derived-anchor estimates
        estimateHigh: ladder.anchorPrice * 1.3,
        estimateConfidence: ladder.confidence,
        estimateBasis: ladder.explanation,
        isEstimate: true,
      };
    }
  }

  // CF-OUR-POOL-PORTFOLIO-PRICER (Drew, 2026-07-27): when the flag is on,
  // the hobbyiq-fmv service (which reads OUR sold_comps pool by canonical
  // slug and applies grade multipliers via GRADE_CALIBRATION) takes final
  // authority over the FMV/estimate fields on the write. Legacy engine
  // still ran above and supplies identityPatch / chLastSalePatch /
  // predictedPrice / trendIQ — Our-Pool only overrides the price surface.
  // Returns null → legacy resolved holds, no override applied.
  let priceSurface = resolvedAfterLadder;
  let ourPoolMeta: {
    slug: string;
    method: string;
    compsUsed: number;
  } | null = null;
  if (isPriceFromOurPoolEnabled()) {
    const ourPool = await priceHoldingFromOurPool(holding);
    if (ourPool !== null) {
      // CF-COST-BASIS-SANITY-FLOOR (Drew, 2026-08-04). Reject our-pool
      // overrides that produce a wildly-suspicious drop vs cost basis.
      // Bobby Witt Jr. BGS 9.5 auto ($1,260 paid) was getting matched
      // to non-auto base card slugs and priced at $6.92 — a 99.5% loss
      // that's obviously a slug/parallel mismatch, not real market
      // signal. Guard: if the proposed FMV is less than 15% of cost
      // basis, KEEP the existing FMV / estimatedValue instead.
      //
      // CF-THE-FLOOR-IS-A-RATIO-NOT-A-DOLLAR-AMOUNT (Drew, 2026-09-04): this
      // was a fourth inline copy of the predicate, dollar gate included. It
      // now calls the SAME `costBasisFloor` every other lane calls, so the
      // doctrine has one implementation and the $29.45 Chipper Jones is
      // refused here too.
      const qty = Math.max(1, toNumber(holding.quantity, 1));
      const proposedUnit = typeof ourPool.fairMarketValue === "number" && ourPool.fairMarketValue > 0
        ? ourPool.fairMarketValue
        : typeof ourPool.estimatedValue === "number" && ourPool.estimatedValue > 0
          ? ourPool.estimatedValue
          : 0;
      const opFloor = costBasisFloor(holding, proposedUnit);
      const costBasis = opFloor.costBasis;
      const proposed = opFloor.proposedTotal;
      const suspiciouslyLow = opFloor.rejects;
      if (suspiciouslyLow) {
        console.warn(JSON.stringify({
          event: "our_pool_override_rejected_cost_basis_floor",
          source: "portfolioStore.autoPriceHolding",
          holdingId: holding.id,
          costBasis,
          proposed,
          proposedPct: Math.round((proposed / costBasis) * 10000) / 100,
          method: ourPool.method,
          slug: ourPool.slug,
          keepingPrior: true,
        }));
        // Skip the override — legacy resolved holds, no change to priceSurface.
      } else {
        priceSurface = {
          fairMarketValueOverride: ourPool.fairMarketValue,
          valuationStatus: ourPool.valuationStatus,
          estimatedValue: ourPool.estimatedValue,
          estimateLow: ourPool.estimateLow,
          estimateHigh: ourPool.estimateHigh,
          estimateConfidence: ourPool.estimateConfidence,
          estimateBasis: ourPool.estimateBasis,
          isEstimate: ourPool.valuationStatus === "estimated",
        };
        // CF-RUNG-LABEL: the meta's `method` is read as a rung label (see the
        // reprice writer below) — stamp the rung, not the HobbyIqFmvMethod.
        ourPoolMeta = { slug: ourPool.slug, method: ourPool.rungLabel, compsUsed: ourPool.compsUsed };
        priceSurfaceRung = ourPool.rungLabel;
      }
    }
  }

  // CF-UNIFIED-FINAL-AUTHORITY (Drew, 2026-08-04). Unified pricing runs
  // first (line ~2054), but two later stages can overwrite its result:
  // the graded-rail's "estimated" branch (line ~2490) and the our-pool
  // pricer (line ~2613). Re-apply the unified override HERE so it's
  // the final authority when it has confidence and a real market value.
  //
  // Rationale: unified pricing uses adaptive-window weighted-median with
  // recency decay AND applies the current trend ratio (marketValue field).
  // For hot markets (Ohtani PSA 9 up 20+%/month), unified's marketValue
  // ($2,596) matches recent August clearing prices; our-pool's hobbyIqFmv
  // walks a different ladder and can produce a stale number ($1,925 for
  // the same holding). Both are valid pool queries but unified's math
  // is what portfolio + Grade Curve now share.
  let unifiedIsFinalAuthority = false;
  // CF-ONE-HEADLINE-CHAIN (D12a): marketValue ?? predictedPrice ?? fmv — the
  // fifth and last chain, aligned with the four #1432 aligned.
  if (unifiedResult && (unifiedResult.marketValue ?? unifiedResult.predictedPrice ?? unifiedResult.fmv) !== null) {
    const finalChosen = unifiedResult.marketValue ?? unifiedResult.predictedPrice ?? unifiedResult.fmv!;
    // CF-EXACT-POOL-SUPREMACY (D4 PR 5): >= 1 exact sale, as at the early exit.
    if (finalChosen > 0 && unifiedResult.totalSampleCount >= 1) {
      unifiedIsFinalAuthority = true;
      priceSurface = {
        fairMarketValueOverride: finalChosen,
        valuationStatus: "observed",
        estimatedValue: null,
        estimateLow: null,
        estimateHigh: null,
        estimateConfidence: null,
        estimateBasis: `unified: window=${unifiedResult.windowDays}d median=$${unifiedResult.fmv?.toFixed(0) ?? "?"} marketValue=$${unifiedResult.marketValue?.toFixed(0) ?? "?"} predicted=$${unifiedResult.predictedPrice?.toFixed(0) ?? "?"} trend=${unifiedResult.trendDirection} ${unifiedResult.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk`,
        isEstimate: false,
      };
      priceSurfaceRung = unifiedResult.rungLabel;
    }
  }

  // CF-IDENTITY-HYDRATION (2026-06-18) / -COMPLETION (2026-06-18): identity
  // patch already computed above (hoisted to fire on both the success path
  // here AND the no-FMV early return). Spread is a no-op when the patch
  // is empty.
  // CF-FINAL-PRICE-COHERENCE (2026-08-22). Two guards that already existed in
  // narrower forms, hoisted to the FINAL price surface.
  //
  // Both bugs this closes share one shape, the same shape as the Kurtz
  // canonical-override bug: a CORRECT guard scoped to ONE code path, while the
  // value can arrive by several.
  //
  //   - CF-COST-BASIS-SANITY-FLOOR (2026-08-04) refuses a proposed FMV under
  //     15% of cost for holdings over $50 — but only inside the our-pool
  //     branch. Jac Caglianone (holding 9b971b03) arrived with
  //     pricingSource=null, so the floor never ran and $9.66 published against
  //     $205.48 paid (4.7%). Root cause is an identity error: the eBay Set
  //     aspect said "2024 Bowman Draft" while the seller's own title said
  //     "2026 Topps Chrome".
  //   - PURCHASE_PRICE_SANITY_FLOOR_PCT flags needsReview under 20% of paid,
  //     but lives only in ebayImportRematch, so a reprice can never raise it.
  //
  // This deliberately does NOT re-identify or re-price anything. The measured
  // blast radius of flipping eBay title-over-aspect precedence was 10 of 59
  // titled holdings (16.9%), of which only 2 were genuine errors — the rest
  // were the documented product-family ladder ("2026 Bowman Chrome" stored as
  // "2026 Bowman", slug already correct). Guessing a different slug here would
  // stack a second guess on top of the first. Refuse and flag instead.
  const cohQty = Math.max(1, toNumber(holding.quantity, 1));
  const cohCost = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * cohQty);

  // (a) An "estimated" holding whose FMV falls outside its own estimate band is
  // internally incoherent whichever number is right. Barry Bonds (46f3dd96)
  // stored fairMarketValue 112.50 against estimateLow 21 / estimateHigh 31 and
  // estimatedValue 26 — the UI rendered 112.50 while the engine's own band said
  // 21-31. The band is the honest answer for an estimated holding.
  // CF-NO-IDENTITY-NO-PRICE: runs BEFORE the band and cost-basis guards,
  // because a price with no identity behind it is not a price those guards
  // should be reasoning about. Identity is read AFTER identityPatch so a
  // holding hydrated during this very run is judged on its new state.
  const identityAfterPatch = {
    cardId: (identityPatch as { cardId?: string | null }).cardId ?? holding.cardId ?? null,
    hobbyiqCardId:
      (identityPatch as { hobbyiqCardId?: string | null }).hobbyiqCardId
      ?? (holding as { hobbyiqCardId?: string | null }).hobbyiqCardId
      ?? null,
  };
  let unidentifiedPatch: { needsReview?: boolean; reviewReason?: string } = {};
  if (!holdingIdentityIsResolved(identityAfterPatch)) {
    if (priceSurface.fairMarketValueOverride !== null || priceSurface.estimatedValue !== null) {
      console.warn(JSON.stringify({
        event: "unidentified_holding_price_withheld",
        source: "portfolioStore.autoPriceHolding",
        holdingId: holding.id,
        playerName: holding.playerName ?? null,
        cardNumber: holding.cardNumber ?? null,
        parallel: holding.parallel ?? null,
        withheldFairMarketValue: priceSurface.fairMarketValueOverride,
        withheldEstimatedValue: priceSurface.estimatedValue,
        costBasis: toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0)),
      }));
    }
    priceSurface = {
      ...priceSurface,
      fairMarketValueOverride: null,
      estimatedValue: null,
      estimateLow: null,
      estimateHigh: null,
      isEstimate: false,
    };
    priceSurfaceRung = null;
    unidentifiedPatch = {
      needsReview: true,
      reviewReason:
        "We could not identify this card, so we are not showing a value. Confirm the set, card number and parallel.",
    };
  }

  const band = reconcileEstimatedFmvToBand({
    valuationStatus: priceSurface.valuationStatus,
    fairMarketValue: priceSurface.fairMarketValueOverride,
    estimateLow: priceSurface.estimateLow,
    estimateHigh: priceSurface.estimateHigh,
    estimatedValue: priceSurface.estimatedValue,
  });
  if (band.changed) {
    console.warn(JSON.stringify({
      event: "estimated_fmv_outside_own_band",
      source: "portfolioStore.autoPriceHolding",
      holdingId: holding.id,
      fairMarketValue: priceSurface.fairMarketValueOverride,
      estimateLow: priceSurface.estimateLow,
      estimateHigh: priceSurface.estimateHigh,
      estimatedValue: priceSurface.estimatedValue,
      replacedWith: band.fmv,
    }));
    priceSurface = { ...priceSurface, fairMarketValueOverride: band.fmv };
  }

  // (b) Cost-basis floor, applied to whatever produced the final number.
  // Flags for review; does NOT overwrite the price. We have no better number,
  // and silently nulling it would hide a card that genuinely crashed.
  const coherencePatch0 = costBasisReviewPatch({
    costBasis: cohCost,
    fairMarketValue: priceSurface.fairMarketValueOverride,
    quantity: cohQty,
    // Pass the stored state so a price that has recovered can RETRACT the
    // flag, not just fail to re-set it.
    needsReview: (holding as { needsReview?: boolean | null }).needsReview ?? null,
    reviewReason: (holding as { reviewReason?: string | null }).reviewReason ?? null,
  });
  // The spread below puts coherencePatch AFTER unidentifiedPatch, so a
  // retraction here would silently undo an unidentified flag raised on this
  // same pass. An unidentified holding is flagged for a different, still-true
  // reason; this check does not get to speak for it.
  const coherencePatch = unidentifiedPatch.needsReview ? {} : coherencePatch0;
  if (coherencePatch.needsReview) {
    console.warn(JSON.stringify({
      event: "final_price_below_cost_basis_floor",
      source: "portfolioStore.autoPriceHolding",
      holdingId: holding.id,
      costBasis: cohCost,
      fairMarketValue: priceSurface.fairMarketValueOverride,
      pricingSource: unifiedIsFinalAuthority ? "unified-pricing" : ourPoolMeta ? "our-pool" : "legacy-engine",
      reviewReason: coherencePatch.reviewReason,
      flaggedForReview: true,
    }));
  }

  // ── CF-NO-REGRESSION-ON-STARVED-POOL (2026-08-22) ─────────────────────
  //
  // A reprice that found NOTHING is not a market observation, it is a failed
  // query, and it must not be written down as a valuation.
  //
  // Live case: Shohei Ohtani 2018 Bowman Chrome #1 PSA 9 held a correct
  // fairMarketValue of $2,341.20, computed from 225 real PSA 9 sales and equal
  // to its own grade-curve tile. A reprice ran during a Cosmos throttling
  // event (17,834 x 429 in that five-minute bucket), its pool queries came
  // back starved, and the engine persisted valuationStatus "estimated" with
  // fairMarketValue REMOVED — over the good number. The grade curve, which
  // recomputes on read, still said $2,341.20, so the card page showed a
  // current value that disagreed with its own curve.
  //
  // The card did not become unpriceable. Cosmos was busy.
  //
  // So: when the new surface carries no FMV and no estimate, and the holding
  // already had a positive stored FMV, keep what we had and log it. A genuine
  // transition to unpriceable still lands the moment the engine returns any
  // number at all, and the unidentified-holding path above is untouched — that
  // one withholds deliberately and has already blanked the surface by design.
  const priorFmv = toNumber((holding as { fairMarketValue?: unknown }).fairMarketValue, 0);
  if (shouldKeepStoredPriceOnEmptySurface({
    newFairMarketValue: priceSurface.fairMarketValueOverride,
    newEstimatedValue: priceSurface.estimatedValue,
    storedFairMarketValue: priorFmv,
    identityResolved: holdingIdentityIsResolved(identityAfterPatch),
  })) {
    console.warn(JSON.stringify({
      event: "reprice_skipped_starved_pool",
      source: "portfolioStore.autoPriceHolding",
      holdingId: holding.id,
      playerName: holding.playerName ?? null,
      keptFairMarketValue: priorFmv,
      detail: "recompute produced neither an FMV nor an estimate; keeping the stored value rather than blanking it",
    }));
    return holding;
  }

  // CF-EXACT-POOL-SUPREMACY (D4 PR 5, 2026-08-29). Every estimate this
  // function can write converges here. A cross-identity estimate (a rail,
  // a ladder, a neighbour rung, an unnamed legacy rung) may be persisted
  // only when no identity of this holding has a sale in window; otherwise
  // the exact pool prices it, or nothing does.
  if (priceSurface.isEstimate) {
    const gate = await gateEstimateAgainstExactPool({
      holding,
      userId,
      rung: priceSurfaceRung,
      site: "autoPriceHolding.priceSurface",
      proposed: priceSurface.estimatedValue ?? priceSurface.fairMarketValueOverride ?? null,
      basis: priceSurface.estimateBasis ?? null,
    });
    if (gate.outcome !== "allowed") {
      if (gate.outcome === "priced-from-exact-pool") {
        // CF-A-MOVER-NEEDS-CORROBORATION: this branch fired BECAUSE the exact
        // pool priced the holding (`priced-from-exact-pool`); the rung the gate
        // settled on is on the holding it returned.
        appendPriceHistory(doc, holding.id, {
          at: String(gate.holding.lastUpdated),
          value: gate.canonical,
          source,
          ...(typeof (gate.holding as { fmvRung?: unknown }).fmvRung === "string"
            && (gate.holding as { fmvRung?: string }).fmvRung
            ? { rungLabel: (gate.holding as { fmvRung: string }).fmvRung }
            : {}),
        });
      }
      evaluateHoldingAlerts(doc, previous, gate.holding);
      doc.holdings[holding.id] = gate.holding;
      return gate.holding;
    }
  }

  // CF-ONE-PERSIST-HELPER (C-7, 2026-09-03). This is the site that wrote
  // holding 60a7cfcc — Devin Taylor CPA-DT Black, $31.50 beside its own
  // "Projected: $1176" basis, on a $650 cost basis, at 15:53Z on 2026-09-03 —
  // with NO `fmvRung` key and no `valueSource`, while `pricingSourceMeta.method`
  // carried "rare-card-anchor" the whole time. The rung existed and never
  // reached the flat field the gates read.
  //
  // `priceSurfaceRung` is the rung when the surface named one. When it did
  // not, the meta's method is the SAME rung by construction (both are set from
  // the unified result / our-pool result a few lines up), so preferring it
  // here recovers the label rather than inventing one; only when neither
  // exists is this an honest refusal.
  const surfaceMetaRung = unifiedIsFinalAuthority && unifiedResult
    ? unifiedResult.rungLabel
    : (ourPoolMeta as { method?: unknown } | null)?.method;
  const surfaceRung = priceSurfaceRung
    ?? (typeof surfaceMetaRung === "string" && surfaceMetaRung ? surfaceMetaRung : null);
  // "observed" only when the surface itself says so. An estimate — a band, a
  // ladder, a rail, a vendor — is "estimated" no matter which rung named it.
  const surfaceValueSource = priceSurface.valuationStatus === "observed" && !priceSurface.isEstimate
    ? "observed" as const
    : "estimated" as const;
  const updated: PortfolioHolding = writeHoldingValuation(holding, {
    fairMarketValue: priceSurface.fairMarketValueOverride === null
      ? null  // null erases the field on display; ERP read coerces null→null
      : priceSurface.fairMarketValueOverride,
    rung: surfaceRung
      ? { rung: surfaceRung }
      : { noRung: "legacy price surface named no rung (legacy engine / band reconcile)" },
    valueSource: surfaceValueSource,
    nowIso: new Date().toISOString(),
    meta: unifiedIsFinalAuthority && unifiedResult
      ? { slug: unifiedResult.pricedId, compsUsed: unifiedResult.totalSampleCount, confidence: unifiedResult.confidence }
      : (ourPoolMeta
        // CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03): explicit null, not a
        // number invented to satisfy the type. priceFromOurPool collapses the
        // engine's numeric confidence to a TIER STRING and never returns the
        // scalar (pinned by siblingEstimateNeverOutranksExactPool), so this
        // lane genuinely has no pricing confidence to give. Null is the honest
        // statement and renders as "—"; a fabricated 1.0 would not.
        ? { slug: (ourPoolMeta as { slug?: string | null }).slug ?? null, compsUsed: (ourPoolMeta as { compsUsed?: number | null }).compsUsed ?? null, confidence: null }
        : undefined),
    writeMeta: Boolean((unifiedIsFinalAuthority && unifiedResult) || ourPoolMeta),
    fields: {
    ...identityPatch,
    ...unidentifiedPatch,
    ...coherencePatch,
    estimatedValue: priceSurface.estimatedValue,
    estimateLow: priceSurface.estimateLow,
    estimateHigh: priceSurface.estimateHigh,
    estimateConfidence: priceSurface.estimateConfidence,
    estimateBasis: priceSurface.estimateBasis,
    isEstimate: priceSurface.isEstimate,
    valuationStatus: priceSurface.valuationStatus,
    // CF-OUR-POOL-PORTFOLIO-PRICER: telemetry so we can audit which pricing
    // path actually landed on each holding after the flag flips on.
    // CF-LABELS-TELL-THE-TRUTH (D4 PR 5): when the unified engine is the
    // final authority on the surface, say so — and name its rung and pool.
    // Before this the surface said "legacy-engine" (or "our-pool") under a
    // unified price, and a previous pass's meta rode along.
    pricingSource: unifiedIsFinalAuthority ? "unified-pricing" : ourPoolMeta ? "our-pool" : "legacy-engine",
    // `pricingSourceMeta` and `fmvRung` are the helper's to write — it composes
    // the meta from `meta` above (so `method` and the flat rung carry ONE
    // vocabulary by construction) and stamps the rung from the required
    // RungDeclaration. Setting either here would be the second implementation
    // that let them disagree in the first place.
    // CF-AUTOPRICE-GRADE-LADDER-FALLBACK (2026-06-28): persist the
    // anchor snapshot so the iOS detail surface can render
    // "Last sold: PSA 9 $1325 · 236 days ago" alongside the estimated
    // value. null when the ladder didn't fire (typical case).
    nearestGradedAnchor: nearestGradedAnchorSnapshot ?? undefined,
    predictedPrice,
    predictedPriceLow,
    predictedPriceHigh,
    predictedPriceMechanism,
    predictedPriceUpdatedAt,
    movementDirection,
    movementUpdatedAt,
    // CF-COMP-HOLDING-WIRE-PARITY Slice 2 (audit PR #483, 2026-07-15):
    // persist the full trendIQ + confidence + predictedPriceAttribution
    // objects from the estimate. composeHoldingWireShape now emits them
    // instead of the null placeholders PR #482 stamped. Legacy holdings
    // (written before this PR) load as `undefined` for these fields; the
    // wire coerces `undefined` → `null` and iOS decoders bind defensively.
    trendIQ: (estimate as any)?.trendIQ ?? null,
    // CF-PRICING-CONFIDENCE-SCALE (2026-09-03). `confidence.pricingConfidence`
    // on a CompIqEstimate is 0..100 — that is the declared type (compiq.types.ts)
    // and what every producer in compiqEstimate.service.ts emits (0/15/25/40/55,
    // and the calibrated value clamped by `Math.min(100, ...)` at ~7491). The
    // holding's flat `confidence` field is 0..1 (portfolioiq.types.ts).
    //
    // This line used to `Math.min(1, ...)` the 0..100 input instead of dividing
    // by 100, so every confidence at or above 1 saturated to exactly 1.0 — a
    // pricing confidence of 37 and one of 91 both persisted as "1". That is the
    // origin of the flat-1.0 population (17 of 43 holdings in Drew's portfolio).
    // compiq.routes.ts has always divided (`... ?? 60) / 100`); this writer did
    // not. scalePricingConfidence makes the conversion explicit and shared.
    confidence: scalePricingConfidence((estimate as any)?.confidence?.pricingConfidence),
    predictedPriceAttribution:
      (estimate as any)?.predictedPriceAttribution ?? null,
    verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
    recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
    // CF-CARDSIGHT-VENDOR-PROVENANCE (audit PR #492, 2026-07-15): the
    // dual-source resolver went live with Drew's CF-CARDSIGHT-FALLBACK-
    // REVIVAL (2026-07-14) + CF-CS-STRUCTURED-BRIDGE / CF-CS-PRICING-
    // BACKSTOP (2026-07-15). Read the vendor from the estimate response
    // (populated from fetched.vendor at compiqEstimate.service.ts:7419)
    // so CS-served holdings get stamped with the correct provenance.
    // Falls back to "cardhedge" for legacy estimates that predate the
    // sourceVendor field — worst case behavior matches the pre-PR
    // hardcode.
    sourceVendor: ((estimate as any)?.sourceVendor as "cardhedge" | "cardsight" | undefined) ?? "cardhedge",
    sourceVendorUpdatedAt: now,
    // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: writer no longer stamps
    // currentValue / totalProfitLoss / totalProfitLossPct / quickSaleValue /
    // premiumValue / suggestedListPrice. The wire computes all 6 at response
    // assembly from cached fairMarketValue + stored quantity + cost basis
    // via composeHoldingWireShape (responseAssembly.ts). Phase C drops still
    // hold: movement detail β, confidence / compsUsed (holding), marketSpeed /
    // marketPressure (Gate-2 β), freshnessStatus.
    },
  });

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): the trajectory iOS renders is real
  // comp-anchored value over time — never estimate points (which drift as the
  // engine re-anchors) or null gaps. That guarantee is unchanged, and now it
  // is enforced by a TAG rather than by silence.
  //
  // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01). Refusing to append left
  // estimated holdings with no record at all, so a grade-curve number could
  // drift with nothing to compare against: Verlander 96.34 -> 64.12 -> 96.34
  // and Judge 131.88 -> 106 -> 131.88 across a single day's crons, invisible.
  // Estimated writes now append TAGGED; every reader of the observed trail
  // goes through observedPricePoints(), which drops them.
  if (resolved.fairMarketValueOverride !== null
    && (resolved.valuationStatus === "observed" || resolved.valuationStatus === "estimated")) {
    appendPriceHistory(doc, holding.id, {
      at: now,
      value: resolved.fairMarketValueOverride,
      source,
      ...(resolved.valuationStatus === "estimated" ? { valuationStatus: "estimated" as const } : {}),
      // CF-A-MOVER-NEEDS-CORROBORATION: `priceSurfaceRung` is the same value
      // this function stamps onto the holding as `fmvRung` a few lines up.
      // The point and the holding therefore never disagree about the rung.
      // It is null for the lanes that do not name one (the ladder, the legacy
      // rungs) — and null is written as ABSENT, which reads as uncorroborated.
      ...(priceSurfaceRung ? { rungLabel: priceSurfaceRung } : {}),
    });
  }

  // CF-CATALOG-RESOLVER-FALLBACK (2026-07-13): when CH could not price this
  // holding (fairMarketValue AND estimatedValue both null → truly nothing),
  // ask the multi-source resolver. Sold-comps may have priced this exact
  // SKU via our own users' completed sales even when CH doesn't index it
  // (the CPA-EHA Blue Refractor Auto case). On a resolver hit, stamp the
  // winning vendor + write the FMV.
  //
  // Kept narrow: only fires on true CH catalog-miss cases. Any successful
  // CH pricing (observed or estimated) is left as authoritative — the
  // resolver is a coverage-gap plug, not a price arbiter.
  // CF-RESOLVER-FALLBACK-EVERYWHERE (2026-07-13): consolidated helper used
  // by both autoPriceHolding + repriceHoldingsForUser. Only fires when CH
  // truly had nothing. On non-CH winner: stamp FMV + sourceVendor +
  // valuationStatus. See resolverFallbackHelper.ts for the shared contract.
  const { tryResolverFallback, shouldTryFallback } = await import(
    "../compiq/resolverFallbackHelper.js"
  );
  if (shouldTryFallback({ fairMarketValue: updated.fairMarketValue, estimatedValue: updated.estimatedValue })) {
    const fallback = await tryResolverFallback({
      playerName: updated.playerName,
      cardYear: updated.cardYear,
      setName: updated.setName ?? (updated as any).product,
      parallel: updated.parallel,
      cardNumber: updated.cardNumber,
      gradeCompany: updated.gradeCompany,
      gradeValue: updated.gradeValue,
      isAuto: updated.isAuto,
      cardId: (updated as any).cardId,
    });
    if (fallback) {
      // CF-CATALOG-FALLBACK-COST-BASIS-FLOOR (Drew, 2026-08-06). Mirror
      // of the same guard at ~line 2765. Devin Taylor CPA-DT Black auto
      // ($650 cost basis) got fmv=$3.69 written via THIS path because
      // this second write site had no cost-basis check. Any fallback
      // FMV that lands <15% of cost basis is suspiciously low; keep the
      // prior value instead. valuationStatus stays as-is so UI still shows
      // a value (per Drew: "we can't show null, we have the calculation to
      // get to its current value").
      //
      // CF-THE-FLOOR-IS-A-RATIO-NOT-A-DOLLAR-AMOUNT (Drew, 2026-09-04): the
      // fifth and last inline copy, routed to the one shared predicate.
      const cfFloor = costBasisFloor(holding, fallback.fairMarketValue);
      const costBasis = cfFloor.costBasis;
      const proposed = cfFloor.proposedTotal;
      const suspiciouslyLow = cfFloor.rejects;
      if (suspiciouslyLow) {
        console.warn(JSON.stringify({
          event: "catalog_fallback_rejected_cost_basis_floor",
          source: "portfolioStore.autoPriceHolding",
          holdingId: holding.id,
          costBasis,
          proposed,
          proposedPct: Math.round((proposed / costBasis) * 10000) / 100,
          vendor: fallback.vendor,
          keepingPrior: true,
        }));
      } else {
        // CF-ONE-PERSIST-HELPER (C-7): the resolver genuinely names no rung —
        // that is an explicit refusal carrying its reason, not a missing key.
        // A vendor's number is `estimated` by definition: it is not comps of
        // this identity and tier that we read.
        Object.assign(updated, writeHoldingValuation(updated, {
          fairMarketValue: fallback.fairMarketValue,
          rung: { noRung: `resolver fallback (${fallback.vendor}) names no rung` },
          valueSource: "estimated",
          nowIso: new Date().toISOString(),
          writeMeta: false,
          fields: {
            valuationStatus: "estimated",
            isEstimate: true,
            estimateBasis: fallback.estimateBasis,
            sourceVendor: fallback.vendor as PortfolioHolding["sourceVendor"],
            sourceVendorUpdatedAt: new Date().toISOString(),
          },
        }));
        console.log(JSON.stringify({
          event: "catalog_resolver_fallback_hit",
          source: "portfolioStore.autoPriceHolding",
          holdingId: holding.id,
          vendor: fallback.vendor,
          fairMarketValue: fallback.fairMarketValue,
          compCount: fallback.compCount,
        }));
      }
    }
  }

  // CF-DIRECT-SLUG-SAFETY-NET (Drew, 2026-08-06). Last-resort: if the
  // whole legacy chain produced a null fairMarketValue AND we have a
  // hobbyiqCardId slug with real sales in sold_comps, use hobbyIqFmv
  // service (direct-slug > sibling-parallel > cross-parallel-ratio
  // ladder) so the holding never renders "no price" when we've observed
  // its market. Real case: Eric Hartman Orange Shimmer Refractor Auto
  // had 3 direct sales ($1,185/$1,531/$1,713) but mechanism1 returned
  // NULL_MECHANISM1_RESULT (parallel not in curated list) so the
  // holding wrote fairMarketValue=null.
  const finalFmv = (updated as any).fairMarketValue;
  const finalSlug = (updated as any).hobbyiqCardId ?? (updated as any).cardId ?? null;
  if ((finalFmv === null || finalFmv === undefined) && typeof finalSlug === "string" && finalSlug.startsWith("hiq:")) {
    try {
      const { computeHobbyIqFmv } = await import("./hobbyIqFmv.service.js");
      const gCo = (updated as any).gradeCompany ? String((updated as any).gradeCompany).trim() : null;
      // CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02): NaN is not a grade -- see gateEstimateAgainstExactPool.
      const gVal = holdingGradeOf(updated as PortfolioHolding)?.value ?? null;
      const hiq = await computeHobbyIqFmv({
        hobbyiqCardId: finalSlug,
        gradeCompany: gCo,
        gradeValue: gVal,
      });
      if (hiq && hiq.fmv !== null && hiq.fmv > 0) {
        // CF-ONE-PERSIST-HELPER (C-7). `direct-slug` reads THIS identity's own
        // sold_comps rows, so it is the one method here that is observed; every
        // other rung on this ladder (sibling-parallel, cross-parallel-ratio) is
        // another identity's evidence and is `estimated`.
        const hiqObserved = hiq.method === "direct-slug";
        Object.assign(updated, writeHoldingValuation(updated, {
          fairMarketValue: hiq.fmv,
          rung: hiq.rungLabel
            ? { rung: hiq.rungLabel }
            : { noRung: `hobbyIqFmv safety net (${hiq.method}) named no rung` },
          valueSource: hiqObserved ? "observed" : "estimated",
          nowIso: new Date().toISOString(),
          writeMeta: false,
          fields: {
            predictedPrice: hiq.fmv,
            predictedPriceMechanism: `hobbyIqFmv:${hiq.method}`,
            predictedPriceUpdatedAt: new Date().toISOString(),
            valuationStatus: "estimated",
            estimateBasis: hiq.basisNote,
            isEstimate: !hiqObserved,
          },
        }));
        console.log(JSON.stringify({
          event: "portfolio_hobbyiqfmv_safety_net_hit",
          source: "portfolioStore.autoPriceHolding",
          holdingId: holding.id,
          slug: finalSlug,
          method: hiq.method,
          fmv: hiq.fmv,
          compCount: hiq.compCount,
        }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "portfolio_hobbyiqfmv_safety_net_error",
        holdingId: holding.id,
        message: (err as Error).message,
      }));
    }
  }

  evaluateHoldingAlerts(doc, previous, updated);
  doc.holdings[holding.id] = updated;
  return updated;
}

/**
 * CF-A-SWING-IS-NOT-A-MARKET (2026-09-01, holdings 9b971b03 RA-JC ~10.4x and
 * ca820b08 Gonzalez ~41x). The per-unit value a holding carries, for swing
 * comparison only: fairMarketValue when it is a positive number, else the
 * estimate. Null when the holding has no number at all — a first price is not
 * a swing.
 */
export function perUnitFmvForSwing(h: {
  fairMarketValue?: unknown;
  estimatedValue?: unknown;
}): number | null {
  const fmv = h.fairMarketValue;
  if (typeof fmv === "number" && Number.isFinite(fmv) && fmv > 0) return fmv;
  const est = h.estimatedValue;
  if (typeof est === "number" && Number.isFinite(est) && est > 0) return est;
  return null;
}

/** The multiple between two positive values, in whichever direction is larger.
 *  Null when either side is missing — nothing to compare. */
export function swingRatio(from: number | null, to: number | null): number | null {
  if (from === null || to === null || !(from > 0) || !(to > 0)) return null;
  return from > to ? from / to : to / from;
}

/**
 * The swing threshold: a newly computed value more than this multiple away
 * from the previous persisted one, in EITHER direction, is a pool-composition
 * flap and not a market. Override with PORTFOLIO_SWING_ALARM_RATIO.
 *
 * The value is PERSISTED either way — grade monotonicity is not an invariant
 * and neither is price continuity: observe the swing, never clamp it
 * (feedback_grade_monotonicity_is_not_an_invariant). This is an alarm, not a
 * gate.
 */
export const DEFAULT_SWING_ALARM_RATIO = 2;

export function swingAlarmRatio(): number {
  const raw = Number(process.env.PORTFOLIO_SWING_ALARM_RATIO);
  return Number.isFinite(raw) && raw > 1 ? raw : DEFAULT_SWING_ALARM_RATIO;
}

/** Pure: does this move deserve the alarm? Strictly greater than the ratio,
 *  so an exact 2x is quiet and 2.01x is loud. */
export function isSwingAlarming(from: number | null, to: number | null, ratio = DEFAULT_SWING_ALARM_RATIO): boolean {
  const r = swingRatio(from, to);
  return r !== null && r > ratio;
}

function appendPriceHistory(
  doc: UserDoc,
  holdingId: string,
  point: PortfolioPricePoint,
): void {
  const existing = doc.priceHistoryByHolding[holdingId] ?? [];
  const prev = existing.length > 0 ? existing[existing.length - 1] : null;
  // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK: the same number under a DIFFERENT
  // status is a different fact (the pool went away, or came back) and is
  // never de-duplicated away.
  const sameStatus = (prev?.valuationStatus ?? "observed") === (point.valuationStatus ?? "observed");
  if (prev && sameStatus && Math.abs(prev.value - point.value) < 0.0001) {
    const prevTime = new Date(prev.at).getTime();
    const currentTime = new Date(point.at).getTime();
    if (Number.isFinite(prevTime) && Number.isFinite(currentTime) && Math.abs(currentTime - prevTime) < 60_000) {
      return;
    }
  }
  existing.push(point);
  doc.priceHistoryByHolding[holdingId] = capPriceHistoryByClass(existing);
}

/**
 * CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK / CAP-EVICTION (2026-09-01).
 *
 * The cap used to be `existing.slice(-max)` over ONE interleaved array. Once
 * estimated points began appending (the 6h cron writes up to 4/day for a
 * holding sitting on the grade-curve rail), those appends walked the window
 * forward and evicted the observed trail wholesale: at 4 estimated/day a
 * 365-point window is pure estimate in ~91 days, observedPricePoints() then
 * returns [], and getHoldingPriceHistory / buildCalibrationReport /
 * buildWeeklyNarrative all see an EMPTY observed series for a holding whose
 * comp-anchored history was real. The estimate would have silently eaten the
 * observations it drifts against — the exact opposite of making drift visible.
 *
 * So retention is PER CLASS. The two series are different facts with different
 * lifetimes and they never compete for one window:
 *
 *   • observed  — comp-anchored, the series every existing reader wants, and
 *     the one the calibration report scores against real sales. Keeps the
 *     existing PORTFOLIO_PRICE_HISTORY_MAX (default 365) semantics EXACTLY,
 *     so an all-observed holding caps identically to before this change.
 *     Never evicted by an estimated append.
 *   • estimated — a drifting number, useful for seeing the drift and little
 *     else. Capped separately at PORTFOLIO_ESTIMATED_HISTORY_MAX, default 180:
 *     at the cron's 4/day that is ~45 days of drift visibility, enough to see
 *     a flap develop without letting the noisy series dominate the UserDoc.
 *
 * Points keep their chronological interleaving in storage — readers that want
 * one class filter (observedPricePoints), readers that want the whole picture
 * (getHoldingPriceHistory with includeEstimated) get it in time order.
 */
export const DEFAULT_PORTFOLIO_PRICE_HISTORY_MAX = 365;
export const DEFAULT_PORTFOLIO_ESTIMATED_HISTORY_MAX = 180;

function historyCapFromEnv(envName: string, fallback: number): number {
  return Math.max(
    30,
    Math.floor(Number(process.env[envName] ?? fallback)) || fallback,
  );
}

export function observedHistoryMax(): number {
  return historyCapFromEnv("PORTFOLIO_PRICE_HISTORY_MAX", DEFAULT_PORTFOLIO_PRICE_HISTORY_MAX);
}

export function estimatedHistoryMax(): number {
  return historyCapFromEnv("PORTFOLIO_ESTIMATED_HISTORY_MAX", DEFAULT_PORTFOLIO_ESTIMATED_HISTORY_MAX);
}

/** Cap each valuation class against its OWN window, preserving the stored
 *  order. Exported for the pin — an estimated flood must not evict observations. */
export function capPriceHistoryByClass<T extends { valuationStatus?: "observed" | "estimated" | string }>(
  points: readonly T[],
): T[] {
  const observedMax = observedHistoryMax();
  const estimatedMax = estimatedHistoryMax();

  // Walk backwards keeping the newest N of each class, so the survivors are
  // the most recent per class rather than the most recent overall.
  let observedKept = 0;
  let estimatedKept = 0;
  const keep = new Array<boolean>(points.length).fill(false);
  for (let i = points.length - 1; i >= 0; i--) {
    // Absence means observed — the pre-tag guarantee (see PortfolioPricePoint).
    const isEstimated = points[i].valuationStatus === "estimated";
    if (isEstimated) {
      if (estimatedKept < estimatedMax) { keep[i] = true; estimatedKept++; }
    } else if (observedKept < observedMax) {
      keep[i] = true; observedKept++;
    }
  }
  return points.filter((_, i) => keep[i]);
}
/**
 * CF-A-DELETED-HOLDING-KEEPS-NO-TRAIL (H-9, 2026-09-03). `priceHistoryByHolding`
 * is keyed by holding id, and nothing ever removed an entry when the holding it
 * belongs to was deleted — so every delete leaked its whole trail into the user
 * doc forever.
 *
 * Measured on prod the day this shipped: 250 orphaned trails corpus-wide
 * carrying 16,246 of 24,055 stored points (67.5%), and `user-199fcbc9`'s doc at
 * 1,963,908 of the 2,097,152-byte Cosmos ceiling (93.7%) with 238 of its 281
 * trails orphaned. At the ceiling every reprice AND every holding edit for that
 * user fails. The per-class caps from #1627 bound a LIVE holding's trail; they
 * bound nothing at all once the holding is gone.
 *
 * Every `delete doc.holdings[id]` in this codebase pairs with this call. It is
 * deliberately keyed off the one id being deleted rather than sweeping the map:
 * a sweep in the delete path would also reap a trail whose holding is being
 * re-keyed in the same tick (the sell and trade lanes both delete and re-add).
 * The corpus-wide sweep for trails ALREADY orphaned is the repair script,
 * `backend/scripts/reap-orphan-price-trails.cjs`, which is report-first and
 * reconciled.
 *
 * Returns the number of points reaped so callers can report a number rather
 * than assert a success.
 */
export function reapPriceTrail(doc: UserDoc, holdingId: string): number {
  const trail = doc.priceHistoryByHolding?.[holdingId];
  if (!Array.isArray(trail)) return 0;
  const points = trail.length;
  delete doc.priceHistoryByHolding[holdingId];
  return points;
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

  // CF-RECOMMENDATION-FLIP-ALERT (2026-07-06, Drew): fire when the
  // seller verdict changes to SELL_NOW or HOLD. Silent on LIST↔LIST
  // and transitions in/out of INSUFFICIENT_DATA (too noisy — a fresh
  // comp arriving shouldn't fire a notification).
  //
  // Persists `next.lastRecommendationVerdict` on every eval so the
  // NEXT eval has a stable prior state to compare against — without
  // this the alert fires every cycle where verdict isn't LIST.
  try {
    const currentRec = computeActionSyncSafe(next);
    if (currentRec) {
      const priorVerdict =
        (previous as { lastRecommendationVerdict?: string } | undefined)
          ?.lastRecommendationVerdict ?? null;
      const flipped =
        currentRec.verdict !== priorVerdict &&
        (currentRec.verdict === "SELL_NOW" || currentRec.verdict === "HOLD");
      if (flipped) {
        const level: PortfolioAlert["level"] =
          currentRec.verdict === "SELL_NOW" ? "critical" : "info";
        const verb =
          currentRec.verdict === "SELL_NOW"
            ? "flipped to SELL_NOW"
            : "flipped to HOLD";
        addAlert(doc, {
          level,
          type: "recommendation-flip",
          holdingId: String(next.id),
          playerName,
          cardTitle,
          message: `${playerName} recommendation ${verb}. ${currentRec.reasoning}`,
          context: {
            priorVerdict: priorVerdict ?? "none",
            newVerdict: currentRec.verdict,
            expectedDeltaPct: currentRec.expectedDeltaPct,
            targetPrice: currentRec.targetPrice,
          },
        });
      }
      // Persist current verdict so the next eval's flip comparison is stable.
      (next as { lastRecommendationVerdict?: string | null }).lastRecommendationVerdict =
        currentRec.verdict;
    }
  } catch {
    // Recommendation compute must never block alert eval.
  }
}

/**
 * CF-RECOMMENDATION-FLIP-ALERT (2026-07-06): compute the current
 * recommendation for a holding using the same inputs as the
 * responseAssembly path. Extracted to a helper so the alert engine can
 * call it inline without pulling in the whole wire-shape composer.
 * Returns null when required inputs are missing.
 */
function computeActionSyncSafe(
  holding: PortfolioHolding,
): { verdict: string; reasoning: string; expectedDeltaPct: number | null; targetPrice: number | null } | null {
  const fmv = computePerUnitValue(holding);
  const predicted =
    typeof (holding as { predictedPrice?: number | null }).predictedPrice === "number"
      ? ((holding as { predictedPrice?: number | null }).predictedPrice as number)
      : null;
  if (fmv === null || predicted === null) return null;

  // Map confidence tier to numeric — mirrors confidenceScoreFromHolding
  // in responseAssembly (keep in sync). Any drift produces a real bug
  // (alerts fire when the wire doesn't render the same verdict).
  const tier = (holding as { estimateConfidence?: string | null }).estimateConfidence;
  const confidenceScore =
    tier === "estimate" ? 0.85 :
    tier === "rough"    ? 0.60 :
    tier === "ballpark" ? 0.35 :
    0.15;
  const costBasis =
    typeof holding.purchasePrice === "number" && holding.purchasePrice > 0
      ? holding.purchasePrice
      : null;

  const rec = computeAction({
    currentValue: fmv,
    predictedValue: predicted,
    confidenceScore,
    signalSource: null,
    costBasis,
  });
  return {
    verdict: rec.verdict,
    reasoning: rec.reasoning,
    expectedDeltaPct: rec.expectedDeltaPct,
    targetPrice: rec.targetPrice,
  };
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
    // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01): calibration measures how
    // close our OBSERVED price was to what the card actually sold for.
    // Scoring an estimate against a real sale would measure the fill, not the
    // prediction — the observed trail only.
    const history = observedPricePoints(doc.priceHistoryByHolding[entry.holdingId] ?? [])
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
      // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01): the weekly narrative
      // reports what the market did. An estimate re-anchoring is not a move,
      // so the observed trail only.
      const history = observedPricePoints(doc.priceHistoryByHolding[h.id] ?? []).sort((a, b) => a.at.localeCompare(b.at));
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
 * CF-PRO-SELLER-GATE (Drew, 2026-09-02). Resolve the paid-field entitlements
 * for this request, for the wire composer.
 *
 * Reads req.user, which requireSession attached, and answers through the ONE
 * authority — hasEntitlement() over the matrix, on the EFFECTIVE plan so a
 * comped owner (entitlementOverride) is entitled here exactly as they are at
 * every middleware gate. Reading `user.plan` directly instead would give
 * comped owners a UI-unlocked / wire-stripped half-state, which is the bug
 * effectivePlanFor exists to prevent.
 *
 * No req.user (a caller that reached a handler without requireSession) →
 * not entitled. Denying on absence keeps the failure mode "paid field
 * missing", never "paid field leaked to an unauthenticated caller".
 */
export function wireEntitlementsFor(req: Request): WireEntitlements {
  const user = req.user;
  if (!user) return { sellSignalEntitled: false };
  return {
    sellSignalEntitled: hasEntitlement(effectivePlanFor(user), "sellerIntelligence"),
  };
}

/**
 * CF-PAYMENTS-A: count helper exposed for the requireCapacity middleware.
 * Reads UserDoc and returns the current number of holdings keys; used to
 * enforce holdingsCap on POST /api/portfolio/holdings before the new row
 * is created.
 */
// CF-EBAY-IMPORT-REMATCH (Drew, 2026-07-18): apply a rematch's
// canonical (cardId, parallel, cardNumber, setName) to a single
// holding. Idempotent — same-values re-runs are no-ops. Marks
// `needsReview=true` when purchase price is set and the ratio to
// current FMV crosses the 20% sanity floor, so iOS surfaces the
// affected rows for user confirmation.
export async function applyRematchToHolding(
  userId: string,
  holdingId: string,
  patch: {
    cardId?: string | null;
    parallel?: string | null;
    cardNumber?: string | null;
    setName?: string | null;
  },
): Promise<boolean> {
  const doc = await readUserDoc(userId);
  const key = findHoldingKey(doc, holdingId);
  if (!key) return false;
  const h = doc.holdings[key];
  let changed = false;
  if (typeof patch.cardId === "string" && patch.cardId !== h.cardId) {
    (h as { cardId?: string }).cardId = patch.cardId;
    changed = true;
  }
  if (typeof patch.parallel === "string" && patch.parallel !== h.parallel) {
    (h as { parallel?: string }).parallel = patch.parallel;
    changed = true;
  }
  if (typeof patch.cardNumber === "string" && patch.cardNumber !== h.cardNumber) {
    (h as { cardNumber?: string }).cardNumber = patch.cardNumber;
    changed = true;
  }
  if (typeof patch.setName === "string" && patch.setName !== h.setName) {
    (h as { setName?: string }).setName = patch.setName;
    changed = true;
  }
  if (!changed) return false;
  (h as { lastUpdated?: string }).lastUpdated = new Date().toISOString();
  // Force a fresh reprice cycle on next surface hit by clearing
  // the persisted engine outputs. The next call to /holdings will
  // trigger repriceHoldingsForUser which computes with the corrected
  // identity.
  (h as { predictedPrice?: number | null }).predictedPrice = null;
  (h as { predictedPriceUpdatedAt?: string | null }).predictedPriceUpdatedAt = null;
  (h as { fairMarketValue?: number | null }).fairMarketValue = null;
  (h as { fmvRung?: string | null }).fmvRung = null;
  await writeUserDoc(userId, doc);
  return true;
}

export async function countHoldingsForUser(userId: string): Promise<number> {
  const doc = await readUserDoc(userId);
  return Object.keys(doc.holdings ?? {}).length;
}

export async function getHoldings(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const allItems = Object.values(doc.holdings);
  // CF-EBAY-REVIEW-QUEUE (2026-07-12): filter pending-review out of the
  // main /holdings response — those aren't real inventory yet. iOS reads
  // them separately via GET /erp/holdings/pending-review + user confirms
  // each one before it lands here. ?includePendingReview=true opts in
  // for admin/debug tools.
  const includePending = String(req.query.includePendingReview ?? "").trim() === "true";
  const items = includePending
    ? allItems
    : allItems.filter((h) => (h as any).cardStatus !== "pending-review");
  const holdings = composePortfolioListResponse(items, undefined, wireEntitlementsFor(req));
  res.json({ userId: auth.userId, count: holdings.length, holdings });
}

/**
 * CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). Allocation / risk / quality
 * analysis of the caller's own portfolio.
 *
 * Computed SERVER-SIDE so web and iOS render the same numbers by construction.
 * The first cut of this shipped as a Swift service; adding a TypeScript copy
 * for the web dashboard would have been two implementations of one rule, and
 * they drift — the same defect this codebase was bitten by three separate times
 * on 2026-08-17 alone. So the judgement lives once, here.
 *
 * Reads holdings exactly the way getHoldings does, pending-review filter
 * included, so the breakdown can never describe a different inventory than the
 * list the user is looking at.
 */
export async function getPortfolioBreakdown(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const items = Object.values(doc.holdings).filter(
    (h) => (h as any).cardStatus !== "pending-review",
  );
  const holdings = composePortfolioListResponse(items, undefined, wireEntitlementsFor(req));
  const { analyzePortfolio, analyzeWithCustomTiers } = await import("./portfolioAnalytics.service.js");

  // CF-CUSTOM-TIERS (2026-08-17): when the user has defined their own buckets,
  // the allocation is computed against THOSE. Absent → the HobbyIQ defaults, so
  // this is purely additive for anyone who never opens the editor.
  const custom = (doc as { portfolioTiers?: unknown[] }).portfolioTiers;
  const result = Array.isArray(custom) && custom.length > 0
    ? analyzeWithCustomTiers(holdings as never[], custom as never[])
    : analyzePortfolio(holdings as never[]);

  res.json({
    userId: auth.userId,
    analyzedAt: new Date().toISOString(),
    usingCustomTiers: Array.isArray(custom) && custom.length > 0,
    ...result,
  });
}

/** CF-CUSTOM-TIERS: read the caller's tier definitions. Returns the HobbyIQ
 *  defaults when none are set, so the editor always has something to open
 *  against rather than a blank page. */
export async function getPortfolioTiers(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const { defaultTiers } = await import("./portfolioCustomTiers.js");
  const custom = (doc as { portfolioTiers?: unknown[] }).portfolioTiers;
  const isCustom = Array.isArray(custom) && custom.length > 0;
  res.json({ tiers: isCustom ? custom : defaultTiers(), isCustom });
}

/** CF-CUSTOM-TIERS: replace the caller's tier definitions.
 *
 *  Validation REJECTS rather than repairs where a repair would change meaning —
 *  a mistyped target comes back as an error instead of being silently
 *  renormalised into something the user did not ask for. Sending an empty array
 *  clears back to the HobbyIQ defaults. */
export async function putPortfolioTiers(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { validateTiers } = await import("./portfolioCustomTiers.js");

  const body = (req.body ?? {}) as { tiers?: unknown };
  if (Array.isArray(body.tiers) && body.tiers.length === 0) {
    const doc = await readUserDoc(auth.userId);
    delete (doc as { portfolioTiers?: unknown }).portfolioTiers;
    await writeUserDoc(auth.userId, doc);
    const { defaultTiers } = await import("./portfolioCustomTiers.js");
    return res.json({ tiers: defaultTiers(), isCustom: false });
  }

  const parsed = validateTiers(body.tiers);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });

  const doc = await readUserDoc(auth.userId);
  (doc as { portfolioTiers?: unknown }).portfolioTiers = parsed.tiers;
  await writeUserDoc(auth.userId, doc);
  return res.json({ tiers: parsed.tiers, isCustom: true });
}

/**
 * CF-EBAY-REVIEW-QUEUE (2026-07-12): return the auto-created holdings
 * that are waiting for user confirmation. Same wire shape as /holdings —
 * iOS decodes the same PortfolioHolding shape and renders the review
 * queue UX with parseConfidence + browseAspects + photos in view.
 */
export async function getPendingReviewHoldings(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const items = Object.values(doc.holdings).filter(
    (h) => (h as any).cardStatus === "pending-review",
  );
  const holdings = composePortfolioListResponse(items, undefined, wireEntitlementsFor(req));
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
  // CF-PORTFOLIO-DAY-CHANGE (Drew, 2026-09-04): "the portfolio bar should show
  // the day change in $ and % with colour". The day change is a DIFFERENCE
  // BETWEEN TWO TOTALS, and the second one has to come from somewhere honest.
  //
  // It comes from `priceHistoryByHolding` -- the trail every reprice already
  // appends to and the reaper already bounds. Nothing here computes a price:
  // the previous close is the sum of each holding's LAST STORED POINT BEFORE
  // the most recent UTC midnight, which is a fact already on disk.
  //
  // WHY THESE FIELDS AND NOT JUST A NUMBER. A day change with no coverage is
  // unreadable: a portfolio where 3 of 43 holdings have a prior point produces
  // a "day change" dominated by the 40 that contributed no change at all, and
  // a bare "+$12.40" would present that as a measurement of the whole
  // portfolio. So the coverage travels WITH the number, and the UI is expected
  // to say so when it is not 100%.
  //
  // NULL vs ZERO, the invariant this repo keeps everywhere: when NO holding
  // has a prior point, `dayChangeValue` is null -- not 0. Zero is a measured
  // flat day; null is "we have no yesterday". The bar renders an em dash.
  /** Sum of each holding's last stored value strictly before
   *  `previousCloseAt`, plus the current display value of holdings with no
   *  prior point. Null when no holding has a prior point at all. */
  previousCloseValue: number | null;
  /** The boundary the previous close was taken at: the most recent UTC
   *  midnight at or before `now`, ISO-8601. Null when there is no prior point.
   *  UTC because every other day key in this backend is
   *  `toISOString().slice(0,10)` -- there is no ET day helper to be consistent
   *  with, and inventing one here would put the bar on a different calendar
   *  from the rest of the app. */
  previousCloseAt: string | null;
  /** displayableTotalValue minus previousCloseValue. Null when no prior. */
  dayChangeValue: number | null;
  /** The same move as a fraction of the previous close (0.0123 = +1.23%).
   *  Null when there is no prior point or the previous close is not positive --
   *  a percentage of zero is not a number we get to print. */
  dayChangePct: number | null;
  /** How much of the portfolio the day change actually measures. A holding
   *  with no point before the boundary contributes its CURRENT value to the
   *  previous close, i.e. zero change, so it drags the move toward flat -- the
   *  UI must be able to say "12 of 43 with prior". */
  dayChangeCoverage: { holdingsWithPrior: number; holdingsTotal: number };
}

/** The trail shape the day-change math needs: holding id to stored points.
 *  Structurally identical to `UserDoc["priceHistoryByHolding"]`, declared
 *  loosely so callers (and tests) can pass a plain literal. */
export type PriceTrailsByHolding = Record<
  string,
  readonly { at: string; value: number; valuationStatus?: string }[]
>;

/**
 * The most recent UTC midnight at or before `now`, as an ISO-8601 instant.
 * Exported for the test -- the boundary IS the contract, and a test that
 * recomputes it locally would pass against a wrong one.
 */
export function previousCloseBoundary(now: Date | number = Date.now()): string {
  const d = new Date(now);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * CF-PORTFOLIO-DAY-CHANGE (2026-09-04). The previous close, from persisted
 * history only.
 *
 * For each holding that counts toward the headline, take the LAST stored price
 * point whose `at` is strictly before the boundary and use its value; a
 * holding with no such point contributes its CURRENT display value, so it
 * lands as zero change rather than as a phantom gain or loss of its whole
 * worth. The count of holdings that did have a prior point rides along.
 *
 * WHY OBSERVED-ONLY POINTS. `observedPricePoints` is the same filter every
 * other trail reader uses. An estimated point drifts as the engine re-anchors
 * (CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK), so differencing against one measures
 * the engine's re-anchoring, not the market. A holding whose only prior points
 * are estimated therefore counts as HAVING NO PRIOR -- it is excluded from
 * coverage and contributes no change.
 *
 * PER-UNIT vs TOTAL. Trail points are written per-holding at the value the
 * reprice produced for that holding; the current side of the comparison is
 * `computeDisplayValue`, which is a TOTAL (per-unit times quantity). So the
 * stored point is scaled by the same quantity before differencing -- otherwise
 * a quantity-3 holding would show a two-thirds "drop" every day it was priced.
 *
 * THIS COMPUTES NO PRICE. It reads `computeDisplayValue` (already-persisted
 * fields) and the stored trail. No engine call, no reprice, no network.
 */
export function computeDayChange(
  items: PortfolioHolding[],
  trails: PriceTrailsByHolding | undefined,
  displayableTotalValue: number,
  now: Date | number = Date.now(),
): {
  previousCloseValue: number | null;
  previousCloseAt: string | null;
  dayChangeValue: number | null;
  dayChangePct: number | null;
  dayChangeCoverage: { holdingsWithPrior: number; holdingsTotal: number };
} {
  const boundary = previousCloseBoundary(now);
  let previousClose = 0;
  let holdingsWithPrior = 0;
  let holdingsTotal = 0;

  for (const h of items) {
    const status = String((h as any).cardStatus ?? (h as any).statusCategory ?? "")
      .trim()
      .toLowerCase();
    // The same exclusion the totals use -- a sold card is not in the portfolio,
    // so it must not be in either side of the day change.
    if (EXCLUDED_STATUS.has(status)) continue;
    holdingsTotal += 1;

    const current = computeDisplayValue(h);
    const points = observedPricePoints(trails?.[h.id] ?? []);
    // The trail is appended in order, but a repair or an out-of-order write
    // must not be able to pick the wrong "last" -- take the max `at` under the
    // boundary rather than trusting array position.
    let priorValue: number | null = null;
    let priorAt = "";
    for (const p of points) {
      if (typeof p?.at !== "string" || p.at >= boundary) continue;
      if (typeof p.value !== "number" || !Number.isFinite(p.value)) continue;
      if (priorValue === null || p.at > priorAt) {
        priorValue = p.value;
        priorAt = p.at;
      }
    }

    if (priorValue === null) {
      // No yesterday for this holding: it contributes its current value, i.e.
      // no change. Never its cost, never zero -- either would manufacture a
      // move out of a holding we know nothing new about.
      previousClose += current;
      continue;
    }
    holdingsWithPrior += 1;
    const qty = Math.max(1, toNumber(h.quantity, 1));
    previousClose += priorValue * qty;
  }

  if (holdingsWithPrior === 0) {
    // Nothing to difference against. Null, not zero -- see the field docs.
    return {
      previousCloseValue: null,
      previousCloseAt: null,
      dayChangeValue: null,
      dayChangePct: null,
      dayChangeCoverage: { holdingsWithPrior: 0, holdingsTotal },
    };
  }

  const previousCloseValue = round2(previousClose);
  const dayChangeValue = round2(displayableTotalValue - previousCloseValue);
  return {
    previousCloseValue,
    previousCloseAt: boundary,
    dayChangeValue,
    dayChangePct:
      previousCloseValue > 0
        ? Math.round((dayChangeValue / previousCloseValue) * 10000) / 10000
        : null,
    dayChangeCoverage: { holdingsWithPrior, holdingsTotal },
  };
}

// CF-EBAY-REVIEW-QUEUE (2026-07-12): "pending-review" is the eBay-auto
// commit-gate status. Auto-created holdings start here; the user promotes
// them to "active" via POST /erp/holdings/:id/confirm after reviewing the
// parser+Browse extraction. Excluded from all portfolio value / P&L /
// reprice paths until confirmed.
const EXCLUDED_STATUS = new Set([
  "sold",
  "archived",
  "watchlist",
  "tradepending",
  "trade pending",
  "pending-review",
]);

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function summarizeHoldings(
  items: PortfolioHolding[],
  /** CF-PORTFOLIO-DAY-CHANGE (2026-09-04): the user doc's stored price trails.
   *  OPTIONAL, and its absence is not an error -- every existing caller
   *  (health, ERP, tests) summarises holdings it holds in hand with no doc
   *  around them, and they keep working: with no trails there is no prior
   *  point, so the day-change fields come back null and nothing else moves.
   *  The day change lives HERE rather than in the route because this is the
   *  canonical aggregator (see the note below) -- a second site summing
   *  portfolio totals is exactly the drift this function exists to prevent. */
  trails?: PriceTrailsByHolding,
  now: Date | number = Date.now(),
): PortfolioSummary {
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
    // CF-PORTFOLIO-DAY-CHANGE -- differenced against the SAME headline total
    // the rest of this object reports, so the bar can never show a day change
    // that does not reconcile with the value printed beside it.
    ...computeDayChange(items, trails, round2(headlineTotal), now),
  };
}

// GET /api/portfolio  — items + summary in one payload for the iOS dashboard.
export async function getPortfolioWithSummary(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const doc = await readUserDoc(auth.userId);
  const rawItems = Object.values(doc.holdings);
  // CF-PORTFOLIO-DAY-CHANGE (2026-09-04): the stored trails come off the doc
  // ALREADY IN HAND -- no extra Cosmos read, and emphatically no reprice. This
  // endpoint has never computed a price and still does not; the previous close
  // is read out of history that the reprice job wrote earlier.
  const summary = summarizeHoldings(rawItems, doc.priceHistoryByHolding);
  // CF-INVENTORY-CATALOG-IMAGE (2026-07-05): pre-resolve catalog card
  // images for every holding that has a resolved cardId. Bounded
  // concurrency 8 — meta cache is warm for common cards, so the fanout
  // is effectively free after the first user in a session. Silent
  // no-throw per-card: a single lookup failure leaves that holding's
  // catalogImageUrl unset (iOS placeholder), doesn't break the payload.
  const uniqueCardIds = Array.from(
    new Set(
      rawItems
        .map((h) => h.cardId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const catalogImageByCardId = new Map<string, string>();
  if (uniqueCardIds.length > 0) {
    const CONCURRENCY = 8;
    const queue = [...uniqueCardIds];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const cardId = queue.shift();
        if (!cardId) return;
        try {
          const url = await resolveCatalogImageUrl(req, cardId);
          if (url) catalogImageByCardId.set(cardId, url);
        } catch {
          /* silent — falls back to iOS placeholder */
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B: route through anti-corruption
  // layer; explicit wire-shape per contract_freeze_v1 §1.3. summary still
  // reads off raw holdings (uses Phase A compute-on-read helpers).
  const items = composePortfolioListResponse(rawItems, catalogImageByCardId, wireEntitlementsFor(req));
  // CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): the refresh is now asynchronous,
  // so this payload can legitimately be answered while a reprice is still in
  // flight. Values here are ALWAYS the last persisted ones — this endpoint
  // has never computed a price and still doesn't. Say so explicitly rather
  // than let the client present possibly-superseded numbers as fresh:
  // `valuation.repricing` is true while a run is working on this user's
  // holdings, and `oldestValuationAt` is the age of the stalest row so the UI
  // can show "as of …" instead of implying now.
  // The marker comes off the doc already in hand — no extra Cosmos read. This
  // endpoint still computes NO price; it only reports how old the stored ones
  // are. (CF-PORTFOLIO-FRESH-ON-OPEN, 2026-09-02.)
  const valuation = buildValuationFreshness(
    auth.userId,
    rawItems,
    Date.now(),
    doc.lastRepriceDispatchAt ?? null,
  );
  res.json({ success: true, userId: auth.userId, items, summary, valuation });
}

/**
 * CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): freshness envelope for the
 * portfolio read.
 *
 * Serving stored values fast is only safe if the client can tell the user
 * what they're looking at. This reports (a) whether a reprice is running
 * right now, and (b) how old the stalest holding's valuation is. It reads
 * `lastUpdated`, the same field the reprice ordering uses.
 */
export function buildValuationFreshness(
  userId: string,
  holdings: PortfolioHolding[],
  now = Date.now(),
  persistedDispatchAt?: number | null,
): {
  repricing: boolean;
  oldestValuationAt: string | null;
  oldestValuationAgeMs: number | null;
  newestValuationAt: string | null;
  lastRepriceDispatchAt: string | null;
} {
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  for (const h of holdings) {
    const lu = (h as any).lastUpdated;
    const t = typeof lu === "string" ? Date.parse(lu) : typeof lu === "number" ? lu : NaN;
    if (!Number.isFinite(t) || t <= 0) continue;
    if (oldestMs === null || t < oldestMs) oldestMs = t;
    if (newestMs === null || t > newestMs) newestMs = t;
  }
  return {
    // CF-PORTFOLIO-FRESH-ON-OPEN (2026-09-02): `repricing` is still only what
    // THIS worker can see. A run dispatched on the other instance reads false
    // here — which is why the client also branches on its own dispatch, and
    // why the durable marker below is reported separately: it is the one
    // freshness fact both workers agree on.
    repricing: repriceJobs.isRunning(userId, now),
    oldestValuationAt: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    oldestValuationAgeMs: oldestMs === null ? null : Math.max(0, now - oldestMs),
    /**
     * lastUpdated of the FRESHEST holding. The "as of" the UI shows: it is
     * the honest answer to "how current is what I'm looking at" for the rows
     * that did get repriced, where the oldest is the honest answer to "is
     * anything here stale". Both are reported; neither is derived from the
     * other.
     */
    newestValuationAt: newestMs === null ? null : new Date(newestMs).toISOString(),
    /**
     * When a reprice was last DISPATCHED for this user, from the durable
     * marker — visible across instances, unlike `repricing`.
     */
    lastRepriceDispatchAt:
      typeof persistedDispatchAt === "number" && Number.isFinite(persistedDispatchAt) && persistedDispatchAt > 0
        ? new Date(persistedDispatchAt).toISOString()
        : null,
  };
}

/**
 * CF-PORTFOLIO-OPPORTUNITIES (2026-07-06, Drew):
 * GET /api/portfolio/opportunities
 *
 * The pull-side counterpart to the recommendation-flip alert push
 * surface (PR #296). Filters the user's holdings by action verdict
 * and returns three tab-ready groups iOS renders as the "what should
 * I do TODAY" screen:
 *
 *   {
 *     sellNow: [...],   // verdict === "SELL_NOW", sorted by urgency+delta magnitude
 *     hold:    [...],   // verdict === "HOLD",     sorted by delta magnitude (biggest gain first)
 *     listNow: [...],   // verdict === "LIST",     urgency==="high" only, sorted by delta
 *     counts:  { sellNow, hold, listNow, listAll, insufficientData }
 *   }
 *
 * Uses composeHoldingWireShape (which already runs computeAction on
 * every holding) so the shape of each row is identical to what /portfolio
 * emits — iOS can reuse the same row renderer.
 *
 * `listAll` in the counts includes MEDIUM-urgency LIST verdicts too;
 * they're excluded from the `listNow` array because they aren't
 * time-sensitive enough to be a "today" surface (they're just the
 * normal fair-value listing tier). iOS can render a "listAll" tab if
 * you want the full firehose.
 */
export async function getPortfolioOpportunities(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const doc = await readUserDoc(auth.userId);
  const rawItems = Object.values(doc.holdings);
  // Reuse the compose helper — same wire shape as /portfolio, so
  // recommendation is populated on every row via the same computeAction.
  const uniqueCardIds = Array.from(
    new Set(
      rawItems
        .map((h) => h.cardId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const catalogImageByCardId = new Map<string, string>();
  if (uniqueCardIds.length > 0) {
    const CONCURRENCY = 8;
    const queue = [...uniqueCardIds];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const cardId = queue.shift();
        if (!cardId) return;
        try {
          const { resolveCatalogImageUrl } = await import(
            "../compiq/cardImageResolver.js"
          );
          const url = await resolveCatalogImageUrl(req, cardId);
          if (url) catalogImageByCardId.set(cardId, url);
        } catch {
          /* silent — falls back to iOS placeholder */
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }
  const wires = composePortfolioListResponse(rawItems, catalogImageByCardId, wireEntitlementsFor(req));

  const sellNow: typeof wires = [];
  const hold: typeof wires = [];
  const listNowHigh: typeof wires = [];
  let listAll = 0;
  let insufficientData = 0;

  for (const wire of wires) {
    const rec = (wire as { actionRecommendation?: {
      verdict?: string;
      urgency?: string | null;
    } | null }).actionRecommendation;
    if (!rec) {
      insufficientData++;
      continue;
    }
    switch (rec.verdict) {
      case "SELL_NOW":
        sellNow.push(wire);
        break;
      case "HOLD":
        hold.push(wire);
        break;
      case "LIST":
        listAll++;
        if (rec.urgency === "high") {
          listNowHigh.push(wire);
        }
        break;
      case "INSUFFICIENT_DATA":
      default:
        insufficientData++;
        break;
    }
  }

  // Sort each group by (urgency rank descending, expectedDeltaPct
  // magnitude descending). Higher urgency + bigger predicted move
  // rises to the top of the list.
  const urgencyRank = (u: string | null | undefined): number => {
    if (u === "high") return 3;
    if (u === "medium") return 2;
    if (u === "low") return 1;
    return 0;
  };
  const sortByUrgencyThenDelta = (a: (typeof wires)[number], b: (typeof wires)[number]) => {
    const ar = (a as { actionRecommendation?: { urgency?: string | null; expectedDeltaPct?: number | null } | null }).actionRecommendation;
    const br = (b as { actionRecommendation?: { urgency?: string | null; expectedDeltaPct?: number | null } | null }).actionRecommendation;
    const urgencyDiff = urgencyRank(br?.urgency) - urgencyRank(ar?.urgency);
    if (urgencyDiff !== 0) return urgencyDiff;
    return Math.abs(br?.expectedDeltaPct ?? 0) - Math.abs(ar?.expectedDeltaPct ?? 0);
  };
  sellNow.sort(sortByUrgencyThenDelta);
  hold.sort(sortByUrgencyThenDelta);
  listNowHigh.sort(sortByUrgencyThenDelta);

  res.json({
    success: true,
    userId: auth.userId,
    sellNow,
    hold,
    listNow: listNowHigh,
    counts: {
      sellNow: sellNow.length,
      hold: hold.length,
      listNow: listNowHigh.length,
      listAll,
      insufficientData,
    },
  });
}

/**
 * CF-GRADING-TIER-CATALOG (2026-07-06):
 * GET /api/portfolio/grading-tiers
 *
 * Returns the current catalog of grader service tiers + prices. iOS
 * renders as a dropdown on the Mark-as-Graded sheet. Response is
 * cacheable client-side for the session — the catalog only changes
 * when we deploy a pricing update.
 */
export async function getGradingTiers(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  res.json({
    success: true,
    tiers: GRADING_TIERS,
    cachedUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
}

export async function getHoldingPriceHistory(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  // CF-D1: case-insensitive lookup. priceHistoryByHolding is keyed by the
  // same id as holdings (one-to-one), so we resolve via holdings first.
  const canonical = findHoldingKey(doc, id);
  if (!canonical) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  const stored = doc.priceHistoryByHolding[canonical] ?? [];
  // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01). The shipped clients (iOS
  // PortfolioPricePoint, apps/web HoldingPricePoint) decode { at, value,
  // source } and plot every point as a real observation, so the DEFAULT stays
  // exactly what they have always received: the observed trail. Estimated
  // points are opt-in — `?includeEstimated=true` — for the drift view.
  const includeEstimated = String(req.query.includeEstimated ?? "").toLowerCase() === "true";
  const points = includeEstimated ? stored : observedPricePoints(stored);
  res.json({ holdingId: canonical, count: points.length, points });
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
 *   - `cardId` alone (covers identify-then-save flows where
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
    typeof holding.cardId === "string"
      ? holding.cardId.trim()
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
        "Provide non-empty playerName plus (cardYear AND product), or alternatively a non-empty cardId.",
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
  // CF-INVENTORY-RAW-CLEAR (2026-07-12): same Raw normalization iOS uses
  // on PATCH. On ADD, a "Raw" create sends gradeCompany in one of the
  // clear-signal shapes; normalize the signal but DO NOT drop fields —
  // the "add-with-explicit-null-cert" contract (W4 wire) uses null to
  // mean "explicit absence" and must round-trip through GET as null.
  // Only the PATCH path drops (there we're actively clearing existing
  // values on the persisted holding).
  normalizeRawGradeClearSignal(incoming);
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
  // CF-A-SUPPLIED-SLUG-MUST-BE-A-CATALOG-ROW (D12a): a slug the caller pinned
  // (the card page, the picker) is accepted only when the catalog holds it.
  await gateSuppliedSlug(holding, {
    source: "portfolioStore.addHolding",
    userId: auth.userId,
    holdingId: holding.id,
    previous: null,
  });
  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: the second identity (an hiq cardId —
  // the card page's URL id, which the web sends under the legacy name
  // cardsightCardId; hoisted here by the same data-boundary rule the read
  // path applies, so the resolver sees it) goes through the same resolver.
  normalizeHoldingCatalogId(holding as unknown as Record<string, unknown>);
  await resolveHiqCardIdToCatalogRow(holding, {
    source: "portfolioStore.addHolding",
    userId: auth.userId,
    holdingId: holding.id,
  });

  // CF-CATALOG-AUTO-SEED-ON-ADD (Drew, 2026-08-04). "When they add
  // cards, they search within the catalog and then the comps fall
  // into it too." — this is the seed step. Every add-card call routes
  // through the catalog matcher with source="user-verified". If a
  // canonical entry exists, the matcher returns "found" and we use
  // its slug. If nothing matches, the matcher seeds a fresh row and
  // returns "seeded". Either way the holding's cardId + hobbyiqCardId
  // point at a canonical catalog row from that moment on.
  //
  // Wrapped in try/catch so a Cosmos hiccup can't block add-card.
  // Silent-safe: on any failure the holding keeps whatever was pinned;
  // user still gets their card added.
  try {
    if (holding.playerName && holding.cardYear && holding.cardNumber) {
      const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
      // holding is a permissive shape at ingest — some fields (sport,
      // printRun) aren't on the strict PortfolioHolding type but may
      // land here from vendor payloads. Narrow via unknown-cast.
      const extras = holding as unknown as { sport?: unknown; printRun?: unknown };
      const matchResult = await canonicalize({
        sport: typeof extras.sport === "string" && extras.sport ? extras.sport : "baseball",
        year: holding.cardYear,
        setName: String(holding.product ?? holding.setName ?? ""),
        cardNumber: String(holding.cardNumber),
        parallel: holding.parallel ?? null,
        isAuto: holding.isAuto === true,
        printRun: typeof extras.printRun === "number" ? extras.printRun : null,
        player: holding.playerName,
        source: "user-verified",
      });
      // CF-ADD-KEEPS-THE-SLUG-YOU-VIEWED (2026-08-22). This adopted ANY match,
      // at any confidence, over an identity the caller had already pinned.
      //
      // Live case: adding Theo Gillen 2024 Bowman Draft #CPA-TG Blue Refractor
      // /150 from its own card page. The page's URL carried the exact canonical
      // slug — ...:bowman-draft:cpa-tg:blue-refractor:auto:num-150 — and the
      // matcher answered ...:bowman-CHROME:... at fuzzy-parallel / 0.72. That
      // won. The card's only comp, the $729 sale, is tagged bowman-draft, so
      // the holding landed on a slug with zero comps, priced $662 estimated
      // instead of $729 observed, and the comp looked like it had vanished.
      //
      // A pinned hiq: slug is the strongest identity statement available — the
      // user was looking at that exact card. A fuzzy re-derivation must not
      // silently move them to a different setKey. Same rule #1177 established
      // for FMV overrides: a low-confidence result may not overwrite a
      // high-confidence one.
      //
      // Still adopted when the incoming id is NOT already canonical, which is
      // the case this block was written for.
      //
      // CF-ONE-PIN-GATE-FOR-BOTH-FIELDS (D12a): the same gate applies when
      // NOTHING is pinned. A 0.72 is a proposal, not the card. See
      // applyCatalogMatchToHolding.
      const pin = await applyCatalogMatchToHolding(holding, matchResult, {
        source: "portfolioStore.addHolding",
        userId: auth.userId,
        holdingId: holding.id,
        cardIdRule: "fill",
      });
      // CF-VERIFIED-IS-CHECKLIST-BACKED (Drew, 2026-08-30): a pin onto a
      // checklist-backed row is VERIFIED without a trip through Edit.
      if (pin.pinned) {
        const { stampChecklistBackedIdentity, readCatalogRowSource } = await import("./checklistBackedIdentity.js");
        await stampChecklistBackedIdentity(holding as unknown as Record<string, unknown>, readCatalogRowSource, { via: "portfolioStore.addHolding" });
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "catalog_auto_seed_error",
      source: "portfolioStore.addHolding",
      userId: auth.userId,
      error: (err as Error)?.message ?? String(err),
    }));
  }
  // CF-PORTFOLIO-DETAIL-SLUG (Drew, 2026-07-26). Populate the canonical
  // hobbyiqCardId at add-time so iOS's tap-into-card flow can hit
  // /api/compiq/card-detail with holding.hobbyiqCardId directly. Null
  // when identity is insufficient (iOS falls back to legacy tap).
  //
  // CF-A-MINTED-SLUG-NEVER-REPLACES-A-PIN (D12a): this ran FIRST and
  // overwrote whatever the caller pinned with a free-text guess. It now
  // runs after the catalog has answered, fills only an absent slug, and
  // only with a slug the catalog holds.
  holding = await fillDerivedSlugFromCatalog(holding, { source: "portfolioStore.addHolding" });

  // CF-GRADE-COMPANY-WITHOUT-VALUE: run before the identity gate so the
  // persisted shape is already coherent.
  clearGradeCompanyWithoutValue(holding as unknown as Record<string, unknown>, {
    userId: auth.userId,
    holdingId: holding.id,
  });

  // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION: gate must run AFTER
  // normalizeR1CardsightCardId (which can hoist cardId from
  // legacy field shapes) AND AFTER populateCardsightGradeId, so the
  // identity check sees the final resolved cardId. Reject
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
  // CF-ADD-CARD-VERIFIED (Drew, 2026-08-04). User manually adding a
  // card via ADD CARD is a first-class identity confirmation — they
  // typed the player, year, set, cardNumber, grade themselves. Stamp
  // identityVerified so the "Unverified" filter/badge clears
  // immediately (same treatment as review-queue Approve).
  if (holding.cardId && (holding as any).identityVerified !== true) {
    (holding as any).identityVerified = true;
    (holding as any).identityVerifiedAt = now;
    (holding as any).identityVerifiedBy = "add-card";
  }
  doc.holdings[holding.id] = { ...doc.holdings[holding.id], ...holding };

  try {
    await autoPriceHolding(doc, doc.holdings[holding.id], undefined, "add", auth.userId);
  } catch {
    // Keep the saved holding even if live pricing fails.
  }

  // CF-USER-EBAY-PURCHASE-AUTO-COMP (Drew, 2026-08-08). When a user adds a
  // card via the Add Card modal with an eBay-sourced purchase, that
  // transaction IS real market data — a confirmed sold-on-eBay price for
  // that identity + grade combo. Write it to sold_comps so it shows up
  // under the card's comps view alongside vendor-ingested sales. Prior
  // behavior missed this: only the automated eBay bulk-import path
  // (ebayImportRematch) called recordSoldComp; manual adds with eBay
  // source were dropped.
  //
  // Gate: purchaseSource must start with "ebay" (case-insensitive) AND
  // purchasePrice > 0 AND purchaseDate present. Silent-safe: any Cosmos
  // failure leaves the holding intact.
  await emitUserEbayPurchaseComp(doc.holdings[holding.id], auth.userId, doc).catch((err) => {
    console.warn(JSON.stringify({
      event: "user_ebay_purchase_comp_error",
      source: "portfolioStore.addHolding",
      userId: auth.userId,
      holdingId: holding.id,
      error: (err as Error)?.message ?? String(err),
    }));
  });

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

  // CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE (2026-06-30): enroll the new
  // holding in CH's price-tracking feed so the delta-poll worker (PR
  // #211) sees future sales for this card. Fire-and-forget: a failure

  res.status(201).json({ message: "Holding saved", id: holding.id });
}

export async function getHoldingById(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  // CF-D1: case-insensitive lookup.
  const holding = getHolding(doc, id);
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B: route through anti-corruption
  // layer; this endpoint runs no estimate, so β fields are null here too.
  // iOS detail-view β richness comes from POST /api/compiq/*.
  res.json(composeHoldingWireShape(holding, undefined, wireEntitlementsFor(req)));
}

export async function updateHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const rawId = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  // CF-D1: case-insensitive lookup; mutate via the canonical stored key
  // so spread + writeback hit the same slot.
  const id = findHoldingKey(doc, rawId);
  if (!id) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  const previous = doc.holdings[id];
  const cleanBody = stripDeprecatedHoldingKeys(
    (req.body ?? {}) as Record<string, unknown>,
    res,
  );
  normalizeRawGradeClearSignal(cleanBody);
  let next = { ...doc.holdings[id], ...(cleanBody as Partial<PortfolioHolding>), id };
  dropClearedGradeFields(next);
  next = normalizeR1CardsightCardId(
    next,
    id,
    "portfolioStore.service.updateHolding",
  );
  next = await populateCardsightGradeId(next);
  // CF-A-SUPPLIED-SLUG-MUST-BE-A-CATALOG-ROW (D12a): a hobbyiqCardId in the
  // body is accepted only when the catalog holds it; otherwise the stored
  // one stands.
  if ("hobbyiqCardId" in (cleanBody as Record<string, unknown>)) {
    await gateSuppliedSlug(next, {
      source: "portfolioStore.updateHolding",
      userId: auth.userId,
      holdingId: id,
      previous: String((previous as { hobbyiqCardId?: string | null }).hobbyiqCardId ?? "").trim() || null,
    });
  }
  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: a cardId the body supplies (under
  // either name) is written as the catalog's row, the same way addHolding
  // writes it. A body that does not touch it does not touch it.
  if ("cardId" in (cleanBody as Record<string, unknown>) || "cardsightCardId" in (cleanBody as Record<string, unknown>)) {
    normalizeHoldingCatalogId(next as unknown as Record<string, unknown>);
    await resolveHiqCardIdToCatalogRow(next, {
      source: "portfolioStore.updateHolding",
      userId: auth.userId,
      holdingId: id,
    });
  }
  // CF-A-MINTED-SLUG-NEVER-REPLACES-A-PIN (D12a). This used to recompute the
  // slug from free text on EVERY update and overwrite the pinned one, before
  // the catalog was even asked. Identity edits now propagate through the
  // catalog resolve below; the derivation fills only an absent slug, after,
  // and only with a slug the catalog holds.

  // CF-CATALOG-RESOLVE-ON-UPDATE (Drew, 2026-08-08). Same catalog-first
  // resolution addHolding does — but on EDIT. Fixes the Verlander-class
  // bug where a user's typo'd setName ("Bowman Chrome Draft Picks &
  // Prospects", which doesn't exist) computes a slug at :bowman-chrome:
  // even though the real catalog entry is at :bowman-draft:. Post-fix,
  // any edit to a holding routes the identity through canonicalize()
  // which uses fuzzy match on (year, cardNumber, isAuto, parallel-token)
  // to find the RIGHT catalog entry regardless of setName drift, then
  // rebinds hobbyiqCardId + cardId to the catalog's canonical slug.
  //
  // Wrapped in try/catch — a Cosmos hiccup shouldn't block edits.
  // Silent-safe: on any failure the stored slug is what sticks; user
  // still gets their edit persisted.
  try {
    if (next.playerName && next.cardYear && next.cardNumber) {
      const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
      const extras = next as unknown as { sport?: unknown; printRun?: unknown };
      const matchResult = await canonicalize({
        sport: typeof extras.sport === "string" && extras.sport ? extras.sport : "baseball",
        year: next.cardYear,
        setName: String(next.product ?? next.setName ?? ""),
        cardNumber: String(next.cardNumber),
        parallel: next.parallel ?? null,
        isAuto: next.isAuto === true,
        printRun: typeof extras.printRun === "number" ? extras.printRun : null,
        player: next.playerName,
        source: "user-verified",
      });
      // CF-ONE-PIN-GATE-EVERYWHERE (Drew, 2026-08-23). cardId was pinned on
      // `found` alone, with no confidence test — while BOTH deliberate pin
      // sites require >= 0.9 (ebayAutoHolding.service.ts:195,
      // ebayReviewQueue.service.ts:389). canonicalize returns found:true at
      // confidence 0.72 for matchedBy "fuzzy-parallel", so ANY patch of a
      // holding — changing only its notes — silently pinned a 0.72 match.
      //
      // Measured on holding aff3236a (2025 Bowman Draft Gold #CPA-MWI,
      // $301.43): its parked match is exactly that shape. The machine has
      // been accepting on the user's behalf, invisibly, at a confidence the
      // rest of the system considers too weak to trust.
      //
      // CF-ONE-PIN-GATE-FOR-BOTH-FIELDS (D12a): hobbyiqCardId was left
      // UNGATED here on the theory that nothing prices off it alone.
      // priceFromOurPool does. Same gate, both fields.
      const pin = await applyCatalogMatchToHolding(next, matchResult, {
        source: "portfolioStore.updateHolding",
        userId: auth.userId,
        holdingId: id,
        cardIdRule: "rebind",
      });
      // CF-VERIFIED-IS-CHECKLIST-BACKED (Drew, 2026-08-30).
      if (pin.pinned) {
        const { stampChecklistBackedIdentity, readCatalogRowSource } = await import("./checklistBackedIdentity.js");
        await stampChecklistBackedIdentity(next as unknown as Record<string, unknown>, readCatalogRowSource, { via: "portfolioStore.updateHolding" });
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "catalog_resolve_on_update_error",
      source: "portfolioStore.updateHolding",
      userId: auth.userId,
      holdingId: id,
      error: (err as Error)?.message ?? String(err),
    }));
  }
  // CF-PORTFOLIO-DETAIL-SLUG: fill a slug only when the merged holding still
  // has none (legacy rows, catalog unavailable), and only with a slug the
  // catalog holds. A pinned slug is kept even when an identity field changed
  // and the catalog could not confidently re-place the card; that
  // disagreement is logged by the resolve above, not silently resolved by a
  // free-text guess.
  next = await fillDerivedSlugFromCatalog(next, { source: "portfolioStore.updateHolding" });

  // CF-GRADE-COMPANY-WITHOUT-VALUE: symmetric with addHolding. An edit that
  // adds a company without a grade must not persist the shape either.
  // CF-GRADE-EDIT-MUST-STICK (2026-08-22). The guard below cleans stale
  // INGEST data — a grading company left on a row with no grade. On an
  // explicit edit it did something quite different: silently deleted a grade
  // the user had just typed. Reported from the app as "I saved PSA 9 and the
  // PSA 9 didn't stay".
  //
  // If this request explicitly set a grading company but supplied no value,
  // say so instead of quietly dropping it. Cleaning data we inferred is one
  // thing; discarding what someone entered without telling them is another.
  const bodySetCompany = typeof (cleanBody as Record<string, unknown>).gradeCompany === "string"
    && String((cleanBody as Record<string, unknown>).gradeCompany).trim() !== "";
  const bodyGradeValue = (cleanBody as Record<string, unknown>).gradeValue;
  const bodyHasGradeValue = typeof bodyGradeValue === "number"
    ? Number.isFinite(bodyGradeValue)
    : typeof bodyGradeValue === "string" && bodyGradeValue.trim() !== "";
  const bodyCert = (cleanBody as Record<string, unknown>).certNumber;
  const bodyHasCert = typeof bodyCert === "string" ? bodyCert.trim() !== "" : bodyCert != null;
  if (bodySetCompany && !bodyHasGradeValue && !bodyHasCert) {
    res.status(400).json({
      success: false,
      error: "Grade needs both a company and a number. Send a gradeValue, or clear gradeCompany to save the card as Raw.",
    });
    return;
  }

  clearGradeCompanyWithoutValue(next as unknown as Record<string, unknown>, {
    userId: auth.userId,
    holdingId: id,
  });

  // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION: symmetric with addHolding.
  // Validates the merged AFTER-state — an update of an existing legacy
  // null-identity row to {quantity: 5} still blocks (the merged state
  // is still null-identity); an update that ADDS cardYear+product OR
  // cardId passes (the merged state has identity). Forces
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

  // CF-PHOTO-PATCH-LATENCY (Drew, 2026-08-12). autoPriceHolding runs a full
  // computeEstimate — ~900 Cosmos queries and 5-16s on a thin-data card — and
  // the PATCH response waits on it. Edits that touch only photos / notes /
  // quantity cannot change the estimate, so that work is pure latency and
  // wasted RUs.
  //
  // Observed in prod 2026-08-12: attaching a photo to a 2026 Bowman Chrome
  // prospect (0 comps, so the slowest engine path) issued 911 Cosmos deps and
  // took 15.64s; the web client aborted before the PATCH reached the server,
  // so the photo looked like it failed even though the blob upload had already
  // succeeded. The same flow on a well-comped card was 260 deps / 1.76s —
  // nothing about the request differed, only the card.
  //
  // Gate on the engine input, not on a "was it a photo?" test: any patch that
  // leaves every computeEstimate input identical is equally safe to skip, and
  // identity / grade edits still reprice exactly as before.
  // CF-CARD-SAVE-FAST (Drew, 2026-08-31: "saving edits on a card is SLOW").
  //
  // The reprice and the comp emit used to run HERE, before writeUserDoc and
  // before the response. Both are real work that must still happen, and
  // neither can change what the user just typed — so they move after the
  // response instead of being dropped. See holdingSaveDeferredWork.ts for the
  // durability argument; the short version is that the marker is persisted by
  // the SAME write that persists the edit, so a crash leaves a replayable debt
  // rather than silently losing the work.
  //
  // The gate itself is unchanged: estimateInputChanged still decides whether a
  // reprice is owed at all (CF-PHOTO-PATCH-LATENCY). This only changes WHEN an
  // owed reprice runs, never whether one is owed.
  const repriceNeeded = estimateInputChanged(previous, next);
  const deferred = deferredOpsFor(doc.holdings[id]!, repriceNeeded);
  markPending(doc.holdings[id]!, deferred);

  // Alerts stay synchronous. They are pure in-memory comparison of previous vs
  // next — no Cosmos — and they belong to the doc this write persists.
  // autoPriceHolding used to call this on its way out; now that the reprice is
  // deferred, the request path must call it directly for BOTH branches, or
  // deferring the reprice would silently defer alert evaluation with it.
  evaluateHoldingAlerts(doc, previous, doc.holdings[id]!);

  await writeUserDoc(auth.userId, doc);

  // CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE (2026-06-30): re-subscribe only
  // when the update changed the (cardId, grade) identity. Edits that
  // only touch quantity / notes / photos don't change what CH should
  // track. Saves a CH call on every quantity bump.

  // CF-MARKETPLACE-SYNC (Drew, 2026-08-10). Marketplace listings are
  // refreshed via a nightly cron workflow (marketplace-listings-refresh),
  // not a per-update write hook. Trade-off: newly-toggled storefront
  // cards take up to 24h to appear in cross-storefront search. Chosen
  // over inline hook to avoid adding a userId→record lookup helper
  // that authService doesn't currently expose. When per-toggle
  // reactivity is needed, promote to real-time hook here.

  // CF-PATCH-HOLDING-RETURN-STATE (2026-07-12): return the fully-persisted
  // holding via composeHoldingWireShape so iOS can verify the round-trip
  // matches what it sent. Prevents "I changed to Raw but it still shows
  // PSA 10" symptoms where iOS was relying on a refetch that raced or
  // never fired. Legacy {message, id} still present for existing consumers.
  const holdingWire = composeHoldingWireShape(doc.holdings[id], undefined, wireEntitlementsFor(req));
  res.json({ message: "Holding updated", id, holding: holdingWire, entry: { holding: holdingWire } });

  // CF-CARD-SAVE-FAST: the user's Save has returned. Everything below is the
  // deferred lane — it re-reads the doc, so it never writes through the stale
  // copy this request held, and it clears the marker only on success.
  if (deferred.length > 0) {
    void runDeferredSaveWork(auth.userId, id, deferred, "update");
  }
}

/**
 * CF-CARD-SAVE-FAST. Run the work a save deferred, after the response.
 *
 * Re-reads the user doc rather than closing over the request's copy: between
 * the response and this running, another write may have landed, and repricing
 * into a stale doc would resurrect the overwritten fields. Re-reading makes
 * this a read-modify-write on current state, which is also what makes replay
 * from the sweep safe.
 *
 * Never throws — it runs unawaited, so an escaping rejection would be an
 * unhandled rejection. Failure leaves the marker in place for the sweep.
 */
export async function runDeferredSaveWork(
  userId: string,
  holdingId: string,
  ops: DeferredOp[],
  source: string,
): Promise<void> {
  const started = Date.now();
  const done: DeferredOp[] = [];
  try {
    const doc = await readUserDoc(userId);
    const key = findHoldingKey(doc, holdingId);
    if (!key) return;
    const holding = doc.holdings[key];
    if (!holding) return;

    if (ops.includes("reprice")) {
      // previous === undefined: this is a recompute of current state, not a
      // transition, and alerts were already evaluated in the request path.
      await autoPriceHolding(doc, doc.holdings[key]!, undefined, source, userId);
      done.push("reprice");
    }
    if (ops.includes("comp-emit")) {
      await emitUserEbayPurchaseComp(doc.holdings[key]!, userId, doc);
      done.push("comp-emit");
    }

    clearOps(doc.holdings[key]!, done);
    await writeUserDoc(userId, doc);
    console.log(JSON.stringify({
      event: "deferred_save_work_complete",
      source: `portfolioStore.${source}`,
      userId,
      holdingId: key,
      ops,
      done,
      ms: Date.now() - started,
    }));
  } catch (err) {
    // The marker stays set — reconcileDeferredSaveWork will pick it up.
    console.warn(JSON.stringify({
      event: "deferred_save_work_error",
      source: `portfolioStore.${source}`,
      userId,
      holdingId,
      ops,
      done,
      ms: Date.now() - started,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/**
 * CF-CARD-SAVE-FAST. The reconcile half of the at-least-once contract.
 *
 * Walks one user's holdings for markers left behind by a save whose deferred
 * lane never finished — a crashed process, a Cosmos blip, an App Service
 * recycle between the response and the work. Every deferred op is idempotent,
 * so re-running one that partially succeeded converges rather than duplicating:
 * the comp upserts on the fixed `holding::<id>` key and the reprice recomputes
 * from current state.
 *
 * Returns what it did so a caller (script or scheduled job) can report it.
 */
export async function reconcileDeferredSaveWork(
  userId: string,
): Promise<{ scanned: number; replayed: number; exhausted: string[] }> {
  const doc = await readUserDoc(userId);
  // CF-HOLDINGS-IS-A-MAP: walk the map's values, never a JOIN over an object.
  const entries = Object.entries(doc.holdings ?? {});
  let replayed = 0;
  const exhausted: string[] = [];

  for (const [key, holding] of entries) {
    const pending = readPending(holding as PortfolioHolding);
    if (!pending) continue;
    if (pending.attempts >= MAX_ATTEMPTS) {
      exhausted.push(key);
      continue;
    }
    // Count the attempt BEFORE running it, and persist that count, so a run
    // that dies mid-work still burns an attempt and cannot spin forever.
    bumpAttempts(holding as PortfolioHolding);
    await writeUserDoc(userId, doc);
    await runDeferredSaveWork(userId, key, pending.ops, "reconcile");
    replayed += 1;
  }

  console.log(JSON.stringify({
    event: "deferred_save_work_reconciled",
    source: "portfolioStore.reconcileDeferredSaveWork",
    userId,
    scanned: entries.length,
    replayed,
    exhausted,
  }));
  return { scanned: entries.length, replayed, exhausted };
}

/**
 * CF-REGRADE-COST-ROLLIN (2026-07-06, Drew via iOS Claude ask):
 * POST /api/portfolio/holdings/:id/regrade
 *
 * Atomic grade conversion. Combines four field updates on a single
 * holding into ONE commit + one audit event so the user's "Mark as
 * Graded" flow doesn't spread across two/three PATCH round-trips:
 *
 *   1. gradeCompany + gradeValue → the new grade
 *   2. certNumber                 → optional slab cert
 *   3. gradingCost                → rolled INTO totalCostBasis so
 *                                    P&L reflects true all-in cost
 *
 * Body:
 *   {
 *     gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | string,   // required
 *     gradeValue:   number,                                    // required
 *     certNumber?:  string | null,                             // optional
 *     gradingCost?: number,                                    // optional, default 0
 *   }
 *
 * Response: { message: string, id: string, updatedHolding: {...wire shape...} }
 *
 * Audit trail:
 *   - priceHistoryByHolding gets a `{ at, value, source: "regrade" }`
 *     point so history charts show the conversion moment
 *   - `holding_regraded` telemetry event captures gradingCost, old
 *     grade → new grade, cost basis before/after
 *
 * Cost roll-in math:
 *   old totalCostBasis = computeCostBasisTotal(holding)
 *   new totalCostBasis = old + gradingCost
 *   `purchasePrice` is NOT touched — it stays the per-unit acquisition
 *   price. Downstream cost consumers read totalCostBasis via
 *   computeCostBasisTotal which prefers totalCostBasis when set.
 */
export async function regradeHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const rawId = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  const id = findHoldingKey(doc, rawId);
  if (!id) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const gradeCompany = typeof body.gradeCompany === "string" ? body.gradeCompany.trim() : "";
  const gradeValueRaw = body.gradeValue;
  const gradeValue =
    typeof gradeValueRaw === "number"
      ? gradeValueRaw
      : typeof gradeValueRaw === "string"
        ? parseFloat(gradeValueRaw)
        : NaN;
  if (gradeCompany.length === 0 || !Number.isFinite(gradeValue)) {
    return res.status(400).json({
      error: {
        code: "INVALID_PAYLOAD",
        message: "gradeCompany (non-empty string) and gradeValue (number) are required.",
      },
    });
  }

  const certNumber =
    typeof body.certNumber === "string"
      ? body.certNumber.trim() || null
      : body.certNumber === null
        ? null
        : undefined; // undefined = don't touch; null = explicit clear

  // CF-GRADING-TIER-CATALOG (2026-07-06): resolve gradingCost from a
  // gradingTierId when provided. Explicit gradingCost in the body wins
  // (user may have paid a promo/bulk rate that differs from the tier's
  // sticker price). When BOTH gradingCost and gradingTierId are absent,
  // gradingCost defaults to 0 (grade-only update).
  const gradingCostRaw = body.gradingCost;
  const explicitGradingCost =
    typeof gradingCostRaw === "number" && Number.isFinite(gradingCostRaw) && gradingCostRaw >= 0
      ? gradingCostRaw
      : null;
  const gradingTierId =
    typeof body.gradingTierId === "string" ? body.gradingTierId.trim() : "";
  let gradingCost = explicitGradingCost ?? 0;
  let resolvedTier: ReturnType<typeof getGradingTierById> | null = null;
  if (gradingTierId) {
    resolvedTier = getGradingTierById(gradingTierId);
    if (!resolvedTier) {
      return res.status(400).json({
        error: {
          code: "UNKNOWN_GRADING_TIER",
          message: `Unknown gradingTierId "${gradingTierId}". Fetch /api/portfolio/grading-tiers for the current catalog.`,
        },
      });
    }
    // If no explicit cost, use the tier's sticker price. For Premium 2+
    // (pricePerCard === null) we require an explicit gradingCost since
    // the tier itself doesn't specify one.
    if (explicitGradingCost === null) {
      if (resolvedTier.pricePerCard === null) {
        return res.status(400).json({
          error: {
            code: "TIER_REQUIRES_EXPLICIT_COST",
            message: `Tier "${resolvedTier.name}" quotes per-card; include gradingCost in the request.`,
          },
        });
      }
      gradingCost = resolvedTier.pricePerCard;
    }
  }

  const previous = doc.holdings[id];
  const oldCostBasis = computeCostBasisTotal(previous);
  const newCostBasis = Math.round((oldCostBasis + gradingCost) * 100) / 100;

  const next: PortfolioHolding = {
    ...previous,
    gradeCompany,
    gradeValue,
    // Only overwrite certNumber when the caller supplied a value or
    // explicit null. Otherwise leave whatever was there.
    ...(certNumber !== undefined ? { certNumber } : {}),
    totalCostBasis: newCostBasis,
    lastUpdated: new Date().toISOString(),
    id,
  };

  // Cardsight taxonomy — re-resolve gradeId now that grade changed.
  const nextWithGradeId = await populateCardsightGradeId(next);
  doc.holdings[id] = nextWithGradeId;

  // Audit trail: append a "regrade" point so history charts render
  // the conversion moment as a break-line even when FMV doesn't move.
  const now = new Date().toISOString();
  const nextValue = computePerUnitValue(nextWithGradeId) ?? 0;
  if (nextValue > 0) {
    appendPriceHistory(doc, id, {
      at: now,
      value: nextValue,
      source: "regrade" as const,
    });
  }

  // Best-effort auto-repricing on the new grade — a Raw→PSA 9 conversion
  // should surface a new FMV immediately, not wait for the next daily job.
  try {
    await autoPriceHolding(doc, doc.holdings[id], previous, "update", auth.userId);
  } catch {
    // Persist anyway; the FMV refresh can happen on the next cycle.
  }

  // CF-REGRADE-LEDGER-LINE-ITEM (2026-07-06): append a regrade audit
  // entry so the user's ledger UI can render the conversion as its own
  // line item. Sell-side financial fields are all 0 so P&L / tax
  // rollups skipping non-"sale" actions produce identical totals.
  if (gradingCost > 0) {
    const priorGrade =
      previous.gradeCompany && typeof previous.gradeValue === "number"
        ? `${previous.gradeCompany} ${previous.gradeValue}`
        : "Raw";
    const newGrade = `${gradeCompany} ${gradeValue}`;
    doc.ledger.push({
      id: randomUUID(),
      userId: auth.userId,
      holdingId: id,
      playerName: previous.playerName ?? "",
      cardTitle: previous.cardTitle ?? "",
      quantitySold: 0,
      unitSalePrice: 0,
      grossProceeds: 0,
      fees: 0,
      tax: 0,
      shipping: 0,
      netProceeds: 0,
      costBasisSold: 0,
      realizedProfitLoss: 0,
      realizedProfitLossPct: 0,
      soldAt: now,
      action: "regrade",
      gradingCostAmount: gradingCost,
      regradeFromGrade: priorGrade,
      regradeToGrade: newGrade,
    });
  }

  await writeUserDoc(auth.userId, doc);

  // Telemetry — one event carrying the whole conversion so ops can KQL
  // grading-cost trends without cross-referencing multiple events.
  console.log(JSON.stringify({
    event: "holding_regraded",
    source: "portfolioStore.regradeHolding",
    userId: auth.userId,
    holdingId: id,
    oldGrade: {
      company: previous.gradeCompany ?? null,
      value: previous.gradeValue ?? null,
    },
    newGrade: {
      company: gradeCompany,
      value: gradeValue,
    },
    certNumberChanged: certNumber !== undefined,
    gradingCost,
    gradingTierId: resolvedTier?.id ?? null,
    gradingTierName: resolvedTier?.name ?? null,
    oldTotalCostBasis: Math.round(oldCostBasis * 100) / 100,
    newTotalCostBasis: newCostBasis,
    timestamp: now,
  }));

  // Re-subscribe delta polls when grade/cardId identity changed (grade
  // change always changes the tracked (cardId, grade) tuple).

  // CF-MUTATION-ENVELOPE-PARITY (2026-07-12): standardize response envelope
  // across all mutation routes. `updatedHolding` preserved for existing
  // consumers; `holding` + `entry.holding` are the new parity fields
  // matching PATCH /holdings and confirm/reject flows.
  const regradedWire = composeHoldingWireShape(doc.holdings[id], undefined, wireEntitlementsFor(req));
  return res.json({
    message: "Holding regraded",
    id,
    updatedHolding: doc.holdings[id],
    holding: regradedWire,
    entry: { holding: regradedWire },
  });
}

/**
 * CF-REGRADE-BATCH (2026-07-06, Drew): batch companion to /regrade.
 * POST /api/portfolio/holdings/regrade-batch
 *
 * Body:
 *   {
 *     entries: Array<{
 *       holdingId:    string,   // required
 *       gradeCompany: string,   // required
 *       gradeValue:   number,   // required
 *       certNumber?:  string | null,
 *       gradingCost?: number,   // optional, default 0
 *     }>
 *   }
 *
 * Response:
 *   {
 *     success: boolean,
 *     totalRequested: N,
 *     succeeded: [{ holdingId, updatedHolding }, ...],
 *     failed:    [{ holdingId, error: { code, message } }, ...],
 *   }
 *
 * Semantics:
 *   - Each entry is processed sequentially against a SINGLE Cosmos
 *     write at the end. This is intentional — 30 slabs coming back
 *     from PSA is one commit, not 30. Partial failures inside the
 *     batch are reported per-entry, but the doc still writes with
 *     the succeeded mutations applied.
 *   - Missing required fields on ANY entry → 400, no writes at all
 *     (bad-payload guard runs before we touch the doc). Individual
 *     "holding not found" errors go into `failed[]` at row level.
 *   - autoPriceHolding fires per-entry AFTER the write for a batch
 *     background reprice — same pattern as single /regrade.
 *   - One `holdings_regraded_batch` telemetry event captures the
 *     rollup: total, succeeded, failed, aggregate grading cost.
 */
export async function regradeHoldingsBatch(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { entries?: unknown };
  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return res.status(400).json({
      error: {
        code: "INVALID_PAYLOAD",
        message: "entries must be a non-empty array",
      },
    });
  }
  const MAX_BATCH = 100;
  if (body.entries.length > MAX_BATCH) {
    return res.status(400).json({
      error: {
        code: "BATCH_TOO_LARGE",
        message: `entries exceeds maximum batch size of ${MAX_BATCH}`,
      },
    });
  }

  // Validate every entry upfront — bad-payload guard runs before we
  // touch the doc, so a caller sending garbage never partial-commits.
  interface ValidEntry {
    holdingId: string;
    gradeCompany: string;
    gradeValue: number;
    certNumber?: string | null;
    gradingCost: number;
    gradingTierId?: string | null;
  }
  const validated: ValidEntry[] = [];
  for (const raw of body.entries as unknown[]) {
    if (!raw || typeof raw !== "object") {
      return res.status(400).json({
        error: {
          code: "INVALID_PAYLOAD",
          message: "each entry must be an object",
        },
      });
    }
    const e = raw as Record<string, unknown>;
    const holdingId = typeof e.holdingId === "string" ? e.holdingId.trim() : "";
    const gradeCompany = typeof e.gradeCompany === "string" ? e.gradeCompany.trim() : "";
    const gradeValueRaw = e.gradeValue;
    const gradeValue =
      typeof gradeValueRaw === "number"
        ? gradeValueRaw
        : typeof gradeValueRaw === "string"
          ? parseFloat(gradeValueRaw)
          : NaN;
    if (!holdingId || !gradeCompany || !Number.isFinite(gradeValue)) {
      return res.status(400).json({
        error: {
          code: "INVALID_PAYLOAD",
          message: `entry missing required fields (holdingId, gradeCompany, gradeValue) — got ${JSON.stringify(e)}`,
        },
      });
    }
    const certNumber =
      typeof e.certNumber === "string"
        ? e.certNumber.trim() || null
        : e.certNumber === null
          ? null
          : undefined;
    // CF-GRADING-TIER-CATALOG (2026-07-06): same tier-resolution as
    // single /regrade — explicit gradingCost wins, tier's sticker
    // price fills when absent, unknown tier ID fails the whole batch.
    const gradingCostRaw = e.gradingCost;
    const explicitGradingCost =
      typeof gradingCostRaw === "number" && Number.isFinite(gradingCostRaw) && gradingCostRaw >= 0
        ? gradingCostRaw
        : null;
    const gradingTierId =
      typeof e.gradingTierId === "string" ? e.gradingTierId.trim() : "";
    let gradingCost = explicitGradingCost ?? 0;
    if (gradingTierId) {
      const resolvedTier = getGradingTierById(gradingTierId);
      if (!resolvedTier) {
        return res.status(400).json({
          error: {
            code: "UNKNOWN_GRADING_TIER",
            message: `Unknown gradingTierId "${gradingTierId}" in batch entry ${holdingId}.`,
          },
        });
      }
      if (explicitGradingCost === null) {
        if (resolvedTier.pricePerCard === null) {
          return res.status(400).json({
            error: {
              code: "TIER_REQUIRES_EXPLICIT_COST",
              message: `Tier "${resolvedTier.name}" on entry ${holdingId} quotes per-card; include gradingCost.`,
            },
          });
        }
        gradingCost = resolvedTier.pricePerCard;
      }
    }
    validated.push({
      holdingId,
      gradeCompany,
      gradeValue,
      certNumber,
      gradingCost,
      gradingTierId: gradingTierId || null,
    });
  }

  const doc = await readUserDoc(auth.userId);
  const now = new Date().toISOString();
  const succeeded: Array<{ holdingId: string; updatedHolding: PortfolioHolding }> = [];
  const failed: Array<{ holdingId: string; error: { code: string; message: string } }> = [];
  let aggregateGradingCost = 0;

  for (const entry of validated) {
    const id = findHoldingKey(doc, entry.holdingId);
    if (!id) {
      failed.push({
        holdingId: entry.holdingId,
        error: { code: "NOT_FOUND", message: "Holding does not exist" },
      });
      continue;
    }
    const previous = doc.holdings[id];
    const oldCostBasis = computeCostBasisTotal(previous);
    const newCostBasis = Math.round((oldCostBasis + entry.gradingCost) * 100) / 100;

    const next: PortfolioHolding = {
      ...previous,
      gradeCompany: entry.gradeCompany,
      gradeValue: entry.gradeValue,
      ...(entry.certNumber !== undefined ? { certNumber: entry.certNumber } : {}),
      totalCostBasis: newCostBasis,
      lastUpdated: now,
      id,
    };

    const nextWithGradeId = await populateCardsightGradeId(next);
    doc.holdings[id] = nextWithGradeId;
    aggregateGradingCost += entry.gradingCost;

    const nextValue = computePerUnitValue(nextWithGradeId) ?? 0;
    if (nextValue > 0) {
      appendPriceHistory(doc, id, {
        at: now,
        value: nextValue,
        source: "regrade" as const,
      });
    }

    if (entry.gradingCost > 0) {
      const priorGrade =
        previous.gradeCompany && typeof previous.gradeValue === "number"
          ? `${previous.gradeCompany} ${previous.gradeValue}`
          : "Raw";
      const newGrade = `${entry.gradeCompany} ${entry.gradeValue}`;
      doc.ledger.push({
        id: randomUUID(),
        userId: auth.userId,
        holdingId: id,
        playerName: previous.playerName ?? "",
        cardTitle: previous.cardTitle ?? "",
        quantitySold: 0,
        unitSalePrice: 0,
        grossProceeds: 0,
        fees: 0,
        tax: 0,
        shipping: 0,
        netProceeds: 0,
        costBasisSold: 0,
        realizedProfitLoss: 0,
        realizedProfitLossPct: 0,
        soldAt: now,
        action: "regrade",
        gradingCostAmount: entry.gradingCost,
        regradeFromGrade: priorGrade,
        regradeToGrade: newGrade,
      });
    }

    succeeded.push({ holdingId: id, updatedHolding: nextWithGradeId });
  }

  await writeUserDoc(auth.userId, doc);

  // Fire post-commit auto-repricing for each success — parallel is fine
  // here; each holding is independent. Best-effort silent failures.
  void Promise.all(
    succeeded.map(async (s) => {
      try {
        await autoPriceHolding(doc, doc.holdings[s.holdingId], undefined, "update", auth.userId);
      } catch { /* refresh on next cycle */ }
    }),
  );

  console.log(JSON.stringify({
    event: "holdings_regraded_batch",
    source: "portfolioStore.regradeHoldingsBatch",
    userId: auth.userId,
    totalRequested: validated.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    aggregateGradingCost: Math.round(aggregateGradingCost * 100) / 100,
    timestamp: now,
  }));

  return res.json({
    success: failed.length === 0,
    totalRequested: validated.length,
    succeeded,
    failed,
  });
}

export async function deleteHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const rawId = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  // CF-D1: case-insensitive lookup; delete via the canonical stored key.
  const id = findHoldingKey(doc, rawId);
  if (!id) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

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

  // H-9: the trail dies with the holding it belongs to (reapPriceTrail).
  reapPriceTrail(doc, id);
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
  // CF-D1: case-insensitive lookup; mutate via the canonical stored key.
  const canonicalKey = findHoldingKey(doc, holdingId);
  if (!canonicalKey) return null;
  const holding = doc.holdings[canonicalKey];
  const updated: PortfolioHolding = {
    ...holding,
    ebayOfferId: link.offerId,
    ebayListingId: link.listingId,
    ebayListingPublishedAt: link.publishedAt ?? new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
  doc.holdings[canonicalKey] = updated;
  await writeUserDoc(userId, doc);
  // CF-EBAY-LINK-INDEX-P0.5: best-effort mirror into the point-read index.
  // Failure MUST NOT fail the link — the holding write is source of truth.
  void writeEbayLinkIndex({
    userId,
    holdingId: canonicalKey,
    offerId: link.offerId,
    listingId: link.listingId,
  }).catch(() => {});
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
  const priorListingId = target.holding.ebayListingId ?? null;
  const cleared: PortfolioHolding = {
    ...target.holding,
    ebayOfferId: null,
    ebayListingId: null,
    ebayListingPublishedAt: null,
    lastUpdated: new Date().toISOString(),
  };
  doc.holdings[target.id] = cleared;
  await writeUserDoc(userId, doc);
  // CF-EBAY-LINK-INDEX-P0.5: best-effort index cleanup (both offer + prior
  // listing rows). Failure MUST NOT fail the unlink.
  void removeEbayLinkIndex({
    offerId,
    listingId: priorListingId,
  }).catch(() => {});
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

  // CF-EBAY-LINK-INDEX-P0.5 (Drew, 2026-07-26). Fast path: point-read on
  // ebay_link_index. On hit, dereference the holding via a single-partition
  // read of the portfolio doc. On miss (or index unavailable, or holding
  // dereferenced but no longer present) fall through to the legacy
  // cross-partition scan below so behaviour is unchanged for historical
  // holdings pre-backfill.
  const indexEntry = await findEbayLinkByOfferId(offerId).catch(() => null);
  if (indexEntry) {
    const holding = await findHoldingByEbayOfferId(indexEntry.userId, offerId);
    if (holding) {
      return { userId: indexEntry.userId, holdingId: indexEntry.holdingId, holding };
    }
    // Index says user X had it but the holding no longer references
    // offerId. Log and fall through — the scan will resolve correctly
    // (return null or find a fresher owner).
    console.warn(JSON.stringify({
      event: "ebay_link_index_stale_offer",
      offerId,
      indexUserId: indexEntry.userId,
      indexHoldingId: indexEntry.holdingId,
    }));
  }

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

  // CF-EBAY-LINK-INDEX-P0.5 (Drew, 2026-07-26). Fast path — see
  // findHoldingByEbayOfferIdAcrossUsers for the pattern rationale.
  const indexEntry = await findEbayLinkByListingId(listingId).catch(() => null);
  if (indexEntry) {
    const doc = await readUserDoc(indexEntry.userId);
    const canonicalKey = findHoldingKey(doc, indexEntry.holdingId);
    const holding = canonicalKey ? doc.holdings[canonicalKey] : undefined;
    if (holding && holding.ebayListingId === listingId) {
      return { userId: indexEntry.userId, holdingId: canonicalKey!, holding };
    }
    console.warn(JSON.stringify({
      event: "ebay_link_index_stale_listing",
      listingId,
      indexUserId: indexEntry.userId,
      indexHoldingId: indexEntry.holdingId,
    }));
  }

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

/**
 * CF-VERDICT-FLIP-PUSH-FANOUT-STEP-2 (Drew, 2026-07-16). Cross-partition
 * scan that returns the union of every `playerName` across every user's
 * holdings — the input universe the fan-out worker walks to find flips
 * to notify on. Same cross-partition pattern as
 * `findHoldingByEbayListingIdAcrossUsers`; returns an empty set when
 * the store is unavailable.
 *
 * Player names are trimmed but NOT normalized here — the caller
 * (verdictHistoryStore's `readRecentFlipsForPlayers`) normalizes on the
 * way in (lowercase + hyphenate) so both sides agree on the key.
 */
export async function listAllHeldPlayers(): Promise<Set<string>> {
  const out = new Set<string>();
  const container = await getContainer();
  if (!container && isTestMode) {
    for (const doc of testMemStore.values()) {
      for (const holding of Object.values(doc.holdings)) {
        const name = String(holding?.playerName ?? "").trim();
        if (name) out.add(name);
      }
    }
    return out;
  }
  if (!container) return out;
  try {
    const { resources } = await container.items
      .query<{ userId: string; holdings: Record<string, PortfolioHolding> }>({
        query: "SELECT c.userId, c.holdings FROM c",
      })
      .fetchAll();
    for (const row of resources ?? []) {
      if (!row?.holdings) continue;
      for (const holding of Object.values(row.holdings)) {
        const name = String(holding?.playerName ?? "").trim();
        if (name) out.add(name);
      }
    }
  } catch (err: any) {
    console.error(
      "[portfolio] listAllHeldPlayers query failed:",
      err?.message ?? String(err),
    );
  }
  return out;
}

/**
 * CF-VERDICT-FLIP-PUSH-FANOUT-STEP-3 (Drew, 2026-07-16). Reverse index
 * for the fan-out worker: given a player display name, return the
 * subset of users who hold that player AND have opted in to major-flip
 * push. Only the fields the worker needs (userId + apnsDeviceToken) are
 * projected — no user PII travels through the fan-out log stream.
 *
 * Matches by case-insensitive `playerName` equality after trim. NOT
 * fuzzy — the caller passes the display name from the flip event which
 * came from the recorded verdict_history doc which came from the
 * holding's playerName in the first place, so the shapes agree.
 *
 * Returns empty when the store is unavailable OR when no users opted
 * in AND own the player.
 */
export async function listUsersOwningPlayerWithPushOptIn(
  playerDisplay: string,
): Promise<Array<{ userId: string; apnsDeviceToken: string | null }>> {
  const target = String(playerDisplay ?? "").trim().toLowerCase();
  if (!target) return [];

  const matches: Array<{ userId: string; apnsDeviceToken: string | null }> = [];
  const scan = (doc: UserDoc) => {
    if (doc.preferences?.pushOnMajorFlip !== true) return;
    const token = doc.apnsDeviceToken ?? null;
    for (const holding of Object.values(doc.holdings)) {
      const name = String(holding?.playerName ?? "").trim().toLowerCase();
      if (name === target) {
        matches.push({ userId: doc.userId, apnsDeviceToken: token });
        return; // one user matches at most once regardless of holding count
      }
    }
  };

  const container = await getContainer();
  if (!container && isTestMode) {
    for (const doc of testMemStore.values()) scan(doc);
    return matches;
  }
  if (!container) return matches;

  try {
    const { resources } = await container.items
      .query<UserDoc>({
        query:
          "SELECT c.userId, c.holdings, c.preferences, c.apnsDeviceToken " +
          "FROM c WHERE c.preferences.pushOnMajorFlip = true",
      })
      .fetchAll();
    for (const row of resources ?? []) {
      if (!row) continue;
      scan(row as UserDoc);
    }
  } catch (err: any) {
    console.error(
      "[portfolio] listUsersOwningPlayerWithPushOptIn query failed:",
      err?.message ?? String(err),
    );
  }
  return matches;
}

/**
 * CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). Reverse index for the
 * cascade fan-out worker: given a player display name, return the
 * subset of users who hold that player AND have opted in to cascade
 * push. Mirrors `listUsersOwningPlayerWithPushOptIn` but keyed on
 * `preferences.pushOnCascade` instead. Only the fields the fan-out
 * worker needs (userId + apnsDeviceToken) are projected — no user PII
 * travels through the push log stream.
 *
 * Case-insensitive on playerName after trim. Returns empty when the
 * store is unavailable OR when no users match.
 */
export async function listUsersOwningPlayerWithCascadeOptIn(
  playerDisplay: string,
): Promise<Array<{ userId: string; apnsDeviceToken: string | null }>> {
  const target = String(playerDisplay ?? "").trim().toLowerCase();
  if (!target) return [];

  const matches: Array<{ userId: string; apnsDeviceToken: string | null }> = [];
  const scan = (doc: UserDoc) => {
    if (doc.preferences?.pushOnCascade !== true) return;
    const token = doc.apnsDeviceToken ?? null;
    for (const holding of Object.values(doc.holdings)) {
      const name = String(holding?.playerName ?? "").trim().toLowerCase();
      if (name === target) {
        matches.push({ userId: doc.userId, apnsDeviceToken: token });
        return;
      }
    }
  };

  const container = await getContainer();
  if (!container && isTestMode) {
    for (const doc of testMemStore.values()) scan(doc);
    return matches;
  }
  if (!container) return matches;

  try {
    const { resources } = await container.items
      .query<UserDoc>({
        query:
          "SELECT c.userId, c.holdings, c.preferences, c.apnsDeviceToken " +
          "FROM c WHERE c.preferences.pushOnCascade = true",
      })
      .fetchAll();
    for (const row of resources ?? []) {
      if (!row) continue;
      scan(row as UserDoc);
    }
  } catch (err: any) {
    console.error(
      "[portfolio] listUsersOwningPlayerWithCascadeOptIn query failed:",
      err?.message ?? String(err),
    );
  }
  return matches;
}

/**
 * CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). Enumerate the user IDs
 * (+ latest apnsDeviceToken) for every user with pushOnWatchlistDigest
 * === true. Unlike the cascade/flip helpers this is NOT keyed on a
 * player display name — the watchlist digest is a per-user computation
 * (each user's own watchlist rows) so the fan-out worker enumerates
 * ALL opted-in users then computes their digest downstream.
 *
 * Returns empty when the store is unavailable OR when nobody opted in.
 */
export async function listUsersWithWatchlistOptIn(): Promise<Array<{ userId: string; apnsDeviceToken: string | null }>> {
  const matches: Array<{ userId: string; apnsDeviceToken: string | null }> = [];
  const scan = (doc: UserDoc) => {
    if (doc.preferences?.pushOnWatchlistDigest !== true) return;
    matches.push({
      userId: doc.userId,
      apnsDeviceToken: doc.apnsDeviceToken ?? null,
    });
  };

  const container = await getContainer();
  if (!container && isTestMode) {
    for (const doc of testMemStore.values()) scan(doc);
    return matches;
  }
  if (!container) return matches;

  try {
    const { resources } = await container.items
      .query<UserDoc>({
        query:
          "SELECT c.userId, c.preferences, c.apnsDeviceToken " +
          "FROM c WHERE c.preferences.pushOnWatchlistDigest = true",
      })
      .fetchAll();
    for (const row of resources ?? []) {
      if (!row) continue;
      scan(row as UserDoc);
    }
  } catch (err: any) {
    console.error(
      "[portfolio] listUsersWithWatchlistOptIn query failed:",
      err?.message ?? String(err),
    );
  }
  return matches;
}

/**
 * CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). Enumerate every user who
 * opted in to grade-worthy push AND has at least one holding to scan.
 * Returns userId + apnsDeviceToken + a shallow holdings map so the
 * fan-out worker doesn't need a second read per user just to iterate.
 *
 * Returns empty when the store is unavailable OR when no users match.
 */
export async function listUsersWithGradeWorthyOptIn(): Promise<Array<{
  userId: string;
  apnsDeviceToken: string | null;
  holdings: Record<string, PortfolioHolding>;
}>> {
  const matches: Array<{
    userId: string;
    apnsDeviceToken: string | null;
    holdings: Record<string, PortfolioHolding>;
  }> = [];
  const scan = (doc: UserDoc) => {
    if (doc.preferences?.pushOnGradeWorthy !== true) return;
    const holdings = doc.holdings ?? {};
    if (Object.keys(holdings).length === 0) return;
    matches.push({
      userId: doc.userId,
      apnsDeviceToken: doc.apnsDeviceToken ?? null,
      holdings,
    });
  };

  const container = await getContainer();
  if (!container && isTestMode) {
    for (const doc of testMemStore.values()) scan(doc);
    return matches;
  }
  if (!container) return matches;

  try {
    const { resources } = await container.items
      .query<UserDoc>({
        query:
          "SELECT c.userId, c.preferences, c.apnsDeviceToken, c.holdings " +
          "FROM c WHERE c.preferences.pushOnGradeWorthy = true",
      })
      .fetchAll();
    for (const row of resources ?? []) {
      if (!row) continue;
      scan(row as UserDoc);
    }
  } catch (err: any) {
    console.error(
      "[portfolio] listUsersWithGradeWorthyOptIn query failed:",
      err?.message ?? String(err),
    );
  }
  return matches;
}

/**
 * CF-VERDICT-FLIP-PUSH-PREFS (Drew, 2026-07-16, PR #500 + follow-up).
 * Writes the two push-related fields on the user doc. Called from the
 * PATCH /api/portfolio/preferences route in production. Named without
 * the -ForTests suffix now that a real route consumes it.
 *
 * Legacy alias `setUserPushPreferenceForTests` is retained so the
 * existing test file (which was written when this was test-only)
 * doesn't have to churn.
 */
export async function setUserPushPreference(
  userId: string,
  input: {
    pushOnMajorFlip?: boolean;
    pushOnCascade?: boolean;
    pushOnWatchlistDigest?: boolean;
    pushOnGradeWorthy?: boolean;
    apnsDeviceToken?: string | null;
  },
): Promise<void> {
  const doc = await readUserDoc(userId);
  const prefs = { ...(doc.preferences ?? {}) };
  if (input.pushOnMajorFlip !== undefined) prefs.pushOnMajorFlip = input.pushOnMajorFlip;
  if (input.pushOnCascade !== undefined) prefs.pushOnCascade = input.pushOnCascade;
  if (input.pushOnWatchlistDigest !== undefined) prefs.pushOnWatchlistDigest = input.pushOnWatchlistDigest;
  if (input.pushOnGradeWorthy !== undefined) prefs.pushOnGradeWorthy = input.pushOnGradeWorthy;
  doc.preferences = prefs;
  if (input.apnsDeviceToken !== undefined) {
    doc.apnsDeviceToken = input.apnsDeviceToken ?? null;
    doc.apnsDeviceTokenUpdatedAt = new Date().toISOString();
  }
  await writeUserDoc(userId, doc);
}

export const setUserPushPreferenceForTests = setUserPushPreference;

export async function sellHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const rawId = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  // CF-D1: case-insensitive lookup; mutate via the canonical stored key.
  const id = findHoldingKey(doc, rawId);
  if (!id) return res.status(404).json({ error: { message: "Holding not found", code: "NOT_FOUND" } });
  const holding = doc.holdings[id];

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
    // CF-MANUAL-SELL-EXPLICIT-SOURCE (2026-07-11, Drew): emit source:"manual"
    // explicitly instead of relying on absent-means-manual reader defaults.
    // The interface comment at line 464 states readers MUST treat absent as
    // manual — that's still true — but explicitly stamping the field makes:
    //   - Cosmos queries filter/group cleanly without OR-null clauses
    //   - App Insights ledger telemetry human-readable
    //   - iOS-side debugging show a positive marker instead of an
    //     absence (which is impossible to distinguish from "field
    //     dropped by a schema-narrowing decode")
    // Behavioral equivalent to absent: isReconciled + accumulate + all
    // groupKeyFor cases already returned "manual" for absent source, so
    // existing readers see no change. Backfill on legacy absent-source
    // entries is NOT done here — pure write-side change.
    source: "manual",
    // CF-ERP-EXPANSION-#1 + #6: manual entries are reconciled-by-definition.
    // The user IS the authoritative source for their own manual sale.
    reconciledVia: "manual_entry",
    ...stParsed.ok,
  };

  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    // H-9: fully sold out — the holding goes, and so does its trail.
    reapPriceTrail(doc, id);
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

  // CF-SOLD-COMPS-FOUNDATION (Drew, 2026-07-14): recorded sale = ground
  // truth. If the holding carries a canonical cardId (i.e. it was
  // user-confirmed at some point), emit a sold-comp record so the
  // sold_comps pool captures REAL sale prices from real users. Same
  // fire-and-forget pattern as confirm-hook — never blocks the sale
  // response, never fails the sale on comp write.
  // CF-ONE-IDENTITY-IN-THE-POOL (D12a): the pinned slug, never the vendor id.
  const sellIdentity = poolIdentityForHolding(holding);
  if (!sellIdentity.cardId && holding.playerName) {
    logUserCompWithheldNoIdentity("portfolioStore.sellHolding", auth.userId, holding, sellIdentity);
  }
  if (sellIdentity.cardId && holding.playerName) {
    const soldCardId = sellIdentity.cardId;
    void (async () => {
      try {
        const { recordSoldComp } = await import("./soldCompsStore.service.js");
        await recordSoldComp({
          cardId: soldCardId,
          vendorCardId: sellIdentity.vendorCardId,
          playerName: String(holding.playerName ?? ""),
          cardYear: holding.cardYear ?? null,
          setName: holding.setName ?? null,
          parallel: holding.parallel ?? null,
          cardNumber: holding.cardNumber ?? null,
          isAuto: holding.isAuto === true,
          printRun: sellIdentity.printRun,
          // CF-USER-COMPS-GRADE-EMIT (Drew, 2026-07-18): include grade
          // fields so downstream readers (canonical FMV rung 1's
          // per-grade pool filter) match this row correctly against a
          // graded holding query. Absent grade defaults to raw.
          gradeCompany: (holding as { gradeCompany?: string | null }).gradeCompany ?? null,
          gradeValue: (holding as { gradeValue?: number | null }).gradeValue ?? null,
          price: unitSalePrice,
          soldAt,
          source: "ebay-user-sale",
          // CF-A-REAL-SALE-IS-IN-THE-POOL-ONCE (2026-08-29, D7b): neither client
          // sends ebayOrderId, so this was always null and the row keyed on a
          // full-precision timestamp -- a re-submit made a second row. Fall back
          // to the ids the holding carries.
          sourceExternalId: (req.body?.ebayOrderId as string | undefined)
            ?? (holding as { ebayOrderId?: string }).ebayOrderId
            ?? (holding as { ebayItemId?: string }).ebayItemId
            ?? null,
          contributorUserId: auth.userId,
          title: shimmedCardTitle(holding),
          imageUrl: (holding as any).ebayImageUrl ?? null,
          sellerHandle: null,
          verifiedByUser: true,
          confidence: 1.0,
        });
      } catch {
        // swallow — comp emission never fails the sale
      }
    })();
  }

  // CF-POST-SALE-ATTRIBUTION (Drew, 2026-07-17): fire-and-forget log
  // the sale outcome against the most recent action-plan verdict for
  // this holding. Never blocks the sale response.
  void (async () => {
    try {
      const [{ readRecentSnapshots, upsertOutcome }, { classifySale }] = await Promise.all([
        import("../dailyiq/actionPlanSnapshotStore.service.js"),
        import("../dailyiq/postSaleAttribution.service.js"),
      ]);
      const snapshots = await readRecentSnapshots(id, 60);
      const attribution = classifySale({
        holdingId: id,
        userId: auth.userId,
        cardId: holding.cardId ?? null,
        soldAt,
        salePrice: unitSalePrice,
        snapshots,
      });
      await upsertOutcome({
        holdingId: attribution.holdingId,
        userId: attribution.userId,
        cardId: attribution.cardId,
        soldAt: attribution.soldAt,
        salePrice: attribution.salePrice,
        verdictAtSaleTime: attribution.verdictAtSaleTime,
        verdictSnapshotDate: attribution.verdictSnapshotDate,
        priceTargetAtSnapshot: attribution.priceTargetAtSnapshot,
        daysSinceVerdict: attribution.daysSinceVerdict,
        outcomeClass: attribution.outcomeClass,
      });
    } catch (err) {
      // CF-ATTRIBUTION-TELEMETRY (Drew, 2026-07-19). Was silent-swallow.
      // Sale attribution runs async after every sell — a broken
      // classify/upsert path silently breaks all downstream outcome
      // reporting. 5% sample warn so App Insights catches the failure
      // rate without spamming for common transient errors.
      if (Math.random() < 0.05) {
        console.warn(JSON.stringify({
          event: "sale_attribution_failed",
          source: "portfolioStore.sellHolding",
          holdingId: id,
          error: (err as Error)?.message ?? String(err),
          sampled: true,
        }));
      }
    }
  })();

  // CF-MUTATION-ENVELOPE-PARITY (2026-07-12): return the partial-quantity
  // remaining holding when qty remains so iOS reflects the new state
  // without a refetch. holdingRemoved=true means the row is gone — no
  // holding field then.
  const remainingHolding = remainingQty > 0 ? composeHoldingWireShape(doc.holdings[id], undefined, wireEntitlementsFor(req)) : null;
  return res.json({
    message: "Holding sale recorded",
    sold: ledgerEntry,
    holdingRemoved: remainingQty <= 0,
    remainingQuantity: Math.max(0, remainingQty),
    holding: remainingHolding,
    entry: remainingHolding ? { holding: remainingHolding } : undefined,
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

  // CF-D1: case-insensitive lookup. Canonicalize once; subsequent ledger
  // idempotency comparison + holding mutate both use the canonical key.
  // For ledgers created pre-CF-D1, holdingId stored on the ledger entry
  // matches whatever case the doc.holdings key was at the time — the
  // VERIFY (14/14 lowercase) means existing ledger entries are also
  // lowercase, so the canonical-key comparison is sound on existing data.
  const canonicalHoldingId = findHoldingKey(doc, holdingId);

  // 1. Idempotency check — required per Step 3 decision #3 carry-forward.
  //    Replay must return the existing entry, not mutate, not throw.
  const existing = doc.ledger.find(
    (e) =>
      e.holdingId === (canonicalHoldingId ?? holdingId) &&
      e.source === "ebay" &&
      e.ebayOrderId === trimmedOrderId,
  );
  if (existing) {
    const currentHolding = canonicalHoldingId ? doc.holdings[canonicalHoldingId] : undefined;
    return {
      status: "marked-sold-deduped",
      entry: existing,
      holdingRemoved: !currentHolding,
      remainingQuantity: currentHolding ? toNumber(currentHolding.quantity, 0) : 0,
    };
  }

  // 2. Holding existence.
  if (!canonicalHoldingId) {
    return { status: "holding-not-found" };
  }
  const holding = doc.holdings[canonicalHoldingId];

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
  // starts true so downstream readers know the number is incomplete until
  // the axis check completes below (may auto-close via tryFinalizeReconciliation).
  const knownFeeSum = Object.values(granularFees).reduce<number>(
    (acc, v) => acc + (v ?? 0),
    0,
  );

  // CF-AUTO-RECONCILE-LAYER-1 (2026-07-12): detect the "no user costs" case
  // and auto-stamp the axis-2 marker. The vast majority of eBay sales are
  // buy-and-flip — no grading events, no supplies expenses recorded — and
  // making the user click Save with $0/$0 on every one adds silent friction.
  //
  // Safe when:
  //   - the holding has no heldExpenses[] entries (nothing user recorded)
  //   - AND no prior regrade action exists on the ledger for this holdingId
  //     (regrade sales cost the user grading fees; unsafe to zero)
  //
  // Distinguished from user-set by userCostsProvidedBy="system:auto-zero-costs".
  const heldExpensesCount = Array.isArray((holding as any).heldExpenses)
    ? (holding as any).heldExpenses.length
    : 0;
  const priorRegradeForHolding = doc.ledger.some(
    (e) => e.holdingId === canonicalHoldingId && (e as any).action === "regrade",
  );
  const autoZeroCostsSafe = heldExpensesCount === 0 && !priorRegradeForHolding;

  const initialGradingCost = data.gradingCost ?? (autoZeroCostsSafe ? 0 : null);
  const initialSuppliesCost = data.suppliesCost ?? (autoZeroCostsSafe ? 0 : null);
  const autoUserCostsProvidedAt = autoZeroCostsSafe ? new Date().toISOString() : undefined;
  const autoUserCostsProvidedBy = autoZeroCostsSafe ? "system:auto-zero-costs" : undefined;

  const needsReconciliation = netPayout === null && !allGranularKnown;

  // CF-PR-E-P&L-COST-RECOMPUTE: gradingCost + suppliesCost subtract from
  // netProceeds (same shape as actualShippingCost in granularFees — they're
  // cash-out costs that reduce returned proceeds). eBay-authoritative
  // netPayout is the post-platform-fee baseline; user-side costs (grading,
  // supplies) still subtract on top because eBay doesn't see them.
  //
  // CF-AUTO-RECONCILE-LAYER-1: `initialGradingCost` / `initialSuppliesCost`
  // are $0 when the auto-zero-costs heuristic fired above; null otherwise.
  const financials = computeLedgerFinancials({
    grossProceeds,
    feesTotal: knownFeeSum,
    tax: 0,
    shipping: 0,
    gradingCost: initialGradingCost,
    suppliesCost: initialSuppliesCost,
    costBasisSold,
    netPayoutOverride: netPayout,
  });

  // 5. Build ledger entry. Legacy aggregate fees/tax/shipping are 0 for
  //    eBay entries; the granular fields are the source of truth.
  const ledgerEntry: PortfolioLedgerEntry = {
    id: randomUUID(),
    userId,
    holdingId: canonicalHoldingId,
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
    suppliesCost: initialSuppliesCost,
    gradingCost: initialGradingCost,
    needsReconciliation,
    // CF-AUTO-RECONCILE-LAYER-1: auto-stamp axis-2 marker when safe.
    userCostsProvidedAt: autoUserCostsProvidedAt,
    userCostsProvidedBy: autoUserCostsProvidedBy,
    // CF-ERP-EXPANSION-#1 + #6: eBay webhook auto-populates the
    // sales-tracking axes. reconciledVia is "ebay_finances" only when the
    // Finances API has actually delivered the granular fees (i.e.
    // !needsReconciliation); otherwise left undefined and a downstream
    // POST /unreconciled/:id/override or the reconcile-on-enrich path
    // sets it.
    salesChannel: "ebay",
    paymentMethod: "ebay_managed",
    reconciledVia: needsReconciliation ? undefined : "ebay_finances",
    feeSource: needsReconciliation ? undefined : "ebay_finances",
  };

  // CF-AUTO-RECONCILE-LAYER-2 (2026-07-12): run tryFinalizeReconciliation on
  // the fresh entry. Closes it now if BOTH axes are met — Finances fees +
  // auto-stamped user costs are the common path. Recomputed needsReconciliation
  // flows through to the persist below.
  const finalizedEntry = tryFinalizeReconciliation(
    ledgerEntry as unknown as LedgerEntryForErp,
  ) as unknown as PortfolioLedgerEntry;
  Object.assign(ledgerEntry, finalizedEntry);

  // 6. Mutate holding state (mirrors sellHolding).
  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    // H-9: mirrors sellHolding — the trail dies with the holding.
    reapPriceTrail(doc, canonicalHoldingId);
    delete doc.holdings[canonicalHoldingId];
  } else {
    const updatedCostBasis = avgUnitCost * remainingQty;
    // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: same currentValue / P&L
    // writer-stop as sellHolding. Wire computes the post-sale display value
    // and P&L from cached fairMarketValue + the decremented quantity.
    doc.holdings[canonicalHoldingId] = {
      ...holding,
      quantity: remainingQty,
      purchasePrice: avgUnitCost,
      totalCostBasis: updatedCostBasis,
      lastUpdated: new Date().toISOString(),
    };
  }

  doc.ledger.push(ledgerEntry);
  await writeUserDoc(userId, doc);

  // CF-EBAY-SALE-COMP-EMIT (Drew, 2026-07-18): mirror sellHolding's
  // sold-comp emit so eBay-webhook-triggered sales ALSO feed the pool.
  // Previously only the manual /sell path emitted; this closes the
  // flywheel gap. Idempotent via {source}::{sourceExternalId} — replay
  // safe if the webhook fires twice.
  // CF-ONE-IDENTITY-IN-THE-POOL (D12a): the pinned slug, never the vendor id.
  // The sale is still marked sold either way; only the pool write is withheld.
  const poolIdentity = poolIdentityForHolding(holding);
  if (!poolIdentity.cardId && holding.playerName) {
    logUserCompWithheldNoIdentity("portfolioStore.markHoldingSoldFromEbay", userId, holding, poolIdentity);
  }
  if (poolIdentity.cardId && holding.playerName) {
    const ebaySoldCardId = poolIdentity.cardId;
    void (async () => {
      try {
        const { recordSoldComp } = await import("./soldCompsStore.service.js");
        await recordSoldComp({
          cardId: ebaySoldCardId,
          vendorCardId: poolIdentity.vendorCardId,
          playerName: String(holding.playerName ?? ""),
          cardYear: holding.cardYear ?? null,
          setName: holding.setName ?? null,
          parallel: holding.parallel ?? null,
          cardNumber: holding.cardNumber ?? null,
          isAuto: holding.isAuto === true,
          printRun: poolIdentity.printRun,
          gradeCompany: (holding as { gradeCompany?: string | null }).gradeCompany ?? null,
          gradeValue: (holding as { gradeValue?: number | null }).gradeValue ?? null,
          price: unitSalePrice,
          soldAt: data.saleConfirmedAt,
          source: "ebay-user-sale",
          sourceExternalId: trimmedOrderId,
          contributorUserId: userId,
          title: shimmedCardTitle(holding),
          imageUrl: (holding as { ebayImageUrl?: string | null }).ebayImageUrl ?? null,
          sellerHandle: null,
          verifiedByUser: true,
          confidence: 1.0,
        });
      } catch { /* comp emission never fails the sale */ }
    })();
  }

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
    cardId?: string;
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
    // CF-D1: case-insensitive lookup.
    const h = getHolding(doc, leg.holdingId);
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
    if (inc.cardId) {
      (newH as any).cardId = inc.cardId;
    }
    (newH as any).tradeId = tradeId;
    newHoldings.push(newH);
    incomingRecords.push({
      holdingId,
      cardId: inc.cardId,
      cardTitle: inc.cardTitle,
      grade: inc.grade,
      fmvAtTrade: inc.fmvAtTrade,
      fmvSource: inc.fmvSource,
    });
  }

  // Mutate doc atomically.
  for (const o of outgoingResolved) {
    // H-9: an outgoing side of a trade is gone; its trail goes with it. The
    // incoming holdings below are NEW ids and start their own trails.
    reapPriceTrail(doc, o.holding.id);
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

// ─── CF-PURCHASE-LEDGER-FOUNDATION (2026-07-12) ─────────────────────────────

/** Input shape accepted by recordPurchase — subset of PortfolioPurchaseEntry
 *  minus derived + server-owned fields (id, userId, createdAt, totalCost). */
export interface RecordPurchaseInput {
  purchaseDate: string;
  source: PurchaseSource;
  subtotal: number;
  tax?: number;
  shipping?: number;
  otherFees?: number;
  holdingIds?: string[];
  vendor?: string;
  invoiceRef?: string;
  notes?: string;
  ebayOrderId?: string;
  ebayTransactionId?: string;
  ebayItemId?: string;
}

/**
 * Idempotent purchase record. Idempotency key = (source, ebayOrderId) for
 * source==="ebay"; manual entries are ALWAYS new inserts (users choose to
 * record; caller-side dedup is out of scope).
 *
 * Returns the persisted entry PLUS a `replay` marker so the route can
 * decide whether to 200-with-existing or 201-new. Never throws.
 */
export interface RecordPurchaseResult {
  entry: PortfolioPurchaseEntry;
  replay: boolean;
}

// ─── D26: the eBay account sync's sold lines ───────────────────────────────

/** How the sale's identity was settled. */
export type EbayAccountSaleStatus =
  /** The matcher cleared the >= 0.9 bar. `cardId` is the identity. */
  | "resolved"
  /** The matcher answered below the bar. `proposedIdentity` is the candidate
   *  the user confirms or rejects; `cardId` is null. */
  | "parked"
  /** No answer at all — not a card, or the matcher was never asked. */
  | "unresolved";

/**
 * One sold order line from the connected eBay account.
 *
 * Keyed by (ebayOrderId, lineItemId): that pair is eBay's own identifier for a
 * sold line and it is what makes a replay a no-op, which the poll depends on
 * because its query window deliberately back-walks an hour on every cycle.
 */
export interface EbayAccountSaleEntry {
  /** `${ebayOrderId}::${lineItemId}` — the idempotency key, and the id. */
  id: string;
  ebayOrderId: string;
  lineItemId: string;
  ebayListingId: string | null;
  /** ISO — when eBay says the order was created. */
  soldAt: string;
  /** ISO — when this row was first written. */
  observedAt: string;
  title: string | null;
  quantity: number;
  /** Gross unit sale price. Fees belong on the holding's P&L, not here. */
  unitSalePrice: number;
  currency: string | null;
  buyerUsername: string | null;

  status: EbayAccountSaleStatus;
  /** The resolved catalog slug. Null unless `status === "resolved"`. */
  cardId: string | null;
  /** The parked candidate — same shape as `proposedIdentity` on the holding
   *  wire (CF-SURFACE-THE-PARKED-MATCH), so a client that already renders one
   *  renders the other. Null when there is nothing to propose. */
  proposedIdentity: { slug: string; confidence: number | null; matchedBy: string | null } | null;
  /** Why nothing resolved. Null when it did. */
  unresolvedReason: string | null;

  /** What the matcher was asked with — the user's confirm screen shows this. */
  fields: {
    sport: string | null;
    year: number | null;
    setName: string | null;
    player: string | null;
    cardNumber: string | null;
    parallel: string | null;
    isAuto: boolean;
    printRun: number | null;
    gradeCompany: string | null;
    gradeValue: number | null;
  };
  imageUrl: string | null;

  /** The holding this sale was matched to and marked sold, when there was one. */
  holdingId: string | null;
  /** How the holding was found — provenance for the three-step ladder. */
  holdingMatchedBy: "listing-id" | "identity-and-grade" | "identity-ungraded" | null;
  /** The pool row this sale is in, and which path put it there. */
  poolRowId: string | null;
  poolWrittenBy: "holding-ledger" | "ebay-account" | null;
}

export interface UpsertEbayAccountSaleResult {
  entry: EbayAccountSaleEntry;
  /** True when an entry for this (orderId, lineItemId) already existed. */
  replay: boolean;
  /** True when the doc was actually written. A replay whose fields are
   *  unchanged writes nothing — the poll re-reads the same 29 orders every
   *  hour and must not rewrite eight docs an hour for no reason. */
  written: boolean;
}

/** The idempotency key. Exported so the backfill and the tests build it the
 *  same way rather than each spelling the separator their own way. */
export function ebayAccountSaleId(ebayOrderId: string, lineItemId: string): string {
  return `${String(ebayOrderId ?? "").trim()}::${String(lineItemId ?? "").trim()}`;
}

/** Fields the poll may refresh on a replay. Everything else is first-write. */
type EbayAccountSaleUpdate = Omit<EbayAccountSaleEntry, "id" | "observedAt">;

/**
 * The ceiling on how many account sales ride on one user doc.
 *
 * A Cosmos document is capped at 2 MB and this array lives on the SAME doc as
 * the user's holdings, ledger, purchases and price history. A Pro Seller doing
 * 500 sales a month would add ~1,500 entries over the backfill's 90-day window
 * at roughly 450 bytes each -- about 0.7 MB of a budget that is already spoken
 * for. So the array is bounded: the newest EBAY_ACCOUNT_SALES_MAX by sale date
 * are kept and older ones are dropped.
 *
 * Nothing is lost that matters. The SALE itself lives in `sold_comps` and in
 * the ledger; this array is the sync's working record -- what we saw, how we
 * resolved it, and what is still waiting on the user's confirm. If this ever
 * needs to be unbounded it wants its own container, not a bigger user doc.
 */
export const EBAY_ACCOUNT_SALES_MAX = Math.max(
  100,
  Number(process.env.EBAY_ACCOUNT_SALES_MAX ?? 1000) || 1000,
);

/** Newest-first by sale date, capped. Returns the array to store. */
function capAccountSales(sales: EbayAccountSaleEntry[]): EbayAccountSaleEntry[] {
  if (sales.length <= EBAY_ACCOUNT_SALES_MAX) return sales;
  const sorted = [...sales].sort((a, b) => String(b.soldAt ?? "").localeCompare(String(a.soldAt ?? "")));
  const kept = sorted.slice(0, EBAY_ACCOUNT_SALES_MAX);
  console.warn(JSON.stringify({
    event: "ebay_account_sales_pruned",
    source: "portfolioStore.upsertEbayAccountSale",
    kept: kept.length,
    dropped: sales.length - kept.length,
    detail: "oldest account-sale records dropped to keep the user doc under the Cosmos 2MB ceiling; the sales themselves are in sold_comps and the ledger",
  }));
  return kept;
}

/**
 * Write (or refresh) one account sale on the user's doc. Idempotent on
 * (ebayOrderId, lineItemId).
 *
 * A replay refreshes the resolution — the catalog gains checklists, so a line
 * that parked last week can resolve this week and must be allowed to — but it
 * NEVER rewrites `observedAt`, and it writes nothing at all when the outcome
 * is identical to what is stored.
 */
export async function upsertEbayAccountSale(
  userId: string,
  update: EbayAccountSaleUpdate,
): Promise<UpsertEbayAccountSaleResult> {
  const id = ebayAccountSaleId(update.ebayOrderId, update.lineItemId);
  const doc = await readUserDoc(userId);
  const sales = doc.ebayAccountSales ?? [];
  const idx = sales.findIndex((e) => e?.id === id);
  const now = new Date().toISOString();

  if (idx >= 0) {
    const prev = sales[idx];
    const next: EbayAccountSaleEntry = { ...update, id, observedAt: prev.observedAt ?? now };
    if (JSON.stringify(prev) === JSON.stringify(next)) {
      return { entry: prev, replay: true, written: false };
    }
    sales[idx] = next;
    doc.ebayAccountSales = capAccountSales(sales);
    await writeUserDoc(userId, doc);
    return { entry: next, replay: true, written: true };
  }

  const entry: EbayAccountSaleEntry = { ...update, id, observedAt: now };
  sales.push(entry);
  doc.ebayAccountSales = capAccountSales(sales);
  await writeUserDoc(userId, doc);
  return { entry, replay: false, written: true };
}

/** Read a user's account sales — newest first. The account page's
 *  "eBay sales we saw" list, and the confirm queue for the parked ones. */
export async function listEbayAccountSales(
  userId: string,
  opts: { status?: EbayAccountSaleStatus; limit?: number } = {},
): Promise<EbayAccountSaleEntry[]> {
  const doc = await readUserDoc(userId);
  const all = (doc.ebayAccountSales ?? []).filter((e) => !!e);
  const filtered = opts.status ? all.filter((e) => e.status === opts.status) : all;
  filtered.sort((a, b) => String(b.soldAt ?? "").localeCompare(String(a.soldAt ?? "")));
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  return filtered.slice(0, limit);
}

/** Where the seller's holding for a sale was found. */
export interface SellerHoldingMatch {
  holdingId: string;
  holding: PortfolioHolding;
  matchedBy: "identity-and-grade" | "identity-ungraded";
  /** How many holdings the walk actually examined. A guard that cannot say
   *  what it looked at is not a guard (`JOIN h IN c.holdings` iterates
   *  nothing — this walks `Object.values`). */
  holdingsWalked: number;
}

const gradeNumOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const gradeCoOf = (v: unknown): string | null => {
  const g = String(v ?? "").trim().toUpperCase();
  return g ? g : null;
};

/**
 * D26 deliverable 3. Find the SELLER's own active holding for a resolved
 * identity, when the listing id did not already name one.
 *
 * The ladder, most specific first:
 *   1. exact identity + the same grade (a PSA 10 sells the PSA 10)
 *   2. the same identity, un-graded (a raw copy)
 *
 * Step 0 — the holding carrying the listing id — is the CALLER's, because that
 * lookup is cross-user (`findHoldingByEbayListingIdAcrossUsers`) and this one
 * deliberately is not: another user's card is not this seller's inventory.
 *
 * Returns null when the user holds no such card, which is not a failure: the
 * sale still records to the pool and still shows in their sales history.
 */
export async function findSellerHoldingForIdentity(
  userId: string,
  slug: string,
  grade: { gradeCompany?: string | null; gradeValue?: number | null } = {},
): Promise<SellerHoldingMatch | null> {
  const wanted = String(slug ?? "").trim();
  if (!userId || !wanted) return null;

  const doc = await readUserDoc(userId);
  // `doc.holdings` is a MAP keyed by holding id. Walk its values.
  const entries = Object.entries(doc.holdings ?? {});
  const holdingsWalked = entries.length;
  if (holdingsWalked === 0) {
    console.log(JSON.stringify({
      event: "ebay_account_seller_holding_walk",
      source: "portfolioStore.findSellerHoldingForIdentity",
      userId,
      slug: wanted,
      holdingsWalked: 0,
      detail: "user holds nothing; no holding can match",
    }));
    return null;
  }

  const wantCo = gradeCoOf(grade.gradeCompany);
  const wantVal = gradeNumOf(grade.gradeValue);

  let ungraded: SellerHoldingMatch | null = null;
  for (const [holdingId, holding] of entries) {
    if (!holding) continue;
    if (poolIdentityForHolding(holding).cardId !== wanted) continue;
    const hCo = gradeCoOf((holding as { gradeCompany?: unknown }).gradeCompany);
    const hVal = gradeNumOf((holding as { gradeValue?: unknown }).gradeValue);
    if (wantCo && hCo === wantCo && hVal === wantVal) {
      return { holdingId, holding, matchedBy: "identity-and-grade", holdingsWalked };
    }
    if (!wantCo && !hCo) {
      return { holdingId, holding, matchedBy: "identity-and-grade", holdingsWalked };
    }
    if (!hCo && !ungraded) {
      ungraded = { holdingId, holding, matchedBy: "identity-ungraded", holdingsWalked };
    }
  }
  return ungraded;
}

export async function recordPurchase(
  userId: string,
  input: RecordPurchaseInput,
): Promise<RecordPurchaseResult> {
  const doc = await readUserDoc(userId);
  const purchases = doc.purchases ?? [];

  // Idempotency on (source, ebayOrderId) for eBay imports.
  if (input.source === "ebay" && input.ebayOrderId) {
    const existing = purchases.find(
      (p) => p.source === "ebay" && p.ebayOrderId === input.ebayOrderId,
    );
    if (existing) {
      return { entry: existing, replay: true };
    }
  }

  const now = new Date().toISOString();
  const subtotal = Number(input.subtotal) || 0;
  const tax = Number(input.tax ?? 0) || 0;
  const shipping = Number(input.shipping ?? 0) || 0;
  const otherFees = Number(input.otherFees ?? 0) || 0;
  const totalCost = Math.round((subtotal + tax + shipping + otherFees) * 100) / 100;

  const entry: PortfolioPurchaseEntry = {
    id: randomUUID(),
    userId,
    purchaseDate: input.purchaseDate,
    source: input.source,
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    shipping: Math.round(shipping * 100) / 100,
    otherFees: Math.round(otherFees * 100) / 100,
    totalCost,
    holdingIds: Array.isArray(input.holdingIds) ? [...input.holdingIds] : [],
    ...(input.vendor ? { vendor: input.vendor } : {}),
    ...(input.invoiceRef ? { invoiceRef: input.invoiceRef } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.ebayOrderId ? { ebayOrderId: input.ebayOrderId } : {}),
    ...(input.ebayTransactionId ? { ebayTransactionId: input.ebayTransactionId } : {}),
    ...(input.ebayItemId ? { ebayItemId: input.ebayItemId } : {}),
    createdAt: now,
  };

  doc.purchases = [...purchases, entry];
  await writeUserDoc(userId, doc);
  return { entry, replay: false };
}

export async function listPurchasesForUser(
  userId: string,
  opts: { from?: string; to?: string; source?: PurchaseSource } = {},
): Promise<PortfolioPurchaseEntry[]> {
  const doc = await readUserDoc(userId);
  const all = doc.purchases ?? [];
  let filtered = all;
  if (opts.from) {
    const fromDate = opts.from.slice(0, 10);
    filtered = filtered.filter((p) => p.purchaseDate.slice(0, 10) >= fromDate);
  }
  if (opts.to) {
    const toDate = opts.to.slice(0, 10);
    filtered = filtered.filter((p) => p.purchaseDate.slice(0, 10) <= toDate);
  }
  if (opts.source) {
    filtered = filtered.filter((p) => p.source === opts.source);
  }
  // Newest first, matches sales ledger convention (listTradesForUser).
  return [...filtered].sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));
}

export async function getPurchaseForUser(
  userId: string,
  purchaseId: string,
): Promise<PortfolioPurchaseEntry | null> {
  const doc = await readUserDoc(userId);
  return (doc.purchases ?? []).find((p) => p.id === purchaseId) ?? null;
}

/**
 * Append holdingIds to an existing purchase's attribution array. Used when
 * a user records a purchase FIRST (via /erp/purchases) and cataloges the
 * cards later. Idempotent: existing holdingIds are not duplicated.
 */
export async function linkHoldingsToPurchase(
  userId: string,
  purchaseId: string,
  holdingIds: string[],
): Promise<PortfolioPurchaseEntry | null> {
  const doc = await readUserDoc(userId);
  const purchases = doc.purchases ?? [];
  const idx = purchases.findIndex((p) => p.id === purchaseId);
  if (idx === -1) return null;
  const existing = purchases[idx];
  const merged = new Set([...existing.holdingIds, ...holdingIds.filter(Boolean)]);
  const updated: PortfolioPurchaseEntry = {
    ...existing,
    holdingIds: [...merged],
    updatedAt: new Date().toISOString(),
  };
  purchases[idx] = updated;
  doc.purchases = purchases;
  await writeUserDoc(userId, doc);
  return updated;
}

// ─── CF-HELD-EXPENSES (2026-07-12) ─────────────────────────────────────────

const VALID_HELD_EXPENSE_KINDS: ReadonlySet<HeldExpenseKind> = new Set([
  "grading",
  "supplies",
  "shipping_to_grader",
  "insurance",
  "storage",
  "other",
]);

export interface AddHeldExpenseInput {
  kind: HeldExpenseKind;
  amount: number;             // positive dollars
  incurredAt?: string;        // ISO; defaults to now
  notes?: string;
  invoiceRef?: string;
}

export interface AddHeldExpenseResult {
  status: "added" | "holding-not-found" | "invalid-input";
  reason?: string;
  holding?: PortfolioHolding;
  expense?: HoldingHeldExpense;
  newTotalCostBasis?: number;
}

/**
 * Append an expense to a held card and roll the amount into totalCostBasis
 * so the eventual sale's realizedProfitLoss reflects true all-in cost.
 *
 * Same integer-math pattern as regradeHolding's gradingCost roll-in
 * (portfolioStore.service.ts:3729-3735):
 *
 *   new totalCostBasis = old + expense.amount
 *   purchasePrice is NOT touched (that's per-unit acquisition price)
 *
 * Idempotency: NONE. Same expense recorded twice = two separate entries
 * (matches the audit-trail intent — a re-grading really did happen twice).
 * If callers need dedup they can pass an invoiceRef and check against
 * existing entries client-side before POSTing.
 */
export async function addHeldExpense(
  userId: string,
  holdingId: string,
  input: AddHeldExpenseInput,
): Promise<AddHeldExpenseResult> {
  if (!VALID_HELD_EXPENSE_KINDS.has(input.kind)) {
    return { status: "invalid-input", reason: `kind must be one of: ${[...VALID_HELD_EXPENSE_KINDS].join(", ")}` };
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: "invalid-input", reason: "amount must be a positive number" };
  }
  const doc = await readUserDoc(userId);
  const canonicalId = findHoldingKey(doc, holdingId);
  if (!canonicalId) return { status: "holding-not-found" };
  const holding = doc.holdings[canonicalId];

  const nowIso = new Date().toISOString();
  const incurredAt = input.incurredAt
    ? new Date(input.incurredAt).toISOString()
    : nowIso;

  const expense: HoldingHeldExpense = {
    id: randomUUID(),
    kind: input.kind,
    amount: Math.round(amount * 100) / 100,
    incurredAt,
    createdAt: nowIso,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.invoiceRef ? { invoiceRef: input.invoiceRef } : {}),
  };

  const priorCostBasis = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * toNumber(holding.quantity, 1));
  const newCostBasis = Math.round((priorCostBasis + expense.amount) * 100) / 100;

  const updated: PortfolioHolding = {
    ...holding,
    heldExpenses: [...(holding.heldExpenses ?? []), expense],
    totalCostBasis: newCostBasis,
    lastUpdated: nowIso,
  };
  doc.holdings[canonicalId] = updated;
  await writeUserDoc(userId, doc);
  return {
    status: "added",
    holding: updated,
    expense,
    newTotalCostBasis: newCostBasis,
  };
}

export interface DeleteHeldExpenseResult {
  status: "deleted" | "holding-not-found" | "expense-not-found";
  holding?: PortfolioHolding;
  newTotalCostBasis?: number;
}

/**
 * Remove an expense entry and reverse its cost-basis contribution. Same
 * integer-math treatment as addHeldExpense in reverse. If the reversal
 * would push totalCostBasis below the sum of remaining expenses + the
 * base acquisition cost, we clamp to a floor of zero (defense — this
 * shouldn't happen with clean writes, but a mismatched delete after
 * hand-edited data shouldn't corrupt further math).
 */
export async function deleteHeldExpense(
  userId: string,
  holdingId: string,
  expenseId: string,
): Promise<DeleteHeldExpenseResult> {
  const doc = await readUserDoc(userId);
  const canonicalId = findHoldingKey(doc, holdingId);
  if (!canonicalId) return { status: "holding-not-found" };
  const holding = doc.holdings[canonicalId];
  const expenses = holding.heldExpenses ?? [];
  const idx = expenses.findIndex((e) => e.id === expenseId);
  if (idx === -1) return { status: "expense-not-found" };

  const removed = expenses[idx];
  const remaining = expenses.filter((_, i) => i !== idx);
  const priorCostBasis = toNumber(holding.totalCostBasis, 0);
  const newCostBasis = Math.max(0, Math.round((priorCostBasis - removed.amount) * 100) / 100);

  const updated: PortfolioHolding = {
    ...holding,
    heldExpenses: remaining,
    totalCostBasis: newCostBasis,
    lastUpdated: new Date().toISOString(),
  };
  doc.holdings[canonicalId] = updated;
  await writeUserDoc(userId, doc);
  return { status: "deleted", holding: updated, newTotalCostBasis: newCostBasis };
}

// HTTP handlers wrap the pure service above.

export async function addHeldExpenseHandler(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const holdingId = String(req.params.id ?? "").trim();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kindRaw = typeof body.kind === "string" ? body.kind : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  const incurredAt = typeof body.incurredAt === "string" ? body.incurredAt : undefined;
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : undefined;
  const invoiceRef = typeof body.invoiceRef === "string" && body.invoiceRef.trim() ? body.invoiceRef.trim().slice(0, 200) : undefined;

  const result = await addHeldExpense(auth.userId, holdingId, {
    kind: kindRaw as HeldExpenseKind,
    amount,
    incurredAt,
    notes,
    invoiceRef,
  });
  if (result.status === "holding-not-found") {
    return res.status(404).json({ success: false, error: "Holding not found" });
  }
  if (result.status === "invalid-input") {
    return res.status(400).json({ success: false, error: result.reason });
  }
  // CF-MUTATION-ENVELOPE-PARITY (2026-07-12): entry.holding for iOS decoder.
  const holdingWire = result.holding ? composeHoldingWireShape(result.holding, undefined, wireEntitlementsFor(req)) : null;
  res.status(201).json({
    success: true,
    expense: result.expense,
    holding: holdingWire,
    entry: holdingWire ? { holding: holdingWire } : undefined,
    newTotalCostBasis: result.newTotalCostBasis,
  });
}

export async function deleteHeldExpenseHandler(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const holdingId = String(req.params.id ?? "").trim();
  const expenseId = String(req.params.expenseId ?? "").trim();
  const result = await deleteHeldExpense(auth.userId, holdingId, expenseId);
  if (result.status === "holding-not-found") {
    return res.status(404).json({ success: false, error: "Holding not found" });
  }
  if (result.status === "expense-not-found") {
    return res.status(404).json({ success: false, error: "Expense not found" });
  }
  // CF-MUTATION-ENVELOPE-PARITY (2026-07-12): entry.holding for iOS decoder.
  const holdingWire = result.holding ? composeHoldingWireShape(result.holding, undefined, wireEntitlementsFor(req)) : null;
  res.json({
    success: true,
    holding: holdingWire,
    entry: holdingWire ? { holding: holdingWire } : undefined,
    newTotalCostBasis: result.newTotalCostBasis,
  });
}

export async function listHeldExpensesHandler(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const holdingId = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  const canonicalId = findHoldingKey(doc, holdingId);
  if (!canonicalId) return res.status(404).json({ success: false, error: "Holding not found" });
  const expenses = doc.holdings[canonicalId].heldExpenses ?? [];
  const total = Math.round(expenses.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  res.json({ success: true, expenses, total });
}

export async function refreshHolding(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const rawId = String(req.params.id ?? "").trim();
  const doc = await readUserDoc(auth.userId);
  // CF-D1: case-insensitive lookup; mutate via the canonical stored key.
  const id = findHoldingKey(doc, rawId);
  if (!id) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  const holding = doc.holdings[id];

  doc.holdings[id] = await populateCardsightGradeId(holding);

  try {
    await autoPriceHolding(doc, doc.holdings[id], doc.holdings[id], "refresh", auth.userId);
  } catch {
    doc.holdings[id].lastUpdated = new Date().toISOString();
  }
  await writeUserDoc(auth.userId, doc);
  // CF-MUTATION-ENVELOPE-PARITY (2026-07-12): return the refreshed holding
  // so iOS shows the new price without a refetch.
  const refreshedWire = composeHoldingWireShape(doc.holdings[id], undefined, wireEntitlementsFor(req));
  res.json({
    message: "Holding refreshed",
    id,
    holding: refreshedWire,
    entry: { holding: refreshedWire },
  });
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
    cardId?: string | null;
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
  /**
   * CF-A-FRESHNESS-SKIP-MUST-SEE-POOL-GROWTH (C-2 verifier, 2026-09-03).
   *
   * When true, `minHoldingAgeMs` alone may NOT skip a holding: a fresh holding
   * whose exact pool has GROWN since its value was written is repriced anyway.
   * Age is a proxy for "nothing has changed", and the audit's own finding is
   * the counter-example — 28 of 118 holdings sat on pools that had grown since
   * their value was written, several of them recently priced. A cadence that
   * skips on age alone re-creates the staleness it exists to remove, quietly,
   * on exactly the cards where a new sale just landed.
   *
   * The pool count is read from the holding's own persisted
   * `pricingSourceMeta.compsUsed` and compared against a live count for the
   * same identity. A holding with no persisted count is never skipped — an
   * unknown pool is not evidence of an unchanged one.
   */
  skipFreshOnlyWhenPoolUnchanged?: boolean;
}

// In-process per-user reprice timestamps for throttle. Survives only within a
// single Node process; that's intentional — Cosmos already has lastUpdated
// per holding, this is just a cheap guard against pull-to-refresh spam from
// the same client hitting the same instance.
const _lastRepriceAt = new Map<string, number>();

/**
 * CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): read accessor so the HTTP handler
 * can apply the same per-user throttle synchronously — answering a spamming
 * client without spawning a background run that would only short-circuit.
 */
export function getLastRepriceAt(userId: string): number | undefined {
  return _lastRepriceAt.get(userId);
}

/**
 * CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): the throttle decision,
 * as a pure function so it can be pinned without Cosmos or two processes.
 *
 * Takes BOTH candidate markers and uses the more recent:
 *
 *   inProcessAt — `_lastRepriceAt` on THIS worker. Fast, and correct
 *                 whenever the previous open happened to land here.
 *   persistedAt — `lastRepriceDispatchAt` off the user doc. Shared by
 *                 every worker, which is the whole point: an open that
 *                 load-balances onto the instance that has never seen
 *                 this user still sees that a run started 40s ago.
 *
 * Max, not "prefer one": the persisted marker is stamped at dispatch and
 * the in-process one at completion, so on a single worker mid-run the
 * persisted value is the newer of the two, and after a run completes the
 * in-process one is. Taking the max means neither ordering can produce a
 * throttle window shorter than intended.
 *
 * Returns the decision AND the timestamp it was made against, so the skip
 * response can say fresh-as-of instead of a bare "throttled" — a client
 * told only "no" cannot tell a working system from a broken one.
 */
export function evaluateRepriceThrottle(args: {
  inProcessAt?: number | null;
  persistedAt?: number | null;
  throttleMs: number;
  now?: number;
}): {
  throttled: boolean;
  /** The marker the decision was made against, ms epoch; null if none. */
  lastAt: number | null;
  /** ms until the throttle lifts; 0 when not throttled. */
  retryAfterMs: number;
} {
  const now = args.now ?? Date.now();
  const candidates = [args.inProcessAt, args.persistedAt].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0,
  );
  const lastAt = candidates.length > 0 ? Math.max(...candidates) : null;
  if (args.throttleMs <= 0 || lastAt === null) {
    return { throttled: false, lastAt, retryAfterMs: 0 };
  }
  const elapsed = now - lastAt;
  // A marker from the future (clock skew between instances) must not throttle
  // forever — treat anything not strictly inside the window as passable.
  if (elapsed < 0 || elapsed >= args.throttleMs) {
    return { throttled: false, lastAt, retryAfterMs: 0 };
  }
  return { throttled: true, lastAt, retryAfterMs: args.throttleMs - elapsed };
}

/**
 * CF-PORTFOLIO-FRESH-ON-OPEN (2026-09-02): read the durable dispatch marker.
 *
 * Reads the user doc, which readUserDoc serves from its cache on the hot
 * path — the same doc the reprice is about to read anyway. Never throws:
 * a Cosmos hiccup degrades the throttle to in-process-only (the previous
 * behaviour), it does not fail the open.
 */
export async function readPersistedRepriceDispatchAt(
  userId: string,
): Promise<number | null> {
  try {
    const doc = await readUserDoc(userId);
    const t = doc.lastRepriceDispatchAt;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reprice_throttle_marker_read_failed",
        source: "portfolioStore.service",
        userId,
        error: (err as Error)?.message ?? String(err),
      }),
    );
    return null;
  }
}

/**
 * CF-PORTFOLIO-FRESH-ON-OPEN (2026-09-02): stamp the durable dispatch marker.
 *
 * Called at DISPATCH, before the pricing work — see the field's doc comment
 * for why completion would be too late. Best-effort: if this write fails the
 * run still proceeds (the in-process marker still guards the common case),
 * so a marker write can never cost the user their refresh.
 */
export async function stampRepriceDispatchMarker(
  userId: string,
  now = Date.now(),
): Promise<void> {
  try {
    const doc = await readUserDoc(userId);
    doc.lastRepriceDispatchAt = now;
    await writeUserDoc(userId, doc);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reprice_throttle_marker_write_failed",
        source: "portfolioStore.service",
        userId,
        error: (err as Error)?.message ?? String(err),
      }),
    );
  }
}

/**
 * CF-REVIEW-QUEUE-CLEAN-DATA (2026-07-12): reprice ONE holding immediately.
 * Called fire-and-forget after a review-queue confirm with a picked cardId
 * so the user sees the clean data reflected in inventory pricing without
 * waiting for the next scheduled batch reprice (6h cadence).
 *
 * Fails silently — the scheduled job is the guaranteed catch-all. Returns
 * boolean for callers that want to log success/failure.
 */
export async function repriceOneHolding(userId: string, holdingId: string): Promise<boolean> {
  if (!userId || !holdingId) return false;
  const doc = await readUserDoc(userId);
  const holding = doc.holdings?.[holdingId];
  if (!holding) return false;
  try {
    const priced = await autoPriceHolding(doc, holding, undefined, "refresh", userId);
    doc.holdings[holdingId] = priced;
    await writeUserDoc(userId, doc);
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reprice_one_holding_error",
        source: "portfolioStore.service",
        userId,
        holdingId,
        error: (err as Error)?.message ?? String(err),
      }),
    );
    return false;
  }
}

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
    let fresh = candidates.filter((h) => ageMs(h) < minAge);
    let stale = candidates.filter((h) => ageMs(h) >= minAge);

    // CF-A-FRESHNESS-SKIP-MUST-SEE-POOL-GROWTH (C-2 verifier, 2026-09-03).
    // Age alone is not evidence that nothing changed. A fresh holding whose
    // exact pool has GROWN since its value was written is repriced anyway —
    // that growth is precisely a new sale of this card, the event the cadence
    // exists to react to. Rescuing them costs ONE partition-keyed COUNT per
    // fresh holding (3.42 RU measured), which is the whole point of the trade:
    // the nightly bill becomes proportional to CHANGE rather than to corpus.
    //
    // Fails OPEN in every ambiguous case — a holding is skipped only on
    // positive evidence that its pool is unchanged:
    //   no persisted compsUsed  -> reprice (an unknown pool is not an
    //                              unchanged one)
    //   no identity candidates  -> reprice
    //   count came back 0       -> reprice (countExactSalesInWindow returns 0
    //                              on a query ERROR as well as on a genuinely
    //                              empty pool; a throttled Cosmos must never
    //                              read as "nothing changed")
    //   live count > persisted  -> reprice (the pool grew)
    if (opts.skipFreshOnlyWhenPoolUnchanged && fresh.length > 0) {
      const rescued: PortfolioHolding[] = [];
      const stillFresh: PortfolioHolding[] = [];
      for (const h of fresh) {
        let poolUnchanged = false;
        try {
          const persistedCount = (h as { pricingSourceMeta?: { compsUsed?: unknown } })
            .pricingSourceMeta?.compsUsed;
          const known = typeof persistedCount === "number" && Number.isFinite(persistedCount) && persistedCount > 0;
          if (known) {
            const ids = exactIdentityCandidates(h as HoldingIdentityFields);
            if (ids.length > 0) {
              const counts = await countExactSalesInWindow(ids);
              const live = Math.max(0, ...ids.map((id) => counts[id] ?? 0));
              // `live > 0` guards the error-returns-0 case above.
              poolUnchanged = live > 0 && live <= (persistedCount as number);
            }
          }
        } catch {
          poolUnchanged = false;  // any failure reprices; never skips
        }
        (poolUnchanged ? stillFresh : rescued).push(h);
      }
      if (rescued.length > 0) {
        console.log(JSON.stringify({
          event: "reprice_fresh_rescued_by_pool_growth",
          source: "portfolioStore.repriceHoldingsForUser",
          userId,
          rescued: rescued.length,
          stillFresh: stillFresh.length,
        }));
      }
      fresh = stillFresh;
      stale = [...stale, ...rescued].sort((a, b) => ageMs(b) - ageMs(a));
    }

    freshSkipped = fresh.length;
    candidates = stale;
  }
  if (opts.maxHoldings && opts.maxHoldings > 0 && candidates.length > opts.maxHoldings) {
    candidates = candidates.slice(0, opts.maxHoldings);
  }

  let repriced = 0;
  let skipped = 0;
  const updates: BatchRepriceResult["updates"] = [];

  // CF-A-SWING-IS-NOT-A-MARKET (2026-09-01). The value each candidate carried
  // BEFORE this cycle, so the post-loop sweep can see a pool-composition flap.
  // Captured here because the loop has a dozen write sites, each with its own
  // `continue`; the previous value is the one thing they all overwrite.
  const priorFmv = new Map<string, number | null>();
  for (const h of candidates) priorFmv.set(h.id, perUnitFmvForSwing(h));

  // CF-USER-PRICE-ALERTS (Drew, 2026-09-02): the pre-cycle (value, rung) pair
  // per holding, for the post-write move-alert sweep below. The rung is
  // captured HERE, alongside priorFmv, for the same reason priorFmv is: the
  // dozen write sites in the loop each overwrite it, and a move alert has to
  // know whether BOTH ends of its comparison read the exact pool before it
  // can call the move observed.
  const priorAlertState = new Map<string, { fairMarketValue: number | null; fmvRung: string | null; lastUpdated: string | number | null }>();
  for (const h of candidates) {
    priorAlertState.set(h.id, {
      fairMarketValue: typeof h.fairMarketValue === "number" ? h.fairMarketValue : null,
      fmvRung: (h as { fmvRung?: string | null }).fmvRung ?? null,
      lastUpdated: (h as { lastUpdated?: string | number | null }).lastUpdated ?? null,
    });
  }

  for (const holding of candidates) {
    // CF-EBAY-REVIEW-QUEUE (2026-07-12): skip pending-review rows. Those
    // aren't real inventory yet — pricing them would fire the CompIQ
    // engine with polluted / unconfirmed inputs, exactly what the review
    // gate exists to prevent.
    if ((holding as any).cardStatus === "pending-review") {
      skipped += 1;
      updates.push({
        id: holding.id,
        status: "skipped",
        reason: "pending-review (awaiting user confirmation)",
        cardId: null,
      });
      continue;
    }
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
    const reprCsid = String((holding as any).cardId ?? "").trim();
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
        reason: "missing_card_identity (cardYear=null AND cardId=null)",
        cardId: null,
      });
      continue;
    }
    try {
      // CF-ONE-VALUATION-PATH (D17, 2026-08-30). FIRST: the ONE valuation
      // entry, as at autoPriceHolding — the batch and the on-demand path
      // persist the same number the card page serves. The legacy exact-pool
      // reads below run only when the catalog holds no identity for the
      // holding; an unpriced resolved identity walks the gated estimate
      // chain only.
      const bOneEntry = await valueHoldingThroughOneEntry(holding, { userId, caller: "repriceHoldingsForUser.one-entry" });
      if (bOneEntry.outcome === "observed" || bOneEntry.outcome === "estimated") {
        // CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01). This is the 6h
        // cron's own one-valuation-path exit, and it appended NOTHING — which
        // is why the measured oscillations left no trail to compare against.
        // Observed points append as they always did elsewhere; estimated ones
        // append tagged, and observedPricePoints() keeps existing readers on
        // the observed trail.
        const bFmv = bOneEntry.valuation.fairMarketValue;
        if (typeof bFmv === "number" && Number.isFinite(bFmv)) {
          appendPriceHistory(doc, holding.id, {
            at: (bOneEntry.holding.lastUpdated as string) ?? new Date().toISOString(),
            value: bFmv,
            source,
            ...(bOneEntry.outcome === "estimated" ? { valuationStatus: "estimated" as const } : {}),
            // CF-A-MOVER-NEEDS-CORROBORATION: same stamp as the single-holding
            // one-entry site; the batch reprice writes the bulk of the trail.
            ...(typeof bOneEntry.valuation.rungLabel === "string" && bOneEntry.valuation.rungLabel
              ? { rungLabel: bOneEntry.valuation.rungLabel }
              : {}),
          });
        }
        evaluateHoldingAlerts(doc, doc.holdings[holding.id], bOneEntry.holding);
        doc.holdings[holding.id] = bOneEntry.holding;
        repriced += 1;
        updates.push({ id: holding.id, status: "repriced", reason: `one-valuation-path:${bOneEntry.valuation.rungLabel}` });
        continue;
      }
      // CF-A-REFUSED-PRICE-IS-STILL-A-DECISION (2026-09-04). The cost-basis
      // floor is the ONE outcome of the one valuation path that wrote
      // NOTHING. Its own doctrine comment said so — "nothing written, the
      // caller falls through" — and the fall-through is exactly how a bare
      // number with no meta reached prod.
      //
      // Measured read-only after the sanctioned reprice (run 33893507773,
      // user user-199fcbc9): 41 of 43 holdings carry a
      // `pricingSourceMeta.method` and TWO do not. Both are floor rejections
      // from THIS run, and they are the only two:
      //
      //   9f082213  Victor Figueroa CPA-VF Black & White Red Ink auto, raw,
      //             $278.60 basis. The ladder returned $8.70 under
      //             `exact-pool-projection`; the floor rejected it (3.1% of
      //             basis). The row fell through to the confidence-gated
      //             retention branch, which faithfully re-stated the prior
      //             pass's pre-C-7 meta — `{slug, compsUsed: 1}`, no method,
      //             no confidence, no labels — and stamped a fresh
      //             `lastUpdated`. Live: fairMarketValue 11, fmvRung null.
      //   277b05a3  Cal Ripken Jr. 1997 Metal Universe #8 PSA 8, $52.98
      //             basis, proposed $5.40 under `exact-pool-weighted-median`.
      //             Identical shape, meta `{compsUsed: 50}`.
      //
      // The floor was RIGHT in both cases. 9f082213's slug pool holds 57 rows
      // of which exactly one ($270) is a Black & White Red Ink sale — the
      // other 56 are plain base Chrome prospect autos at $5-$20, mis-slugged
      // onto the SSP row. Per Drew's 2026-08-30 ruling the Red Ink IS a
      // distinct card with its own row, and the row exists
      // (`hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto`,
      // source `user-verified`) — its POOL is contaminated. $8.70 is the base
      // auto's price, not this card's, and refusing it is correct.
      //
      // What was wrong is that a correct refusal left no trace on the row. A
      // refusal is a valuation decision, and a decision names itself: the
      // number is KEPT (the floor says the new one is wrong, not that the old
      // one is), and the row records `method: "withheld"` with the machine-
      // readable reason, the rung that was refused and the number that was
      // refused — so the invariant auditor sees a stated refusal instead of a
      // row that reads as never written.
      if (bOneEntry.outcome === "cost-basis-floor") {
        const cbf = costBasisFloorRefusalWrite(holding, bOneEntry, new Date().toISOString());
        doc.holdings[holding.id] = cbf.holding;
        console.warn(JSON.stringify({
          event: "cost_basis_floor_refusal_persisted",
          source: "portfolioStore.repriceHoldingsForUser",
          holdingId: holding.id,
          summary: cbf.summary,
        }));
        updates.push({
          id: holding.id,
          status: "skipped",
          reason: `cost-basis-floor: ${cbf.summary}`,
          cardId: typeof (holding as any).cardId === "string" && ((holding as any).cardId as string).trim() !== ""
            ? ((holding as any).cardId as string).trim()
            : null,
        });
        continue;
      }
      // CF-A-STALE-VALUE-IS-NOT-A-PRICE (Drew, 2026-09-04). Same shared write
      // as the on-demand lane, so the two cannot drift: the prior value is
      // kept and labelled, and the legacy chain does NOT run — it could only
      // substitute a number the engine deliberately withheld.
      if (bOneEntry.outcome === "no-basis-refusal") {
        const nb = noBasisRefusalWrite(holding, bOneEntry.reason, bOneEntry.valuation, new Date().toISOString());
        doc.holdings[holding.id] = nb.holding;
        console.warn(JSON.stringify({
          event: "no_basis_refusal_persisted",
          source: "portfolioStore.repriceHoldingsForUser",
          holdingId: holding.id,
          reason: bOneEntry.reason,
          summary: nb.summary,
        }));
        updates.push({
          id: holding.id,
          status: "skipped",
          reason: `${bOneEntry.reason}: ${nb.summary}`,
          cardId: typeof (holding as any).cardId === "string" && ((holding as any).cardId as string).trim() !== ""
            ? ((holding as any).cardId as string).trim()
            : null,
        });
        continue;
      }
      const bEntryDecided = bOneEntry.outcome !== "unresolved";

      // CF-UNIFIED-PRICING-BATCH-EARLY-EXIT (Drew, 2026-08-04). Same
      // ONE-function, ONE-number, ONE-prediction contract as
      // autoPriceHolding. Fire unified pricing FIRST. When it has
      // real data (marketValue > 0 AND confidence >= 0.3), write
      // directly + continue to next holding — bypass computeEstimate
      // + graded rail + ladder + our-pool + sibling fallback + resolver
      // fallback entirely. Cuts one CH call per holding on the hot path.
      // D17: only for identities the catalog cannot name (see above).
      const bEarlyId = (holding as any).cardId || (holding as any).hobbyiqCardId || null;
      if (!bEntryDecided && process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true" && bEarlyId) {
        try {
          const bGCo = (holding as any).gradeCompany
            ? String((holding as any).gradeCompany).trim()
            : null;
          // CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02): NaN is not a grade -- see gateEstimateAgainstExactPool.
          const bGVal = holdingGradeOf(holding as PortfolioHolding)?.value ?? null;
          // CF-EXACT-POOL-FIRST-BY-CHECKLIST-ID (D4 PR 5): hobbyiqCardId alone
          // first, then its twin, then the cardId union.
          const bExactEarly = await priceHoldingFromExactPool(holding as HoldingIdentityFields, {
            grade: bGCo ? { company: bGCo, value: bGVal } : null,
            excludeContributorUserId: userId ?? null,
            playerName: (holding as any).playerName ?? null,
            cardYear: typeof (holding as any).cardYear === "number"
              ? (holding as any).cardYear
              : null,
          });
          const bU = bExactEarly?.u ?? null;
          // CF-ONE-GRADE-CURVE (D4 PR 4): same precedence as autoPriceHolding
          // — marketValue (the fit at now, the tile's number) first.
          const bCanon = bU ? (bU.marketValue ?? bU.predictedPrice ?? bU.fmv) : null;
          // Cost-basis floor for batch reprice early-exit — same guard
          // as autoPriceHolding to catch slug-mismatch price drops.
          const bEarlyQty = Math.max(1, toNumber(holding.quantity, 1));
          const bEarlyCost = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * bEarlyQty);
          const bEarlyProposedTotal = bCanon !== null ? bCanon * bEarlyQty : 0;
          const bEarlySuspiciouslyLow = bEarlyCost > 50 && bEarlyProposedTotal > 0 && (bEarlyProposedTotal / bEarlyCost) < 0.15;
          if (bEarlySuspiciouslyLow) {
            console.warn(JSON.stringify({
              event: "batch_reprice_unified_early_exit_rejected_cost_basis_floor",
              source: "portfolioStore.repriceHoldingsForUser",
              holdingId: holding.id,
              costBasis: bEarlyCost,
              proposedTotal: bEarlyProposedTotal,
              confidence: bU?.confidence ?? null,
            }));
            // Fall through to legacy path.
          } else if (bU !== null && bCanon !== null && bCanon > 0 && bU.totalSampleCount >= 1) {
            const bNow = new Date().toISOString();
            console.log(JSON.stringify({
              event: "batch_reprice_unified_early_exit_applied",
              source: "portfolioStore.repriceHoldingsForUser",
              userId, holdingId: holding.id, cardId: bEarlyId,
              identityAttempt: bExactEarly?.attempt.label ?? null,
              pricedId: bExactEarly?.attempt.cardId ?? null,
              fair_market_value: bCanon,
              unified_median: bU.fmv,
              unified_market_value: bU.marketValue,
              unified_predicted: bU.predictedPrice,
              confidence: bU.confidence,
              window_days: bU.windowDays,
            }));
            const bPrev = doc.holdings[holding.id];
            // CF-ONE-PERSIST-HELPER (C-7): batch twin of the single-holding
            // unified early exit — exact pool, observed, labels composed once.
            const bUpdated: PortfolioHolding = writeHoldingValuation(holding, {
              fairMarketValue: bCanon,
              rung: { rung: bU.rungLabel },
              valueSource: "observed",
              nowIso: bNow,
              meta: {
                slug: bExactEarly?.attempt.cardId ?? String(bEarlyId),
                compsUsed: bU.totalSampleCount,
                confidence: bU.confidence,
                // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
                ...persistedLabelsForUnifiedResult(bU, tierLabelFor(holdingGradeOf(holding as PortfolioHolding)), userId ?? null),
              },
              fields: {
              predictedPrice: bU.predictedPrice,
              predictedPriceLow: null,
              predictedPriceHigh: null,
              predictedPriceMechanism: "unified-trend",
              predictedPriceUpdatedAt: bNow,
              movementDirection: bU.trendDirection === "up" ? "up"
                : bU.trendDirection === "down" ? "down"
                : null,
              movementUpdatedAt: bNow,
              estimatedValue: null,
              estimateLow: null,
              estimateHigh: null,
              estimateConfidence: null,
              estimateBasis: `unified: window=${bU.windowDays}d median=$${bU.fmv?.toFixed(0) ?? "?"} marketValue=$${bU.marketValue?.toFixed(0) ?? "?"} predicted=$${bU.predictedPrice?.toFixed(0) ?? "?"} trend=${bU.trendDirection} ${bU.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk conf=${bU.confidence.toFixed(2)}`,
              isEstimate: false,
              valuationStatus: "observed",
              pricingSource: "unified-pricing",
              sourceVendor: "cardhedge" as any,
              sourceVendorUpdatedAt: bNow,
              },
            });
            evaluateHoldingAlerts(doc, bPrev, bUpdated);
            doc.holdings[holding.id] = bUpdated;
            repriced += 1;
            updates.push({ id: holding.id, status: "repriced", reason: "unified-pricing-early-exit" });
            continue;
          }
        } catch (err) {
          console.warn(JSON.stringify({
            event: "batch_reprice_unified_early_exit_error",
            source: "portfolioStore.repriceHoldingsForUser",
            holdingId: holding.id,
            error: (err as Error)?.message ?? String(err),
          }));
        }
      }

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

      // CF-UNIFIED-PRICING-BATCH-REPRICE-PATH (Drew, 2026-08-04).
      // repriceHoldingsForUser is a SEPARATE persistence site from
      // autoPriceHolding — batch/scheduled reprice cycles bypass the
      // unified pricing block entirely and write whatever legacy
      // computeEstimate returned. That's why Ohtani PSA 9 kept
      // regressing to $2,483 (legacy composite) after every reprice
      // even though the on-demand refresh path was producing $2,596
      // via unified pricing. Fix: mirror the autoPriceHolding unified
      // block here so both persistence paths converge on the same math.
      //
      // When unified returns a valid trend-lifted marketValue with
      // confidence >= 0.3, write it directly and skip the rest of the
      // legacy pricing branches for this holding.
      // D17: only for identities the catalog cannot name (see above).
      if (!bEntryDecided && process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true") {
        const bResolvedId = (holding as any).cardId || (holding as any).hobbyiqCardId || null;
        if (bResolvedId) {
          try {
            const gradeCoRaw = (holding as any).gradeCompany;
            const gradeValRaw = (holding as any).gradeValue;
            const gradeCo = gradeCoRaw ? String(gradeCoRaw).trim() : null;
            const gradeVal = typeof gradeValRaw === "number" ? gradeValRaw : (gradeValRaw ? Number(gradeValRaw) : null);
            // CF-EXACT-POOL-FIRST-BY-CHECKLIST-ID (D4 PR 5): hobbyiqCardId alone
            // first, then its twin, then the cardId union.
            const bExact = await priceHoldingFromExactPool(holding as HoldingIdentityFields, {
              grade: gradeCo ? { company: gradeCo, value: gradeVal } : null,
              excludeContributorUserId: userId ?? null,
            });
            const unified = bExact?.u ?? null;
            // CF-ONE-GRADE-CURVE (D4 PR 4): marketValue first, as everywhere.
            const bChosen = unified ? (unified.marketValue ?? unified.predictedPrice ?? unified.fmv) : null;
            // CF-EXACT-POOL-SUPREMACY (D4 PR 5): >= 1 exact sale prices the
            // holding — the rule autoPriceHolding's early exit already applies
            // (CF-UNIFIED-SAMPLE-FLOOR). This site demanded confidence >= 0.3
            // instead, so a thin exact pool could fall through to the rescues.
            if (unified !== null && bChosen !== null && bChosen > 0 && unified.totalSampleCount >= 1) {
              const uNow = new Date().toISOString();
              console.log(JSON.stringify({
                event: "batch_reprice_unified_pricing_applied",
                source: "portfolioStore.repriceHoldingsForUser",
                userId, holdingId: holding.id, cardId: bResolvedId,
                identityAttempt: bExact?.attempt.label ?? null,
                pricedId: bExact?.attempt.cardId ?? null,
                unified_median: unified.fmv,
                unified_market_value: unified.marketValue,
                unified_predicted: unified.predictedPrice,
                confidence: unified.confidence,
                window_days: unified.windowDays,
                trend_pct_per_week: unified.trendPctPerWeek,
                trend_direction: unified.trendDirection,
              }));
              // Unified early-exit runs BEFORE computeEstimate, so the
              // identity-hydration patch isn't computed here. holding's
              // existing identity fields flow through via `...holding`.
              // CF-ONE-PERSIST-HELPER (C-7): the batch lane's second unified
              // write. Exact pool, this identity, this tier — observed.
              doc.holdings[holding.id] = writeHoldingValuation(holding, {
                fairMarketValue: bChosen,
                rung: { rung: unified.rungLabel },
                valueSource: "observed",
                nowIso: uNow,
                meta: {
                  slug: bExact?.attempt.cardId ?? String(bResolvedId),
                  compsUsed: unified.totalSampleCount,
                  confidence: unified.confidence,
                  // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
                  ...persistedLabelsForUnifiedResult(unified, tierLabelFor(holdingGradeOf(holding as PortfolioHolding)), userId ?? null),
                },
                fields: {
                  estimatedValue: null,
                  estimateLow: null,
                  estimateHigh: null,
                  estimateConfidence: null,
                  estimateBasis: `unified: window=${unified.windowDays}d median=$${unified.fmv?.toFixed(0) ?? "?"} marketValue=$${unified.marketValue?.toFixed(0) ?? "?"} predicted=$${unified.predictedPrice?.toFixed(0) ?? "?"} trend=${unified.trendDirection} ${unified.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk`,
                  isEstimate: false,
                  valuationStatus: "observed",
                  pricingSource: "unified-pricing",
                  verdict: holding.verdict ?? "Hold",
                  recommendation: holding.recommendation ?? "Hold",
                  sourceVendor: (holding.sourceVendor as "cardhedge" | "cardsight" | undefined) ?? "cardhedge",
                  sourceVendorUpdatedAt: uNow,
                },
              });
              repriced += 1;
              updates.push({ id: holding.id, status: "repriced", reason: "unified-pricing" });
              continue;
            }
          } catch (err) {
            console.warn(JSON.stringify({
              event: "batch_reprice_unified_pricing_error",
              source: "portfolioStore.repriceHoldingsForUser",
              holdingId: holding.id,
              error: (err as Error)?.message ?? String(err),
            }));
          }
        }
      }

      // CF-IDENTITY-HYDRATION-COMPLETION (2026-06-18): compute the hydration
      // patch BEFORE the confidence gate. Engine catalog resolution +
      // cardIdentity construction happen during fetchComps regardless of
      // pricing outcome — the variant-mismatch / thin-data / no-recent-
      // comps branches all return rich cardIdentity (verified live on
      // Hartman's `source:"variant-mismatch"` shape: full
      // {card_id, title, player, set, release, year, number} payload). The
      // patch flows into BOTH the skip writeback below and the success
      // writeback at L3735+. Helper's pin-authoritative + card_id-match
      // guards still apply; name-resolved skips or stub identities no-op.
      const repriceIdentityPatch = hydrateHoldingIdentityFromEstimate(
        holding,
        (estimate as any)?.cardIdentity,
      );

      // CF-EXACT-POOL-SUPREMACY (D4 PR 5, 2026-08-29). Every estimate site
      // below asks the gate first. When an identity of this holding has a
      // sale in window, the estimate is telemetry: the exact pool prices the
      // holding (unified engine, hobbyiqCardId first) or a stale estimate is
      // withheld — and the loop moves on.
      const applyGate = (gate: EstimateGateOutcome, site: string): boolean => {
        if (gate.outcome === "allowed") return false;
        evaluateHoldingAlerts(doc, doc.holdings[holding.id], gate.holding);
        doc.holdings[holding.id] = gate.holding;
        if (gate.outcome === "priced-from-exact-pool") {
          repriced += 1;
          updates.push({ id: holding.id, status: "repriced", reason: `exact-pool-supremacy:${site} (${gate.blockingId})` });
        } else {
          skipped += 1;
          updates.push({ id: holding.id, status: "skipped", reason: `estimate-withheld:${site} (${gate.blockingId}${gate.cleared ? ", stale estimate cleared" : ""})` });
        }
        return true;
      };

      // CF-A(a) — T3 BASE-AUTO FLOOR RE-BUCKET: when the engine emits
      // valuationStatus === "estimated" (set at T3 ladder success in
      // compiqEstimate.service.ts), bypass the FMV-based confidence gate
      // (engine.fairMarketValue is null by design) and persist as an
      // estimate. Mirrors autoPriceHolding's railResolution-style routing
      // so both persistence sites agree on the wire shape Phase 5 reads.
      const engineT3 = (estimate as any)?.valuationStatus === "estimated"
        && (estimate as any)?.estimateBasis === "base_auto_floor";
      if (engineT3) {
        if (applyGate(await gateEstimateAgainstExactPool({
          holding, userId, rung: null, site: "reprice.t3-base-auto-floor",
          proposed: toNumber((estimate as any)?.estimatedValue, 0) || null,
          basis: "base_auto_floor",
        }), "reprice.t3-base-auto-floor")) continue;
        const t3Now = new Date().toISOString();
        const t3PredictedPrice = typeof (estimate as any)?.predictedPrice === "number"
          && Number.isFinite((estimate as any).predictedPrice)
          ? (estimate as any).predictedPrice
          : null;
        const t3PredictedRange = (estimate as any)?.predictedPriceRange ?? null;
        const t3PredictedLow = typeof t3PredictedRange?.low === "number"
          && Number.isFinite(t3PredictedRange.low) ? t3PredictedRange.low : null;
        const t3PredictedHigh = typeof t3PredictedRange?.high === "number"
          && Number.isFinite(t3PredictedRange.high) ? t3PredictedRange.high : null;
        const t3PredictedMechanism = (estimate as any)?.predictedPriceAttribution?.mechanism ?? null;
        const t3PredictedUpdatedAt = (estimate as any)?.signalsLastUpdated ?? null;
        const t3TrendIQ = (estimate as any)?.trendIQ ?? null;
        const t3MovementDirection = typeof t3TrendIQ?.direction === "string" ? t3TrendIQ.direction : null;
        const t3MovementUpdatedAt = t3TrendIQ
          ? (t3TrendIQ.lastUpdated ?? (estimate as any)?.signalsLastUpdated ?? t3Now)
          : null;
        const t3Previous = doc.holdings[holding.id];
        // CF-ONE-PERSIST-HELPER (C-7): the legacy engine classified this as an
        // estimate and does not name a rung. Explicit refusal, with the reason.
        const t3Updated: PortfolioHolding = writeHoldingValuation(holding, {
          fairMarketValue: null,  // engine classified as estimated, not observed
          rung: { noRung: "legacy compiq estimate (T3); the legacy engine names no rung" },
          valueSource: "estimated",
          nowIso: t3Now,
          writeMeta: false,
          fields: {
          ...repriceIdentityPatch,
          estimatedValue: (estimate as any)?.estimatedValue ?? null,
          estimateLow: (estimate as any)?.estimateLow ?? null,
          estimateHigh: (estimate as any)?.estimateHigh ?? null,
          estimateConfidence: (estimate as any)?.estimateConfidence ?? null,
          estimateBasis: (estimate as any)?.estimateBasis ?? null,
          isEstimate: true,
          valuationStatus: "estimated",
          predictedPrice: t3PredictedPrice,
          predictedPriceLow: t3PredictedLow,
          predictedPriceHigh: t3PredictedHigh,
          predictedPriceMechanism: t3PredictedMechanism,
          predictedPriceUpdatedAt: t3PredictedUpdatedAt,
          movementDirection: t3MovementDirection,
          movementUpdatedAt: t3MovementUpdatedAt,
          verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
          recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
          // CF-CARDSIGHT-VENDOR-PROVENANCE (PR #492): T3 base-auto floor
          // estimate rides the same engine as the main path — vendor is
          // whichever the router picked. Read from the estimate response.
          sourceVendor: ((estimate as any)?.sourceVendor as "cardhedge" | "cardsight" | undefined) ?? "cardhedge",
          sourceVendorUpdatedAt: t3Now,
          },
        });
        evaluateHoldingAlerts(doc, t3Previous, t3Updated);
        doc.holdings[holding.id] = t3Updated;
        repriced += 1;
        updates.push({ id: holding.id, status: "repriced" });
        continue;
      }

      // CF-CH-THIN-COMP-PRIMARY (2026-06-26): scoped gate bypass for
      // estimateSource === "cardhedge-last-sale". The buildChLastSalePatch
      // helper returns {} for every other source — `repriceChLastSalePatch`
      // being non-empty is itself the scope predicate, and the helper IS
      // the gate (no separate source-string check needed here). When set,
      // we persist lastSaleSurface and count this as a successful reprice
      // so the holding stops being marked "insufficient-comps" on every
      // tick. Every other source still hits the existing confidence /
      // compsUsed / fairValue<=0 gate exactly as before.
      const repriceChLastSalePatch = buildChLastSalePatch(estimate);
      if (Object.keys(repriceChLastSalePatch).length > 0) {
        const chLsNow = new Date().toISOString();
        const chLsPrevious = doc.holdings[holding.id];

        // CF-REPRICE-LADDER-IN-LASTSALE (2026-06-29): on the single-CH-sale
        // path (estimateSource="cardhedge-last-sale"), the old chLastSalePatch
        // bypass returned with lastSale data but NO estimated FMV. For Drew's
        // 3 Hartman Orange Shimmer/X-Fractor holdings this was the actual
        // gap — they have 1 CH sale each, hit this bypass, then skipped my
        // PR #174 ladder fallback below. Run the ladder HERE so both surfaces
        // populate: lastSale (engine-emitted) + estimatedValue (ladder).
        let lsLadderResult: LadderFallbackResult | null = null;
        const lsCsid =
          typeof (holding as { cardId?: string }).cardId === "string" &&
          ((holding as { cardId?: string }).cardId as string).trim() !== ""
            ? ((holding as { cardId?: string }).cardId as string).trim()
            : null;
        if (lsCsid) {
          lsLadderResult = await applyGradeLadderFallback({
            holding,
            cardId: lsCsid,
            source: "portfolio.repriceHoldingsForUser.lastSale",
          });
        }

        if (lsLadderResult && applyGate(await gateEstimateAgainstExactPool({
          holding, userId, rung: null, site: "reprice.last-sale-ladder",
          proposed: lsLadderResult.derivedFmv, basis: lsLadderResult.explanation,
        }), "reprice.last-sale-ladder")) continue;
        const chLsUpdated: PortfolioHolding = {
          ...holding,
          ...repriceIdentityPatch,
          ...repriceChLastSalePatch,
          // fairMarketValue stays whatever it was (typically null for
          // this source). We're not inventing an FMV; we're persisting a
          // single trusted CH last-sale that iOS renders separately.
          // CF-REPRICE-LADDER-IN-LASTSALE: also persist the ladder-derived
          // estimatedValue + nearestGradedAnchor so iOS has BOTH surfaces.
          ...(lsLadderResult
            ? {
                estimatedValue: lsLadderResult.derivedFmv,
                estimateLow: lsLadderResult.anchorPrice * 0.7,
                estimateHigh: lsLadderResult.anchorPrice * 1.3,
                estimateConfidence: (
                  lsLadderResult.confidence >= 0.5 ? "estimate" :
                  lsLadderResult.confidence >= 0.3 ? "rough" : "ballpark"
                ) as "estimate" | "rough" | "ballpark",
                estimateBasis: lsLadderResult.explanation,
                isEstimate: true,
                valuationStatus: "estimated" as const,
                nearestGradedAnchor: {
                  grade: lsLadderResult.anchorGrade,
                  price: lsLadderResult.anchorPrice,
                  daysOld: lsLadderResult.anchorDaysOld,
                  sampleSize: lsLadderResult.anchorSampleSize,
                  confidence: lsLadderResult.confidence,
                },
              }
            : {}),
          verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
          recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
          lastUpdated: chLsNow,
        };
        evaluateHoldingAlerts(doc, chLsPrevious, chLsUpdated);
        doc.holdings[holding.id] = chLsUpdated;
        repriced += 1;
        updates.push({ id: holding.id, status: "repriced" });
        continue;
      }

      if (confidence < minPricingConfidence || compsUsed < minCompsUsed || fairValue <= 0) {
        // CF-REPRICE-GRADE-LADDER-FALLBACK (2026-06-29): the autoPriceHolding
        // path got a grade-ladder fallback in #170+, but repriceHoldingsForUser
        // has its OWN inline pricing loop that didn't. For graded/Raw cards
        // with no FMV from the engine, fall through to the same ladder so
        // we surface estimatedValue + nearestGradedAnchor instead of leaving
        // the holding stamped "Low confidence" with no number at all.
        const reprCsidForLadder =
          typeof (holding as any).cardId === "string" &&
          ((holding as any).cardId as string).trim() !== ""
            ? ((holding as any).cardId as string).trim()
            : null;
        if (reprCsidForLadder) {
          const ladder = await applyGradeLadderFallback({
            holding,
            cardId: reprCsidForLadder,
            source: "portfolio.repriceHoldingsForUser",
          });
          if (ladder) {
            if (applyGate(await gateEstimateAgainstExactPool({
              holding, userId, rung: null, site: "reprice.grade-ladder",
              proposed: ladder.derivedFmv, basis: ladder.explanation,
            }), "reprice.grade-ladder")) continue;
            const now = new Date().toISOString();
            // CF-ONE-PERSIST-HELPER (C-7): the ladder anchors on ANOTHER grade
            // tier of this card — an estimate, and one that names no rung of
            // its own. The refusal is explicit and carries its reason.
            doc.holdings[holding.id] = writeHoldingValuation(holding, {
              fairMarketValue: null,
              rung: { noRung: `grade-ladder fallback anchored on ${ladder.anchorGrade}; the ladder names no rung` },
              valueSource: "estimated",
              nowIso: now,
              writeMeta: false,
              fields: {
              ...repriceIdentityPatch,
              estimatedValue: ladder.derivedFmv,
              estimateLow: ladder.anchorPrice * 0.7,
              estimateHigh: ladder.anchorPrice * 1.3,
              estimateConfidence:
                ladder.confidence >= 0.5 ? "estimate" :
                ladder.confidence >= 0.3 ? "rough" : "ballpark",
              estimateBasis: ladder.explanation,
              isEstimate: true,
              valuationStatus: "estimated",
              nearestGradedAnchor: {
                grade: ladder.anchorGrade,
                price: ladder.anchorPrice,
                daysOld: ladder.anchorDaysOld,
                sampleSize: ladder.anchorSampleSize,
                confidence: ladder.confidence,
              },
              verdict: "Estimated",
              recommendation: "Hold",
              // CF-SOURCE-VENDOR (2026-07-13): grade-ladder fallback is CH-derived.
              sourceVendor: "cardhedge",
              sourceVendorUpdatedAt: now,
              },
            });
            repriced += 1;
            updates.push({ id: holding.id, status: "repriced", reason: "grade-ladder-fallback" });
            continue;
          }
        }
        // CF-RESOLVER-FALLBACK-EVERYWHERE (2026-07-13): before falling
        // through to the "low confidence / insufficient" persist, ask the
        // multi-source resolver. Cardsight often indexes SKUs CH doesn't
        // (2026 CPA-EHA Blue Refractor Auto is the canonical example).
        // On resolver hit, stamp FMV + winning vendor + continue as a
        // successful reprice.
        try {
          const { tryResolverFallback } = await import("../compiq/resolverFallbackHelper.js");
          const fallback = await tryResolverFallback({
            playerName: holding.playerName,
            cardYear: shimmedCardYear(holding) ?? undefined,
            setName: holding.setName ?? (holding as any).product,
            parallel: holding.parallel,
            cardNumber: holding.cardNumber,
            gradeCompany: holding.gradeCompany,
            gradeValue: holding.gradeValue,
            isAuto: holding.isAuto,
            cardId: (holding as any).cardId,
          });
          if (fallback) {
            if (applyGate(await gateEstimateAgainstExactPool({
              holding, userId, rung: null, site: "reprice.resolver-fallback",
              proposed: fallback.fairMarketValue, basis: fallback.estimateBasis,
            }), "reprice.resolver-fallback")) continue;
            const now = new Date().toISOString();
            // CF-ONE-PERSIST-HELPER (C-7): batch twin of autoPriceHolding's
            // resolver fallback — a vendor's number, no rung, stated as such.
            const rescued: PortfolioHolding = writeHoldingValuation(holding, {
              fairMarketValue: fallback.fairMarketValue,
              rung: { noRung: `resolver fallback (${fallback.vendor}) names no rung` },
              valueSource: "estimated",
              nowIso: now,
              writeMeta: false,
              fields: {
                ...repriceIdentityPatch,
                estimatedValue: null,
                isEstimate: true,
                valuationStatus: "estimated",
                estimateBasis: fallback.estimateBasis,
                verdict: "Estimated",
                recommendation: "Hold",
                sourceVendor: fallback.vendor as any,
                sourceVendorUpdatedAt: now,
              },
            });
            doc.holdings[holding.id] = rescued;
            repriced += 1;
            updates.push({ id: holding.id, status: "repriced", reason: `resolver-fallback:${fallback.vendor}` });
            console.log(JSON.stringify({
              event: "catalog_resolver_fallback_hit",
              source: "portfolioStore.repriceHoldingsForUser",
              holdingId: holding.id,
              vendor: fallback.vendor,
              fairMarketValue: fallback.fairMarketValue,
              compCount: fallback.compCount,
            }));
            continue;
          }
        } catch (err) {
          console.warn(JSON.stringify({
            event: "resolver_fallback_error",
            source: "portfolioStore.repriceHoldingsForUser",
            holdingId: holding.id,
            error: (err as Error)?.message ?? String(err),
          }));
        }

        // CF-OUR-POOL-FALLBACK-WIRE-IN (Drew, 2026-07-28): before we
        // fall through to sibling-fallback + skip, check OUR OWN
        // sold_comps pool via hobbyiq-fmv. Diagnostic on Drew's account
        // showed 5/6 currently-Missing holdings have sold_comps rows
        // (222 for a 1964 Banks, 13 for a 1972 Aaron, 7 for a 2026
        // Bowman prospect) that the CH-primary reprice never consulted.
        // No feature flag — this is a last-resort "check our own data
        // before giving up," same shape as sibling-fallback below.
        // priceHoldingFromOurPool returns null (silent) on any error,
        // missing slug, or empty pool.
        try {
          const ourPool = await priceHoldingFromOurPool(holding);
          if (ourPool !== null) {
            const now = new Date().toISOString();
            const fmv = ourPool.fairMarketValue ?? ourPool.estimatedValue;
            if (typeof fmv === "number" && fmv > 0) {
              // CF-COST-BASIS-SANITY-FLOOR (Drew, 2026-08-04). Same guard
              // as autoPriceHolding — reject our-pool overrides that would
              // wipe out a high-value holding's estimate with a suspicious
              // slug-mismatch price. Bobby Witt Jr. BGS 9.5 auto ($1,260
              // paid) got matched to non-auto base cards at $6.92 by the
              // ladder's family-baseline rung. If proposed < 15% of cost
              // basis, keep the prior estimate.
              //
              // CF-THE-FLOOR-IS-A-RATIO-NOT-A-DOLLAR-AMOUNT (Drew,
              // 2026-09-04). This lane held its own copy of the predicate,
              // dollar gate and all, so the $29.45 Chipper Jones passed here
              // for the same reason it passed the one-entry lane. The
              // predicate now comes from `costBasisFloor` — the SAME function
              // both one-entry lanes call — so the doctrine has one
              // implementation and this lane cannot drift from it again.
              const floor = costBasisFloor(holding, fmv);
              const costBasis = floor.costBasis;
              const proposedTotal = floor.proposedTotal;
              if (floor.rejects) {
                // CF-ONE-FLOOR-ONE-WRITE (2026-09-04). This lane was the THIRD
                // cost-basis floor and the one #1754 did not reach: it logged
                // that it was retaining the prior value and then wrote NOTHING,
                // leaving the holding's `pricingSourceMeta` as whatever the last
                // pass happened to leave — the same silent fall-through, under a
                // different event name. A refusal is a decision and a decision names
                // itself, so it goes through the ONE shared refusal write (the
                // number is kept, `method: "withheld"`, reason
                // `cost-basis-floor`, the refused number preserved as
                // evidence) — never a second implementation of it here.
                //
                // This lane holds an `OurPoolPricingResult`, not a `Valuation`,
                // so it passes the narrow refusal facts; the write is the same
                // one both one-entry lanes call.
                const cbf = costBasisFloorRefusalWrite(holding, {
                  rungLabel: ourPool.rungLabel,
                  proposedUnit: fmv,
                  proposedTotal,
                  costBasis,
                  pooledAs: ourPool.slug ?? null,
                  compsUsed: ourPool.compsUsed ?? 0,
                }, now);
                doc.holdings[holding.id] = cbf.holding;
                console.warn(JSON.stringify({
                  event: "our_pool_reprice_rejected_cost_basis_floor",
                  source: "portfolioStore.repriceHoldingsForUser",
                  holdingId: holding.id,
                  costBasis,
                  proposedTotal,
                  proposedPct: Math.round((proposedTotal / costBasis) * 10000) / 100,
                  method: ourPool.method,
                  slug: ourPool.slug,
                  // The refusal is now PERSISTED, not merely logged: the prior
                  // number is kept and the row says why.
                  refusalPersisted: true,
                  summary: cbf.summary,
                }));
                // The fall-through is DELIBERATELY unchanged: the floor faults
                // this lane's number, and the sibling / legacy lanes below may
                // still price the holding legitimately. If one does, its write
                // supersedes this refusal — which is correct, a published price
                // outranks a withhold. If none does, the refusal is what the
                // row carries, instead of the untouched meta it carried before.
              } else {
              // CF-EXACT-POOL-SUPREMACY (D4 PR 5): an our-pool ESTIMATE from a
              // cross-identity rung (cross-setkey, sibling-parallel, family-
              // baseline, composite-neighbor …) faces the gate; an observed
              // result, or an estimate that read this identity's own pool
              // (rare-card-anchor, grade-cross-raw), does not.
              if (ourPool.valuationStatus === "estimated" && applyGate(await gateEstimateAgainstExactPool({
                holding, userId, rung: ourPool.rungLabel, site: "reprice.our-pool",
                proposed: fmv, basis: ourPool.estimateBasis,
              }), "reprice.our-pool")) continue;
              // CF-ONE-PERSIST-HELPER (C-7): our-pool names its rung; whether
              // it is observed is the engine's own verdict on the read, not an
              // assumption this site gets to make.
              doc.holdings[holding.id] = writeHoldingValuation(holding, {
                fairMarketValue: ourPool.fairMarketValue ?? null,
                rung: ourPool.rungLabel
                  ? { rung: ourPool.rungLabel }
                  : { noRung: `our-pool ${ourPool.method} named no rung` },
                valueSource: ourPool.valuationStatus === "observed" ? "observed" : "estimated",
                nowIso: now,
                // CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03): explicit null.
                // priceFromOurPool collapses the engine's numeric confidence
                // to a tier string (confidenceTier) and never returns the
                // scalar, so this lane has none to give and says so.
                meta: { slug: ourPool.slug, compsUsed: ourPool.compsUsed, confidence: null },
                fields: {
                ...repriceIdentityPatch,
                estimatedValue: ourPool.estimatedValue,
                estimateLow: ourPool.estimateLow,
                estimateHigh: ourPool.estimateHigh,
                estimateConfidence: ourPool.estimateConfidence,
                estimateBasis: ourPool.estimateBasis,
                isEstimate: ourPool.valuationStatus === "estimated",
                valuationStatus: ourPool.valuationStatus,
                verdict: ourPool.valuationStatus === "observed" ? "Observed" : "Estimated",
                recommendation: "Hold",
                sourceVendor: "hobbyiq-pool" as any,
                sourceVendorUpdatedAt: now,
                pricingSource: "our-pool",
                // CF-RUNG-LABEL: `pricingSourceMeta.method` is read as a RUNG
                // label — the web's holdingProvenance() prefers it over the
                // flat `fmvRung`, and rung.ts only knows the closed
                // FmvRungLabel vocabulary. `ourPool.method` is the
                // HobbyIqFmvMethod vocabulary, whose `direct-slug` is
                // deliberately NOT a rung name (fmvRung.ts excludes it: the
                // exact pool's rung is `exact-pool-*`, by aggregation). Writing
                // the method here made the dashboard render
                // `? unknown - unknown rung "direct-slug"` on genuine
                // exact-pool prices. writeHoldingValuation now stamps `method`
                // from the SAME RungDeclaration that sets the flat `fmvRung`,
                // so the two cannot carry different vocabularies at all.
                },
              });
              repriced += 1;
              updates.push({ id: holding.id, status: "repriced", reason: `our-pool:${ourPool.method}` });
              console.log(JSON.stringify({
                event: "our_pool_fallback_wired_from_reprice_hit",
                source: "portfolioStore.repriceHoldingsForUser",
                holdingId: holding.id,
                slug: ourPool.slug,
                method: ourPool.method,
                compsUsed: ourPool.compsUsed,
                fmv,
                valuationStatus: ourPool.valuationStatus,
              }));
              continue;
              } // end cost-basis-floor else
            }
          }
        } catch (err) {
          console.warn(JSON.stringify({
            event: "our_pool_fallback_wired_from_reprice_error",
            source: "portfolioStore.repriceHoldingsForUser",
            holdingId: holding.id,
            error: (err as Error)?.message ?? String(err),
          }));
        }

        // CF-SIBLING-FALLBACK-WIRE-IN (Drew, 2026-07-28): last-mile
        // rescue before the skip branch. Wires the existing
        // attemptSiblingPriceFallback (compiq/siblingCardPriceFallback)
        // into the nightly reprice — previously this ran only for
        // interactive card-panel routes via observedGradeCurve's
        // enableSiblingFallback opt-in, so any parallel card that CH
        // has no comps for at any grade stayed permanently Missing
        // between refreshes.
        //
        // Bounded cost: only fires for cards with (parallel, playerName,
        // cardYear, product) all present — sibling function itself
        // returns null in ~15ms if the calibration table has no match.
        // On a hit, stamps the same wire shape the resolver-fallback
        // branch above uses so downstream code paths (iOS row render,
        // ERP totals, alerts) don't need to change.
        try {
          const parallelStr = typeof holding.parallel === "string" ? holding.parallel.trim() : "";
          const yearN = shimmedCardYear(holding) ?? (typeof holding.cardYear === "number" ? holding.cardYear : null);
          const setStr =
            (typeof holding.setName === "string" && holding.setName.trim()) ||
            (typeof (holding as any).product === "string" && ((holding as any).product as string).trim()) ||
            "";
          const playerStr = typeof holding.playerName === "string" ? holding.playerName.trim() : "";
          if (parallelStr && yearN && setStr && playerStr) {
            const { attemptSiblingPriceFallback } = await import("../compiq/siblingCardPriceFallback.service.js");
            const { mapSiblingToRepriceFmv, siblingEstimateBasis } = await import("./siblingReprice.helper.js");
            // CF-SIBLING-TRAJECTORY-WIRE (Drew, 2026-07-28). PR #891
            // originally passed trajectoryRateWeekly: null here — the
            // trajectory chain (matched-cohort → parallel-tier → release-
            // decay) already exists in deriveWeeklyRate but wasn't
            // plumbed into the nightly reprice's sibling rescue. Result:
            // every missing-card rescue priced at the sibling's stale
            // historical median with zero up/down/flat projection. Now
            // we compute the same rate the interactive card-panel route
            // uses (manualIdentityPricing.service.ts:114 is the direct
            // model). Wrapped in a race + try/catch so a stalled or
            // errored trajectory lookup falls through to null and the
            // sibling call still runs (existing behavior).
            let trajectoryRateWeekly: number | null = null;
            try {
              const [{ deriveWeeklyRate }, { getReleaseDecayForCardAsync }] = await Promise.all([
                import("../compiq/observedGradeCurve.service.js"),
                import("../compiq/releaseDecayPrior.service.js"),
              ]);
              const parallelTierKey = { year: yearN, set: setStr, variant: parallelStr };
              const releaseDecay = await getReleaseDecayForCardAsync(yearN, setStr).catch(() => null);
              const derivation = await Promise.race([
                deriveWeeklyRate(playerStr, parallelTierKey, { year: yearN, set: setStr }, releaseDecay),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
              ]);
              if (derivation && Number.isFinite(derivation.cappedRate)) {
                trajectoryRateWeekly = derivation.cappedRate;
              }
            } catch {
              // Silent — trajectory is a nice-to-have here; sibling
              // still fires with null rate = raw median (previous behavior).
            }
            const sibling = await attemptSiblingPriceFallback({
              targetCardId: (holding as any).cardId ?? holding.id,
              year: yearN,
              set: setStr,
              parallel: parallelStr,
              isAuto: Boolean(holding.isAuto),
              playerName: playerStr,
              trajectoryRateWeekly,
            });
            if (sibling) {
              const match = mapSiblingToRepriceFmv(
                sibling,
                holding.gradeCompany ?? null,
                typeof holding.gradeValue === "number" ? holding.gradeValue : null,
              );
              if (match) {
                const now = new Date().toISOString();
                const basis = siblingEstimateBasis(sibling);
                // CF-EXACT-POOL-SUPREMACY (D4 PR 5): a sibling × premium estimate
                // is persisted ONLY when no identity of this holding has a sale
                // in window. The Marconi German $1,109.44 was written here past
                // three exact sales under hobbyiqCardId.
                if (applyGate(await gateEstimateAgainstExactPool({
                  holding, userId, rung: "sibling-estimate", site: "reprice.sibling-estimate",
                  proposed: match.price, basis,
                }), "reprice.sibling-estimate")) continue;
                // CF-ONE-PERSIST-HELPER (C-7). This site wrote holding
                // afbebf9c — Gavin Fien CPA-GF Sparkle PSA 10, $68.68 on a
                // $440 basis at 15:55Z on 2026-09-03 — with no rung key, no
                // valueSource and no pricingSourceMeta at all. A sibling ×
                // premium is ANOTHER card's evidence: never observed.
                doc.holdings[holding.id] = writeHoldingValuation(holding, {
                  fairMarketValue: match.price,
                  // CF-LABELS-TELL-THE-TRUTH (D4 PR 5): the rung, the source and
                  // the meta all name the sibling estimate; nothing here can
                  // masquerade as "unified-pricing" / "cross-setkey", and no
                  // previous pass's labels survive the spread.
                  rung: { rung: "sibling-estimate" },
                  valueSource: "estimated",
                  nowIso: now,
                  meta: {
                    slug: String((holding as any).hobbyiqCardId ?? (holding as any).cardId ?? holding.id),
                    compsUsed: sibling.siblingCompCount,
                    // CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03): explicit
                    // null. A sibling × premium is ANOTHER card's evidence and
                    // the sibling read carries no pricing confidence for THIS
                    // identity; null reports it unknown rather than borrowing
                    // a number that answers a different question.
                    confidence: null,
                  },
                  fields: {
                  ...repriceIdentityPatch,
                  estimatedValue: null,
                  estimateLow: null,
                  estimateHigh: null,
                  estimateConfidence: "rough",
                  isEstimate: true,
                  valuationStatus: "estimated",
                  estimateBasis: basis,
                  pricingSource: "sibling-estimate",
                  nearestGradedAnchor: undefined,
                  verdict: "Estimated",
                  recommendation: "Hold",
                  sourceVendor: "cardhedge" as any,
                  sourceVendorUpdatedAt: now,
                  },
                });
                repriced += 1;
                updates.push({ id: holding.id, status: "repriced", reason: "sibling-fallback" });
                console.log(JSON.stringify({
                  event: "sibling_fallback_wired_from_reprice_hit",
                  source: "portfolioStore.repriceHoldingsForUser",
                  holdingId: holding.id,
                  targetCardId: (holding as any).cardId ?? null,
                  siblingCardId: sibling.siblingCardId,
                  chosenGrade: match.grade,
                  chosenPrice: match.price,
                  parallelPremium: sibling.parallelPremium,
                  premiumSampleSize: sibling.premiumSampleSize,
                  siblingIsCrossClass: sibling.siblingIsCrossClass,
                }));
                continue;
              }
            }
          }
        } catch (err) {
          console.warn(JSON.stringify({
            event: "sibling_fallback_wired_from_reprice_error",
            source: "portfolioStore.repriceHoldingsForUser",
            holdingId: holding.id,
            error: (err as Error)?.message ?? String(err),
          }));
        }

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
        //
        // CF-IDENTITY-HYDRATION-COMPLETION: spread the hydration patch
        // here too so Hartman-style sparse-identity holdings gain their
        // catalog identity fields even when they take the variant-mismatch
        // skip branch on every tick (which the canary on fcf7c59 showed
        // they do).
        // CF-A-RETAINED-VALUE-IS-STILL-A-WRITE (C-8, 2026-09-03). This branch
        // was the LAST writer in repriceHoldingsForUser still hand-spreading a
        // holding literal, and it is the one that produced the shape C-7 was
        // built to abolish — a value with no `valueSource` — precisely BECAUSE
        // it writes no new number.
        //
        // Live proof, holding 277b05a3 (Cal Ripken Jr., PSA 8), read read-only
        // after reprice run 33807265583:
        //
        //     fairMarketValue        49.99
        //     fmvRung                "exact-pool-weighted-median"
        //     pricingSourceMeta      {slug, method: "exact-pool-weighted-median",
        //                             compsUsed: 41}   <- no confidence, no labels
        //     valueSource            (key ABSENT)
        //     verdict                "Insufficient comps"
        //     lastUpdated            2026-09-03T21:20:02Z   <- THIS branch
        //     sourceVendorUpdatedAt  2026-09-03T15:50:14Z   <- the real pricer
        //
        // The `...holding` spread carried a PRE-#1683 pass's value, rung and
        // meta forward verbatim while stamping a fresh `lastUpdated`. The row
        // therefore reads as "repriced at 21:20Z" and carries none of the C-7
        // contract, because the writer that actually decided the number ran
        // hours earlier and the branch that touched the doc last declared
        // nothing at all. Every sibling row repriced in the 21:24Z wave —
        // Griffey, Maddux, Figueroa — went through the helper and carries
        // valueSource and confidence; only the rows that took THIS branch do
        // not. Freshening `lastUpdated` is a claim about the row; a claim is a
        // write, and a write names its source.
        //
        // So the retention is DECLARED rather than silent. The prior rung and
        // the prior valueSource are carried forward EXPLICITLY (they remain
        // true of the number, which is unchanged), the reason is recorded on
        // the row, and a holding whose prior pass named neither is stated as
        // the unlabelled legacy value it is — `{ noRung: ... }` with the cause,
        // so the auditor's RUNG-HONESTY check sees a statement instead of an
        // absence it must guess at.
        //
        // No confidence is invented: this branch computed no pricing, so the
        // meta it re-states carries the prior pass's confidence when there was
        // one and an explicit `null` when there was not.
        // The prior value, rung, valueSource, meta and confidence are no
        // longer read here: `noBasisRefusalWrite` below reads them off the
        // holding itself and rules on the retention through
        // `retentionThroughFloor`. Recomputing them at this call site is how
        // the branch came to make its own, different decision.
        //
        // The ENGINE's own reason for declining, when it named one, so the
        // withhold says `identity-not-in-catalog` rather than a generic
        // "confidence-gate" that describes the lane instead of the cause.
        // CF-A-REFUSAL-STATES-WHAT-ACTUALLY-HAPPENED (Drew, 2026-09-04).
        const engineReason = bOneEntry.outcome !== "unresolved" || bOneEntry.valuation
          ? bOneEntry.valuation?.reason ?? null
          : null;
        const retentionReason =
          `value retained unchanged by the confidence-gated reprice (${failed.join(", ")}; source=${estSource || "ok"}`
          + `${engineReason ? `; engine: ${engineReason}` : ""})`;
        // CF-A-HOLDING-CARRIES-ONE-STAMP (Drew, 2026-09-05). This branch used
        // to hand-build its own withheld write, and that is how a row came to
        // carry BOTH stamps at once.
        //
        // It passed `rung: priorRung ? { rung: priorRung } : ...` — the PRIOR
        // pass's rung — beside a `withheld` block, so `writeHoldingValuation`
        // stamped `method: "exact-pool-last-sale"` on a row whose meta also
        // said `withheld { reason: "no-exact-pool" }`. And the reason itself
        // was the engine's raw `ValuationReason`, a second vocabulary no
        // reader could look up. Holding 6f4f079b (the ruled D24 Diamond
        // Dominance) read exactly that way on 2026-09-05: method
        // "exact-pool-last-sale", confidence 0, withheld "no-exact-pool".
        // Every reader preferring `method` saw a current observed price; the
        // auditor reading `withheld` saw a refusal. Same row.
        //
        // So the branch no longer writes its own stamp. It asks the ONE
        // refusal writer — the same function `pool-migrating` and
        // `no-checklist-match` already use — which sets `fmvRung` null,
        // `method` "withheld", `valueSource` "estimated", and asks
        // `retentionThroughFloor` (#1781) ONCE whether the prior number may
        // stand, instead of re-implementing that rule here. The engine reason
        // is mapped through `noBasisReasonFromEngine`, a TOTAL mapping, so an
        // engine reason the union does not name can never again reach a row
        // as an undeclared withheld string.
        const nbRetention = noBasisRefusalWrite(
          holding,
          noBasisReasonFromEngine(engineReason),
          bOneEntry.valuation ?? null,
          now,
        );
        // The refusal writer has already decided the number (retained or not)
        // and stamped the whole contract. This second pass carries only THIS
        // lane's identity patch and verdict fields onto the row, with
        // `writeMeta: false` so the meta the refusal just wrote — the single
        // withheld stamp — is left exactly as it stands.
        doc.holdings[holding.id] = writeHoldingValuation(nbRetention.holding, {
          fairMarketValue: nbRetention.holding.fairMarketValue ?? null,
          // CF-A-REFUSAL-NAMES-THE-LANE-THAT-MADE-IT. `noRung` becomes
          // `fmvRungAbsentReason`, the field a reader consults to answer "why
          // is there no rung on this row". The refusal writer's prose says
          // what was missing (no pool, no checklist, gate declined); it cannot
          // say WHERE the refusal happened, because it is shared by every
          // caller. Before #1833 this branch's prose named the lane — this is
          // the end of the reprice chain, and "which pass refused" is the
          // first thing an operator reading a silent holding needs. Routing
          // through the one refusal writer (#1833) is about the STAMP, not the
          // prose: `writeMeta:false` keeps the single withheld meta exactly as
          // `noBasisRefusalWrite` wrote it, so naming the lane here cannot
          // reintroduce a second stamp. Both halves are stated, in the same
          // order `fmvRetainedReason` states them.
          rung: { noRung: `${retentionReason}. ${nbRetention.prose}` },
          valueSource: "estimated",
          nowIso: now,
          writeMeta: false,
          fields: {
            ...repriceIdentityPatch,
            verdict: reasonLabel,
            recommendation: "Hold",
            // The retention is recorded ON THE ROW, so "why does this say
            // 21:20Z" is answerable without reading a log that has rolled.
            fmvRetainedReason: `${retentionReason}. ${nbRetention.prose}`,
            fmvRetainedAt: now,
          },
        });
        const reprCsid =
          typeof (holding as any).cardId === "string" &&
          ((holding as any).cardId as string).trim() !== ""
            ? ((holding as any).cardId as string).trim()
            : null;
        updates.push({
          id: holding.id,
          status: "skipped",
          reason: `confidence-gate: ${failed.join(", ")} (source=${estSource || "ok"}${
            daysSinceNewestComp !== null ? `, daysSinceNewestComp=${daysSinceNewestComp}` : ""
          })`,
          cardId: reprCsid,
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

      // CF-IDENTITY-HYDRATION (2026-06-18) / -COMPLETION (2026-06-18):
      // repriceIdentityPatch was hoisted above the confidence-gate to fire
      // on both the skip writeback above AND this success writeback below.
      // Single helper, single computation per holding per tick; the same
      // patch reaches whichever writeback branch the holding takes.
      // CF-ONE-PERSIST-HELPER (C-7): the legacy confidence-gated reprice lane.
      // It genuinely does not know which rung produced `fairValue` — that is
      // now an explicit refusal carrying the reason, not an absent key. The
      // value is `estimated`: this lane never established that the number came
      // from this identity's own exact-pool comps, and claiming "observed"
      // without that evidence is exactly the conflation C-7 exists to stop.
      const updated: PortfolioHolding = writeHoldingValuation(holding, {
        fairMarketValue: fairValue,
        rung: { noRung: "legacy confidence-gated reprice; the legacy engine names no rung" },
        valueSource: "estimated",
        nowIso: now,
        writeMeta: false,
        fields: {
        ...repriceIdentityPatch,
        predictedPrice: repricePredictedPrice,
        predictedPriceLow: repricePredictedPriceLow,
        predictedPriceHigh: repricePredictedPriceHigh,
        predictedPriceMechanism: repricePredictedPriceMechanism,
        predictedPriceUpdatedAt: repricePredictedPriceUpdatedAt,
        movementDirection: repriceMovementDirection,
        movementUpdatedAt: repriceMovementUpdatedAt,
        verdict: String((estimate as any)?.verdict ?? holding.verdict ?? "Hold"),
        recommendation: String((estimate as any)?.action ?? holding.recommendation ?? "Hold"),
        // CF-CARDSIGHT-VENDOR-PROVENANCE (PR #492): batch-reprice success
        // path — reads whichever vendor served each individual estimate.
        sourceVendor: ((estimate as any)?.sourceVendor as "cardhedge" | "cardsight" | undefined) ?? "cardhedge",
        sourceVendorUpdatedAt: now,
        // CF-CURRENTVALUE-DIMENSION-CANONICALIZE C2: currentValue / P&L
        // (3 fields) and quickSale / premium / suggestedList (3 fields)
        // no longer stamped — wire computes them via composeHoldingWireShape.
        // Phase C drops still hold (movement detail β, confidence /
        // compsUsed (holding), marketSpeed / marketPressure, freshnessStatus).
        },
      });

      // CF-A-MOVER-NEEDS-CORROBORATION: this legacy reprice lane stamps
      // `fmvRung: null` on the holding above — it genuinely does not know which
      // rung produced `fairValue`. The point is written WITHOUT a rungLabel to
      // match, and absence reads as uncorroborated: the digest will not call a
      // move measured against this point a market move. Naming a rung here
      // would be inventing evidence this lane does not have.
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
        typeof (holding as any).cardId === "string" &&
        ((holding as any).cardId as string).trim() !== ""
          ? ((holding as any).cardId as string).trim()
          : null;
      updates.push({
        id: holding.id,
        status: "error",
        reason: error?.message ?? "estimate-failed",
        cardId: errCsid,
      });
    }
  }

  // CF-USER-PRICE-ALERTS (Drew, 2026-09-02): "tell me when my card moves N%".
  //
  // POST-VALUATION, NEVER INSIDE IT. Every holding in `updates` has already
  // been priced and written into `doc.holdings` by the loop above; this sweep
  // only READS the resulting (fairMarketValue, fmvRung) pair and compares it
  // to the pre-cycle pair captured in `priorAlertState`. It calls no pricing
  // entry point, and the whole block is wrapped so a Cosmos blip or an APNs
  // failure can never fail a reprice that already succeeded.
  //
  // It sits immediately BEFORE writeUserDoc, not after it, because the feed
  // rows it appends to `doc.alerts` have to land in the same persist as the
  // prices they describe. (The telemetry-only sweeps below the write can
  // safely run after it; this one mutates the doc, so it cannot.)
  //
  // Only holdings the user has an ACTIVE rule on cost anything: the context
  // build is one query per user per pass and returns null when there are no
  // rules, which is the overwhelmingly common case.
  try {
    const { buildHoldingMoveAlertContext, evaluateHoldingMoveAlert } = await import(
      "../advancedAlerts/holdingMoveEvaluator.service.js"
    );
    const moveCtx = await buildHoldingMoveAlertContext(userId);
    if (moveCtx) {
      for (const u of updates) {
        if (u.status !== "repriced") continue;
        const h = doc.holdings[u.id];
        if (!h) continue;
        if (!moveCtx.rules.has(String(u.id))) continue;
        const outcome = await evaluateHoldingMoveAlert(
          moveCtx,
          {
            id: String(h.id),
            playerName: (h as { playerName?: string | null }).playerName ?? null,
            cardTitle: (h as { cardTitle?: string | null }).cardTitle ?? null,
            fairMarketValue: typeof h.fairMarketValue === "number" ? h.fairMarketValue : null,
            fmvRung: (h as { fmvRung?: string | null }).fmvRung ?? null,
            lastUpdated: (h as { lastUpdated?: string | number | null }).lastUpdated ?? null,
          },
          priorAlertState.get(u.id),
        );
        // The feed row rides the same `doc.alerts` array as every other
        // portfolio alert, so the web bell and the iOS feed pick it up with
        // no second store. The type is "holding-move-rule", NOT "value-move":
        // the legacy 10%/18% emitter runs earlier in THIS SAME pass and writes
        // "value-move" for the same holding, and addAlert dedups on
        // (holdingId, type) within 6h — sharing the type meant the legacy row
        // won and the user's rule row (rule text, basis, speculative label)
        // was silently dropped. Distinct type, so both rows land.
        if (outcome?.feedAlert) {
          addAlert(doc, {
            level: outcome.feedAlert.level,
            type: "holding-move-rule",
            holdingId: outcome.feedAlert.holdingId,
            playerName: outcome.feedAlert.playerName,
            cardTitle: outcome.feedAlert.cardTitle,
            message: outcome.feedAlert.message,
            context: outcome.feedAlert.context,
          });
        }
      }
      if (moveCtx.fired > 0 || Object.keys(moveCtx.suppressed).length > 0) {
        console.log(JSON.stringify({
          event: "holding_move_alerts_pass",
          source: "portfolioStore.repriceHoldingsForUser",
          repriceSource: source,
          userId,
          rules: moveCtx.rules.size,
          fired: moveCtx.fired,
          suppressed: moveCtx.suppressed,
          dailyCount: moveCtx.dailyCount,
        }));
      }
    }
  } catch (err: any) {
    console.warn(
      `[holding.move.alert] sweep failed user=${userId}: ${err?.message ?? err}`,
    );
  }


  await writeUserDoc(userId, doc);
  _lastRepriceAt.set(userId, Date.now());

  // CF-COST-BASIS-DIVERGENCE-ALERT (Drew, 2026-07-28). Sweep every
  // holding that was repriced this cycle and flag the ones where the
  // fresh FMV / estimatedValue diverges from cost basis by more than
  // the configured threshold (default: |gain/loss| > 40% AND absolute
  // delta > $500). Real repro this session: Hartman Gold Refractor
  // Auto PSA 9 emitted $339 against cost $2,325 (-85%) because a
  // dilutive rung fired past 2 real anchor sales — exactly the kind
  // of gap Drew wants surfaced automatically instead of catching by
  // eye.
  // CF-A-SWING-IS-NOT-A-MARKET (2026-09-01). Every oscillation this session
  // measured was persisted silently: holding 9b971b03 logged 21.25 x5 ->
  // 212.95 -> 20.625 -> 20.625 -> 213.8 -> 20.625 on the 6h cron (~10.4x) and
  // ca820b08 168.74 -> 4.17 -> ... -> 187 (~41x), with no alarm anywhere — the
  // list renders the persisted value faithfully, so nothing looked wrong.
  //
  // The value STANDS: a swing is observed, never clamped (grade monotonicity
  // is not an invariant, and neither is price continuity — a real market can
  // double). What was missing is the signal, so App Insights can alert on
  // pool-composition flapping.
  const swingRatioLimit = swingAlarmRatio();
  for (const u of updates) {
    if (u.status !== "repriced") continue;
    const h = doc.holdings[u.id];
    if (!h) continue;
    const from = priorFmv.get(u.id) ?? null;
    const to = perUnitFmvForSwing(h);
    if (!isSwingAlarming(from, to, swingRatioLimit)) continue;
    console.warn(JSON.stringify({
      event: "portfolio_reprice_value_swing",
      source: "portfolioStore.repriceHoldingsForUser",
      repriceSource: source,
      userId,
      holdingId: u.id,
      from,
      to,
      ratio: Math.round((swingRatio(from, to) as number) * 100) / 100,
      threshold: swingRatioLimit,
      rung: (h as { fmvRung?: string | null }).fmvRung
        ?? (h as { pricingSourceMeta?: { method?: string } }).pricingSourceMeta?.method
        ?? null,
      poolLabel: (h as { pricingSourceMeta?: { slug?: string } }).pricingSourceMeta?.slug
        ?? (h as { hobbyiqCardId?: string | null }).hobbyiqCardId
        ?? null,
      valuationStatus: (h as { valuationStatus?: string }).valuationStatus ?? null,
      unionRefused: (h as { pricingSourceMeta?: { unionRefused?: string } }).pricingSourceMeta?.unionRefused ?? null,
      persisted: true,
      detail: "the value moved by more than the swing threshold between reprice cycles; it is PERSISTED, not clamped — a repeating swing is pool composition, not a market",
    }));
  }

  try {
    const { recordCostBasisDivergenceIfNoteworthy } = await import("../compiq/boundedProjectionAlerts.service.js");
    for (const u of updates) {
      if (u.status !== "repriced") continue;
      const h = doc.holdings[u.id];
      if (!h) continue;
      const cost = computeCostBasisTotal(h);
      if (!(cost > 0)) continue;
      const fmvCandidate = typeof h.fairMarketValue === "number" && Number.isFinite(h.fairMarketValue) && h.fairMarketValue > 0
        ? h.fairMarketValue
        : typeof (h as { estimatedValue?: number }).estimatedValue === "number"
          && Number.isFinite((h as { estimatedValue?: number }).estimatedValue!)
          && ((h as { estimatedValue?: number }).estimatedValue as number) > 0
          ? (h as { estimatedValue: number }).estimatedValue
          : null;
      if (fmvCandidate === null) continue;
      recordCostBasisDivergenceIfNoteworthy({
        userId,
        holdingId: h.id,
        cardTitle: (h as { cardTitle?: string | null }).cardTitle ?? null,
        playerName: (h as { playerName?: string | null }).playerName ?? null,
        slug: (h as { hobbyiqCardId?: string | null }).hobbyiqCardId ?? null,
        costBasis: cost,
        fmv: fmvCandidate,
        // CF-THE-DIGEST-WAS-SILENT (2026-08-29, D4 scoping). `pricingMeta` has no
        // writer anywhere in src, so the #1342 gate saw method=null on every
        // holding and suppressed the whole digest. The unified engine prices from
        // the exact-identity per-grade pool and stamps pricingSource; that is
        // the exact-pool signal the gate was written for.
        fmvMethod: (h as { pricingSource?: string }).pricingSource === "unified-pricing"
          ? "unified-market-value"
          : ((h as { pricingSourceMeta?: { method?: string } }).pricingSourceMeta?.method
            ?? (h as { pricingMeta?: { method?: string } }).pricingMeta?.method
            ?? null),
        fmvBasisNote: (h as { estimateBasis?: string | null }).estimateBasis ?? null,
        // CF-RUNG-LABEL (D4 PR 1): the label the writer stamped beside the
        // price. The gate reads this first; the method/basis fields above
        // only matter for holdings priced before the label existed.
        fmvRung: (h as { fmvRung?: string | null }).fmvRung ?? null,
        fmvCompCount: (h as { pricingSourceMeta?: { compsUsed?: number } }).pricingSourceMeta?.compsUsed
          ?? (h as { pricingMeta?: { compsUsed?: number } }).pricingMeta?.compsUsed
          ?? null,
      });
    }
  } catch {
    // Never let alerting break the reprice.
  }

  // CF-TRAJECTORY-12WK bounds alerts (Drew, 2026-07-28). After every
  // reprice run, drain any projection-multiplier bound hits (floor
  // 0.20 / ceiling 3.0) and the cost-basis divergences, and email the
  // ops digest. Silent-no-op when nothing hit.
  //
  // D13 (2026-08-29) — alert gates prove delivery. The send used to be
  // swallowed three times over with a hardcoded recipient; the result
  // `{delivered:false, devLogged:true}` was never read. The digest now
  // lives in divergenceDigestSend.ts, which never throws and ALWAYS
  // emits cost_basis_digest_delivered / cost_basis_digest_not_delivered
  // with a reason. The outer try still protects the reprice from a
  // failed dynamic import — not from a silent non-delivery.
  try {
    const { drainAlerts, drainDivergenceAlerts } = await import("../compiq/boundedProjectionAlerts.service.js");
    const divergenceHits = drainDivergenceAlerts();
    const hits = drainAlerts();
    if (hits.length > 0 || divergenceHits.length > 0) {
      const { sendDivergenceDigest } = await import("./divergenceDigestSend.js");
      await sendDivergenceDigest({ userId, hits, divergenceHits });
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "cost_basis_digest_not_delivered",
      reason: "digest-module-threw",
      error: (err as Error)?.message ?? String(err),
    }));
  }

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

// CF-CH-DELTA-POLL-REVERSE-MAP (2026-06-30): scan all user docs for
// holdings matching a (cardId, grade) pair. The delta-poll
// worker calls this with each unique (card_id, grade) from a price-
// updates batch and triggers a targeted reprice on each match.
//
// O(users × holdings) per call. With ~1000 holdings across all users
// and ~10 updates per poll cycle, that's ~10K holding checks per
// cycle — well within budget for an in-process scan.
//
// Returns an array of {userId, holdingId} pairs. Empty on any failure
// (cosmos unavailable, scan error) — the delta worker treats empty as
// "no holdings affected, no reprice needed".
export async function findHoldingsByCardAndGrade(
  cardId: string,
  grade: string,
): Promise<Array<{ userId: string; holdingId: string }>> {
  if (!cardId || !grade) return [];
  const matches: Array<{ userId: string; holdingId: string }> = [];
  try {
    const userIds = await listAllPortfolioUserIds();
    for (const userId of userIds) {
      try {
        const doc = await readUserDoc(userId);
        for (const [holdingId, h] of Object.entries(doc.holdings ?? {})) {
          if (!h) continue;
          if (String(h.cardId ?? "").trim() !== cardId) continue;
          const company = String(h.gradingCompany ?? "").trim().toUpperCase();
          const value = h.gradeValue;
          const holdingGrade =
            !company || value == null
              ? "Raw"
              : Number.isFinite(value) && value > 0
                ? `${company} ${value}`
                : null;
          if (holdingGrade !== grade) continue;
          matches.push({ userId, holdingId });
        }
      } catch (err) {
        console.warn(
          `[findHoldingsByCardAndGrade] read userId=${userId} failed (non-fatal):`,
          (err as Error)?.message ?? err,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[findHoldingsByCardAndGrade] listAllPortfolioUserIds failed:",
      (err as Error)?.message ?? err,
    );
  }
  return matches;
}

// CF-CH-DELTA-POLL-REVERSE-MAP (2026-06-30): re-price a single holding
// in response to a CH delta-poll update. Reads the user doc, runs
// autoPriceHolding, persists. Non-fatal: read / write / autoprice
// failures log + return without throwing — the next poll cycle will
// retry if the update is still relevant.
export async function repriceHoldingByDelta(
  userId: string,
  holdingId: string,
): Promise<{ repriced: boolean; reason?: string }> {
  try {
    const doc = await readUserDoc(userId);
    const holding = doc.holdings?.[holdingId];
    if (!holding) return { repriced: false, reason: "holding_not_found" };
    const previous = { ...holding };
    await autoPriceHolding(doc, holding, previous, "refresh", userId);
    await writeUserDoc(userId, doc);
    return { repriced: true };
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    console.warn(
      `[repriceHoldingByDelta] failed userId=${userId} holdingId=${holdingId} (non-fatal): ${reason}`,
    );
    return { repriced: false, reason };
  }
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
  // CF-PORTFOLIO-REFRESH-ASYNC (Drew, 2026-08-31): DISPATCH, don't compute.
  //
  // This handler used to `await repriceHoldingsForUser(...)` and return the
  // finished result. Measured cost of exactly one such request (App Insights,
  // app-id 468bd437-…): 5,657 Cosmos dependency calls, 68.3s of summed
  // dependency time — 2,992 sold_comps + 1,895 card_catalog + 280
  // daily_price_series, i.e. the whole valuation chain once per holding,
  // serially, for up to 50 holdings. No `requests` row was ever recorded for
  // it, only the OPTIONS preflight: the client gave up and the server
  // finished into a dead socket. The web client had been widened to a 180s
  // timeout to survive it.
  //
  // A refresh must never block on pricing. The read path is already fast
  // (GET /api/portfolio/ measures 77ms / ~10 deps, because it serves stored
  // values off one user doc), so the contract is now: start the work, return
  // a handle, let the client re-read the cheap GET to see values land.
  //
  // ONE VALUATION PATH is untouched — this changes *when* the caller is
  // answered, not *how* anything is priced. repriceHoldingsForUser is still
  // the single entry, still writes the same numbers.
  if (repriceJobs.isRunning(auth.userId)) {
    const running = repriceJobs.getJob(auth.userId);
    return res.status(202).json({
      accepted: true,
      status: "running" as const,
      alreadyRunning: true,
      // Echoed so the client's polls can name this run; a worker that does
      // not hold this id answers `unknown-here` rather than `idle`.
      jobId: running?.jobId ?? null,
      startedAt: running ? new Date(running.startedAt).toISOString() : null,
      // Values on screen are the last persisted ones until this run lands.
      // The UI must say so — see `stale` in the GET summary.
      stale: true,
    });
  }

  // Apply the user throttle HERE, synchronously, so a spamming client is
  // still cheap to answer and we don't spawn a run just to have it
  // short-circuit. repriceHoldingsForUser re-checks it anyway.
  //
  // CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): the throttle now consults
  // the DURABLE marker on the user doc as well as this worker's in-process
  // map. Opening the portfolio dispatches a refresh automatically, so two
  // opens a minute apart must collapse to one reprice even when they land on
  // different instances — which, with 2 serving workers, is about half the
  // time. In-process alone would have let the second one through.
  const persistedAt = await readPersistedRepriceDispatchAt(auth.userId);
  const decision = evaluateRepriceThrottle({
    inProcessAt: getLastRepriceAt(auth.userId) ?? null,
    persistedAt,
    throttleMs,
  });
  if (decision.throttled) {
    return res.status(202).json({
      accepted: false,
      status: "throttled" as const,
      throttled: true,
      retryAfterMs: decision.retryAfterMs,
      // Say fresh-as-of, not just "no". A skip that reports only that it
      // skipped is indistinguishable from a broken refresh; this tells the
      // client (and the UI) exactly how current the values on screen are.
      freshAsOf:
        decision.lastAt !== null ? new Date(decision.lastAt).toISOString() : null,
      freshAgeMs: decision.lastAt !== null ? Math.max(0, Date.now() - decision.lastAt) : null,
      stale: true,
    });
  }

  const job = repriceJobs.markStarted(auth.userId);
  // Stamp the durable marker BEFORE the work starts, so a concurrent open on
  // the other instance sees it immediately rather than 68s from now. Awaited
  // (not fire-and-forget) precisely because the next open may arrive during
  // the very next event-loop turn.
  await stampRepriceDispatchMarker(auth.userId, job.startedAt);
  // Fire-and-forget. Errors are captured onto the job entry and structured-
  // logged; they must never reject into an unhandled rejection, and there is
  // no response left to fail — the client already has its 202.
  void (async () => {
    try {
      const result = await repriceHoldingsForUser(auth.userId, "batch-reprice", {
        userThrottleMs: throttleMs,
        minHoldingAgeMs: minAgeMs,
        maxHoldings,
      });
      repriceJobs.markDone(auth.userId, result);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      repriceJobs.markError(auth.userId, message);
      console.warn(
        JSON.stringify({
          event: "batch_reprice_async_error",
          source: "portfolioStore.service",
          userId: auth.userId,
          error: message,
        }),
      );
    }
  })();

  return res.status(202).json({
    accepted: true,
    status: "running" as const,
    alreadyRunning: false,
    // The handle the client polls with. See buildRepriceStatusPayload for
    // why a poll that lands on the other instance must be able to name it.
    jobId: job.jobId,
    startedAt: new Date(job.startedAt).toISOString(),
    stale: true,
  });
}

/**
 * CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): GET /api/portfolio/reprice/status
 *
 * Progress surface for the dispatched run. Returns the *run's* state only —
 * never a price. The refreshed values are read back through
 * GET /api/portfolio/, which is the one place holdings are served from.
 */
export async function getBatchRepriceStatus(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const jobId = typeof req.query?.jobId === "string" ? req.query.jobId : null;
  return res.json(buildRepriceStatusPayload(auth.userId, jobId));
}

/**
 * CF-PORTFOLIO-REFRESH-ASYNC (Drew, 2026-08-31, judged blocker): the status
 * answer, as a pure function so the multi-instance behaviour is pinned by
 * tests without standing up two Node processes.
 *
 * The bug this shape exists to prevent: with 2 serving instances, a poll
 * routed to the worker that did NOT dispatch found nothing in its map and
 * answered `{status:"idle", running:false}`. Clients read any non-running
 * status as settled and announced "Refresh complete." over a run that was
 * still pricing on the other instance — roughly half of all polls.
 *
 * So a worker that cannot account for the named jobId answers
 * **`unknown-here`**, which is neither "running" nor "settled": it says
 * only that THIS worker has no view of that run. `settled` is the field
 * clients branch on, and it is true only for a run this worker actually
 * watched reach done/error. Everything else means keep asking.
 */
export type RepriceStatusPayload = {
  status: "idle" | "unknown-here" | "running" | "done" | "error";
  running: boolean;
  /**
   * True ONLY when this worker observed the run settle. `idle` and
   * `unknown-here` are explicitly NOT settled — a client that dispatched
   * must keep polling until it sees this true or its deadline fires.
   */
  settled: boolean;
  jobId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  result?: BatchRepriceResult | null;
  error?: string | null;
};

export function buildRepriceStatusPayload(
  userId: string,
  jobId?: string | null,
  now = Date.now(),
): RepriceStatusPayload {
  const lookup = repriceJobs.lookupJob(userId, jobId);
  if (lookup.kind === "idle") {
    // Nobody dispatched, as far as this worker knows. Not settled: a client
    // that DID dispatch is looking at the other instance's blind spot.
    return { status: "idle", running: false, settled: false, jobId: jobId ?? null };
  }
  if (lookup.kind === "unknown-here") {
    // The run was minted elsewhere (or already swept here). Say so plainly.
    return { status: "unknown-here", running: false, settled: false, jobId: jobId ?? null };
  }
  const job = lookup.job;
  const running = job.status === "running" && repriceJobs.isRunning(userId, now);
  return {
    status: job.status,
    running,
    // A "running" entry that has aged past ASSUME_DEAD_MS is not settled
    // either — we stopped believing it, we never saw it finish.
    settled: job.status === "done" || job.status === "error",
    jobId: job.jobId,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt != null ? new Date(job.finishedAt).toISOString() : null,
    result: job.result ?? null,
    error: job.error ?? null,
  };
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
