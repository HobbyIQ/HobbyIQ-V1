import { Request, Response } from "express";
import { CompIQEstimateRequest } from "../../types/compiq.types.js";
import { DynamicPricingOrchestrator } from "../../modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js";

// ---------------------------------------------------------------------------
// Apify eBay comp fetch
// ---------------------------------------------------------------------------

interface RawComp {
  price: number;
  title: string;
  soldDate: string;
}

async function fetchComps(query: string): Promise<RawComp[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return [];

  const url =
    "https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items" +
    `?token=${encodeURIComponent(token)}`;

  try {
    const apifyRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: [query], count: 20 }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!apifyRes.ok) return [];
    const items: unknown[] = await apifyRes.json();
    if (!Array.isArray(items)) return [];
    return items
      .map((item: any) => {
        const price = Number(item.soldPrice ?? item.price);
        return isNaN(price) || price <= 0
          ? null
          : { price, title: String(item.title || ""), soldDate: String(item.endedAt ?? item.soldDate ?? "") };
      })
      .filter((x): x is RawComp => x !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function computeEstimate(body: CompIQEstimateRequest): Promise<Record<string, unknown>> {

  const cardTitle = [
    body.playerName,
    body.cardYear,
    body.product,
    body.parallel,
    body.gradeCompany ? `${body.gradeCompany} ${body.gradeValue}` : undefined,
    body.isAuto ? "Auto" : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  // Build subject for the pipeline
  const subject = {
    playerName: body.playerName,
    cardYear: body.cardYear,
    product: body.product,
    parallel: body.parallel,
    gradeCompany: body.gradeCompany,
    gradeValue: body.gradeValue,
    isAuto: body.isAuto ?? false,
  };

  // Fetch live comps from eBay via Apify
  const rawComps = await fetchComps(cardTitle);

  // Filter out numbered serials (/499, #/50, etc.) unless the request explicitly specifies a parallel.
  // This prevents refractors/prizms from skewing the base card FMV.
  const hasParallel = Boolean(body.parallel);
  const serialPattern = /(?:#\s*\/\s*|\/)\s*\d{1,4}(?:\b|$)/i;
  const filteredComps = hasParallel
    ? rawComps
    : rawComps.filter((c) => !serialPattern.test(c.title));
  // Fall back to unfiltered pool if filtering leaves too few comps
  const compsPool = filteredComps.length >= 3 ? filteredComps : rawComps;

  // --- Parallel keyword post-filter ---
  // Keeps only comps that mention the requested parallel (e.g. "Blue Raywave" or "Blue /99").
  // Falls back to full pool when fewer than 3 match so we never go dark on data.
  function applyParallelFilter(pool: RawComp[], parallel: string): RawComp[] {
    const lower = parallel.trim().toLowerCase();
    const fullMatch = pool.filter((c) => c.title.toLowerCase().includes(lower));
    if (fullMatch.length >= 3) return fullMatch;
    // Try longest word (≥4 chars) as a fallback distinguishing token
    const distinctWord = lower.split(/\s+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0];
    if (distinctWord) {
      const wordMatch = pool.filter((c) => c.title.toLowerCase().includes(distinctWord));
      if (wordMatch.length >= 3) return wordMatch;
    }
    return pool; // can't narrow further — keep full pool
  }

  // --- Grade keyword post-filter ---
  // When a grade is requested (e.g. "PSA 10"), only use comps that carry that grade in their title.
  function applyGradeFilter(pool: RawComp[], gradeStr: string): RawComp[] {
    const lower = gradeStr.trim().toLowerCase();
    const gradeMatch = pool.filter((c) => c.title.toLowerCase().includes(lower));
    return gradeMatch.length >= 3 ? gradeMatch : pool;
  }

  let refinedPool = compsPool;
  if (body.parallel) refinedPool = applyParallelFilter(refinedPool, body.parallel);
  if (body.gradeCompany && body.gradeValue !== undefined) {
    refinedPool = applyGradeFilter(refinedPool, `${body.gradeCompany} ${body.gradeValue}`);
  }

  const comps = refinedPool.map((c) => ({
    price: c.price,
    title: c.title,
    date: c.soldDate,
    source: "ebay",
    id: `${c.price}-${c.soldDate}`,
  }));

  // Build context for the pipeline
  const soldCount30d = comps.length;
  // Estimate active listings as ~40% of 30-day sold count (typical sell-through ratio for sports cards).
  // This gives an absorptionRate > 1.0 (sellers' market) for active cards rather than always 1.0.
  const activeListings = Math.max(1, Math.round(soldCount30d * 0.4));
  const context: {
    soldCount30d: number;
    activeListings: number;
    avgDaysToSell: number;
    volatilityIndex: number;
    rankingTrend: string;
    trendProjection?: {
      projectedPrice: number;
      rSquared: number;
      slope: number;
      confidence: number;
    };
    compPoolDebug?: {
      totalNormalized: number;
      exactMatchForTrend: number;
      usingFallbackPool: boolean;
    };
  } = {
    soldCount30d,
    activeListings,
    avgDaysToSell: 7,
    volatilityIndex: 40,
    rankingTrend: "flat",
  };

  // Run predictive analytics pipeline
  const result = DynamicPricingOrchestrator.run(subject, comps, context);

  const usedFallback = result.observability?.usedFallback ?? false;
  const { quickSaleValue, fairMarketValue, premiumValue } = result.priceLanes;

  // Map confidence bundle (ConfidenceEngine returns 0–100 integers already)
  const confidenceBundle = result.confidence ?? {};
  const pricingConfidence = Math.min(100, confidenceBundle.pricingConfidence ?? 60);
  const liquidityConfidence = Math.min(100, confidenceBundle.liquidityConfidence ?? 60);
  const timingConfidence = Math.min(100, confidenceBundle.timingConfidence ?? 60);

  // Map marketDNA
  const dna = result.marketDNA ?? {};
  const marketSpeed = result.market?.marketSpeed ?? "normal";
  const marketPressure = result.market?.marketPressure ?? "balanced";
  const demandMap: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
  const speedMap: Record<string, string> = { fast: "Fast", normal: "Normal", slow: "Slow" };
  const riskMap: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
  const trendMap: Record<string, string> = { up: "Up", flat: "Flat", down: "Down" };
  const pressureMap: Record<string, string> = {
    buyers: "Buyer's Market",
    sellers: "Seller's Market",
    balanced: "Balanced Market",
  };

  // Freshness
  const now = new Date().toISOString();
  const freshnessStatus = usedFallback
    ? ("Needs refresh" as const)
    : comps.length > 0
    ? ("Live" as const)
    : ("Needs refresh" as const);

  return {
    cardTitle,
    verdict: result.verdict ?? "Hold",
    action: result.action ?? "Hold",
    dealScore: result.dealScore ?? 50,
    quickSaleValue,
    fairMarketValue,
    premiumValue,
    explanation: result.explanationBullets?.length
      ? result.explanationBullets
      : ["Estimate based on available market data."],
    marketDNA: {
      demand: demandMap[dna.demand] ?? "Medium",
      speed: speedMap[marketSpeed] ?? "Normal",
      risk: riskMap[dna.risk] ?? "Medium",
      trend: trendMap[dna.trend] ?? "Flat",
      marketCondition: pressureMap[marketPressure] ?? "Balanced Market",
    },
    confidence: { pricingConfidence, liquidityConfidence, timingConfidence },
    exitStrategy: {
      recommendedMethod: result.exitStrategy?.recommendedMethod ?? "auction",
      expectedDaysToSell: result.exitStrategy?.expectedDaysToSell ?? null,
      timingRecommendation:
        result.exitStrategy?.timingRecommendation ?? "List when market activity increases.",
    },
    freshness: {
      status: freshnessStatus,
      lastUpdated: comps.length > 0 ? now : null,
    },
    pricingAnalytics: context.trendProjection
      ? {
          projectedNextSale: context.trendProjection.projectedPrice,
          trendSlope: context.trendProjection.slope,
          rSquared: context.trendProjection.rSquared,
          projectionConfidence: context.trendProjection.confidence,
          compPoolDebug: context.compPoolDebug ?? null,
        }
      : null,
    estimate: fairMarketValue,
    compsUsed: comps.length,
    source: comps.length > 0 ? "live" : "fallback",
  };
}

export async function compiqEstimate(req: Request, res: Response) {
  const data = await computeEstimate(req.body || {});
  res.json(data);
}
