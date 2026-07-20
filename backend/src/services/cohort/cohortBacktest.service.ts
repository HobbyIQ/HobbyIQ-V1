// CF-COHORT-BACKTEST (Drew, 2026-07-20). "How did the 2020 rookie
// class hold value vs 2019?" Real analytics play — powers narrative
// surfaces (weekly hobby digest, rookie-class-of-the-year lists)
// AND informs FMV projection by class.
//
// Approach: for each (playerName, cardYear) cohort, compute the
// median price of their canonical rookie card (first-year prospect
// auto / base card) in two windows: initial (year-of-release +/-
// 90 days) and current (last 90 days). Return the growth multiplier.
//
// "Canonical rookie card" heuristic: the card in the class with the
// highest 30-day-recent comp count. Works well for signal players
// (Bobby Witt Jr. = 2020 CPA-BWJ, Ronald Acuña Jr. = 2018 CPA-RA,
// etc.). Small-tail players return no cohort entry.

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
  price: number;
  soldAt: string;
  cardYear: number | null;
}

export interface CohortBacktestInput {
  /** Sport to scope the cohort to. Required. */
  sport: string;
  /** The rookie year of the cohort ("2020" = 2020 rookies). */
  cohortYear: number;
  /** Comparison window in days (default 90). */
  windowDays?: number;
  /** Max players returned (default 30). */
  limit?: number;
}

export interface CohortMemberResult {
  playerName: string;
  cardId: string;
  cohortYear: number;
  initialMedian: number | null;   // median in the year-of-release window
  currentMedian: number;          // median in the current window
  growthPct: number | null;       // (current - initial) / initial * 100
  currentSampleN: number;
  initialSampleN: number;
}

export interface CohortBacktestResult {
  sport: string;
  cohortYear: number;
  windowDays: number;
  computedAt: string;
  medianGrowthPct: number | null;   // cohort-level median of per-player growthPct
  memberCount: number;
  topGainers: CohortMemberResult[];
  topDecliners: CohortMemberResult[];
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

export async function runCohortBacktest(input: CohortBacktestInput): Promise<CohortBacktestResult> {
  const windowDays = input.windowDays ?? 90;
  const limit = input.limit ?? 30;
  const container = await getContainer();
  if (!container) {
    return { sport: input.sport, cohortYear: input.cohortYear, windowDays, computedAt: new Date().toISOString(), medianGrowthPct: null, memberCount: 0, topGainers: [], topDecliners: [] };
  }

  const nowMs = Date.now();
  const currentFrom = new Date(nowMs - windowDays * 86_400_000).toISOString();
  // Initial window: 90 days after the cohort's release year (Jan 1 of
  // cohortYear + 90d as a rough "rookie release + settle" period).
  const initialFrom = new Date(Date.UTC(input.cohortYear, 0, 1)).toISOString();
  const initialTo = new Date(Date.UTC(input.cohortYear, 3, 30)).toISOString();

  // Query sold_comps for all sales in either window across the cohort.
  const iter = container.items.query<CompRow>({
    query: `SELECT c.cardId, c.playerName, c.price, c.soldAt, c.cardYear
            FROM c
            WHERE c.sport = @sport
              AND c.cardYear = @year
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
              AND ((c.soldAt >= @currentFrom) OR
                   (c.soldAt >= @initialFrom AND c.soldAt <= @initialTo))`,
    parameters: [
      { name: "@sport", value: input.sport },
      { name: "@year", value: input.cohortYear },
      { name: "@currentFrom", value: currentFrom },
      { name: "@initialFrom", value: initialFrom },
      { name: "@initialTo", value: initialTo },
    ],
  });

  const rows: CompRow[] = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    rows.push(...resources);
  }

  // Group by (playerName, cardId). Pick each player's most-active
  // cardId as their canonical rookie card.
  const byPlayerCard = new Map<string, { cardId: string; playerName: string; initial: number[]; current: number[] }>();
  for (const r of rows) {
    if (!r.playerName) continue;
    const key = `${r.playerName}::${r.cardId}`;
    let g = byPlayerCard.get(key);
    if (!g) {
      g = { cardId: r.cardId, playerName: r.playerName, initial: [], current: [] };
      byPlayerCard.set(key, g);
    }
    if (r.soldAt >= currentFrom) g.current.push(r.price);
    else if (r.soldAt >= initialFrom && r.soldAt <= initialTo) g.initial.push(r.price);
  }

  // Pick the canonical cardId per player: highest current-window count.
  const byPlayer = new Map<string, ReturnType<typeof byPlayerCard.get>>();
  for (const [, g] of byPlayerCard) {
    if (!g || g.current.length === 0) continue;
    const existing = byPlayer.get(g.playerName);
    if (!existing || g.current.length > existing.current.length) {
      byPlayer.set(g.playerName, g);
    }
  }

  const members: CohortMemberResult[] = [];
  for (const [, g] of byPlayer) {
    if (!g) continue;
    const currentSorted = g.current.slice().sort((a, b) => a - b);
    const initialSorted = g.initial.slice().sort((a, b) => a - b);
    const currentMedian = median(currentSorted);
    const initialMedian = initialSorted.length > 0 ? median(initialSorted) : null;
    const growthPct = initialMedian !== null && initialMedian > 0
      ? Math.round(((currentMedian - initialMedian) / initialMedian) * 1000) / 10
      : null;
    members.push({
      playerName: g.playerName,
      cardId: g.cardId,
      cohortYear: input.cohortYear,
      initialMedian: initialMedian !== null ? Math.round(initialMedian * 100) / 100 : null,
      currentMedian: Math.round(currentMedian * 100) / 100,
      growthPct,
      currentSampleN: currentSorted.length,
      initialSampleN: initialSorted.length,
    });
  }

  const withGrowth = members.filter((m) => m.growthPct !== null);
  const growths = withGrowth.map((m) => m.growthPct as number).sort((a, b) => a - b);
  const medianGrowthPct = growths.length > 0
    ? Math.round(growths[Math.floor(growths.length / 2)] * 10) / 10
    : null;

  const topGainers = [...withGrowth].sort((a, b) => (b.growthPct as number) - (a.growthPct as number)).slice(0, Math.ceil(limit / 2));
  const topDecliners = [...withGrowth].sort((a, b) => (a.growthPct as number) - (b.growthPct as number)).slice(0, Math.floor(limit / 2));

  return {
    sport: input.sport,
    cohortYear: input.cohortYear,
    windowDays,
    computedAt: new Date().toISOString(),
    medianGrowthPct,
    memberCount: members.length,
    topGainers,
    topDecliners,
  };
}
