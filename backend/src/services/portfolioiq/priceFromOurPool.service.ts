// CF-OUR-POOL-PORTFOLIO-PRICER (Drew, 2026-07-27).
//
// Portfolio pricing helper that reads from OUR sold_comps pool via the
// hobbyiq-fmv service, not from any live vendor lookup. Consumed by
// autoPriceHolding behind PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED.
//
// Why: the legacy path in autoPriceHolding routes graded holdings
// through the CH/CS cardId-dependent graded-rail, which calls
// getPricingForMarketRead — a Wave-3b removal stub that unconditionally
// returns { notFound: true }. So the entire graded-rail branch is dead
// code, and graded holdings without a cardId fall through to legacy
// computeEstimate + get "Raw anchor $X, used directly" with no PSA
// multiplier ever applied. hobbyiq-fmv already reads our sold_comps
// pool by slug, walks a 7-rung ladder, and applies grade multipliers at
// rung 7 (grade-cross-raw) via GRADE_CALIBRATION. This helper wires
// that in as the portfolio pricer.
//
// Behavior:
//   - Ensures holding has hobbyiqCardId (computes via deriveHoldingSlug
//     if missing); returns null when slug can't be derived (identity
//     insufficient) so caller falls back to legacy.
//   - Calls computeHobbyIqFmv({slug, gradeCompany, gradeValue}).
//   - Interprets the winning rung:
//       method === "grade-cross-raw"  → estimated (raw × multiplier)
//       method === "no-basis"         → null (no data; fall back)
//       any other observed rung       → observed (real graded comps
//                                        of this exact / adjacent identity)
//   - Populates {fairMarketValue, valuationStatus, estimatedValue,
//     estimateLow, estimateHigh, estimateConfidence, estimateBasis}
//     ready to be written back onto the holding.
//
// Wrapped in try/catch: any error → returns null so autoPriceHolding
// falls through to the legacy engine. No exception ever bubbles into
// a holding write.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { computeHobbyIqFmv, type HobbyIqFmvMethod, type HobbyIqFmvResult } from "./hobbyIqFmv.service.js";
import { deriveHoldingSlug } from "./holdingSlug.service.js";

export interface OurPoolPricingResult {
  fairMarketValue: number | null;
  valuationStatus: "observed" | "estimated" | "pending";
  estimatedValue: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  estimateConfidence: "estimate" | "rough" | "ballpark" | "no-data" | null;
  estimateBasis: string | null;
  method: HobbyIqFmvMethod;
  compsUsed: number;
  slug: string;
  source: "our-pool";
}

// Rungs where a graded query returning a positive fmv is treated as an
// observation of real graded comps of this-or-nearby identity. "no-basis"
// and "grade-cross-raw" are handled explicitly outside this set.
const OBSERVED_RUNGS: ReadonlySet<HobbyIqFmvMethod> = new Set<HobbyIqFmvMethod>([
  "direct-slug",
  "cross-printrun",
  "same-printrun-cross-parallel",
  "printrun-discovery",
  "sibling-parallel",
  "family-baseline",
]);

// Estimate confidence tier from the FMV service's numeric confidence.
// hobbyiq-fmv returns a 0-1 score per rung; map into the discrete tier
// autoPriceHolding writes into estimateConfidence.
function confidenceTier(numeric: number): "estimate" | "rough" | "ballpark" | "no-data" {
  if (!Number.isFinite(numeric)) return "no-data";
  if (numeric >= 0.70) return "estimate";
  if (numeric >= 0.45) return "rough";
  if (numeric > 0) return "ballpark";
  return "no-data";
}

// Default ±20% band when the rung emits no explicit low/high.
function bandAround(v: number, pct = 0.20): { low: number; high: number } {
  return { low: v * (1 - pct), high: v * (1 + pct) };
}

function requestedGrade(holding: PortfolioHolding): { company: string | null; value: number | null } {
  const co = String((holding as { gradeCompany?: unknown }).gradeCompany ?? "").trim().toUpperCase();
  const rawValue = (holding as { gradeValue?: unknown }).gradeValue;
  const n = Number(rawValue);
  const value = Number.isFinite(n) && n > 0 ? n : null;
  return { company: co || null, value };
}

/**
 * Price a holding from our own sold_comps pool via hobbyiq-fmv.
 * Returns null when the pool has no data OR the holding lacks a
 * derivable slug — caller must fall through to legacy computeEstimate.
 */
export async function priceHoldingFromOurPool(
  holding: PortfolioHolding,
): Promise<OurPoolPricingResult | null> {
  try {
    const explicit = typeof holding.hobbyiqCardId === "string" ? holding.hobbyiqCardId.trim() : "";
    const slug = explicit.startsWith("hiq:") ? explicit : deriveHoldingSlug(holding);
    if (!slug) return null;

    const { company, value } = requestedGrade(holding);
    const result: HobbyIqFmvResult = await computeHobbyIqFmv({
      hobbyiqCardId: slug,
      gradeCompany: company,
      gradeValue: value,
    });

    if (result.method === "no-basis" || result.fmv === null || result.fmv <= 0) {
      return null;
    }

    const compsUsed = result.compCount;
    const conf = confidenceTier(result.confidence);
    const explicitLow = typeof result.min === "number" && result.min > 0 ? result.min : null;
    const explicitHigh = typeof result.max === "number" && result.max > 0 ? result.max : null;
    // Use pool min/max as band ONLY when it's a reasonable ±40% envelope;
    // otherwise fall back to a fixed ±20% around fmv to avoid the UI
    // rendering a "$50–$5000" range on a spread pool.
    const useExplicit =
      explicitLow != null
      && explicitHigh != null
      && explicitLow >= result.fmv * 0.5
      && explicitHigh <= result.fmv * 2.0;
    const band = useExplicit
      ? { low: explicitLow as number, high: explicitHigh as number }
      : bandAround(result.fmv, 0.20);

    // grade-cross-raw is a synthetic estimate. Everything else with a
    // requested grade is observation of adjacent-identity real sales.
    if (result.method === "grade-cross-raw") {
      return {
        fairMarketValue: null,
        valuationStatus: "estimated",
        estimatedValue: result.fmv,
        estimateLow: band.low,
        estimateHigh: band.high,
        estimateConfidence: conf,
        estimateBasis: result.basisNote,
        method: result.method,
        compsUsed,
        slug,
        source: "our-pool",
      };
    }

    // "Observed" from our pool. For rungs broader than direct-slug (e.g.
    // family-baseline or sibling-parallel) we still classify the number
    // as observed but with lower confidence — these are real recorded
    // sales of adjacent-identity cards, not synthesized values. The
    // basisNote makes the rung transparent to the user.
    if (OBSERVED_RUNGS.has(result.method)) {
      return {
        fairMarketValue: result.fmv,
        valuationStatus: "observed",
        estimatedValue: null,
        estimateLow: null,
        estimateHigh: null,
        estimateConfidence: null,
        estimateBasis: result.basisNote,  // still record the rung's prose for transparency
        method: result.method,
        compsUsed,
        slug,
        source: "our-pool",
      };
    }

    // Unknown method — belt-and-suspenders, treat as estimated.
    return {
      fairMarketValue: null,
      valuationStatus: "estimated",
      estimatedValue: result.fmv,
      estimateLow: band.low,
      estimateHigh: band.high,
      estimateConfidence: conf,
      estimateBasis: result.basisNote,
      method: result.method,
      compsUsed,
      slug,
      source: "our-pool",
    };
  } catch (err) {
    // Never crash autoPriceHolding — always give the caller the safe
    // fall-through by returning null on any error.
    console.warn(
      `[priceFromOurPool] failed for holding ${String((holding as { id?: unknown }).id ?? "?")}: ${(err as Error)?.message ?? String(err)}`,
    );
    return null;
  }
}

/** Feature-flag gate. Reads env var each call so we can flip on live
 *  App Service without a redeploy. */
export function isPriceFromOurPoolEnabled(): boolean {
  const v = String(process.env.PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
