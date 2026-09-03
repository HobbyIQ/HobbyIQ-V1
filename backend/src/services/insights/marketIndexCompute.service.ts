// CF-MARKET-INDEXES (Drew, 2026-09-02). Orchestration for the fixed-
// liquid-basket index: basket selection, daily point append, and the
// first-run 180d backfill. Formula + storage rationale live in the
// marketIndex.service.ts header â€” read that first.
//
// Idempotence: point docs are keyed `point::<sport>::<date>` and written
// with upsert, so re-running a day overwrites that day rather than
// appending a second point for it. Basket docs are keyed
// `basket::<sport>::<epoch>` for the same reason.

import type { Container } from "@azure/cosmos";
import {
  INDEX_SPORTS,
  MARKET_INDEX_BASKET_SIZE,
  MIN_BASKET_SIZE,
  ELIGIBILITY_WINDOW_DAYS,
  VALUE_WINDOW_DAYS,
  SERIES_DAYS,
  type BasketMember,
  type IndexBasketDoc,
  type IndexPointDoc,
  addDays,
  computeWeights,
  epochBaseDate,
  fetchSales,
  getSeriesContainer,
  getSoldCompsContainer,
  groupByCard,
  indexLevel,
  indexPartitionKey,
  isoDay,
  loadCarryForward,
  rebalanceEpochFor,
  saveCarryForward,
  selectBasket,
  valueMembersOnDayDated,
  decidePoint,
  MIN_USED_WEIGHT,
} from "./marketIndex.service.js";

export interface SportComputeResult {
  sport: string;
  epoch: string;
  basketSize: number;
  pointsWritten: number;
  /** Days whose level fell below the usedWeight floor and were withheld. */
  pointsWithheld: number;
  firstDate: string | null;
  lastDate: string | null;
  latestLevel: number | null;
  /** usedWeight of the newest published point. */
  latestUsedWeight: number | null;
  reusedBasket?: boolean;
  /** Epochs whose basket was selected while walking the span (H-11). */
  epochsUsed?: string[];
}

/** Load the in-force basket for a sport+epoch, if one was already built. */
export async function loadBasket(
  series: Container,
  sport: string,
  epoch: string,
): Promise<IndexBasketDoc | null> {
  try {
    const { resource } = await series
      .item(`basket::${sport}::${epoch}`, indexPartitionKey(sport))
      .read<IndexBasketDoc>();
    return resource ?? null;
  } catch { return null; }
}

/**
 * Build (or reuse) the basket in force for `asOf`. Membership is frozen
 * within a quarterly epoch - we only reselect when the epoch rolls.
 *
 * NO LOOKAHEAD (H-11): eligibility is read over the 90 days ENDING at
 * the epoch's own base date, so a basket is always selected from rows
 * that existed on or before the days it values. Selecting once at a
 * span's END date and valuing the whole span against it - what the
 * backfill used to do - valued 116 of 181 points on a basket chosen
 * with their own future.
 *
 * WRITE-FREE DRY RUN (2026-09-03): `persist: false` computes the
 * would-be basket entirely in memory and returns it WITHOUT upserting.
 * The report lane needs this because a span can cross an epoch that has
 * no stored basket yet: minting one from today's eligibility read is a
 * real write, and a run that says "REPORT-ONLY (no writes)" must make
 * none. Nine such baskets were minted in prod on 2026-09-03 before this
 * existed - see the PR body.
 */
export async function ensureBasket(
  soldComps: Container,
  series: Container,
  sport: string,
  asOf: string,
  opts: { persist?: boolean } = {},
): Promise<{ basket: IndexBasketDoc; reused: boolean; persisted: boolean } | null> {
  const persist = opts.persist !== false;
  const epoch = rebalanceEpochFor(asOf);
  const existing = await loadBasket(series, sport, epoch);
  if (existing && existing.members?.length > 0) {
    // A STORED basket gets the same size test as a fresh one. The check
    // has to live here, not only at selection: prod already holds a
    // 4-member pokemon 2026-Q2 basket, and reusing it is precisely how
    // 181.94 kept reaching the tile. Refusing it here is what retires
    // that number without a data migration.
    if (existing.members.length < MIN_BASKET_SIZE) return null;
    return { basket: existing, reused: true, persisted: false };
  }

  // Base date is the epoch start, but never in the future of the data we
  // are computing for (a mid-quarter first run bases at the epoch start,
  // which is what makes the level comparable across the quarter).
  const baseDate = epochBaseDate(epoch);
  const eligFrom = addDays(baseDate, -ELIGIBILITY_WINDOW_DAYS);
  const rows = await fetchSales(soldComps, sport, eligFrom, baseDate);
  const byCard = groupByCard(rows);
  const picked = selectBasket(byCard, MARKET_INDEX_BASKET_SIZE);
  // A handful of cards is not an index. Refusing to build the basket at
  // all is the only defence here: once built, a tiny basket is fully
  // valued by construction, so usedWeight is 1.00 and the floor waves
  // every one of its days through. See MIN_BASKET_SIZE.
  if (picked.length < MIN_BASKET_SIZE) return null;

  const weights = computeWeights(picked.map((p) => p.baseValue));
  const members: BasketMember[] = picked.map((p, i) => ({
    cardId: p.cardId,
    baseValue: Math.round(p.baseValue * 100) / 100,
    weight: weights[i],
    eligibilitySales: p.sales,
  }));

  const doc: IndexBasketDoc = {
    id: `basket::${sport}::${epoch}`,
    cardId: indexPartitionKey(sport),
    docType: "market_index_basket",
    sport,
    epoch,
    baseDate,
    members,
    computedAt: new Date().toISOString(),
  };
  if (!persist) return { basket: doc, reused: false, persisted: false };
  await series.items.upsert(doc);
  return { basket: doc, reused: false, persisted: true };
}

/**
 * The most recent level this sport actually PUBLISHED strictly before
 * `before` - i.e. the newest stored point that was not itself withheld.
 *
 * A withheld day carries this. Carrying anything else (a level from a
 * different computation, or a stale point's own carried value) is how a
 * tile ends up showing a number no run ever published for that day.
 */
export async function lastPublishedLevel(
  series: Container,
  sport: string,
  before: string,
): Promise<number | null> {
  try {
    const iter = series.items.query<{ level: number }>({
      query: `SELECT TOP 1 c.level
              FROM c
              WHERE c.cardId = @pk
                AND c.docType = 'market_index_point'
                AND c.date < @before
                AND (NOT IS_DEFINED(c.stale) OR c.stale = false)
              ORDER BY c.date DESC`,
      parameters: [
        { name: "@pk", value: indexPartitionKey(sport) },
        { name: "@before", value: before },
      ],
    });
    const { resources } = await iter.fetchNext();
    const level = resources?.[0]?.level;
    return Number.isFinite(level) && level > 0 ? level : null;
  } catch { return null; }
}

/**
 * Compute and persist index points for [fromDate, toDate] inclusive.
 * Used for both the nightly single-day append (from === to) and the
 * first-run 180d backfill - ONE method, so backfilled and nightly points
 * are comparable (they were not before: the nightly seeded carry-forward
 * from a 14-day lead-in while the backfill accumulated it across the
 * whole walk, and the backfill picked its basket at the end date).
 *
 * Three integrity properties, all load-bearing:
 *   1. Carry-forward is loaded from the persisted members doc, so a
 *      member with no recent sale keeps its last known value however
 *      long ago that was (C-1).
 *   2. The basket is re-resolved as each day's own epoch rolls, never
 *      chosen from the span's end (H-11).
 *   3. A day whose usedWeight is below the floor is WITHHELD, not
 *      published (C-1).
 */
export async function computeSeriesForSport(
  sport: string,
  fromDate: string,
  toDate: string,
): Promise<SportComputeResult | null> {
  const soldComps = await getSoldCompsContainer();
  const series = await getSeriesContainer();
  if (!soldComps || !series) return null;

  // The basket in force at the START of the span. Later days re-resolve
  // as the epoch rolls, so no day is valued against a future basket.
  // A null here means the span's FIRST epoch cannot form a basket. The
  // span still walks: a later epoch may be fine, and those early days
  // are withheld rather than the whole sport abandoned.
  const firstEnsured = await ensureBasket(soldComps, series, sport, fromDate, { persist: true });
  let basket: IndexBasketDoc | null = firstEnsured ? firstEnsured.basket : null;
  let epoch = basket ? basket.epoch : rebalanceEpochFor(fromDate);
  let memberIds = basket ? basket.members.map((m) => m.cardId) : [];
  let memberSet = new Set(memberIds);
  const epochsUsed: string[] = basket ? [epoch] : [];

  // One pool read covers the whole span plus the lead-in. Membership can
  // change across an epoch roll, so this is NOT filtered to one basket.
  const readFrom = addDays(fromDate, -VALUE_WINDOW_DAYS);
  const readTo = addDays(toDate, 1);
  const allRows = await fetchSales(soldComps, sport, readFrom, readTo);

  // Persisted carry-forward: the full history, not a 14-day lead-in.
  const carryForward = await loadCarryForward(series, sport);
  // Still seed from the lead-in so a first run (empty members doc) has
  // day-one values; a stored value is not overwritten by the seed.
  const seed = groupByCard(allRows.filter((r) => r.soldAt < fromDate && memberSet.has(r.cardId)));
  for (const id of memberIds) {
    const agg = seed.get(id);
    if (agg && agg.values.length > 0) {
      const v = agg.values[agg.values.length - 1];
      if (v > 0 && !carryForward.has(id)) carryForward.set(id, { value: v, asOf: fromDate });
    }
  }

  let pointsWritten = 0;
  let pointsWithheld = 0;
  let latestLevel: number | null = null;
  let latestUsedWeight: number | null = null;
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  /**
   * Last PUBLISHED level - what a withheld day carries forward.
   *
   * Seeded from storage, not null (2026-09-03). The nightly runs with
   * from === to: a single withheld day would otherwise find no prior
   * level in-run, write nothing, and leave the newest stored point -
   * computed a DIFFERENT way, on a different day - standing as if it
   * were live, with stale:false. The carried level must always be the
   * most recent non-withheld level actually published for this sport.
   */
  let priorLevel: number | null = await lastPublishedLevel(series, sport, fromDate);

  for (let day = fromDate; day <= toDate; day = addDays(day, 1)) {
    // H-11: re-resolve the basket when this day's own epoch differs.
    const dayEpoch = rebalanceEpochFor(day);
    if (dayEpoch !== epoch) {
      const rolled = await ensureBasket(soldComps, series, sport, day, { persist: true });
      if (rolled) {
        basket = rolled.basket;
        epoch = basket.epoch;
        memberIds = basket.members.map((m) => m.cardId);
        memberSet = new Set(memberIds);
        epochsUsed.push(epoch);
      } else {
        // This epoch has too few eligible cards to form a basket. Keeping
        // the previous epoch's basket would value these days against a
        // membership that was never in force for them, so the whole epoch
        // is withheld instead - the sport publishes nothing until its
        // pool thickens.
        basket = null;
        epoch = dayEpoch;
        memberIds = [];
        memberSet = new Set();
      }
    }
    if (!basket) {
      pointsWithheld++;
      continue;
    }

    const windowFrom = addDays(day, -VALUE_WINDOW_DAYS);
    const windowTo = addDays(day, 1);
    const windowRows = allRows.filter(
      (r) => r.soldAt >= windowFrom && r.soldAt < windowTo && memberSet.has(r.cardId),
    );
    const inWindow = groupByCard(windowRows);
    const { values, fresh } = valueMembersOnDayDated(memberIds, inWindow, carryForward, day);
    const decision = decidePoint(basket.members, values);

    const base = {
      id: `point::${sport}::${day}`,
      cardId: indexPartitionKey(sport),
      docType: "market_index_point" as const,
      sport,
      date: day,
      epoch,
      freshMembers: fresh,
      basketSize: memberIds.length,
      usedWeight: Math.round(decision.usedWeight * 10000) / 10000,
      computedAt: new Date().toISOString(),
    };

    if (!decision.publish) {
      // Withheld: carry the prior level, flagged stale, with the reason.
      // Never publish the fabricated level - and where there is no prior
      // level to carry, write nothing rather than invent one.
      pointsWithheld++;
      if (priorLevel == null) continue;
      const doc: IndexPointDoc = {
        ...base,
        level: priorLevel,
        stale: true,
        withheldReason: decision.withheldReason,
      };
      await series.items.upsert(doc);
      lastDate = day;
      if (!firstDate) firstDate = day;
      continue;
    }

    const doc: IndexPointDoc = { ...base, level: Math.round(decision.level * 100) / 100 };
    await series.items.upsert(doc);
    pointsWritten++;
    priorLevel = doc.level;
    latestLevel = doc.level;
    latestUsedWeight = base.usedWeight;
    if (!firstDate) firstDate = day;
    lastDate = day;
  }

  // Persist carry-forward for the next run. This is what makes the
  // nightly append seed from the full history rather than 14 days.
  await saveCarryForward(series, sport, epoch, carryForward);

  return {
    sport,
    epoch,
    basketSize: memberIds.length,
    pointsWritten,
    pointsWithheld,
    firstDate,
    lastDate,
    latestLevel,
    latestUsedWeight,
    reusedBasket: firstEnsured?.reused ?? false,
    epochsUsed,
  };
}

/**
 * Nightly entry point. `backfill` (or `rebuild`, its alias for the
 * recompute lane) runs the full SERIES_DAYS window; otherwise only the
 * target day is appended.
 *
 * Backfill and nightly are ONE method now, so rebuilding history does
 * not silently rewrite it to values computed a different way - that
 * divergence is exactly what made the stored series non-comparable.
 */
export async function runMarketIndexJob(opts: {
  backfill?: boolean;
  rebuild?: boolean;
  asOf?: string;
  sports?: readonly string[];
} = {}): Promise<SportComputeResult[]> {
  const asOf = opts.asOf ?? isoDay(new Date());
  const full = opts.backfill === true || opts.rebuild === true;
  const from = full ? addDays(asOf, -(SERIES_DAYS - 1)) : asOf;
  const sports = opts.sports ?? INDEX_SPORTS;
  const results: SportComputeResult[] = [];
  for (const sport of sports) {
    const r = await computeSeriesForSport(sport, from, asOf);
    if (r) results.push(r);
  }
  return results;
}

/** The floor a point must clear to publish. Re-exported so the scripts
 *  and the read side quote one number rather than each hardcoding it. */
export { MIN_USED_WEIGHT };
