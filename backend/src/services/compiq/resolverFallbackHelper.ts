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

/**
 * CF-RESOLVER-FALLBACK-COMPIQ-ROUTES (2026-07-13): overlay helper for the
 * compiq/search + /price + /price-by-id routes. Called at the tail of each
 * route right before res.json. If the response's fairMarketValueLive AND
 * marketValue are both null (CH catalog gap), attempt the resolver fallback
 * and overlay the rescue vendor's FMV.
 *
 * DESIGN CONSTRAINT (Drew, 2026-07-13): iOS response shape stays identical
 * to the pre-fallback contract. The overlay only fills EXISTING fields that
 * CH would have populated on a successful pricing — no new keys iOS would
 * see. sourceVendor / vendor attribution is emitted to structured logs
 * only (for internal audit), never on the wire.
 *
 * Overlaid fields (all pre-existing on the response shape):
 *   fairMarketValueLive → resolver FMV
 *   marketValue         → resolver FMV
 *   marketTier.value    → resolver FMV (nested tier band)
 *   estimateBasis       → "N comp(s) via <vendor>" (CH also uses this key)
 *   approximate         → true (bool CH already flips)
 *
 * Pipeline fields (comps[], trendIQ, predictedPrice, etc.) are NOT
 * synthesized — they stay null. iOS renders the base price + skips the
 * trend/prediction blocks for null-signal responses just as it does for
 * a CH low-confidence result today.
 *
 * Idempotent + safe: returns the original response object mutated in-place.
 * Never throws.
 */
export async function overlayResolverRescue(
  response: any,
  query: CardQuery,
): Promise<any> {
  if (!response || typeof response !== "object") return response;

  // Skip when CH already produced a real FMV.
  const hasFmv =
    (typeof response.fairMarketValueLive === "number" && response.fairMarketValueLive > 0) ||
    (typeof response.marketValue === "number" && response.marketValue > 0);
  if (hasFmv) return response;

  const fallback = await tryResolverFallback(query);
  if (!fallback) return response;

  response.fairMarketValueLive = fallback.fairMarketValue;
  response.marketValue = fallback.fairMarketValue;
  response.estimateBasis = fallback.estimateBasis;
  response.approximate = true;
  if (response.marketTier && typeof response.marketTier === "object") {
    response.marketTier.value = fallback.fairMarketValue;
  }
  // Vendor attribution logged to KQL only — NOT on the wire (iOS shape lock).
  console.log(JSON.stringify({
    event: "catalog_resolver_route_rescue",
    source: "resolverFallbackHelper.overlayResolverRescue",
    vendor: fallback.vendor,
    fairMarketValue: fallback.fairMarketValue,
    compCount: fallback.compCount,
    query: {
      playerName: query.playerName,
      cardYear: query.cardYear,
      parallel: query.parallel,
      cardNumber: query.cardNumber,
    },
  }));
  return response;
}
