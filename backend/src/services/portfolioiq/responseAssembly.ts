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
export function freshnessFromPricingTimestamp(h: PortfolioHolding | undefined | null): string {
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
  suggestionConfidence?: number | null;
  suggestionCandidate?: {
    title?: string;
    set?: string;
    year?: number | string;
    number?: string;
    variant?: string;
    image?: string;
  } | null;
  suggestionUpdatedAt?: string | null;
  // Auxiliary aspect fields we backfilled from Browse (team, sport,
  // manufacturer) — always optional so old holdings still decode.
  team?: string | null;
  sport?: string | null;
  manufacturer?: string | null;
  // Cert
  certNumber?: string | null;
  certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
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
}

export function composeHoldingWireShape(
  holding: PortfolioHolding,
  /** CF-INVENTORY-CATALOG-IMAGE (2026-07-05): when the caller pre-resolved
   *  catalog images (see composePortfolioListResponse), this map supplies
   *  the URL by cardId. Undefined map / missing entry → catalogImageUrl
   *  is omitted from the wire (iOS falls back to its placeholder). */
  catalogImageByCardId?: ReadonlyMap<string, string>,
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

  return {
    // Identity
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
    suggestionConfidence: (holding as any).suggestionConfidence,
    suggestionCandidate: (holding as any).suggestionCandidate,
    suggestionUpdatedAt: (holding as any).suggestionUpdatedAt,
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
    quickSaleValue: applyMultiplierOrNull(fmvPerUnit, 0.85),
    premiumValue: applyMultiplierOrNull(fmvPerUnit, 1.15),
    suggestedListPrice: applyMultiplierOrNull(fmvPerUnit, 1.05),
    freshnessStatus: freshnessFromPricingTimestamp(holding),
    displayableValue,
    displayableValueSource: displayable.source,
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
): PortfolioHoldingWire[] {
  return items.map((h) => composeHoldingWireShape(h, catalogImageByCardId));
}
