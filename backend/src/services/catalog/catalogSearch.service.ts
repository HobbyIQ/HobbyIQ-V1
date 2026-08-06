/**
 * CF-CATALOG-FIRST — search (Drew, 2026-08-04).
 *
 * "When they add cards, they search within the catalog and then the
 * comps fall into it too."
 *
 * Direct query against card_catalog by canonical fields + searchTokens.
 * Returns a candidate list with the pre-computed salesSummary attached
 * (populated by attach-sales-summary-to-catalog.ts) so a UI renders
 * trends instantly.
 *
 * Contrast with the legacy unified search (dispatcher.ts) which fans
 * out to vendors first. This service is the "our data first" path:
 *   1. Tokenize the input.
 *   2. Match against catalog searchTokens + player + cardNumber.
 *   3. Score by token overlap.
 *   4. Return top N with salesSummary attached.
 *
 * A downstream fallback to vendor search is the caller's choice.
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

let _container: Container | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn).database(COSMOS_DATABASE).container(CATALOG_CONTAINER);
    return _container;
  } catch { return null; }
}

export interface CatalogSearchInput {
  query: string;              // freetext user input
  limit?: number;             // default 25
  sport?: string | null;
  year?: number | null;
  isAuto?: boolean | null;
}

export interface CatalogSearchHit {
  slug: string;               // canonical hobbyiqCardId
  cardNumber: string | null;
  playerName: string | null;
  sport: string | null;
  year: number | null;
  setKey: string | null;
  setName: string | null;
  parallel: string | null;
  isAuto: boolean;
  printRun: number | null;
  score: number;              // 0-1 token overlap
  salesSummary: {
    count: number;
    firstSaleAt: string | null;
    lastSaleAt: string | null;
    median30d: number | null;
    median90d: number | null;
    median180d: number | null;
    medianAll: number | null;
    trendDirection: "up" | "down" | "flat";
    trendPct30dVs90d: number | null;
    updatedAt: string;
  } | null;
}

export interface CatalogSearchResponse {
  hits: CatalogSearchHit[];
  totalCandidatesScanned: number;
  query: string;
  tokensUsed: string[];
}

function tokenize(input: string): string[] {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 30);
}

/** Direct catalog search. Returns hits sorted by token-overlap score
 *  descending, then by sales volume as tiebreaker. */
export async function searchCatalog(
  input: CatalogSearchInput,
): Promise<CatalogSearchResponse> {
  const query = String(input.query ?? "").trim();
  const limit = Math.max(1, Math.min(100, input.limit ?? 25));
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return { hits: [], totalCandidatesScanned: 0, query, tokensUsed: [] };
  }

  const container = await getContainer();
  if (!container) return { hits: [], totalCandidatesScanned: 0, query, tokensUsed: tokens };

  // Build a Cosmos query that matches candidate rows containing ANY of
  // the tokens, then score in memory. Cosmos's ARRAY_CONTAINS on the
  // searchTokens field is efficient; we OR across tokens.
  //
  // CF-CATALOG-TREE-CARD-COVERAGE (Drew, 2026-08-06). The tree-built
  // card nodes (~182K docs) don't have searchTokens populated — only
  // legacy vendor rows do. Adding named-field CONTAINS fallbacks so
  // "2018 ohtani topps refractor" reaches the ~307 Ohtani card nodes,
  // not just the ~13 vendor rows that happen to have tokenized.
  const wherePieces: string[] = [];
  const params: Array<{ name: string; value: string | number | boolean }> = [];
  for (let i = 0; i < tokens.length; i++) {
    wherePieces.push(`ARRAY_CONTAINS(c.searchTokens, @t${i})`);
    wherePieces.push(`(IS_DEFINED(c.playerName) AND CONTAINS(LOWER(c.playerName), @t${i}))`);
    wherePieces.push(`(IS_DEFINED(c.setKey) AND CONTAINS(LOWER(c.setKey), @t${i}))`);
    wherePieces.push(`(IS_DEFINED(c.cardNumber) AND CONTAINS(LOWER(c.cardNumber), @t${i}))`);
    params.push({ name: `@t${i}`, value: tokens[i] });
  }
  const searchOr = wherePieces.join(" OR ");

  const scopes: string[] = [];
  if (input.sport) {
    scopes.push("c.sport = @sport");
    params.push({ name: "@sport", value: input.sport });
  }
  if (input.year) {
    scopes.push("c.year = @year");
    params.push({ name: "@year", value: input.year });
  }
  if (typeof input.isAuto === "boolean") {
    scopes.push("c.isAuto = @isAuto");
    params.push({ name: "@isAuto", value: input.isAuto });
  }
  const scopeAnd = scopes.length > 0 ? " AND " + scopes.join(" AND ") : "";

  const qspec = {
    query: `SELECT TOP 500 c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c["set"] AS setName, c.parallel, c.isAuto, c.printRun, c.searchTokens, c.salesSummary FROM c WHERE (${searchOr})${scopeAnd}`,
    parameters: params,
  };

  interface Row {
    id: string;
    cardNumber?: string;
    playerName?: string;
    sport?: string;
    year?: number;
    setKey?: string;
    setName?: string;
    parallel?: string;
    isAuto?: boolean;
    printRun?: number | null;
    searchTokens?: string[];
    salesSummary?: CatalogSearchHit["salesSummary"];
  }

  let rows: Row[] = [];
  try {
    const { resources } = await container.items.query<Row>(qspec).fetchAll();
    rows = resources;
  } catch { return { hits: [], totalCandidatesScanned: 0, query, tokensUsed: tokens }; }

  // CF-CATALOG-SCORING-MULTI-FIELD (Drew, 2026-08-06). Score each row
  // by weighted matches across ALL searchable fields (searchTokens +
  // playerName + setKey + cardNumber + year). Tree card nodes don't
  // have searchTokens populated, so a searchTokens-only score would
  // drop them below the 0.5 threshold. Weights:
  //   playerName match  → 3.0  (strongest signal — "ohtani" should
  //                              rank Ohtani cards far above others)
  //   searchTokens hit  → 2.0
  //   setKey match      → 1.5
  //   year match        → 1.5
  //   cardNumber match  → 1.0
  // Score = sum(weighted matches) / max possible (tokens × 3.0).
  const scored: CatalogSearchHit[] = [];
  for (const r of rows) {
    const rowTokens = new Set((r.searchTokens ?? []).map((t) => t.toLowerCase()));
    const rowPlayer = String(r.playerName ?? "").toLowerCase();
    const rowSet = String(r.setKey ?? "").toLowerCase();
    const rowNumber = String(r.cardNumber ?? "").toLowerCase();
    const rowYear = r.year != null ? String(r.year) : "";
    let raw = 0;
    let hitFields = 0;
    for (const t of tokens) {
      let tokenMax = 0;
      if (rowPlayer && rowPlayer.includes(t)) tokenMax = Math.max(tokenMax, 3.0);
      if (rowTokens.has(t)) tokenMax = Math.max(tokenMax, 2.0);
      if (rowSet && rowSet.includes(t)) tokenMax = Math.max(tokenMax, 1.5);
      if (rowYear && rowYear === t) tokenMax = Math.max(tokenMax, 1.5);
      if (rowNumber && rowNumber.includes(t)) tokenMax = Math.max(tokenMax, 1.0);
      if (tokenMax > 0) hitFields++;
      raw += tokenMax;
    }
    const maxPossible = tokens.length * 3.0;
    const score = maxPossible > 0 ? raw / maxPossible : 0;
    // Require at least half the tokens matched (any field) for
    // multi-word queries. Prevents ranking noise where a lone
    // "topps" match surfaces a card that has nothing to do with
    // the query.
    if (hitFields < Math.max(1, Math.ceil(tokens.length / 2))) continue;
    scored.push({
      slug: r.id,
      cardNumber: r.cardNumber ?? null,
      playerName: r.playerName ?? null,
      sport: r.sport ?? null,
      year: r.year ?? null,
      setKey: r.setKey ?? null,
      setName: r.setName ?? null,
      parallel: r.parallel ?? null,
      isAuto: r.isAuto === true,
      printRun: typeof r.printRun === "number" ? r.printRun : null,
      score,
      salesSummary: r.salesSummary ?? null,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const av = a.salesSummary?.count ?? 0;
    const bv = b.salesSummary?.count ?? 0;
    return bv - av;
  });

  return {
    hits: scored.slice(0, limit),
    totalCandidatesScanned: rows.length,
    query,
    tokensUsed: tokens,
  };
}
