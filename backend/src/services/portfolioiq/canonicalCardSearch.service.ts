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

  // Build query. Every search token must match at least one field.
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
    whereClauses.push(
      `(CONTAINS(LOWER(c.player), ${p}, true) OR CONTAINS(LOWER(c.releaseName), ${p}, true) OR CONTAINS(LOWER(c.number), ${p}, true) OR EXISTS(SELECT VALUE 1 FROM par IN c.parallels WHERE CONTAINS(LOWER(par.name), ${p}, true)))`,
    );
    params.push({ name: p, value: t });
  });
  if (isAutoFilter === true) {
    // Autograph subsets show up in setName or releaseName as "Auto…" or via cardNumber prefix.
    whereClauses.push(
      "(CONTAINS(LOWER(c.setName), 'auto', true) OR CONTAINS(LOWER(c.releaseName), 'auto', true))",
    );
  }

  const query = `SELECT TOP 200 c.cardId, c.player, c.releaseId, c.releaseName, c.setName, c.year, c.number, c.parallels, c.attributes, c.sport
                 FROM c WHERE ${whereClauses.join(" AND ")}`;
  let candidates: any[] = [];
  try {
    const { resources } = await containers.catalog.items.query({ query, parameters: params }).fetchAll();
    candidates = resources || [];
  } catch { candidates = []; }

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
      if (!matchedThis) { /* token unmatched — penalize? we already filtered on match, so shouldn't happen */ }
    }
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
      score: scoreBase,
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
