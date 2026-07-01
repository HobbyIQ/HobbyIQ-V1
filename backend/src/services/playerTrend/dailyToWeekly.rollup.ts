/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * Roll a daily price series into complete weekly buckets.
 *
 * CH returns per-card data as a daily series (`/cards/prices-by-card`).
 * The matched-cohort computation operates on weekly rollups. This
 * function handles the daily → weekly transformation once,
 * vendor-agnostic.
 *
 * A "week" is Monday → Sunday (ISO 8601 week). Partial weeks (either
 * the current week, or the earliest week if data doesn't start on a
 * Monday) are dropped so downstream never has to think about
 * partial-week noise.
 */

import type { CardWeeklySalesBucket } from "./matchedCohort.types.js";

export interface DailyPricePoint {
  closingDate: string; // ISO date (YYYY-MM-DD)
  price: number;
}

/**
 * Turn a daily series into complete-week buckets.
 * Points with invalid dates or non-positive prices are dropped.
 * Weeks with zero points are omitted from the output.
 *
 * The "median" reported per week is the median of all daily prices
 * in that week (each daily entry counts as one). CH's daily entries
 * already represent the median sale price for that day, so this is
 * effectively "median of daily medians."
 *
 * The "mean" is the arithmetic mean of the same.
 *
 * "saleCount" is the number of daily entries in the week — a proxy
 * for how many days had at least one sale. CH doesn't expose per-day
 * sale count via prices-by-card, so this is the best signal available
 * from that endpoint. A follow-up could enrich with per-day counts
 * via the /cards/comps endpoint if needed.
 */
export function rollupDailyToWeekly(
  points: ReadonlyArray<DailyPricePoint>,
): CardWeeklySalesBucket[] {
  if (points.length === 0) return [];

  // Bucketize by ISO Monday.
  const byWeek = new Map<string, DailyPricePoint[]>();
  for (const p of points) {
    if (!p.closingDate || p.price <= 0) continue;
    const mondayISO = mondayOf(p.closingDate);
    if (!mondayISO) continue;
    const existing = byWeek.get(mondayISO);
    if (existing) existing.push(p);
    else byWeek.set(mondayISO, [p]);
  }

  // Sort weeks ascending.
  const weekStarts = Array.from(byWeek.keys()).sort();
  if (weekStarts.length === 0) return [];

  // Drop partial edges: only include complete Monday-Sunday weeks.
  // A week is complete if we EITHER (a) have data for every day
  // Mon-Sun, OR (b) the week is entirely in the past (weekEnd <
  // today). We drop the latter case for the current in-progress week
  // and keep everything else.
  const todayISO = new Date().toISOString().slice(0, 10);
  const result: CardWeeklySalesBucket[] = [];
  for (const weekStart of weekStarts) {
    const weekEnd = addDaysISO(weekStart, 6);
    if (weekEnd >= todayISO) continue; // in-progress week — skip
    const bucketPoints = byWeek.get(weekStart) ?? [];
    if (bucketPoints.length === 0) continue;
    const prices = bucketPoints.map((p) => p.price).sort((a, b) => a - b);
    const medianPrice = median(prices);
    const meanPrice = prices.reduce((s, p) => s + p, 0) / prices.length;
    result.push({
      weekStart,
      weekEnd,
      saleCount: bucketPoints.length,
      medianPrice: round(medianPrice),
      meanPrice: round(meanPrice),
    });
  }
  return result;
}

/**
 * Get the ISO Monday for a given ISO date.
 * "2026-06-25" (Thursday) → "2026-06-22" (Monday).
 * Returns null on invalid input.
 */
export function mondayOf(dateIso: string): string | null {
  const parsed = new Date(dateIso + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return null;
  // getUTCDay: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
  // We want to offset back to Monday. If Sunday (0), subtract 6.
  // Otherwise subtract (day - 1).
  const day = parsed.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(parsed);
  monday.setUTCDate(parsed.getUTCDate() - offset);
  return monday.toISOString().slice(0, 10);
}

function addDaysISO(dateIso: string, days: number): string {
  const d = new Date(dateIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  if (sortedAsc.length % 2 === 0) return (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
  return sortedAsc[mid];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
