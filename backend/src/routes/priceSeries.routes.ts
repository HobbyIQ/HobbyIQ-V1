// CF-PRICE-SERIES (Drew, 2026-07-20). Pro-tier historical chart data.
// Reads sold_comps_daily rollups (or falls back to sold_comps direct
// aggregation when the rollup container is empty for a given SKU) and
// returns a sparse time-series iOS charts library can render.
//
// Route: GET /api/compiq/cards/:cardId/price-series
// Auth:  requireSession
//
// Query params:
//   parallel        (optional) — filter to a specific parallel
//   gradeCompany    (optional)
//   gradeValue      (optional)
//   window          "30d" | "90d" | "180d" | "365d" (default 90d)
//   bucket          "day" | "week" (default "day")
//
// Response:
//   {
//     cardId, parallel, gradeCompany, gradeValue,
//     windowDays, bucket, computedAt,
//     points: [
//       { day, median, min, max, count, sources: {...} }
//     ]
//   }
//
// Prefers reading sold_comps_daily (fast). Falls back to sold_comps
// direct aggregation if daily container has no matching rows —
// happens for SKUs that haven't been rolled up yet (still populating)
// or that haven't traded during the window.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { CosmosClient, type Container } from "@azure/cosmos";

const router = Router();

let sharedDailyContainer: Container | null = null;
let sharedRawContainer: Container | null = null;
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
async function getRawContainer(): Promise<Container | null> {
  if (sharedRawContainer) return sharedRawContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cs);
    sharedRawContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return sharedRawContainer;
  } catch { return null; }
}

function normalizeKey(v: unknown): string {
  return String(v ?? "").trim().toLowerCase() || "__null__";
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

router.get("/cards/:cardId/price-series", requireSession, async (req: Request, res: Response, next) => {
  try {
    const cardId = String(req.params.cardId ?? "").trim();
    if (!cardId) {
      res.status(400).json({ error: "cardId required" });
      return;
    }
    const parallel = typeof req.query.parallel === "string" ? req.query.parallel : undefined;
    const gradeCompany = typeof req.query.gradeCompany === "string" && req.query.gradeCompany.length > 0
      ? req.query.gradeCompany : null;
    const gradeValueRaw = typeof req.query.gradeValue === "string" ? Number(req.query.gradeValue) : NaN;
    const gradeValue = Number.isFinite(gradeValueRaw) ? gradeValueRaw : null;
    const windowMap: Record<string, number> = { "30d": 30, "90d": 90, "180d": 180, "365d": 365 };
    const windowDays = windowMap[String(req.query.window ?? "90d")] ?? 90;
    const bucket = req.query.bucket === "week" ? "week" : "day";

    const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

    // Try daily rollup first
    const daily = await getDailyContainer();
    let points: Array<{ day: string; median: number; min: number; max: number; count: number; sources?: Record<string, number> }> = [];
    if (daily) {
      const parameters: Array<{ name: string; value: string | number }> = [
        { name: "@cid", value: cardId },
        { name: "@from", value: windowStart },
      ];
      let filterExtras = "";
      if (parallel !== undefined) {
        filterExtras += " AND c.parallel = @parallel";
        parameters.push({ name: "@parallel", value: parallel });
      }
      if (gradeCompany !== null) {
        filterExtras += " AND c.gradeCompany = @gc";
        parameters.push({ name: "@gc", value: gradeCompany });
      }
      if (gradeValue !== null) {
        filterExtras += " AND c.gradeValue = @gv";
        parameters.push({ name: "@gv", value: gradeValue });
      }
      const iter = daily.items.query<{
        day: string; median: number; min: number; max: number; count: number; sources?: Record<string, number>;
      }>({
        query: `SELECT c.day, c.median, c.min, c.max, c.count, c.sources
                FROM c WHERE c.cardId = @cid AND c.day >= @from${filterExtras}
                ORDER BY c.day ASC`,
        parameters,
      }, { partitionKey: cardId });
      while (iter.hasMoreResults()) {
        const { resources } = await iter.fetchNext();
        points.push(...resources);
      }
    }

    // Fall back to sold_comps direct if daily returned nothing
    if (points.length === 0) {
      const raw = await getRawContainer();
      if (raw) {
        const windowStartISO = new Date(Date.now() - windowDays * 86_400_000).toISOString();
        const rawIter = raw.items.query<{ soldAt: string; price: number; source: string; parallel: string | null; gradeCompany: string | null; gradeValue: number | null }>({
          query: `SELECT c.soldAt, c.price, c.source, c.parallel, c.gradeCompany, c.gradeValue
                  FROM c WHERE c.cardId = @cid AND c.soldAt >= @from AND c.price > 0
                    AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
          parameters: [
            { name: "@cid", value: cardId },
            { name: "@from", value: windowStartISO },
          ],
        }, { partitionKey: cardId });
        const rawRows: Array<{ soldAt: string; price: number; source: string; parallel: string | null; gradeCompany: string | null; gradeValue: number | null }> = [];
        while (rawIter.hasMoreResults()) {
          const { resources } = await rawIter.fetchNext();
          rawRows.push(...resources);
        }
        // Filter in-memory
        const filtered = rawRows.filter((r) => {
          if (parallel !== undefined && normalizeKey(r.parallel) !== normalizeKey(parallel)) return false;
          if (gradeCompany !== null && normalizeKey(r.gradeCompany) !== normalizeKey(gradeCompany)) return false;
          if (gradeValue !== null && r.gradeValue !== gradeValue) return false;
          return true;
        });
        // Bucket by day
        const byDay = new Map<string, { prices: number[]; sources: Record<string, number> }>();
        for (const r of filtered) {
          const day = r.soldAt.slice(0, 10);
          const g = byDay.get(day) ?? { prices: [], sources: {} };
          g.prices.push(r.price);
          g.sources[r.source] = (g.sources[r.source] ?? 0) + 1;
          byDay.set(day, g);
        }
        points = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, g]) => {
          const s = g.prices.slice().sort((a, b) => a - b);
          return {
            day,
            median: Math.round(median(s) * 100) / 100,
            min: Math.round(s[0] * 100) / 100,
            max: Math.round(s[s.length - 1] * 100) / 100,
            count: s.length,
            sources: g.sources,
          };
        });
      }
    }

    // Weekly re-bucket if requested
    if (bucket === "week" && points.length > 0) {
      const byWeek = new Map<string, { prices: number[]; count: number; sources: Record<string, number> }>();
      for (const p of points) {
        const d = new Date(p.day + "T00:00:00Z");
        const dow = d.getUTCDay();
        const monday = new Date(d.getTime() - dow * 86_400_000);
        const weekKey = monday.toISOString().slice(0, 10);
        const g = byWeek.get(weekKey) ?? { prices: [], count: 0, sources: {} };
        // We don't have the raw prices at week level, only per-day medians.
        // Approximate: weight each day's median by its count.
        for (let i = 0; i < p.count; i++) g.prices.push(p.median);
        g.count += p.count;
        for (const [k, v] of Object.entries(p.sources ?? {})) {
          g.sources[k] = (g.sources[k] ?? 0) + v;
        }
        byWeek.set(weekKey, g);
      }
      points = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, g]) => {
        const s = g.prices.slice().sort((a, b) => a - b);
        return {
          day,
          median: s.length > 0 ? Math.round(median(s) * 100) / 100 : 0,
          min: s.length > 0 ? Math.round(s[0] * 100) / 100 : 0,
          max: s.length > 0 ? Math.round(s[s.length - 1] * 100) / 100 : 0,
          count: g.count,
          sources: g.sources,
        };
      });
    }

    res.json({
      cardId,
      parallel: parallel ?? null,
      gradeCompany,
      gradeValue,
      windowDays,
      bucket,
      computedAt: new Date().toISOString(),
      pointCount: points.length,
      points,
    });
  } catch (err) { next(err); }
});

export default router;
