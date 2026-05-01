/**
 * Live search + pricing via Apify eBay sold listings actor.
 */

export interface SoldComp {
  price: number;
  title: string;
  date: string;
  url: string;
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
  supply: { activeListings: null; trend2w: null; trend4w: null; trend3m: null };
  confidence: number;
  source: "live" | "mock";
}

function getMedianPrice(items: SoldComp[]): number {
  if (!items.length) return 0;
  const sorted = [...items].map((i) => i.price).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function calculatePricing(
  medianPrice: number,
  salesCount: number,
  activeListings: number,
): { estimatedFMV: number; scarcityScore: number; confidence: "High" | "Medium" | "Low" } {
  let liquidityMultiplier = 1.0;
  if (salesCount >= 10) liquidityMultiplier = 1.15;
  else if (salesCount >= 5) liquidityMultiplier = 1.08;
  else if (salesCount <= 1) liquidityMultiplier = 0.9;

  let supplyPenalty = 1.0;
  if (activeListings >= 20) supplyPenalty = 0.8;
  else if (activeListings >= 10) supplyPenalty = 0.9;

  const fmv = medianPrice * liquidityMultiplier * supplyPenalty;
  const scarcityScore = Math.max(0, Math.min(100, 100 - activeListings * 2));

  let confidence: "High" | "Medium" | "Low" = "Low";
  if (salesCount >= 10) confidence = "High";
  else if (salesCount >= 5) confidence = "Medium";

  return { estimatedFMV: fmv, scarcityScore, confidence };
}

async function fetchEbaySoldData(query: string): Promise<SoldComp[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.warn("[compiqSearch] APIFY_TOKEN not set — skipping live fetch");
    return [];
  }

  try {
    const url =
      "https://api.apify.com/v2/acts/caffein~ebay-sold-listings/run-sync-get-dataset-items" +
      `?token=${token}&timeout=25&memory=256`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, maxItems: 30, country: "US" }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.warn(`[compiqSearch] Apify responded ${res.status}`);
      return [];
    }

    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return [];

    return data
      .filter((item) => item && typeof item.price === "number" && (item.price as number) > 0)
      .map((item) => ({
        price: item.price as number,
        title: (item.title as string) || "",
        date: (item.soldDate as string) || (item.date as string) || "",
        url: (item.url as string) || "",
      }));
  } catch (err) {
    console.warn("[compiqSearch] Apify fetch failed:", (err as Error).message);
    return [];
  }
}

export async function searchAndPrice(query: string): Promise<CardSearchResult> {
  const comps = await fetchEbaySoldData(query);
  const salesCount = comps.length;
  const medianPrice = getMedianPrice(comps);

  const { estimatedFMV, confidence } = calculatePricing(medianPrice, salesCount, 0);
  const confidenceNum = confidence === "High" ? 0.85 : confidence === "Medium" ? 0.65 : 0.4;

  if (salesCount === 0 || medianPrice === 0) {
    return {
      success: true,
      query,
      summary: "No recent eBay sales found for this query. Try a more specific search.",
      marketTier: { entry: 0, fair: 0, premium: 0 },
      buyZone: [0, 0],
      holdZone: [0, 0],
      sellZone: [0, 0],
      recentComps: [],
      supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
      confidence: 0,
      source: "live",
    };
  }

  const entry = parseFloat((estimatedFMV * 0.8).toFixed(2));
  const fair = parseFloat(estimatedFMV.toFixed(2));
  const premium = parseFloat((estimatedFMV * 1.25).toFixed(2));

  const summary =
    `Based on ${salesCount} recent eBay sold listing${salesCount !== 1 ? "s" : ""}, ` +
    `median price $${medianPrice.toFixed(2)}. ` +
    `Est. FMV $${fair}. Confidence: ${confidence}.`;

  return {
    success: true,
    query,
    summary,
    marketTier: { entry, fair, premium },
    buyZone: [parseFloat((entry * 0.9).toFixed(2)), parseFloat((entry * 1.05).toFixed(2))],
    holdZone: [parseFloat((fair * 0.95).toFixed(2)), parseFloat((fair * 1.1).toFixed(2))],
    sellZone: [parseFloat((premium * 0.95).toFixed(2)), parseFloat((premium * 1.2).toFixed(2))],
    recentComps: comps.slice(0, 10),
    supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
    confidence: confidenceNum,
    source: "live",
  };
}
