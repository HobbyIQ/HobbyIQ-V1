/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * CardHedge provider adapter for matched-cohort data.
 *
 * Fetches per-card daily price series for a player's known cards,
 * rolls them up to weekly buckets, computes the matched-cohort
 * momentum. Vendor-agnostic downstream — the eBay-direct migration
 * ships an ebay-direct sibling and downstream code is unchanged.
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

/** How many days of daily-price history to fetch per card. */
const DEFAULT_DAYS_PER_CARD = 60;
/** How many cards to consider per player. Capped so batch cost is bounded. */
const DEFAULT_MAX_CARDS_PER_PLAYER = 30;
/** Concurrency for the per-card fetches. */
const DEFAULT_FETCH_CONCURRENCY = 5;

export interface FetchMatchedCohortOptions {
  /** How many days back to pull per-card price history. Default 60. */
  daysPerCard?: number;
  /** Cap on cards evaluated per player. Default 30. */
  maxCards?: number;
  /** In-flight concurrent CH calls. Default 5. */
  concurrency?: number;
  /** Grade to fetch prices for. Default Raw. */
  grade?: string;
}

/**
 * Fetch matched-cohort momentum for a player from CardHedge.
 * Returns null when the player has no cards or all CH calls fail.
 * Never throws — errors are absorbed, worst case returns a result
 * with empty cohort and null ratios.
 */
export async function fetchCardHedgeMatchedCohort(
  playerName: string,
  opts: FetchMatchedCohortOptions = {},
): Promise<MatchedCohortResult | null> {
  if (!playerName || playerName.trim().length === 0) return null;

  const daysPerCard = opts.daysPerCard ?? DEFAULT_DAYS_PER_CARD;
  const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS_PER_PLAYER;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_FETCH_CONCURRENCY);
  const grade = opts.grade ?? "Raw";

  // Step 1 — list the player's cards
  const cards = await chSearchCards(playerName, 100, { player: playerName });
  if (!cards.length) return null;
  const capped = cards.slice(0, maxCards);

  // Step 2 — per-card daily price fetch with bounded concurrency
  const perCardSeries: CardWeeklySalesSeries[] = [];
  const queue = [...capped];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      try {
        const prices = await getPricesByCard(c.card_id, grade, daysPerCard);
        const daily: DailyPricePoint[] = prices
          .map((p) => ({
            closingDate: typeof p.closing_date === "string" ? p.closing_date.slice(0, 10) : "",
            price: typeof p.price === "number" ? p.price : parseFloat(String(p.price)),
          }))
          .filter((p) => p.closingDate && Number.isFinite(p.price) && p.price > 0);
        if (daily.length === 0) continue;
        const buckets = rollupDailyToWeekly(daily);
        if (buckets.length === 0) continue;
        perCardSeries.push({
          cardId: c.card_id,
          grade,
          buckets,
        });
      } catch (err) {
        console.warn(
          `[matchedCohort] getPricesByCard failed for card_id=${c.card_id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  };
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  if (perCardSeries.length === 0) return null;

  // Step 3 — compute matched-cohort momentum
  return computeMatchedCohortMomentum(perCardSeries);
}
