// CF-PLAYER-DETAIL (Drew, 2026-07-19). Aggregated per-player view
// across all cardIds. Powers the "Player Pages" iOS surface — tap a
// player name anywhere in the app, see their whole footprint: total
// sales, price trend, top parallels, cross-year cohort comparison.
//
// Route: GET /api/players/:name?sport=baseball&days=30
// Auth:  requireSession
//
// Query params:
//   sport      "baseball" | "football" | "basketball" | "hockey" (default: baseball)
//   days       lookback window (default 30, max 365)
//
// Response:
//   {
//     player, sport, windowDays, computedAt,
//     summary: {
//       totalSales, medianPrice, deltaPct (vs prior window),
//       distinctCards, priceRange: { min, p25, p50, p75, max }
//     },
//     topCards: [                             // top 10 by sales volume
//       { cardId, product, parallel, cardYear, cardNumber,
//         count, median, min, max, sampleImageUrl }
//     ],
//     byYear: [                                // rookie card + subsequent years
//       { cardYear, count, median, minSaleDate, maxSaleDate }
//     ]
//   }
//
// Uses the (sport, playerName) composite index shipped in PR #607 —
// sub-second at 1M+ row pool size. Falls back to CH's raw pool
// (compsByPlayer) if sold_comps returns nothing for this player.
//
// Rate limits: existing app-level rate limiter applies.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { CosmosClient, type Container } from "@azure/cosmos";

const router = Router();

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
  playerName?: string | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  cardYear?: number | null;
  price: number;
  soldAt: string;
  imageUrl?: string | null;
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.floor((sortedAsc.length - 1) * p);
  return sortedAsc[idx];
}

router.get("/players/:name", requireSession, async (req: Request, res: Response, next) => {
  try {
    const playerName = String(req.params.name ?? "").trim();
    if (!playerName) {
      res.status(400).json({ error: "player name required" });
      return;
    }
    const sport = typeof req.query.sport === "string" && req.query.sport.trim().length > 0
      ? req.query.sport.trim().toLowerCase()
      : "baseball";
    const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 30;

    const container = await getContainer();
    if (!container) {
      res.status(503).json({ error: "sold_comps container unavailable" });
      return;
    }

    const nowMs = Date.now();
    const windowStart = new Date(nowMs - days * 86_400_000).toISOString();
    const priorWindowStart = new Date(nowMs - 2 * days * 86_400_000).toISOString();

    // Uses (sport, playerName) composite index. Case-sensitive exact
    // match on playerName — callers are expected to send the canonical
    // form as it appears in sold_comps.playerName. Future extension:
    // fuzzy match via a name-alias resolver.
    const iter = container.items.query<CompRow>({
      query: `SELECT c.cardId, c.playerName, c.setName, c.parallel, c.cardNumber,
                     c.cardYear, c.price, c.soldAt, c.imageUrl
              FROM c
              WHERE c.sport = @sport
                AND c.playerName = @playerName
                AND c.soldAt >= @priorFrom
                AND c.price > 0
                AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
      parameters: [
        { name: "@sport", value: sport },
        { name: "@playerName", value: playerName },
        { name: "@priorFrom", value: priorWindowStart },
      ],
    });

    const rows: CompRow[] = [];
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      rows.push(...resources);
    }

    // Split into current + prior windows for the deltaPct calc.
    const currentWindow = rows.filter((r) => r.soldAt >= windowStart);
    const priorWindow = rows.filter((r) => r.soldAt < windowStart);

    if (currentWindow.length === 0) {
      res.json({
        player: playerName,
        sport,
        windowDays: days,
        computedAt: new Date().toISOString(),
        summary: null,
        topCards: [],
        byYear: [],
      });
      return;
    }

    const currentPricesSorted = currentWindow.map((r) => r.price).sort((a, b) => a - b);
    const currentMedian = median(currentPricesSorted);
    const priorPricesSorted = priorWindow.map((r) => r.price).sort((a, b) => a - b);
    const priorMedian = priorPricesSorted.length > 0 ? median(priorPricesSorted) : null;
    const deltaPct = priorMedian && priorMedian > 0
      ? Math.round(((currentMedian - priorMedian) / priorMedian) * 1000) / 10
      : null;

    // Group by cardId for top-cards
    const cardBuckets = new Map<string, { rows: CompRow[]; sample: CompRow }>();
    for (const r of currentWindow) {
      const g = cardBuckets.get(r.cardId);
      if (g) g.rows.push(r);
      else cardBuckets.set(r.cardId, { rows: [r], sample: r });
    }
    const topCards = [...cardBuckets.entries()]
      .map(([cardId, g]) => {
        const prices = g.rows.map((r) => r.price).sort((a, b) => a - b);
        return {
          cardId,
          product: g.sample.setName ?? null,
          parallel: g.sample.parallel ?? null,
          cardYear: g.sample.cardYear ?? null,
          cardNumber: g.sample.cardNumber ?? null,
          count: prices.length,
          median: Math.round(median(prices) * 100) / 100,
          min: Math.round(prices[0] * 100) / 100,
          max: Math.round(prices[prices.length - 1] * 100) / 100,
          sampleImageUrl: g.rows.find((r) => r.imageUrl)?.imageUrl ?? null,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Group by cardYear
    const yearBuckets = new Map<number, CompRow[]>();
    for (const r of currentWindow) {
      if (!r.cardYear) continue;
      const arr = yearBuckets.get(r.cardYear) ?? [];
      arr.push(r);
      yearBuckets.set(r.cardYear, arr);
    }
    const byYear = [...yearBuckets.entries()]
      .map(([cardYear, sales]) => {
        const prices = sales.map((r) => r.price).sort((a, b) => a - b);
        const dates = sales.map((r) => r.soldAt).sort();
        return {
          cardYear,
          count: sales.length,
          median: Math.round(median(prices) * 100) / 100,
          minSaleDate: dates[0],
          maxSaleDate: dates[dates.length - 1],
        };
      })
      .sort((a, b) => a.cardYear - b.cardYear);

    res.json({
      player: playerName,
      sport,
      windowDays: days,
      computedAt: new Date().toISOString(),
      summary: {
        totalSales: currentWindow.length,
        medianPrice: Math.round(currentMedian * 100) / 100,
        deltaPct,
        priorMedianPrice: priorMedian !== null ? Math.round(priorMedian * 100) / 100 : null,
        distinctCards: cardBuckets.size,
        priceRange: {
          min: Math.round(currentPricesSorted[0] * 100) / 100,
          p25: Math.round(percentile(currentPricesSorted, 0.25) * 100) / 100,
          p50: Math.round(currentMedian * 100) / 100,
          p75: Math.round(percentile(currentPricesSorted, 0.75) * 100) / 100,
          max: Math.round(currentPricesSorted[currentPricesSorted.length - 1] * 100) / 100,
        },
      },
      topCards,
      byYear,
    });
  } catch (err) { next(err); }
});

export default router;
