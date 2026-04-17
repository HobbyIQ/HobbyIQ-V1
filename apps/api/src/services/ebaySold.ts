
// In-memory cache with TTL
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

export interface EbaySoldListing {
  title: string;
  price: number;
  date: string;
  url: string;
}

export interface EbaySoldStats {
  listings: EbaySoldListing[];
  weightedMedianFMV: number | null;
  compRange: { low: number | null; high: number | null };
  trend: number | null; // % change per week (recency-weighted)
  liquidity: number | null; // sales per week
}

// Helper: weighted median
function weightedMedian(values: number[], weights: number[]): number | null {
  if (!values.length) return null;
  const sorted = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);
  let total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const { v, w } of sorted) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return sorted[sorted.length - 1].v;
}

// Fetch recent eBay sold listings via Apify actor (replace with your actor endpoint/token)
async function fetchEbaySoldRaw(query: string): Promise<any[]> {
  // Example: Apify actor HTTP API
  const APIFY_ACTOR_URL = process.env.APIFY_EBAY_SOLD_URL;
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_ACTOR_URL || !APIFY_TOKEN) throw new Error('eBay sold API not configured');
  const url = `${APIFY_ACTOR_URL}?query=${encodeURIComponent(query)}`;
    // Add a timeout for slow responses (8s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('Failed to fetch eBay sold data');
      const data = await res.json();
      return data.results || data || [];
    } catch (e) {
      clearTimeout(timeout);
      throw new Error('Sold data service unavailable or slow.');
    }
}

// Normalize and compute stats
export async function getEbaySoldStats(query: string): Promise<EbaySoldStats> {
  const cacheKey = query.toLowerCase().trim();
  const now = Date.now();
  if (cache.has(cacheKey)) {
    const { data, expires } = cache.get(cacheKey)!;
    if (now < expires) return data;
    cache.delete(cacheKey);
  }
  let raw: any[] = [];
  try {
    raw = await fetchEbaySoldRaw(query);
  } catch (e) {
    return { listings: [], weightedMedianFMV: null, compRange: { low: null, high: null }, trend: null, liquidity: null };
  }
  // Normalize
  function isEbaySoldListing(x: any): x is EbaySoldListing {
    return x && typeof x.title === 'string' && typeof x.price === 'number' && typeof x.date === 'string' && typeof x.url === 'string';
  }
  // Helper to filter out messy titles (customize as needed)
  function isMessyTitle(title: string): boolean {
    // Example: filter out titles with 'lot', 'damaged', or 'junk'
    return /lot|damaged|junk/i.test(title);
  }
  // Normalize and filter messy titles
  let listings: EbaySoldListing[] = raw
    .map((item: any) => {
      const price = typeof item.price === 'number' ? item.price : parseFloat(item.price?.replace(/[^\d.]/g, ''));
      const date = item.dateSold || item.date || item.soldDate;
      return price && date && item.title ? {
        title: item.title,
        price,
        date: new Date(date).toISOString(),
        url: item.url || item.link || ''
      } : null;
    })
    .filter(isEbaySoldListing)
    .filter(l => !isMessyTitle(l.title));
  // Remove price outliers (1.5x IQR)
  if (listings.length > 4) {
    const prices = listings.map(l => l.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const iqr = q3 - q1;
    const min = q1 - 1.5 * iqr;
    const max = q3 + 1.5 * iqr;
    listings = listings.filter(l => l.price >= min && l.price <= max);
  }
  if (!listings.length) {
    cache.set(cacheKey, { data: { listings, weightedMedianFMV: null, compRange: { low: null, high: null }, trend: null, liquidity: null }, expires: now + CACHE_TTL_MS });
    return { listings, weightedMedianFMV: null, compRange: { low: null, high: null }, trend: null, liquidity: null };
  }
  if (!listings.length) {
    cache.set(cacheKey, { data: { listings, weightedMedianFMV: null, compRange: { low: null, high: null }, trend: null, liquidity: null }, expires: now + CACHE_TTL_MS });
    return { listings, weightedMedianFMV: null, compRange: { low: null, high: null }, trend: null, liquidity: null };
  }
  // Sort by date desc
  listings.sort((a, b) => b.date.localeCompare(a.date));
  // Price stats
  const prices = listings.map(l => l.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  // Recency weights (last 30 days, more recent = higher weight)
  const nowDate = Date.now();
  const weights = listings.map(l => {
    const daysAgo = (nowDate - new Date(l.date).getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0.1, 30 - daysAgo); // 0.1 minimum
  });
  // Weighted median FMV
  const weightedMedianFMV = weightedMedian(prices, weights);
  // Trend: fit a line to price vs. date (recency-weighted)
  let trend: number | null = null;
  if (listings.length > 3) {
    const xs = listings.map(l => (nowDate - new Date(l.date).getTime()) / (1000 * 60 * 60 * 24));
    const ys = prices;
    // Weighted linear regression (daysAgo vs price)
    const sumW = weights.reduce((a, b) => a + b, 0);
    const meanX = xs.reduce((a, b, i) => a + b * weights[i], 0) / sumW;
    const meanY = ys.reduce((a, b, i) => a + b * weights[i], 0) / sumW;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += weights[i] * (xs[i] - meanX) * (ys[i] - meanY);
      den += weights[i] * (xs[i] - meanX) ** 2;
    }
    const slope = den ? num / den : 0;
    // Convert to % change per week (7 days)
    trend = slope ? (slope * 7) / meanY * 100 : 0;
  }
  // Liquidity: sales per week (last 30 days)
  const thirtyDaysAgo = nowDate - 30 * 24 * 60 * 60 * 1000;
  const salesLast30 = listings.filter(l => new Date(l.date).getTime() > thirtyDaysAgo).length;
  const liquidity = salesLast30 / 4; // per week
  const stats: EbaySoldStats = {
    listings,
    weightedMedianFMV,
    compRange: { low, high },
    trend,
    liquidity
  };
  cache.set(cacheKey, { data: stats, expires: now + CACHE_TTL_MS });
  return stats;
}
