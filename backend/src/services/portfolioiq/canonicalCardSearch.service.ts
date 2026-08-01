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
  /** Filter to a specific parallel (matches case-insensitively against
   *  card_catalog parallels[].name and any sold_comps.parallel field on
   *  the enrichment lookup). */
  parallel?: string;
  /** Filter to a specific grade — e.g. "PSA 10" or "BGS 9.5". */
  grade?: string;
  /** Filter to a specific print run (numeric, e.g. 150 for /150). */
  printRun?: number;
  /** Filter to autographs only (true) or non-autos only (false). */
  isAuto?: boolean;
  /** Filter to a specific card year. */
  year?: number;
  /** CF-SELL-SIGNAL-USER-THRESHOLD (Drew, 2026-07-26). User's
   *  "sell at +N%" preference (from iOS settings). Default 15%.
   *  Only affects the sell-now boundary in computeSellSignal;
   *  buy/hold/watch stay at their locked doctrine defaults.
   *  Clamped 5-100 in the resolver (out-of-range silently falls to
   *  default so a broken client can't produce nonsense signals). */
  sellThresholdPct?: number;
}

export interface MatchedRange {
  field: "player" | "releaseName" | "cardNumber" | "parallels";
  start: number;
  end: number;
  token: string;
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
  matchedRanges: MatchedRange[];   // for iOS to bold-highlight matched substrings
  momentumPct: number | null;      // 30d-vs-prior-60d % change on same slug (nullable)
  recentSaleCount: number;         // popularity indicator from card_catalog
  /** CF-SELL-SIGNAL (Drew, 2026-07-26). Actionable seller-intelligence
   *  tag derived from momentumPct + compCount. Per product doctrine
   *  (project_product_actionable_seller_intelligence): timed action
   *  recommendations, not prediction accuracy. iOS renders as a small
   *  badge on each hit.
   *    "sell-now" — spike detected (up >15% in 30d with real volume)
   *    "buy"      — drawdown detected (down >15% in 30d with real volume)
   *    "hold"     — stable (within ±5% with real volume)
   *    "watch"    — insufficient signal (thin volume OR indeterminate) */
  signal: "sell-now" | "hold" | "buy" | "watch";
  /** One-sentence human explanation of the signal for iOS tooltip. */
  signalReason: string;
  score: number;
}

export interface CanonicalSearchGroup {
  groupId: string;                    // year+cardNumber+player key
  player: string | null;
  cardYear: number | null;
  releaseName: string | null;
  cardNumber: string | null;
  variantCount: number;
  hits: CanonicalSearchHit[];         // all hits belonging to this group
}

export interface CanonicalSearchFacets {
  parallels: Record<string, number>;
  grades: Record<string, number>;
  printRuns: Record<string, number>;
  years: Record<string, number>;
  releaseNames: Record<string, number>;
}

export interface CanonicalSearchResult {
  q: string;
  tokens: string[];
  semanticFilters: {
    isAuto: boolean | null;
    year: number | null;
  };
  appliedFilters: {
    parallel: string | null;
    grade: string | null;
    printRun: number | null;
    isAuto: boolean | null;
    year: number | null;
  };
  hits: CanonicalSearchHit[];
  groups: CanonicalSearchGroup[];   // hits collapsed by (player, year, cardNumber)
  facets: CanonicalSearchFacets;
  totalCandidates: number;
  cachedFromMemory: boolean;
  /** CF-SEARCH-CONFIDENT-SINGLE (Drew, 2026-07-25). When top hit's score
   *  is ≥3× the second-place, iOS can auto-jump to card detail instead
   *  of showing a list. Reflects "clear winner" query. */
  confidentSingleResult: boolean;
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

// CF-SEARCH-SET-ALIASES (Drew, 2026-07-25). Expand user shorthand into
// full set names so "prizm silver" matches "Panini Prizm Silver". Applied
// during tokenization — the alias's expanded tokens replace the original.
const SET_ALIASES: Record<string, string[]> = {
  "prizm": ["panini", "prizm"],
  "tc": ["topps", "chrome"],
  "bc": ["bowman", "chrome"],
  "bdc": ["bowman", "draft", "chrome"],
  "ud": ["upper", "deck"],
  "opc": ["o-pee-chee"],
  "sc": ["stadium", "club"],
  "ss": ["select"],
  "ntx": ["national", "treasures"],
  "flawless": ["panini", "flawless"],
  "immaculate": ["panini", "immaculate"],
  "obsidian": ["panini", "obsidian"],
  "mosaic": ["panini", "mosaic"],
  "optic": ["panini", "optic"],
  "donruss": ["panini", "donruss"],
  "sapphire": ["sapphire"],  // keeps as-is but marks it as a distinct product hint
  "ttcu": ["topps", "chrome", "update"],
};

// Grade shortcuts — "psa10" → PSA 10 filter, "10" alone → PSA 10 filter.
const GRADE_ALIAS: Record<string, { company: string; value: number }> = {
  "psa10": { company: "PSA", value: 10 },
  "psa9": { company: "PSA", value: 9 },
  "psa9.5": { company: "PSA", value: 9.5 },
  "psa8": { company: "PSA", value: 8 },
  "bgs10": { company: "BGS", value: 10 },
  "bgs9.5": { company: "BGS", value: 9.5 },
  "bgs9": { company: "BGS", value: 9 },
  "sgc10": { company: "SGC", value: 10 },
  "sgc9.5": { company: "SGC", value: 9.5 },
  "cgc10": { company: "CGC", value: 10 },
  "cgc9.5": { company: "CGC", value: 9.5 },
  "gem": { company: "PSA", value: 10 },
  "gemmint": { company: "PSA", value: 10 },
  "mint": { company: "PSA", value: 9 },        // colloquial — "mint" = PSA 9, not PSA 10
  "pristine": { company: "BGS", value: 10 },   // BGS Pristine 10 (all subgrades = 10)
  "blacklabel": { company: "BGS", value: 10 }, // BGS Black Label = Pristine 10
};

// Print-run pattern — "/50", "/150", "/199" in the query → printRun filter.
const PRINT_RUN_RE = /^\/?(\d{1,4})$/;
// Card number pattern — "#125", "BCP-102", "CPA-EHA", "USC88", etc.
const CARD_NUMBER_RE = /^#?([A-Z]{2,6}-[A-Z0-9]+|[A-Z]?\d{1,4}[A-Z]?|[A-Z]{2,4}\d{1,4})$/i;

// CF-SELL-SIGNAL (Drew, 2026-07-26). Actionable-intelligence signal
// tags derived from three fields the search already computes:
//   momentumPct   — 30d median vs prior-60d median % change
//   compCount     — comps in 90d window (direct-slug)
//   recentSaleCount — popularity indicator from card_catalog
//
// Thresholds (defaults):
//   sell-now  — momentumPct >= +sellThresholdPct AND compCount >= 5
//               (USER-CONFIGURABLE per PR #776 — iOS "sell at +N%"
//               preference passes through as sellThresholdPct on the
//               request. Range clamped 5-100.)
//   buy       — momentumPct <= -15 AND compCount >= 5 (LOCKED)
//   hold      — |momentumPct| <= 5 AND compCount >= 5 (LOCKED)
//   watch     — everything else
//
// Why sell-now is user-tunable and the others aren't:
//   sell-now is a "when do I take profit" decision — deeply personal
//   (risk tolerance, capital deployment). Buy / hold / watch are
//   market-state readings that don't change based on user preference —
//   a -20% drop is a -20% drop regardless of who's looking. Keeping
//   those locked preserves comparability across users.
//
// The compCount>=5 gate keeps thin-comp cards out of the actionable
// tiers — no fake urgency on cards with 1-2 recent sales. Below that
// threshold, everything is "watch". Empirical-only doctrine: no
// signal without data.
const SIGNAL_MIN_COMPS_FOR_ACTION = 5;
const SIGNAL_DEFAULT_SELL_PCT = 15;
const SIGNAL_BUY_PCT = 15;
const SIGNAL_STABLE_BAND_PCT = 5;
// Range guard on user-passed sell threshold. Below 5 is inside the
// stable band (silly); above 100 is fantasyland.
const SIGNAL_SELL_MIN = 5;
const SIGNAL_SELL_MAX = 100;

export interface SellSignalOpts {
  /** User's "sell at +N%" preference (iOS setting). Default 15. Range
   *  clamped to [5, 100]. When passed, only affects sell-now boundary;
   *  buy / hold / watch remain at their locked doctrine defaults. */
  sellThresholdPct?: number;
}

export function computeSellSignal(
  momentumPct: number | null,
  compCount: number,
  recentSaleCount: number,
  opts: SellSignalOpts = {},
): { signal: "sell-now" | "hold" | "buy" | "watch"; reason: string } {
  // Resolve user-tunable sell threshold with clamping. NaN / negative /
  // out-of-range values silently fall back to the default so a broken
  // client can't produce a nonsense signal.
  const rawThreshold = opts.sellThresholdPct;
  const sellThreshold = (typeof rawThreshold === "number" && Number.isFinite(rawThreshold))
    ? Math.max(SIGNAL_SELL_MIN, Math.min(SIGNAL_SELL_MAX, rawThreshold))
    : SIGNAL_DEFAULT_SELL_PCT;

  if (momentumPct === null || compCount < SIGNAL_MIN_COMPS_FOR_ACTION) {
    const compsFragment = compCount === 0 ? "no recent sales" : `only ${compCount} sale${compCount === 1 ? "" : "s"} in 90d`;
    return { signal: "watch", reason: `Insufficient signal — ${compsFragment}` };
  }
  const abs = Math.abs(momentumPct);
  const dirWord = momentumPct >= 0 ? "up" : "down";
  const compsFragment = `${compCount} sales in 90d`;
  if (momentumPct >= sellThreshold) {
    return { signal: "sell-now", reason: `Up ${momentumPct.toFixed(1)}% in last 30d — over your +${sellThreshold}% target (${compsFragment})` };
  }
  if (momentumPct <= -SIGNAL_BUY_PCT) {
    return { signal: "buy", reason: `Down ${abs.toFixed(1)}% in last 30d (${compsFragment})` };
  }
  if (abs <= SIGNAL_STABLE_BAND_PCT) {
    return { signal: "hold", reason: `Stable (±${SIGNAL_STABLE_BAND_PCT}% in 30d, ${compsFragment})` };
  }
  return { signal: "watch", reason: `${dirWord} ${abs.toFixed(1)}% in 30d — mid-range, monitor (${compsFragment})` };
}

function tokenize(q: string): string[] {
  const raw = String(q ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s#-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 1);
  const expanded: string[] = [];
  for (const t of raw) {
    const alias = SET_ALIASES[t];
    if (alias) expanded.push(...alias);
    else expanded.push(t);
  }
  return expanded.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
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

// In-memory memoization — 5-minute TTL, capped at 128 entries.
// Keyed by (q + all filter params) so identical queries return instantly.
const memoCache = new Map<string, { at: number; result: CanonicalSearchResult }>();
const MEMO_TTL_MS = 5 * 60 * 1000;
const MEMO_CAP = 128;

function memoKey(input: CanonicalSearchInput): string {
  return [
    input.q,
    input.sport ?? "",
    input.limit ?? "",
    input.parallel ?? "",
    input.grade ?? "",
    input.printRun ?? "",
    input.isAuto ?? "",
    input.year ?? "",
  ].join("|");
}

const emptyFacets = (): CanonicalSearchFacets => ({
  parallels: {}, grades: {}, printRuns: {}, years: {}, releaseNames: {},
});

export async function canonicalCardSearch(input: CanonicalSearchInput): Promise<CanonicalSearchResult> {
  const q = String(input.q ?? "").trim();
  const now = new Date();
  const empty: CanonicalSearchResult = {
    q, tokens: [], semanticFilters: { isAuto: null, year: null },
    appliedFilters: { parallel: null, grade: null, printRun: null, isAuto: null, year: null },
    hits: [], groups: [], facets: emptyFacets(), totalCandidates: 0, cachedFromMemory: false,
    confidentSingleResult: false, computedAt: now.toISOString(),
  };
  if (!q) return empty;

  // Cache check
  const cacheK = memoKey(input);
  const cached = memoCache.get(cacheK);
  if (cached && (Date.now() - cached.at) < MEMO_TTL_MS) {
    return { ...cached.result, cachedFromMemory: true };
  }

  const containers = await getContainers();
  if (!containers) return empty;

  const rawTokens = tokenize(q);
  if (rawTokens.length === 0) return empty;

  // Extract semantic hints + resolve explicit filter params. Explicit
  // filters win over hints when both are present.
  let isAutoFilter: boolean | null = input.isAuto ?? null;
  let yearFilter: number | null = input.year ?? null;
  let gradeFilterCompany: string | null = null;
  let gradeFilterValue: number | null = null;
  if (input.grade) {
    const m = String(input.grade).trim().replace(/\s+/g, "").toLowerCase();
    const g = GRADE_ALIAS[m];
    if (g) { gradeFilterCompany = g.company; gradeFilterValue = g.value; }
  }
  const parallelFilter: string | null = input.parallel ? String(input.parallel).toLowerCase() : null;
  let printRunFilter: number | null = input.printRun ?? null;

  const searchTokens: string[] = [];
  for (const t of rawTokens) {
    if (AUTO_TOKENS.has(t)) { isAutoFilter = true; continue; }
    const y = Number(t);
    // CF-VINTAGE-YEAR-RANGE (Drew, 2026-07-26). Was `y >= 1980 && y <= 2030` —
    // that lower bound made vintage years (1961, 1972, 1985, etc.) fall
    // through to the print-run branch and silently corrupt every vintage
    // query. Smoke test 2026-07-26 confirmed: q="nolan ryan 1972 topps"
    // set printRun=1972 (nonsense) and returned 0 hits. Range expanded
    // to 1900-2030 to cover pre-war → ultra-modern. Also short-circuits
    // ambiguity with print-run: any 4-digit token in [1900, 2030] is a
    // year first — real print-runs go up to ~10000 but almost none are
    // in that specific window (Bowman /1000 exists, /1500, /2000 — but
    // print-runs of 1900-2030 are essentially unheard of, and if such a
    // card exists the user can filter via the explicit printRun body
    // param instead of a bare token).
    if (Number.isFinite(y) && y >= 1900 && y <= 2030) { if (yearFilter === null) yearFilter = y; continue; }
    // Print-run token — "/50", "/150", "199" (naked print-run number, 3-4 digits).
    // Loosely: any three- or four-digit standalone number that's not a year.
    const prMatch = t.match(PRINT_RUN_RE);
    if (prMatch) {
      const n = Number(prMatch[1]);
      if (Number.isFinite(n) && n > 0 && n <= 5000 && printRunFilter === null) {
        // Skip common years even without prefix — 2024/2025 would be caught above,
        // but 1990 or 1999 could look like print-runs. Since year is already
        // handled and print-runs > 1980 & <= 2030 are rare, we're safe here
        // because year-check ran first.
        printRunFilter = n;
        continue;
      }
    }
    // Grade tokens (psa10, bgs9.5, gem etc.)
    const g = GRADE_ALIAS[t];
    if (g) {
      if (gradeFilterCompany === null) { gradeFilterCompany = g.company; gradeFilterValue = g.value; }
      continue;
    }
    searchTokens.push(t);
  }

  if (searchTokens.length === 0 && (isAutoFilter === null && yearFilter === null)) return empty;

  // Build query. Prefers ARRAY_CONTAINS(c.searchTokens, @t) — this IS
  // index-accelerated (Cosmos range index on an array field). CONTAINS on
  // a scalar string is NOT (substring lookup can't use the index), so the
  // pre-2026-07-25 CONTAINS(c.searchText, ...) path hit the RU wall on
  // cross-partition scans of card_catalog (866k rows). The old CONTAINS
  // path is kept as fallback for rows that haven't been reached by the
  // searchTokens backfill yet — those rows still work, just slower.
  //
  // See scripts/comp-quality/backfill-search-fields.cjs for how
  // searchTokens is computed (unique alphanum tokens from searchText,
  // hyphen-split included so "cpa" hits "cpa-eha").
  const sport = String(input.sport ?? "baseball").toLowerCase();
  // CF-CATALOG-FIRST-SEARCH-MULTI-SOURCE (Drew, 2026-08-01). Was
  // hardcoded to source='cardsight' which missed 371K CH-source
  // catalog entries (95% of which have images). Include both vendor
  // sources so the fast search covers our full 1.9M-entry catalog.
  const params: Array<{ name: string; value: string | number | boolean }> = [
    { name: "@sport", value: sport },
  ];
  const whereClauses: string[] = ["c.source IN ('cardhedge', 'cardsight')", "c.sport = @sport"];
  if (yearFilter !== null) {
    whereClauses.push("c.year = @year");
    params.push({ name: "@year", value: String(yearFilter) });
  }
  searchTokens.forEach((t, i) => {
    const p = `@t${i}`;
    // Tri-tier: (1) fast ARRAY_CONTAINS on the tokenized field (best);
    // (2) CONTAINS on searchText for rows tokenized-but-not-yet-arrayed;
    // (3) legacy 4-field OR for rows the backfill has never touched.
    whereClauses.push(
      `(` +
        `(IS_DEFINED(c.searchTokens) AND ARRAY_CONTAINS(c.searchTokens, ${p})) OR ` +
        `(NOT IS_DEFINED(c.searchTokens) AND IS_DEFINED(c.searchText) AND CONTAINS(c.searchText, ${p})) OR ` +
        `(NOT IS_DEFINED(c.searchTokens) AND NOT IS_DEFINED(c.searchText) AND ` +
          `(CONTAINS(LOWER(c.player), ${p}, true) OR CONTAINS(LOWER(c.releaseName), ${p}, true) OR CONTAINS(LOWER(c.number), ${p}, true) OR ` +
           `EXISTS(SELECT VALUE 1 FROM par IN c.parallels WHERE CONTAINS(LOWER(par.name), ${p}, true))))` +
      `)`,
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
      const sampleQ = `SELECT TOP 500 c.cardId, c.player, c.releaseId, c.releaseName, c.setName, c.year, c.number, c.parallels, c.attributes, c.sport, c.recentSaleCount, c.searchText FROM c WHERE c.source IN ('cardhedge', 'cardsight') AND c.sport = @sport${yearFilter !== null ? " AND c.year = @year" : ""} AND IS_DEFINED(c.searchText)`;
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

  // CF-SEARCH-SOLD-COMPS-FALLBACK (Drew, 2026-07-26). When card_catalog
  // + fuzzy layer both miss, fall back to sold_comps. Cardsight's crawl
  // coverage has gaps (verified 2026-07-26: 0 rows for 1989 Upper Deck,
  // no 1980 Topps George Brett, etc.) but those cards ARE in sold_comps
  // via CH ingest — 468K fresh pre-1980 comps + long-tail modern gaps.
  // sold_comps rows carry hobbyiqCardId + playerName + cardYear +
  // setName + cardNumber + imageUrl, everything the picker needs.
  //
  // Groups by hobbyiqCardId in-memory + emits picker-hit shape identical
  // to the card_catalog path so iOS gets a uniform response.
  //
  // Only fires when the primary layers returned 0 — no perf regression
  // on common queries. Enrichment loop (recentMedian / momentum /
  // signal) runs AS-IS since it reads sold_comps anyway.
  if (candidates.length === 0 && searchTokens.length > 0) {
    try {
      const scParams: Array<{ name: string; value: string | number | boolean }> = [
        { name: "@sport", value: sport },
      ];
      const scWhere: string[] = ["c.sport = @sport", "IS_DEFINED(c.hobbyiqCardId)", "c.hobbyiqCardId != null"];
      if (yearFilter !== null) {
        scWhere.push("c.cardYear = @y");
        scParams.push({ name: "@y", value: yearFilter });
      }
      // Every search token must appear somewhere in (playerName, setName,
      // cardNumber). No searchText field on sold_comps (yet) so
      // CONTAINS on individual fields is the honest option. This scan
      // is bounded by year+sport when year present, so cost stays in
      // proportion to the era-slice.
      searchTokens.forEach((t, i) => {
        const p = `@st${i}`;
        scWhere.push(
          `(CONTAINS(LOWER(c.playerName), ${p}, true) OR CONTAINS(LOWER(c.setName), ${p}, true) OR CONTAINS(LOWER(c.cardNumber), ${p}, true))`,
        );
        scParams.push({ name: p, value: t });
      });
      const scQuery = `SELECT TOP 500 c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.imageUrl, c.sport, c.soldAt
                       FROM c WHERE ${scWhere.join(" AND ")}
                       ORDER BY c.soldAt DESC`;
      const { resources: scRows } = await containers.sold.items.query({ query: scQuery, parameters: scParams }).fetchAll();
      // Group by hobbyiqCardId — one picker hit per distinct slug.
      // sold_comps has MANY rows per card (each sale) so aggregation is
      // essential.
      const bySlug = new Map<string, any>();
      for (const r of scRows ?? []) {
        const slug = String(r.hobbyiqCardId ?? "");
        if (!slug || bySlug.has(slug)) continue;
        // Reshape into the card_catalog candidate shape so the shared
        // scoring / enrichment loop below handles it uniformly.
        bySlug.set(slug, {
          cardId: null,                                    // no vendor cardId available
          player: r.playerName ?? null,
          releaseId: null,
          releaseName: r.setName ?? null,
          setName: r.setName ?? null,
          year: r.cardYear !== undefined && r.cardYear !== null ? String(r.cardYear) : null,
          number: r.cardNumber ?? null,
          parallels: r.parallel ? [{ id: null, name: r.parallel, numberedTo: r.printRun ?? null }] : [],
          attributes: r.isAuto ? ["auto"] : [],
          sport: r.sport ?? sport,
          recentSaleCount: 0,                             // no popularity boost from sold_comps path
          searchText: [r.playerName, r.setName, r.cardNumber, r.cardYear ?? "", r.parallel ?? ""].filter(Boolean).join(" ").toLowerCase(),
          _origin: "sold-comps-fallback",                 // provenance for debugging
        });
      }
      candidates = [...bySlug.values()];
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
    const matchedRanges: MatchedRange[] = [];
    let scoreBase = 0;
    for (const t of searchTokens) {
      let matchedThis = false;
      const playerHit = player.indexOf(t);
      if (playerHit >= 0) {
        matched.push(t); scoreBase += 4; matchedThis = true;
        matchedRanges.push({ field: "player", start: playerHit, end: playerHit + t.length, token: t });
      } else {
        const parIdx = parallelNames.findIndex((n: string) => n.includes(t));
        if (parIdx >= 0) {
          const start = parallelNames[parIdx].indexOf(t);
          matched.push(t); scoreBase += 3; matchedThis = true;
          matchedRanges.push({ field: "parallels", start, end: start + t.length, token: t });
        } else {
          const rnHit = releaseName.indexOf(t);
          if (rnHit >= 0) {
            matched.push(t); scoreBase += 2; matchedThis = true;
            matchedRanges.push({ field: "releaseName", start: rnHit, end: rnHit + t.length, token: t });
          } else {
            const numHit = number.indexOf(t);
            if (numHit >= 0) {
              // Card-number-shaped tokens (BCP-102, CPA-EH, USC88, #125) are
              // high-signal — bump score so an exact card-number query wins
              // over a generic 4-word text match.
              const looksLikeCardNumber = CARD_NUMBER_RE.test(t);
              const bump = looksLikeCardNumber ? 3 : 1;
              matched.push(t); scoreBase += bump; matchedThis = true;
              matchedRanges.push({ field: "cardNumber", start: numHit, end: numHit + t.length, token: t });
            }
            // Fuzzy fallback — if strict match missed but the searchText was
            // built for this card, allow edit-distance-1 as a partial credit.
            // No range emitted for fuzzy hits (positions aren't well-defined).
            else if (c.searchText && fuzzyContains(String(c.searchText), t)) {
              matched.push(t); scoreBase += 0.5; matchedThis = true;
            }
          }
        }
      }
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
      matchedRanges,
      momentumPct: null,
      recentSaleCount: Number(c.recentSaleCount || 0),
      signal: "watch",                                         // default until enrichment sets it
      signalReason: "Insufficient signal — no recent sales",
      score: finalScore,
    };
  });

  // Only keep hits that match ALL search tokens (AND semantics)
  const requiredCount = searchTokens.length;
  let filtered = scored.filter((h) => h.matchedTokens.length >= requiredCount);

  // Apply explicit filters (parallel/printRun/isAuto). Grade + year are
  // applied later during enrichment because they touch sold_comps.
  if (parallelFilter) {
    filtered = filtered.filter((h) => h.parallels.some((p) => String(p.name).toLowerCase().includes(parallelFilter)));
  }
  if (printRunFilter !== null) {
    filtered = filtered.filter((h) => h.parallels.some((p) => p.numberedTo === printRunFilter));
  }
  if (input.isAuto === true) {
    filtered = filtered.filter((h) => h.isAutographSet);
  } else if (input.isAuto === false) {
    filtered = filtered.filter((h) => !h.isAutographSet);
  }

  // Dedup by hobbyiqCardId — keep highest-scoring per canonical identity
  const byCanonical = new Map<string, CanonicalSearchHit>();
  for (const h of filtered) {
    const key = h.hobbyiqCardId ?? `${h.releaseName}::${h.cardNumber}::${h.player}`;
    const existing = byCanonical.get(key);
    if (!existing || h.score > existing.score) byCanonical.set(key, h);
  }
  const deduped = [...byCanonical.values()].sort((a, b) => b.score - a.score);

  // Facets — compute from the deduped (before top-K slicing) so filter
  // chips reflect the FULL result set, not just the visible page.
  //
  // CF-FACET-KEY-DEDUP (Drew, 2026-07-25). Cardsight ingest carries both
  // "FoilFractor" and "Foilfractor" as distinct parallel-name strings;
  // as raw object keys they split the count across meaningless variants.
  // De-key on lowercase, then use the first casing we see as the display
  // label. Preserves per-row parallel objects (unchanged for hit-level
  // matching); only the facet chip dedupes.
  const facets: CanonicalSearchFacets = emptyFacets();
  const parallelDisplay = new Map<string, string>();       // lowerName → first-seen display
  const releaseDisplay = new Map<string, string>();
  for (const h of deduped) {
    for (const p of h.parallels) {
      if (!p.name) continue;
      const key = String(p.name).toLowerCase();
      if (!parallelDisplay.has(key)) parallelDisplay.set(key, p.name);
      const display = parallelDisplay.get(key)!;
      facets.parallels[display] = (facets.parallels[display] || 0) + 1;
      if (p.numberedTo) {
        const k = `/${p.numberedTo}`;
        facets.printRuns[k] = (facets.printRuns[k] || 0) + 1;
      }
    }
    if (h.cardYear) facets.years[String(h.cardYear)] = (facets.years[String(h.cardYear)] || 0) + 1;
    if (h.releaseName) {
      const rk = h.releaseName.toLowerCase();
      if (!releaseDisplay.has(rk)) releaseDisplay.set(rk, h.releaseName);
      const rdisplay = releaseDisplay.get(rk)!;
      facets.releaseNames[rdisplay] = (facets.releaseNames[rdisplay] || 0) + 1;
    }
  }

  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const topHits = deduped.slice(0, limit);

  // Enrich top hits with imageUrl + recent median from sold_comps
  // (grade-scoped when a grade filter was requested).
  const gradeSuffix = (gradeFilterCompany && gradeFilterValue !== null)
    ? ` AND c.gradeCompany = @gc AND c.gradeValue = @gv`
    : "";
  await Promise.all(topHits.map(async (h) => {
    if (!h.hobbyiqCardId) return;
    try {
      const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
      const params2: Array<{ name: string; value: string | number | null }> = [
        { name: "@slug", value: h.hobbyiqCardId },
        { name: "@from", value: cutoff },
      ];
      if (gradeFilterCompany && gradeFilterValue !== null) {
        params2.push({ name: "@gc", value: gradeFilterCompany });
        params2.push({ name: "@gv", value: gradeFilterValue });
      }
      const { resources: rows } = await containers.sold.items.query({
        query: `SELECT TOP 90 c.price, c.imageUrl, c.soldAt FROM c WHERE c.hobbyiqCardId = @slug AND c.soldAt >= @from${gradeSuffix} ORDER BY c.soldAt DESC`,
        parameters: params2 as { name: string; value: string | number }[],
      }).fetchAll();
      if (rows.length > 0) {
        for (const r of rows) {
          if (r.imageUrl && !h.imageUrl) { h.imageUrl = r.imageUrl; break; }
        }
        const prices = rows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        if (prices.length > 0) h.recentMedian = prices[Math.floor(prices.length / 2)];
        h.compCount = prices.length;
        // Momentum: 30d median vs prior 60d median (percent change).
        // Uses the SAME 90d window we already fetched, no extra query.
        const cutoff30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
        const recent30: number[] = [], prior60: number[] = [];
        for (const r of rows) {
          const price = Number(r.price);
          if (!Number.isFinite(price) || price <= 0) continue;
          if (String(r.soldAt) >= cutoff30) recent30.push(price);
          else prior60.push(price);
        }
        if (recent30.length >= 3 && prior60.length >= 3) {
          const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
          const m30 = med(recent30);
          const m60 = med(prior60);
          if (m60 > 0) h.momentumPct = Math.round(((m30 - m60) / m60) * 1000) / 10;
        }
      }
      // CF-SELL-SIGNAL (Drew, 2026-07-26). Compute after momentumPct +
      // compCount are known. Everything else already computed — this
      // is pure derivation, no additional Cosmos work.
      // Pass through the user's per-request sellThresholdPct so the
      // sell-now boundary reflects their preference (default 15%).
      const sig = computeSellSignal(h.momentumPct, h.compCount, h.recentSaleCount, {
        sellThresholdPct: input.sellThresholdPct,
      });
      h.signal = sig.signal;
      h.signalReason = sig.reason;
      // Grade facet — collect distinct grade tiers from the enriched pool.
      // (Runs even without grade filter so facet chips show all tiers.)
      if (!gradeFilterCompany) {
        const { resources: gradeRows } = await containers.sold.items.query({
          query: "SELECT c.gradeCompany, c.gradeValue FROM c WHERE c.hobbyiqCardId = @slug AND c.soldAt >= @from",
          parameters: [{ name: "@slug", value: h.hobbyiqCardId }, { name: "@from", value: cutoff }],
        }).fetchAll();
        for (const g of gradeRows) {
          const label = g.gradeCompany ? `${g.gradeCompany} ${g.gradeValue}` : "Raw";
          facets.grades[label] = (facets.grades[label] || 0) + 1;
        }
      }
    } catch { /* enrichment optional */ }
  }));

  // Grouped-results view: cluster hits by (player, year, cardNumber) so
  // iOS can render "Eric Hartman 2026 Bowman #CPA-EH — 14 variants" collapsed.
  const groupsMap = new Map<string, CanonicalSearchGroup>();
  for (const h of topHits) {
    const key = `${(h.player ?? "?").toLowerCase()}|${h.cardYear ?? "?"}|${(h.cardNumber ?? "?").toLowerCase()}`;
    let g = groupsMap.get(key);
    if (!g) {
      g = { groupId: key, player: h.player, cardYear: h.cardYear, releaseName: h.releaseName, cardNumber: h.cardNumber, variantCount: 0, hits: [] };
      groupsMap.set(key, g);
    }
    g.hits.push(h);
    g.variantCount = g.hits.length;
  }
  const groups = [...groupsMap.values()];

  // Confident-single-result: top hit's score is >=3x runner-up, and it has
  // real comp backing (compCount >= 3). iOS uses this to auto-jump.
  const confidentSingleResult =
    topHits.length >= 1 &&
    (topHits.length === 1 || topHits[0].score >= 3 * topHits[1].score) &&
    (topHits[0].compCount ?? 0) >= 3;

  const result: CanonicalSearchResult = {
    q,
    tokens: rawTokens,
    semanticFilters: { isAuto: isAutoFilter, year: yearFilter },
    appliedFilters: {
      parallel: parallelFilter,
      grade: gradeFilterCompany && gradeFilterValue !== null ? `${gradeFilterCompany} ${gradeFilterValue}` : null,
      printRun: printRunFilter,
      isAuto: input.isAuto ?? null,
      year: input.year ?? null,
    },
    hits: topHits,
    groups,
    facets,
    totalCandidates: candidates.length,
    cachedFromMemory: false,
    confidentSingleResult,
    computedAt: now.toISOString(),
  };

  // Cache the result. Cap eviction: oldest entry drops when we hit MEMO_CAP.
  if (memoCache.size >= MEMO_CAP) {
    const oldestKey = memoCache.keys().next().value;
    if (oldestKey) memoCache.delete(oldestKey);
  }
  memoCache.set(cacheK, { at: Date.now(), result });

  return result;
}
