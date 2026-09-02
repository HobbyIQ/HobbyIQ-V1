// CF-MARKET-INDEXES (Drew, 2026-09-02). Read side: one call returns
// every sport's series + latest values, which is exactly what the
// MarketIndexes tile strip needs to render without a fan-out.

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
  };
  const container = await getSeriesContainer();
  if (!container) return empty;

  const from = addDays(isoDay(new Date()), -(windowDays - 1));
  try {
    const iter = container.items.query<IndexPointDoc>({
      query: `SELECT c.date, c.level, c.basketSize
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
    const rows: IndexPointDoc[] = [];
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      rows.push(...resources);
    }
    if (rows.length === 0) return empty;

    const series = rows.map((r) => ({ date: r.date, level: r.level }));
    const first = series[0].level;
    const last = series[series.length - 1].level;
    const changePct = first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null;
    return {
      sport,
      series,
      latestLevel: last,
      changePct,
      windowDays,
      basketSize: rows[rows.length - 1].basketSize ?? null,
      asOf: series[series.length - 1].date,
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
