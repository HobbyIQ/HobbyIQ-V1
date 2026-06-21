/**
 * Cardsight ID resolver (mapper). Phase 1 of migration per ADR-cardsight-migration-2026-05-18.
 *
 * Translates CompIQ internal query inputs (product names, parallels, etc.) to
 * Cardsight catalog card IDs and parallel IDs using the Cardsight catalog API.
 *
 * Resolution strategy (post Phase 1 CH-removal-v2 fix, per
 * docs/phase0/ch_removal_v2_plan.md commit 8d6d769):
 *  1. Build combined query: `{playerName} {cardsightReleaseName}` using the release dictionary
 *  2. Call searchCatalog with year + segment=baseball
 *  3. Filter results by releaseName exact match (case-insensitive)
 *  4. NEW (defect #1): if cardNumber provided AND multiple candidates remain,
 *     fetch getCardDetail (parallel fanout, capped at MAX_DETAIL_PROBES) and
 *     narrow by detail.number match
 *  5. NEW (defect #5): if still multiple candidates, probe getPricing for top-3
 *     (parallel fanout) and pick highest meta.total_records — Cardsight catalog
 *     returns duplicate entries per logical card, some without pricing data;
 *     candidates[0] is unreliable
 *  6. If parallel requested, call getCardDetail to resolve parallelId
 *
 * Wrapped with an in-process LRU cache for resolved cardIds. See bottom of file.
 */

import { searchCatalog, getCardDetail, getPricing } from "./cardsight.client.js";
import type { CardsightCatalogResult } from "./cardsight.client.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.mapper", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "cardsight.mapper", ...fields })),
};

export interface CompIQQueryInput {
  playerName: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
  /**
   * CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
   * effectiveIsAuto from upstream — compiqEstimate computes it from
   * (body.isAuto || /\b(auto|autograph|autographed)\b/.test(body.parallel))
   * at compiqEstimate.service.ts:1648. When supplied, _resolveCardId
   * compares the scored top candidate's card-number auto-prefix against
   * this flag and attempts a single-pass re-resolve to a matching
   * candidate from the scored pool if mismatched. When omitted, the
   * legacy non-auto-aware selection path is preserved (older callers
   * unaffected).
   */
  isAuto?: boolean;
}

export interface CardsightResolution {
  cardId: string | null;
  parallelId: string | null;
  matchConfidence: "exact" | "likely" | "none";
  warnings: string[];
}

const COMPIQ_TO_CARDSIGHT_RELEASES: Record<string, string> = {
  "topps chrome": "Topps Chrome",
  "topps chrome update": "Topps Chrome Update",
  // Phase 2 — covers Mike Trout 2011, Ohtani 2018, Judge 2017, Acuna 2018.
  // Cardsight catalog confirmed releaseName "Topps Update" via live probe
  // (docs/phase0/phase2_design.md Q1 addendum).
  "topps update": "Topps Update",
  // Phase 2 correction — flagship Bowman Chrome was previously mismapped to
  // "Bowman Draft Chrome". Cardsight has both releases distinct; the flagship
  // string should map to itself.
  "bowman chrome": "Bowman Chrome",
  "bowman draft": "Bowman Draft",
  "bowman draft chrome": "Bowman Draft Chrome",
  "panini prizm": "Panini Prizm",
  "donruss": "Donruss",
};

const CARDSIGHT_SET_PATTERNS: Record<string, RegExp> = {
  "Topps Chrome Base":             /^Base Set$/i,
  "Topps Chrome Refractor":        /^Refractor$/i,
  "Topps Chrome Prospect Auto":    /^Chrome Prospect Autograph/i,
};

// Selection algorithm tuning constants. Detail probes are cheap (no pricing
// data, just metadata); pricing probes are expensive (~9s p50 first-call).
// Bound fanout so worst-case latency stays under iOS's 60s timeout.
const MAX_DETAIL_PROBES = 5;
// Phase 2 v2 — raised from 3 to 8 per implementation finding. Cardsight catalog
// returns up to 16 candidates for some queries (e.g. Shohei Ohtani 2018 Topps
// Update returned 16, with data-bearing cardIds ranked at positions 4 and 10).
// The prior cap of 3 caused candidates[0] fallback for cards where the
// data-bearing entry was ranked deeper. Defect #13 v2 makes warming use the
// same cap (single source of truth) by serializing warming targets instead
// of throttling per-target probe count. See warmResolveCardIdCache below.
const MAX_PRICING_PROBES = 8;

// Lookup the Cardsight releaseName the resolver should search for.
// Returns the canonical product line ("Topps Update", "Bowman Chrome", etc.)
// from the COMPIQ_TO_CARDSIGHT_RELEASES dictionary, or null when the product
// isn't in the dictionary (resolver falls back to player-name-only search).
//
// History: an earlier signature accepted optional parallel + year arguments
// for set-level parallel overrides (Tiffany family). Empirical investigation
// in CF-CARDSIGHT-SCHEMA-INVESTIGATION (docs/phase0/cardsight_schema_truth.md)
// established that Cardsight does NOT decompose Tiffany as a distinct
// releaseName/setName — it's a parallelName on the same base cardId. The
// override mechanism was inert and removed. Title-match-with-specificity-
// guard now handles set-level parallels via parallelTitleMatch.ts.
export function lookupReleaseName(product: string): string | null {
  if (!product) return null;
  const productNorm = product.toLowerCase().trim();
  return COMPIQ_TO_CARDSIGHT_RELEASES[productNorm] ?? null;
}

// CF-PLAYERNAME-NORMALIZATION (2026-05-26): iOS card-scan path
// concatenates set / parallel / status tokens into the playerName field
// for ~9 of the user's ~16 real holdings. Server-side read-path
// normalization strips known contamination patterns before Cardsight
// catalog lookup so the right card can be identified. Stored data is
// preserved unchanged; a separate workstream addresses the iOS source.
//
// Multi-stage strategy:
//   1. Strip known set/status prefix tokens (longest match first)
//   2. Strip explicit suffix tokens (longest match first)
//   3. Strip generic CHR PROS / CHR PROSPECT suffix patterns via regex
//   4. Hygiene: collapse whitespace, trim
//
// Conservative defaults — only patterns observed in production data are
// stripped. Adding new tokens is low-risk additive; loosening to
// pattern-based heuristics would create false-positive risk on
// legitimate player names.
const PLAYERNAME_PREFIX_TOKENS = [
  // Longer multi-token prefixes must come BEFORE their shorter
  // overlapping prefixes so longest match wins.
  "CHROME PROSPECT AUTOGRAPHS",
  "TRADED TIFFANY",
  "PROSPECT AUTOGRAPHS",
  "TRADED",
  "TIFFANY",
];

const PLAYERNAME_SUFFIX_TOKENS = [
  // Longer suffixes first.
  "WAL-MART BORDER",
  "TIFFANY",
];

// Generic suffix: any "CHR PROS ..." or "CHR PROSPECT ..." through end
// of string. Matches the parallel-code suffixes that vary in spacing /
// dashes ("CHR PROS - MINI DIA", "CHR PROSPECT AU- SHIM", etc.) without
// requiring an entry per code.
const PLAYERNAME_GENERIC_CODE_SUFFIX = /\bCHR\s+PROS(?:PECT)?\b.*$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePlayerName(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name).trim();
  if (!s) return "";

  // Stage 1 — strip known prefix tokens (longest first via list order).
  for (const prefix of PLAYERNAME_PREFIX_TOKENS) {
    const re = new RegExp(`^${escapeRegExp(prefix).replace(/\\\s\+/g, "\\s+")}\\s+`, "i");
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }

  // Stage 2 — strip explicit suffix tokens (longest first).
  for (const suffix of PLAYERNAME_SUFFIX_TOKENS) {
    const re = new RegExp(`\\s+${escapeRegExp(suffix).replace(/\\\s\+/g, "\\s+")}\\s*$`, "i");
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }

  // Stage 3 — strip generic CHR PROS / CHR PROSPECT suffix patterns.
  s = s.replace(PLAYERNAME_GENERIC_CODE_SUFFIX, "").trim();

  // Stage 4 — hygiene.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

// Phase 2 v2 defect #12 — cardNumber-pattern dispatch (resolves the 2020 Witt
// "Bowman Chrome Refractor BDC-1" regression from PR #114).
//
// When a user types "Bowman Chrome" but the cardNumber prefix indicates a
// Bowman Draft Chrome realm card (BDC-N prospects, CPA-XXX autographs, etc.),
// override the product so resolveCardId searches the broader Bowman Draft
// catalog space instead of flagship Bowman Chrome. The Phase 2 dictionary
// correction ("bowman chrome" → "Bowman Chrome") is semantically correct but
// surfaces wrong-card answers for these cardNumber-prefixed queries because
// flagship Bowman Chrome and Bowman Draft Chrome share player+year but use
// different setNames in Cardsight catalog.
//
// Verified cardNumber pattern coverage (2026-05-25, Cardsight catalog probe +
// hobby convention):
//   BDC-  Bowman Draft Chrome main prospects (e.g. 2020 Witt BDC-1)
//   BD-   Bowman Draft base
//   CPA-  Chrome Prospect Autographs (e.g. Bonemer CPA-CBO)
//   CDA-  Chrome Draft Autographs (verified in 2020 Bowman Draft probe)
//   BCRP- Bowman Chrome Rookie Prospects (rare variant)
//   BBPA- Bowman Black Prospect Autographs
//
// Explicitly NOT in the override (these are flagship Bowman Chrome, not BDC):
//   BCP-  Bowman Chrome Prospects (releaseName="Bowman Chrome", setName="Prospects")
//   BSP-  Bowman Sapphire Prospects (different release entirely)
const BOWMAN_DRAFT_CHROME_NUMBER_PATTERN = /^(BD-|BDC-|CPA-|CDA-|BCRP-|BBPA-)/i;

export function applyCardNumberDisambiguation(
  product: string | undefined,
  cardNumber: string | undefined,
): string | undefined {
  if (!product || !cardNumber) return product;
  if (product.toLowerCase().trim() === "bowman chrome" &&
      BOWMAN_DRAFT_CHROME_NUMBER_PATTERN.test(cardNumber)) {
    log.info("release_fallback_cardnumber_dispatch", {
      originalProduct: product,
      cardNumber,
      resolvedProduct: "Bowman Draft Chrome",
      endpoint: "resolveCardId",
    });
    return "Bowman Draft Chrome";
  }
  return product;
}

// CF-PARALLEL-PLURAL-NORMALIZE (2026-06-16): Cardsight catalogs many
// parallel finishes under BOTH singular and plural names — "Refractor"
// AND "Refractors", "Speckle Refractor" AND "Speckle Refractors",
// "Gold Mini Diamond Refractor" AND "Gold Mini-Diamond Refractors", etc.
// The two spellings get distinct parallel_ids in detail.parallels[], so
// sales of the same physical parallel split across two catalog
// identities. The composed branch's observed-parallel-raw pooling
// (computeSameParallelRawMedian) ignored the duplicate, under-counting
// real comps. Empirically discovered in CF-LADDER-FIT (Step 1 audit
// surfaced 212 records under "Refractors" / "Yellow Refractors" / etc.
// that the matcher's `\brefractor\b` regex couldn't bind to the
// "refractor" token).
//
// Singular forms of parallel-vocabulary nouns that should be normalized
// when tokenizing. Stripping is gated by this set so non-vocab plurals
// (player names ending in -s, set-name plurals, etc.) stay untouched.
export const PARALLEL_SINGULAR_TOKENS: ReadonlySet<string> = new Set([
  "refractor",
  "fractor",        // matches "superfractor" siblings (X-Fractor handled via xfractor below)
  "xfractor",       // CF-X3: canonicalized X-Fractor token, plural-tolerant ("X-fractors")
  "wave",
  "shimmer",
  "speckle",
  "diamond",
  "raywave",
  "reptilian",
  "lava",
  "atomic",
  "mojo",
  "pulsar",
  "padparadscha",
  "sapphire",
  "prizm",
]);

function singularize(token: string): string {
  if (token.length < 4 || !token.endsWith("s")) return token;
  const singular = token.slice(0, -1);
  return PARALLEL_SINGULAR_TOKENS.has(singular) ? singular : token;
}

// Exported for parallelTitleMatch.ts (CF-CARDSIGHT-RESOLVER-REDESIGN).
// Single source of truth for parallel tokenization shared between
// parallelMatches (resolver-time) and applyParallelTitleMatch (comp-fetch
// time). Both consumers must see the same wrapper-strip behavior so a
// matched parallel resolves identical tokens at filter time.
export function tokenizeParallel(name: string): string[] {
  // CF-CARDSIGHT-RESOLVER-COMPREHENSIVE (parallelMatches fix): Cardsight
  // catalogs some set-level parallels with a verbose wrapper around the
  // canonical parallel name (e.g. parallelName="Limited Edition (Tiffany)"
  // for the Tiffany Maddux 1987 Topps Traded RC). User input "TIFFANY"
  // would never satisfy strict-set-equality against ["limited", "edition",
  // "(tiffany)"], leaving parallelId null and getPricing returning the
  // mixed base+Tiffany comp pool.
  //
  // Strip parenthesized wrappers from the candidate before tokenizing so
  // "Limited Edition (Tiffany)" tokenizes the same as the user's "Tiffany".
  // Generalizes to other wrapper patterns ("Refractor (Gold)" → ["gold"]).
  // Preserves defect #2 strict-equality semantics for non-wrapped parallels
  // (Refractor ≠ Chrome Blue Refractor remains the contract).
  //
  // CF-PARALLEL-PLURAL-NORMALIZE (2026-06-16): apply singularize() to each
  // token so "Refractor" and "Refractors" tokenize identically. See the
  // PARALLEL_SINGULAR_TOKENS comment block above.
  // CF-X3 (2026-06-20): canonicalize the X-Fractor family — Cardsight titles
  // spell it three ways ("X-Fractor"/"Xfractor"/"x fractor") and the hyphen-
  // split below would otherwise produce ["x", "fractor"], where `\bx\b` then
  // fails to find the "x" inside a smooshed "Xfractor" (no word boundary
  // between x and f). Pre-collapsing the three forms to "xfractor" makes the
  // input side single-token; buildWordBoundaryPattern's matching regex covers
  // the title side. Word-boundary anchored so "Lex-Fractor"-shaped strings
  // (the "e" before "x" blocks \b) are untouched. Audit (2026-06-20):
  // 392/393 X-Fractor title spellings normalize cleanly; the 393rd ("X-fractors"
  // plural) matches via xfractor's PARALLEL_SINGULAR_TOKENS membership.
  const wrapped = name.match(/\(([^)]+)\)/);
  const stripped = (wrapped ? wrapped[1] : name).replace(/\bx[-\s]?fractor\b/gi, "xfractor");
  return stripped
    .split(/[\s\-/]+/)
    .map((t) => singularize(t.toLowerCase()))
    .filter((t) => t.length > 0);
}

// Phase 2 v2 — defect #2 fix: exact set-equality on tokens (sorted-array
// equal), replacing the prior subset check.
//
// Prior behavior: `inputTokens.every(t => candidateTokens.includes(t))` treated
// the input as a subset of the candidate. This caused "Refractor" to falsely
// match "Chrome Blue Refractor" (and similar over-permissive matches), which
// then drove `Array.find()` to return whichever multi-word refractor parallel
// appeared first in detail.parallels[] — semantically wrong, and the
// downstream getPricing(cardId, {parallelId}) call would filter to a parallel
// the user never asked for, often returning zero records.
//
// New behavior: token sets must be exactly equal post-sort. "Refractor" only
// matches a parallel literally named "Refractor". "Blue Wave Refractor" only
// matches "Blue Wave Refractor" (also order-independent: "Refractor Blue
// Wave" matches the same — order in tokenized form is normalized out).
//
// Safety fallback: when no parallel matches strictly, parallelId stays null
// and getPricing is called without a parallel filter — returns the full
// pricing pool, downstream filtering can disambiguate.
function parallelMatchesStrict(input: string, candidate: string): boolean {
  const inputTokens = tokenizeParallel(input).sort();
  const candidateTokens = tokenizeParallel(candidate).sort();
  if (inputTokens.length !== candidateTokens.length) return false;
  return inputTokens.every((t, i) => t === candidateTokens[i]);
}

/**
 * CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
 * loose CONTIGUOUS-PREFIX matcher used as a SECOND pass after
 * parallelMatchesStrict misses. User tokens must appear as a contiguous
 * prefix of the candidate's token list, in the same order — NOT a free
 * subset.
 *
 * Why prefix-and-not-subset: defect #2 (preserved in
 * `cardsight.mapper.test.ts` "defect #2 preserved: 'Refractor' still
 * does NOT match 'Chrome Blue Refractor'") requires that a single
 * generic token like "Refractor" does NOT match a multi-word parallel
 * where the generic token is a SUFFIX. A subset matcher would bind
 * "Refractor" → "Chrome Blue Refractor"; a prefix matcher rejects
 * that (catalog tokens[0] = "chrome" ≠ user tokens[0] = "refractor")
 * while still binding "gold" → "Gold Refractor" (both [0] = "gold").
 *
 * `tokenizeParallel` already case-folds and splits on `[\s\-/]+`, so
 * the prefix matcher inherits Cardsight's "MIni-Diamond" typo
 * tolerance (lowercase) and the hyphen↔space normalization
 * ("mini diamond" ↔ "MIni-Diamond" → both ["mini","diamond"]).
 *
 * Safety: the caller (resolveParallelOnCandidate) MUST sort matches by
 * ascending name token-count so when multiple parallels start with the
 * user's tokens ("Gold Refractor", "Gold Wave Refractor", "Shimmer
 * Gold Refractor") the SHORTEST wins. This preserves the spirit of
 * defect #2 (avoid over-permissive ambiguous matches) while loosening
 * enough to bind the bare-color-name input pattern.
 *
 * Disabled by passing allowLoose=false to resolveParallelOnCandidate
 * (set by the auto-prefix re-resolve guard when no corrected candidate
 * exists — see _resolveCardId). This keeps the Q8'' wrong-card guard
 * intact on auto/base mismatches the re-resolve couldn't fix.
 */
function parallelMatchesLoose(input: string, candidate: string): boolean {
  const inputTokens = tokenizeParallel(input);
  const candidateTokens = tokenizeParallel(candidate);
  if (inputTokens.length === 0) return false;
  if (inputTokens.length > candidateTokens.length) return false;
  for (let i = 0; i < inputTokens.length; i++) {
    if (inputTokens[i] !== candidateTokens[i]) return false;
  }
  return true;
}

/**
 * CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
 * canonical autograph card-number prefix matcher. Mirrors the regex at
 * compiqEstimate.service.ts:1933 (CARD_NUMBER_AUTO_PREFIX_RE) — kept as
 * a sibling here so the resolver can apply the same auto-prefix
 * detection during candidate selection without depending on the
 * estimate-service layer.
 *
 * Returns true when the resolved cardIdentity.number starts with a
 * known Cardsight autograph prefix (CPA / BCPA / BPA / BCRRA / BCRA /
 * CRA / BSA / BCA / TCA / USA / BBPA / BSPA / AU / FA / ROA),
 * separated from the rest of the SKU by `-`, `_`, whitespace, or end
 * of string.
 */
const CARD_NUMBER_AUTO_PREFIX_RE =
  /^(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa)([-_\s]|$)/i;

function isAutoPrefix(cardNumber: string | null | undefined): boolean {
  if (!cardNumber) return false;
  return CARD_NUMBER_AUTO_PREFIX_RE.test(cardNumber.trim());
}

// ───── CF-69-RESOLVER-FIX helpers (2026-06-21) ───────────────────────────────
//
// Two-shape catalog retry + post-fetch filtering pipeline for the hot RC
// resolver class (Skenes 2024 Topps Chrome, Judge 2017 Topps Chrome,
// Ohtani 2018 Topps Chrome, Acuna 2018 Topps Chrome). Replaces the prior
// single-shape `{playerName} {releaseName}` query + case-insensitive
// substring release filter, which mis-ranked Topps Heritage above Topps
// Chrome (substring "Topps" wins both) and collided same-surname players
// (Ronald Acuna Jr ↔ Luisangel Acuna).
//
// Helpers are exported for unit-test coverage. Each is pure and side-effect
// free; the orchestration lives in _resolveCardId where the retry decision
// is made.

/**
 * Build Shape Y primary catalog query: `{cardYear} {releaseName} {playerName} RC`.
 * No `year=` filter is passed to searchCatalog because the API's year filter
 * was empirically flaky on Skenes-class cards (CF-69 spec C2). The "RC"
 * suffix biases the lexical relevance toward the rookie class. Returns
 * null when releaseName is missing (forces caller to skip Shape Y and
 * fall through to legacy).
 */
export function buildShapeYQuery(
  cardYear: number | string | undefined,
  releaseName: string | null,
  playerName: string,
): string | null {
  if (!releaseName) return null;
  const trimmedPlayer = playerName.trim();
  if (!trimmedPlayer) return null;
  const yearStr = cardYear != null ? String(cardYear).trim() : "";
  const parts = [yearStr, releaseName, trimmedPlayer, "RC"].filter((p) => p.length > 0);
  return parts.join(" ");
}

/**
 * Build Shape S fallback catalog query: `{surname} {releaseName}`.
 * Surname is the last whitespace-delimited token of playerName, AFTER
 * stripping generational suffixes (Jr, Sr, II, III, IV). Without the
 * strip, "Ronald Acuna Jr" → surname "Jr"; query "Jr Topps Chrome" —
 * the same false-positive class as the Heritage-substring-above-Chrome
 * inversion (Cardsight fuzzy-matches "Jr" globally).
 *
 * Suffixes handled: case-insensitive Jr, Sr, II, III, IV, with optional
 * trailing period (e.g. "Jr.", "Sr."). When the only remaining token IS
 * a suffix, surname falls back to that token (degenerate case — caller
 * shouldn't construct a playerName of just "Jr" but we don't crash).
 *
 * Fires only after Shape Y exhausts (zero exact-release matches post-
 * filter). Returns null when releaseName missing or playerName empty.
 */
const GENERATIONAL_SUFFIX_RE = /^(jr|sr|ii|iii|iv)\.?$/i;

export function buildShapeSQuery(
  releaseName: string | null,
  playerName: string,
): string | null {
  if (!releaseName) return null;
  const tokens = playerName.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // Strip trailing generational suffixes — "Ronald Acuna Jr" → surname "Acuna",
  // "Cal Ripken Jr." → "Ripken", "Ken Griffey Jr" → "Griffey". When the player
  // name is JUST a suffix (degenerate), keep the suffix as surname.
  let surnameIdx = tokens.length - 1;
  while (surnameIdx > 0 && GENERATIONAL_SUFFIX_RE.test(tokens[surnameIdx])) {
    surnameIdx--;
  }
  const surname = tokens[surnameIdx];
  return `${surname} ${releaseName}`;
}

/**
 * Case-insensitive equality filter on releaseName. Substring match (the
 * legacy semantic) is what mis-ranked "Topps Heritage" above "Topps Chrome"
 * when expectedRelease was "Topps Chrome" — both contain the substring
 * "Topps". This filter rejects Heritage on the equality check.
 */
export function filterExactRelease(
  candidates: CardsightCatalogResult[],
  expectedRelease: string,
): CardsightCatalogResult[] {
  const target = expectedRelease.toLowerCase().trim();
  if (!target) return candidates;
  return candidates.filter((c) => (c.releaseName ?? "").toLowerCase().trim() === target);
}

/**
 * Identify "canonical base" setName values vs autograph / relic / buyback
 * / dual / insert / variant. Needed alongside filterExactRelease because
 * Cardsight's "2022 Topps Chrome Refractor MVP Buybacks" shares releaseName
 * "Topps Chrome" with the canonical Judge base — only setName disambiguates.
 *
 * Matches: "base set", bare "base", "rookie cup".
 * Empty/null/undefined → false (treat as non-canonical so a known canonical
 * still gets preferred when present).
 */
export function isCanonicalSetName(setName: string | null | undefined): boolean {
  if (!setName) return false;
  const s = setName.toLowerCase().trim();
  if (!s) return false;
  if (s === "base") return true;
  return /\b(base set|base|rookie cup)\b/i.test(s);
}

/**
 * String-compare cardYear against candidate.year. CardsightCatalogResult
 * types `year` as number, but per CF-69 C2 the wire value is a string.
 * `String()` coercion handles both. Candidates with missing/zero/empty
 * year PASS — don't reject for missing data (throwback/buyback edge).
 */
export function filterByYearMatch(
  candidates: CardsightCatalogResult[],
  expectedYear: number | string | undefined,
): CardsightCatalogResult[] {
  if (expectedYear == null || expectedYear === "") return candidates;
  const target = String(expectedYear).trim();
  if (!target) return candidates;
  return candidates.filter((c) => {
    const candYear = c.year == null || c.year === 0 ? "" : String(c.year).trim();
    if (!candYear) return true; // missing year → don't reject
    return candYear === target;
  });
}

/**
 * Name guard: every whitespace-delimited token of input.playerName must
 * appear (case-insensitive substring) in candidate.name. Rejects the
 * Luisangel Acuna ↔ Ronald Acuna Jr collision when playerName="Ronald
 * Acuna Jr" — Luisangel's catalog name doesn't contain "Ronald". For a
 * single-token playerName ("Acuna" alone), that single token must
 * appear — same contract.
 */
export function passesNameGuard(
  candidate: CardsightCatalogResult,
  parsedPlayerName: string,
): boolean {
  const tokens = parsedPlayerName.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const candName = (candidate.name ?? "").toLowerCase();
  if (!candName) return false;
  return tokens.every((t) => candName.includes(t));
}

// ───── Internal: resolution worker (uncached) ────────────────────────────────

async function _resolveCardId(
  input: CompIQQueryInput,
): Promise<CardsightResolution> {
  const warnings: string[] = [];

  // Phase 2 v2 defect #12 — apply cardNumber-pattern dispatch BEFORE dictionary
  // lookup, so an input.product="Bowman Chrome" with input.cardNumber="BDC-1"
  // resolves through the Bowman Draft Chrome catalog path instead of flagship.
  // input.product is preserved for log/warning text (user-facing reflection of
  // what they actually typed); effectiveProduct drives catalog routing.
  const effectiveProduct = applyCardNumberDisambiguation(input.product, input.cardNumber);

  let releaseName: string | null = effectiveProduct
    ? lookupReleaseName(effectiveProduct)
    : null;
  if (effectiveProduct && !releaseName) {
    warnings.push(
      `Product "${input.product}" not in Cardsight release dictionary — searching by player name only.`,
    );
  }

  // ───── CF-69-RESOLVER-FIX: 2-shape retry + progressive post-fetch filter ───
  //
  // Replaces the prior single-shape `{playerName} {releaseName}` query +
  // case-insensitive substring release filter. The single-shape pipeline
  // mis-ranked Topps Heritage above Topps Chrome (substring "Topps" matched
  // both) and collided same-surname players (Ronald Acuna Jr ↔ Luisangel
  // Acuna). The new pipeline:
  //   1. Shape Y primary: `{year} {releaseName} {playerName} RC` (no year=
  //      filter — empirically flaky for Skenes-class cards per CF-69 C2).
  //   2. Filter chain: exact-release → year → name-guard → setName-canonical,
  //      cascading down to the looser non-empty set when each tighter filter
  //      empties.
  //   3. Shape S fallback: `{surname} {releaseName}` — fires only when
  //      Shape Y empties post-filter.
  //   4. Legacy fallback: when both Y and S yield zero, run the original
  //      `{playerName} {releaseName}` query with year= filter and the
  //      original substring release filter (back-compat for non-flagship
  //      queries that don't fit the 2-shape pattern).

  /** Apply the full progressive filter chain to a candidate set and return
   * the most-filtered non-empty result. Returns [] when EITHER:
   *   - exact-release gate empties (no candidates match the user-stated
   *     release), OR
   *   - name-guard empties (no candidate's name contains all user-tokens —
   *     i.e. only namesakes like Luisangel survived when user meant Ronald
   *     Acuna Jr).
   *
   * Name-guard is a SAFETY filter, not a relevance tier — when it empties,
   * we never fall back to the namesake-containing yearFiltered set. Better
   * to return [] (caller retries Shape S or falls through to legacy with
   * potentially-wrong-but-different-shape match) than to ship the wrong
   * person silently. CF-69-FINISH refinement after the agent's initial
   * pass cascaded to yearFiltered on name-guard empty — that would have
   * shipped Luisangel when only Luisangel matched release+year and the
   * user typed Ronald. Drew caught it pre-commit. */
  function applyFilterChain(
    pool: CardsightCatalogResult[],
    expectedRelease: string,
  ): CardsightCatalogResult[] {
    const releaseFiltered = filterExactRelease(pool, expectedRelease);
    if (releaseFiltered.length === 0) return [];
    const yearFiltered = filterByYearMatch(releaseFiltered,
      typeof input.cardYear === "string" ? input.cardYear : input.cardYear);
    // Year cascade — fall back to releaseFiltered when year-match empties
    // (year is a relevance tier, not safety; candidate without year metadata
    // shouldn't be discarded).
    const nameGuardInput = yearFiltered.length > 0 ? yearFiltered : releaseFiltered;
    const nameGuarded = nameGuardInput.filter((c) => passesNameGuard(c, input.playerName));
    // Name-guard SAFETY: when empty, return [] — do NOT fall back to
    // yearFiltered / releaseFiltered (which would contain rejected namesakes).
    // Caller (Shape S or legacy) handles the empty case.
    if (nameGuarded.length === 0) return [];
    // setName-canonical preference on the name-guarded set; fall back to
    // name-guarded when canonical empties (canonical might just not
    // pattern-match — e.g. "Chrome Prospects" — don't lose the name-guarded
    // set just because setName isn't strictly "Base Set").
    const canonical = nameGuarded.filter((c) => isCanonicalSetName(c.setName));
    return canonical.length > 0 ? canonical : nameGuarded;
  }

  let candidates: CardsightCatalogResult[] = [];
  let query = "";
  let resultsForDownstream: CardsightCatalogResult[] = [];

  const expectedRelease = releaseName ?? effectiveProduct ?? null;
  const shapeYQuery = effectiveProduct
    ? buildShapeYQuery(input.cardYear as number | string | undefined, releaseName, input.playerName)
    : null;

  if (shapeYQuery && expectedRelease) {
    const shapeYResults = await searchCatalog(shapeYQuery, { take: 20 });
    const filteredY = applyFilterChain(shapeYResults, expectedRelease);
    if (filteredY.length > 0) {
      candidates = filteredY;
      resultsForDownstream = shapeYResults;
      query = shapeYQuery;
    } else {
      // Shape Y empty post-filter — try Shape S.
      const shapeSQuery = buildShapeSQuery(releaseName, input.playerName);
      if (shapeSQuery) {
        log.info("cf69_two_shape_retry_used", {
          shapeYQuery,
          shapeSQuery,
          shapeYResultCount: shapeYResults.length,
          endpoint: "resolveCardId",
        });
        const shapeSResults = await searchCatalog(shapeSQuery, { take: 20 });
        const filteredS = applyFilterChain(shapeSResults, expectedRelease);
        if (filteredS.length > 0) {
          candidates = filteredS;
          resultsForDownstream = shapeSResults;
          query = shapeSQuery;
        } else {
          log.warn("cf69_zero_exact_release_after_filters", {
            shapeYQuery,
            shapeSQuery,
            shapeYResultCount: shapeYResults.length,
            shapeSResultCount: shapeSResults.length,
            expectedRelease,
            endpoint: "resolveCardId",
          });
        }
      }
    }
  }

  // Legacy fallback — both shapes failed (or shape-Y was never built because
  // no effectiveProduct). Run the original single-shape pipeline so non-
  // flagship queries that don't fit the 2-shape pattern still resolve.
  if (candidates.length === 0) {
    const legacyParts = [input.playerName.trim(), releaseName].filter(Boolean) as string[];
    const legacyQuery = legacyParts.join(" ");
    query = legacyQuery;
    const legacyResults = await searchCatalog(legacyQuery, {
      year: input.cardYear,
      take: 25,
    });

    if (legacyResults.length === 0) {
      log.warn("catalog_zero_results", {
        query: legacyQuery,
        playerName: input.playerName,
        product: input.product ?? null,
        cardYear: input.cardYear ?? null,
        endpoint: "resolveCardId",
      });
      warnings.push(`No Cardsight catalog results for query "${legacyQuery}".`);
      return { cardId: null, parallelId: null, matchConfidence: "none", warnings };
    }

    resultsForDownstream = legacyResults;
    candidates = legacyResults;

    // Legacy release-name filter (case-insensitive exact match — preserves
    // the pre-CF-69 contract for back-compat).
    if (effectiveProduct) {
      const expectedReleaseLegacy = (releaseName ?? effectiveProduct).toLowerCase().trim();
      const exactMatch = legacyResults.filter(
        (r) => r.releaseName?.toLowerCase() === expectedReleaseLegacy,
      );
      if (exactMatch.length > 0) {
        candidates = exactMatch;
      } else {
        log.warn("release_filter_no_exact_match", {
          query: legacyQuery,
          expectedRelease: expectedReleaseLegacy,
          dictHit: releaseName !== null,
          topCandidates: legacyResults.slice(0, 3).map((r) => r.releaseName ?? "").join(" | "),
          endpoint: "resolveCardId",
        });
        warnings.push(`No candidates matched release "${expectedReleaseLegacy}" — picking from top-ranked results.`);
      }
    }
    // CF-69-FINISH: legacy name-guard SAFETY filter — gated on 2+ token
    // playerName.
    //
    // Rationale: the name-guard only DISAMBIGUATES a namesake when the
    // query carries the distinguishing token. "Ronald Acuna" (2 tokens)
    // rejects Luisangel because Luisangel's candidate name doesn't
    // contain "Ronald". But bare "Acuna" (1 token) matches both Ronald
    // AND Luisangel — both candidate names contain "acuna" — so the
    // guard is structurally INERT on single-token namesake collisions.
    //
    // Gating on 2+ tokens applies the guard exactly where it can do its
    // job and skips it where it'd no-op. Covers the named-namesake
    // classes (Acuña Jr, Tatis Jr, Guerrero Jr — all multi-token).
    //
    // Known residual (intentional, documented by single-token-namesake
    // test): single-token playerName at this legacy escape-hatch can
    // ship (a) a single-token namesake best-guess (intended: query is
    // genuinely ambiguous), or (b) a gross fuzzy mismatch (pre-CF-69
    // legacy semantics retained; not a regression).
    const playerTokens = input.playerName.trim().split(/\s+/).filter((t) => t.length > 0);
    if (playerTokens.length >= 2) {
      const legacyNameGuarded = candidates.filter((c) => passesNameGuard(c, input.playerName));
      if (legacyNameGuarded.length === 0) {
        log.warn("cf69_legacy_name_guard_empty", {
          query: legacyQuery,
          playerName: input.playerName,
          rejectedCount: candidates.length,
          rejectedSample: candidates.slice(0, 3).map((c) => c.name ?? "?").join(" | "),
          endpoint: "resolveCardId",
        });
        warnings.push(
          `Legacy fallback had ${candidates.length} candidates but none matched playerName "${input.playerName}" — refusing to ship namesake.`,
        );
        return { cardId: null, parallelId: null, matchConfidence: "none", warnings };
      }
      candidates = legacyNameGuarded;
    }
  }

  // `results` retained as alias for any downstream code that referenced it
  // (sub-pattern filter, etc.) — points at the raw catalog response of the
  // shape we ultimately used.
  const results = resultsForDownstream;
  void results;

  // Sub-pattern filter (existing CARDSIGHT_SET_PATTERNS).
  if (input.product) {
    const patternKey = Object.keys(CARDSIGHT_SET_PATTERNS).find((k) =>
      k.toLowerCase().includes(input.product!.toLowerCase()),
    );
    if (patternKey) {
      const pattern = CARDSIGHT_SET_PATTERNS[patternKey];
      const setFiltered = candidates.filter((r) => pattern.test(r.setName ?? ""));
      if (setFiltered.length > 0) candidates = setFiltered;
    }
  }

  // ───── Defect #1+#5 fix — number disambiguation + pricing-bearing selection ─

  // Step A: card-number disambiguation via detail probes (cheap; no pricing).
  // Only fires when cardNumber is provided AND multiple candidates survive
  // release filtering. Capped at MAX_DETAIL_PROBES parallel calls to bound
  // worst-case latency under the iOS 60s budget. If MAX_DETAIL_PROBES <
  // candidates.length, we probe only the top N by catalog relevance order.
  if (input.cardNumber && candidates.length > 1) {
    const probeSet = candidates.slice(0, MAX_DETAIL_PROBES);
    const expectedNumber = input.cardNumber.toLowerCase().trim();
    const details = await Promise.all(
      probeSet.map((c) =>
        getCardDetail(c.id).catch(() => null),
      ),
    );
    const byNumber = probeSet.filter((_c, i) => {
      const d = details[i];
      return d && !d.notFound && d.number?.toLowerCase().trim() === expectedNumber;
    });
    if (byNumber.length > 0) {
      candidates = byNumber;
      log.info("cardnumber_filter_matched", {
        cardNumber: input.cardNumber,
        candidatesAfter: candidates.length,
        candidatesProbed: probeSet.length,
      });
    } else if (probeSet.length === candidates.length) {
      // We probed every candidate and none matched the number — fall back to
      // pricing-probe selection on the original set rather than failing here.
      // Defect #9: this is expected fallthrough behavior under cross-catalog
      // disagreement (CH and Cardsight have different card numbers for ~80%
      // of cards per the Phase 2 warming-target audit). Logged at info, not
      // warn, since downstream pricing-probe handles it correctly and the
      // event is structural noise rather than an error condition.
      log.info("cardnumber_filter_no_match", {
        cardNumber: input.cardNumber,
        candidatesProbed: probeSet.length,
      });
    } else {
      // Probed only top-N; cardNumber may match a non-probed candidate.
      // Fall back to pricing probe; don't claim failure.
      // Defect #9: same rationale as cardnumber_filter_no_match — info level.
      log.info("cardnumber_filter_inconclusive", {
        cardNumber: input.cardNumber,
        candidatesProbed: probeSet.length,
        totalCandidates: candidates.length,
      });
    }
  }

  // Step B: single candidate? Done. Skip pricing probe.
  if (candidates.length === 1) {
    const single = await applyAutoPrefixGuard(candidates[0], [], input, warnings, query);
    return resolveParallelOnCandidate(
      single.chosen,
      input,
      warnings,
      "exact",
      single.allowLooseParallelMatch,
    );
  }

  // Step C: pricing-probe disambiguation (defect #5). Cardsight returns
  // duplicate catalog entries per logical card; some are namesake players or
  // combo cards; some have empty pricing. Probe top-K in parallel and pick
  // the highest meta.total_records. Bounded at MAX_PRICING_PROBES.
  const topK = candidates.slice(0, MAX_PRICING_PROBES);
  const pricings = await Promise.all(
    topK.map((c) => getPricing(c.id).catch(() => null)),
  );
  const scored = topK.map((c, i) => ({
    candidate: c,
    records: pricings[i]?.meta?.total_records ?? 0,
  }));
  scored.sort((a, b) => b.records - a.records);

  const dataBearingCount = scored.filter((s) => s.records > 0).length;

  if (dataBearingCount === 0) {
    log.warn("all_top_candidates_empty", {
      query,
      probedCount: topK.length,
      totalCandidates: candidates.length,
    });
    warnings.push(
      `${topK.length} top candidates all had zero pricing data — using top-ranked.`,
    );
    const fallbackPool = scored.map((s) => ({ candidate: s.candidate, records: s.records }));
    const empty = await applyAutoPrefixGuard(candidates[0], fallbackPool, input, warnings, query);
    return resolveParallelOnCandidate(
      empty.chosen,
      input,
      warnings,
      "likely",
      empty.allowLooseParallelMatch,
    );
  }

  if (dataBearingCount > 1) {
    log.info("multiple_data_bearing_candidates", {
      query,
      chosenId: scored[0].candidate.id,
      chosenRecords: scored[0].records,
      altId: scored[1].candidate.id,
      altRecords: scored[1].records,
    });
    warnings.push(
      `${dataBearingCount} candidates have pricing data; picked highest (${scored[0].records} records).`,
    );
  }

  const guarded = await applyAutoPrefixGuard(scored[0].candidate, scored, input, warnings, query);
  return resolveParallelOnCandidate(
    guarded.chosen,
    input,
    warnings,
    dataBearingCount === 1 ? "exact" : "likely",
    guarded.allowLooseParallelMatch,
  );
}

/**
 * CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
 * autograph-prefix re-resolve guard. Two outcomes when input.isAuto is
 * supplied:
 *
 *   1. Chosen candidate's card-number auto-prefix matches input.isAuto
 *      → return chosen as-is with allowLooseParallelMatch=true.
 *   2. Chosen candidate's auto-prefix MISMATCHES input.isAuto →
 *      look for a corrected candidate in the scored pool whose
 *      auto-prefix matches AND has pricing records > 0. Prefer the
 *      highest-records match (scored[] is already sorted by records desc).
 *      If found, swap to it (loose match allowed). If not, keep the
 *      original chosen card AND set allowLooseParallelMatch=false so
 *      the strict matcher's miss propagates as a parallelNotFound
 *      warning — which the downstream Q8'' guard (compiqEstimate.service.ts
 *      :1937) reads to skip the entire tier ladder. Architectural rule:
 *      the loose matcher is ONLY ever applied on a card whose auto-ness
 *      we've actually verified.
 *
 * When input.isAuto is undefined (legacy callers), this is a no-op.
 *
 * CF-CARDSIGHT-CATALOG-NUMBER-PROBE (2026-06-01): Cardsight's
 * /catalog/search returns "lite" records for some catalog entries
 * where the SKU number is empty string at the search level — the
 * authoritative SKU only materializes after getCardDetail or
 * getPricing. Without the probe, `isAutoPrefix("")` returns false,
 * matches `input.isAuto=false`, the mismatch is silently undetected,
 * and the loose matcher binds on the wrong-auto-side card (the
 * Bonemer Gold class — production-observed 2026-06-01 03:22Z).
 *
 * The probe runs ONLY when: input.isAuto signal is present, the
 * chosen candidate's number is empty/null, AND a swap is even
 * possible (pool.length > 1). On any of those false, the fast path
 * holds — no probe. When the probe fires:
 *   - Detail returned with populated number → run guard on it.
 *   - Detail returned with empty number → defensive
 *     allowLooseParallelMatch=false (we can't verify auto-ness; safer
 *     than no-op).
 *   - Detail notFound / network error → same defensive default.
 *
 * Pool candidates' numbers are NOT probed individually — too costly.
 * Instead, pool members with empty/null numbers are EXCLUDED from
 * the "corrected" search (we can't reliably know their auto-side).
 * This is defensive narrowing: better to miss a potential correction
 * than to swap to a candidate whose auto-ness is unverified.
 */
async function applyAutoPrefixGuard(
  chosen: CardsightCatalogResult,
  pool: Array<{ candidate: CardsightCatalogResult; records: number }>,
  input: CompIQQueryInput,
  warnings: string[],
  query: string,
): Promise<{ chosen: CardsightCatalogResult; allowLooseParallelMatch: boolean }> {
  if (input.isAuto === undefined) {
    return { chosen, allowLooseParallelMatch: true };
  }

  let chosenNumber: string = chosen.number ?? "";

  // CF-CARDSIGHT-CATALOG-NUMBER-PROBE: gated detail probe to populate
  // the SKU when searchCatalog returned a lite record. Detail responses
  // are cache-wrapped (DETAIL_TTL_SEC=24h via cardsight.client) so
  // repeat traffic on the same cardId pays the cost once per day.
  if (chosenNumber === "" && pool.length > 1) {
    try {
      const detail = await getCardDetail(chosen.id);
      if (detail.notFound) {
        log.warn("auto_prefix_probe_notfound", {
          query,
          chosenCardId: chosen.id,
          endpoint: "resolveCardId",
        });
        // Defensive: can't verify auto-ness → treat as uncorrectable
        // mismatch. allowLoose=false propagates to strict-only match.
        return { chosen, allowLooseParallelMatch: false };
      }
      const probedNumber = (detail.number ?? "").trim();
      if (probedNumber === "") {
        log.warn("auto_prefix_probe_empty", {
          query,
          chosenCardId: chosen.id,
          endpoint: "resolveCardId",
        });
        // detail returned ALSO with no SKU — same defensive default.
        // Locks the degraded-but-safe path.
        return { chosen, allowLooseParallelMatch: false };
      }
      chosenNumber = probedNumber;
      log.info("auto_prefix_probe_success", {
        query,
        chosenCardId: chosen.id,
        probedNumber,
        endpoint: "resolveCardId",
      });
    } catch (err) {
      log.warn("auto_prefix_probe_threw", {
        query,
        chosenCardId: chosen.id,
        error: (err as Error)?.message ?? String(err),
        endpoint: "resolveCardId",
      });
      return { chosen, allowLooseParallelMatch: false };
    }
  }

  const chosenIsAuto = isAutoPrefix(chosenNumber);
  if (chosenIsAuto === input.isAuto) {
    return { chosen, allowLooseParallelMatch: true };
  }
  // Pool corrected-search: explicitly require populated number on the
  // candidate so we never swap to a card whose auto-ness we can't verify.
  // Empty/null numbers in the pool are EXCLUDED — better to miss a
  // potential correction (caller falls back to strict-only on the
  // wrong-prefix chosen) than to swap to an unknown card.
  const corrected = pool.find(
    (s) =>
      s.records > 0 &&
      s.candidate.number != null &&
      s.candidate.number !== "" &&
      isAutoPrefix(s.candidate.number) === input.isAuto,
  );
  if (corrected) {
    log.info("auto_prefix_reresolve_success", {
      query,
      fromCardId: chosen.id,
      fromNumber: chosenNumber,
      toCardId: corrected.candidate.id,
      toNumber: corrected.candidate.number,
      toRecords: corrected.records,
      userIsAuto: input.isAuto,
      endpoint: "resolveCardId",
    });
    warnings.push(
      `Re-resolved from "${chosenNumber}" to "${corrected.candidate.number}" (auto-prefix corrected for ${input.isAuto ? "auto" : "base"} request).`,
    );
    return { chosen: corrected.candidate, allowLooseParallelMatch: true };
  }
  log.warn("auto_prefix_reresolve_failed", {
    query,
    chosenCardId: chosen.id,
    chosenNumber,
    chosenIsAuto,
    userIsAuto: input.isAuto,
    candidatePoolSize: pool.length,
    endpoint: "resolveCardId",
  });
  // No corrected candidate available in pool — keep the wrong-prefix
  // candidate but force strict-only parallel matching downstream so the
  // Q8'' wrong-card guard's parallelNotFound signal is preserved.
  return { chosen, allowLooseParallelMatch: false };
}

async function resolveParallelOnCandidate(
  topCard: CardsightCatalogResult,
  input: CompIQQueryInput,
  warnings: string[],
  matchConfidence: "exact" | "likely",
  // CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
  // when false, ONLY parallelMatchesStrict is consulted — the loose
  // subset-with-shorter-preference fallback is skipped. Set by the
  // auto-prefix re-resolve guard in _resolveCardId when the candidate
  // pool didn't contain a corrected auto-side match. Preserves the
  // Q8'' wrong-card guard's load-bearing parallelNotFound signal in
  // exactly the cases the guard is meant to catch.
  allowLooseParallelMatch: boolean = true,
): Promise<CardsightResolution> {
  let parallelId: string | null = null;
  if (input.parallel) {
    const detail = await getCardDetail(topCard.id);
    if (detail.notFound || !detail.parallels?.length) {
      log.warn("parallel_not_found", {
        cardId: topCard.id,
        requestedParallel: input.parallel,
        reason: detail.notFound ? "detail_not_found" : "no_parallels",
        endpoint: "resolveCardId",
      });
      warnings.push(
        `Could not load card detail for id=${topCard.id} to resolve parallel "${input.parallel}".`,
      );
    } else {
      // Pass 1: strict set-equality (defect #2 semantics — exact match only).
      const strictMatched = detail.parallels.find((p) =>
        parallelMatchesStrict(input.parallel!, p.name),
      );
      if (strictMatched) {
        parallelId = strictMatched.id;
      } else if (allowLooseParallelMatch) {
        // Pass 2: loose subset match with shorter-name preference. Sort
        // matches by ascending token count (then by raw name length as
        // tiebreak) and pick the shortest. This binds "gold" → "Gold
        // Refractor" (2 tokens) over "Gold Wave Refractor" (3) or
        // "Shimmer Gold Refractor" (3) — preserving the spirit of
        // defect #2 (avoid the over-permissive "wins by iteration
        // order" failure mode) while loosening enough to bind the
        // common bare-color-name input pattern.
        const looseMatches = detail.parallels.filter((p) =>
          parallelMatchesLoose(input.parallel!, p.name),
        );
        if (looseMatches.length > 0) {
          looseMatches.sort((a, b) => {
            const aTokens = tokenizeParallel(a.name).length;
            const bTokens = tokenizeParallel(b.name).length;
            if (aTokens !== bTokens) return aTokens - bTokens;
            return a.name.length - b.name.length;
          });
          const looseMatched = looseMatches[0];
          parallelId = looseMatched.id;
          log.info("parallel_loose_match", {
            cardId: topCard.id,
            requestedParallel: input.parallel,
            matchedParallel: looseMatched.name,
            matchedParallelId: looseMatched.id,
            candidatesConsidered: looseMatches.length,
            endpoint: "resolveCardId",
          });
        } else {
          log.warn("parallel_not_found", {
            cardId: topCard.id,
            requestedParallel: input.parallel,
            availableParallelCount: detail.parallels.length,
            endpoint: "resolveCardId",
            allowLooseParallelMatch,
          });
          warnings.push(
            `Parallel "${input.parallel}" not found among ${detail.parallels.length} parallel(s) — returning cardId only.`,
          );
        }
      } else {
        log.warn("parallel_not_found", {
          cardId: topCard.id,
          requestedParallel: input.parallel,
          availableParallelCount: detail.parallels.length,
          endpoint: "resolveCardId",
          allowLooseParallelMatch,
        });
        warnings.push(
          `Parallel "${input.parallel}" not found among ${detail.parallels.length} parallel(s) — returning cardId only.`,
        );
      }
    }
  }

  return {
    cardId: topCard.id,
    parallelId,
    matchConfidence,
    warnings,
  };
}

// ───── In-process LRU cache for resolveCardId results ────────────────────────
//
// MIGRATE TO REDIS WHEN: scaling to multiple App Service instances (cache
// misses across instances will negate the warming benefit), OR cache
// invalidation needs to be cross-process (e.g. a catalog correction workflow
// needs to expire stale cardId mappings without redeploying).
//
// Until then in-process is correct: Cardsight catalog drift is slow, the
// 7-day TTL absorbs that drift, and the warming step at server start ensures
// popular cards skip the cold-path on fresh containers.

const RESOLVE_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 5000;
const CACHE_STATS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_STATS_LOG_EVERY_N = 100;

interface CacheEntry { value: CardsightResolution; expiresAt: number; }
const _resolveCache = new Map<string, CacheEntry>();
const _cacheStats = { hits: 0, misses: 0, evictions: 0, lastLogAt: 0, totalRequests: 0 };

function buildCacheKey(input: CompIQQueryInput): string {
  return [
    input.playerName.trim().toLowerCase().replace(/\s+/g, " "),
    String(input.cardYear ?? ""),
    (input.product ?? "").toLowerCase().trim(),
    (input.parallel ?? "").toLowerCase().trim(),
    (input.cardNumber ?? "").toLowerCase().trim(),
    (input.gradeCompany ?? "").toLowerCase().trim(),
    String(input.gradeValue ?? ""),
    // CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
    // isAuto drives auto-prefix re-resolve in _resolveCardId; same query
    // with different isAuto values can resolve to DIFFERENT cardIds, so
    // it must shard cache entries. `isAuto=undefined` (legacy callers)
    // serializes to "" — same key as pre-CF inputs, no cache invalidation.
    input.isAuto === undefined ? "" : input.isAuto ? "auto" : "base",
  ].join("|");
}

function cacheGet(key: string): CardsightResolution | null {
  const entry = _resolveCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _resolveCache.delete(key);
    return null;
  }
  // LRU touch — Map preserves insertion order; delete + re-set moves entry
  // to the most-recently-used end.
  _resolveCache.delete(key);
  _resolveCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: CardsightResolution): void {
  if (_resolveCache.has(key)) _resolveCache.delete(key);
  _resolveCache.set(key, { value, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
  while (_resolveCache.size > RESOLVE_CACHE_MAX_ENTRIES) {
    const oldestKey = _resolveCache.keys().next().value;
    if (oldestKey === undefined) break;
    _resolveCache.delete(oldestKey);
    _cacheStats.evictions++;
  }
}

function logCacheStatsThrottled(): void {
  _cacheStats.totalRequests++;
  const now = Date.now();
  const intervalElapsed = now - _cacheStats.lastLogAt >= CACHE_STATS_LOG_INTERVAL_MS;
  const countTrigger = _cacheStats.totalRequests % CACHE_STATS_LOG_EVERY_N === 0;
  if (!intervalElapsed && !countTrigger) return;
  const total = _cacheStats.hits + _cacheStats.misses;
  const hitRatePct = total > 0 ? Math.round((_cacheStats.hits / total) * 1000) / 10 : 0;
  log.info("resolveCardId_cache_stats", {
    hits: _cacheStats.hits,
    misses: _cacheStats.misses,
    evictions: _cacheStats.evictions,
    size: _resolveCache.size,
    hitRatePct,
  });
  _cacheStats.lastLogAt = now;
}

/**
 * Public entry — cache-wrapped resolveCardId.
 *
 * Cache misses run the full _resolveCardId pipeline (catalog → release filter
 * → cardNumber narrowing → pricing-probe disambiguation). Cache hits return
 * the prior resolution. Failures (cardId === null) are NOT cached so transient
 * issues don't get pinned for 7 days.
 */
export async function resolveCardId(
  input: CompIQQueryInput,
): Promise<CardsightResolution> {
  const key = buildCacheKey(input);
  const cached = cacheGet(key);
  if (cached) {
    _cacheStats.hits++;
    logCacheStatsThrottled();
    return cached;
  }
  _cacheStats.misses++;
  logCacheStatsThrottled();

  const result = await _resolveCardId(input);
  if (result.cardId !== null) {
    cacheSet(key, result);
  }
  return result;
}

// ───── Cache warming at server startup ───────────────────────────────────────
//
// Popular cards that surface in demos + DailyIQ watchlists. Without warming,
// the first iOS query on any of these pays the cold-path latency (single
// candidate ~9s, multi-candidate disambiguation ~18s). With warming, every
// post-startup user hit is a cache lookup.
//
// MAINTENANCE: update when the DailyIQ watchlist rotates or demo set
// changes. Telemetry (resolveCardId_cache_stats logs) guides re-prime
// cadence.

// Phase 2 v2 — cardNumber field REMOVED per defect #10 mitigation (warming API
// load reduction). The Option B cache-alignment approach from addendum 8a51dd5
// was found to (1) trip Cardsight rate limit due to cardNumber detail-probe
// fan-out × 10 parallel warming targets at startup (~80-90 calls), and (2) not
// actually align with /price + /estimate request keys anyway because those
// paths don't populate cardNumber in queryContext (typical iOS usage).
//
// Trade-off: /price-by-id with iOS displayLabels (which DO carry cardNumber via
// defect #11 threading) pays cold-path latency on first request per logical
// card, then the result is cached lazily by resolveCardId's LRU and subsequent
// requests hit the cache. /price + /estimate hit warming-cache immediately.
//
// Witt Jr product correction preserved from Phase 2: "Topps Chrome" → "Topps
// Chrome Update" (USC35 is in the Update set, not flagship Topps Chrome).
const CACHE_WARM_TARGETS: ReadonlyArray<CompIQQueryInput> = [
  // 2011 Topps Update — Mike Trout RC class (demo-critical)
  { playerName: "Mike Trout",      cardYear: 2011, product: "Topps Update" },
  // 2017-2018 Topps Update — modern superstar RCs (demo-critical)
  { playerName: "Aaron Judge",     cardYear: 2017, product: "Topps Update" },
  { playerName: "Cody Bellinger",  cardYear: 2017, product: "Topps Update" },
  { playerName: "Shohei Ohtani",   cardYear: 2018, product: "Topps Update" },
  { playerName: "Ronald Acuna Jr", cardYear: 2018, product: "Topps Update" },
  { playerName: "Juan Soto",       cardYear: 2018, product: "Topps Update" },
  { playerName: "Gleyber Torres",  cardYear: 2018, product: "Topps Update" },
  // Modern Topps Chrome Update
  { playerName: "Bobby Witt Jr",   cardYear: 2022, product: "Topps Chrome Update" },
  { playerName: "Paul Skenes",     cardYear: 2024, product: "Topps Chrome Update" },
  // DailyIQ-style Bowman Draft Chrome prospect
  { playerName: "Caleb Bonemer",   cardYear: 2024, product: "Bowman Draft Chrome" },
];

export async function warmResolveCardIdCache(): Promise<void> {
  const start = Date.now();
  let primed = 0;
  let failed = 0;
  // Defect #13 v2 — serialize warming targets to eliminate the parallel
  // rate-limit cascade. Prior Promise.all + 10 targets × MAX_PRICING_PROBES=8
  // produced ~80 concurrent Cardsight calls at startup, tripping the rate
  // limit and poisoning the LRU with candidates[0] fallback resolutions.
  // The first defect #13 attempt (asymmetric cap: warming=3, request=8)
  // eliminated the cascade but regressed deep-catalog cards (Ohtani-shape:
  // data-bearing cardId ranked >3 in catalog order). Serializing instead
  // means one resolution at a time, full MAX_PRICING_PROBES=8 per target,
  // no rate-limit cascade, no Ohtani-shape trade-off.
  //
  // Startup cost: ~10s parallel → ~3-4 min sequential. Acceptable because
  // warmResolveCardIdCache is invoked fire-and-forget after app.listen
  // (server.ts) — /api/health is responsive immediately; users in the
  // warming window pay cold-path latency on uncached queries (same as if
  // warming hadn't run).
  for (const target of CACHE_WARM_TARGETS) {
    try {
      const result = await resolveCardId(target);
      if (result.cardId) primed++;
      else failed++;
    } catch (err: any) {
      failed++;
      log.warn("warm_target_failed", {
        target: target.playerName,
        year: target.cardYear,
        product: target.product,
        error: err?.message ?? String(err),
      });
    }
  }
  log.info("resolveCardId_cache_warmed", {
    primed,
    failed,
    targets: CACHE_WARM_TARGETS.length,
    elapsedMs: Date.now() - start,
  });
}

// Test-only internal accessors.
export const __resolveCardIdInternals = {
  clearCache: (): void => {
    _resolveCache.clear();
    _cacheStats.hits = 0;
    _cacheStats.misses = 0;
    _cacheStats.evictions = 0;
    _cacheStats.totalRequests = 0;
    _cacheStats.lastLogAt = 0;
  },
  cacheSize: (): number => _resolveCache.size,
  cacheStats: () => ({ ..._cacheStats }),
  buildCacheKey,
};
