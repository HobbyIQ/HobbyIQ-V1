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
}

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

let sharedDailyContainer: Container | null = null;
async function getDailyContainer(): Promise<Container | null> {
  if (sharedDailyContainer) return sharedDailyContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cs);
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
    if (Math.abs(deltaUSD) < 1) continue;
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

    const container = await getContainer();
    if (!container) {
      res.status(503).json({ error: "sold_comps container unavailable" });
      return;
    }

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
          res.json({
            sport, windowDays,
            totalSkusInWindow: groups.size,
            qualifyingMovers: movers.length,
            returned: result.length,
            computedAt: new Date().toISOString(),
            source: usedPath,
            movers: result,
          });
          return;
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
                     c.cardYear, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.imageUrl
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
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      rows.push(...resources);
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

      // Guard against thin-comp noise: require abs(delta) >= $1 so
      // dime-per-comp movers don't dominate the list.
      if (Math.abs(deltaUSD) < 1) continue;

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

    res.json({
      sport,
      windowDays,
      totalSkusInWindow: groups.size,
      qualifyingMovers: movers.length,
      returned: result.length,
      computedAt: new Date().toISOString(),
      source: "raw",
      movers: result,
    });
  } catch (err) { next(err); }
});

export default router;
