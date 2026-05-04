import { Router } from "express";
import { compiqEstimate, computeEstimate } from "../services/compiq/compiqEstimate.service.js";
import { CompIQEstimateRequest } from "../types/compiq.types.js";
const router = Router();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "CompIQ",
    timestamp: new Date().toISOString()
  });
});

router.post("/estimate", (req, res, next) => compiqEstimate(req, res).catch(next));

// POST /api/compiq/search
// Accepts { query: string } — used by DashboardView free-text search
router.post("/search", async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const body: CompIQEstimateRequest = { playerName: query.trim() };
    const est = await computeEstimate(body);

    const fmv = (est.fairMarketValue as number) ?? 0;
    const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
    const premium = (est.premiumValue as number) ?? fmv * 1.15;
    const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
    const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
    const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);

    res.json({
      success: true,
      query: query.trim(),
      summary: est.verdict ?? "Estimate based on available market data.",
      marketTier: { value: fmv, high: premium },
      buyZone: [quick * 0.9, quick],
      holdZone: [quick, fmv],
      sellZone: [fmv, premium],
      confidence,
      source: est.source ?? "live",
      trendAnalysis: {
        market_direction: direction,
        change_from_older_to_recent: null,
        liquidity: (est.marketDNA as any)?.speed ?? "Normal",
      },
      supply: null,
      recentComps: [],
      buySignal: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/price  (alias for /search — same contract)
router.post("/price", async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const body: CompIQEstimateRequest = { playerName: query.trim() };
    const est = await computeEstimate(body);
    const fmv = (est.fairMarketValue as number) ?? 0;
    const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
    const premium = (est.premiumValue as number) ?? fmv * 1.15;
    const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
    const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
    const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
    res.json({
      success: true,
      query: query.trim(),
      summary: est.verdict ?? "Estimate based on available market data.",
      marketTier: { value: fmv, high: premium },
      buyZone: [quick * 0.9, quick],
      holdZone: [quick, fmv],
      sellZone: [fmv, premium],
      confidence,
      source: est.source ?? "live",
      trendAnalysis: { market_direction: direction, change_from_older_to_recent: null },
      supply: null,
      recentComps: [],
      buySignal: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/bulk
// Accepts { queries: string[] } — used by PortfolioIQViewModel.refreshPortfolio()
router.post("/bulk", async (req, res, next) => {
  try {
    const { queries } = req.body || {};
    if (!Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "queries" array' });
    }
    const safeQueries: string[] = queries.slice(0, 20).map(String);

    const settled = await Promise.allSettled(
      safeQueries.map(async (query) => {
        const est = await computeEstimate({ playerName: query.trim() });
        const fmv = (est.fairMarketValue as number) ?? 0;
        const premium = (est.premiumValue as number) ?? fmv * 1.15;
        const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
        return {
          query,
          status: "ok" as const,
          data: {
            success: true,
            query,
            summary: est.verdict,
            marketTier: { value: fmv, high: premium },
            confidence: Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100),
            trendAnalysis: {
              market_direction: trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat",
            },
            source: est.source ?? "live",
          },
          error: null,
        };
      })
    );

    const results = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { query: safeQueries[i], status: "error" as const, data: null, error: (r.reason as Error)?.message ?? "Unknown error" }
    );

    const succeeded = results.filter((r) => r.status === "ok").length;
    res.json({ requested: safeQueries.length, succeeded, failed: safeQueries.length - succeeded, results });
  } catch (err) {
    next(err);
  }
});

export default router;
