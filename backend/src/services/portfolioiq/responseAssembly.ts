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
  // Cert
  certNumber?: string | null;
  certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
  // Cardsight FK
  cardsightCardId?: string | null;
  cardsightGradeId?: string | null;
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
}

export function composeHoldingWireShape(holding: PortfolioHolding): PortfolioHoldingWire {
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
    // Cert
    certNumber: holding.certNumber,
    certGrader: holding.certGrader,
    // Cardsight FK
    cardsightCardId: holding.cardsightCardId,
    cardsightGradeId: holding.cardsightGradeId,
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
  };
}

export function composePortfolioListResponse(items: PortfolioHolding[]): PortfolioHoldingWire[] {
  return items.map(composeHoldingWireShape);
}
