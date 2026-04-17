import { CompIQFetchParams, CompIQSoldListing } from "./types";

// Build Apify API URL for eBay sold data (dataset endpoint)
function buildApifyDatasetUrl(params: CompIQFetchParams): string {
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN;
  const APIFY_DATASET_ID = process.env.APIFY_DATASET_ID;
  if (!APIFY_API_TOKEN) {
    throw new Error("Missing APIFY_API_TOKEN or APIFY_TOKEN in environment variables");
  }
  if (!APIFY_DATASET_ID) {
    throw new Error("Missing APIFY_DATASET_ID in environment variables. Please set it in your .env file.");
  }
  const base = `https://api.apify.com/v2/datasets/${APIFY_DATASET_ID}/items`;
  const query: Record<string, string> = {
    token: APIFY_API_TOKEN,
    clean: "true",
    desc: "1",
    limit: String(params.maxResults || 40)
  };
  const q = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${base}?${q}`;
}


// --- Helper: Extract grade from title ---
function extractGrade(title: string): string | null {
  const match = title.match(/(PSA ?10|PSA ?9|BGS ?9\.5|BGS ?10|SGC ?10|SGC ?9|CGC ?10|CGC ?9|CGA ?10|CGA ?9|BVG ?10|BVG ?9|CSG ?10|CSG ?9)/i);
  return match ? match[1].replace(/\s+/g, " ").toUpperCase() : null;
}

// --- Helper: Extract parallel from title ---
function extractParallel(title: string): string {
  const lower = title.toLowerCase();
  if (/superfractor/.test(lower)) return "superfractor";
  if (/red/.test(lower)) return "red";
  if (/orange/.test(lower)) return "orange";
  if (/gold/.test(lower)) return "gold";
  if (/blue/.test(lower)) return "blue";
  if (/green/.test(lower)) return "green";
  if (/purple/.test(lower)) return "purple";
  if (/refractor/.test(lower)) return "refractor";
  if (/base/.test(lower)) return "base";
  return "other";
}

// --- Helper: Parse price safely ---
function parsePrice(price: any): number {
  if (typeof price === "number") return price;
  if (typeof price === "string") {
    const cleaned = price.replace(/[^\d.]/g, "");
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

// --- Main CompIQ ingestion function ---
export async function fetchSoldListingsFromApify(params: CompIQFetchParams): Promise<CompIQSoldListing[]> {
  // 1. Build query tokens
  const queryTokens = [
    params.player,
    params.set,
    params.parallel,
    params.isAuto ? "auto" : "",
    params.serial
  ].filter(Boolean).map(s => String(s).toLowerCase());

  // 2. Build URL
  const url = buildApifyDatasetUrl(params);
  console.log("CompIQ Request:", {
    query: queryTokens.join(" "),
    datasetId: APIFY_DATASET_ID
  });

  // 3. Fetch
  const res = await fetch(url);
  console.log(`[CompIQ] Apify response status: ${res.status}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error("DATASET_ERROR: Apify dataset not found or not ready");
    throw new Error(`FETCH_ERROR: Apify fetch failed: ${res.status}`);
  }
  let data: any[];
  try {
    data = await res.json();
  } catch (e) {
    console.error('[CompIQ] Failed to parse Apify response as JSON');
    throw new Error('Malformed Apify response');
  }
  if (!Array.isArray(data)) {
    console.warn('[CompIQ] Apify response is not an array');
    return [];
  }

  // 4. Filter by query tokens
  const filtered = data.filter(item => {
    const t = (item.title || '').toLowerCase();
    return queryTokens.every(q => t && t.includes(q));
  });

  // 5. Normalize
  const normalized: CompIQSoldListing[] = filtered.map(item => ({
    title: item.title,
    price: parsePrice(item.price || item.soldPrice),
    date: item.date ? new Date(item.date) : (item.soldDate ? new Date(item.soldDate) : null),
    grade: extractGrade(item.title),
    isAuto: item.title ? item.title.toLowerCase().includes("auto") : false,
    parallel: extractParallel(item.title),
    raw: item
  }));

  // 6. Logging
  console.log("CompIQ Results:", {
    count: normalized.length,
    sample: normalized.slice(0, 2)
  });

  return normalized;
}
