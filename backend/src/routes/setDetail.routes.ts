// CF-SET-DETAIL (Drew, 2026-07-20). "Every card in 2020 Bowman Chrome
// Prospects, sorted by median FMV." Powers a Sets tab in iOS.
//
// Route: GET /api/compiq/sets/:setSlug
// Auth:  requireSession
//
// Path param:
//   setSlug — url-encoded string that the endpoint fuzzy-matches
//             against sold_comps.setName. Example:
//             "2020-bowman-chrome-prospects" → matches setName
//             containing "2020 bowman chrome prospects" (case-fold,
//             hyphen-space tolerant).
//
// Query params:
//   sport         "baseball" | "football" | "basketball" | "hockey"
//                 (default baseball). Used for the composite index.
//   days          lookback for median calc (default 90, max 365)
//   limit         max cards returned (default 50, cap 200)
//   sortBy        "median-desc" | "median-asc" | "sales-desc" |
//                 "sales-asc" (default median-desc)
//
// Response:
//   {
//     setSlug, sport, windowDays, computedAt,
//     card_count: number,      // distinct cardIds in the set
//     total_sales: number,     // total sale rows across the set in window
//     cards: [
//       {
//         cardId, playerName, cardNumber, parallel, cardYear,
//         product, sampleImageUrl,
//         salesInWindow, min, p25, median, p75, max,
//       }
//     ]
//   }
//
// Read-only. Uses the (sport, soldAt) composite index. Filters by
// setName in-memory after the composite scan.

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
  playerName: string | null;
  setName: string | null;
  parallel: string | null;
  cardNumber: string | null;
  cardYear: number | null;
  price: number;
  soldAt: string;
  imageUrl: string | null;
}

function slugToText(slug: string): string {
  return slug.toLowerCase().replace(/-/g, " ").trim();
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

router.get("/sets/:setSlug", requireSession, async (req: Request, res: Response, next) => {
  try {
    const setSlug = String(req.params.setSlug ?? "").trim();
    if (!setSlug) {
      res.status(400).json({ error: "setSlug required" });
      return;
    }
    const setText = slugToText(setSlug);
    const sport = typeof req.query.sport === "string" && req.query.sport.trim().length > 0
      ? req.query.sport.trim().toLowerCase()
      : "baseball";
    const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 90;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? Math.floor(limitRaw) : 50;
    const sortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "median-desc";

    const container = await getContainer();
    if (!container) {
      res.status(503).json({ error: "sold_comps container unavailable" });
      return;
    }

    const windowStart = new Date(Date.now() - days * 86_400_000).toISOString();

    const iter = container.items.query<CompRow>({
      query: `SELECT c.cardId, c.playerName, c.setName, c.parallel, c.cardNumber,
                     c.cardYear, c.price, c.soldAt, c.imageUrl
              FROM c
              WHERE c.sport = @sport
                AND c.soldAt >= @from
                AND c.price > 0
                AND CONTAINS(LOWER(c.setName), @setToken)
                AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
      parameters: [
        { name: "@sport", value: sport },
        { name: "@from", value: windowStart },
        { name: "@setToken", value: setText },
      ],
    });

    const rows: CompRow[] = [];
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      rows.push(...resources);
    }

    if (rows.length === 0) {
      res.json({
        setSlug, sport, windowDays: days, computedAt: new Date().toISOString(),
        card_count: 0, total_sales: 0, cards: [],
      });
      return;
    }

    // Group by cardId (folding across parallels of the same base card
    // would collapse Blue Refractor into the same bucket as Base —
    // wrong for a set-detail view. Group by cardId keeps each SKU
    // discrete).
    const byCardId = new Map<string, { rows: CompRow[]; sample: CompRow }>();
    for (const r of rows) {
      const g = byCardId.get(r.cardId);
      if (g) g.rows.push(r);
      else byCardId.set(r.cardId, { rows: [r], sample: r });
    }

    const cards = [...byCardId.entries()].map(([cardId, g]) => {
      const prices = g.rows.map((r) => r.price).sort((a, b) => a - b);
      return {
        cardId,
        playerName: g.sample.playerName,
        cardNumber: g.sample.cardNumber,
        parallel: g.sample.parallel,
        cardYear: g.sample.cardYear,
        product: g.sample.setName,
        sampleImageUrl: g.rows.find((r) => r.imageUrl)?.imageUrl ?? null,
        salesInWindow: prices.length,
        min: Math.round(prices[0] * 100) / 100,
        p25: Math.round(percentile(prices, 0.25) * 100) / 100,
        median: Math.round(median(prices) * 100) / 100,
        p75: Math.round(percentile(prices, 0.75) * 100) / 100,
        max: Math.round(prices[prices.length - 1] * 100) / 100,
      };
    });

    // Sort
    switch (sortBy) {
      case "median-asc":
        cards.sort((a, b) => a.median - b.median);
        break;
      case "sales-desc":
        cards.sort((a, b) => b.salesInWindow - a.salesInWindow);
        break;
      case "sales-asc":
        cards.sort((a, b) => a.salesInWindow - b.salesInWindow);
        break;
      case "median-desc":
      default:
        cards.sort((a, b) => b.median - a.median);
        break;
    }

    res.json({
      setSlug,
      sport,
      windowDays: days,
      computedAt: new Date().toISOString(),
      card_count: cards.length,
      total_sales: rows.length,
      cards: cards.slice(0, limit),
    });
  } catch (err) { next(err); }
});

export default router;
