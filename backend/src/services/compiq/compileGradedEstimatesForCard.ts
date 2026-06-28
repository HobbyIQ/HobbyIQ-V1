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
// CF-CH-WIRE-GRADER-RATIO-TELEMETRY (2026-06-28): observed-pair telemetry
// for per-player grading multiplier calibration. Fires when we have both
// observed raw AND observed graded medians on the same card.
import { logGraderRatioObserved } from "./compiqEstimate.service.js";

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
    /**
     * CF-CH-GRADED-FROM-COMPOSED-ANCHOR (2026-06-28): Build B's
     * composed raw FMV (base_auto_median × curated baseRelativePremium)
     * for parallel cards without observed comps. When fmv (observed)
     * and lastSale.price are both absent, the parallel-scope anchor
     * resolution falls through to this composed value with source
     * "fmv" so the projection has SOMETHING to project from. Without
     * this, thin parallels (Hartman Blue X-Fractor /150 auto, etc.)
     * yielded empty gradedEstimates because every anchor branch null'd
     * out — even though Build B had produced a real composed estimate.
     */
    estimatedValue?: number | null;
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

    // CF-CH-GRADED-FROM-COMPOSED-ANCHOR (2026-06-28): Build B's composed
    // raw FMV for parallel cards without observed comps. Used as the last-
    // resort anchor when fmv (observed) and lastSale.price are both null,
    // so thin parallels yield projected graded estimates instead of an
    // empty array. Extracted once here so both the raw-scope branch (below)
    // and the graded-scope branch can fall through to it.
    const estimatedValueRaw = input.estimate.estimatedValue;
    const composedRawFmv =
      typeof estimatedValueRaw === "number"
      && Number.isFinite(estimatedValueRaw)
      && estimatedValueRaw > 0
        ? estimatedValueRaw
        : null;

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
        } else if (composedRawFmv != null) {
          // CF-CH-GRADED-FROM-COMPOSED-ANCHOR — Build B fallback for
          // thin parallels (no observed fmv, no last-sale). Source
          // tag stays "fmv" because downstream consumers treat it as
          // the synthetic raw anchor; the engine's projection math is
          // anchor-source-agnostic. Age stays null — composed values
          // are point-in-time outputs of the curated multiplier, not
          // a dated sale record.
          parallelRawFmv = composedRawFmv;
          parallelRawFmvSource = "fmv";
          parallelRawFmvAgeDays = null;
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
        } else if (composedRawFmv != null) {
          // CF-CH-GRADED-FROM-COMPOSED-ANCHOR (2026-06-28): same Build B
          // fallback as the raw-scope branch above — graded-scope thin
          // parallels also yielded empty gradedEstimates pre-fix because
          // no same-parallel observed median existed. Now the composed
          // value anchors the projection on graded scope too.
          parallelRawFmv = composedRawFmv;
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

    // CF-CH-WIRE-GRADER-RATIO-TELEMETRY (2026-06-28): emit a
    // `graded_ratio_observed` event for each (raw, graded) pair we
    // currently see on this card. The aggregator (KQL query — see
    // docs/per-player-grader-calibration.md) groups these by
    // (player, gradingCompany, grade, tier) over a rolling window and
    // produces the per-player observed median ratio.
    //
    // OBSERVED-PAIR ONLY: we need a raw median (from gradeBreakdown's
    // "Raw" / "Ungraded" entry) AND a graded median (from any non-raw
    // entry) on the SAME card. Composed/projected anchors are not
    // logged — they're circular (they ARE our multiplier) and would
    // pollute the calibration signal.
    //
    // Fire-and-forget; failures never propagate (the helper itself
    // try/catches). Telemetry payload size is bounded — one event per
    // observed graded tier per priced response.
    try {
      const breakdown = input.gradeBreakdown as ReadonlyArray<{
        grader?: string;
        grade?: string;
        compCount?: number;
        median?: number;
      }>;
      const rawEntry = breakdown.find(
        (e) =>
          typeof e?.grader === "string" &&
          /^(raw|ungraded)$/i.test(e.grader.trim()),
      );
      const rawAnchor =
        rawEntry?.median != null && Number.isFinite(rawEntry.median) && rawEntry.median > 0
          ? rawEntry.median
          : null;
      // CardsightPricingCard surfaces the player via `name` on most flows;
      // the CardHedge-routed path stamps `player` defensively as an
      // additional field. Read both for max coverage.
      const cardAny = pricing.card as { player?: unknown; name?: unknown } | null | undefined;
      const playerName =
        typeof cardAny?.player === "string" && cardAny.player.length > 0
          ? cardAny.player
          : typeof cardAny?.name === "string" && cardAny.name.length > 0
            ? cardAny.name
            : null;
      if (rawAnchor != null) {
        for (const entry of breakdown) {
          if (!entry?.grader || !entry?.grade) continue;
          // Skip the raw row itself; we want raw → graded pairs only.
          if (/^(raw|ungraded)$/i.test(String(entry.grader).trim())) continue;
          if (
            typeof entry.median !== "number" ||
            !Number.isFinite(entry.median) ||
            entry.median <= 0
          ) {
            continue;
          }
          logGraderRatioObserved({
            source: `${source}.observed-pair`,
            player: playerName,
            cardId,
            gradingCompany: String(entry.grader),
            grade: String(entry.grade),
            rawAnchor,
            gradedValue: entry.median,
          });
        }
      }
    } catch (err) {
      // Telemetry must never propagate. Log a warn so we can see the rare
      // shape-mismatch case in App Insights.
      console.warn(
        `[${source}] graded_ratio_observed telemetry failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }

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
