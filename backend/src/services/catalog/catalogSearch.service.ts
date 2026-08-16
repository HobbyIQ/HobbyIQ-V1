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

/**
 * Did the cheap exact-token arm actually find the PERSON being asked for?
 *
 * This is the escalation decision, and getting the signal right matters more
 * than the threshold. A first attempt used overall token-overlap score with a
 * 0.70 floor; that misroutes on query LENGTH, not on quality. "2018 topps
 * chrome update ohtani" is a perfect match yet scores 9.0/15.0 = 0.60, because
 * the four set/year tokens are only worth 1.5 each — so it escalated to the
 * expensive fuzzy scan for no reason and took 28.8s.
 *
 * What actually distinguishes the two situations is whether one row's
 * playerName accounts for ALL the name-ish tokens in the query:
 *
 *   "2026 bowman owen carey"     -> Owen Carey covers owen + carey     confident
 *   "2018 topps ... ohtani"      -> Shohei Ohtani covers ohtani        confident
 *   "2026 bowman justin gonzalez"-> Josuar Gonzalez covers gonzalez,
 *                                   NOT justin                         escalate
 *
 * That last case is exactly the misspelling trap: "gonzalez" is a real token
 * owned by other players, so the exact arm succeeds while answering the wrong
 * question. Matching is fuzzy per token (CF-SEARCH-FUZZY-PLAYER), so "erik"
 * still covers Eric without escalating.
 */
function nameTokensCovered(
  rows: Array<{ playerName?: string }>,
  nameTokens: readonly string[],
): boolean {
  if (nameTokens.length === 0) return rows.length > 0;
  return rows.some((r) => {
    const player = String(r.playerName ?? "");
    if (!player) return false;
    return nameTokens.every((t) => fuzzyIncludes(player, t));
  });
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
  // CF-SEARCH-ANCHOR-IS-THE-NAME (Drew, 2026-08-15: "when we search for say a
  // 2026 bowman owen carey, we want ALL potential matches to show up that
  // could fit that card for owen carey").
  //
  // "Longest alphabetic token of 6+ characters" is a proxy for the surname
  // that breaks on two counts, and "2026 bowman owen carey" trips both:
  // "carey" is five letters so it never qualified, and "bowman" is six so it
  // won the anchor instead. Since the anchor clause also matches
  // c.parallel, anchoring on "bowm" pulled in every card whose PARALLEL is
  // named Bowman-something — Bowman Logofractor, Bowman Logo Pattern
  // Refractor — for players nobody searched for. The page came back holding
  // Eric Hartman, CPA-BA, CPA-VF and dozens of bare card numbers.
  //
  // So: drop to four characters, and never anchor on a product or finish
  // word. Every token here is a word that names a BRAND, PRODUCT LINE or
  // FINISH, which is exactly the class that matches thousands of rows and
  // identifies no card. Real surnames of four-plus letters ("carey", "witt",
  // "soto") are what is left, which is what the anchor was always for.
  const ANCHOR_STOPWORDS = new Set([
    "bowman", "topps", "panini", "leaf", "upper", "deck", "fleer", "donruss", "score",
    "chrome", "prizm", "select", "optic", "mosaic", "heritage", "sapphire", "finest",
    "sterling", "inception", "platinum", "stadium", "club", "gallery", "archives",
    "allen", "ginter", "gypsy", "queen", "immaculate", "obsidian", "contenders",
    "refractor", "fractor", "prizms", "auto", "autograph", "autographs", "rookie",
    "prospect", "prospects", "paper", "update", "series", "draft", "mega", "jumbo",
    "base", "insert", "parallel", "variation", "numbered", "card", "cards",
    "baseball", "basketball", "football", "hockey", "soccer", "wrestling",
  ]);
  // A MISSPELLED product word is still a product word. "2026 bowmen owen carey"
  // put "bowmen" (6) ahead of "carey" (5) on length, anchored the whole search
  // on the brand, and returned nothing at all. Stopwords are therefore matched
  // by bounded edit distance, the same tolerance the player scorer uses. Only
  // for tokens of 5+ so short words are never absorbed by a longer stopword.
  const isStopword = (t: string) =>
    ANCHOR_STOPWORDS.has(t)
    || (t.length >= 5 && [...ANCHOR_STOPWORDS].some((w) =>
      Math.abs(w.length - t.length) <= 1 && editDistance(w, t, 1) <= 1));
  const alphaTokens = tokens.filter(
    (t) => /^[a-z]+$/.test(t) && t.length >= 4 && !isStopword(t),
  );
  const anchor = alphaTokens.sort((a, b) => b.length - a.length)[0] ?? null;

  // A token that looks like a CARD NUMBER: alphanumeric with a digit, and not a
  // bare year. "hmt1", "bcp-69", "cpa-eha", "us285". Used to guarantee the
  // named card is among the candidates — see CF-SEARCH-ANCHOR-SELECTS-THE-
  // CANDIDATES. Purely additive: a query with no such token is unaffected.
  const cardNumberToken = tokens.find((t) =>
    /\d/.test(t)
    && /^[a-z0-9-]+$/.test(t)
    && !/^(?:19|20)\d{2}$/.test(t)
    && !/^\d{1,2}$/.test(t)) ?? null;
  let anchorAnd = "";
  // CF-SEARCH-ANCHOR-INDEXED-FAST-PATH (Drew, 2026-08-15: "the search taking
  // 20+ seconds is bad").
  //
  // The anchor below matches with CONTAINS(LOWER(c.playerName), <prefix>).
  // CONTAINS on a scalar is a substring test and CANNOT use an index, so every
  // search scans card_catalog — 35.7M rows. That is fine for a rare name and
  // ruinous for a common one: "2018 topps chrome update ohtani" measured
  // 16.3s while "2026 bowman owen carey" measured 3.9s, and neither comps nor
  // images were involved. Ohtani is slow because he is everywhere.
  //
  // ARRAY_CONTAINS on searchTokens IS index-accelerated. So try the EXACT
  // token first and only fall back to the fuzzy prefix scan when that comes up
  // empty. The fuzzy path is what bridges spelling variants ("gonzalez" vs
  // "Gonzales", CF-SEARCH-FUZZY-PLAYER), and it still runs — for the queries
  // that need it, which are the ones with few rows to scan anyway.
  let anchorFastAnd = "";
  if (anchor) {
    const prefix = anchor.slice(0, Math.max(4, anchor.length - 2));
    anchorAnd =
      ` AND ((IS_DEFINED(c.playerName) AND CONTAINS(LOWER(c.playerName), @anchor))` +
      ` OR ARRAY_CONTAINS(c.searchTokens, @anchor)` +
      ` OR (IS_DEFINED(c.parallel) AND CONTAINS(LOWER(c.parallel), @anchor)))`;
    params.push({ name: "@anchor", value: prefix });
    anchorFastAnd = ` AND ARRAY_CONTAINS(c.searchTokens, @anchorExact)`;
    params.push({ name: "@anchorExact", value: anchor });
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

  /**
   * CF-SEARCH-ANCHOR-SELECTS-THE-CANDIDATES (Drew, 2026-08-16: "fix it so when
   * it gives a card year name, it shows all cards, but it also works with fuzzy
   * but when it is a full card it picks the right one").
   *
   * Three behaviours, one query path, and all three were limited by the same
   * thing: `searchOr` ORs EIGHT field predicates per token, six of them
   * CONTAINS — 40 branches on a five-token query, none index-accelerated. So it
   * scans, gets capped at TOP 500, and the 500 are an ARBITRARY sample of
   * everything matching a common word like "topps". Measured on 2026-08-16, the
   * two failures were not mis-ranking but rank=none — the right card was never
   * in the candidate set at all:
   *
   *     "2026 bowman justin gonzalez"          -> Josuar Gonzalez, 14.3s
   *     "2018 topps chrome update ohtani hmt1" -> HMT32 not HMT1, 16.0s
   *
   * Fix: let Cosmos SELECT cheaply on an index and let the scorer MATCH in
   * memory, where fuzzy player matching already lives (CF-SEARCH-FUZZY-PLAYER).
   *
   *   - PREFIX match on the token array via EXISTS + STARTSWITH. STARTSWITH
   *     inside EXISTS is index-accelerated where a bare CONTAINS is not, and
   *     the prefix is what carries misspellings: "gonzalez" anchors on
   *     "gonzal", which reaches GonzalES. One predicate serves as both the fast
   *     arm and the fuzzy arm, so no exact-match arm can short-circuit a
   *     misspelling before it is reached — the bug this replaces.
   *   - A CARD NUMBER arm, so a query naming a specific card always has that
   *     card among the candidates. This is what "when it is a full card it
   *     picks the right one" needs; ranking cannot pick what selection dropped.
   *
   * The projection deliberately omits c.searchTokens. Fetching 800 rows each
   * carrying its full token array is what blew the 20s budget on a first
   * attempt (several queries returned NOTHING). The scorer falls back to the
   * named fields, which are strictly more precise anyway — playerName is
   * weighted 3.0 against searchTokens' 2.0.
   */
  // NARROW ON PURPOSE. Cosmos has no covering index here, so every projected
  // field means loading more of each document, and that — not the row count —
  // is what costs. Measured on card_catalog: the same TOP 800 anchor query
  // returns in 453ms selecting c.id alone and ~15s selecting seventeen fields.
  // This is the minimum CatalogSearchHit needs; imageUrl is gone because search
  // no longer renders a thumbnail, and source/verificationStatus are used in
  // the WHERE clause but never read back.
  const anchorSelectFields = `c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c.parallel, c.isAuto, c.printRun, c.salesSummary`;
  //
  // The two arms run as SEPARATE queries, not as one OR. An OR that mixes an
  // EXISTS subquery with a scalar equality makes Cosmos fall back to a scan and
  // the pair measured 20-28s together; run apart, each stays on its index. TOP
  // is per-arm and modest for the same reason — the cost here is dominated by
  // materialising wide documents, not by matching them.
  const ANCHOR_TOP = 400;
  const buildArm = (where: string, extra: Array<{ name: string; value: string | number | boolean }> = []) => ({
    query: `SELECT TOP ${ANCHOR_TOP} ${anchorSelectFields} FROM c`
         + ` WHERE STARTSWITH(c.id, 'hiq:') AND ${where}`
         + `${scopeAnd} AND ${verifiedCatalogSqlClause("c")}`,
    parameters: [...params, ...extra],
  });
  //
  // EXACT FIRST, FUZZY ONLY IF NEEDED. ARRAY_CONTAINS on the whole token is an
  // index point-lookup; EXISTS + STARTSWITH is an index RANGE scan, and the
  // range is far wider than it looks — the prefix for "carey" is "care", which
  // also pulls Careaga, Carela and every other token starting that way. Same
  // query, measured: exact "carey" 1.5s, prefix "care" 16.6s.
  //
  // But exact alone is what broke misspellings, because "gonzalez" IS a real
  // token owned by OTHER players: it matched, short-circuited, and Justin
  // GonzalES was never reached. So the fallback cannot be triggered by
  // emptiness — it has to be triggered by QUALITY. A correctly spelled name
  // scores high on the exact arm; a misspelling scores poorly because the rows
  // it found belong to someone else. Below the floor, pay for the fuzzy arm.
  const armExact = anchor ? buildArm(`ARRAY_CONTAINS(c.searchTokens, @anchorExact)`) : null;
  const armFuzzy = anchor ? buildArm(`EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @anchor))`) : null;
  // Card numbers are compared WITHOUT wrapping the column in LOWER(). A
  // function on the indexed column defeats the index, and this one cost 15.7s
  // on "…blue refractor bcp-69" and 18.3s on "…ohtani hmt1" — the arm meant to
  // guarantee the exact card was the slowest thing in the query. The catalog
  // stores card numbers uppercase ("BCP-69", "HMT1", "CPA-EHA"), so comparing
  // against both the uppercased token and the raw one keeps it an indexable
  // equality while still matching either casing.
  const armNumber = cardNumberToken
    ? buildArm(`(c.cardNumber = @cardNumUpper OR c.cardNumber = @cardNum)`,
      [
        { name: "@cardNumUpper", value: cardNumberToken.toUpperCase() },
        { name: "@cardNum", value: cardNumberToken },
      ])
    : null;

  let rows: Row[] = [];
  let provisional = false;
  try {
    const runArm = (qs: { query: string; parameters: typeof params } | null) =>
      qs
        ? container.items.query<Row>(qs).fetchAll()
          .then((r) => r.resources ?? [])
          .catch(() => [] as Row[])
        : Promise.resolve([] as Row[]);

    const fastById = new Map<string, Row>();
    const absorb = (rows: Row[]) => { for (const r of rows) if (r?.id) fastById.set(r.id, r); };

    // The exact arm and the card-number arm are both cheap point lookups.
    absorb((await Promise.all([runArm(armExact), runArm(armNumber)])).flat());
    // Escalate to the fuzzy prefix scan only when the cheap arms did not
    // produce a confident answer for this query.
    if (armFuzzy && !nameTokensCovered([...fastById.values()], alphaTokens)) {
      absorb(await runArm(armFuzzy));
    }
    const fast = [...fastById.values()];
    const { resources: canon } = fast.length > 0
      ? { resources: fast }
      : await container.items.query<Row>(canonicalQspec).fetchAll();
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
    let score = maxPossible > 0 ? raw / maxPossible : 0;

    // CF-SEARCH-EXACT-CARD-WINS (Drew, 2026-08-16: "when it is a full card it
    // picks the right one").
    //
    // Token overlap alone cannot express this. Every 2018 Topps Chrome Update
    // Ohtani shares the year, the set and the player, so a query naming
    // "hmt1" differs from its rivals by ONE token out of six — and #HMT32 beat
    // #HMT1 on the remaining noise. Same for "blue refractor bcp-69", where
    // Black Refractor outranked Blue.
    //
    // A card NUMBER is an exact identifier, not a keyword: when the query names
    // one and the row IS it, that row is the answer and nothing that merely
    // shares a set should outrank it. Substring is not enough either — "hmt1"
    // is a substring of nothing useful, but "1" would be a substring of
    // everything, which is why this is equality on the whole token.
    //
    // Parallel gets a smaller, non-decisive bump: naming "blue" should beat
    // Black on a tie, but must not overrule the card number.
    const numberIsExact = rowNumber.length > 0 && tokens.some((t) => t === rowNumber);
    if (numberIsExact) score += 1.0;
    if (rowParallel) {
      const parallelWords = new Set(rowParallel.split(/[\s-]+/).filter(Boolean));
      if (tokens.some((t) => parallelWords.has(t))) score += 0.15;
    }
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

  // CF-SEARCH-COMPS-BATCHED (Drew, 2026-08-15: "the search taking 20+ seconds
  // is bad"). This was one query PER HIT. That was survivable while the query
  // was partition-scoped and the page was 25 rows; it is not once the lookup
  // has to match hobbyiqCardId (CF-SEARCH-COMPS-MATCH-BOTH-IDS, necessarily
  // cross-partition) and the page grows to show a whole product family. At 250
  // hits it was 250 cross-partition round trips and blew the 20s budget
  // outright — search returned nothing at all.
  //
  // Batch instead: one query per CHUNK of slugs, chunks in parallel, then fan
  // the rows back out in memory. 250 round trips becomes 5.
  //
  // ENRICHMENT IS CAPPED, THE PAGE IS NOT. Cost scales with the number of
  // COMPS behind the page, not the number of hits: a Shohei Ohtani page is 100
  // cards each holding hundreds of sales, and pulling all of them — often just
  // to find one image — measured 18.9s. Hits past the cap still return, still
  // rank, and still carry whatever the batch job wrote; they only miss the
  // live top-up. That keeps the whole product family on the page (Drew,
  // 2026-08-15: "the entire product family should show up ... even if we don't
  // have comp data in there") while bounding the tail.
  //
  // NO IMAGE LOOKUP (Drew, 2026-08-15: "let's remove the image in the search.
  // That will speed things up"). Chasing a picture was the expensive half:
  // popular cards already carry a batch-computed salesSummary, so the ONLY
  // reason to open their comps was to find a thumbnail — and a Shohei Ohtani
  // page is 100 cards holding hundreds of sales each. Measured 18.9s, almost
  // all of it spent fetching sales we then threw away.
  //
  // Search results no longer show a thumbnail. The card DETAIL page still
  // does, where one card is being confirmed and one lookup is cheap.
  //
  // What is left is the genuinely cheap case: cards the batch job has not
  // reached, which are by definition the ones with few comps.
  const ENRICH_MAX = 60;
  const needs = hits
    .filter((h) => !(h.salesSummary && h.salesSummary.count > 0))
    .slice(0, ENRICH_MAX);
  if (needs.length === 0) return;

  const CHUNK = 50;
  const chunks: CatalogSearchHit[][] = [];
  for (let i = 0; i < needs.length; i += CHUNK) chunks.push(needs.slice(i, i + CHUNK));

  await Promise.all(chunks.map(async (chunk) => {
    const ids = chunk.map((h) => h.slug);
    let rows: Array<{
      cardId?: string | null; hobbyiqCardId?: string | null;
      price: number; soldAt: string;
    }> = [];
    try {
      const { resources } = await comps.items.query<typeof rows[number]>({
        // Matches BOTH ids: /cardId is the partition key and usually holds a
        // vendor id, while the canonical slug lives in hobbyiqCardId. See
        // CF-SEARCH-COMPS-MATCH-BOTH-IDS — 83.5% of canonically-identified
        // comps are reachable only via hobbyiqCardId, and a small set (2018
        // Ohtani #HMT1) only via cardId.
        query: "SELECT c.cardId, c.hobbyiqCardId, c.price, c.soldAt "
             + "FROM c WHERE ARRAY_CONTAINS(@ids, c.cardId) OR ARRAY_CONTAINS(@ids, c.hobbyiqCardId)",
        parameters: [{ name: "@ids", value: ids }],
      }).fetchAll();
      rows = resources ?? [];
    } catch { return; }   // best-effort: leave whatever the batch job wrote
    if (rows.length === 0) return;

    const byId = new Map<string, typeof rows>();
    for (const r of rows) {
      for (const key of [r.cardId, r.hobbyiqCardId]) {
        if (typeof key !== "string" || !key) continue;
        const cur = byId.get(key);
        if (cur) cur.push(r); else byId.set(key, [r]);
      }
    }

    for (const h of chunk) {
      const mine = byId.get(h.slug);
      if (!mine || mine.length === 0) continue;

      const dated = mine
        .filter((r) => typeof r.price === "number" && r.price > 0 && r.soldAt)
        .sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt)));
      if (dated.length === 0) continue;

      const median = (xs: number[]) => {
        if (xs.length === 0) return null;
        const srt = [...xs].sort((a, b) => a - b);
        const m = Math.floor(srt.length / 2);
        return srt.length % 2 ? srt[m] : Math.round(((srt[m - 1] + srt[m]) / 2) * 100) / 100;
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
    }
  }));
}
