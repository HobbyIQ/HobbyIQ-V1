// CF-IMAGE-SIMILARITY-LOOKUP (Drew, 2026-07-25). "Scan any card" —
// user uploads a photo, we compute its pHash, and find the closest
// matches in sold_comps (which back-references card_catalog + FMV).
//
// Uses the same dhash-v1 algorithm as the rest of the pHash pipeline
// (phashCompute.service). Compares by hamming distance against every
// pHashed row in sold_comps. For 2M+ hashes in memory, brute-force
// hamming is ~100ms — acceptable for interactive scan UX.
//
// Response returns top-K matches with each match's hobbyiqCardId,
// canonical identity, and current recent-median FMV so iOS can render
// "we think this is X, currently trading at $Y" without a second call.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeDhashFromBytes, computeDhashFromUrl, hammingHex } from "../attribution/phashCompute.service.js";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";

// POOL-1 residue (audit, 2026-09-03). The phash INDEX query below deliberately
// reads every row -- identity lookup wants all the evidence, adjudicated or
// not. The recentMedian ENRICHMENT is a price shown to a user, so it takes the
// filter. Same store-form predicate as exactPoolReader:84-85.
const ADJUDICATION_FILTER =
  "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)"
  + " AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)";

export interface ImageLookupInput {
  imageBase64?: string;       // "iVBORw0KGgoAAAA..." (raw base64, no data: prefix)
  imageUrl?: string;          // alternative — remote URL to fetch
  limit?: number;             // default 5, max 20
  maxHamming?: number;        // default 20 — reject matches worse than this
}

export interface ImageLookupHit {
  hobbyiqCardId: string;
  player: string | null;
  cardYear: number | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  hamming: number;
  matchConfidence: "exact" | "strong" | "likely" | "possible";  // hamming buckets
  recentMedian: number | null;
  imageUrl: string | null;    // representative image from matched row
  compCount: number;
}

export interface ImageLookupResult {
  algo: "dhash-v1";
  queryHash: string | null;
  hits: ImageLookupHit[];
  totalPhashedRows: number;
  computedAt: string;
  processingMs: number;
}

// In-memory index built lazily on first call, refreshed every N minutes.
// For 2M+ rows this stays under ~200MB (16-byte hex + slug + identity).
interface IndexRow { hash: string; slug: string; row: Record<string, unknown> }
let indexRows: IndexRow[] | null = null;
let indexBuiltAt = 0;
const INDEX_TTL_MS = 15 * 60 * 1000;

let cachedSold: Container | null = null;
async function getSoldContainer(): Promise<Container | null> {
  if (cachedSold) return cachedSold;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    cachedSold = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
    return cachedSold;
  } catch { return null; }
}

async function buildIndex(): Promise<IndexRow[]> {
  const container = await getSoldContainer();
  if (!container) return [];
  const rows: IndexRow[] = [];
  const q = "SELECT c.phash, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.imageUrl, c.price, c.soldAt FROM c WHERE IS_DEFINED(c.phash) AND c.phash != null";
  const it = container.items.query({ query: q }, { maxItemCount: 5000 });
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      if (!r.phash || !r.hobbyiqCardId) continue;
      rows.push({ hash: String(r.phash), slug: String(r.hobbyiqCardId), row: r });
    }
  }
  indexRows = rows;
  indexBuiltAt = Date.now();
  return rows;
}

async function getIndex(): Promise<IndexRow[]> {
  if (indexRows && Date.now() - indexBuiltAt < INDEX_TTL_MS) return indexRows;
  return await buildIndex();
}

function confidenceBucket(h: number): "exact" | "strong" | "likely" | "possible" {
  if (h <= 5) return "exact";
  if (h <= 10) return "strong";
  if (h <= 15) return "likely";
  return "possible";
}

export async function lookupByImage(input: ImageLookupInput): Promise<ImageLookupResult> {
  const t0 = Date.now();
  const empty: ImageLookupResult = {
    algo: "dhash-v1", queryHash: null, hits: [], totalPhashedRows: 0,
    computedAt: new Date().toISOString(), processingMs: 0,
  };
  const limit = Math.max(1, Math.min(20, input.limit ?? 5));
  const maxHamming = input.maxHamming ?? 20;

  // Compute query hash from either base64 blob or URL
  let queryHash: string | null = null;
  if (input.imageBase64) {
    try {
      const buf = Buffer.from(input.imageBase64.replace(/^data:image\/[^;]+;base64,/, ""), "base64");
      queryHash = await computeDhashFromBytes(buf);
    } catch { queryHash = null; }
  } else if (input.imageUrl) {
    const res = await computeDhashFromUrl(input.imageUrl, { timeoutMs: 10_000 });
    queryHash = res && "hash" in res ? res.hash : null;
  }
  if (!queryHash) return { ...empty, processingMs: Date.now() - t0 };

  const idx = await getIndex();
  if (idx.length === 0) return { ...empty, queryHash, processingMs: Date.now() - t0 };

  // Brute-force hamming. Keep top-K in a bucket sort — cheaper than
  // sorting all N matches when K << N.
  const buckets: IndexRow[][] = Array.from({ length: 65 }, () => []);
  for (const r of idx) {
    const h = hammingHex(queryHash, r.hash);
    if (h <= maxHamming) buckets[h].push(r);
  }

  const seenSlugs = new Set<string>();
  const hits: ImageLookupHit[] = [];
  outer: for (let dist = 0; dist <= maxHamming; dist++) {
    for (const r of buckets[dist]) {
      if (seenSlugs.has(r.slug)) continue;
      seenSlugs.add(r.slug);
      const row = r.row as Record<string, unknown>;
      const parsed = parseHobbyIqCardId(r.slug);
      hits.push({
        hobbyiqCardId: r.slug,
        player: (row.playerName as string) ?? null,
        cardYear: (row.cardYear as number) ?? parsed?.year ?? null,
        setName: (row.setName as string) ?? null,
        cardNumber: (row.cardNumber as string) ?? parsed?.cardNumber ?? null,
        parallel: (row.parallel as string) ?? null,
        isAuto: !!row.isAuto || parsed?.isAuto || false,
        hamming: dist,
        matchConfidence: confidenceBucket(dist),
        recentMedian: null,     // enriched next
        imageUrl: (row.imageUrl as string) ?? null,
        compCount: 0,
      });
      if (hits.length >= limit) break outer;
    }
  }

  // Enrich each hit with recentMedian + compCount from sold_comps
  const container = await getSoldContainer();
  if (container && hits.length > 0) {
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await Promise.all(hits.map(async (h) => {
      try {
        const { resources } = await container.items.query({
          query: `SELECT c.price FROM c WHERE c.hobbyiqCardId = @s AND c.soldAt >= @f AND ${ADJUDICATION_FILTER}`,
          parameters: [{ name: "@s", value: h.hobbyiqCardId }, { name: "@f", value: cutoff }],
        }).fetchAll();
        const prices = resources.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        h.compCount = prices.length;
        if (prices.length > 0) h.recentMedian = prices[Math.floor(prices.length / 2)];
      } catch { /* enrichment optional */ }
    }));
  }

  return {
    algo: "dhash-v1",
    queryHash,
    hits,
    totalPhashedRows: idx.length,
    computedAt: new Date().toISOString(),
    processingMs: Date.now() - t0,
  };
}
