import { Router, Request, Response } from "express";
import { searchAndPrice } from "../../services/compiqSearchService";

const router = Router();

router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "CompIQ running" });
});

// POST /api/compiq/search — live eBay comps
router.post("/search", async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query?: string };
    if (!query || typeof query !== "string" || query.trim() === "") {
      return res.status(400).json({ error: "Missing required field: query" });
    }
    const result = await searchAndPrice(query.trim());
    return res.json(result);
  } catch (err) {
    console.error("[compiq/search] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/compiq/price — alias for search
router.post("/price", async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query?: string };
    if (!query || typeof query !== "string" || query.trim() === "") {
      return res.status(400).json({ error: "Missing required field: query" });
    }
    const result = await searchAndPrice(query.trim());
    return res.json(result);
  } catch (err) {
    console.error("[compiq/price] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/compiq/query
router.post("/query", (req: Request, res: Response) => {
  // Example baseball query: { player: "Aaron Judge", stat: "home_runs", season: 2023 }
  const { player, stat, season } = req.body;
  if (!player || !stat || !season) {
    return res.status(400).json({ error: "Missing required fields: player, stat, season" });
  }
  res.json({
    player,
    stat,
    season,
    value: 52, // mock value
    source: "mock"
  });
});

// POST /api/compiq/estimate — structured card fields → real eBay pricing
router.post("/estimate", async (req: Request, res: Response) => {
  const { playerName, cardYear, product, parallel, grade, isAuto } = req.body as {
    playerName?: string;
    cardYear?: number;
    product?: string;
    parallel?: string;
    grade?: string;
    isAuto?: boolean;
  };
  if (!playerName || !product) {
    return res.status(400).json({ error: "Missing required fields: playerName, product" });
  }
  const parts = [
    cardYear ? String(cardYear) : null,
    product,
    playerName,
    parallel && parallel.toLowerCase() !== "base" ? parallel : null,
    grade ? grade : null,
    isAuto ? "auto" : null,
  ].filter(Boolean);
  const query = parts.join(" ");
  try {
    const result = await searchAndPrice(query);
    const primaryParallel = result.recentComps.length > 0 ? result.recentComps[0].parallel ?? null : null;
    const adjacentComps = result.recentComps.filter((c) => (c.parallel ?? null) !== primaryParallel);

    return res.json({
      fairMarketValue: result.marketTier.value,
      quickSaleValue: result.buyZone[0],
      premiumValue: result.marketTier.high,
      lastDirectComp: result.lastDirectComp,
      nextSaleEstimate: result.nextSaleEstimate,
      anchorAnalysis: result.anchorAnalysis,
      compRange: result.compRange,
      recommendation: result.recommendation,
      keyRisks: result.keyRisks,
      marketDNA: {
        trend: result.trendAnalysis.market_direction,
        liquidity: result.trendAnalysis.liquidity,
        trendConfidence: result.trendAnalysis.trend_confidence,
        surroundingMovement: result.anchorAnalysis.surroundingMovement,
        anchorAge: result.anchorAnalysis.anchorAge,
      },
      pricingAnalytics: {
        projectedNextSale: result.nextSaleEstimate,
        rSquared: result.trendAnalysis.trend_confidence,
        compsUsed: result.recentComps.length,
        gradeDetected: result.gradeTierUsed,
        parallelDetected: primaryParallel,
      },
      marketContext: {
        fullMarketQuery: result.marketTrendOverall.queryUsed,
        fullMarketSampleSize: result.marketTrendOverall.sampleSize,
        fullMarketTrend: result.marketTrendOverall.trend,
      },
      comps: {
        used: result.recentComps,
        outliers: result.outliers,
      },
      adjacentCards: {
        count: adjacentComps.length,
        comps: adjacentComps,
      },
      zones: {
        buy: result.buyZone,
        hold: result.holdZone,
        sell: result.sellZone,
      },
      summary: result.summary,
      confidence: result.confidence,
      source: "live",
    });
  } catch (err) {
    console.error("[compiq/estimate] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
