/**
 * CF-SIBLING-CARD-FALLBACK (2026-07-06, Drew):
 *
 * Last-resort price fallback for thin-market cards where CH has zero
 * closed-sale comps at any grade. Concrete case: Eli Willits 2025
 * Bowman Draft Chrome Orange Auto /25 — cardId resolves in CH's
 * catalog but no sales in the last 90 days at any grade level.
 *
 * The fallback:
 *   1. Read the target card's identity (year, set, parallel, isAuto,
 *      playerName).
 *   2. Look up the MEASURED parallel-premium multiplier for that
 *      (year, set, parallel, isAuto) tuple (empiricalParallelPremium.ts,
 *      backed by backend/data/parallel-premiums-latest.json; same-year
 *      same-brand-family proxy when the exact set was never measured).
 *   3. Search CH for the same PLAYER's Base Auto (or Base card if
 *      !isAuto) in the same set.
 *   4. Fetch the sibling's Raw comps (PSA 10 as the secondary anchor).
 *   5. Compute basePrice × parallelPremium → estimated Raw; PSA 10 from
 *      Raw via the engine's calibrated grader premium.
 *
 * Returns null on any miss — the target card genuinely has no
 * defensible price estimate, and the pill should stay "unavailable".
 *
 * D4 PR 5 (2026-08-29) — the seam obeys the empirical-only doctrine
 * (project_empirical_only_multiplier_doctrine). Three hobby-consensus
 * multipliers used to live here and are gone:
 *   - CF-PARALLEL-PREMIUM-FLOOR: `applyPrintRunFloor` lifted the measured
 *     premium to a print-run tier floor (Gold /50 = 8x, Orange /25 = 15x,
 *     ...) and, when nothing was measured at all, used the floor ALONE
 *     ("floor-only", empiricalPremium = 1). That is the "8.00x parallel
 *     (floor lifted from 1.00x)" behind the $1,109 Marconi German
 *     estimate. Now: no measurement, no price.
 *   - CF-SIBLING-BASE-CARD-FALLBACK: when the player had no Base Auto,
 *     the Base CARD was anchored and multiplied by a flat 10x "auto-over-
 *     base premium". Now: no Base Auto sibling, no price.
 *   - PSA 10 = Raw x 8 (and Raw = PSA 10 / 8 when the sibling had only
 *     slab sales). Now: getGraderPremium — the calibration ladder every
 *     other engine path already uses.
 * `siblingIsCrossClass` / `crossClassAutoPremium` stay on the result as
 * permanent false / null because iOS decodes the lineage shape.
 *
 * Silent no-throw. All errors caught, returned as null. Never blocks
 * the primary response path.
 *
 * Wiring: called from buildObservedGradeCurve after fillEstimatedFallback,
 * only when ALL grade entries have valueSource === "unavailable" AND
 * the caller opted in via opts.enableSiblingFallback (routes with
 * user-facing display do; bulk reprice paths don't, to avoid CH cost
 * amplification). Also the last rung of repriceHoldingsForUser — where,
 * since D4 PR 5, a sibling estimate is persisted ONLY when the holding's
 * exact-identity pool is empty (exactPoolSupremacy.ts).
 */

import {
  searchCards as chSearchCards,
  getCardSales,
  type CardHedgeCard,
} from "./cardhedge.client.js";
import { computeWeightedMedian, getGraderPremium } from "./compiqEstimate.service.js";
import {
  lookupEmpiricalParallelPremium,
  _resetEmpiricalParallelPremiumCacheForTesting,
} from "./empiricalParallelPremium.js";
import { inferPrintRun } from "./parallelPremiumFloors.js";

/** Test hook — force a reload of the parallel-premiums table on the next
 *  lookup. Kept under its historical name for the existing test files. */
export function _resetTableCacheForTesting(): void {
  _resetEmpiricalParallelPremiumCacheForTesting();
}

/**
 * Extract the last-name token from a "First Last" or "First Middle Last"
 * player name. Used by the sibling picker to text-check candidate cards
 * against the target player — CH sometimes emits `player: "X"` while
 * `title/name/subset` describes a DIFFERENT player. Surname match on
 * text fields breaks that tie.
 *
 * Returns lowercase last-name, or null when input is empty. Handles
 * suffixes like "Jr." / "III" by using the token before the suffix.
 * When surname is < 4 chars, returns null so we don't accidentally
 * match on common substrings ("Kim", "Wu", "Yi").
 */
function extractSurname(fullName: string | null | undefined): string | null {
  if (!fullName || typeof fullName !== "string") return null;
  const parts = fullName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
  let last = parts[parts.length - 1];
  if (suffixes.has(last) && parts.length >= 2) {
    last = parts[parts.length - 2];
  }
  if (last.length < 4) return null;
  return last;
}

export interface SiblingFallbackInput {
  targetCardId: string;
  year: number;
  set: string;
  parallel: string;
  isAuto: boolean;
  playerName: string;
  /** CF-SIBLING-TREND-ANCHOR (2026-07-06, Drew): weekly rate from the
   *  target player's trajectory chain (matched-cohort / parallel-tier /
   *  release-decay). Used to project the sibling's historical median
   *  FORWARD to today before applying the parallel premium — Drew:
   *  "median is a weighted average" but stale; we want accurate
   *  prediction, not backward-looking snapshots. Null = no trajectory
   *  available; sibling fallback still fires but uses raw median. */
  trajectoryRateWeekly?: number | null;
}

export interface SiblingFallbackResult {
  /** Estimated Raw price for TODAY — sibling's trend-projected median × parallel premium. */
  estimatedRawPrice: number | null;
  /** Estimated PSA 10 price — Raw × the calibrated PSA 10 grader premium
   *  for this card class / year / set (getGraderPremium). */
  estimatedPSA10Price: number | null;
  /** Predicted Raw price at the trajectory horizon (7d) = today's
   *  estimate projected another week forward at the same rate.
   *  Null when no rate was provided. */
  estimatedRawPredicted7d: number | null;
  /** The sibling card we anchored on. */
  siblingCardId: string;
  siblingParallel: string;
  /** Sibling's raw historical weighted median (BEFORE trend-projection). */
  siblingBaseMedianRaw: number;
  /** Sibling's trend-projected value TODAY (median × (1 + rate × weeksSinceNewest)).
   *  Same as siblingBaseMedianRaw when no rate provided. */
  siblingBaseProjectedToday: number;
  /** Weeks since the sibling's newest closed sale — used for projection. */
  siblingWeeksSinceNewestSale: number | null;
  /** How many sibling sales the anchor median was computed from. This is
   *  the comp count a persisted estimate reports — the TARGET has none. */
  siblingCompCount: number;
  /** The multiplier applied. Since D4 PR 5 this IS the measured premium;
   *  there is no floor to lift it. */
  parallelPremium: number;
  /** CF-SIBLING-LINEAGE-SURFACE (2026-07-07): the measured premium from
   *  the calibration table. Always equal to parallelPremium now; kept so
   *  KQL written against the lineage keeps working. */
  empiricalPremium: number;
  /** Paired observations behind the premium. */
  premiumSampleSize: number;
  /** Inferred print run for the target parallel by NAME (25 for Orange,
   *  50 for Gold, ...). Informational — a scarcity guess, not a
   *  multiplier. Null when the name matches no known parallel. */
  inferredPrintRun: number | null;
  /** Which parallel-premium table entry we matched (helps ops debug). */
  premiumMatchedSet: string;
  /** True when the premium came from a same-brand-family proxy set. */
  premiumUsedProxy: boolean;
  /** Retired D4 PR 5 — the Base-card × 10x cross-class anchor is gone.
   *  Permanently false; stays on the wire for iOS's lineage decoder. */
  siblingIsCrossClass: boolean;
  /** Retired D4 PR 5. Permanently null. */
  crossClassAutoPremium: number | null;
}

/**
 * Attempt to derive an estimated price for a thin-market card by
 * combining a sibling's Base Auto comps with the target's measured
 * parallel premium. Returns null on any miss — genuinely rare card,
 * honest silence over speculation.
 */
export async function attemptSiblingPriceFallback(
  input: SiblingFallbackInput,
): Promise<SiblingFallbackResult | null> {
  if (!input.playerName || !input.set || !input.parallel || !input.year) {
    return null;
  }

  // Step 1 — the MEASURED parallel premium, or nothing.
  const premiumMatch = lookupEmpiricalParallelPremium(
    input.year,
    input.set,
    input.parallel,
    input.isAuto,
  );
  if (!premiumMatch) {
    console.log(JSON.stringify({
      event: "sibling_fallback_no_premium",
      source: "siblingCardPriceFallback",
      note: "no measured parallel premium for this (year, set, parallel, isAuto); no price",
      year: input.year,
      set: input.set,
      parallel: input.parallel,
      isAuto: input.isAuto,
    }));
    return null;
  }
  const parallelPremium = premiumMatch.premium;
  const empiricalPremium = premiumMatch.premium;
  const premiumUsedProxy = premiumMatch.usedProxy;
  const premiumMatchedSet = premiumMatch.matchedSet;
  const inferredPrintRun = inferPrintRun(input.parallel);

  // Step 2 — sibling card search. For autos, seek the same player's
  // Base Auto in the same set. For non-autos, seek the Base card.
  // CF-SIBLING-SEARCH-NO-SET-FILTER (2026-07-08, Drew): CH's search
  // treats the `set` filter as strict-match. Our canonical set string
  // is "Bowman Draft Chrome" (year + sport stripped) but CH's set
  // field is "2025 Bowman Draft Chrome Baseball" — filter mismatch,
  // 0 results. Drop the set filter and rely on the SEARCH TEXT
  // "<year> <set> <player> auto" which CH's tokenizer matches loosely.
  // Manual probes confirm this returns full results for the same
  // targets that fail with the strict set filter.
  const searchSetName = `${input.year} ${input.set}`;
  const searchQuery = `${searchSetName} ${input.playerName} ${input.isAuto ? "auto" : "base"}`;
  let cards: CardHedgeCard[] = [];
  try {
    cards = await chSearchCards(searchQuery, 20, {
      player: input.playerName,
    });
  } catch {
    return null;
  }

  const targetIsBase = (c: CardHedgeCard): boolean => {
    const variant = (c.variant ?? "").toLowerCase();
    const subset = (c.subset ?? "").toLowerCase();
    if (input.isAuto) {
      // Base Auto = variant is "Base" AND subset mentions Autograph
      return (
        (variant === "base" || variant === "") &&
        (subset.includes("auto") || subset.includes("signat"))
      );
    }
    // Base card = variant "Base" and NOT an autograph subset
    return (
      (variant === "base" || variant === "") &&
      !subset.includes("auto") &&
      !subset.includes("signat")
    );
  };

  // CF-SIBLING-PICKER-SURNAME-GUARD (2026-07-07, Drew): CH's catalog has
  // known player-attribution glitches — some cards emit player="Ethan
  // Conrad" but description/title="Gavin Fien 2025 Bowman Draft Chrome
  // Prospect Autographs Baseball ..." (observed in ~4 SKUs during the
  // Conrad probe today; same pattern seen with Willits/Ike Irish
  // yesterday). Filtering solely on the CH-reported `player` field will
  // silently pick THE WRONG PLAYER's card as our sibling — and then
  // multiply THAT card's median as the target's price.
  //
  // Guard: prefer siblings whose text fields (title / name / subset)
  // contain the target player's surname. If NONE match, fall back to
  // the CH player field (better than nothing when text fields are
  // empty), but never over-rule an explicit different name.
  const surnaneToken = extractSurname(input.playerName);
  const textContainsSurname = (c: CardHedgeCard): boolean => {
    if (!surnaneToken) return true;   // no surname to check → don't filter
    const blob = `${c.title ?? ""} ${c.name ?? ""} ${c.subset ?? ""}`.toLowerCase();
    return blob.includes(surnaneToken);
  };

  const candidateSiblings = cards.filter(
    (c) => c.card_id !== input.targetCardId && targetIsBase(c),
  );
  // Prefer candidates whose description clearly matches the player.
  const surnameMatches = candidateSiblings.filter(textContainsSurname);
  const sibling = surnameMatches[0] ?? candidateSiblings[0];
  // D4 PR 5: no same-class sibling means no anchor. The Base CARD x 10x
  // "auto-over-base" bridge for auto targets was a hobby-consensus
  // multiplier and is retired; honest silence instead.
  if (!sibling) {
    console.log(JSON.stringify({
      event: "sibling_fallback_no_base_found",
      source: "siblingCardPriceFallback",
      player: input.playerName,
      set: searchSetName,
      isAuto: input.isAuto,
      resultsCount: cards.length,
    }));
    return null;
  }

  // The calibrated PSA 10 / Raw ratio for this card class — the same
  // ladder (GRADE_CALIBRATION family x band x sport, vintage table,
  // gem-rate) hobbyIqFmv's grade-cross-raw rung and the grade curve use.
  const psa10Premium = (rawAnchor: number | null): number | null =>
    getGraderPremium(
      "PSA",
      "10",
      rawAnchor,
      input.isAuto ? "autograph" : "base",
      input.year,
      input.set,
    );

  // Step 3 — sibling's comps at Raw. PSA 10 as secondary. Capture
  // dates too so we can trend-project the median forward (Drew's
  // "predict accurately, median is a weighted average [snapshot]"
  // point 2026-07-06).
  let siblingBaseMedianRaw: number | null = null;
  let siblingNewestSaleDate: string | null = null;
  let siblingCompCount = 0;
  try {
    const rawSales = await getCardSales(sibling.card_id, "Raw", 50);
    const rawSalesUsable = rawSales
      .map((s) => ({
        price: typeof s.price === "number" ? s.price : parseFloat(String(s.price)),
        date: s.date,
        saleType: s.sale_type ?? null,
      }))
      .filter((s) => Number.isFinite(s.price) && s.price > 0);
    if (rawSalesUsable.length > 0) {
      siblingBaseMedianRaw = computeWeightedMedian(rawSalesUsable);
      siblingCompCount = rawSalesUsable.length;
      // Find the newest closed sale date to time the trend projection
      const dates = rawSalesUsable
        .map((s) => s.date)
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .sort();
      siblingNewestSaleDate = dates.length > 0 ? dates[dates.length - 1] : null;
    }
    // If no Raw sales on the sibling either, try PSA 10 and translate
    // back to Raw through the calibrated PSA 10 premium.
    if (siblingBaseMedianRaw === null) {
      const psaSales = await getCardSales(sibling.card_id, "PSA 10", 50);
      const psaUsable = psaSales
        .map((s) => ({
          price: typeof s.price === "number" ? s.price : parseFloat(String(s.price)),
          date: s.date,
          saleType: s.sale_type ?? null,
        }))
        .filter((s) => Number.isFinite(s.price) && s.price > 0);
      if (psaUsable.length > 0) {
        const psaMedian = computeWeightedMedian(psaUsable);
        const ratio = psa10Premium(null);
        if (psaMedian !== null && psaMedian > 0 && ratio !== null && Number.isFinite(ratio) && ratio > 0) {
          siblingBaseMedianRaw = Math.round((psaMedian / ratio) * 100) / 100;
          siblingCompCount = psaUsable.length;
          const dates = psaUsable
            .map((s) => s.date)
            .filter((d): d is string => typeof d === "string" && d.length > 0)
            .sort();
          siblingNewestSaleDate = dates.length > 0 ? dates[dates.length - 1] : null;
        }
      }
    }
  } catch {
    return null;
  }
  if (siblingBaseMedianRaw === null || siblingBaseMedianRaw <= 0) {
    console.log(JSON.stringify({
      event: "sibling_fallback_sibling_no_comps",
      source: "siblingCardPriceFallback",
      player: input.playerName,
      siblingCardId: sibling.card_id,
    }));
    return null;
  }

  // Step 4 — trend-project sibling's median forward to TODAY. Same
  // trajectory math as the target's own entries (weeks-since-newest ×
  // rate, capped at 6 weeks lookback for stability). Player is the
  // SAME between target and sibling, so the trajectory rate applies
  // one-for-one.
  // CF-TRAJECTORY-12WK (Drew, 2026-07-28): extended lookback from 6→12
  // weeks so 60-90-day-old sibling comps on trending players get real
  // projection instead of stale-comp treatment. Multiplier bounds
  // (floor 0.20 / ceiling 3.0) prevent 12w × ±10%/w from producing
  // negative or absurd projections. Both bounds emit
  // bounded_projection_alert telemetry for review.
  const MAX_WEEKS = 12;
  const PROJECTION_MULTIPLIER_FLOOR = 0.20;
  const PROJECTION_MULTIPLIER_CEILING = 3.0;
  let siblingWeeksSinceNewestSale: number | null = null;
  if (siblingNewestSaleDate) {
    const ms = Date.parse(siblingNewestSaleDate);
    if (Number.isFinite(ms)) {
      siblingWeeksSinceNewestSale = Math.min(
        (Date.now() - ms) / (7 * 24 * 3600 * 1000),
        MAX_WEEKS,
      );
    }
  }
  let siblingBaseProjectedToday = siblingBaseMedianRaw;
  if (
    typeof input.trajectoryRateWeekly === "number" &&
    Number.isFinite(input.trajectoryRateWeekly) &&
    siblingWeeksSinceNewestSale !== null
  ) {
    const rawMultiplier = 1 + input.trajectoryRateWeekly * siblingWeeksSinceNewestSale;
    const marketMultiplier = Math.max(
      PROJECTION_MULTIPLIER_FLOOR,
      Math.min(PROJECTION_MULTIPLIER_CEILING, rawMultiplier),
    );
    if (marketMultiplier !== rawMultiplier) {
      const { recordBoundedProjectionAlert } = await import("./boundedProjectionAlerts.service.js");
      recordBoundedProjectionAlert({
        source: "siblingCardPriceFallback.projectForward",
        playerName: input.playerName,
        cardId: input.targetCardId,
        rate: input.trajectoryRateWeekly,
        weeksSinceSale: siblingWeeksSinceNewestSale,
        rawMultiplier,
        bounded: marketMultiplier,
        direction: rawMultiplier > marketMultiplier ? "capped-ceiling" : "capped-floor",
      });
    }
    siblingBaseProjectedToday =
      Math.round(siblingBaseMedianRaw * marketMultiplier * 100) / 100;
  }

  const estimatedRawPrice =
    Math.round(siblingBaseProjectedToday * parallelPremium * 100) / 100;
  const psa10Ratio = psa10Premium(estimatedRawPrice);
  const estimatedPSA10Price =
    psa10Ratio !== null && Number.isFinite(psa10Ratio) && psa10Ratio > 0
      ? Math.round(estimatedRawPrice * psa10Ratio * 100) / 100
      : null;
  // Predicted at 7d = today's estimate projected another week forward
  // at the same rate. Null when no rate is available.
  let estimatedRawPredicted7d: number | null = null;
  if (
    typeof input.trajectoryRateWeekly === "number" &&
    Number.isFinite(input.trajectoryRateWeekly)
  ) {
    const predictedMultiplier = 1 + input.trajectoryRateWeekly * 1; // 7d = 1 week
    estimatedRawPredicted7d =
      Math.round(estimatedRawPrice * predictedMultiplier * 100) / 100;
  }

  console.log(JSON.stringify({
    event: "sibling_fallback_success",
    source: "siblingCardPriceFallback",
    targetCardId: input.targetCardId,
    player: input.playerName,
    year: input.year,
    set: input.set,
    parallel: input.parallel,
    isAuto: input.isAuto,
    siblingCardId: sibling.card_id,
    siblingCompCount,
    siblingBaseMedianRaw,
    siblingBaseProjectedToday,
    siblingWeeksSinceNewestSale,
    trajectoryRateWeekly: input.trajectoryRateWeekly ?? null,
    parallelPremium,
    empiricalPremium,
    premiumSampleSize: premiumMatch.sampleSize,
    inferredPrintRun,
    premiumMatchedSet,
    premiumUsedProxy,
    psa10Ratio,
    estimatedRawPrice,
    estimatedPSA10Price,
    estimatedRawPredicted7d,
  }));

  return {
    estimatedRawPrice,
    estimatedPSA10Price,
    estimatedRawPredicted7d,
    siblingCardId: sibling.card_id,
    siblingParallel: sibling.variant ?? "Base",
    siblingBaseMedianRaw,
    siblingBaseProjectedToday,
    siblingWeeksSinceNewestSale,
    siblingCompCount,
    parallelPremium,
    empiricalPremium,
    premiumSampleSize: premiumMatch.sampleSize,
    inferredPrintRun,
    premiumMatchedSet,
    premiumUsedProxy,
    siblingIsCrossClass: false,
    crossClassAutoPremium: null,
  };
}
