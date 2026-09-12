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
//
// CF-MARKET-MOVERS-PERSISTED-SNAPSHOT (Fable, 2026-09-12). The compute
// logic (rollup-first, raw-scan fallback) now lives in
// services/compiq/marketMoversSnapshot.service.ts, shared with the admin
// dispatch route below and the scheduled refresh job — same reasons
// documented there: a live viewer must never be the one paying for the
// raw cross-partition scan, and an in-process cache alone cannot fix that
// on 2 recycling App Service instances. Read order:
//   1. this worker's in-process cache (fresh within 5 min) — zero Cosmos
//      calls, cheapest path, survives until this worker recycles.
//   2. the PERSISTED snapshot in daily_snapshots (one point read, 1 RU) —
//      survives recycles and is shared across both instances; refreshed
//      on its own schedule by the "Daily Market Signals Refresh" cron.
//   3. a live compute — only when neither of the above has anything,
//      i.e. a genuinely cold shape nobody has warmed yet.
import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import {
  computeMarketMovers,
  readMarketMoversSnapshot,
  type MarketMoversParams,
  type MarketMoversResult,
} from "../services/compiq/marketMoversSnapshot.service.js";

const router = Router();

// CF-MARKET-MOVERS-SNAPSHOT-CACHE (Fable, 2026-09-12). Still worth keeping
// in front of the persisted-snapshot point read: it costs nothing to check,
// and turns a burst of requests for the same shape (several viewers open
// the Market tab within the same few seconds) into ONE Cosmos point read
// instead of N. It is NOT the structural fix by itself — see the module
// doc comment above and marketMoversSnapshot.service.ts for why.
const TTL_FRESH_MS = 5 * 60_000;   // serve with no Cosmos call at all
interface CacheEntry { result: MarketMoversResult; computedAtMs: number }
const inProcessCache = new Map<string, CacheEntry>();

function cacheKeyFor(p: MarketMoversParams): string {
  return `${p.sport}::${p.windowDays}::${p.direction}::${p.limit}::${p.minSales}`;
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

    // 1. In-process cache — zero Cosmos calls when fresh.
    const cached = inProcessCache.get(key);
    const ageMs = cached ? Date.now() - cached.computedAtMs : Infinity;
    if (cached && ageMs < TTL_FRESH_MS) {
      res.json({ ...cached.result, cache: { state: "in-process", ageMs } });
      return;
    }

    // 2. Persisted snapshot — one point read, survives recycles and is
    // shared across both instances. This is the answer for the OVERWHELMING
    // majority of real requests once the scheduled job has warmed the
    // handful of shapes it covers (see scheduledSnapshotShapes()).
    const snapshot = await readMarketMoversSnapshot(params);
    if (snapshot) {
      inProcessCache.set(key, { result: snapshot.result, computedAtMs: Date.now() });
      const snapshotAgeMs = Date.now() - Date.parse(snapshot.computedAt);
      res.json({ ...snapshot.result, cache: { state: "persisted-snapshot", ageMs: snapshotAgeMs } });
      return;
    }

    // 3. Cold shape — nobody has warmed this (sport, window, direction,
    // limit, minSales) combination yet. Compute inline, exactly as the
    // route always has, and seed the in-process cache so a burst of
    // requests for this same cold shape doesn't each pay for it.
    const computed = await computeMarketMovers(params);
    if ("unavailable" in computed) {
      res.status(503).json({ error: "sold_comps container unavailable" });
      return;
    }
    inProcessCache.set(key, { result: computed, computedAtMs: Date.now() });
    res.json({ ...computed, cache: { state: "miss", ageMs: 0 } });
  } catch (err) { next(err); }
});

export default router;
