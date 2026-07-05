/**
 * CF-PARALLEL-TIER-TREND (2026-07-05):
 * Same-parallel-tier momentum signal — the third fallback in the
 * trajectory rate chain, sitting between matched-cohort-on-demand
 * and null.
 *
 * Motivation (Roldy Brito Blue X-Fractor incident):
 * Prospects whose CH matched-cohort can't be built (either overnight
 * cache miss + on-demand yields < 2 same-card matches) had no
 * trajectory signal after CF-KILL-RAW-WEEKLY. Drew's ask 2026-07-05:
 * "why wouldn't we look at the overall card market and match like
 * cards to find the trends?" This service answers that — instead
 * of "the player's trend", we take "cards in the same (year, set,
 * parallel) tier's trend" as the signal.
 *
 * Structural mix-bias-freeness:
 * By construction, we're comparing Blue X-Fractor /150 autos ONLY
 * to other Blue X-Fractor /150 autos. There's no compositional bias
 * from cheap raw base cards drowning premium autos — the tier
 * definition IS the compositional guard.
 *
 * Signal quality:
 * Uses the same matched-cohort math we use at the player level —
 * per-card ratios across cards that sold in BOTH the latest week
 * AND the prior 4-week window, then the median of ratios. A tier
 * with 15 players' autos has more sample density than a single
 * prospect's card history, so the signal is thicker and more stable
 * than per-card self-fit.
 *
 * Cache sharing:
 * Cache key is `(year, set, variant)`. Every player lookup that
 * shares a tier hits the same cached result — Brito, Conrad, Hartman,
 * etc. all Blue X-Fractor /150 = one compute, N reads. 24h TTL
 * matches matched-cohort cache discipline.
 */

import {
  searchCards as chSearchCards,
  getPricesByCard,
} from "../compiq/cardhedge.client.js";
import { computeMatchedCohortMomentum } from "./matchedCohort.compute.js";
import { rollupDailyToWeekly, type DailyPricePoint } from "./dailyToWeekly.rollup.js";
import type {
  CardWeeklySalesSeries,
  MatchedCohortResult,
} from "./matchedCohort.types.js";
import { cacheWrap } from "../shared/cache.service.js";

const CACHE_TTL_SEC = 24 * 60 * 60;
/** How many cards from the tier to sample. Capped so per-request cost
 *  is bounded even for large tiers (some parallels have 50+ players). */
const MAX_CARDS_PER_TIER = 20;
/** Daily-price look-back per card. Matches matched-cohort default. */
const DAYS_PER_CARD = 60;
/** In-flight concurrent CH fetches. Matches matched-cohort default. */
const FETCH_CONCURRENCY = 5;

export interface ParallelTierKey {
  /** Year of the release, e.g. 2026. */
  year: number | string;
  /** Set family, e.g. "Bowman Chrome". CH's `set` field on a card.
   *  Case-normalized in cache key so trivial casing drift doesn't
   *  fragment the cache. */
  set: string;
  /** Parallel/variant name, e.g. "Blue X-Fractor". CH's `variant` field.
   *  Case-normalized in cache key. */
  variant: string;
}

function normalizeToken(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

function makeCacheKey(k: ParallelTierKey): string {
  return [
    "parallel-tier-trend",
    String(k.year).trim(),
    normalizeToken(k.set),
    normalizeToken(k.variant),
  ].join(":");
}

/**
 * Fetch parallel-tier momentum for a `(year, set, variant)` tier.
 * Returns null when:
 *   - the tier key is malformed / empty
 *   - CH's card-search returns no matching cards
 *   - filtering to the exact variant leaves < 2 cards (matched-cohort
 *     needs ≥ 2 same-card matches)
 *   - all per-card price fetches yield no data
 *
 * Never throws. Silent no-op on any error — trajectory falls through
 * to null / no adjustment, which is the honest failure mode.
 */
export async function getParallelTierTrend(
  key: ParallelTierKey,
): Promise<MatchedCohortResult | null> {
  if (!key || !key.year || !key.set || !key.variant) return null;
  if (String(key.year).trim().length === 0) return null;
  if (key.set.trim().length === 0 || key.variant.trim().length === 0) return null;

  return cacheWrap(
    makeCacheKey(key),
    () => _fetchParallelTierTrend(key),
    CACHE_TTL_SEC,
  );
}

async function _fetchParallelTierTrend(
  key: ParallelTierKey,
): Promise<MatchedCohortResult | null> {
  const setQuery = `${key.year} ${key.set}`.trim();
  // Use the variant name as the free-text search token, filtered by set.
  // CH's tokenizer will match variants across all players in that set.
  const results = await chSearchCards(key.variant, 100, { set: setQuery });
  if (results.length === 0) {
    console.log(JSON.stringify({
      event: "parallel_tier_trend_empty_search",
      source: "parallelTierTrend",
      year: key.year,
      set: key.set,
      variant: key.variant,
    }));
    return null;
  }

  // Filter to results whose variant field EXACTLY matches the target
  // (post-normalization). CH's free-text search will surface adjacent
  // variants (e.g., searching "Blue X-Fractor" also returns "Blue
  // Refractor" hits); we discard those so the tier stays pure.
  const targetVariantToken = normalizeToken(key.variant);
  const matched = results.filter((c) => {
    const v = (c.variant ?? "").trim();
    return v.length > 0 && normalizeToken(v) === targetVariantToken;
  });
  if (matched.length < 2) {
    console.log(JSON.stringify({
      event: "parallel_tier_trend_insufficient_pool",
      source: "parallelTierTrend",
      year: key.year,
      set: key.set,
      variant: key.variant,
      searchResults: results.length,
      matchedPool: matched.length,
    }));
    return null;
  }

  const capped = matched.slice(0, MAX_CARDS_PER_TIER);

  // Per-card daily-price fetch with bounded concurrency, same pattern
  // as fetchCardHedgeMatchedCohort.
  const perCardSeries: CardWeeklySalesSeries[] = [];
  const queue = [...capped];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      try {
        const prices = await getPricesByCard(c.card_id, "Raw", DAYS_PER_CARD);
        const daily: DailyPricePoint[] = prices
          .map((p) => ({
            closingDate: typeof p.closing_date === "string" ? p.closing_date.slice(0, 10) : "",
            price: typeof p.price === "number" ? p.price : parseFloat(String(p.price)),
          }))
          .filter((p) => p.closingDate && Number.isFinite(p.price) && p.price > 0);
        if (daily.length === 0) return;
        const buckets = rollupDailyToWeekly(daily);
        if (buckets.length === 0) return;
        perCardSeries.push({
          cardId: c.card_id,
          grade: "Raw",
          buckets,
        });
      } catch (err) {
        console.warn(
          `[parallelTierTrend] getPricesByCard failed for card_id=${c.card_id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));

  if (perCardSeries.length < 2) {
    console.log(JSON.stringify({
      event: "parallel_tier_trend_no_price_history",
      source: "parallelTierTrend",
      year: key.year,
      set: key.set,
      variant: key.variant,
      cardsFetched: capped.length,
      cardsWithPrices: perCardSeries.length,
    }));
    return null;
  }

  const result = computeMatchedCohortMomentum(perCardSeries);
  console.log(JSON.stringify({
    event: "parallel_tier_trend_computed",
    source: "parallelTierTrend",
    year: key.year,
    set: key.set,
    variant: key.variant,
    cohortSize: result.cohort.length,
    medianRatio: result.medianRatio,
    latestWeekActiveCards: result.latestWeekActiveCards,
  }));
  return result;
}
