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
 *   2. Look up the parallel-premium multiplier for that
 *      (year, set, parallel, isAuto) tuple in
 *      backend/data/parallel-premiums-latest.json.
 *   3. If not found, try same-year Bowman Chrome Prospects as a proxy
 *      (auto premiums track well across Bowman family products).
 *   4. Search CH for the same PLAYER's Base Auto (or Base card if
 *      !isAuto) in the same set.
 *   5. Fetch the sibling's Raw + PSA 10 comps.
 *   6. Compute basePrice × parallelPremium → estimated Raw + PSA 10.
 *
 * Returns null on any miss — the target card genuinely has no
 * defensible price estimate, and the pill should stay "unavailable".
 *
 * Silent no-throw. All errors caught, returned as null. Never blocks
 * the primary response path.
 *
 * Wiring: called from buildObservedGradeCurve after fillEstimatedFallback,
 * only when ALL grade entries have valueSource === "unavailable" AND
 * the caller opted in via opts.enableSiblingFallback (routes with
 * user-facing display do; bulk reprice paths don't, to avoid CH cost
 * amplification).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  searchCards as chSearchCards,
  getCardSales,
  type CardHedgeCard,
} from "./cardhedge.client.js";
import { computeWeightedMedian } from "./compiqEstimate.service.js";
// CF-PARALLEL-PREMIUM-FLOOR (2026-07-06, Drew): hobby-consensus minimum
// multipliers by print-run tier. Overrides the empirical calibration
// median when it's demonstrably too low for a rare parallel (e.g.
// Orange /25 auto median = 4.4× but hobby-consensus is 15×).
import { applyPrintRunFloor } from "./parallelPremiumFloors.js";

interface EmpiricalParallelEntry {
  year: number;
  set: string;
  parallel: string;
  printRun: string;
  isAuto?: boolean;
  baseRelativePremium: number | null;
  sampleSize: number;
  provenance?: string;
}

/** Cached parallel-premiums table load. Reset via reloadTable for tests. */
let _tableCache: EmpiricalParallelEntry[] | null | undefined = undefined;

function loadTable(): EmpiricalParallelEntry[] | null {
  if (_tableCache !== undefined) return _tableCache;
  try {
    const p = path.resolve(process.cwd(), "data/parallel-premiums-latest.json");
    if (!fs.existsSync(p)) {
      _tableCache = null;
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    _tableCache = entries as EmpiricalParallelEntry[];
    return _tableCache;
  } catch (err) {
    console.warn(
      `[siblingFallback] parallel-premiums load failed: ${(err as Error)?.message ?? err}`,
    );
    _tableCache = null;
    return null;
  }
}

/** Test hook — force a reload on the next lookup call. */
export function _resetTableCacheForTesting(): void {
  _tableCache = undefined;
}

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
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

/**
 * Find the parallel-premium entry matching (year, set, parallel, isAuto).
 * Falls through to Bowman Chrome Prospects as a same-year proxy when
 * the exact set has no entry for the auto tier (common: Bowman Draft
 * Chrome has base-card entries but not auto entries; Bowman Chrome
 * Prospects has both and auto premiums generalize well across the
 * Bowman family).
 */
function lookupPremium(
  year: number,
  setName: string,
  parallel: string,
  isAuto: boolean,
): { entry: EmpiricalParallelEntry; matchedSet: string } | null {
  const table = loadTable();
  if (!table) return null;

  const setNorm = normalizeToken(setName);
  const parallelNorm = normalizeToken(parallel);

  const exact = table.find(
    (e) =>
      e.year === year &&
      normalizeToken(e.set) === setNorm &&
      normalizeToken(e.parallel) === parallelNorm &&
      !!e.isAuto === isAuto &&
      typeof e.baseRelativePremium === "number" &&
      e.baseRelativePremium > 0 &&
      e.sampleSize >= 5,
  );
  if (exact) return { entry: exact, matchedSet: exact.set };

  // CF-SIBLING-PROXY-BRAND-FAMILY (2026-07-07, Drew): the calibration
  // table indexes each product under whichever set name the discovery
  // script produced from CH's search (e.g. 2025 Orange auto premiums
  // live in set="Bowman Draft", NOT set="Bowman Chrome Prospects" — CH
  // returned that string). The pre-fix proxy required set exactly ==
  // "bowman chrome prospects" — silently bailed for every target whose
  // same-year Bowman family entry happened to sit under any other set
  // name.
  //
  // Concrete miss discovered via probe 2026-07-07: Willits 2025 Bowman
  // Draft Chrome Orange Auto — reached this branch, but the 2025
  // Orange isAuto=true entry lives under set="Bowman Draft" (n=30,
  // premium=4.364). No match → null → fallback bailed → the very card
  // that PR #303 (print-run floor) was supposed to price stayed
  // "unavailable" on prod.
  //
  // Fix: match by BRAND FAMILY substring. Bowman/Topps/Panini variants
  // trade close enough that any same-year same-parallel same-isAuto
  // hit inside the target's brand family is materially better than
  // gray-pill "unavailable". Prefer highest-sample-size entry so the
  // richest calibration wins when multiple candidates exist.
  const targetBrand = inferBrand(setNorm);
  if (targetBrand) {
    const candidates = table.filter(
      (e) =>
        e.year === year &&
        normalizeToken(e.parallel) === parallelNorm &&
        !!e.isAuto === isAuto &&
        typeof e.baseRelativePremium === "number" &&
        e.baseRelativePremium > 0 &&
        e.sampleSize >= 5 &&
        inferBrand(normalizeToken(e.set)) === targetBrand &&
        normalizeToken(e.set) !== setNorm,  // exact already tried above
    );
    if (candidates.length > 0) {
      // Prefer highest sample-size within the family
      candidates.sort((a, b) => b.sampleSize - a.sampleSize);
      const best = candidates[0];
      return { entry: best, matchedSet: best.set };
    }
  }

  return null;
}

/**
 * Infer the brand family for a set name. Returns the canonical family
 * token (bowman/topps/panini) or null when no known family matches.
 * Used by lookupPremium to constrain the proxy fallback to the target's
 * own brand family — Bowman auto premiums track well across Bowman
 * Chrome Prospects / Bowman Draft Chrome / Bowman Draft / Bowman's
 * Best, but poorly across Bowman → Panini Prizm.
 */
function inferBrand(normalizedSet: string): string | null {
  if (normalizedSet.includes("bowman")) return "bowman";
  if (normalizedSet.includes("topps")) return "topps";
  if (normalizedSet.includes("panini") || normalizedSet.includes("prizm") ||
      normalizedSet.includes("select") || normalizedSet.includes("mosaic") ||
      normalizedSet.includes("optic")) return "panini";
  return null;
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
  /** Estimated PSA 10 price (Raw × PSA 10 tier multiplier of 8). */
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
  /** Effective multiplier applied: max(empiricalPremium, printRunFloor). */
  parallelPremium: number;
  /** CF-SIBLING-LINEAGE-SURFACE (2026-07-07): the empirical (median-of-
   *  medians) premium from the calibration table BEFORE floor lift.
   *  Same as parallelPremium when no floor applied. Enables downstream
   *  callers + KQL to see when the hobby-consensus floor overrode the
   *  empirical value. */
  empiricalPremium: number;
  /** True when the print-run floor lifted the empirical value. */
  floorApplied: boolean;
  /** Inferred print run for the target parallel (25 for Orange, 50
   *  for Gold, etc.). Null when the parallel didn't match any known
   *  hobby-consensus tier. */
  inferredPrintRun: number | null;
  /** Which parallel-premium table entry we matched (helps ops debug). */
  premiumMatchedSet: string;
  /** True when we had to fall through to Bowman Chrome Prospects. */
  premiumUsedProxy: boolean;
  /** CF-SIBLING-BASE-CARD-FALLBACK (2026-07-06): true when the target
   *  is an auto but we anchored on the player's Base CARD (non-auto)
   *  because no Base Auto SKU exists — hobby-consensus auto-over-base
   *  premium was applied in addition to the parallel premium. */
  siblingIsCrossClass: boolean;
  /** Multiplier applied to bridge Base card → Base Auto anchor when
   *  siblingIsCrossClass is true. Null otherwise. */
  crossClassAutoPremium: number | null;
}

/**
 * Attempt to derive an estimated price for a thin-market card by
 * combining a sibling's Base Auto comps with the target's parallel
 * premium. Returns null on any miss — genuinely rare card, honest
 * silence over speculation.
 */
export async function attemptSiblingPriceFallback(
  input: SiblingFallbackInput,
): Promise<SiblingFallbackResult | null> {
  if (!input.playerName || !input.set || !input.parallel || !input.year) {
    return null;
  }

  // Step 1 — parallel premium
  const premiumMatch = lookupPremium(
    input.year,
    input.set,
    input.parallel,
    input.isAuto,
  );
  if (!premiumMatch) {
    console.log(JSON.stringify({
      event: "sibling_fallback_no_premium",
      source: "siblingCardPriceFallback",
      year: input.year,
      set: input.set,
      parallel: input.parallel,
      isAuto: input.isAuto,
    }));
    return null;
  }
  const empiricalPremium = premiumMatch.entry.baseRelativePremium as number;
  const premiumUsedProxy = normalizeToken(premiumMatch.matchedSet) !== normalizeToken(input.set);
  // CF-PARALLEL-PREMIUM-FLOOR (2026-07-06, Drew): apply the print-run
  // floor. For known-rare parallels (Orange /25, Red /5, etc.), the
  // empirical median tends to under-represent hot-prospect market —
  // the median is dragged down by cool-player sales at the same
  // parallel. The floor represents the hobby-consensus "hot prospect"
  // baseline. When it lifts the value, telemetry captures the flip.
  const floored = applyPrintRunFloor(empiricalPremium, input.parallel);
  const parallelPremium = floored.effective;

  // Step 2 — sibling card search. For autos, seek the same player's
  // Base Auto in the same set. For non-autos, seek the Base card.
  const searchSetName = `${input.year} ${input.set}`;
  const searchQuery = `${input.playerName} ${input.isAuto ? "auto" : "base"}`;
  let cards: CardHedgeCard[] = [];
  try {
    cards = await chSearchCards(searchQuery, 20, {
      player: input.playerName,
      set: searchSetName,
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
  // multiply THAT card's median × 15× floor as the target's price.
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
  let sibling = surnameMatches[0] ?? candidateSiblings[0];
  // Additional signal — if we used Base Auto (or Base) as the sibling
  // but had to promote up from the alternative anchor. Tracked for
  // telemetry so ops can KQL how often this fires.
  let siblingIsCrossClass = false;
  let crossClassAutoPremium: number | null = null;
  if (!sibling && input.isAuto) {
    // Try Base card (non-auto). Same player, same set.
    const baseCandidates = cards.filter((c) => {
      const variant = (c.variant ?? "").toLowerCase();
      const subset = (c.subset ?? "").toLowerCase();
      return (
        c.card_id !== input.targetCardId &&
        (variant === "base" || variant === "") &&
        !subset.includes("auto") &&
        !subset.includes("signat")
      );
    });
    // Same surname guard as above — prefer clearly-named candidates.
    const baseSurnameMatches = baseCandidates.filter(textContainsSurname);
    const baseCard = baseSurnameMatches[0] ?? baseCandidates[0];
    if (baseCard) {
      sibling = baseCard;
      siblingIsCrossClass = true;
      // Hobby-consensus auto-over-base premium for prospects. Ranges
      // from 5× (cool player) to 50-100× (top prospect at peak hype).
      // Middle-ground 10× as a defensible starting point; refined via
      // corpus calibration later.
      crossClassAutoPremium = 10;
    }
  }
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

  // Step 3 — sibling's comps at Raw. PSA 10 as secondary. Capture
  // dates too so we can trend-project the median forward (Drew's
  // "predict accurately, median is a weighted average [snapshot]"
  // point 2026-07-06).
  let siblingBaseMedianRaw: number | null = null;
  let siblingNewestSaleDate: string | null = null;
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
      // Find the newest closed sale date to time the trend projection
      const dates = rawSalesUsable
        .map((s) => s.date)
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .sort();
      siblingNewestSaleDate = dates.length > 0 ? dates[dates.length - 1] : null;
    }
    // If no Raw sales on the sibling either, try PSA 10 and adjust
    // downward via the standard Raw × 8 multiplier.
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
        if (psaMedian !== null && psaMedian > 0) {
          siblingBaseMedianRaw = Math.round((psaMedian / 8) * 100) / 100;
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
  const MAX_WEEKS = 6;
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
    const marketMultiplier = 1 + input.trajectoryRateWeekly * siblingWeeksSinceNewestSale;
    siblingBaseProjectedToday =
      Math.round(siblingBaseMedianRaw * marketMultiplier * 100) / 100;
  }

  // When we cross-class-fell-back (Base card → Auto target), apply the
  // auto-premium multiplier FIRST to get the projected Base Auto anchor,
  // THEN apply the parallel premium to reach the target parallel. Both
  // multipliers stack — 1 Base card × 10 (auto premium) × 15 (Orange /25 floor)
  // = 150× vs a plain Base card. Represents the compounded scarcity.
  const preParallelAnchor = siblingIsCrossClass && crossClassAutoPremium
    ? siblingBaseProjectedToday * crossClassAutoPremium
    : siblingBaseProjectedToday;
  const estimatedRawPrice =
    Math.round(preParallelAnchor * parallelPremium * 100) / 100;
  const estimatedPSA10Price = Math.round(estimatedRawPrice * 8 * 100) / 100;
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
    siblingBaseMedianRaw,
    siblingBaseProjectedToday,
    siblingWeeksSinceNewestSale,
    trajectoryRateWeekly: input.trajectoryRateWeekly ?? null,
    parallelPremium,
    empiricalPremium,
    floorApplied: floored.flooredFrom !== null,
    inferredPrintRun: floored.inferredPrintRun,
    premiumMatchedSet: premiumMatch.matchedSet,
    premiumUsedProxy,
    siblingIsCrossClass,
    crossClassAutoPremium,
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
    parallelPremium,
    empiricalPremium,
    floorApplied: floored.flooredFrom !== null,
    inferredPrintRun: floored.inferredPrintRun,
    premiumMatchedSet: premiumMatch.matchedSet,
    premiumUsedProxy,
    siblingIsCrossClass,
    crossClassAutoPremium,
  };
}
