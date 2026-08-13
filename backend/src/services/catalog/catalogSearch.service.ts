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
import {
  verifiedCatalogSqlClause,
  provisionalCatalogSqlClause,
} from "./catalogVisibility.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

const SOLD_COMPS_CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";

let _container: Container | null = null;
let _comps: Container | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn).database(COSMOS_DATABASE).container(CATALOG_CONTAINER);
    return _container;
  } catch { return null; }
}

/** sold_comps handle for CF-SEARCH-ATTACH-COMPS. Separate from the catalog
 *  container so a comps outage can never take the catalog search down. */
async function getCompsContainer(): Promise<Container | null> {
  if (_comps) return _comps;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _comps = new CosmosClient(conn).database(COSMOS_DATABASE).container(SOLD_COMPS_CONTAINER);
    return _comps;
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
  imageUrl: string | null;    // CF-CATALOG-PHOTOS: attached from sold_comps
  kind: string | null;        // "card" | "variant" | "grade" | "canonical"
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
  /** CF-CATALOG-SEARCH-TIERS: true when NOTHING verified matched and these
   *  hits came from the provisional tier — cards we hold real sales for but
   *  have no checklist for yet. Clients should label them ("no verified
   *  checklist yet") rather than render them as ordinary results, and this
   *  is the signal that a checklist for that release is worth building. */
  provisional?: boolean;
}

/** Fold to ASCII and strip punctuation so "Ronald Acuña, Jr." and
 *  "Ronald Acuna Jr" compare equal. Mirrors slugify() in
 *  hobbyIqCardId.service — see CF-PLAYER-NAME-FOLDING. */
function fold(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein, bounded — returns >max as soon as it is certain. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * CF-SEARCH-FUZZY-PLAYER (Drew, 2026-08-13). Card names carry spelling
 * variants that exact matching cannot bridge. Drew searched
 * "2026 bowman Justin gonzalez auto"; the checklist spells him
 * "Justin Gonzales" — z vs s — so the player token, the strongest signal in
 * the scorer, contributed nothing and his three autos ranked below noise.
 *
 * Tolerance scales with length so short tokens stay exact: a 1-edit window on
 * a 4-letter token would make "Cruz" match "Cruk" and "Ruiz". Diacritics are
 * handled by folding first, not by the edit budget, so "Peña"/"Pena" costs
 * nothing against the distance allowance.
 */
function fuzzyIncludes(haystack: string, token: string): boolean {
  const h = fold(haystack);
  const t = fold(token);
  if (!h || !t) return false;
  if (h.includes(t)) return true;
  if (t.length < 5) return false;              // too short to risk a fuzzy hit
  const budget = t.length >= 8 ? 2 : 1;
  for (const word of h.split(/[\s-]+/)) {
    if (Math.abs(word.length - t.length) > budget) continue;
    if (editDistance(word, t, budget) <= budget) return true;
  }
  return false;
}

/** Identity of the physical card, from FIELDS rather than the id — the only
 *  thing that merges a vendor-keyed row with its canonical twin. */
function dedupeKey(h: CatalogSearchHit): string {
  return [
    h.year ?? "",
    String(h.setKey || h.setName || "").toLowerCase(),
    String(h.cardNumber ?? "").toLowerCase(),
    String(h.parallel ?? "").toLowerCase(),
    h.isAuto ? "auto" : "no-auto",
    h.printRun ?? "",
  ].join("|");
}

/** True when `a` should represent the card instead of `b`. Ungraded first
 *  (comps hang off the ungraded slug), then canonical over vendor-keyed, then
 *  score. */
function preferHit(a: CatalogSearchHit, b: CatalogSearchHit): boolean {
  const graded = (x: CatalogSearchHit) => (/:(raw|psa|bgs|sgc|cgc)(-|$)/.test(x.slug) ? 1 : 0);
  const vendor = (x: CatalogSearchHit) => (x.slug.startsWith("hiq:") ? 0 : 1);
  if (graded(a) !== graded(b)) return graded(a) < graded(b);
  if (vendor(a) !== vendor(b)) return vendor(a) < vendor(b);
  return a.score > b.score;
}

/** Pure helpers, exported for tests only. */
export const __testables = { fold, editDistance, fuzzyIncludes, dedupeKey, preferHit };

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
    // CF-CATALOG-SETNAME-MATCH (Drew, 2026-08-08). Some catalog rows
    // populate setName (or the reserved-word field c["set"]) but not
    // setKey — including all TCDB batch-fill entries and older Cardsight
    // rows. Previously WHERE searched setKey only, so multi-word queries
    // like "2018 topps chrome update ohtani" would fail to score high
    // enough on catalog-first and fall through to CH freetext. That
    // fallback broke when CH_RUNTIME_DISABLED was flipped on. Searching
    // setName + set closes the gap so catalog-first is truly self-sufficient.
    wherePieces.push(`(IS_DEFINED(c.setName) AND CONTAINS(LOWER(c.setName), @t${i}))`);
    wherePieces.push(`(IS_DEFINED(c["set"]) AND CONTAINS(LOWER(c["set"]), @t${i}))`);
    wherePieces.push(`(IS_DEFINED(c.cardNumber) AND CONTAINS(LOWER(c.cardNumber), @t${i}))`);
    // CF-CATALOG-VARIANT-MATCH (Drew, 2026-08-06). Also match variant
    // node parallel/parallelSlug so a query with a finish token like
    // "refractor" can surface the right variant (not just the base card).
    wherePieces.push(`(IS_DEFINED(c.parallel) AND CONTAINS(LOWER(c.parallel), @t${i}))`);
    wherePieces.push(`(IS_DEFINED(c.parallelSlug) AND CONTAINS(LOWER(c.parallelSlug), @t${i}))`);
    params.push({ name: `@t${i}`, value: tokens[i] });
  }
  const searchOr = wherePieces.join(" OR ");

  // CF-SEARCH-SELECTIVE-ANCHOR (Drew, 2026-08-13). ORing every token makes the
  // predicate match on "bowman" alone — millions of rows — so the TOP N sample
  // is arbitrary and the card being searched for is usually not in it. Both
  // the vendor-row flood and the later zero-hit result came from this, not
  // from scoring.
  //
  // Anchor the query on the longest alphabetic token, which is the surname in
  // essentially every real query ("gonzalez" over "bowman"/"auto"/"2026"), and
  // require it. Matching is by PREFIX with the last two characters dropped, so
  // "gonzalez" anchors on "gonzal" and still reaches "Gonzales" — the z/s
  // variant that started this. Cosmos cannot do edit distance, so the prefix
  // buys recall cheaply and fuzzyIncludes() does the precise scoring in memory.
  //
  // Skipped when no token is long enough to be a name, leaving the old
  // any-token behaviour for short queries like "topps 1989".
  const alphaTokens = tokens.filter((t) => /^[a-z]+$/.test(t) && t.length >= 6);
  const anchor = alphaTokens.sort((a, b) => b.length - a.length)[0] ?? null;
  let anchorAnd = "";
  if (anchor) {
    const prefix = anchor.slice(0, Math.max(4, anchor.length - 2));
    anchorAnd =
      ` AND ((IS_DEFINED(c.playerName) AND CONTAINS(LOWER(c.playerName), @anchor))` +
      ` OR ARRAY_CONTAINS(c.searchTokens, @anchor)` +
      ` OR (IS_DEFINED(c.parallel) AND CONTAINS(LOWER(c.parallel), @anchor)))`;
    params.push({ name: "@anchor", value: prefix });
  }

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

  // CF-CATALOG-SEARCH-TIERS (Drew, 2026-08-12). Search returns VERIFIED
  // cards. Rows created from observed sales (`sold-comps-stub-*`) exist so
  // comps have something to roll up to — they power a card's pricing and
  // trend — but they are not checklist-backed, so they must not be presented
  // as ordinary results. Comp-derived rows have twice become a search-quality
  // problem (`sales-derived` purged 2026-08-08, `tree-builder-v1` excluded
  // 2026-08-09); this is the durable version of that exclusion.
  //
  // Provisional rows are still FINDABLE — see searchProvisionalCatalog()
  // below, which the caller runs only when the verified tier came back
  // empty, so a card we hold sales for is never simply "not found".
  const qspec = {
    query: `SELECT TOP 500 c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c["set"] AS setNameFromSet, c.parallel, c.parallelSlug, c.isAuto, c.printRun, c.searchTokens, c.salesSummary, c.kind, c.imageUrl, c.source, c.verificationStatus FROM c WHERE (${searchOr})${anchorAnd}${scopeAnd} AND ${verifiedCatalogSqlClause("c")}`,
    parameters: params,
  };

  /** Same query, provisional tier only. Used as the fallback when the
   *  verified tier is empty — these are the "we have sales but no checklist
   *  yet" cards, and the caller flags them so they never render as equals. */
  const provisionalQspec = {
    query: `SELECT TOP 100 c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c["set"] AS setNameFromSet, c.parallel, c.parallelSlug, c.isAuto, c.printRun, c.searchTokens, c.salesSummary, c.kind, c.imageUrl, c.source, c.verificationStatus FROM c WHERE (${searchOr})${anchorAnd}${scopeAnd} AND ${provisionalCatalogSqlClause("c")}`,
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
    setNameFromSet?: string;  // aliased from c["set"] — some legacy rows use the reserved-word field
    parallel?: string;
    parallelSlug?: string;
    isAuto?: boolean;
    printRun?: number | null;
    searchTokens?: string[];
    salesSummary?: CatalogSearchHit["salesSummary"];
    kind?: string;
    imageUrl?: string | null;
  }

  // CF-SEARCH-CHECKLIST-FIRST-QUERY (Drew, 2026-08-13). The candidate query is
  // TOP 500 with no ORDER BY over a WHERE that matches ANY token, so a common
  // token like "bowman" matches millions of rows and the 500 returned are an
  // ARBITRARY sample. In practice they came back entirely vendor-keyed
  // (`cardhedge::…`), so a post-filter preferring canonical rows had nothing
  // canonical to prefer — the checklist rows were never fetched at all. Same
  // sampling trap as the pricing lookup's TOP 60.
  //
  // Restrict the first pass to canonical `hiq:` slugs — the checklist IS the
  // index — and fall back to the unrestricted query only when that finds
  // nothing, so a card we know only through a vendor stays findable.
  const canonicalQspec = {
    query: qspec.query.replace(" FROM c WHERE (", " FROM c WHERE STARTSWITH(c.id, 'hiq:') AND ("),
    parameters: params,
  };

  let rows: Row[] = [];
  let provisional = false;
  try {
    const { resources: canon } = await container.items.query<Row>(canonicalQspec).fetchAll();
    const { resources } = canon.length > 0
      ? { resources: canon }
      : await container.items.query<Row>(qspec).fetchAll();
    rows = resources;
    // CF-CATALOG-SEARCH-TIERS: fall back to the provisional tier ONLY when
    // nothing verified matched. A card we hold real sales for should never
    // read as "not found" just because its checklist hasn't landed — but a
    // stub must never dilute a page of verified results either, so this is
    // strictly empty-else, not a merge.
    if (rows.length === 0) {
      const { resources: prov } = await container.items.query<Row>(provisionalQspec).fetchAll();
      if (prov.length > 0) { rows = prov; provisional = true; }
    }
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
    // Pick whichever set field is populated: setKey → setName → c["set"].
    // Rows differ across ingest sources (TCDB uses setName, tree cards use
    // setKey, legacy Cardsight uses c["set"]).
    const rowSet = String(r.setKey || r.setName || r.setNameFromSet || "").toLowerCase();
    const rowNumber = String(r.cardNumber ?? "").toLowerCase();
    const rowYear = r.year != null ? String(r.year) : "";
    const rowParallel = String(r.parallel ?? "").toLowerCase();
    const rowParallelSlug = String(r.parallelSlug ?? "").toLowerCase();
    let raw = 0;
    let hitFields = 0;
    for (const t of tokens) {
      let tokenMax = 0;
      if (rowPlayer && rowPlayer.includes(t)) tokenMax = Math.max(tokenMax, 3.0);
      // CF-SEARCH-FUZZY-PLAYER: a near-miss on the name still counts, just
      // below an exact hit so correct spellings always outrank variants.
      else if (rowPlayer && fuzzyIncludes(rowPlayer, t)) tokenMax = Math.max(tokenMax, 2.5);
      if (rowTokens.has(t)) tokenMax = Math.max(tokenMax, 2.0);
      if (rowSet && rowSet.includes(t)) tokenMax = Math.max(tokenMax, 1.5);
      if (rowYear && rowYear === t) tokenMax = Math.max(tokenMax, 1.5);
      if (rowParallel && rowParallel.includes(t)) tokenMax = Math.max(tokenMax, 1.5);
      if (rowParallelSlug && rowParallelSlug.includes(t)) tokenMax = Math.max(tokenMax, 1.5);
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
      imageUrl: r.imageUrl ?? null,
      kind: r.kind ?? null,
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

  // CF-SEARCH-DEDUP (Drew, 2026-08-13: search "came back with duplicates").
  // The catalog holds many rows per physical card — 2026 Bowman Justin
  // Gonzales CPA-JG alone has 130 across 8 sources (65 vendor-keyed
  // `cardhedge::` rows for one "Base auto", plus grade variants, stubs and a
  // bowman/bowman-chrome split). Scoring them independently puts the same card
  // on the page three and four times, which is what Drew saw.
  //
  // Collapse to one row per physical identity, built from FIELDS rather than
  // ids — the only thing that merges a vendor-keyed row with its canonical
  // twin. Within a card, keep the best-scoring row, preferring a canonical
  // `hiq:` slug so the result links to the card rather than to a vendor's copy
  // of it.
  const byCard = new Map<string, CatalogSearchHit>();
  for (const h of scored) {
    const key = dedupeKey(h);
    const cur = byCard.get(key);
    if (!cur) { byCard.set(key, h); continue; }
    // Grade variants carry the SAME identity fields as the ungraded card —
    // parallel, printRun and isAuto are all identical — so they land on this
    // key too, and a `:psa-10` row can win the tie on score alone. The comps
    // hang off the ungraded slug, so picking a grade row returns the right
    // card with an empty market panel. Order: ungraded, then canonical slug,
    // then score. (Grade is still a real identity — see
    // CF-PRICE-LOOKUP-COLLAPSE-GRADES — it is just not what a checklist
    // search result should collapse to.)
    if (preferHit(h, cur)) byCard.set(key, h);
  }
  let collapsed = [...byCard.values()];

  // CF-SEARCH-CHECKLIST-IS-THE-INDEX (Drew, 2026-08-13: "we want to search for
  // the checklist and see the comps attached to it. So the checklist feeds the
  // search").
  //
  // Vendor-keyed rows (`cardhedge::…`, `cardsight::…`, `variant::…`) are
  // mirrors of cards we already hold canonically. They carry the vendor's
  // setKey rather than ours, so they do NOT collapse into their canonical twin
  // above, and they frequently outscore it — a search for
  // "2026 bowman Justin gonzalez auto" returned four `cardhedge::` rows at the
  // top, each with comps=0 because sales hang off the canonical slug, not the
  // vendor's copy of it.
  //
  // When any canonical `hiq:` row matched, the vendor rows are redundant and
  // are dropped. When none did, they are kept — a card we only know through a
  // vendor should still be findable rather than silently absent.
  const canonicalHits = collapsed.filter((h) => h.slug.startsWith("hiq:"));
  if (canonicalHits.length > 0) collapsed = canonicalHits;

  const deduped = collapsed.slice(0, limit);

  // CF-SEARCH-ATTACH-COMPS (Drew, 2026-08-13: "we want to search for the
  // checklist and see the comps attached to it").
  //
  // salesSummary is written by a batch job (attach-sales-summary-to-catalog),
  // so every freshly-ingested checklist row reads comps=0 until that job next
  // runs — the checklist search returned the right cards with no market data
  // behind them. sold_comps partitions on /cardId, so counting a card's comps
  // is a single-partition query; doing it live for the page being returned
  // keeps a brand-new checklist card correct immediately and costs one cheap
  // query per hit rather than a scan.
  await attachLiveComps(deduped);

  return {
    hits: deduped,
    totalCandidatesScanned: rows.length,
    query,
    tokensUsed: tokens,
    ...(provisional ? { provisional: true } : {}),
  };
}

/** Fill salesSummary for hits the batch job hasn't reached yet. Best-effort:
 *  a failure leaves the pre-computed value (or null) untouched rather than
 *  failing the search. */
async function attachLiveComps(hits: CatalogSearchHit[]): Promise<void> {
  if (hits.length === 0) return;
  const comps = await getCompsContainer();
  if (!comps) return;

  await Promise.all(hits.map(async (h) => {
    if (h.salesSummary && h.salesSummary.count > 0) return;   // batch value wins
    try {
      const { resources } = await comps.items.query<{
        price: number; soldAt: string; imageUrl?: string | null; blobUrl?: string | null;
      }>({
        // CF-SEARCH-ATTACH-IMAGE (Drew, 2026-08-13: "Images should show here,
        // we have them"). CatalogSearchHit.imageUrl is documented as "attached
        // from sold_comps", but that attachment is a batch job — so every
        // freshly-ingested checklist row had imageUrl=null and the UI rendered
        // a broken placeholder for each result. Measured: 0 of 8 2018 Ohtani
        // catalog rows carried an image, while their comps carried several.
        //
        // We are already reading this card's comps for the sales summary, so
        // the picture costs nothing extra — same single-partition query.
        query: "SELECT c.price, c.soldAt, c.imageUrl, c.blobUrl FROM c WHERE c.cardId = @id",
        parameters: [{ name: "@id", value: h.slug }],
      }, { partitionKey: h.slug }).fetchAll();
      if (!resources || resources.length === 0) return;

      // Prefer OUR blob copy over the vendor URL: eBay image links expire and
      // are hotlink-restricted, so a vendor URL is a placeholder waiting to
      // happen. Falls back to the vendor URL when we have not mirrored one yet.
      if (!h.imageUrl) {
        const withBlob = resources.find((r) => typeof r.blobUrl === "string" && r.blobUrl);
        const withImg = resources.find((r) => typeof r.imageUrl === "string" && r.imageUrl);
        h.imageUrl = (withBlob?.blobUrl ?? withImg?.imageUrl) ?? null;
      }

      const dated = resources
        .filter((r) => typeof r.price === "number" && r.price > 0 && r.soldAt)
        .sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt)));
      if (dated.length === 0) return;

      const median = (xs: number[]) => {
        if (xs.length === 0) return null;
        const s = [...xs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100;
      };
      const since = (days: number) => {
        const cut = new Date(Date.now() - days * 86_400_000).toISOString();
        return dated.filter((r) => String(r.soldAt) >= cut).map((r) => r.price);
      };
      const m30 = median(since(30));
      const m90 = median(since(90));

      h.salesSummary = {
        count: dated.length,
        firstSaleAt: String(dated[0].soldAt),
        lastSaleAt: String(dated[dated.length - 1].soldAt),
        median30d: m30,
        median90d: m90,
        median180d: median(since(180)),
        medianAll: median(dated.map((r) => r.price)),
        trendDirection: m30 != null && m90 != null
          ? (m30 > m90 * 1.02 ? "up" : m30 < m90 * 0.98 ? "down" : "flat")
          : "flat",
        trendPct30dVs90d: m30 != null && m90 != null && m90 > 0
          ? Math.round(((m30 - m90) / m90) * 1000) / 10
          : null,
        updatedAt: new Date().toISOString(),
      };
    } catch { /* best-effort — leave whatever the batch job wrote */ }
  }));
}
