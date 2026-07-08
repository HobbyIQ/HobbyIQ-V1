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

  // Fallback: same year + Bowman Chrome Prospects (well-covered auto
  // premiums). Only fire for autos — for base cards the set differences
  // are too material.
  if (isAuto) {
    const proxy = table.find(
      (e) =>
        e.year === year &&
        normalizeToken(e.set) === "bowman chrome prospects" &&
        normalizeToken(e.parallel) === parallelNorm &&
        !!e.isAuto === true &&
        typeof e.baseRelativePremium === "number" &&
        e.baseRelativePremium > 0 &&
        e.sampleSize >= 5,
    );
    if (proxy) return { entry: proxy, matchedSet: proxy.set };
  }

  return null;
}

export interface SiblingFallbackInput {
  targetCardId: string;
  year: number;
  set: string;
  parallel: string;
  isAuto: boolean;
  playerName: string;
}

export interface SiblingFallbackResult {
  /** Estimated Raw price derived from the sibling × parallel premium. */
  estimatedRawPrice: number | null;
  /** Estimated PSA 10 price (Raw × PSA 10 tier multiplier of 8). */
  estimatedPSA10Price: number | null;
  /** The sibling card we anchored on. */
  siblingCardId: string;
  siblingParallel: string;
  siblingBasePrice: number;
  /** Multiplier applied. */
  parallelPremium: number;
  /** Which parallel-premium table entry we matched (helps ops debug). */
  premiumMatchedSet: string;
  /** True when we had to fall through to Bowman Chrome Prospects. */
  premiumUsedProxy: boolean;
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
  const parallelPremium = premiumMatch.entry.baseRelativePremium as number;
  const premiumUsedProxy = normalizeToken(premiumMatch.matchedSet) !== normalizeToken(input.set);

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

  const sibling = cards.find(
    (c) => c.card_id !== input.targetCardId && targetIsBase(c),
  );
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

  // Step 3 — sibling's comps at Raw. PSA 10 as secondary.
  let siblingBasePrice: number | null = null;
  try {
    const rawSales = await getCardSales(sibling.card_id, "Raw", 50);
    if (rawSales.length > 0) {
      siblingBasePrice = computeWeightedMedian(
        rawSales
          .map((s) => ({
            price: typeof s.price === "number" ? s.price : parseFloat(String(s.price)),
            date: s.date,
            saleType: s.sale_type ?? null,
          }))
          .filter((s) => Number.isFinite(s.price) && s.price > 0),
      );
    }
    // If no Raw sales on the sibling either, try PSA 10 and adjust
    // downward via the standard Raw × 8 multiplier.
    if (siblingBasePrice === null) {
      const psaSales = await getCardSales(sibling.card_id, "PSA 10", 50);
      if (psaSales.length > 0) {
        const psaMedian = computeWeightedMedian(
          psaSales
            .map((s) => ({
              price: typeof s.price === "number" ? s.price : parseFloat(String(s.price)),
              date: s.date,
              saleType: s.sale_type ?? null,
            }))
            .filter((s) => Number.isFinite(s.price) && s.price > 0),
        );
        if (psaMedian !== null && psaMedian > 0) {
          siblingBasePrice = Math.round((psaMedian / 8) * 100) / 100;
        }
      }
    }
  } catch {
    return null;
  }
  if (siblingBasePrice === null || siblingBasePrice <= 0) {
    console.log(JSON.stringify({
      event: "sibling_fallback_sibling_no_comps",
      source: "siblingCardPriceFallback",
      player: input.playerName,
      siblingCardId: sibling.card_id,
    }));
    return null;
  }

  const estimatedRawPrice = Math.round(siblingBasePrice * parallelPremium * 100) / 100;
  const estimatedPSA10Price = Math.round(estimatedRawPrice * 8 * 100) / 100;

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
    siblingBasePrice,
    parallelPremium,
    premiumMatchedSet: premiumMatch.matchedSet,
    premiumUsedProxy,
    estimatedRawPrice,
    estimatedPSA10Price,
  }));

  return {
    estimatedRawPrice,
    estimatedPSA10Price,
    siblingCardId: sibling.card_id,
    siblingParallel: sibling.variant ?? "Base",
    siblingBasePrice,
    parallelPremium,
    premiumMatchedSet: premiumMatch.matchedSet,
    premiumUsedProxy,
  };
}
