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

import { canonicalCardName } from "./canonicalCardName.js";
import { CosmosClient, type Container } from "@azure/cosmos";
import {
  verifiedCatalogSqlClause,
  provisionalCatalogSqlClause,
} from "./catalogVisibility.js";
// Same normaliser the slug generator uses, so "Bowman Draft" here and
// "bowman-draft" in a slug are compared as the one thing they are.
import { cardNumberInClause, normalizeSetKey, sameCardNumber } from "../portfolioiq/hobbyIqCardId.service.js";
// CF-SEARCH-FULL-NAME-DOMINATES: the product PARENT walk (D23 table), so a
// "bowman" query can recognise bowman-draft as one family step away.
import { productAncestry, productEntry } from "./productSetKeys.js";
import { authorityRank, catalogAuthorityOf, type CatalogAuthority } from "./catalogAuthority.service.js";
import { foldSpelling } from "./parallelSpellingFold.js";

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

/**
 * CF-CATALOG-SEARCH-TIME-BUDGET (2026-08-21). Test-only container injection.
 *
 * The budget is a wall-clock behaviour of the escalation LADDER — which rungs
 * get skipped, and what is returned when they are — so mirroring the rules in
 * a test file would pin a copy of the logic rather than the logic. Injecting a
 * fake container lets the real searchCatalog run against slow/fast stubs.
 *
 * Pass null to restore normal resolution.
 */
export function __setCatalogContainerForTest(c: Container | null): void {
  _container = c;
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
  /** CF-SEARCH-ANCHOR-FROM-PARSER (2026-08-21). The player as already
   *  resolved by parseCardQuery. When present it decides the anchor,
   *  instead of re-guessing it from raw tokens. See the anchor block. */
  playerName?: string | null;
  /** CF-SEARCH-RANK-AGAINST-THE-HOLDING (Drew, 2026-08-23: "that search should
   *  put best matches at the top").
   *
   *  When the search is being used to IDENTIFY a specific card the user already
   *  owns — the review queue's search-and-pick — we know more than the typed
   *  query. Token overlap alone cannot use that: it ranks a 2024 card and a
   *  2025 card identically when both share a player name.
   *
   *  Pass what the import already parsed and matching hits float up. This lives
   *  here rather than in each client on purpose: iOS and web would otherwise
   *  each grow their own idea of "best", and two copies of a ranking rule drift
   *  — which is exactly what happened to the player-name matcher this week. */
  context?: {
    cardNumber?: string | null;
    year?: number | null;
    setName?: string | null;
    playerName?: string | null;
    isAuto?: boolean | null;
  } | null;
}

export interface CatalogSearchHit {
  slug: string;               // canonical hobbyiqCardId
  /** The one display format, computed per request:
   *  "2025 Bowman Draft Baseball Chrome Prospect Autographs #CPA-EW Eli Willits Yellow Refractor /75"
   *  Segments are omitted when absent — no print run means the string just ends. */
  displayName: string;
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
  /** "psa-10", "csg-10", … — non-empty on a graded twin. Carried so the
   *  ungraded-wins collapse tests a FIELD instead of enumerating grader names
   *  in a slug regex, which is how csg-10 leaked through as a pickable card. */
  gradeTier: string | null;
  /** The row's own `source` string, passed through verbatim. */
  source: string | null;
  /** D33: what this row is ALLOWED to decide, derived from `source` by the one
   *  classifier (catalogAuthorityOf). The picker draws its checklist badge from
   *  this and both clients rank on it, so "is this a real checklist card or a
   *  row we minted off a sale?" has ONE answer computed in ONE place. The web
   *  previously had no way to ask: `source` was SELECTed and then dropped here,
   *  so a `sold-comps-stub` row and a Beckett row rendered identically. */
  authority: CatalogAuthority;
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
  /** CF-CATALOG-SEARCH-TIME-BUDGET (2026-08-21): true when the search ran
   *  out of its wall-clock budget and returned the candidates it had
   *  already collected instead of finishing the escalation ladder. The
   *  hits are real, the set may be incomplete. Never silently empty — a
   *  caller that cannot distinguish "no such card" from "we gave up" will
   *  cache the wrong answer. */
  timedOut?: boolean;
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
 *  checklist authority, then score. */
function preferHit(a: CatalogSearchHit, b: CatalogSearchHit): boolean {
  // D33: GRADED IS EITHER SIGNAL, BECAUSE NEITHER ONE IS COMPLETE.
  //
  // The old test was a slug regex enumerating raw|psa|bgs|sgc|cgc — an
  // allowlist of grader names, the same decaying-allowlist trap that
  // catalogAuthority.service.ts documents for source strings. CSG, HGA and TAG
  // were absent, so those rows read as UNGRADED, tied with their ungraded twin
  // on identical identity fields, and won the tie by arrival order. Live: the
  // "Find this card" page for 2020 Bowman Draft BD-152 offered
  // `…:bd-152:refractor:no-auto:csg-10` as pick #6 — a graded slug presented as
  // the card, which is exactly what the comment below says must not happen
  // (comps hang off the UNGRADED slug, so picking it pins the holding to a row
  // with an empty market panel).
  //
  // The obvious fix — read the `gradeTier` FIELD instead, now that it is
  // SELECTed — trades one leak for another. Measured read-only 2026-08-30:
  // 583 rows with a `:psa-` slug and 784 in total carry NO gradeTier at all, so
  // a field-only test would have made those pickable. The field catches the
  // graders the regex forgot; the slug catches the rows the field forgot.
  // Either signal means graded, and a false positive here is cheap — it only
  // decides which of two rows for ONE identity represents it.
  const GRADED_SLUG = /:(raw|psa|bgs|sgc|cgc|csg|hga|tag|isa|ace|gma|pgs)(-|$)/;
  const graded = (x: CatalogSearchHit) => (x.gradeTier || GRADED_SLUG.test(x.slug) ? 1 : 0);
  const vendor = (x: CatalogSearchHit) => (x.slug.startsWith("hiq:") ? 0 : 1);
  if (graded(a) !== graded(b)) return graded(a) < graded(b);
  if (vendor(a) !== vendor(b)) return vendor(a) < vendor(b);
  // A checklist row represents the card over a derived twin carrying the same
  // identity fields — a row we minted from a sale never speaks for a card when
  // a transcribed checklist row is standing right next to it.
  const ra = authorityRank(a.source), rb = authorityRank(b.source);
  if (ra !== rb) return ra > rb;
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
 * question. Matching is fuzzy per token (CF-SEARCH-FUZZY-PLAYER), so
 * "gonzales" still covers Gonzalez without escalating.
 *
 * That example used to read "erik" still covers Eric. It does not, and never
 * did: fuzzyIncludes bails on tokens under 5 chars ("too short to risk a fuzzy
 * hit"), so a 4-char misspelling escalates. Corrected 2026-08-21 rather than
 * changing the threshold, which is a deliberate false-positive guard.
 *
 * CF-ESCALATE-ON-NAME-TOKENS-ONLY (2026-08-21). `nameTokens` must be tokens
 * of the PLAYER NAME. Every example above is a name-only query, and the
 * predicate compares each token against `playerName` alone — so any token
 * that is not part of a person's name makes this UNSATISFIABLE and forces an
 * escalation that can never be avoided. The call site used to pass every
 * >=4-char non-brand token, which includes every colour and finish word.
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

/**
 * CF-CATALOG-SEARCH-TIME-BUDGET (2026-08-21).
 *
 * Two comments in this file already reason about "the 20s budget" as though
 * it were enforced. It never was — there is no timeout, no AbortSignal and no
 * deadline anywhere in the escalation ladder, so a query that falls through
 * to the unindexed CONTAINS fallbacks runs until Cosmos is done with it.
 * Measured in prod over 6h on 2026-08-21, catalogMs:
 *
 *     p50 2.3s   p95 556s   max 727s
 *
 * 727s is twelve minutes. Nobody is still waiting; the client gave up long
 * ago. But the query keeps burning RUs and holding an event-loop slot, and
 * that combination is exactly what starved the box earlier today. An
 * abandoned request that still costs full price is worse than a truncated
 * answer.
 *
 * So: enforce the budget the comments already assume. Every query in the
 * ladder shares one AbortController, and each escalation is skipped once the
 * deadline has passed. On expiry we return the candidates already collected
 * and set `timedOut` — partial and labelled, never silently empty.
 *
 * AbortSignal rather than Promise.race on purpose: racing leaves the Cosmos
 * query running server-side, which does nothing for the RU burn that is the
 * actual damage. Same idiom as watchlistStore.service and ops.routes.
 */
const SEARCH_BUDGET_MS = Math.max(
  1000,
  Number(process.env.CATALOG_SEARCH_BUDGET_MS ?? 20_000) || 20_000,
);

/** Pure helpers, exported for tests only. */
export const __testables = {
  fold, editDistance, fuzzyIncludes, dedupeKey, preferHit,
  // CF-ESCALATE-ON-NAME-TOKENS-ONLY (2026-08-21). Exposed so the escalation
  // decision is pinned directly: it is the difference between a 1.5s exact
  // arm and a 16.6s prefix scan, and it was silently unsatisfiable.
  nameTokensCovered,
};

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
/** Brand and product-line words. A query token in this set names the
 *  PRODUCT being searched for; the hit's set text must account for every one
 *  of them. Deliberately NOT the anchor stopword list: that list also carries
 *  sport words ("baseball") and finish words ("base", "refractor", "auto"),
 *  which name no product and must never narrow one. */
export const PRODUCT_WORDS = new Set([
  "bowman", "topps", "panini", "leaf", "upper", "deck", "fleer", "donruss", "score",
  "chrome", "prizm", "select", "optic", "mosaic", "heritage", "sapphire", "finest",
  "sterling", "inception", "platinum", "stadium", "club", "gallery", "archives",
  "allen", "ginter", "gypsy", "queen", "immaculate", "obsidian", "contenders",
  "prospect", "prospects", "update", "series", "draft", "mega", "jumbo",
  // CF-THE-ID-CARRIES-THE-PRODUCT (D23): the Leaf lines the id now carries
  // ("leaf metal" must not fill the page with Leaf Vivid).
  "vivid", "metal",
]);

/** CF-SEARCH-PRODUCT-NARROWS (Drew, 2026-08-16: "any 2018 bowman chrome
 *  ohtani, NOT other years"). With the year pinned in SQL, the PRODUCT still
 *  has to narrow, or "2018 bowman chrome ohtani" fills the page with topps,
 *  bowmans-best and donruss-optic. Require the row's set text to account for
 *  ALL the product words the query said ("bowman chrome" keeps bowman-chrome
 *  and bowman-chrome-sapphire, drops bare bowman and topps-chrome); fall back
 *  to ANY, then to no narrowing, so an unindexed product never empties the
 *  page (the rule narrowToRequestedVariants follows).
 *
 *  CF-A-SPORT-IS-NOT-A-PRODUCT (2026-08-29, identity triangulation re-run:
 *  search -> same card 42.0%). The product words used to be the anchor
 *  stopwords, which include "baseball" and "base". "2025 Bowman Draft Baseball
 *  #BD-143 Base" then demanded a set text containing "baseball": the Beckett
 *  Base row (setName "Bowman Draft", the top score) was dropped and a
 *  "Base Cards" row whose setName says "...Baseball" survived. Same shape for
 *  "#TCA-ARU Base" -> topps-chrome-black. Product words are PRODUCT_WORDS. */
export function narrowToNamedProduct<H extends { setKey?: string | null; setName?: string | null }>(
  tokens: string[],
  hits: H[],
): H[] {
  const productTokens = tokens.filter((t) => /^[a-z]+$/.test(t) && PRODUCT_WORDS.has(t));
  if (productTokens.length === 0) return hits;
  const setTextOf = (h: H) => `${h.setKey ?? ""} ${h.setName ?? ""}`.toLowerCase();
  const all = hits.filter((h) => productTokens.every((t) => setTextOf(h).includes(t)));
  if (all.length > 0) return all;
  const any = hits.filter((h) => productTokens.some((t) => setTextOf(h).includes(t)));
  return any.length > 0 ? any : hits;
}

const ANCHOR_STOPWORDS = new Set([
  "bowman", "topps", "panini", "leaf", "upper", "deck", "fleer", "donruss", "score",
  "chrome", "prizm", "select", "optic", "mosaic", "heritage", "sapphire", "finest",
  "sterling", "inception", "platinum", "stadium", "club", "gallery", "archives",
  "allen", "ginter", "gypsy", "queen", "immaculate", "obsidian", "contenders",
  "refractor", "fractor", "prizms", "auto", "autograph", "autographs", "rookie",
  "prospect", "prospects", "paper", "update", "series", "draft", "mega", "jumbo",
  "base", "insert", "parallel", "variation", "numbered", "card", "cards",
  "baseball", "basketball", "football", "hockey", "soccer", "wrestling",
  // CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30): grade words, so "psa 10"
  // cannot become a name token now that three-letter tokens qualify.
  "psa", "bgs", "sgc", "cgc", "hga", "csg", "tag", "gem", "mint", "raw", "rc", "graded", "slab",
]);

// CF-SEARCH-A-LISTING-IS-NOT-A-NAME (2026-09-03, identity triangulation
// re-run: search -> same card 42.0%, and TEN of the search misses were
// "(no hit)" on a card whose catalog row exists and scores fine).
//
// Every one of these tokens becomes a REQUIRED name token: `nameTokens`
// falls back to `alphaTokens` whenever the caller passes no parsed
// playerName (the triangulation harness, and every raw-title caller),
// and `armExactAll` ANDs one ARRAY_CONTAINS per token. A word the
// catalog does not put on the card is then a word no row can satisfy.
//
// Measured on "Freddie Freeman 2025 Bowman Chrome #33 Los Angeles
// Dodgers FREE SHIPPING" (read-only, card_catalog):
//
//   freddie AND freeman                34,215 rows
//   freddie AND freeman AND dodgers        20 rows
//   freddie AND freeman AND shipping        1 row
//
// -> armExactAll returned 0, armFuzzyAll ANDs the same prefixes and also
// returned 0, and the search reported "no such card" for a card sitting
// in the catalog with a full searchTokens array. Dropping the trailing
// " Los Angeles Dodgers FREE SHIPPING" from the SAME query returned it
// as the top hit, which is the whole bug in one A/B.
//
// The team names are the subtle half: they DO occur in searchTokens
// (dodgers 4,081 rows) so they are not "absent" words -- they are words
// the catalog carries on a small minority of rows, which is precisely
// what makes ANDing them lethal. A listing says the team; the checklist
// row usually does not. Neither is wrong, so the query must not require
// agreement. They stay full scoring signals -- this list only governs
// the anchor and the ANDed SQL arms, never the score.
// Team nicknames, as a listing writes them. City words ("los", "angeles",
// "san", "new", "york") are covered above or are too short to qualify.
const LISTING_NOISE = new Set([
  // Marketplace boilerplate. None of it can identify a card, and each one
  // ANDed into SQL removes rows that ARE the card.
  "free", "shipping", "ship", "ships", "shipped", "lot", "lots", "bundle",
  "see", "scan", "scans", "pic", "pics", "photo", "photos", "look",
  "combined", "buy", "sell", "deal", "offer", "offers", "bid", "listing",
  "condition", "excellent", "sharp", "clean", "mint",
  "mlb", "nba", "nfl", "nhl", "milb", "nwsl", "wnba",
  // Team nicknames a listing appends and a checklist row usually omits.
  //
  // DELIBERATELY OMITTED, though every one of them is also a team: the
  // words that are a real playerName token or a real set word. Measured
  // read-only against card_catalog before trusting this list --
  //
  //   royals    4,000 playerName rows   "Jalen Royals" is a person
  //   giants    2,718                   and 44 setKeys
  //   cardinals 2,783                   and 48 setKeys
  //   angels    2,141                   Angels is also a set word
  //   athletics 2,103
  //   kings     1,550 playerName rows, 44,279 setKeys (Diamond Kings)
  //   rare        804                   "Nick Kurtz Black Rare", and
  //                                     Pokemon's "Rare Candy"
  //   york     12,508                   "Nick Yorke" -- exact-token
  //                                     matching spares Yorke, but "York"
  //                                     alone still names New York cards
  //   bay      14,365                   "Bayron Lora", "Kuribayashi"
  //   new      24,224                   "Newman", "Newcomb", "Newton"
  //
  // A word that names a card is not noise, however often a listing also
  // uses it as decoration. What is left below is unambiguous.
  "yankees", "dodgers", "orioles", "reds", "rays", "rockies", "mariners",
  "pirates", "jays", "sox", "braves", "guardians", "marlins", "twins",
  "astros", "brewers", "rangers", "padres", "phillies", "mets",
  "nationals", "cubs", "tigers", "diamondbacks", "dbacks",
  // City words, under the same rule and the same check. "Los Angeles" alone
  // still cut freddie+freeman from 34,215 rows to 17, so leaving the cities
  // out would have left the bug half-fixed. Only cities that are never a
  // given name or a surname in card_catalog are listed -- measured, and the
  // omissions are the point:
  //
  //   francisco   "Francisco Lindor", "Francisco Liriano"
  //   diego       "Diego Cartaya"
  //   louis       "Louis Oliver"
  //   boston      "Aliyah Boston", "Boston Bateman"
  //   washington  "Claudell Washington"
  //   denver      "Denver" appears inside team text only, but the surname
  //               risk is the same shape, so it is left in play
  "angeles", "cincinnati", "milwaukee", "pittsburgh", "seattle", "toronto",
  "atlanta", "houston", "philadelphia", "baltimore", "minnesota", "colorado",
  "arizona", "cleveland", "miami", "tampa", "oakland",
]);
// A MISSPELLED product word is still a product word. "2026 bowmen owen carey"
// put "bowmen" (6) ahead of "carey" (5) on length, anchored the whole search
// on the brand, and returned nothing at all. Stopwords are therefore matched
// by bounded edit distance, the same tolerance the player scorer uses. Only
// for tokens of 5+ so short words are never absorbed by a longer stopword.
// LISTING_NOISE is matched EXACTLY, never by edit distance. The fuzzy rule
// exists so a misspelled BRAND is still read as a brand, and brands are a
// closed set a collector types deliberately. Listing noise is not: at
// distance 1 "rays" absorbs the Homestead "Grays" and "ship" absorbs the
// surname "Shipp", which would drop a real name token instead of a stray
// word. Product words keep the tolerance they were given.
const isStopword = (t: string) =>
  ANCHOR_STOPWORDS.has(t)
  || LISTING_NOISE.has(t)
  || (t.length >= 5 && [...ANCHOR_STOPWORDS].some((w) =>
    Math.abs(w.length - t.length) <= 1 && editDistance(w, t, 1) <= 1));
// CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30): three letters qualify. "max"
// was under the old four-letter floor, so "2025 bowman refractor auto max
// williams" reached Cosmos as "williams" alone -- 37,614 verified rows for
// 2025, sampled at TOP 2000 with no ORDER BY, and the card was not in the
// sample. Every one of the 597 Max Williams rows carries "max".
/**
 * The tokens of a query that may stand for a PLAYER NAME: the words left once
 * brands, product lines, finishes, grades and marketplace noise are removed.
 *
 * Exported because these tokens are ANDed into Cosmos one ARRAY_CONTAINS
 * apiece (`armExactAll`), so a single wrong word here does not merely
 * misrank a page -- it empties it. That failure mode is invisible to
 * `scoreCatalogRow`, which never sees the rows the SQL refused to fetch, and
 * it is exactly the shape CF-SEARCH-A-LISTING-IS-NOT-A-NAME found. Pinned in
 * searchAListingIsNotAName.test.ts.
 */
export function nameCandidateTokens(tokens: readonly string[]): string[] {
  return tokens.filter(
    (t) => /^[a-z]+$/.test(t) && t.length >= 3 && !isStopword(t),
  );
}

/** The row's scoring, as a pure function so the identity triangulation
 *  harness and its tests can hold it to account.
 *
 *  CF-CATALOG-SCORING-MULTI-FIELD (Drew, 2026-08-06): weighted matches across
 *  playerName (3.0) / searchTokens (2.0) / setKey, year, parallel (1.5) /
 *  cardNumber (1.0), normalised by tokens x 3.0.
 *  CF-SEARCH-EXACT-CARD-WINS (Drew, 2026-08-16): an exact card number is an
 *  identifier, +1.0; a named parallel word +0.15.
 *  CF-SEARCH-SAYS-WHAT-IT-MEANS (2026-08-29, identity triangulation baseline:
 *  search -> same card 30.5%). Three failures, one cause -- a row was rewarded
 *  for words the query never said:
 *    "#217 X-Fractor"   -> topps-chrome-PLATINUM-ANNIVERSARY ... topps-refractor
 *    "#BD-143 Base"     -> base-cards, not Base
 *    "#TCA-ARU Base"    -> topps-chrome-BLACK #CBA-MR
 *  So: a set-key token the query does not name costs -0.25 each (cap -0.5); a
 *  parallel word the query does not name costs -0.2 each (cap -0.4); a query
 *  that says "base" or names no finish prefers the Base row (+0.3); and a
 *  one-character token matches only by equality, never by substring.
 *  CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30, Drew's edit-card search for
 *  "2025 bowman refractor auto max williams" returned Carson Williams Pearl
 *  Refractor and no Max Williams at all). Even with the right row in the
 *  candidate set the scorer ranked it second: the per-token player match paid
 *  +0.167 for "max", while the flat set penalty charged -0.25 for the family
 *  refinement "draft" under a "bowman" query -- so an exact-product row
 *  WITHOUT the player beat the family row WITH the full name. "auto" was a
 *  stop word worth nothing, so the auto twin tied its no-auto twin; and a
 *  bare "refractor" earned "Pearl Refractor" the named-parallel bonus. So:
 *    - every word of the row's player name in the query (particles and
 *      suffixes aside)                                            +0.5
 *    - an unnamed set word whose product ANCESTRY the query names in full
 *      ("bowman" for bowman-draft, "topps chrome" for topps-chrome-update-
 *      series) costs -0.1 per family rung instead of -0.25 per word; a
 *      product with no named ancestor keeps the full penalty
 *    - the named-parallel bonus needs EVERY colour/pattern word of the
 *      parallel in the query, so a bare "refractor" rewards no colour; the
 *      finish suffix itself is never required, so a bare "gold" still names
 *      Gold Refractor (Colour == Colour Refractor; the catalog keeps the
 *      long form). Once the colour IS named the suffix is not an unnamed
 *      word either, so it costs nothing -- otherwise the colour row cleared
 *      Base only by 0.5/n - 0.05, which vanishes at ten query tokens
 *    - "auto" in the query (or isAuto on the request): auto row +0.15, any
 *      other row -0.3; a query silent on auto changes nothing
 *    - the query's year token is never an exact card number ("#2025")
 *  Net order: exact product with the player > family product with the player
 *  > exact product without the player. */
export function scoreCatalogRow(
  tokens: string[],
  r: { playerName?: string | null; setKey?: string | null; setName?: string | null; setNameFromSet?: string | null; cardNumber?: string | null; year?: number | null; parallel?: string | null; parallelSlug?: string | null; searchTokens?: string[] | null; isAuto?: boolean | null },
  opts: { isAuto?: boolean | null; year?: number | null } = {},
): { score: number; hitFields: number } | null {
  const rowTokens = new Set((r.searchTokens ?? []).map((t) => String(t).toLowerCase()));
  const rowPlayer = String(r.playerName ?? "").toLowerCase();
  const rowSet = String(r.setKey || r.setName || r.setNameFromSet || "").toLowerCase();
  const rowNumber = String(r.cardNumber ?? "").toLowerCase();
  const rowYear = r.year != null ? String(r.year) : "";
  const rowParallel = String(r.parallel ?? "").toLowerCase();
  const rowParallelSlug = String(r.parallelSlug ?? "").toLowerCase();
  const sub = (hay: string, t: string) => (t.length <= 1 ? hay === t || hay.split(/[\s-]+/).includes(t) : hay.includes(t));
  let raw = 0;
  let hitFields = 0;
  for (const t of tokens) {
    let tokenMax = 0;
    if (rowPlayer && sub(rowPlayer, t)) tokenMax = Math.max(tokenMax, 3.0);
    else if (rowPlayer && t.length > 1 && fuzzyIncludes(rowPlayer, t)) tokenMax = Math.max(tokenMax, 2.5);
    if (rowTokens.has(t)) tokenMax = Math.max(tokenMax, 2.0);
    if (rowSet && sub(rowSet, t)) tokenMax = Math.max(tokenMax, 1.5);
    if (rowYear && rowYear === t) tokenMax = Math.max(tokenMax, 1.5);
    if (rowParallel && sub(rowParallel, t)) tokenMax = Math.max(tokenMax, 1.5);
    if (rowParallelSlug && sub(rowParallelSlug, t)) tokenMax = Math.max(tokenMax, 1.5);
    if (rowNumber && sub(rowNumber, t)) tokenMax = Math.max(tokenMax, 1.0);
    if (tokenMax > 0) hitFields++;
    raw += tokenMax;
  }
  const maxPossible = tokens.length * 3.0;
  let score = maxPossible > 0 ? raw / maxPossible : 0;
  const queryTokens = new Set(tokens);
  // Hyphen-split, so "x-fractor" names both "x" and "fractor" and a typed
  // "bowman-draft" names both set words.
  const queryWords = new Set(tokens.flatMap((t) => t.split("-")).filter(Boolean));
  // The year the query is scoped to. A cardNumber that happens to equal it
  // ("Savion Williams Freshman #2025") is not the card the user numbered.
  const yearToken = opts.year != null
    ? String(opts.year)
    : (tokens.find((t) => /^(?:19|20)\d{2}$/.test(t) && Number(t) <= 2035) ?? null);
  const numberIsExact = rowNumber.length > 0 && tokens.some((t) => t === rowNumber && t !== yearToken);
  if (numberIsExact) score += 1.0;
  // CF-A-SPELLING-IS-NOT-A-SECOND-CARD, applied to RANKING (2026-09-03).
  // `foldSpelling` already exists as the catalog's answer to "are these two
  // strings the same rung spelled by two scrapers?" (D31), but only the
  // dedup lane consulted it -- search still scored the raw string, so the
  // scraper spelling that repeats the finish outscored the canonical row by
  // carrying the word twice:
  //
  //   q "…#16 Yellow Refractor 74/75"
  //     yellow-refractor             <- the checklist row, and the miss
  //     yellow-refractors-refractor  <- beckett's section-plural, and the hit
  //
  //   q "…Superfractors #23 … 1/1"
  //     superfractor                 <- the checklist row, and the miss
  //     superfractors-refractor      <- and the hit
  //
  // Both pairs fold to ONE key, so neither is a different card and the query
  // named the rung either way. Scoring the folded words costs the duplicate
  // spelling its bonus token without rewarding or punishing either row for
  // which scraper wrote it -- the tie is then broken by the rules that
  // already exist (authority, and the unnamed-set penalty). This is a
  // comparison only; nothing here renames a row or is written back.
  const foldedParallel = foldSpelling(rowParallelSlug || rowParallel);
  const parallelWords = foldedParallel ? foldedParallel.split(/[\s-]+/).filter(Boolean) : [];
  const isBaseRow = !rowParallel || rowParallel === "base";
  // The named-parallel bonus needs every non-finish word of the parallel in
  // the query: "Refractor" under "refractor" earns it, "Pearl Refractor" does
  // not -- the query never said pearl. The finish SUFFIX is not such a word:
  // a bare colour names its Refractor (Colour == Colour Refractor, the
  // catalog keeps the long form), so "Gold Refractor" under "gold" earns it
  // too. Only the colour or pattern has to be said.
  const namedParallelWords = parallelWords.filter((w) => !FINISH_STOP.has(w) && !PARALLEL_FINISH_SUFFIX.has(w));
  if (parallelWords.length
      && parallelWords.some((w) => queryWords.has(w))
      && namedParallelWords.every((w) => queryWords.has(w))) score += 0.15;
  // words the query never said
  const setWords = rowSet.split(/[\s-]+/).filter((w) => w && !/^\d{4}$/.test(w));
  const setNamedByWord = setWords.some((w) => queryWords.has(w));
  // A set the query reached only by SUBSTRING -- "bowman" inside "bowmans-
  // best" -- is a set the query never named: the per-token loop paid it the
  // set weight as if it were the product asked for, and no word penalty ever
  // fired. Every word of such a set is unnamed; the family step below still
  // applies when the table says it is a refinement of the product named.
  const setMatchedBySubstring = !setNamedByWord
    && tokens.some((t) => PRODUCT_WORDS.has(t) && rowSet.includes(t));
  if (setNamedByWord || setMatchedBySubstring) {
    const unnamedSet = setWords.filter((w) => !queryWords.has(w)).length;
    if (unnamedSet > 0) {
      // A refinement of a product the query DID name is a family step, not a
      // word the query never said: "bowman" reaches bowman-draft one rung
      // down. A product whose ancestry the query never names (topps-chrome-
      // platinum-anniversary under "topps chrome") keeps the full penalty.
      const steps = familyStepsToNamedAncestor(r.setKey || rowSet, queryWords);
      score -= steps > 0 ? Math.min(0.5, 0.1 * steps) : Math.min(0.5, 0.25 * unnamedSet);
    }
  }
  // The finish SUFFIX is excluded from the unnamed set by the SAME rule that
  // excludes it from namedParallelWords -- once the query has named the
  // colour or pattern, "refractor" is not a word the user had to say. Without
  // this the colour row paid -0.2 for a suffix it was never charged for
  // naming, and outranked Base only by the raw parallel-field token, worth
  // 1.5/(3n): margin 0.5/n - 0.05, which is ZERO at ten query tokens and
  // negative beyond. Measured: "2024 bowman chrome leo de vries blue bcp-179
  // padres rc" (10 tokens) tied Blue Refractor with Base at 1.9833, and a
  // 13-token variant put Base ahead. The suffix is forgiven only when some
  // OTHER word of the parallel is named, so a bare "refractor" still pays for
  // the colour in "Pearl Refractor", and a query naming no finish at all
  // leaves Base its +0.3 and the win.
  const queryNamesAParallelWord = namedParallelWords.some((w) => queryWords.has(w));
  const unnamedParallel = parallelWords.filter((w) =>
    !queryWords.has(w)
    && !FINISH_STOP.has(w)
    && !(queryNamesAParallelWord && PARALLEL_FINISH_SUFFIX.has(w))).length;
  if (!isBaseRow) score -= Math.min(0.4, 0.2 * unnamedParallel);
  const queryNamesAFinish = tokens.some((t) => !FINISH_STOP.has(t) && CATALOG_FINISH_WORDS.has(t));
  if (isBaseRow && (queryTokens.has("base") || !queryNamesAFinish)) score += 0.3;
  // The FULL player name. Per-token matching already pays 3.0 a token, but
  // normalised by the query length that is +0.167 for "max" -- less than one
  // family step used to cost. When the query names every word of the row's
  // player, that is the person being asked for, and it dominates.
  const nameWords = fold(rowPlayer).split(/[\s-]+/).filter((w) => w.length >= 2 && !NAME_PARTICLES.has(w));
  if (nameWords.length >= 2 && nameWords.every((w) => nameWordNamed(w, queryWords))) score += 0.5;
  // Auto is honoured when the query says it; a query silent on auto must not
  // push the autos down the page (CF-SEARCH-CHECKLIST-OPTIONS).
  const querySaysAuto = opts.isAuto === true || tokens.some((t) => AUTO_WORDS.has(t));
  if (querySaysAuto) score += r.isAuto === true ? 0.15 : -0.3;
  if (hitFields < Math.max(1, Math.ceil(tokens.length / 2))) return null;
  return { score, hitFields };
}

/** Parallel words that name a finish rather than a colour or pattern; they
 *  are never "unnamed" and never earn the named-parallel bonus on their own. */
const FINISH_STOP = new Set(["base", "card", "cards", "rc", "rookie", "auto", "autos", "autograph", "autographs", "psa", "bgs", "sgc", "gem", "mint", "nm"]);

/** The finish SUFFIX of a parallel name -- the word after the colour or
 *  pattern that the checklist writes and the hobby drops. A bare colour in a
 *  query names its Refractor/Prizm (Colour == Colour Refractor, per card, the
 *  catalog keeping the long form), so the suffix is never a word the query
 *  had to say -- neither for the named-parallel bonus nor for the unnamed
 *  penalty, ONCE some other word of the parallel is named. Under a bare
 *  "refractor" no other word is named, so "Gold Refractor" still pays for
 *  "gold" and the plain "Refractor" row outranks it; "Pearl Refractor" still
 *  needs "pearl". Patterns
 *  ("wave", "x-fractor", "mojo") are NOT suffixes -- "gold" does not name
 *  Gold Wave Refractor. */
const PARALLEL_FINISH_SUFFIX = new Set(["refractor", "refractors", "prizm", "prizms"]);

/** How a query says "auto". */
const AUTO_WORDS = new Set(["auto", "autos", "autograph", "autographs", "autographed"]);

/** Particles and suffixes inside a player name that a query need not repeat
 *  for the full-name bonus: "Leo De Vries" is named by "leo vries". */
const NAME_PARTICLES = new Set(["jr", "sr", "ii", "iii", "iv", "de", "da", "di", "del", "der", "du", "la", "le", "van", "von", "dos", "das", "st"]);

/** Is this word of the row's player name in the query -- exactly, or within
 *  the same bounded edit distance fuzzyIncludes allows (5+ letters only)?
 *  The budget is keyed on the SHORTER of the two words, as fuzzyIncludes
 *  keys it on the query token: keyed on the row word, "williams" (8, budget
 *  2) accepted "willis" and Max Williams took the full-name bonus for a
 *  query that asked for Max Willis. */
function nameWordNamed(word: string, queryWords: Set<string>): boolean {
  if (queryWords.has(word)) return true;
  if (word.length < 5) return false;
  for (const q of queryWords) {
    const shorter = Math.min(q.length, word.length);
    if (shorter < 5) continue;
    const budget = shorter >= 8 ? 2 : 1;
    if (Math.abs(q.length - word.length) > budget) continue;
    if (editDistance(word, q, budget) <= budget) return true;
  }
  return false;
}

/** How many rungs of the product ancestry (productSetKeys' PARENT walk -- not
 *  productFamilyOf, whose pricing family for bowman-draft is bowman-draft
 *  itself) separate this row's product from one the query names in full.
 *  0 when no ancestor is named. */
function familyStepsToNamedAncestor(setKeyOrName: string, queryWords: Set<string>): number {
  const raw = String(setKeyOrName ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!raw) return 0;
  const chain = productAncestry(productEntry(raw)?.setKey ?? raw);
  for (let i = 1; i < chain.length; i++) {
    const words = chain[i].split("-").filter((w) => w && !/^\d{4}$/.test(w));
    if (words.length > 0 && words.every((w) => queryWords.has(w))) return i;
  }
  return 0;
}

/** Finish vocabulary a query uses to name a parallel; when none is present the
 *  Base row is what the query means. Kept short and obvious on purpose. */
const CATALOG_FINISH_WORDS = new Set(["refractor", "refractors", "xfractor", "x", "fractor", "prizm", "mojo", "wave", "shimmer", "foil", "holo", "chrome", "sapphire", "superfractor", "black", "gold", "silver", "blue", "red", "green", "orange", "purple", "pink", "yellow", "aqua", "teal", "magenta", "fuchsia", "bronze", "platinum", "rainbow", "atomic", "lava", "laser", "crackle", "mini", "camo", "disco", "ice", "velocity", "hyper", "speckle", "sparkle", "glitter", "neon", "negative", "sepia", "printing", "plate", "plates", "geometric", "logofractor", "pulsar", "raywave", "fireworks", "tinsel", "diamante", "sandglitter"]);

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
  const alphaTokens = nameCandidateTokens(tokens);
  // CF-SEARCH-ANCHOR-FROM-PARSER (2026-08-21). "Longest non-stopword token"
  // is a PROXY for the surname, and it loses whenever a colour or finish word
  // is longer than the name. The stopword list covers brands and product lines
  // (bowman, topps, chrome, refractor, sapphire) but no colours, so:
  //
  //   "2024 Bowman Chrome Blue Raywave Auto Leo De Vries"  -> raywave (7) beats vries (5)
  //   "2018 Panini Prizm Silver Luka Doncic"               -> silver (6) ties doncic (6)
  //
  // Anchoring on "raywav" matches EVERY Raywave card, so TOP N is an arbitrary
  // sample that rarely holds the card asked for, the quality gate fails, and the
  // request escalates into the unindexed CONTAINS fallbacks. Measured 2026-08-21
  // on an idle box: those queries spent 18-364s in searchCatalog while queries
  // whose surname happened to win the anchor came back under 1.4s.
  //
  // This has been patched twice by adding the specific offending words to the
  // denylist (CF-SEARCH-SELECTIVE-ANCHOR, CF-SEARCH-ANCHOR-IS-THE-NAME). A
  // denylist cannot be completed — there are thousands of colour and finish
  // words. But the caller has ALREADY resolved the player: parseCardQuery
  // returns playerName with a confidence score. Use it.
  //
  // Longest token OF THE PLAYER NAME, not the last, so particles and suffixes
  // ("de", "jr") cannot win: "Leo De Vries" -> vries, "Josh Hammond" -> hammond.
  // Falls back to the old heuristic when the parser found no player.
  // CF-ESCALATE-ON-NAME-TOKENS-ONLY (2026-08-21). Tokens of the parsed player
  // name. Two consumers: the anchor below picks the longest of these, and the
  // escalation gate needs ALL of them (see nameTokensCovered). Derived once
  // from the same source so the two cannot disagree about who was asked for.
  // null — not [] — when the parser found no usable name, so each consumer
  // can fall back to the old token proxy rather than treating "no name" as
  // "no tokens required".
  const playerNameTokens: string[] | null = (() => {
    const pn = String(input.playerName ?? "").toLowerCase();
    if (!pn) return null;
    const parts = pn.split(/[^a-z]+/).filter((t) => t.length >= 3);
    // A parsed "name" made only of product, finish or grade words is not a
    // name; fall back to the token proxy rather than AND a brand into SQL.
    const named = parts.filter((t) => !isStopword(t));
    return named.length > 0 ? named : null;
  })();
  const parsedPlayerAnchor = playerNameTokens
    ? (playerNameTokens.slice().sort((a, b) => b.length - a.length)[0] ?? null)
    : null;
  const anchor = parsedPlayerAnchor
    ?? (alphaTokens.sort((a, b) => b.length - a.length)[0] ?? null);
  // CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30). EVERY name token reaches
  // Cosmos, not just the longest. The anchor arm used to key on one token, so
  // a common surname produced an arbitrary 2000-row sample and the second
  // name token was never applied in SQL at all -- "Max Williams" fetched the
  // same Williams sample as "Williams" and the card was not in it. Each
  // ARRAY_CONTAINS is an index point-lookup; their intersection is small
  // (597 rows for Max Williams 2025, all under the cap). Longest first, so
  // @name0 is the anchor.
  const nameTokens: string[] = [...new Set(playerNameTokens ?? alphaTokens)]
    .sort((a, b) => b.length - a.length);

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
  // CF-SEARCH-YEAR-IS-A-FILTER (Drew, 2026-08-16, on searching "2018 bowman
  // chrome ohtani": "I want the search to show only that match what the data
  // gives them. So any 2018 bowman chrome ohtani, NOT other years").
  //
  // A year in the query was only ever a SCORING signal, worth 1.5 against
  // playerName's 3.0. So "2018 bowman chrome ohtani" returned 2025 #MR-12,
  // 2025 #BGP-24, 2020 #58, 2022 #71 and 2023 #67 — every Bowman Chrome Ohtani
  // ever printed, because matching the player and the set outweighed missing
  // the year entirely. A year is not a hint about relevance; it is part of the
  // card's identity, and a card from another year is not a worse match, it is
  // the wrong card.
  //
  // Taken from the query when the caller did not supply one explicitly. Only a
  // plausible card year counts (1900-2035) so a print run like "/2024" or a
  // stray number cannot silently empty the page.
  const queryYear = tokens
    .map((t) => Number(t))
    .find((n) => Number.isInteger(n) && n >= 1900 && n <= 2035) ?? null;
  const effectiveYear = input.year ?? queryYear;
  if (effectiveYear) {
    scopes.push("c.year = @year");
    params.push({ name: "@year", value: effectiveYear });
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
    query: `SELECT TOP 500 c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c["set"] AS setNameFromSet, c.parallel, c.parallelSlug, c.isAuto, c.printRun, c.searchTokens, c.salesSummary, c.kind, c.imageUrl, c.source, c.verificationStatus, c.gradeTier FROM c WHERE (${searchOr})${anchorAnd}${scopeAnd} AND ${verifiedCatalogSqlClause("c")}`,
    parameters: params,
  };

  /** Same query, provisional tier only. Used as the fallback when the
   *  verified tier is empty — these are the "we have sales but no checklist
   *  yet" cards, and the caller flags them so they never render as equals. */
  const provisionalQspec = {
    query: `SELECT TOP 100 c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c["set"] AS setNameFromSet, c.parallel, c.parallelSlug, c.isAuto, c.printRun, c.searchTokens, c.salesSummary, c.kind, c.imageUrl, c.source, c.verificationStatus, c.gradeTier FROM c WHERE (${searchOr})${anchorAnd}${scopeAnd} AND ${provisionalCatalogSqlClause("c")}`,
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
    source?: string | null;
    verificationStatus?: string | null;
    gradeTier?: string | null;
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
  // D33: `c.source` and `c.gradeTier` are here because THIS is the arm that
  // actually serves a real query. The wider SELECT above carries them, but the
  // anchor arms are what "2020 BOWMAN Bobby Witt Jr. Royals #BD152 sp" runs,
  // and their narrower field list is why every hit on that page came back
  // authority "unknown" with no checklist badge on any row — the classifier had
  // nothing to classify. Both are short scalars ("baseballcardpedia", "psa-10"),
  // so they do not reopen the wide-document cost this list exists to bound.
  const anchorSelectFields = `c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c.parallel, c.isAuto, c.printRun, c.salesSummary, c.source, c.gradeTier`;
  //
  // The two arms run as SEPARATE queries, not as one OR. An OR that mixes an
  // EXISTS subquery with a scalar equality makes Cosmos fall back to a scan and
  // the pair measured 20-28s together; run apart, each stays on its index. TOP
  // is per-arm and modest for the same reason — the cost here is dominated by
  // materialising wide documents, not by matching them.
  // Raised once the year became a SQL filter. "2018 bowman chrome ohtani"
  // returned 5 cards and was missing the Refractor parallels outright, because
  // TOP 400 truncated the candidate set BEFORE the product narrowing ran —
  // Ohtani has more than 400 rows in 2018 alone across every product. A year
  // filter cuts the pool by roughly the number of years we hold, so a much
  // larger cap costs little and is what "show ALL of them" requires. Queries
  // with no year keep a smaller cap, since there the anchor is all we have.
  const ANCHOR_TOP = effectiveYear ? 2000 : 600;
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
  //
  // CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30). Both arms AND a predicate per
  // NAME TOKEN ("max" AND "williams"), so the candidate set is the person
  // asked for rather than a sample of a surname. The single-anchor arms below
  // survive only as the FALLBACK rung, for when the ANDed arms find nothing:
  // a misspelled first name, or a non-name token that slipped into the list.
  // With one name token the ANDed arm IS the single-anchor arm, so the
  // fallback is built only when there is more than one.
  const prefixOf = (t: string) => t.slice(0, Math.max(4, t.length - 2));
  const nameParams = nameTokens.map((t, i) => ({ name: `@name${i}`, value: t }));
  const namePrefixParams = nameTokens.map((t, i) => ({ name: `@namePrefix${i}`, value: prefixOf(t) }));
  const armExactAll = nameTokens.length > 0
    ? buildArm(nameTokens.map((_, i) => `ARRAY_CONTAINS(c.searchTokens, @name${i})`).join(" AND "), nameParams)
    : null;
  const armFuzzyAll = nameTokens.length > 0
    ? buildArm(nameTokens.map((_, i) => `EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @namePrefix${i}))`).join(" AND "), namePrefixParams)
    : null;
  const armExact = anchor && nameTokens.length > 1 ? buildArm(`ARRAY_CONTAINS(c.searchTokens, @anchorExact)`) : null;
  const armFuzzy = anchor && nameTokens.length > 1 ? buildArm(`EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @anchor))`) : null;
  // Card numbers are compared WITHOUT wrapping the column in LOWER(). A
  // function on the indexed column defeats the index, and this one cost 15.7s
  // on "…blue refractor bcp-69" and 18.3s on "…ohtani hmt1" — the arm meant to
  // guarantee the exact card was the slowest thing in the query. The catalog
  // stores card numbers uppercase ("BCP-69", "HMT1", "CPA-EHA"), so comparing
  // against both the uppercased token and the raw one keeps it an indexable
  // equality while still matching either casing.
  // CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling d): the same indexable
  // equality over every spelling — case, hyphen-free, hyphenated — so a
  // query typed "bd152" finds the checklist's BD-152.
  const numberIn = cardNumberToken ? cardNumberInClause(cardNumberToken, "@cardNum") : null;
  const armNumber = numberIn
    ? buildArm(`(c.cardNumber IN (${numberIn.sql}))`, numberIn.params)
    : null;

  let rows: Row[] = [];
  let provisional = false;
  // CF-CATALOG-SEARCH-TIME-BUDGET (2026-08-21). One controller for the whole
  // ladder: aborting it stops every in-flight query, not just the current one.
  const controller = new AbortController();
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const budgetTimer = setTimeout(() => controller.abort(), SEARCH_BUDGET_MS);
  let timedOut = false;
  /** False once the budget is spent — check BEFORE paying for an escalation. */
  const withinBudget = () => {
    if (Date.now() < deadline) return true;
    timedOut = true;
    return false;
  };
  try {
    // Every query carries the shared signal, and swallows its own failure so
    // one aborted arm cannot discard the candidates the others found.
    const runQuery = (qs: { query: string; parameters: typeof params }) =>
      container.items.query<Row>(qs, { abortSignal: controller.signal }).fetchAll()
        .then((r) => r.resources ?? [])
        .catch(() => { if (controller.signal.aborted) timedOut = true; return [] as Row[]; });
    const runArm = (qs: { query: string; parameters: typeof params } | null) =>
      qs ? runQuery(qs) : Promise.resolve([] as Row[]);

    const fastById = new Map<string, Row>();
    const absorb = (rows: Row[]) => { for (const r of rows) if (r?.id) fastById.set(r.id, r); };

    // The ANDed exact arm and the card-number arm are both cheap point lookups.
    const [exactRows, numberRows] = await Promise.all([runArm(armExactAll), runArm(armNumber)]);
    absorb(exactRows);
    absorb(numberRows);
    // Rows the NAME arms produced. The card-number arm does not count: the
    // fallback below exists for a name that reached nothing.
    let nameArmFound = exactRows.length;
    // Escalate to the fuzzy prefix scan only when the cheap arms did not
    // produce a confident answer for this query.
    //
    // CF-ESCALATE-ON-NAME-TOKENS-ONLY (2026-08-21). This used to pass
    // `alphaTokens`. nameTokensCovered tests each token against `playerName`
    // ONLY, and alphaTokens is every >=4-char token that is not a brand or
    // product word — so it carries every colour and finish the user typed.
    // No playerName contains "blue" or "raywave", which made the gate
    // UNSATISFIABLE for any query naming a parallel:
    //
    //   "2024 Bowman Chrome Blue Raywave Auto Leo De Vries"
    //     alphaTokens = [blue, raywave, vries]
    //     -> needs a playerName containing all three -> never -> escalate
    //
    // So the arm this gate exists to make RARE ran on essentially every real
    // card query. It is not cheap, and the cost was already measured in the
    // comments below: exact "carey" 1.5s vs prefix "care" 16.6s. That is the
    // dense 19-24s cluster in compiq_search_stage_timing — a fixed cost, not
    // variable query work, which is why it did not move when the anchor was
    // fixed in CF-SEARCH-ANCHOR-FROM-PARSER.
    //
    // The docstring above is unambiguous that these are meant to be name
    // tokens, and it even prices a false escalation: "escalated to the
    // expensive fuzzy scan for no reason and took 28.8s". That earlier fix
    // removed a length-driven false escalation; this removes a colour-driven
    // one.
    //
    // parseCardQuery has already resolved the player, so use its tokens. Fall
    // back to alphaTokens when it found no player — there, the old proxy is
    // still the best signal available, and escalating is the safe direction.
    const nameTokensForGate = playerNameTokens ?? alphaTokens;
    const covered = () => nameTokensCovered([...fastById.values()], nameTokensForGate);
    if (armFuzzyAll && withinBudget() && !covered()) {
      const fuzzyRows = await runArm(armFuzzyAll);
      absorb(fuzzyRows);
      nameArmFound += fuzzyRows.length;
    }
    // CF-SEARCH-FULL-NAME-DOMINATES: the single-anchor rung, only when the
    // ANDed arms reached nothing at all. When they found rows, every one of
    // those rows carries every name token typed; a single-anchor sample could
    // only add rows that MISS one, so it is not worth its 2000-row cost.
    if (nameArmFound === 0 && armExact && withinBudget()) {
      absorb(await runArm(armExact));
      if (armFuzzy && withinBudget() && !covered()) absorb(await runArm(armFuzzy));
    }
    // CF-CATALOG-SEARCH-TIME-BUDGET: each rung below is an unindexed CONTAINS
    // scan and they run in SEQUENCE, so without a check between them one slow
    // query does not just blow the budget, it lets the next two start anyway.
    const fast = [...fastById.values()];
    const canon = fast.length > 0
      ? fast
      : withinBudget() ? await runQuery(canonicalQspec) : [];
    rows = canon.length > 0
      ? canon
      : withinBudget() ? await runQuery(qspec) : [];
    // CF-CATALOG-SEARCH-TIERS: fall back to the provisional tier ONLY when
    // nothing verified matched. A card we hold real sales for should never
    // read as "not found" just because its checklist hasn't landed — but a
    // stub must never dilute a page of verified results either, so this is
    // strictly empty-else, not a merge.
    if (rows.length === 0 && withinBudget()) {
      const prov = await runQuery(provisionalQspec);
      if (prov.length > 0) { rows = prov; provisional = true; }
    }
  } catch {
    // CF-CATALOG-SEARCH-TIME-BUDGET: keep whatever the ladder already
    // collected. This used to return [] unconditionally, which would have
    // turned a late abort into "no such card".
    if (rows.length === 0) {
      return { hits: [], totalCandidatesScanned: 0, query, tokensUsed: tokens, timedOut };
    }
  } finally {
    clearTimeout(budgetTimer);
  }

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
    // CF-SEARCH-FULL-NAME-DOMINATES: the request's isAuto is a scoring signal
    // here (the SQL filter above fires only on an explicit boolean), and the
    // scoped year is what keeps "#2025" from posing as a card number.
    const verdict = scoreCatalogRow(tokens, r, { isAuto: input.isAuto ?? null, year: effectiveYear });
    if (!verdict) continue;
    const score = verdict.score;
    scored.push({
      slug: r.id,
      // CF-ONE-NAME-FORMAT-FOR-EVERY-CARD (Drew, 2026-08-24: "we want the SAME
      // consistent format FOR all of our catalog").
      //
      // COMPUTED, never stored. canonicalCardName is a pure function of fields
      // already on the row, so every one of the 40.1M rows gets the format the
      // moment this ships — no backfill, no RU, nothing to re-run. Storing it
      // would have meant ~22 days of upserts single-threaded, and worse, a
      // stored name goes stale the instant any input is corrected. Today alone
      // that would have invalidated thousands: setName normalised, 5,986 player
      // names recovered, 12,000+ sales moved to different parallels, Berk Ross
      // renumbered. A computed name cannot drift.
      displayName: canonicalCardName({
        year: r.year, setName: r.setName, setKey: r.setKey, sport: r.sport,
        cardNumber: r.cardNumber, playerName: r.playerName, parallel: r.parallel,
        printRun: typeof r.printRun === "number" ? r.printRun : null,
        subsetName: (r as { subsetName?: string | null }).subsetName ?? null,
      }),
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
      gradeTier: r.gradeTier ?? null,
      source: r.source ?? null,
      authority: catalogAuthorityOf(r.source),
      score,
      salesSummary: r.salesSummary ?? null,
    });
  }

  // CF-SEARCH-RANK-AGAINST-THE-HOLDING (Drew, 2026-08-23). Boost hits that
  // agree with what we already know about the card being identified.
  //
  // Weights are ordered by how much each field NARROWS the answer, which is not
  // the same as how confident we are in it:
  //
  //   cardNumber  1.20  near-unique within a year+set. The strongest signal
  //                     there is, and worth more than the query's own exact-
  //                     number bonus because it came from the listing rather
  //                     than from something the user typed while searching.
  //   year        0.60  cheap and decisive — the same player and number recur
  //                     every season, and a wrong year is a different card.
  //   setKey      0.40  narrows product family; deliberately below year
  //                     because set NAMES are the thing parsers get wrong
  //                     (Bowman vs Bowman Draft is this week's whole story).
  //   playerName  0.30  usually already in the query, so mostly a tie-break.
  //   isAuto      0.15  binary, and the parse is often wrong about it, so it
  //                     breaks ties and nothing more.
  //
  // Deliberately additive, never a filter. Every one of these fields came from
  // an eBay title parse that has ALREADY been shown to be unreliable — that is
  // why the card reached a human. Filtering on a wrong parse would hide the
  // right card completely; boosting merely orders the page, and the correct
  // answer stays reachable by scrolling.
  const ctx = input.context ?? null;
  if (ctx) {
    const wantNumber = String(ctx.cardNumber ?? "").trim().toUpperCase();
    const wantYear = Number.isFinite(Number(ctx.year)) ? Number(ctx.year) : null;
    const wantSetKey = ctx.setName ? normalizeSetKey(String(ctx.setName)) : "";
    const wantPlayer = fold(String(ctx.playerName ?? ""));
    for (const h of scored) {
      if (wantNumber && sameCardNumber(h.cardNumber, wantNumber)) h.score += 1.2;
      if (wantYear !== null && h.year === wantYear) h.score += 0.6;
      if (wantSetKey && String(h.setKey ?? "") === wantSetKey) h.score += 0.4;
      if (wantPlayer && fold(String(h.playerName ?? "")) === wantPlayer) h.score += 0.3;
      if (typeof ctx.isAuto === "boolean" && h.isAuto === ctx.isAuto) h.score += 0.15;
    }
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

  // CF-SEARCH-PRODUCT-NARROWS (Drew, 2026-08-16: "any 2018 bowman chrome
  // ohtani, NOT other years"). Year is filtered in SQL above; the PRODUCT has
  // to narrow too, or the page still fills with the wrong card. With the year
  // pinned, "2018 bowman chrome ohtani" came back topps=18, bowman=12,
  // bowmans-best=9, donruss-optic=8 — right player, right year, wrong product.
  //
  // The product words in a query are exactly the ANCHOR_STOPWORDS: the tokens
  // that name a brand or product line rather than identify a card. Require the
  // row's setKey to account for ALL of them, so "bowman chrome" keeps
  // bowman-chrome (and bowman-chrome-sapphire, a real sub-product) while
  // dropping bare bowman and topps-chrome — different products that trade at
  // their own prices.
  //
  // Narrowing applies ONLY when it leaves something behind, the same rule
  // narrowToRequestedVariants follows. A product we have not indexed under
  // that name must not empty the page; it falls back to matching ANY product
  // word, then to no narrowing at all.
  collapsed = narrowToNamedProduct(tokens, collapsed);

  // D33 — A SALE-MINTED ROW IS NEVER A BETTER ANSWER THAN A CHECKLIST ROW.
  //
  // Ordering above is score, then sales count. Neither knows what a row IS, so
  // an `ingest-auto-seed` or `sold-comps-stub` row sits level with a Beckett
  // one and can outrank it outright: derived rows are minted FROM sales, so
  // they carry the sales count that breaks the tie, and a row whose parallel we
  // inferred off a listing title beat the transcribed checklist card. On 2020
  // Bowman Draft alone that is 173 ingest-auto-seed + 9 sold-comps-stub + 1,041
  // catalog-explode rows competing with the checklist for the top of the page.
  //
  // Partition into authority tiers and concatenate, keeping the existing score
  // order strictly inside each tier — a stable partition, not a re-sort, so
  // every ranking rule above (the holding context boost, the product narrowing)
  // still decides which checklist row is FIRST.
  //
  // COVERAGE IS NEVER FILTERED. This reorders; it does not drop. When no
  // checklist row matched at all, the derived rows are still returned, still in
  // their own order — a card we only know through a sale stays findable, and
  // the `provisional` flag continues to say so. That is the same rule the
  // vendor-row narrowing above follows, and the reason both are re-orderings
  // rather than filters: the parse that got the user here was already unreliable.
  //
  // Ranking lives server-side so web and iOS cannot drift on what "best" means.
  const tierOf = (h: CatalogSearchHit): number => {
    switch (h.authority) {
      case "checklist": return 0;
      case "vendor": return 1;
      case "unknown": return 1;   // unclassified sources rank WITH vendor, not below
      default: return 2;          // derived
    }
  };
  collapsed = collapsed
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (tierOf(a.h) - tierOf(b.h)) || (a.i - b.i))
    .map((x) => x.h);

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
    // CF-CATALOG-SEARCH-TIME-BUDGET: surface truncation on the SUCCESS path
    // too. A budget expiry usually still returns hits — just fewer rungs of
    // the ladder than the query deserved — and a caller that cannot tell the
    // difference will cache a short answer as if it were the whole one.
    ...(timedOut ? { timedOut: true } : {}),
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
