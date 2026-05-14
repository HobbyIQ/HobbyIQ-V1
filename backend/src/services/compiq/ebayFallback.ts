// ---------------------------------------------------------------------------
// ebayFallback.ts
//
// When Card Hedge has zero or thin comps for a card_id, we still need a
// signal. This module pulls eBay sold listings via Apify (already used by
// compiqSearch.service.ts) and converts them into `NeighborComp[]` so the
// existing neighbor-synthesis engine can reprice from real market sales.
//
// Returns up to `maxResults` sold listings from the last `daysBack` window,
// filtered to non-trivial sales (>$5) with valid sold dates.
// ---------------------------------------------------------------------------

import type { NeighborComp } from "./neighborSynthesis.js";

const APIFY_ENDPOINT =
  "https://api.apify.com/v2/acts/caffein~ebay-sold-listings/run-sync-get-dataset-items";

export interface EbayFallbackOptions {
  /** How many days back from today to include sales. Default 60. */
  daysBack?: number;
  /** Maximum number of comps to fetch from Apify. Default 30. */
  maxResults?: number;
  /** Minimum sale price (drops outliers like lot-of-100 base cards). Default 5. */
  minPrice?: number;
}

/**
 * Fetch eBay sold-listing comps for a free-text query (player + variant tokens
 * work well). Returns [] when APIFY_TOKEN is missing or the call fails — the
 * caller falls back to Card Hedge / neighbor synthesis as before, so a bad
 * Apify outage never blocks a price prediction.
 */
export async function fetchEbayNeighborComps(
  query: string,
  opts: EbayFallbackOptions = {}
): Promise<NeighborComp[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.warn("[ebayFallback] APIFY_TOKEN not set — skipping eBay fallback");
    return [];
  }

  const daysBack = opts.daysBack ?? 60;
  const maxResults = opts.maxResults ?? 30;
  const minPrice = opts.minPrice ?? 5;

  const url = `${APIFY_ENDPOINT}?token=${encodeURIComponent(token)}`;
  let items: unknown[] = [];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, maxResults }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn(`[ebayFallback] Apify responded ${res.status} for query="${query}"`);
      return [];
    }
    const parsed = await res.json();
    items = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[ebayFallback] Apify fetch failed for query="${query}":`, (err as Error).message);
    return [];
  }

  const cutoffMs = Date.now() - daysBack * 24 * 3600 * 1000;
  const out: NeighborComp[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < minPrice) continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const soldDateRaw = typeof item.soldDate === "string" ? item.soldDate : "";
    const soldTs = Date.parse(soldDateRaw);
    // Allow comps without a parseable date (some Apify rows omit it), but
    // require all dated comps to fall inside the recency window.
    if (Number.isFinite(soldTs) && soldTs < cutoffMs) continue;
    out.push({ title, price, soldDate: soldDateRaw || undefined });
  }
  console.log(
    `[ebayFallback] query="${query}" fetched=${items.length} kept=${out.length} daysBack=${daysBack}`
  );
  return out;
}
