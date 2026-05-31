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
//   • freshnessStatus — CACHED PASS-THROUGH this phase. Writers stamp
//     operationally ("Live" at autoPrice, "Updated Today" at sell,
//     "Stale" at reprice-fail). A compute-from-lastUpdated recipe was
//     attempted and REVERTED — lastUpdated bumps on reprice FAILURE
//     too (portfolioStore.service.ts:2047-2056), so an age-based recipe
//     reads "Live" on holdings whose last reprice failed, losing the
//     "Stale" signal. Phase C scope: compute from a success-only
//     timestamp (verify predictedPriceUpdatedAt / movementUpdatedAt
//     qualify; add pricedAt only if neither does), then drop the cached
//     field. See CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C scope in
//     SESSION_HANDOFF.md.
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
import { computePerUnitValue, computeTotalValue } from "./portfolioStore.service.js";

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function applyMultiplierOrNull(value: number | null, multiplier: number): number | null {
  return value === null ? null : value * multiplier;
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
  // Computed CHEAP at response (7)
  currentValue: number;
  totalProfitLoss: number;
  totalProfitLossPct: number;
  quickSaleValue: number | null;
  premiumValue: number | null;
  suggestedListPrice: number | null;
  freshnessStatus: string | null;
}

export function composeHoldingWireShape(holding: PortfolioHolding): PortfolioHoldingWire {
  const fmvPerUnit = computePerUnitValue(holding);
  const fmvTotal = computeTotalValue(holding);

  const currentValue = fmvTotal ?? 0;
  const basis = toFiniteNumber(holding.totalCostBasis, 0);
  const totalProfitLoss = basis > 0 ? currentValue - basis : 0;
  const totalProfitLossPct = basis > 0 ? ((currentValue - basis) / basis) * 100 : 0;

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
    // Computed CHEAP
    currentValue,
    totalProfitLoss,
    totalProfitLossPct,
    quickSaleValue: applyMultiplierOrNull(fmvPerUnit, 0.85),
    premiumValue: applyMultiplierOrNull(fmvPerUnit, 1.15),
    suggestedListPrice: applyMultiplierOrNull(fmvPerUnit, 1.05),
    freshnessStatus: holding.freshnessStatus ?? null,
  };
}

export function composePortfolioListResponse(items: PortfolioHolding[]): PortfolioHoldingWire[] {
  return items.map(composeHoldingWireShape);
}
