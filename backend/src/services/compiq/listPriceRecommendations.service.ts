// CF-LIST-PRICE-RECS (Drew, 2026-07-13, PR #427): trend-anchored list
// price recommendations. Every priced-card response now carries three
// suggested list prices so iOS' sell/list flow can auto-fill instead
// of guessing.
//
//   suggested   — predictedPrice (30d forward projection of the trend)
//   aggressive  — predictedPriceRange.high (top of confidence band)
//   quickSale   — marketValue × 0.90 (accept a 10% haircut for velocity)
//
// Returns null when the underlying pricing data is too thin to trust
// (marketValue null OR unavailable).

export interface ListPriceRecommendations {
  suggested: number | null;
  aggressive: number | null;
  quickSale: number | null;
  rationale: {
    suggestedBasis: string;   // "predicted next 30d"
    aggressiveBasis: string;  // "top of prediction range"
    quickSaleBasis: string;   // "10% below Market Value for velocity"
  };
}

export function buildListPriceRecommendations(input: {
  marketValue: number | null;
  predictedPrice: number | null;
  predictedPriceRange: { low?: number | null; high?: number | null } | null;
}): ListPriceRecommendations | null {
  const mv = typeof input.marketValue === "number" && input.marketValue > 0
    ? input.marketValue
    : null;
  const pp = typeof input.predictedPrice === "number" && input.predictedPrice > 0
    ? input.predictedPrice
    : null;
  const ppHigh = typeof input.predictedPriceRange?.high === "number" && input.predictedPriceRange.high > 0
    ? input.predictedPriceRange.high
    : null;

  if (mv == null && pp == null) return null;

  const quickSale = mv != null ? Math.round(mv * 0.90) : null;
  const suggested = pp ?? mv;
  const aggressive = ppHigh ?? (pp != null ? Math.round(pp * 1.10) : null);

  return {
    suggested,
    aggressive,
    quickSale,
    rationale: {
      suggestedBasis: pp != null ? "predicted next 30d" : "current market value",
      aggressiveBasis: ppHigh != null ? "top of prediction range" : "10% above predicted",
      quickSaleBasis: "10% below market value for velocity",
    },
  };
}
