// CF-RESOLVER-FALLBACK-EVERYWHERE (2026-07-13): shared helper for the
// "CH catalog-miss → resolver rescue" pattern. Called at every price
// surface (autoPriceHolding, repriceHoldingsForUser, compiq/search,
// compiq/price, compiq/price-by-id) so the fallback logic lives in
// ONE place and evolves consistently.
//
// Contract:
//   - Only fires when CH truly had nothing (both fmv AND estimated null)
//   - Consults every registered vendor source in parallel
//   - Uses only NON-cardhedge winners (any cardhedge answer would have
//     already been consumed by the primary path)
//   - Returns null when no non-CH vendor has a confident answer

import { resolveCard, type CardQuery, type CardResolution } from "./catalogResolver.service.js";

export interface FallbackResult {
  fairMarketValue: number;
  vendor: string;
  compCount: number;
  estimateBasis: string;
}

/**
 * Try the multi-source resolver as a rescue when the primary CH pricing
 * failed. Returns null unless a non-CH vendor has a positive FMV.
 *
 * Callers should merge the returned fields onto their response shape:
 *   - fairMarketValue → holding.fairMarketValue / response.marketValue
 *   - vendor          → holding.sourceVendor / response.sourceVendor
 *   - estimateBasis   → holding.estimateBasis / response.attribution
 * And stamp valuationStatus = "estimated", isEstimate = true.
 */
export async function tryResolverFallback(query: CardQuery): Promise<FallbackResult | null> {
  try {
    const resolution = await resolveCard(query);
    const w = resolution.winner;
    if (
      w &&
      w.vendor !== "cardhedge" &&
      typeof w.fairMarketValue === "number" &&
      w.fairMarketValue > 0
    ) {
      return {
        fairMarketValue: w.fairMarketValue,
        vendor: w.vendor,
        compCount: w.compCount,
        estimateBasis: `${w.compCount} comp(s) via ${w.vendor}`,
      };
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "resolver_fallback_error",
      source: "resolverFallbackHelper",
      error: (err as Error)?.message ?? String(err),
    }));
  }
  return null;
}

/**
 * Convenience: given a computed estimate result and a query, decide if the
 * fallback should fire. Encapsulates the "CH truly had nothing" predicate
 * so every caller uses the same rule.
 */
export function shouldTryFallback(estimate: {
  fairMarketValue?: number | null;
  estimatedValue?: number | null;
} | null | undefined): boolean {
  if (!estimate) return true;
  const hasFmv = typeof estimate.fairMarketValue === "number" && estimate.fairMarketValue > 0;
  const hasEstimated = typeof estimate.estimatedValue === "number" && estimate.estimatedValue > 0;
  return !hasFmv && !hasEstimated;
}
