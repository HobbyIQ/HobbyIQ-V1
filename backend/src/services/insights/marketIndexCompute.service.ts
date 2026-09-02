// CF-MARKET-INDEXES (Drew, 2026-09-02). Orchestration for the fixed-
// liquid-basket index: basket selection, daily point append, and the
// first-run 180d backfill. Formula + storage rationale live in the
// marketIndex.service.ts header — read that first.
//
// Idempotence: point docs are keyed `point::<sport>::<date>` and written
// with upsert, so re-running a day overwrites that day rather than
// appending a second point for it. Basket docs are keyed
// `basket::<sport>::<epoch>` for the same reason.

import type { Container } from "@azure/cosmos";
import {
  INDEX_SPORTS,
  MARKET_INDEX_BASKET_SIZE,
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
  rebalanceEpochFor,
  selectBasket,
  valueMembersOnDay,
} from "./marketIndex.service.js";

export interface SportComputeResult {
  sport: string;
  epoch: string;
  basketSize: number;
  pointsWritten: number;
  firstDate: string | null;
  lastDate: string | null;
  latestLevel: number | null;
  reusedBasket?: boolean;
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
 * within a quarterly epoch — we only reselect when the epoch rolls.
 */
export async function ensureBasket(
  soldComps: Container,
  series: Container,
  sport: string,
  asOf: string,
): Promise<{ basket: IndexBasketDoc; reused: boolean } | null> {
  const epoch = rebalanceEpochFor(asOf);
  const existing = await loadBasket(series, sport, epoch);
  if (existing && existing.members?.length > 0) return { basket: existing, reused: true };

  // Base date is the epoch start, but never in the future of the data we
  // are computing for (a mid-quarter first run bases at the epoch start,
  // which is what makes the level comparable across the quarter).
  const baseDate = epochBaseDate(epoch);
  const eligFrom = addDays(baseDate, -ELIGIBILITY_WINDOW_DAYS);
  const rows = await fetchSales(soldComps, sport, eligFrom, baseDate);
  const byCard = groupByCard(rows);
  const picked = selectBasket(byCard, MARKET_INDEX_BASKET_SIZE);
  if (picked.length === 0) return null;

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
  await series.items.upsert(doc);
  return { basket: doc, reused: false };
}

/**
 * Compute and persist index points for [fromDate, toDate] inclusive.
 * Used for both the nightly single-day append (from === to) and the
 * first-run 180d backfill.
 */
export async function computeSeriesForSport(
  sport: string,
  fromDate: string,
  toDate: string,
): Promise<SportComputeResult | null> {
  const soldComps = await getSoldCompsContainer();
  const series = await getSeriesContainer();
  if (!soldComps || !series) return null;

  const ensured = await ensureBasket(soldComps, series, sport, toDate);
  if (!ensured) return null;
  const { basket } = ensured;
  const memberIds = basket.members.map((m) => m.cardId);
  const memberSet = new Set(memberIds);

  // One pool read covers the whole span plus the lead-in needed to value
  // the first day. Filtering to basket members in memory keeps this to a
  // single query instead of one per day.
  const readFrom = addDays(fromDate, -VALUE_WINDOW_DAYS);
  const readTo = addDays(toDate, 1);
  const allRows = (await fetchSales(soldComps, sport, readFrom, readTo))
    .filter((r) => memberSet.has(r.cardId));

  const carryForward = new Map<string, number>();
  // Seed carry-forward from the lead-in window so day one is not blank.
  const seed = groupByCard(allRows.filter((r) => r.soldAt < fromDate));
  for (const id of memberIds) {
    const agg = seed.get(id);
    if (agg && agg.values.length > 0) carryForward.set(id, agg.values[agg.values.length - 1]);
  }

  let pointsWritten = 0;
  let latestLevel: number | null = null;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (let day = fromDate; day <= toDate; day = addDays(day, 1)) {
    const windowFrom = addDays(day, -VALUE_WINDOW_DAYS);
    const windowTo = addDays(day, 1);
    const windowRows = allRows.filter((r) => r.soldAt >= windowFrom && r.soldAt < windowTo);
    const inWindow = groupByCard(windowRows);
    const { values, fresh } = valueMembersOnDay(memberIds, inWindow, carryForward);
    const level = indexLevel(basket.members, values);
    if (!(level > 0)) continue;

    const doc: IndexPointDoc = {
      id: `point::${sport}::${day}`,
      cardId: indexPartitionKey(sport),
      docType: "market_index_point",
      sport,
      date: day,
      level: Math.round(level * 100) / 100,
      epoch: basket.epoch,
      freshMembers: fresh,
      basketSize: memberIds.length,
      computedAt: new Date().toISOString(),
    };
    await series.items.upsert(doc);
    pointsWritten++;
    latestLevel = doc.level;
    if (!firstDate) firstDate = day;
    lastDate = day;
  }

  return {
    sport,
    epoch: basket.epoch,
    basketSize: memberIds.length,
    pointsWritten,
    firstDate,
    lastDate,
    latestLevel,
    reusedBasket: ensured.reused,
  };
}

/**
 * Nightly entry point. `backfill` runs the full SERIES_DAYS window (the
 * first-run history build); otherwise only the target day is appended.
 */
export async function runMarketIndexJob(opts: {
  backfill?: boolean;
  asOf?: string;
  sports?: readonly string[];
} = {}): Promise<SportComputeResult[]> {
  const asOf = opts.asOf ?? isoDay(new Date());
  const from = opts.backfill ? addDays(asOf, -(SERIES_DAYS - 1)) : asOf;
  const sports = opts.sports ?? INDEX_SPORTS;
  const results: SportComputeResult[] = [];
  for (const sport of sports) {
    const r = await computeSeriesForSport(sport, from, asOf);
    if (r) results.push(r);
  }
  return results;
}
