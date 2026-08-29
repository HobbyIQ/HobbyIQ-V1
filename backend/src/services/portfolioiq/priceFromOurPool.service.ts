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
//       method === "rare-card-anchor" → estimated (last real sale of THIS
//                                        card, projected by parent drift)
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
import type { FmvRungLabel } from "../compiq/fmvRung.js";
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
  /** CF-RUNG-LABEL (D4 PR 1): the hobbyIqFmv rung in the shared
   *  vocabulary, carried onto the holding as `fmvRung`. */
  rungLabel: FmvRungLabel;
  compsUsed: number;
  slug: string;
  source: "our-pool";
}

// Rungs where a graded query returning a positive fmv is treated as an
// observation of real graded comps of this-or-nearby identity. "no-basis"
// and "grade-cross-raw" are handled explicitly outside this set.
//
// CF-OBSERVED-NEEDS-COMPS (Drew, 2026-08-22). Membership here is NOT on its
// own enough to publish a number as observed — see MIN_COMPS_FOR_BROAD_RUNG.
const OBSERVED_RUNGS: ReadonlySet<HobbyIqFmvMethod> = new Set<HobbyIqFmvMethod>([
  "direct-slug",
  "cross-setkey",
  "cross-printrun",
  "same-printrun-cross-parallel",
  "printrun-discovery",
  "sibling-parallel",
  "family-baseline",
]);

/**
 * CF-OBSERVED-NEEDS-COMPS (Drew, 2026-08-22).
 *
 * Every rung above direct-slug prices a DIFFERENT card and reasons across to
 * this one. That is legitimate when several sales agree. It is not when the
 * rung found one.
 *
 * Live case that surfaced it — 2024 Bowman Draft Cam Caminiti #CPA-CC Blue
 * Refractor /150, cost $205.40. The Blue Refractor partition holds zero
 * comps, so cross-setkey fired, found exactly ONE sale under a different
 * setKey, and published $4.99 as an OBSERVED fair market value. The card's
 * own sibling parallels were all sitting in the pool at the time:
 *
 *     base:auto              7 comps   $39-62
 *     refractor:auto         5 comps   $38-58
 *     purple-refractor /250  2 comps   $56-128
 *     green-lava /99         1 comp    $113.50
 *
 * The cheapest real sale of that card in ANY parallel is $37. The dashboard
 * rendered -97.6% P&L against cost off a single stray comp.
 *
 * So a broad rung must clear a floor before it counts as observed. Below it
 * the number still goes out — suppressing it entirely would leave the card
 * blank when we do hold weak evidence — but as an ESTIMATE carrying its
 * confidence tier and band, which is what the UI needs to render it as a
 * guess rather than a fact.
 *
 * direct-slug is deliberately exempt. One sale of the EXACT card is thin,
 * but it is genuinely that card, which is the whole difference.
 */
const MIN_COMPS_FOR_BROAD_RUNG = 3;

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
      // CF-CROSS-SETKEY-STAYS-HOME (D4 PR 5): the holding's player, so the
      // cross-setkey rung can refuse another player's card number.
      playerName: typeof holding.playerName === "string" ? holding.playerName : null,
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
        rungLabel: result.rungLabel,
        compsUsed,
        slug,
        source: "our-pool",
      };
    }

    // "Observed" from our pool — real recorded sales, not synthesized values.
    //
    // CF-OBSERVED-NEEDS-COMPS (2026-08-22). A broad rung has to clear
    // MIN_COMPS_FOR_BROAD_RUNG first. This block previously published any
    // rung in OBSERVED_RUNGS as observed regardless of compCount, which is
    // how a single cross-setkey comp became a $4.99 "observed" FMV on a card
    // whose own comps run $37-128.
    //
    // It also set estimateConfidence: null while the comment directly above
    // it claimed the number carried "lower confidence". The tier was computed
    // and thrown away, so nothing downstream could tell a 50-comp direct hit
    // from a 1-comp reach. `conf` now rides along on both paths.
    const isBroadRung = result.method !== "direct-slug";
    if (OBSERVED_RUNGS.has(result.method)
        && (!isBroadRung || compsUsed >= MIN_COMPS_FOR_BROAD_RUNG)) {
      return {
        fairMarketValue: result.fmv,
        valuationStatus: "observed",
        estimatedValue: null,
        estimateLow: null,
        estimateHigh: null,
        estimateConfidence: conf,
        estimateBasis: result.basisNote,  // the rung's prose, for transparency
        method: result.method,
        rungLabel: result.rungLabel,
        compsUsed,
        slug,
        source: "our-pool",
      };
    }

    // CF-RARE-CARD-ANCHOR-LABEL (2026-08-22). One real sale of the EXACT card,
    // projected forward by the parent pool's drift. By this file's own rule —
    // "one sale of the EXACT card is thin, but it is genuinely that card" — it
    // is not a broad rung and does not face MIN_COMPS_FOR_BROAD_RUNG.
    //
    // It is still an ESTIMATE, not an observation: the projection is modelled,
    // and rareCardFmv hands us a confidence band precisely because of that. So
    // the number goes out with its band and tier, which is what the UI needs to
    // render a guess as a guess. Before this rung was named, it was labelled
    // "no-basis" and dropped entirely — the card went blank instead.
    if (result.method === "rare-card-anchor") {
      return {
        fairMarketValue: null,
        valuationStatus: "estimated",
        estimatedValue: result.fmv,
        estimateLow: band.low,
        estimateHigh: band.high,
        estimateConfidence: conf,
        estimateBasis: result.basisNote,
        method: result.method,
        rungLabel: result.rungLabel,
        compsUsed,
        slug,
        source: "our-pool",
      };
    }

    // Broad rung that did not clear the floor. Still worth showing — we do
    // hold SOME evidence, and blanking the card hides that — but as an
    // estimate with its band and tier, never as a fact.
    if (OBSERVED_RUNGS.has(result.method)) {
      return {
        fairMarketValue: null,
        valuationStatus: "estimated",
        estimatedValue: result.fmv,
        estimateLow: band.low,
        estimateHigh: band.high,
        estimateConfidence: conf,
        estimateBasis: result.basisNote,
        method: result.method,
        rungLabel: result.rungLabel,
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
      rungLabel: result.rungLabel,
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
