// CF-MARKET-INDEXES (Drew, 2026-09-02). Read side: one call returns
// every sport's series + latest values, which is exactly what the
// MarketIndexes tile strip needs to render without a fan-out.
//
// H-12 (2026-09-03): freshMembers used to be STORED and never read back,
// so a level computed from 1 member rendered identically to one computed
// from 94 - which is why the hockey collapse (C-1) was invisible for as
// long as it was. The SELECT now carries freshMembers, usedWeight and
// the withheld flags, and the response surfaces them, so a thin point
// can say so on the tile instead of passing for a real one.

import {
  INDEX_SPORTS,
  SERIES_DAYS,
  addDays,
  getSeriesContainer,
  isoDay,
  type IndexPointDoc,
} from "./marketIndex.service.js";

export interface IndexSeriesPoint {
  date: string;
  level: number;
  /** Members with a fresh (non-carried) value on this date. */
  freshMembers?: number;
  /** Share of basket weight actually valued (0..1). */
  usedWeight?: number;
  /** True when the level is carried from a prior day, not computed. */
  stale?: boolean;
  withheldReason?: string;
}

export interface SportIndexSeries {
  sport: string;
  /** Chronological, oldest first. */
  series: IndexSeriesPoint[];
  latestLevel: number | null;
  /** % change across the returned window. */
  changePct: number | null;
  windowDays: number;
  basketSize: number | null;
  asOf: string | null;
  /** Members with a fresh value on the newest point. */
  freshMembers: number | null;
  /** Share of basket weight valued on the newest point (0..1). */
  usedWeight: number | null;
  /** The newest point is carried, not computed - the basket went thin. */
  stale: boolean;
  withheldReason: string | null;
}

export interface MarketIndexesResponse {
  success: true;
  computedAt: string;
  windowDays: number;
  indexes: SportIndexSeries[];
}

/** Read one sport's points. Single-partition query — the reserved
 *  `index::<sport>` partition key keeps this cheap. */
async function readSeries(sport: string, windowDays: number): Promise<SportIndexSeries> {
  const empty: SportIndexSeries = {
    sport,
    series: [],
    latestLevel: null,
    changePct: null,
    windowDays,
    basketSize: null,
    asOf: null,
    freshMembers: null,
    usedWeight: null,
    stale: false,
    withheldReason: null,
  };
  const container = await getSeriesContainer();
  if (!container) return empty;

  const from = addDays(isoDay(new Date()), -(windowDays - 1));
  try {
    const iter = container.items.query<IndexPointDoc>({
      query: `SELECT c.date, c.level, c.basketSize, c.freshMembers,
                     c.usedWeight, c.stale, c.withheldReason
              FROM c
              WHERE c.cardId = @pk
                AND c.docType = 'market_index_point'
                AND c.date >= @from
              ORDER BY c.date ASC`,
      parameters: [
        { name: "@pk", value: `index::${sport}` },
        { name: "@from", value: from },
      ],
    });
    const all: IndexPointDoc[] = [];
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      all.push(...resources);
    }
    // A `series_start` withhold carries NO level: it is a day below the
    // floor with no prior level to carry, written only so the recompute
    // owns its id. There is nothing to plot, so it is dropped here and
    // the tile shows nothing for those days rather than a gap-filling
    // zero (which would print a -100% change on the very first point).
    const rows = all.filter((r) => Number.isFinite(r.level) && (r.level as number) > 0);
    if (rows.length === 0) {
      // Every point in the window is levelless. That is NOT "no such
      // sport" — it is a sport we track and deliberately did not price,
      // and the two must not look alike downstream. Returning the bare
      // `empty` here threw away the newest point's withheldReason, so a
      // withheld sport arrived at the UI indistinguishable from one that
      // has no basket doc at all, and the tile strip dropped it silently
      // (pokemon, 180/180 levelless on 2026-09-04). Carry the reason so
      // the tile can say why there is no number.
      const newestAny = all[all.length - 1];
      if (!newestAny) return empty;
      return {
        ...empty,
        basketSize: newestAny.basketSize ?? null,
        asOf: newestAny.date,
        freshMembers: newestAny.freshMembers ?? null,
        usedWeight: newestAny.usedWeight ?? null,
        stale: newestAny.stale === true,
        withheldReason: newestAny.withheldReason ?? null,
      };
    }

    const series: IndexSeriesPoint[] = rows.map((r) => ({
      date: r.date,
      level: r.level as number,
      freshMembers: r.freshMembers,
      usedWeight: r.usedWeight,
      ...(r.stale ? { stale: true, withheldReason: r.withheldReason } : {}),
    }));
    const first = series[0].level;
    const last = series[series.length - 1].level;
    const changePct = first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null;
    const newest = rows[rows.length - 1];
    return {
      sport,
      series,
      latestLevel: last,
      changePct,
      windowDays,
      basketSize: newest.basketSize ?? null,
      asOf: series[series.length - 1].date,
      freshMembers: newest.freshMembers ?? null,
      usedWeight: newest.usedWeight ?? null,
      stale: newest.stale === true,
      withheldReason: newest.withheldReason ?? null,
    };
  } catch {
    return empty;
  }
}

export async function getMarketIndexes(windowDays = SERIES_DAYS): Promise<MarketIndexesResponse> {
  const indexes = await Promise.all(INDEX_SPORTS.map((s) => readSeries(s, windowDays)));
  return {
    success: true,
    computedAt: new Date().toISOString(),
    windowDays,
    indexes,
  };
}
