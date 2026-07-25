// CF-CANONICAL-CARD-SEARCH (Drew, 2026-07-24). Free-text card search
// over card_catalog. Handles queries like "hartman blue auto bowman" —
// pulls semantic hints out (auto flag, year), matches the rest across
// (player, releaseName, cardNumber, parallels[].name), scores by token
// overlap + field specificity, dedups by canonical identity, enriches
// each result with the most-recent sale image + FMV median.
//
// Ships as POST /api/compiq/search.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeHobbyIqCardId } from "./hobbyIqCardId.service.js";

export interface CanonicalSearchInput {
  q: string;
  sport?: string;
  limit?: number;
}

export interface CanonicalSearchHit {
  hobbyiqCardId: string | null;   // computed if identity fields are complete
  player: string | null;
  releaseName: string | null;
  cardYear: number | null;
  cardNumber: string | null;
  parallels: Array<{ id: string; name: string; numberedTo: number | null }>;
  isAutographSet: boolean;
  sport: string;
  imageUrl: string | null;         // from most-recent sale (sold_comps)
  recentMedian: number | null;     // 90-day median (sold_comps)
  compCount: number;               // 90-day comp count
  matchedTokens: string[];
  score: number;
}

export interface CanonicalSearchResult {
  q: string;
  tokens: string[];
  semanticFilters: {
    isAuto: boolean | null;
    year: number | null;
  };
  hits: CanonicalSearchHit[];
  totalCandidates: number;
  computedAt: string;
}

let cachedCatalog: Container | null = null;
let cachedSold: Container | null = null;
async function getContainers(): Promise<{ catalog: Container; sold: Container } | null> {
  if (cachedCatalog && cachedSold) return { catalog: cachedCatalog, sold: cachedSold };
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedCatalog = db.container("card_catalog");
    cachedSold = db.container("sold_comps");
    return { catalog: cachedCatalog, sold: cachedSold };
  } catch { return null; }
}

const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "on", "with", "for", "to", "and", "or", "card", "cards", "baseball", "basketball", "football", "hockey"]);
const AUTO_TOKENS = new Set(["auto", "autograph", "autographed", "autos"]);

function tokenize(q: string): string[] {
  return String(q ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s#-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/** Levenshtein distance — small, no deps. Used for fuzzy fallback when
 *  strict CONTAINS returns no candidates. Only computed on <500 sampled
 *  candidates so it stays cheap. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** Fuzzy substring check: does `haystack` contain any word within edit
 *  distance 1 of `needle`? Short needles (<= 3 chars) require exact
 *  substring to avoid noise. */
function fuzzyContains(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  if (needle.length <= 3) return false;
  // Scan word-tokens in haystack for edit-distance-1 match
  const maxDist = needle.length >= 6 ? 2 : 1;
  const words = haystack.split(/[\s\-]+/).filter((w) => w.length >= needle.length - maxDist);
  for (const w of words) {
    if (Math.abs(w.length - needle.length) > maxDist) continue;
    if (levenshtein(w, needle) <= maxDist) return true;
  }
  return false;
}

export async function canonicalCardSearch(input: CanonicalSearchInput): Promise<CanonicalSearchResult> {
  const q = String(input.q ?? "").trim();
  const now = new Date();
  const empty: CanonicalSearchResult = {
    q, tokens: [], semanticFilters: { isAuto: null, year: null },
    hits: [], totalCandidates: 0, computedAt: now.toISOString(),
  };
  if (!q) return empty;

  const containers = await getContainers();
  if (!containers) return empty;

  const rawTokens = tokenize(q);
  if (rawTokens.length === 0) return empty;

  // Extract semantic hints
  let isAutoFilter: boolean | null = null;
  let yearFilter: number | null = null;
  const searchTokens: string[] = [];
  for (const t of rawTokens) {
    if (AUTO_TOKENS.has(t)) { isAutoFilter = true; continue; }
    const y = Number(t);
    if (Number.isFinite(y) && y >= 1980 && y <= 2030) { yearFilter = y; continue; }
    searchTokens.push(t);
  }

  if (searchTokens.length === 0 && (isAutoFilter === null && yearFilter === null)) return empty;

  // Build query. Uses the precomputed searchText field (case-insensitive
  // CONTAINS on ONE lowercase field) instead of a 4-field OR — 10x faster
  // on cross-partition scans. Falls back to the multi-field query when
  // searchText hasn't been backfilled yet.
  const sport = String(input.sport ?? "baseball").toLowerCase();
  const params: Array<{ name: string; value: string | number | boolean }> = [
    { name: "@sport", value: sport },
    { name: "@src", value: "cardsight" },
  ];
  const whereClauses: string[] = ["c.source = @src", "c.sport = @sport"];
  if (yearFilter !== null) {
    whereClauses.push("c.year = @year");
    params.push({ name: "@year", value: String(yearFilter) });
  }
  searchTokens.forEach((t, i) => {
    const p = `@t${i}`;
    // searchText is precomputed lowercase concat of (player, releaseName,
    // setName, number, year, parallels[].name, attributes). Fallback OR
    // handles rows the backfill hasn't reached yet.
    whereClauses.push(
      `((IS_DEFINED(c.searchText) AND CONTAINS(c.searchText, ${p})) OR ` +
      `(NOT IS_DEFINED(c.searchText) AND (CONTAINS(LOWER(c.player), ${p}, true) OR CONTAINS(LOWER(c.releaseName), ${p}, true) OR CONTAINS(LOWER(c.number), ${p}, true) OR EXISTS(SELECT VALUE 1 FROM par IN c.parallels WHERE CONTAINS(LOWER(par.name), ${p}, true)))))`,
    );
    params.push({ name: p, value: t });
  });
  if (isAutoFilter === true) {
    whereClauses.push(
      "(CONTAINS(LOWER(c.setName), 'auto', true) OR CONTAINS(LOWER(c.releaseName), 'auto', true))",
    );
  }

  const query = `SELECT TOP 200 c.cardId, c.player, c.releaseId, c.releaseName, c.setName, c.year, c.number, c.parallels, c.attributes, c.sport, c.recentSaleCount, c.searchText
                 FROM c WHERE ${whereClauses.join(" AND ")}`;
  let candidates: any[] = [];
  try {
    const { resources } = await containers.catalog.items.query({ query, parameters: params }).fetchAll();
    candidates = resources || [];
  } catch { candidates = []; }

  // Fuzzy fallback — if strict CONTAINS returned nothing, try Levenshtein
  // on the searchText field with tokens allowed 1-char typos. Sampled
  // (TOP 500) since fuzzy is O(N) in JS.
  if (candidates.length === 0 && searchTokens.length > 0) {
    try {
      const sampleQ = `SELECT TOP 500 c.cardId, c.player, c.releaseId, c.releaseName, c.setName, c.year, c.number, c.parallels, c.attributes, c.sport, c.recentSaleCount, c.searchText FROM c WHERE c.source = 'cardsight' AND c.sport = @sport${yearFilter !== null ? " AND c.year = @year" : ""} AND IS_DEFINED(c.searchText)`;
      const sampleParams = [{ name: "@sport", value: sport }];
      if (yearFilter !== null) sampleParams.push({ name: "@year", value: String(yearFilter) });
      const { resources: sample } = await containers.catalog.items.query({ query: sampleQ, parameters: sampleParams }).fetchAll();
      candidates = (sample || []).filter((c: any) => {
        const st = String(c.searchText || "");
        // Every token must have a fuzzy hit within edit distance 1
        return searchTokens.every((t) => fuzzyContains(st, t));
      });
    } catch { candidates = []; }
  }

  if (candidates.length === 0) return { ...empty, tokens: rawTokens, semanticFilters: { isAuto: isAutoFilter, year: yearFilter } };

  // Score each candidate
  const scored: CanonicalSearchHit[] = candidates.map((c) => {
    const player = c.player ? String(c.player).toLowerCase() : "";
    const releaseName = c.releaseName ? String(c.releaseName).toLowerCase() : "";
    const number = c.number ? String(c.number).toLowerCase() : "";
    const parallelNames = Array.isArray(c.parallels) ? c.parallels.map((p: any) => String(p?.name ?? "").toLowerCase()) : [];

    const matched: string[] = [];
    let scoreBase = 0;
    for (const t of searchTokens) {
      let matchedThis = false;
      if (player.includes(t)) { matched.push(t); scoreBase += 4; matchedThis = true; }        // player match — strongest
      else if (parallelNames.some((n: string) => n.includes(t))) { matched.push(t); scoreBase += 3; matchedThis = true; }
      else if (releaseName.includes(t)) { matched.push(t); scoreBase += 2; matchedThis = true; }
      else if (number.includes(t)) { matched.push(t); scoreBase += 1; matchedThis = true; }
      // Fuzzy fallback — if strict match missed but the searchText was
      // built for this card, allow edit-distance-1 as a partial credit.
      else if (c.searchText && fuzzyContains(String(c.searchText), t)) { matched.push(t); scoreBase += 0.5; matchedThis = true; }
      if (!matchedThis) { /* unmatched token */ }
    }
    // Popularity boost — hot cards surface first. log1p(recentSaleCount)
    // gives diminishing returns so a mega-hot card doesn't fully drown a
    // niche card that matches the query more precisely.
    const popularity = Math.log1p(Number(c.recentSaleCount || 0));
    const finalScore = scoreBase * (1 + popularity / 5);
    const yearNum = Number(c.year);
    const cardYear = Number.isFinite(yearNum) ? yearNum : null;
    const isAutographSet = /auto/i.test(String(c.setName ?? "") + " " + String(c.releaseName ?? ""));
    let hobbyiqCardId: string | null = null;
    try {
      if (cardYear && c.number && c.releaseName) {
        hobbyiqCardId = computeHobbyIqCardId({
          sport: c.sport || "baseball",
          year: cardYear,
          setKey: c.releaseName,
          cardNumber: c.number,
          parallel: "Base",
          isAuto: isAutographSet,
          printRun: null,
        });
      }
    } catch { hobbyiqCardId = null; }

    return {
      hobbyiqCardId,
      player: c.player ?? null,
      releaseName: c.releaseName ?? null,
      cardYear,
      cardNumber: c.number ?? null,
      parallels: (c.parallels || []).map((p: any) => ({ id: p.id, name: p.name, numberedTo: p.numberedTo ?? null })),
      isAutographSet,
      sport: c.sport || "baseball",
      imageUrl: null,
      recentMedian: null,
      compCount: 0,
      matchedTokens: matched,
      score: finalScore,
    };
  });

  // Only keep hits that match ALL search tokens (AND semantics)
  const requiredCount = searchTokens.length;
  const filtered = scored.filter((h) => h.matchedTokens.length >= requiredCount);

  // Dedup by hobbyiqCardId — keep highest-scoring per canonical identity
  const byCanonical = new Map<string, CanonicalSearchHit>();
  for (const h of filtered) {
    const key = h.hobbyiqCardId ?? `${h.releaseName}::${h.cardNumber}::${h.player}`;
    const existing = byCanonical.get(key);
    if (!existing || h.score > existing.score) byCanonical.set(key, h);
  }
  const deduped = [...byCanonical.values()].sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const topHits = deduped.slice(0, limit);

  // Enrich top hits with imageUrl + recent median from sold_comps
  await Promise.all(topHits.map(async (h) => {
    if (!h.hobbyiqCardId) return;
    try {
      const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
      const { resources: rows } = await containers.sold.items.query({
        query: "SELECT TOP 30 c.price, c.imageUrl, c.soldAt FROM c WHERE c.hobbyiqCardId = @slug AND c.soldAt >= @from ORDER BY c.soldAt DESC",
        parameters: [{ name: "@slug", value: h.hobbyiqCardId }, { name: "@from", value: cutoff }],
      }).fetchAll();
      if (rows.length > 0) {
        for (const r of rows) {
          if (r.imageUrl && !h.imageUrl) { h.imageUrl = r.imageUrl; break; }
        }
        const prices = rows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        if (prices.length > 0) h.recentMedian = prices[Math.floor(prices.length / 2)];
        h.compCount = prices.length;
      }
    } catch { /* enrichment optional */ }
  }));

  return {
    q, tokens: rawTokens, semanticFilters: { isAuto: isAutoFilter, year: yearFilter },
    hits: topHits, totalCandidates: candidates.length, computedAt: now.toISOString(),
  };
}
