/**
 * CF-RELEASE-AUTO-DETECT (2026-07-05, Drew):
 *
 * Auto-detect release dates for products NOT in the hard-coded
 * RELEASE_DATES table. Uses CH's /cards/additions-summary endpoint,
 * which reports how many new cardIds enter CH's catalog per day.
 * A product's release day IS the day CH ingests hundreds of new
 * cardIds for that set — a huge spike above the prior baseline.
 *
 * Complements `releaseDecayPrior.service.ts`:
 *   1. Hard-coded RELEASE_DATES = curated, precise dates for Bowman +
 *      Topps families we know we care about.
 *   2. Auto-detect = catches everything else automatically. Long-tail
 *      products (regional Panini, exclusive Bowman variants, etc.)
 *      get decay-mode without me having to maintain the table.
 *
 * Called from `getReleaseDecayForCard` as a fallback when a lookup
 * misses the hard-coded table. Result is cached 30 days (a release
 * date doesn't change once known).
 *
 * Spike detection heuristic:
 *   - Query 60 days of addition rows for the set
 *   - Group by added_date, sum card_count
 *   - Find days where card_count > SPIKE_THRESHOLD_ABSOLUTE
 *     AND card_count > SPIKE_THRESHOLD_RELATIVE × (prior 14-day mean)
 *   - The EARLIEST such day is the release date
 */

import { getAdditionsSummary } from "./cardhedge.client.js";
import { cacheWrap } from "../shared/cache.service.js";

/** Cache for 30 days — release date is a one-time fact. */
const CACHE_TTL_SEC = 30 * 24 * 60 * 60;
/** Absolute floor: a spike day must have ≥ this many new cards.
 *  Rules out tiny-release false positives (a single day where CH
 *  ingested 5 cardIds isn't a real release). */
const SPIKE_THRESHOLD_ABSOLUTE = 50;
/** Relative floor: a spike day must be ≥ this many × the prior
 *  14-day-mean baseline. Rules out gradual ramp-up misidentification. */
const SPIKE_THRESHOLD_RELATIVE = 5.0;
/** How far back to look. 60 days covers the standard 8-week decay
 *  window with margin for a spike detected at day 0 of that window. */
const LOOKBACK_DAYS = 60;

function normalizeSetKey(year: number | string, setName: string): string {
  const y = String(year).trim();
  const s = setName.trim().toLowerCase().replace(/\s+/g, " ");
  return `${y}:${s}`;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Detect the release date for a `(year, set)` combo by finding the
 * first day of significant additions in CH's catalog. Returns null
 * when no spike is found (product not in CH's tracked catalog, or
 * released more than LOOKBACK_DAYS ago and the spike day fell out of
 * the window).
 *
 * Silent no-throw. Returns null on any error.
 */
export async function detectReleaseDateForSet(
  year: number | string,
  setName: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!year || !setName || setName.trim().length === 0) return null;

  const key = normalizeSetKey(year, setName);
  const cacheKey = `release-auto-detect:${key}`;

  return cacheWrap(
    cacheKey,
    () => _detectReleaseDateForSetImpl(year, setName, now),
    CACHE_TTL_SEC,
  );
}

async function _detectReleaseDateForSetImpl(
  year: number | string,
  setName: string,
  now: Date,
): Promise<string | null> {
  const endDate = toIsoDate(now);
  const startDate = toIsoDate(
    new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000),
  );
  const setQuery = `${year} ${setName}`.trim();

  // CH pagination — 200/page is the max. For a 60-day window on a
  // popular set we might see hundreds of addition rows (many variants
  // per day). Two pages usually covers it.
  let allRows: { added_date: string; card_count: number }[] = [];
  for (let page = 1; page <= 3; page++) {
    const resp = await getAdditionsSummary({
      startDate,
      endDate,
      setName: setQuery,
      page,
      pageSize: 200,
    });
    if (!resp || resp.data.length === 0) break;
    allRows.push(
      ...resp.data.map((r) => ({
        added_date: r.added_date,
        card_count: r.card_count,
      })),
    );
    if (resp.data.length < 200) break; // no more pages
  }

  if (allRows.length === 0) {
    console.log(JSON.stringify({
      event: "release_auto_detect_no_data",
      source: "releaseAutoDetect",
      year,
      set: setName,
      window: { startDate, endDate },
    }));
    return null;
  }

  // Sum card_count per unique day, then sort ascending by date.
  const byDate = new Map<string, number>();
  for (const row of allRows) {
    byDate.set(row.added_date, (byDate.get(row.added_date) ?? 0) + row.card_count);
  }
  const daily = [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Walk chronologically. For each day, check spike condition against
  // the prior 14 days' mean. Return the first day that qualifies.
  const PRIOR_WINDOW = 14;
  for (let i = 0; i < daily.length; i++) {
    const today = daily[i];
    if (today.count < SPIKE_THRESHOLD_ABSOLUTE) continue;

    // Compute prior-window mean (over the calendar days before `today`,
    // not over just the last N entries in `daily` — sparse days count).
    const todayMs = Date.parse(today.date);
    if (!Number.isFinite(todayMs)) continue;
    const priorStartMs = todayMs - PRIOR_WINDOW * 24 * 3600 * 1000;
    let priorSum = 0;
    let priorDays = 0;
    for (let j = 0; j < i; j++) {
      const other = daily[j];
      const otherMs = Date.parse(other.date);
      if (!Number.isFinite(otherMs)) continue;
      if (otherMs < priorStartMs || otherMs >= todayMs) continue;
      priorSum += other.count;
      priorDays++;
    }
    // If we have no prior data (window falls before our lookback),
    // treat baseline as zero. That means the very-first-day of the
    // lookback window can qualify on absolute threshold alone.
    const priorMean = priorDays > 0 ? priorSum / PRIOR_WINDOW : 0;
    const spikeRatio = priorMean > 0 ? today.count / priorMean : Infinity;

    if (spikeRatio >= SPIKE_THRESHOLD_RELATIVE) {
      console.log(JSON.stringify({
        event: "release_auto_detected",
        source: "releaseAutoDetect",
        year,
        set: setName,
        detectedDate: today.date,
        dayCardCount: today.count,
        priorMean: Math.round(priorMean * 100) / 100,
        spikeRatio: Number.isFinite(spikeRatio)
          ? Math.round(spikeRatio * 100) / 100
          : "infinity",
      }));
      return today.date;
    }
  }

  console.log(JSON.stringify({
    event: "release_auto_detect_no_spike",
    source: "releaseAutoDetect",
    year,
    set: setName,
    daysScanned: daily.length,
  }));
  return null;
}
