// CF-WEEKLY-HOBBY-INDEX (Drew, 2026-07-20). Aggregated per-sport
// market snapshot: WoW % change on median transaction, top gainers/
// losers, activity levels. Content-play — powers a Sunday-morning
// email digest for paid subscribers + a public "hobby weather"
// dashboard surface.
//
// Uses sold_comps directly (composite index (sport, soldAt) makes
// the aggregation sub-second even at 2M+ rows). No dependency on
// sold_comps_daily so ready to ship before rollup finishes.
//
// Output shape targets iOS + a text-formattable digest.

import { CosmosClient, type Container } from "@azure/cosmos";

let sharedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cs);
    sharedContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return sharedContainer;
  } catch { return null; }
}

interface CompRow {
  cardId: string;
  playerName: string | null;
  setName: string | null;
  parallel: string | null;
  cardYear: number | null;
  price: number;
  soldAt: string;
}

export interface HobbyIndexMover {
  cardId: string;
  playerName: string | null;
  product: string | null;
  parallel: string | null;
  cardYear: number | null;
  priorMedian: number;
  currentMedian: number;
  deltaPct: number;
  deltaUSD: number;
  salesThisWeek: number;
}

export interface HobbyIndexResult {
  sport: string;
  weekStart: string;
  weekEnd: string;
  priorWeekStart: string;
  priorWeekEnd: string;
  computedAt: string;
  activity: {
    salesThisWeek: number;
    salesPriorWeek: number;
    activityDeltaPct: number;
    distinctCardsThisWeek: number;
  };
  index: {
    medianTransactionThisWeek: number;
    medianTransactionPriorWeek: number;
    indexDeltaPct: number;
  };
  topGainers: HobbyIndexMover[];
  topDecliners: HobbyIndexMover[];
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

export async function buildWeeklyHobbyIndex(sport: string): Promise<HobbyIndexResult | null> {
  const container = await getContainer();
  if (!container) return null;

  const now = new Date();
  const weekEnd = now.toISOString();
  const weekStart = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const priorWeekEnd = weekStart;
  const priorWeekStart = new Date(now.getTime() - 14 * 86_400_000).toISOString();

  // One query covers both weeks — the composite (sport, soldAt) index
  // makes this sub-second at pool size.
  const iter = container.items.query<CompRow>({
    query: `SELECT c.cardId, c.playerName, c.setName, c.parallel, c.cardYear, c.price, c.soldAt
            FROM c
            WHERE c.sport = @sport
              AND c.soldAt >= @from
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@from", value: priorWeekStart },
    ],
  });
  const rows: CompRow[] = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    rows.push(...resources);
  }

  const current = rows.filter((r) => r.soldAt >= weekStart);
  const prior = rows.filter((r) => r.soldAt < weekStart);

  const currentPrices = current.map((r) => r.price).sort((a, b) => a - b);
  const priorPrices = prior.map((r) => r.price).sort((a, b) => a - b);
  const medianCurrent = median(currentPrices);
  const medianPrior = median(priorPrices);
  const indexDeltaPct = medianPrior > 0
    ? Math.round(((medianCurrent - medianPrior) / medianPrior) * 1000) / 10
    : 0;
  const activityDeltaPct = prior.length > 0
    ? Math.round(((current.length - prior.length) / prior.length) * 1000) / 10
    : 0;

  // Group by (cardId, parallel) for movers
  const byCardParallel = new Map<string, { row: CompRow; currentPrices: number[]; priorPrices: number[] }>();
  for (const r of rows) {
    const key = `${r.cardId}::${r.parallel ?? ""}`;
    let g = byCardParallel.get(key);
    if (!g) {
      g = { row: r, currentPrices: [], priorPrices: [] };
      byCardParallel.set(key, g);
    }
    if (r.soldAt >= weekStart) g.currentPrices.push(r.price);
    else g.priorPrices.push(r.price);
  }

  const movers: HobbyIndexMover[] = [];
  for (const [, g] of byCardParallel) {
    if (g.currentPrices.length < 2 || g.priorPrices.length < 2) continue;
    const cs = g.currentPrices.slice().sort((a, b) => a - b);
    const ps = g.priorPrices.slice().sort((a, b) => a - b);
    const cur = median(cs);
    const pri = median(ps);
    if (pri <= 0) continue;
    const deltaPct = Math.round(((cur - pri) / pri) * 1000) / 10;
    const deltaUSD = Math.round((cur - pri) * 100) / 100;
    if (Math.abs(deltaUSD) < 1) continue;
    movers.push({
      cardId: g.row.cardId,
      playerName: g.row.playerName,
      product: g.row.setName,
      parallel: g.row.parallel,
      cardYear: g.row.cardYear,
      priorMedian: Math.round(pri * 100) / 100,
      currentMedian: Math.round(cur * 100) / 100,
      deltaPct,
      deltaUSD,
      salesThisWeek: cs.length,
    });
  }

  const topGainers = movers
    .filter((m) => m.deltaPct > 0)
    .sort((a, b) => b.deltaPct - a.deltaPct)
    .slice(0, 10);
  const topDecliners = movers
    .filter((m) => m.deltaPct < 0)
    .sort((a, b) => a.deltaPct - b.deltaPct)
    .slice(0, 10);

  const distinctCardsThisWeek = new Set(current.map((r) => r.cardId)).size;

  return {
    sport,
    weekStart,
    weekEnd,
    priorWeekStart,
    priorWeekEnd,
    computedAt: new Date().toISOString(),
    activity: {
      salesThisWeek: current.length,
      salesPriorWeek: prior.length,
      activityDeltaPct,
      distinctCardsThisWeek,
    },
    index: {
      medianTransactionThisWeek: Math.round(medianCurrent * 100) / 100,
      medianTransactionPriorWeek: Math.round(medianPrior * 100) / 100,
      indexDeltaPct,
    },
    topGainers,
    topDecliners,
  };
}
