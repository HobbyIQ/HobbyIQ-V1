/**
 * CF-MANUAL-IDENTITY-PRICING (2026-07-07, Drew):
 *
 * Prices a card by MANUAL identity — bypasses CH's card catalog entirely
 * to serve the "CH doesn't index this SKU" case (concrete: Ethan
 * Conrad CPA-EC Blue Refractor Auto, Eric Hartman CPA-EHA Blue
 * Refractor Auto, all Ethan Salas parallel autos, etc — see
 * scratchpad/ch-support-escalation-2026-07-07.md for the full list).
 *
 * Pre-fix flow when a user tried to price one of these:
 *   1. iOS search bar → /api/search/cards → no card_id (CH catalog miss)
 *   2. Gray pill → "we can't price this" — dead end
 *
 * Post-fix flow:
 *   1. iOS presents a manual-entry sheet after the search miss
 *   2. Sheet POSTs `{ year, set, playerName, parallel, isAuto }` to
 *      /api/compiq/price-manual-identity
 *   3. This service derives trajectory rate for the player, then calls
 *      the sibling-fallback service directly with the tuple
 *   4. Returns estimated Raw + Predicted 7d + full lineage
 *
 * The sibling fallback already:
 *   - Looks up the parallel-premium (with the PR #307 brand-family
 *     proxy widening)
 *   - Searches CH for the player's Base Auto (or Base card cross-class)
 *   - Applies print-run floor (PR #303)
 *   - Trend-projects sibling forward to today via trajectory rate
 *
 * We just plumb the trajectory rate in and hand the tuple through.
 */

import {
  attemptSiblingPriceFallback,
  type SiblingFallbackResult,
} from "./siblingCardPriceFallback.service.js";
import { deriveWeeklyRate, type RateDerivation } from "./observedGradeCurve.service.js";
import { getReleaseDecayForCardAsync } from "./releaseDecayPrior.service.js";
import type { ParallelTierKey } from "../playerTrend/parallelTierTrend.service.js";

export interface ManualIdentityInput {
  year: number;
  set: string;
  playerName: string;
  parallel: string;
  isAuto: boolean;
}

export interface ManualIdentityResult {
  estimatedRawPrice: number | null;
  estimatedPSA10Price: number | null;
  /** Raw price projected 7 days out (via trajectory rate). */
  estimatedRawPredicted7d: number | null;
  /** Percentage change from today's estimate to Predicted 7d. */
  predictedPricePct: number | null;
  /** Trajectory rate used for the projection. Null when derivation
   *  produced no signal (rare — for very obscure prospects). */
  trajectoryRateWeekly: number | null;
  /** Which signal drove the rate (matched-cohort-cached, etc). */
  signalSource: RateDerivation["signalSource"] | null;
  /** Full sibling lineage — same shape as ObservedGradeCurve.siblingFallback. */
  siblingFallback: {
    siblingCardId: string;
    siblingParallel: string;
    siblingBaseMedianRaw: number;
    siblingBaseProjectedToday: number;
    siblingWeeksSinceNewestSale: number | null;
    parallelPremium: number;
    empiricalPremium: number;
    floorApplied: boolean;
    inferredPrintRun: number | null;
    premiumMatchedSet: string;
    premiumUsedProxy: boolean;
    siblingIsCrossClass: boolean;
    crossClassAutoPremium: number | null;
  } | null;
}

/**
 * Price a manual-identity card. Returns null on:
 *  - No sibling could be resolved (player has no Base Auto AND no Base
 *    card in the same set — thin-market player)
 *  - Parallel doesn't match any calibration entry AND no floor tier
 *
 * Never throws — all errors caught, returned as null. Telemetry
 *   `manual_identity_pricing_attempted` fires on every invocation for
 *   ops observability.
 */
export async function priceByManualIdentity(
  input: ManualIdentityInput,
): Promise<ManualIdentityResult | null> {
  try {
    console.log(JSON.stringify({
      event: "manual_identity_pricing_attempted",
      source: "manualIdentityPricing",
      year: input.year,
      set: input.set,
      playerName: input.playerName,
      parallel: input.parallel,
      isAuto: input.isAuto,
      timestamp: new Date().toISOString(),
    }));

    // Derive trajectory rate. Uses matched-cohort → parallel-tier →
    // release-decay chain, identical to the CH-cardId path.
    const parallelTierKey: ParallelTierKey = {
      year: input.year,
      set: input.set,
      variant: input.parallel,
    };
    const releaseDecayPrecomputed = await getReleaseDecayForCardAsync(
      input.year,
      input.set,
    );
    const derivation = await deriveWeeklyRate(
      input.playerName,
      parallelTierKey,
      { year: input.year, set: input.set },
      releaseDecayPrecomputed,
    );

    // Run the sibling fallback with the trajectory rate. The synthetic
    // targetCardId doesn't need to exist — the sibling service uses
    // it only to skip the target itself when scanning candidate siblings.
    const fallback = await attemptSiblingPriceFallback({
      targetCardId: `manual:${input.year}:${input.set}:${input.parallel}:${input.playerName}`,
      year: input.year,
      set: input.set,
      parallel: input.parallel,
      isAuto: input.isAuto,
      playerName: input.playerName,
      trajectoryRateWeekly: derivation?.cappedRate ?? null,
    });
    if (!fallback || fallback.estimatedRawPrice === null) {
      console.log(JSON.stringify({
        event: "manual_identity_pricing_no_estimate",
        source: "manualIdentityPricing",
        reason: fallback === null ? "sibling_returned_null" : "estimate_null",
        year: input.year,
        set: input.set,
        playerName: input.playerName,
        parallel: input.parallel,
        isAuto: input.isAuto,
      }));
      return null;
    }

    const predictedPricePct =
      fallback.estimatedRawPredicted7d !== null &&
      fallback.estimatedRawPrice !== null &&
      fallback.estimatedRawPrice > 0
        ? Math.round(
            ((fallback.estimatedRawPredicted7d / fallback.estimatedRawPrice) - 1) * 10000,
          ) / 100
        : null;

    return {
      estimatedRawPrice: fallback.estimatedRawPrice,
      estimatedPSA10Price: fallback.estimatedPSA10Price,
      estimatedRawPredicted7d: fallback.estimatedRawPredicted7d,
      predictedPricePct,
      trajectoryRateWeekly: derivation?.cappedRate ?? null,
      signalSource: derivation?.signalSource ?? null,
      siblingFallback: {
        siblingCardId: fallback.siblingCardId,
        siblingParallel: fallback.siblingParallel,
        siblingBaseMedianRaw: fallback.siblingBaseMedianRaw,
        siblingBaseProjectedToday: fallback.siblingBaseProjectedToday,
        siblingWeeksSinceNewestSale: fallback.siblingWeeksSinceNewestSale,
        parallelPremium: fallback.parallelPremium,
        empiricalPremium: fallback.empiricalPremium,
        floorApplied: fallback.floorApplied,
        inferredPrintRun: fallback.inferredPrintRun,
        premiumMatchedSet: fallback.premiumMatchedSet,
        premiumUsedProxy: fallback.premiumUsedProxy,
        siblingIsCrossClass: fallback.siblingIsCrossClass,
        crossClassAutoPremium: fallback.crossClassAutoPremium,
      },
    };
  } catch (err) {
    console.warn(
      `[manualIdentityPricing] failed: ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}
