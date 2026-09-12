// CF-MARKET-MOVERS (Drew, 2026-07-19). "What's moving in the hobby
// this week." Reads sold_comps directly using the new (sport, soldAt)
// composite index and computes per-cardId price change over the
// requested window.
//
// Route: GET /api/compiq/market-movers
// Auth:  requireSession
//
// Query params:
//   sport      "baseball" | "football" | "basketball" | "hockey" (default: baseball)
//   window     "7d" | "14d" | "30d" (default: 7d)
//   direction  "up" | "down" | "both" (default: both)
//   limit      1..50 (default: 20)
//   minSales   min number of sales in the window (default: 3 — filters out illiquid)
//
// Response:
//   {
//     sport, windowDays, computedAt,
//     movers: [
//       { cardId, playerName, product, parallel, gradeCompany, gradeValue,
//         cardYear, cardNumber, priorMedian, currentMedian, deltaPct,
//         deltaUSD, salesInWindow, sampleImageUrl }
//     ]
//   }
//
// Delta math: prior half of window vs. current half of window. Requires
// at least 1 sale in each half for a card to qualify.
//
// Rate limits: 10 requests / min / user via existing app-level middleware.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { CosmosClient, type Container } from "@azure/cosmos";
import { moverCredibility, looksDamaged } from "../services/compiq/moverCredibility.service.js";
import { cosmosOptionsFromConnectionString } from "../services/ops/cosmosConnectionPolicy.js";

const router = Router();

interface CompRow {
  cardId: string;
  playerName?: string | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  cardYear?: number | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price: number;
  soldAt: string;
  imageUrl?: string | null;
  title?: string | null;
}

let sharedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cosmosOptionsFromConnectionString(cs));
    sharedContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return sharedContainer;
  } catch { return null; }
}

let sharedDailyContainer: Container | null = null;
async function getDailyContainer(): Promise<Container | null> {
  if (sharedDailyContainer) return sharedDailyContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cosmosOptionsFromConnectionString(cs));
    sharedDailyContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("sold_comps_daily");
    return sharedDailyContainer;
  } catch { return null; }
}

interface DailyRow {
  cardId: string;
  sport: string | null;
  playerName: string | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  cardNumber: string | null;
  cardYear: number | null;
  day: string;
  count: number;
  median: number;
  min: number;
  max: number;
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

interface Mover {
  cardId: string;
  playerName: string | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  cardYear: number | null;
  cardNumber: string | null;
  priorMedian: number;
  currentMedian: number;
  deltaPct: number;
  deltaUSD: number;
  salesInWindow: number;
  sampleImageUrl: string | null;
}

function buildMoversFromDaily(
  groups: Map<string, { rows: DailyRow[]; sku: DailyRow }>,
  midpointDay: string,
  minSales: number,
): Mover[] {
  const movers: Mover[] = [];
  for (const [, g] of groups) {
    const totalSales = g.rows.reduce((s, r) => s + r.count, 0);
    if (totalSales < minSales) continue;
    const prior = g.rows.filter((r) => r.day < midpointDay);
    const current = g.rows.filter((r) => r.day >= midpointDay);
    if (prior.length === 0 || current.length === 0) continue;
    // Weighted median-of-medians by day count. For thin buckets this
    // is equivalent to the raw median; for thick buckets it's a fair
    // approximation without paying the raw-scan cost.
    const priorSorted = prior.slice().sort((a, b) => a.median - b.median).map((r) => r.median);
    const currentSorted = current.slice().sort((a, b) => a.median - b.median).map((r) => r.median);
    const priorMedian = median(priorSorted);
    const currentMedian = median(currentSorted);
    if (priorMedian <= 0) continue;
    const deltaPct = Math.round(((currentMedian - priorMedian) / priorMedian) * 1000) / 10;
    const deltaUSD = Math.round((currentMedian - priorMedian) * 100) / 100;
    const verdict = moverCredibility({ priorMedian, currentMedian, deltaPct, deltaUSD, salesInWindow: totalSales });
    if (!verdict.ok) continue;
    movers.push({
      cardId: g.sku.cardId,
      playerName: g.sku.playerName,
      product: g.sku.product,
      parallel: g.sku.parallel,
      gradeCompany: g.sku.gradeCompany,
      gradeValue: g.sku.gradeValue,
      cardYear: g.sku.cardYear,
      cardNumber: g.sku.cardNumber,
      priorMedian: Math.round(priorMedian * 100) / 100,
      currentMedian: Math.round(currentMedian * 100) / 100,
      deltaPct,
      deltaUSD,
      salesInWindow: totalSales,
      sampleImageUrl: null, // rollup path doesn't have image; iOS falls to catalog art
    });
  }
  return movers;
}

function rankMovers(movers: Mover[], direction: string, limit: number): Mover[] {
  if (direction === "up") {
    return movers.filter((m) => m.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, limit);
  }
  if (direction === "down") {
    return movers.filter((m) => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, limit);
  }
  const up = movers.filter((m) => m.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, Math.ceil(limit / 2));
  const down = movers.filter((m) => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, Math.floor(limit / 2));
  return [...up, ...down];
}

interface MarketMoversParams {
  sport: string;
  windowDays: number;
  direction: string;
  limit: number;
  minSales: number;
}

interface MarketMoversResult {
  sport: string;
  windowDays: number;
  totalSkusInWindow: number;
  qualifyingMovers: number;
  damagedSkipped?: number;
  rejectedByCredibility?: Record<string, number>;
  returned: number;
  computedAt: string;
  source: "rollups" | "raw";
  movers: Mover[];
}

// CF-MARKET-MOVERS-SNAPSHOT-CACHE (Fable, 2026-09-12). The raw path is a
// cross-partition scan of every comp in the window (30d baseball ~= 400K+
// rows) aggregated in memory — a Tier 1 harness run (PR #2056) measured
// 5.0s+ on a cold request, and sold_comps_daily (the rollup container the
// code already prefers) has NEVER been written to in prod (0 dependency
// calls in 30 days of App Insights), so MARKET_MOVERS_USE_ROLLUPS turning
// on today would just fall through to the same raw scan every time.
//
// Fixing the query shape doesn't fix a full-window cross-partition
// aggregation — that work is inherent until the nightly rollup job is
// actually dispatched (a follow-up, not a request-path fix). What IS a
// request-path fix, and needs no prod config or infra change: never let a
// live viewer pay for that scan. One snapshot per (sport, window,
// direction, limit, minSales) shape is computed at a time; every request
// within TTL_FRESH_MS gets it with no Cosmos round-trip; a request that
// finds the snapshot stale (TTL_FRESH_MS < age < TTL_STALE_MS) gets the
// STALE snapshot immediately and triggers exactly one background refresh
// (never a second one while the first is in flight); only the very first
// request for a shape, or one past TTL_STALE_MS, waits on a fresh compute.
const TTL_FRESH_MS = 5 * 60_000;   // serve with no refresh
const TTL_STALE_MS = 30 * 60_000;  // serve stale + kick a background refresh
interface CacheEntry { result: MarketMoversResult; computedAtMs: number; refreshing: boolean }
const snapshotCache = new Map<string, CacheEntry>();

function cacheKeyFor(p: MarketMoversParams): string {
  return `${p.sport}::${p.windowDays}::${p.direction}::${p.limit}::${p.minSales}`;
}

/** The actual Cosmos-touching compute — rollups first (when sufficiently
 *  populated), raw scan otherwise. Unchanged from the pre-cache behavior;
 *  this is what the cache wraps, never bypasses on a genuine first compute. */
async function computeMarketMovers(params: MarketMoversParams): Promise<MarketMoversResult | { unavailable: true }> {
  const { sport, windowDays, direction, limit, minSales } = params;
  const container = await getContainer();
  if (!container) return { unavailable: true };

  const nowMs = Date.now();
  const windowStart = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const midpoint = new Date(nowMs - (windowDays / 2) * 86_400_000).toISOString();
  const windowStartDay = windowStart.slice(0, 10);
  const midpointDay = midpoint.slice(0, 10);

  // CF-MARKET-MOVERS-ROLLUPS (Drew, 2026-07-20). Rollup-first path
  // consumes sold_comps_daily to eliminate the ~100K-row raw scan.
  // Flag-gated + defensive: if the rollup returns fewer SKUs than a
  // sanity threshold (rollup script hasn't been dispatched for this
  // sport, or the day range isn't populated), fall back to the raw
  // scan below. Populate ROLLUP_SUFFICIENCY_MIN so a sparsely-covered
  // long-tail sport doesn't silently return an empty list.
  const useRollups = String(process.env.MARKET_MOVERS_USE_ROLLUPS ?? "").toLowerCase() === "true";
  const rollupMinSkus = Number(process.env.MARKET_MOVERS_ROLLUP_SUFFICIENCY_MIN ?? "50");
  let usedPath: "rollups" | "raw" = "raw";

  if (useRollups) {
    const daily = await getDailyContainer();
    if (daily) {
      const dailyIter = daily.items.query<DailyRow>({
        query: `SELECT c.cardId, c.sport, c.playerName, c.product, c.parallel,
                       c.gradeCompany, c.gradeValue, c.cardNumber, c.cardYear,
                       c.day, c.count, c.median, c.min, c.max
                FROM c
                WHERE c.sport = @sport
                  AND c.day >= @fromDay
                  AND c.median > 0`,
        parameters: [
          { name: "@sport", value: sport },
          { name: "@fromDay", value: windowStartDay },
        ],
      });
      const dailyRows: DailyRow[] = [];
      while (dailyIter.hasMoreResults()) {
        const { resources } = await dailyIter.fetchNext();
        dailyRows.push(...resources);
      }

      // Group by (cardId, parallel, gradeCompany, gradeValue). For
      // each group compute prior-half median-of-medians + current-half
      // median-of-medians (weighted by daily count).
      const groups = new Map<string, { rows: DailyRow[]; sku: DailyRow }>();
      for (const r of dailyRows) {
        const key = `${r.cardId}::${r.parallel ?? ""}::${r.gradeCompany ?? ""}::${r.gradeValue ?? ""}`;
        const g = groups.get(key);
        if (g) g.rows.push(r);
        else groups.set(key, { rows: [r], sku: r });
      }

      if (groups.size >= rollupMinSkus) {
        usedPath = "rollups";
        const movers = buildMoversFromDaily(groups, midpointDay, minSales);
        const result = rankMovers(movers, direction, limit);
        return {
          sport, windowDays,
          totalSkusInWindow: groups.size,
          qualifyingMovers: movers.length,
          returned: result.length,
          computedAt: new Date().toISOString(),
          source: usedPath,
          movers: result,
        };
      }
      console.log(JSON.stringify({
        event: "market_movers.rollup_insufficient",
        sport, skus: groups.size, threshold: rollupMinSkus,
        action: "fall_back_to_raw",
      }));
    }
  }

  // Uses the (sport, soldAt) composite index. Returns every comp in
  // the window across the sport — bounded by window * daily volume;
  // for baseball 7d ~= 100K rows at current volume (manageable in
  // memory for aggregation).
  const iter = container.items.query<CompRow>({
    query: `SELECT c.cardId, c.playerName, c.setName, c.parallel, c.cardNumber,
                   c.cardYear, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.imageUrl,
                   c.title
            FROM c
            WHERE c.sport = @sport
              AND c.soldAt >= @from
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@from", value: windowStart },
    ],
  });

  const rows: CompRow[] = [];
  let damagedSkipped = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      // A "READ" / creased / miscut listing is a real sale of a DAMAGED card.
      // It belongs in neither half of a price comparison — several sat at the
      // top of the live index.
      if (looksDamaged(r.title)) { damagedSkipped++; continue; }
      rows.push(r);
    }
  }

  // Group by (cardId, parallel, gradeCompany, gradeValue) — same SKU
  // definition as canonical FMV. Cross-parallel/cross-grade mixing
  // would produce meaningless deltas.
  const groups = new Map<string, { rows: CompRow[]; sku: CompRow }>();
  for (const r of rows) {
    const key = `${r.cardId}::${r.parallel ?? ""}::${r.gradeCompany ?? ""}::${r.gradeValue ?? ""}`;
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { rows: [r], sku: r });
  }

  const movers: Mover[] = [];
  // Counted rather than silently dropped: an index that filters everything
  // looks exactly like one that is broken, which is how this stayed hidden.
  const rejected = new Map<string, number>();

  for (const [, g] of groups) {
    if (g.rows.length < minSales) continue;
    const prior = g.rows.filter((r) => r.soldAt < midpoint).map((r) => r.price);
    const current = g.rows.filter((r) => r.soldAt >= midpoint).map((r) => r.price);
    if (prior.length === 0 || current.length === 0) continue;
    const priorSorted = prior.slice().sort((a, b) => a - b);
    const currentSorted = current.slice().sort((a, b) => a - b);
    const priorMedian = median(priorSorted);
    const currentMedian = median(currentSorted);
    if (priorMedian <= 0) continue;
    const deltaPct = Math.round(((currentMedian - priorMedian) / priorMedian) * 1000) / 10;
    const deltaUSD = Math.round((currentMedian - priorMedian) * 100) / 100;

    // CF-MOVER-CREDIBILITY. The old guard was abs(deltaUSD) >= $1, which a
    // $0.01 -> $10 penny listing clears while reading as +99,900% — so junk
    // permanently outranked every genuine mover and the index looked frozen.
    const verdict = moverCredibility({ priorMedian, currentMedian, deltaPct, deltaUSD, salesInWindow: g.rows.length });
    if (!verdict.ok) { rejected.set(verdict.reason, (rejected.get(verdict.reason) ?? 0) + 1); continue; }

    const sampleImage = g.rows.find((r) => r.imageUrl)?.imageUrl ?? null;
    movers.push({
      cardId: g.sku.cardId,
      playerName: g.sku.playerName ?? null,
      product: g.sku.setName ?? null,
      parallel: g.sku.parallel ?? null,
      gradeCompany: g.sku.gradeCompany ?? null,
      gradeValue: g.sku.gradeValue ?? null,
      cardYear: g.sku.cardYear ?? null,
      cardNumber: g.sku.cardNumber ?? null,
      priorMedian: Math.round(priorMedian * 100) / 100,
      currentMedian: Math.round(currentMedian * 100) / 100,
      deltaPct,
      deltaUSD,
      salesInWindow: g.rows.length,
      sampleImageUrl: sampleImage,
    });
  }

  const result = rankMovers(movers, direction, limit);

  return {
    sport,
    windowDays,
    totalSkusInWindow: groups.size,
    qualifyingMovers: movers.length,
    damagedSkipped,
    rejectedByCredibility: Object.fromEntries([...rejected.entries()].sort((a, b) => b[1] - a[1])),
    returned: result.length,
    computedAt: new Date().toISOString(),
    source: "raw",
    movers: result,
  };
}

/** Fire a background refresh for one cache key, at most once concurrently.
 *  Errors are logged and swallowed — a failed background refresh leaves the
 *  existing (stale) snapshot in place rather than losing it. */
function refreshInBackground(key: string, params: MarketMoversParams): void {
  const existing = snapshotCache.get(key);
  if (existing?.refreshing) return;
  if (existing) existing.refreshing = true;
  void (async () => {
    try {
      const computed = await computeMarketMovers(params);
      if (!("unavailable" in computed)) {
        snapshotCache.set(key, { result: computed, computedAtMs: Date.now(), refreshing: false });
      } else if (existing) {
        existing.refreshing = false;
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "market_movers.background_refresh_failed",
        key,
        error: (err as Error)?.message ?? String(err),
      }));
      const entry = snapshotCache.get(key);
      if (entry) entry.refreshing = false;
    }
  })();
}

router.get("/market-movers", requireSession, async (req: Request, res: Response, next) => {
  try {
    const sport = typeof req.query.sport === "string" && req.query.sport.trim().length > 0
      ? req.query.sport.trim().toLowerCase()
      : "baseball";
    const windowRaw = typeof req.query.window === "string" ? req.query.window : "7d";
    const windowDaysMap: Record<string, number> = { "7d": 7, "14d": 14, "30d": 30 };
    const windowDays = windowDaysMap[windowRaw] ?? 7;
    const direction = typeof req.query.direction === "string" ? req.query.direction : "both";
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50 ? Math.floor(limitRaw) : 20;
    const minSalesRaw = typeof req.query.minSales === "string" ? Number(req.query.minSales) : NaN;
    const minSales = Number.isFinite(minSalesRaw) && minSalesRaw >= 1 && minSalesRaw <= 20 ? Math.floor(minSalesRaw) : 3;

    const params: MarketMoversParams = { sport, windowDays, direction, limit, minSales };
    const key = cacheKeyFor(params);
    const cached = snapshotCache.get(key);
    const ageMs = cached ? Date.now() - cached.computedAtMs : Infinity;

    if (cached && ageMs < TTL_FRESH_MS) {
      res.json({ ...cached.result, cache: { state: "fresh", ageMs } });
      return;
    }
    if (cached && ageMs < TTL_STALE_MS) {
      // Serve stale immediately; refresh happens off the request path so
      // this viewer never pays for the scan — the doctrine's "cached
      // snapshot with a TTL and a stale-while-revalidate refresh".
      refreshInBackground(key, params);
      res.json({ ...cached.result, cache: { state: "stale", ageMs } });
      return;
    }

    // No usable snapshot (first request for this shape, or one old enough
    // that serving it would be misleading): compute inline, exactly as the
    // route always has, and seed the cache for the next viewer.
    const computed = await computeMarketMovers(params);
    if ("unavailable" in computed) {
      res.status(503).json({ error: "sold_comps container unavailable" });
      return;
    }
    snapshotCache.set(key, { result: computed, computedAtMs: Date.now(), refreshing: false });
    res.json({ ...computed, cache: { state: "miss", ageMs: 0 } });
  } catch (err) { next(err); }
});

export default router;
