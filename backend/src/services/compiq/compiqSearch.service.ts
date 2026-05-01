/**
 * CompIQ Search Service
 * Fetches eBay sold listings via Apify, then runs the pricing model
 * to produce entry / fair / premium price tiers for a card query.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SoldComp {
  title: string;
  price: number;
  soldDate: string;
}

interface PricingResult {
  estimatedFMV: number;
  scarcityScore: number;
  confidence: "High" | "Medium" | "Low";
}

export interface CardSearchResult {
  success: boolean;
  query: string;
  summary: string;
  marketTier: { entry: number; fair: number; premium: number };
  buyZone: [number, number];
  holdZone: [number, number];
  sellZone: [number, number];
  recentComps: SoldComp[];
  supply: {
    activeListings: number | null;
    trend2w: null;
    trend4w: null;
    trend3m: null;
  };
  confidence: number;
  source: "live" | "mock";
  meta?: { timestamp: string };
}

// ---------------------------------------------------------------------------
// Apify / eBay fetch
// ---------------------------------------------------------------------------

async function fetchEbaySoldData(query: string): Promise<SoldComp[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.warn("[compiqSearch] APIFY_TOKEN not set — skipping live fetch");
    return [];
  }

  const url =
    "https://api.apify.com/v2/acts/caffein~ebay-sold-listings/run-sync-get-dataset-items" +
    `?token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, maxResults: 20 }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      console.warn(`[compiqSearch] Apify responded ${res.status}`);
      return [];
    }

    const items: unknown[] = await res.json();
    if (!Array.isArray(items)) return [];

    return items
      .map((item: any) => {
        const price = Number(item.price);
        return isNaN(price) || price <= 0
          ? null
          : {
              title: String(item.title || ""),
              price,
              soldDate: String(item.soldDate || ""),
            };
      })
      .filter((x): x is SoldComp => x !== null);
  } catch (err) {
    console.warn("[compiqSearch] Apify fetch failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pricing model (ported from services/pricing.js)
// ---------------------------------------------------------------------------

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

function calculatePricing(
  medianPrice: number,
  salesCount: number,
  activeListings: number
): PricingResult {
  const sales30d = salesCount;
  const liquidityRatio = sales30d / Math.max(activeListings, 1);

  let liquidityBoost = 1;
  if (liquidityRatio > 2) liquidityBoost = 1.15;
  else if (liquidityRatio > 1) liquidityBoost = 1.08;
  else if (liquidityRatio < 0.5) liquidityBoost = 0.9;

  let supplyPenalty = 1;
  if (activeListings > 20) supplyPenalty = 0.8;
  else if (activeListings > 10) supplyPenalty = 0.9;

  const estimatedFMV = Math.round(
    medianPrice * liquidityBoost * supplyPenalty
  );

  let scarcityScore =
    100 - activeListings * 2 + liquidityRatio * 10;
  scarcityScore = clamp(Math.round(scarcityScore), 10, 100);

  let confidence: PricingResult["confidence"] = "Low";
  if (sales30d > 10) confidence = "High";
  else if (sales30d > 4) confidence = "Medium";

  return { estimatedFMV, scarcityScore, confidence };
}

function getMedianPrice(items: SoldComp[]): number {
  const prices = items.map((i) => i.price).sort((a, b) => a - b);
  if (!prices.length) return 0;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2
    ? prices[mid]
    : (prices[mid - 1] + prices[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function searchAndPrice(query: string): Promise<CardSearchResult> {
  const comps = await fetchEbaySoldData(query);
  const source: "live" | "mock" = comps.length > 0 ? "live" : "mock";

  // Fall back to illustrative numbers when Apify is unavailable
  const medianPrice = comps.length > 0 ? getMedianPrice(comps) : 0;
  const activeListings = comps.length;

  let entry: number;
  let fair: number;
  let premium: number;
  let confidenceNum: number;
  let summary: string;

  if (medianPrice > 0) {
    const pricing = calculatePricing(medianPrice, comps.length, activeListings);
    fair = pricing.estimatedFMV;
    entry = Math.round(fair * 0.85);
    premium = Math.round(fair * 1.18);

    const confMap: Record<string, number> = { High: 0.85, Medium: 0.65, Low: 0.45 };
    confidenceNum = confMap[pricing.confidence] ?? 0.55;

    summary =
      `Based on ${comps.length} recent eBay sold listing${comps.length !== 1 ? "s" : ""}, ` +
      `the fair market value is around $${fair}. ` +
      `Confidence: ${pricing.confidence.toLowerCase()}.`;
  } else {
    // No live data — return a clearly marked no-data response
    entry = 0;
    fair = 0;
    premium = 0;
    confidenceNum = 0;
    summary = "No recent eBay sales found for this query. Try a more specific search.";
  }

  return {
    success: true,
    query,
    summary,
    marketTier: { entry, fair, premium },
    buyZone: [Math.round(entry * 0.9), entry],
    holdZone: [entry, fair],
    sellZone: [fair, premium],
    recentComps: comps.slice(0, 10),
    supply: {
      activeListings: activeListings || null,
      trend2w: null,
      trend4w: null,
      trend3m: null,
    },
    confidence: confidenceNum,
    source,
    meta: { timestamp: new Date().toISOString() },
  };
}
