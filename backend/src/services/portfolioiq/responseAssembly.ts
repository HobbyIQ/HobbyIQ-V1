// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B (2026-05-31) — anti-corruption
// wire layer for the PortfolioHolding wire shape.
//
// Every field that lands on the wire is named explicitly here — never via a
// holding-object spread — so Phase C (writer stops) and Phase D (type
// deletion) cannot silently drop a field from the wire response, and a
// future writer cannot leak a new field unintentionally.
//
// Three responsibilities:
//   1. Pass through stored facts (verbatim).
//   2. Pass through the 10 cached pipeline outputs (verbatim).
//   3. Compute the 7 CHEAP secondary derivatives at response time.
//
// The 7 β fields (confidence, expectedDaysToSell, compsUsed,
// explanationBullets, movementComposite, movementImpliedPct,
// movementCoverage) are EXPLICITLY OMITTED from the portfolio wire.
// They remain available on the estimate-bearing card-detail response
// only (POST /api/compiq/{estimate,price,price-by-id}).
//
// Recipe-confirmation findings vs autoPriceHolding (writer reference,
// portfolioStore.service.ts:525-552):
//   • quickSaleValue — success-path multiplier `round(fmv * 0.85)` per
//     PriceDistributionEngine.ts:5. Writer FALLBACK is `fairValue * 0.88`
//     (autoPriceHolding L527, repriceHoldingsForUser L2118). Layer uses
//     the COMMON-CASE 0.85 (success path). For fallback-path holdings
//     the computed value differs from cache; stale-cache delta precedent
//     established in Phase A. CF-CURRENTVALUE-DIMENSION-CANONICALIZE
//     unifies the two-recipe split.
//   • premiumValue — writer fallback `fairValue * 1.15`. Layer matches
//     the writer fallback and the estimate-success "normal" market case.
//     Estimate-success at fast (1.25) / slow (1.10) markets diverges —
//     accepted consequence of Gate-2 β (marketSpeed dropped, no signal
//     available at response assembly to select speed-conditional
//     multiplier). CF-CURRENTVALUE-DIMENSION-CANONICALIZE unifies.
//   • suggestedListPrice — writer fallback `fairValue * 1.05`. Layer
//     matches. Estimate-success also uses `fmv * 1.05` (sibling-pool
//     path, compiqEstimate.service.ts:2097); recipes coincide.
//   • freshnessStatus — COMPUTED FROM SUCCESS-ONLY TIMESTAMP (Phase C).
//     Phase B carried freshnessStatus as cached pass-through; Phase C
//     replaces with `freshnessFromPricingTimestamp` (below) which reads
//     predictedPriceUpdatedAt → movementUpdatedAt → "Needs refresh".
//     Both pricing timestamps are written only inside the success
//     branches of autoPriceHolding / repriceHoldingsForUser; the
//     failure path preserves their prior values via `...holding`
//     spread. This resolves the false-"Live"-after-failed-reprice
//     bug that an age-based recipe keyed on `lastUpdated` would
//     otherwise produce (writer bumps `lastUpdated: now` on failure
//     at portfolioStore.service.ts:2052-2055 alongside
//     `freshnessStatus: "Stale"`).
//   • netEstimatedValue — declared on PortfolioHolding type at L56 but
//     NEVER POPULATED anywhere in the backend (grep verified). Today's
//     wire value is always undefined. Layer OMITS the field; the
//     recipe (likely premiumValue net of fee/tax/shipping fields, which
//     are themselves DROPPED per contract §1.3) ties to W2 eBay-
//     finances and has no faithful definition today.
//
// Unpriced (FMV-null) behavior: mirrors Phase A helpers — currentValue
// / P&L return 0 when FMV is null. quickSaleValue / premiumValue /
// suggestedListPrice return null (consistent with estimate-side at
// compiqEstimate.service.ts:2487-2489 / 1864-1870 / 2205-2211).
// CF-CURRENTVALUE-DIMENSION-CANONICALIZE will canonicalize unpriced
// semantics (cost-basis proxy vs $0) before the C/D deploy.

import { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { PricingEnvelope } from "../../types/pricingEnvelope.js";
import { buildPricingEnvelope } from "./pricingEnvelope.builder.js";
import { deriveHoldingSlug } from "./holdingSlug.service.js";
import { deriveSellWindowSignal } from "../signals/sellWindow.service.js";
import { resolvePricingConfidence } from "./pricingEnvelope.builder.js";
import {
  computePerUnitValue,
  computeCostBasisTotal,
  computeDisplayValue,
  computeDisplayablePerUnitValue,
} from "./portfolioStore.service.js";
// CF-ACTION-RECOMMENDATION (2026-07-05, Drew): per-holding SELL/HOLD/LIST
// verdict. Consumes the holding's own FMV + Predicted + confidence +
// cost basis and emits a shape iOS can render directly.
import { computeAction } from "../compiq/actionRecommendation.service.js";
// CF-COMP-HOLDING-WIRE-PARITY (audit PR #482, 2026-07-15): consume the
// canonical multipliers introduced in PR #481 for the derived tier/zone
// bands. Ensures the holding wire's derived math tracks any future
// tuning changes to the pricing engine in exactly ONE place.
import {
  QUICK_SALE_MULTIPLIER,
  QUICK_SALE_FALLBACK_MULTIPLIER,
  PREMIUM_MULTIPLIER,
  SUGGESTED_LIST_MULTIPLIER,
  BUY_ZONE_LOW_MULTIPLIER,
  applyHeadlineMultiplier,
} from "../../modules/compiq/services/pricing/utils/pricing.constants.js";

/**
 * Map the portfolio holding's categorical `estimateConfidence` tier
 * (which was calibrated for a different UI) to the 0-1 numeric scale
 * `computeAction` expects. Conservative approximations — a holding
 * priced from a robust comp pool sits at "estimate" (0.85); a holding
 * on the graded-rail ladder fallback sits at "ballpark" (0.35).
 * Anything null / "no-data" / "insufficient" falls below the
 * recommendation confidence floor → INSUFFICIENT_DATA verdict.
 */
function confidenceScoreFromHolding(holding: PortfolioHolding): number {
  const tier = (holding as any).estimateConfidence as
    | "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null
    | undefined;
  switch (tier) {
    case "estimate":
      return 0.85;
    case "rough":
      return 0.60;
    case "ballpark":
      return 0.35;
    case "no-data":
    case "insufficient":
    case null:
    case undefined:
    default:
      return 0.15;
  }
}

function applyMultiplierOrNull(value: number | null, multiplier: number): number | null {
  return value === null ? null : value * multiplier;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: compute freshnessStatus from a
// success-only pricing timestamp instead of cached pass-through. The writer
// stamps cached freshnessStatus operationally — including "Stale" on
// reprice FAILURE at portfolioStore.service.ts:2052 alongside a bumped
// `lastUpdated` — so a recipe keyed on `lastUpdated` would falsely read
// "Live" on failed-reprice holdings. predictedPriceUpdatedAt and
// movementUpdatedAt are written only inside the success branches of
// autoPriceHolding (after the `if (fairValue <= 0) return holding;`
// guard) and repriceHoldingsForUser's success path; the failure path
// preserves their prior values via the `...holding` spread. Both
// qualify as success-only timestamps. Recipe prefers
// predictedPriceUpdatedAt (broadest success coverage) and falls back
// to movementUpdatedAt (set only when trendIQ is present).
export type FreshnessLabel = "Live" | "Updated Today" | "Yesterday" | "Needs refresh";

export function freshnessFromPricingTimestamp(h: PortfolioHolding | undefined | null): FreshnessLabel {
  if (!h) return "Needs refresh";
  const stamp = h.predictedPriceUpdatedAt ?? h.movementUpdatedAt ?? null;
  if (!stamp) return "Needs refresh";
  const ts = new Date(stamp as string).getTime();
  if (!Number.isFinite(ts)) return "Needs refresh";
  const ageMs = Date.now() - ts;
  if (ageMs < HOUR_MS) return "Live";
  if (ageMs < DAY_MS) return "Updated Today";
  if (ageMs < 2 * DAY_MS) return "Yesterday";
  return "Needs refresh";
}

export interface PortfolioHoldingWire {
  // Identity (stored facts)
  id: string;
  playerName?: string;
  cardTitle?: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  cardNumber?: string;
  serialNumber?: string;
  isAuto?: boolean;
  variation?: string;
  /** CF-PORTFOLIO-DETAIL-SLUG (Drew, 2026-07-26). Canonical HobbyIQ slug
   *  for tap-into-card. Populated at write time via deriveHoldingSlug;
   *  compose paths compute-on-fly for legacy holdings that predate the
   *  CF. null when identity is insufficient. */
  hobbyiqCardId?: string | null;
  // Grade
  gradeCompany?: string;
  gradeValue?: number;
  /** CF-GRADER-STATUS-FIELD (2026-06-28): see PortfolioHolding for semantics. */
  graderStatus?: "available" | "at_psa" | "pending_redemption" | "in_route";
  // Acquisition
  quantity?: number;
  purchasePrice?: number;
  totalCostBasis?: number;
  purchaseDate?: string | number;
  purchaseSource?: string;
  // Listing intent
  listingUrl?: string;
  listingPrice?: number;
  // Timestamp
  lastUpdated?: string | number;
  // Notes / media / client id
  notes?: string;
  photos?: string[];
  clientId?: string;
  // CF-SOURCE-VENDOR-WIRE-STRIP (Drew, 2026-07-13): sourceVendor +
  // sourceVendorUpdatedAt REMOVED from the wire shape per iOS shape lock —
  // the fields still write to the persisted holding (backend audit + KQL)
  // but never surface to iOS. Restore this block only when iOS explicitly
  // opts in to vendor attribution rendering.
  // CF-HELD-EXPENSES (2026-07-12): explicit on the wire shape so mutation
  // routes returning composed holdings still surface the array iOS renders.
  heldExpenses?: Array<{
    id: string;
    kind: string;
    amount: number;
    incurredAt?: string;
    notes?: string;
    invoiceRef?: string;
  }>;
  // MLB resolution
  playerId?: string;
  playerIdConfidence?: "high" | "medium" | "low" | "ambiguous";
  playerIdResolvedAt?: string;
  // eBay linkage
  ebayOfferId?: string | null;
  ebayListingId?: string | null;
  ebayListingPublishedAt?: string | null;
  // CF-EBAY-AUTO-HOLDING (2026-07-12): provenance markers for holdings
  // created by the auto-import path (POST /erp/purchases/import/ebay or
  // POST /erp/purchases/backfill-holdings). iOS uses these to render a
  // "Auto-imported from eBay" badge + a "Confirm details" prompt when
  // parseConfidence < 0.90.
  source?: string | null;
  sourcePurchaseId?: string | null;
  parseConfidence?: number | null;
  needsReview?: boolean | null;
  // setName duplicated on the wire alongside product because the auto-
  // parser fills both, and iOS existing screens may key off either.
  setName?: string | null;
  // CF-EBAY-BROWSE-ENRICHMENT (2026-07-12): Browse API item-specifics
  // populated when the auto-import fetched full item details from eBay.
  // Foundation for iOS eBay relisting flow + future sold-comp matching.
  ebayImageUrl?: string | null;
  ebayShortDescription?: string | null;
  ebayItemAspects?: Record<string, string> | null;
  ebayCategoryPath?: string | null;
  ebaySeller?: { username: string; feedbackScore: number | null } | null;
  enrichedFromEbay?: boolean | null;
  // CF-CARDID-SUGGESTER (2026-07-12): pending-review holdings carry a
  // proposed canonical cardId + confidence + candidate summary. iOS shows
  // the suggestion prominently on the review sheet — Accept sends
  // { cardId: suggestedCardId } in the confirm edits body.
  suggestedCardId?: string | null;
  /** CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (D12a): "hiq" when suggestedCardId
   *  is a canonical slug; "vendor" when the winning candidate carried only a
   *  vendor id (suggestedCardId is then absent; the vendor id is context on
   *  suggestionCandidate.vendorCardId). */
  suggestionIdKind?: "hiq" | "vendor" | null;
  suggestionConfidence?: number | null;
  suggestionCandidate?: {
    title?: string;
    set?: string;
    year?: number | string;
    number?: string;
    variant?: string;
    image?: string;
  } | null;
  /** CF-CARDID-SUGGESTER-CONFIDENCE-TIERING (2026-07-12): iOS keys on this
   *  to bucket the review queue into high/medium/low review tiers. Backend
   *  owns the thresholds; iOS should never depend on the raw confidence
   *  number for tier decisions. */
  suggestionConfidenceTier?: "high" | "medium" | "low" | null;
  /** Transparency layer: which structured fields aligned + which didn't,
   *  so iOS can render "Matched 5 of 6 (mismatch: parallel)". */
  suggestionMatchBreakdown?: {
    fieldsChecked: number;
    fieldsMatched: number;
    mismatchedFields: string[];
  } | null;
  suggestionUpdatedAt?: string | null;
  /** CF-CARDID-SUGGESTER-MULTI-VENDOR (PR #438): which vendor sourced
   *  the primary suggestion. iOS badges the review row accordingly. */
  suggestionCandidateSource?: "cardhedge" | "cardsight-uuid" | null;
  /** CF-CARDID-SUGGESTER-TOP-N (PR #438): up to 2 alternative
   *  candidates surfaced when primary tier != "high". iOS renders as
   *  one-tap picks in the review sheet. Absent on high-tier picks. */
  suggestionAlternatives?: Array<{
    cardId: string;
    confidence: number;
    confidenceTier: "high" | "medium" | "low";
    candidateSource: "cardhedge" | "cardsight-uuid";
    candidate: {
      title?: string;
      set?: string;
      year?: number | string;
      number?: string;
      variant?: string;
      image?: string;
    };
    matchBreakdown?: {
      fieldsChecked: number;
      fieldsMatched: number;
      mismatchedFields: string[];
    };
  }> | null;
  /** CF-CARDID-SUGGESTER-CATALOG-VERIFY (PR — 2026-07-14): reference-
   *  catalog match on the suggestion's (year, product, parallel).
   *  Present when a real catalogued SKU exists; iOS badges accordingly. */
  suggestionCatalogVerified?: {
    confidence: "Verified" | "High" | "Medium";
    printRun: number | null;
    canonicalProduct: string;
    canonicalCardSet: string;
    canonicalParallel: string;
  } | null;
  // Auxiliary aspect fields we backfilled from Browse (team, sport,
  // manufacturer) — always optional so old holdings still decode.
  team?: string | null;
  sport?: string | null;
  manufacturer?: string | null;
  // Cert
  certNumber?: string | null;
  certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
  // CF-IDENTITY-VERIFIED (Drew, 2026-07-27): see PortfolioHolding.
  identityVerified?: boolean;
  identityVerifiedAt?: string;
  identityVerifiedBy?: {
    source: string;
    candidateId: string;
    verifiedAt: string;
  };
  // CF-NEVER-AGAIN (Drew, 2026-09-02): the nightly pricing invariant auditor's
  // marker. Present only when the last run could not reconcile this holding's
  // value with an independent re-derivation. The value still shows — this only
  // adds an "under review" badge beside it.
  auditFlag?: {
    reason: string;
    at: string;
    invariant: string;
  } | null;
  // Cardsight FK
  cardId?: string | null;
  gradeId?: string | null;
  // CF-INVENTORY-CATALOG-IMAGE (2026-07-05): publicly-hittable HTTPS URL
  // to the canonical catalog card art — same image /api/compiq/price-by-id
  // emits on `response.cardImageUrl`. iOS renders this as the fallback
  // behind the user's own photo (imageFrontUrl):
  //     row image = holding.imageFrontUrl ?? holding.catalogImageUrl
  // Undefined key when the holding has no cardId or meta cache is cold
  // (iOS then renders its initials placeholder). Never a synthesized URL.
  catalogImageUrl?: string | null;
  // Cached pipeline (10)
  fairMarketValue: number | null;
  predictedPrice: number | null;
  predictedPriceLow: number | null;
  predictedPriceHigh: number | null;
  predictedPriceUpdatedAt: string | null;
  movementDirection: string | null;
  movementUpdatedAt: string | null;
  verdict: string | null;
  recommendation: string | null;
  predictedPriceMechanism: string | null;
  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): graded-rail valuation fields.
  // Structurally separate from fairMarketValue — iOS reads these to
  // render the "estimated" badge + tap-state for graded holdings.
  estimatedValue: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  // CF-FINAL-CONSTANTS (2026-06-12): "ballpark" is a first-class tier
  // (rail emits it with a number). "no-data" replaces "insufficient" for
  // the no-anchor case. Old "insufficient" kept for Cosmos back-compat.
  estimateConfidence: "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null;
  estimateBasis: string | null;
  isEstimate: boolean;
  valuationStatus: "observed" | "estimated" | "pending" | null;
  // Computed CHEAP at response (7)
  currentValue: number;
  totalProfitLoss: number;
  totalProfitLossPct: number;
  quickSaleValue: number | null;
  premiumValue: number | null;
  suggestedListPrice: number | null;
  freshnessStatus: string;
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): observed-or-estimated
  // headline value for the per-row "what this holding is worth"
  // display. ADDITIVE — currentValue stays observed-only above (any
  // existing iOS code that reads currentValue keeps its semantics).
  // iOS reads displayableValue + displayableValueSource for the new
  // estimated-aware row treatment.
  displayableValue: number | null;
  displayableValueSource: "observed" | "estimated" | null;
  /** CF-ACTION-RECOMMENDATION (2026-07-05): the seller-facing verdict
   *  for this holding — SELL_NOW / HOLD / LIST / INSUFFICIENT_DATA plus
   *  a suggested list price and short reasoning. Computed from the
   *  holding's own FMV, Predicted, confidence, and cost basis. iOS
   *  reads this to render an actionable badge on each inventory row
   *  and portfolio Top Movers card. Named `actionRecommendation` to
   *  avoid collision with the legacy string `recommendation` field
   *  used by an earlier iOS decoder (kept for backward-compat). */
  actionRecommendation: {
    verdict: "SELL_NOW" | "HOLD" | "LIST" | "INSUFFICIENT_DATA";
    targetPrice: number | null;
    reasoning: string;
    urgency: "high" | "medium" | "low" | null;
    expectedDeltaPct: number | null;
  } | null;
  // CF-CH-THIN-COMP-PRIMARY (2026-06-26): persisted single trusted CardHedge
  // sale for holdings whose engine returned estimateSource ===
  // "cardhedge-last-sale". Surfaced as optional + nullable so the existing
  // wire payload stays byte-identical when the field is absent on the
  // holding doc (the universal case for non-CH-last-sale holdings).
  // iOS renders "Last sold $X via N comp(s)" off this block.
  lastSaleSurface?: {
    price: number;
    date: string | null;
    compCount: number;
  } | null;

  // CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): multiplier-model
  // expectation + buy/sell signal. Surfaced as optional + nullable. Same
  // additive invariant as lastSaleSurface — wire key omitted when absent
  // on the holding doc; only present on cardhedge-last-sale holdings
  // whose engine signal helper succeeded.
  modelExpectation?: {
    value: number;
    range: [number, number];
    multiplier: number;
    multiplierRange: [number, number];
    basis: string | null;
    n: number;
    baseAutoMedian: number;
    baseAutoCount: number;
    // CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26): wire-side
    // mirror of PortfolioHolding.modelExpectation. Same shape; absent
    // when null on the holding (the conditional-spread emit OMITS the
    // parent block entirely when null, so these are transitively
    // absent too — no extra wire-shape gating needed here).
    trendAnchor?: {
      direction: "up" | "down";
      slopePctPerDay: number;
      trendConfidence: number;
      windowDays: number;
      daysWithSales: number;
      projectedBaseAtSale: number;
      projectedBaseToday: number;
      allTimeBaseMedian: number;
    } | null;
    forwardProjection?: {
      low: number;
      high: number;
      basis: string;
      confidence: number;
    } | null;
    positionSignal?: {
      purchasePrice: number;
      gainVsLastSale: number;
      gainVsExpectation: number;
      gainPct: number;
    } | null;
  } | null;
  modelSignal?: {
    lean: "buy" | "hold" | "sell";
    deltaPct: number;
    expectation: number;
    effectiveMultiplier: number;
  } | null;

  // CF-NEAREST-ANCHOR-WIRE (2026-06-29): surface the grade-ladder
  // fallback's anchor snapshot on the wire. PR #180 + earlier CFs
  // already persist `nearestGradedAnchor` on the holding when the
  // ladder rescued an estimate (engine couldn't anchor a real FMV
  // for the requested grade). The wire shape was the missing link —
  // without this field, iOS reading from the inventory endpoint
  // can't render "Last sold: PSA 9 $1325 · 236 days ago" alongside
  // the estimated value, even though the data is in Cosmos.
  //
  // Conditional-spread emit (matches lastSaleSurface pattern): when
  // the holding has no anchor (the universal case for healthy-priced
  // holdings), the wire key is OMITTED — byte-identical to pre-CF.
  nearestGradedAnchor?: {
    grade: string;
    price: number;
    daysOld: number;
    sampleSize: number;
    confidence: number;
  };

  // ── CF-COMP-HOLDING-WIRE-PARITY (audit PR #482, 2026-07-15) ─────────
  //
  // The whole-app wire-shape audit surfaced 8 fields present on comp
  // responses (/search, /price, /price-by-id) but absent — or emitted
  // under a different name/envelope — on the holding wire. iOS decoders
  // had to branch on which endpoint produced the row; the holding
  // detail sheet couldn't render zones/trendIQ/confidence tiles because
  // the data never left the backend.
  //
  // Fix: ADDITIVE aliases that mirror the comp-family envelope. The
  // legacy flat fields (predictedPriceLow/High, predictedPriceMechanism,
  // estimateLow/High, fairMarketValue) STAY on the wire for backward
  // compat while iOS decoders migrate at their own pace. Never break
  // an existing decoder; always add new keys.
  //
  //   marketValue          — alias of fairMarketValue (comp routes name)
  //   fairMarketValueLive  — alias of fairMarketValue (comp routes name)
  //   predictedPriceRange  — nested form of predictedPriceLow/High
  //   predictedPriceAttribution.mechanism
  //                        — nested form of predictedPriceMechanism
  //   estimateRange        — nested form of estimateLow/High
  //   marketTier / buyZone / holdZone / sellZone
  //                        — derived from FMV via pricing.constants
  //                          multipliers (PR #481). Zones are TUPLES
  //                          `[low, high]` matching the comp response's
  //                          PriceZone decoder.
  //   trendIQ / confidence — null placeholders in PR #482; will be
  //                          populated in PR #483 once the holding doc
  //                          persists trendIQ + a per-holding confidence
  //                          via autoPriceHolding. iOS decoders can
  //                          bind the field defensively today so the
  //                          transition is a null → object change,
  //                          not a schema break.
  marketValue: number | null;
  fairMarketValueLive: number | null;
  predictedPriceRange: { low: number; high: number } | null;
  predictedPriceAttribution: { mechanism: string } | null;
  estimateRange: { low: number; high: number } | null;
  marketTier: { value: number | null; high: number | null };
  buyZone: [number | null, number | null];
  holdZone: [number | null, number | null];
  sellZone: [number | null, number | null];
  // CF-COMP-HOLDING-WIRE-PARITY Slice 2 (PR #483): trendIQ is now the
  // full result object when the holding was repriced by autoPriceHolding
  // (with an engine estimate carrying trendIQ), null otherwise. Same
  // shape iOS decodes on comp responses so a shared PricingPanelView
  // component can bind either.
  trendIQ:
    | import("../compiq/trendIQ.types.js").TrendIQResult
    | null;
  confidence: number | null;
  /**
   * CF-SELLER-INTELLIGENCE-SELL-WINDOW (Drew, 2026-09-02). The per-holding
   * timing call — {none|watch|sell-window|hold} with the horizon it is
   * allowed to speak to and a basis sentence quoting its numbers.
   *
   * Derived, never stored: it is a pure read of the trendIQ + confidence
   * already on this wire shape, so it costs no pool read and cannot drift
   * from the numbers beside it. NOT a valuation — it says WHEN, never WHAT,
   * and no price on this envelope is affected by it.   *
   * CF-PRO-SELLER-GATE (Drew, 2026-09-02): "Gate all five to the Pro tiers."
   * OPTIONAL as of this CF. The field is populated only when the caller
   * passes `sellSignalEntitled: true` — free callers get a wire with the key
   * ABSENT, not a key holding an empty signal.
   *
   * Absent, not emptied, and the distinction is the product. A `signal:
   * "none"` means "we looked and there is no call to make" — it is a
   * measurement, and every consumer renders it as one (SellSignalChip
   * returns null; the Pro Seller section shows "No open sell windows"). A
   * free user has not been looked at, so saying "none" to them would be
   * telling them a fact we never established. Absence already carries the
   * meaning "capability not live" on both clients by prior contract, which
   * is the honest reading here. See apps/web/src/lib/api.ts (`sellSignal?:`
   * — "Consumers MUST treat absence as capability-not-live ... rather than
   * as 'no signal' — the two look identical on the wire but mean different
   * things to a seller").
   */
  sellSignal?: import("../signals/sellWindow.service.js").SellWindowSignal;
  /** CF-PRICING-ENVELOPE (Drew, 2026-07-31). Canonical pricing surface —
   *  the single shape iOS + web both bind to. Additive to the flat legacy
   *  fields above (fairMarketValue, estimatedValue, predictedPrice, etc.),
   *  which remain for one release while both clients migrate. Deletion
   *  of the flats happens in a follow-up CF once both clients cut over. */
  pricing: PricingEnvelope;
  /** CF-SURFACE-THE-PARKED-MATCH (Drew, 2026-08-23).
   *
   *  The matcher already found this card and we never showed the user.
   *
   *  canonicalize() runs at import and again at confirm, stores its answer on
   *  the holding as catalogMatchSlug, and pins cardId only at confidence >=
   *  0.9 (ebayAutoHolding.service.ts:195, ebayReviewQueue.service.ts:388).
   *  That gate is right — pinning a weak match prices the holding wrongly
   *  while looking confirmed. But below the gate the answer was simply parked,
   *  and NOTHING in src/ read the field. The user saw "Fix identity" with no
   *  suggestion and had to go searching for a card we had already identified.
   *
   *  Max Williams "2025 Bowman Draft Gold #CPA-MWI", $301.43 paid: parked at
   *  hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50, confidence 0.72,
   *  matchedBy "fuzzy-parallel" — the correct /50 Gold, unread.
   *
   *  Measured across the live portfolio 2026-08-23: 23 of 91 holdings carry no
   *  identity, and 20 of those 23 have a parked match. Surfacing them takes
   *  identity coverage from 74.7% to ~96.7% without acquiring a single row.
   *
   *  NULL unless there is genuinely something to offer: a holding that already
   *  resolved does not need a proposal, and a holding with no parked match has
   *  none to give. The confidence travels with it so the client can present a
   *  0.72 differently from a 0.89 rather than implying we are certain. */
  proposedIdentity: {
    slug: string;
    confidence: number | null;
    matchedBy: string | null;
  } | null;
  /** CF-REVIEW-REASON-ON-THE-WIRE (2026-08-23). `needsReview` is already on the
   *  wire; the sentence explaining it was not. After the no-identity-no-price
   *  guard shipped, a client could learn a holding needs review and had no way
   *  to say WHY, while the row was carrying the explanation the whole time —
   *  the same shape as the parked match itself. */
  reviewReason: string | null;
}

/** The parked match, or null when there is nothing to propose.
 *
 *  Reads the STORED identity only — deriveHoldingSlug() computes a slug from
 *  the holding's own fields, and those fields are exactly what is in doubt on
 *  an unidentified holding, so a derived slug must not suppress the proposal. */
function proposedIdentityOf(holding: PortfolioHolding): PortfolioHoldingWire["proposedIdentity"] {
  const h = holding as {
    cardId?: string | null;
    hobbyiqCardId?: string | null;
    catalogMatchSlug?: string | null;
    catalogMatchConfidence?: number | null;
    catalogMatchedBy?: string | null;
  };
  const resolved = String(h.cardId ?? "").trim() !== "" || String(h.hobbyiqCardId ?? "").trim() !== "";
  if (resolved) return null;

  const slug = String(h.catalogMatchSlug ?? "").trim();
  if (!slug) return null;

  return {
    slug,
    confidence: typeof h.catalogMatchConfidence === "number" ? h.catalogMatchConfidence : null,
    matchedBy: h.catalogMatchedBy ?? null,
  };
}

/**
 * CF-PRO-SELLER-GATE (Drew, 2026-09-02). Per-call entitlement facts the wire
 * composer needs. Deliberately a plain data object, not a user or a plan: the
 * composer must not learn to read entitlements itself. The ONE authority on
 * whether a plan grants a feature is hasEntitlement() over the matrix in
 * config/entitlements.ts, and it stays there — every caller resolves the
 * boolean at the route edge (through effectivePlanFor, so comped owners are
 * handled) and hands the answer down.
 *
 * DEFAULT IS FALSE, and that is the point. A new call site that forgets this
 * option emits a wire WITHOUT the paid field — the failure mode is a missing
 * signal, never a leaked one. The opposite default would make every future
 * call site a potential bypass.
 */
export interface WireEntitlements {
  /** Caller's effective plan grants `sellerIntelligence`. */
  sellSignalEntitled?: boolean;
  /**
   * H-13 (audit 2026-09-03). The measured #1644/#1647 player index per
   * holding id, when the caller has measured it.
   *
   * The sell-window signal's player side is that index, and measuring it
   * costs a bounded pool read per PLAYER — which this synchronous assembler
   * cannot do (the portfolio envelope has never computed a price, and that
   * property is load-bearing). So a caller that can afford the reads measures
   * them once for the page's players and hands the map down; a caller that
   * cannot passes nothing, and the derivation returns its honest
   * `no-player-index` refusal instead of reading the clamped
   * median-of-medians it used to.
   *
   * MEASURED, live, 2026-09-03: of 40 sampled holdings carrying a trend, 27
   * were evaluable and the real index was measurable for 14 of them (baskets
   * of 25-197 cards). So the refusal on this wire is NOT permanent blindness —
   * it is this endpoint declining to buy the reads, and the map is the seam
   * through which a caller that wants the signal supplies them. Two of those
   * 14 measured OUTSIDE the retired [0.85, 1.20] clamp (+23.4%, +23.6%),
   * which is exactly the magnitude the old code could not report.
   *
   * The per-holding routes in portfolioStore are synchronous and pass nothing
   * today; wiring them is a follow-up, deliberately not bundled here, because
   * it changes what those endpoints COST rather than what they claim.
   */
  playerIndexByHoldingId?: ReadonlyMap<string, { ratio: number; basketSize: number; tierScope?: string | null }>;
}

export function composeHoldingWireShape(
  holding: PortfolioHolding,
  /** CF-INVENTORY-CATALOG-IMAGE (2026-07-05): when the caller pre-resolved
   *  catalog images (see composePortfolioListResponse), this map supplies
   *  the URL by cardId. Undefined map / missing entry → catalogImageUrl
   *  is omitted from the wire (iOS falls back to its placeholder). */
  catalogImageByCardId?: ReadonlyMap<string, string>,
  /** CF-PRO-SELLER-GATE (2026-09-02): gates paid fields. Omitted → nothing
   *  paid is emitted. */
  entitlements?: WireEntitlements,
): PortfolioHoldingWire {
  const fmvPerUnit = computePerUnitValue(holding);

  // CF-CURRENTVALUE-DIMENSION-CANONICALIZE Ship 1: currentValue is the
  // "value-or-cost" display total. For priced holdings: FMV × qty. For
  // unpriced-with-cost: total cost basis (proxy — what the user paid is
  // the closest honest number we can show, NOT zero). For truly unknown:
  // 0. P&L applies its own basis > 0 guard so a cost-proxy nets to $0/
  // 0% (NOT -100%), which is the unpriced-deploy-gate fix.
  const currentValue = computeDisplayValue(holding);
  const basis = computeCostBasisTotal(holding);
  const totalProfitLoss = basis > 0 ? currentValue - basis : 0;
  const totalProfitLossPct = basis > 0 ? ((currentValue - basis) / basis) * 100 : 0;
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): observed-or-estimated per-row
  // headline. Returns null for valuationStatus="pending" — iOS renders
  // "valuation pending" treatment using estimateBasis prose.
  const displayable = computeDisplayablePerUnitValue(holding);
  const qty = Math.max(1, typeof holding.quantity === "number" && holding.quantity > 0 ? holding.quantity : 1);
  const displayableValue = displayable.value !== null ? displayable.value * qty : null;

  // CF-PORTFOLIO-DETAIL-SLUG (Drew, 2026-07-26). Prefer the stored slug;
  // compute on-fly for legacy holdings that predate the CF so iOS's
  // tap-into-card still resolves for holdings that were added before
  // write-time slugging landed.
  const hobbyiqCardId = holding.hobbyiqCardId ?? deriveHoldingSlug(holding);

  return {
    // Identity
    proposedIdentity: proposedIdentityOf(holding),
    reviewReason: ((holding as { reviewReason?: string | null }).reviewReason ?? null),
    id: holding.id,
    playerName: holding.playerName,
    cardTitle: holding.cardTitle,
    cardYear: holding.cardYear,
    product: holding.product,
    parallel: holding.parallel,
    cardNumber: holding.cardNumber,
    serialNumber: holding.serialNumber,
    isAuto: holding.isAuto,
    variation: holding.variation,
    hobbyiqCardId,
    // Grade
    gradeCompany: holding.gradeCompany,
    gradeValue: holding.gradeValue,
    // CF-GRADER-STATUS-FIELD (2026-06-28)
    graderStatus: holding.graderStatus,
    // Acquisition
    quantity: holding.quantity,
    purchasePrice: holding.purchasePrice,
    totalCostBasis: holding.totalCostBasis,
    purchaseDate: holding.purchaseDate,
    purchaseSource: holding.purchaseSource,
    // Listing intent
    listingUrl: holding.listingUrl,
    listingPrice: holding.listingPrice,
    // Timestamp
    lastUpdated: holding.lastUpdated,
    // Notes / media / client id
    notes: holding.notes,
    photos: holding.photos,
    clientId: holding.clientId,
    // CF-HELD-EXPENSES (2026-07-12): the expense array iOS renders and the
    // per-expense breakdown users edit. Must live on the wire shape so
    // mutation routes (POST/DELETE /holdings/:id/expenses) can return it.
    heldExpenses: (holding as any).heldExpenses,
    // CF-SOURCE-VENDOR-WIRE-STRIP (2026-07-13): sourceVendor +
    // sourceVendorUpdatedAt intentionally NOT surfaced to iOS.
    // MLB resolution
    playerId: holding.playerId,
    playerIdConfidence: holding.playerIdConfidence,
    playerIdResolvedAt: holding.playerIdResolvedAt,
    // eBay linkage
    ebayOfferId: holding.ebayOfferId,
    ebayListingId: holding.ebayListingId,
    ebayListingPublishedAt: holding.ebayListingPublishedAt,
    // CF-EBAY-AUTO-HOLDING (2026-07-12): auto-import provenance. Fields
    // are stored on the holding doc via `as any` at write time and
    // surfaced here so iOS gets the "auto-imported" markers.
    source: (holding as any).source,
    sourcePurchaseId: (holding as any).sourcePurchaseId,
    parseConfidence: (holding as any).parseConfidence,
    needsReview: (holding as any).needsReview,
    setName: (holding as any).setName,
    // CF-CARDID-SUGGESTER (2026-07-12)
    suggestedCardId: (holding as any).suggestedCardId,
    suggestionIdKind: (holding as any).suggestionIdKind,
    suggestionConfidence: (holding as any).suggestionConfidence,
    suggestionCandidate: (holding as any).suggestionCandidate,
    suggestionConfidenceTier: (holding as any).suggestionConfidenceTier,
    suggestionMatchBreakdown: (holding as any).suggestionMatchBreakdown,
    suggestionUpdatedAt: (holding as any).suggestionUpdatedAt,
    // CF-CARDID-SUGGESTER-MULTI-VENDOR (Drew, 2026-07-14): the two new
    // fields from PR #438 were stored on the holding but NOT serialized
    // here, so iOS saw undefined candidateSource + missing alternatives
    // and rendered the review row as "no suggestion" even though Cosmos
    // had one. Root cause of Drew's 2026-07-14 report: "in review queue
    // but no suggestion to pick from" for 14 pending holdings.
    suggestionCandidateSource: (holding as any).suggestionCandidateSource,
    suggestionAlternatives: (holding as any).suggestionAlternatives,
    // CF-CARDID-SUGGESTER-CATALOG-VERIFY (Drew, 2026-07-14): reference-
    // catalog match on the suggestion. iOS badges "catalog verified"
    // when present. null when catalog lookup found no match OR when
    // env flag is off.
    suggestionCatalogVerified: (holding as any).suggestionCatalogVerified,
    // CF-EBAY-BROWSE-ENRICHMENT (2026-07-12)
    ebayImageUrl: (holding as any).ebayImageUrl,
    ebayShortDescription: (holding as any).ebayShortDescription,
    ebayItemAspects: (holding as any).ebayItemAspects,
    ebayCategoryPath: (holding as any).ebayCategoryPath,
    ebaySeller: (holding as any).ebaySeller,
    enrichedFromEbay: (holding as any).enrichedFromEbay,
    team: (holding as any).team,
    sport: (holding as any).sport,
    manufacturer: (holding as any).manufacturer,
    // Cert
    certNumber: holding.certNumber,
    certGrader: holding.certGrader,
    // CF-IDENTITY-VERIFIED (Drew, 2026-07-27): true iff the owner has
    // explicitly picked a catalog candidate through the Confirm gate.
    // Surfaced on the wire so portfolio row / storefront filters can
    // read it without a second call.
    identityVerified: (holding as { identityVerified?: boolean }).identityVerified,
    identityVerifiedAt: (holding as { identityVerifiedAt?: string }).identityVerifiedAt,
    identityVerifiedBy: (holding as { identityVerifiedBy?: { source: string; candidateId: string; verifiedAt: string } }).identityVerifiedBy,
    // CF-NEVER-AGAIN (Drew, 2026-09-02): the audit marker rides the envelope so
    // the portfolio row can render "under review" without a second call. Null
    // and undefined both mean "reconciled" — the badge is absence-safe.
    auditFlag: (holding as { auditFlag?: { reason: string; at: string; invariant: string } | null }).auditFlag ?? null,
    // Cardsight FK
    cardId: holding.cardId,
    gradeId: holding.gradeId,
    // CF-INVENTORY-CATALOG-IMAGE (2026-07-05): populated ONLY when the
    // caller pre-resolved images AND the holding has a resolved cardId
    // AND catalog meta was cached. Conditional spread — key omitted from
    // the wire otherwise so byte-identity holds for uploads / unmatched
    // holdings. Never synthesized: no cardId → no URL.
    ...(holding.cardId && catalogImageByCardId?.has(holding.cardId)
      ? { catalogImageUrl: catalogImageByCardId.get(holding.cardId) as string }
      : {}),
    // Cached pipeline (10)
    fairMarketValue: fmvPerUnit,
    predictedPrice: holding.predictedPrice ?? null,
    predictedPriceLow: holding.predictedPriceLow ?? null,
    predictedPriceHigh: holding.predictedPriceHigh ?? null,
    predictedPriceUpdatedAt: holding.predictedPriceUpdatedAt ?? null,
    movementDirection: holding.movementDirection ?? null,
    movementUpdatedAt: holding.movementUpdatedAt ?? null,
    verdict: holding.verdict ?? null,
    recommendation: holding.recommendation ?? null,
    predictedPriceMechanism: holding.predictedPriceMechanism ?? null,
    // CF-GRADED-RAIL-WIRE-IN (2026-06-14): graded-rail valuation fields.
    // fmvPerUnit is OBSERVED-ONLY (computePerUnitValue). estimatedValue
    // is the labeled estimate when the rail fires grounded; null when
    // observed or pending. iOS reads valuationStatus to decide which
    // treatment to render. currentValue/quickSale/premium below still
    // use observed-only fmvPerUnit — Step 2's totals split decides
    // whether to fold estimated dollars into headline aggregates.
    estimatedValue: holding.estimatedValue ?? null,
    estimateLow: holding.estimateLow ?? null,
    estimateHigh: holding.estimateHigh ?? null,
    estimateConfidence: holding.estimateConfidence ?? null,
    estimateBasis: holding.estimateBasis ?? null,
    isEstimate: holding.isEstimate ?? false,
    valuationStatus: holding.valuationStatus ?? null,
    // Computed CHEAP
    currentValue,
    totalProfitLoss,
    totalProfitLossPct,
    quickSaleValue: applyMultiplierOrNull(fmvPerUnit, QUICK_SALE_MULTIPLIER),
    premiumValue: applyMultiplierOrNull(fmvPerUnit, PREMIUM_MULTIPLIER),
    suggestedListPrice: applyMultiplierOrNull(fmvPerUnit, SUGGESTED_LIST_MULTIPLIER),
    freshnessStatus: freshnessFromPricingTimestamp(holding),
    displayableValue,
    displayableValueSource: displayable.source,
    // ── CF-COMP-HOLDING-WIRE-PARITY (PR #482, 2026-07-15) ─────────
    // Additive comp-family envelope aliases + derived tier/zone bands.
    // Every field below either mirrors an existing flat key or derives
    // from fmvPerUnit via the PR #481 multiplier constants.
    marketValue: fmvPerUnit,
    fairMarketValueLive: fmvPerUnit,
    predictedPriceRange:
      typeof holding.predictedPriceLow === "number"
        && typeof holding.predictedPriceHigh === "number"
        ? { low: holding.predictedPriceLow, high: holding.predictedPriceHigh }
        : null,
    // CF-COMP-HOLDING-WIRE-PARITY Slice 2 (PR #483): prefer the persisted
    // full attribution object; fall through to the flat mechanism string
    // for legacy holdings written before Slice 2.
    predictedPriceAttribution:
      (holding as any).predictedPriceAttribution
        && typeof (holding as any).predictedPriceAttribution === "object"
        ? ((holding as any).predictedPriceAttribution as { mechanism: string })
        : (typeof holding.predictedPriceMechanism === "string" && holding.predictedPriceMechanism.length > 0
            ? { mechanism: holding.predictedPriceMechanism }
            : null),
    estimateRange:
      typeof holding.estimateLow === "number"
        && typeof holding.estimateHigh === "number"
        ? { low: holding.estimateLow, high: holding.estimateHigh }
        : null,
    marketTier: {
      value: fmvPerUnit,
      high: applyHeadlineMultiplier(fmvPerUnit, PREMIUM_MULTIPLIER),
    },
    buyZone: [
      applyHeadlineMultiplier(fmvPerUnit, QUICK_SALE_MULTIPLIER * BUY_ZONE_LOW_MULTIPLIER),
      applyHeadlineMultiplier(fmvPerUnit, QUICK_SALE_MULTIPLIER),
    ],
    holdZone: [
      applyHeadlineMultiplier(fmvPerUnit, QUICK_SALE_MULTIPLIER),
      fmvPerUnit,
    ],
    sellZone: [
      fmvPerUnit,
      applyHeadlineMultiplier(fmvPerUnit, PREMIUM_MULTIPLIER),
    ],
    // CF-COMP-HOLDING-WIRE-PARITY Slice 2 (PR #483): emit the persisted
    // trendIQ + confidence values from the holding doc. Legacy holdings
    // written before Slice 2 have these fields undefined → wire coerces
    // to null. Fresh reprices via autoPriceHolding populate them per the
    // engine estimate response.
    trendIQ: (holding as any).trendIQ ?? null,
    confidence:
      typeof (holding as any).confidence === "number"
        ? (holding as any).confidence
        : null,
    // CF-SELLER-INTELLIGENCE-SELL-WINDOW (Drew, 2026-09-02): derived from
    // the two lines directly above plus the holding's own lastUpdated. Pure
    // and synchronous — no pool read, no price computed, so the portfolio
    // envelope keeps its "this endpoint has never computed a price"
    // property. A holding with no trend gets a `none` carrying the reason.
    //
    // CF-PRO-SELLER-GATE (Drew, 2026-09-02): conditional-spread emit, the
    // same pattern lastSaleSurface / modelExpectation / nearestGradedAnchor
    // already use on this wire. Unentitled → the key is absent entirely and
    // deriveSellWindowSignal is never even called, so the paid computation
    // does not run for a caller who cannot see it.
    ...(entitlements?.sellSignalEntitled
      ? {
          sellSignal: deriveSellWindowSignal({
            trendIQ: (holding as any).trendIQ ?? null,
            // H-13 (audit 2026-09-03): the #1644/#1647 index, when the caller
            // measured it (see WireEntitlements.playerIndexByHoldingId). This
            // assembler is synchronous and reads no pool of its own, so an
            // unmeasured player yields the derivation's `no-player-index`
            // refusal — a truthful "we did not look" — rather than the clamped
            // median-of-medians the module used to read while its header
            // claimed this very basket.
            playerIndex: entitlements?.playerIndexByHoldingId?.get(String((holding as { id?: unknown }).id ?? "")) ?? null,
            // CF-SELL-WINDOW-READS-PRICING-CONFIDENCE (2026-09-03). The
            // signal gates on, and quotes to the user as "Pricing confidence
            // on this card is N%", the confidence behind the PRICE. That is
            // pricingSourceMeta.confidence — the same quantity the report
            // envelope publishes as confidence.pricing — not the flat
            // `holding.confidence`, which on a unified-engine row is an
            // identity/match score and was additionally saturated to 1.0 by
            // the scaling defect this PR fixes. Reading the flat field here
            // let cards with a barely-evidenced price pass the timing gate
            // while telling the user their price was 100% confident.
            confidence: resolvePricingConfidence(holding as any),
            trendUpdatedAt:
              typeof holding.lastUpdated === "string" ? holding.lastUpdated : null,
          }),
        }
      : {}),
    // CF-CH-THIN-COMP-PRIMARY (2026-06-26): conditional spread so the key
    // is OMITTED entirely on every non-CH-last-sale holding (the universal
    // case). Preserves byte-identical wire emission for the existing
    // population — additive invariant locked by the wire-shape test.
    ...(holding.lastSaleSurface
      ? { lastSaleSurface: holding.lastSaleSurface }
      : {}),
    // CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): same conditional-
    // spread pattern. Key omitted when absent on the holding doc. Present
    // only on cardhedge-last-sale holdings whose engine signal succeeded
    // (curated row + empirical baseRelativePremium + sufficient base
    // autos). Non-signal holdings (the overwhelming majority) emit a wire
    // BYTE-IDENTICAL to pre-CF behavior.
    ...(holding.modelExpectation
      ? { modelExpectation: holding.modelExpectation }
      : {}),
    ...(holding.modelSignal
      ? { modelSignal: holding.modelSignal }
      : {}),
    // CF-NEAREST-ANCHOR-WIRE (2026-06-29): conditional-spread emit. Key
    // omitted on the universal case (no anchor stored). Present only on
    // holdings the ladder fallback rescued.
    ...(holding.nearestGradedAnchor
      ? { nearestGradedAnchor: holding.nearestGradedAnchor }
      : {}),
    // CF-PRICING-ENVELOPE (Drew, 2026-07-31). Canonical pricing surface
    // that iOS + web both bind to. Constructed from the same locals used
    // above so `pricing.headline.value` matches wire.fairMarketValue etc.
    // Additive — legacy flat fields stay for one release.
    pricing: buildPricingEnvelope(holding, {
      fmvPerUnit,
      displayable,
      quantity: qty,
      freshness: freshnessFromPricingTimestamp(holding),
    }),
    // CF-ACTION-RECOMMENDATION (2026-07-05, Drew): per-holding verdict.
    // Uses fmvPerUnit as currentValue and holding.predictedPrice as
    // predictedValue. signalSource is unavailable on the portfolio-
    // pipeline path (it's a card-panel-side field) — passing null gives
    // us fair-value LIST logic, not the early-decay override. Cost basis
    // (per-unit) enables the "projected below your cost" callout on
    // SELL_NOW verdicts.
    actionRecommendation: computeAction({
      currentValue: fmvPerUnit,
      predictedValue: (holding as any).predictedPrice ?? null,
      confidenceScore: confidenceScoreFromHolding(holding),
      signalSource: null,
      costBasis:
        typeof holding.purchasePrice === "number" && holding.purchasePrice > 0
          ? holding.purchasePrice
          : null,
    }),
  };
}

export function composePortfolioListResponse(
  items: PortfolioHolding[],
  /** CF-INVENTORY-CATALOG-IMAGE (2026-07-05): pre-resolved catalog image
   *  URLs keyed by cardId. The route (getPortfolioWithSummary) builds
   *  this map once per request via resolveCatalogImageUrl so meta cache
   *  hits are amortized across the whole portfolio. Optional — callers
   *  without it (tests, legacy paths) get the pre-CF wire shape verbatim. */
  catalogImageByCardId?: ReadonlyMap<string, string>,
  /** CF-PRO-SELLER-GATE (2026-09-02): threaded to every entry. Omitted →
   *  no paid field on any of them. */
  entitlements?: WireEntitlements,
): PortfolioHoldingWire[] {
  return items.map((h) => composeHoldingWireShape(h, catalogImageByCardId, entitlements));
}
