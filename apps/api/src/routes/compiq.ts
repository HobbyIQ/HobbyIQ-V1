import { Router, Request, Response } from "express";
import { fetchSoldComps } from "../utils/apifySoldService";
import { analyzeTrend } from "../utils/trendEngine";

const router = Router();

// POST /api/compiq/estimate
router.post("/estimate", (req: Request, res: Response) => {
  const { player, cardSet, parallel, rawPrice } = req.body || {};
  if (
    typeof player !== "string" ||
    typeof cardSet !== "string" ||
    typeof parallel !== "string" ||
    typeof rawPrice !== "number"
  ) {
    return res.status(400).json({
      success: false,
      error: "Missing or invalid input. Required: player, cardSet, parallel, rawPrice (number)"
    });
  }
  const estimatedPsa10 = rawPrice * 2.25;
  const estimatedPsa9 = rawPrice * 1.15;
  const estimatedPsa8 = rawPrice * 0.9;
  res.json({
    success: true,
    player,
    cardSet,
    parallel,
    rawPrice,
    estimatedPsa10,
    estimatedPsa9,
    estimatedPsa8
  });
});

// --- Public GET /api/compiq/trend-test ---
router.get("/trend-test", (req: Request, res: Response) => {
  let { prices, dates } = req.query;
  if (typeof prices === "string") prices = prices.split(",");
  if (typeof dates === "string") dates = dates.split(",");
  let comps: { price: number; soldDate: string }[] = [];
  if (Array.isArray(prices) && Array.isArray(dates) && prices.length === dates.length && prices.length > 0) {
    comps = prices.map((p, i) => ({ price: Number(p), soldDate: String(dates[i]) }));
  } else {
    comps = [
      { price: 100, soldDate: "2026-04-01" },
      { price: 110, soldDate: "2026-04-03" },
      { price: 125, soldDate: "2026-04-05" },
      { price: 130, soldDate: "2026-04-07" },
      { price: 145, soldDate: "2026-04-09" }
    ];
  }
  // Simple trend analysis
  const pricesArr = comps.map(c => c.price);
  const compCount = comps.length;
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const baseCompFmv = pricesArr.length ? Math.round(median(pricesArr) * 100) / 100 : null;
  const recentMedian = pricesArr.length >= 3 ? Math.round(median(pricesArr.slice(-3)) * 100) / 100 : null;
  const olderMedian = pricesArr.length >= 3 ? Math.round(median(pricesArr.slice(0, 3)) * 100) / 100 : null;
  let trendPct = null, trendDirection = "flat", trendMultiplier = 1.0;
  if (recentMedian && olderMedian && olderMedian !== 0) {
    trendPct = Math.round(((recentMedian - olderMedian) / olderMedian) * 10000) / 100;
    if (trendPct <= -20) {
      trendMultiplier = 0.88;
      trendDirection = "down";
    } else if (trendPct > -20 && trendPct <= -10) {
      trendMultiplier = 0.93;
      trendDirection = "down";
    } else if (trendPct > -10 && trendPct < 5) {
      trendMultiplier = 1.0;
      trendDirection = "flat";
    } else if (trendPct >= 5 && trendPct < 10) {
      trendMultiplier = 1.03;
      trendDirection = "up";
    } else if (trendPct >= 10 && trendPct < 20) {
      trendMultiplier = 1.07;
      trendDirection = "up";
    } else if (trendPct >= 20 && trendPct < 35) {
      trendMultiplier = 1.12;
      trendDirection = "up";
    } else if (trendPct >= 35) {
      trendMultiplier = 1.18;
      trendDirection = "up";
    }
  }
  const finalAdjustedFmv = baseCompFmv && trendMultiplier ? Math.round(baseCompFmv * trendMultiplier * 100) / 100 : null;
  res.json({
    success: true,
    comps,
    compCount,
    baseCompFmv,
    recentMedian,
    olderMedian,
    trendPct,
    trendDirection,
    trendMultiplier: Math.round(trendMultiplier * 100) / 100,
    finalAdjustedFmv
  });
});

// --- Public GET /api/compiq/live-estimate ---
router.get("/live-estimate", async (req: Request, res: Response) => {
  const { player, cardSet, parallel, isAuto, serial } = req.query;
  if (!player || !cardSet) {
    return res.status(400).json({ success: false, error: "player and cardSet are required" });
  }
  const isAutoBool = typeof isAuto === "string" ? isAuto.toLowerCase() === "true" : false;
  const normalizedParallel = typeof parallel === "string" ? parallel.toLowerCase() : undefined;
  // Multipliers (reuse logic if needed)
  // For demo, just use 1.0
  const parallelMultiplier = 1.0;
  const serialMultiplier = 1.0;
  // Fetch comps
  let comps = await fetchSoldComps({
    player: String(player),
    cardSet: String(cardSet),
    parallel: typeof parallel === "string" ? parallel : undefined,
    isAuto: isAutoBool,
    serial: serial as string | undefined
  });
  // Trend
  const trend = analyzeTrend(comps);
  const trendMultiplier = trend.trendMultiplier;
  const finalAdjustedFmv = trend.finalAdjustedFmv !== null ? Math.round(trend.finalAdjustedFmv * parallelMultiplier * serialMultiplier * 100) / 100 : null;
  res.json({
    success: true,
    compCount: trend.compCount,
    baseCompFmv: trend.baseCompFmv !== null ? Math.round(trend.baseCompFmv * 100) / 100 : null,
    recentMedian: trend.recentMedian !== null ? Math.round(trend.recentMedian * 100) / 100 : null,
    olderMedian: trend.olderMedian !== null ? Math.round(trend.olderMedian * 100) / 100 : null,
    trendPct: trend.trendPct !== null ? Math.round(trend.trendPct * 100) / 100 : null,
    trendDirection: trend.trendDirection,
    trendMultiplier: Math.round(trendMultiplier * 100) / 100,
    finalAdjustedFmv,
    estimatedPsa10: finalAdjustedFmv !== null ? Math.round(finalAdjustedFmv * 2.25 * 100) / 100 : null,
    estimatedPsa9: finalAdjustedFmv !== null ? Math.round(finalAdjustedFmv * 1.15 * 100) / 100 : null,
    estimatedPsa8: finalAdjustedFmv !== null ? Math.round(finalAdjustedFmv * 0.9 * 100) / 100 : null
  });
});

export default router;
