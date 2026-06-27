// CF-COMPILE-GRADED-ESTIMATES (2026-06-14) — extraction of the
// /price-by-id route's gradedEstimates assembly block ([routes.ts L1466-
// L1581 at c56a65f) into a reusable helper. PURE NO-BEHAVIOR-CHANGE
// REFACTOR: the output array must be byte-identical to the prior inline
// path's output for any given (pricing, estimate, parallelId,
// parallelName, isRawScope, isThinMarket, gradeBreakdown) tuple, and
// the same telemetry events (mutation-detected stderr JSON,
// release-curve-failed + build-failed stdout warns) must fire with the
// caller-provided `source` string.
//
// Why a helper: autoPriceHolding (portfolioStore.service.ts L897+) now
// needs the same gradedEstimates array at holding-write time. Duplicating
// the route's assembly logic would let it drift; extraction gives a
// single canonical implementation that the route AND the holding writer
// share. The helper:
//   1. Computes anchor precedence (CF-ANCHOR-PRECEDENCE 2026-06-14):
//      fmv when observed, else lastSale.price when iOS surfaces the
//      thin-data slot, else null (engine composes).
//   2. Fetches the release-level grade-premium curve (CF Phase 1c)
//      when pricing.card.set carries release + year. Cache-keyed in
//      gradedPriceProjection.ts at the 6h TTL — no extra cost per
//      request after the first in the release.
//   3. Calls buildGradedEstimates with the snapshot invariant inputs.
//   4. Surfaces mutationDetected so the caller can log + alert.
//
// Helper traps all internal throws → returns { estimates: [],
// mutationDetected: false } so the caller doesn't need its own
// try/catch (route's outer try/catch is now redundant but harmless).

import type { CardsightPricingResponse } from "./catalogSource.js";
import { getCardDetail } from "./catalogSource.js";
import {
  buildGradedEstimates,
  computeReleaseGradeCurve,
  computeSameParallelRawMedian,
  type GradedProjectionResult,
} from "./gradedPriceProjection.js";
import type { TrendIQResult } from "./trendIQ.types.js";

export interface CompileGradedEstimatesInput {
  pricing: CardsightPricingResponse;
  /** The estimate object returned by computeEstimate(...). Only the
   *  fields used for anchor precedence + mutation snapshots are read;
   *  cast at the boundary. */
  estimate: {
    fairMarketValue?: number | null;
    lastSale?: { price?: number | null | undefined } | null | undefined;
    daysSinceNewestComp?: number | null;
    recentComps?: ReadonlyArray<unknown>;
    /**
     * CF-ESTIMATOR-PHASE-1 (2026-06-14): consumed by the new observed-
     * anchor paths to forward-project an old sibling/same-parallel sale.
     * Null/undefined or "insufficient" coverage = no forward shift.
     */
    trendIQ?: TrendIQResult | null;
  };
  /** Cardsight parallelId of the request (null/undefined for base scope). */
  parallelId: string | null;
  /** Human-readable parallel name (null/undefined when unknown).
   *  Falls back to "this parallel" inside the engine when null on a
   *  parallel-scope request. */
  parallelName: string | null;
  /** True iff the request has NO graded scope (no gradeCompany +
   *  gradeValue). Anchor precedence only uses fmv when raw-scope —
   *  on graded-scope requests, fmv is a graded median (wrong anchor;
   *  engine falls to parallel-composed). */
  isRawScope: boolean;
  /** True iff est.fairMarketValue is null/<=0. Drives the
   *  marketTierValue snapshot used by the no-mutation invariant. */
  isThinMarket: boolean;
  /** The gradeBreakdown array shipped on the same response — passed in
   *  for the no-mutation invariant snapshot, never mutated. */
  gradeBreakdown: ReadonlyArray<unknown>;
  /** Telemetry source for warn/error events (e.g. "compiq.price-by-id",
   *  "portfolio.autoPriceHolding"). */
  source: string;
  /** Telemetry cardId tag. */
  cardId: string;
}

export interface CompileGradedEstimatesResult {
  estimates: GradedProjectionResult[];
  mutationDetected: boolean;
}

export async function compileGradedEstimatesForCard(
  input: CompileGradedEstimatesInput,
): Promise<CompileGradedEstimatesResult> {
  try {
    const {
      pricing,
      estimate,
      parallelId,
      parallelName,
      isRawScope,
      isThinMarket,
      gradeBreakdown,
      source,
      cardId,
    } = input;

    const fmv = estimate.fairMarketValue ?? 0;

    // CF-ANCHOR-PRECEDENCE (2026-06-14): mirror the value iOS displays.
    // fmv > 0 → marketTier.value (the headline). Else lastSale.price (the
    // "last sold $X, N ago" thin-data slot). Else null (no raw shown →
    // engine composes via base × multiplier).
    const lastSalePriceRaw = estimate.lastSale?.price;
    const lastSalePrice =
      typeof lastSalePriceRaw === "number"
      && Number.isFinite(lastSalePriceRaw)
      && lastSalePriceRaw > 0
        ? lastSalePriceRaw
        : null;
    const daysSinceNewestCompRaw = estimate.daysSinceNewestComp;
    const daysSinceNewestComp =
      typeof daysSinceNewestCompRaw === "number"
      && Number.isFinite(daysSinceNewestCompRaw)
      && daysSinceNewestCompRaw >= 0
        ? daysSinceNewestCompRaw
        : null;

    // CF-ESTIMATOR-PHASE-1 (2026-06-14): fetch the card-level parallels[]
    // for the sibling-observed anchor path. CF-GRADED-PRECEDENCE-OBSERVED
    // (2026-06-15) also needs them upstream of the parallelRawFmv
    // computation for the graded-scope observed-anchor selector's
    // sibling-token exclusion. Fetch once, reuse for both paths.
    //
    // getCardDetail is cached at 24h TTL in cardsight.client; first hit
    // per card is ~one round-trip and subsequent compile calls reuse the
    // cached result. Skipped for base scope (no parallel target → both
    // branches that consume parallels never fire). On failure: catch and
    // pass empty parallels so the engine gracefully degrades.
    //
    // CF-ESTIMATOR-PHASE-2 (2026-06-15): the same getCardDetail call
    // surfaces `attributes` — we extract `isAuto` here (no extra round-
    // trip) and thread it through so the parallel-composed anchor
    // applies the auto-base power-law correction.
    let cardParallels: ReadonlyArray<{ id: string; name: string; numberedTo?: number | null }> = [];
    let isAuto = false;
    if (parallelId) {
      try {
        const detail = await getCardDetail(cardId);
        // CF-FITTED-LADDER (2026-06-16): thread numberedTo so the engine's
        // composed branch can parse (serial, finish) → f(serial) · g(finish).
        // Sibling-anchor + plural-equivalence pooler ignore the extra field.
        cardParallels = (detail.parallels ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          numberedTo: p.numberedTo ?? null,
        }));
        isAuto = (detail.attributes ?? []).some(
          (a: string) => /\bAUTO\b/i.test(a),
        );
      } catch (err) {
        console.warn(
          `[${source}] getCardDetail failed for ${cardId} (non-fatal, sibling-anchor branch disabled): ${(err as Error)?.message ?? err}`,
        );
        cardParallels = [];
      }
    }

    let parallelRawFmv: number | null = null;
    let parallelRawFmvSource: "fmv" | "last-sale" | undefined;
    let parallelRawFmvAgeDays: number | null = null;
    if (parallelId) {
      if (isRawScope) {
        if (fmv > 0) {
          parallelRawFmv = fmv;
          parallelRawFmvSource = "fmv";
          parallelRawFmvAgeDays = null;
        } else if (lastSalePrice != null) {
          parallelRawFmv = lastSalePrice;
          parallelRawFmvSource = "last-sale";
          parallelRawFmvAgeDays = daysSinceNewestComp;
        }
      } else {
        // CF-GRADED-PRECEDENCE-OBSERVED (2026-06-15): graded-scope used
        // to leave parallelRawFmv null, dropping into resolveAnchor's
        // composed branch and ignoring observed same-parallel raw sales
        // (Leo Blue Refractor: composed PSA 10 $959 vs observed-anchored
        // ~$3,134 from the $1,183 raw sale). Compute the median of
        // pricing.raw records that match the target parallel via the
        // strict catalog-derived matcher — pid match for tagged records,
        // word-boundary + sibling-exclusion title match for untagged —
        // so the engine's existing "parallel-observed" short-circuit
        // fires on graded scope too. Composed remains the fallback when
        // no observed parallel raw exists.
        const observedMedian = computeSameParallelRawMedian(
          pricing,
          parallelId,
          parallelName,
          cardParallels,
        );
        if (observedMedian != null && observedMedian > 0) {
          parallelRawFmv = observedMedian;
          parallelRawFmvSource = "fmv";
          parallelRawFmvAgeDays = null;
        }
      }
    }

    // CF Phase 1c — release-level grade-premium curve. Bounded 5-wide
    // concurrent harvest; 6h cache-keyed at cs:graded-curve:{release}|{year}.
    // Non-fatal on throw — falls back to tier-3 inside the engine.
    const releaseFromPricing = pricing.card?.set?.release ?? null;
    const setNameFromPricing = pricing.card?.set?.name ?? null;
    const yearRaw = pricing.card?.set?.year;
    const yearNum =
      yearRaw != null && Number.isFinite(Number(yearRaw))
        ? Number(yearRaw)
        : null;
    let releaseRatios = null;
    let releaseLabel: string | null = null;
    if (releaseFromPricing && yearNum && yearNum > 0) {
      try {
        releaseRatios = await computeReleaseGradeCurve(
          releaseFromPricing,
          yearNum,
          setNameFromPricing,
        );
        releaseLabel = `${yearNum} ${releaseFromPricing}`;
      } catch (err) {
        console.warn(
          `[${source}] release-curve compute failed (non-fatal): ${(err as Error)?.message ?? err}`,
        );
        releaseRatios = null;
      }
    }

    // cardParallels + isAuto already resolved upstream of parallelRawFmv
    // computation (CF-GRADED-PRECEDENCE-OBSERVED 2026-06-15 moved the
    // detail fetch up to feed the strict graded-scope matcher; the
    // existing sibling-observed anchor path consumes the same values
    // here without a re-fetch).

    const built = buildGradedEstimates({
      pricing,
      targetParallelId: parallelId,
      targetParallelName: parallelName,
      targetParallelRawFmv: parallelRawFmv,
      targetParallelRawFmvSource: parallelRawFmvSource,
      targetParallelRawFmvAgeDays: parallelRawFmvAgeDays,
      releaseRatios,
      releaseLabel,
      trendIQ: estimate.trendIQ ?? null,
      cardParallels,
      isAuto,
      snapshots: {
        marketTierValue: isThinMarket ? null : fmv,
        recentComps: estimate.recentComps ?? [],
        gradeBreakdown,
      },
    });
    if (built.mutationDetected) {
      console.error(JSON.stringify({
        event: "graded_estimates_mutation_detected",
        source,
        subsystem: "graded-projection",
        cardId,
        parallelId: parallelId ?? null,
      }));
    }
    return {
      estimates: built.estimates,
      mutationDetected: built.mutationDetected,
    };
  } catch (err) {
    console.warn(
      `[${input.source}] gradedEstimates build failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
    return { estimates: [], mutationDetected: false };
  }
}
