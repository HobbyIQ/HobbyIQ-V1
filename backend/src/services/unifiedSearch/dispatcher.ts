// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — unified search dispatcher.
//
// Per design doc 23038d7 §2-§4. Single async function that composes
// the cert-grader registry (W2) with the Cardsight catalog adapter
// (W3) into a single search surface:
//
//   dispatchSearch(input, hint?) → UnifiedSearchResponse
//
// Mode resolution:
//   - empty input              → freetext mode, empty candidates,
//                                "empty_input" warning
//   - hint provided            → hint wins (caller knows best)
//   - any grader recognizes    → cert mode
//   - otherwise                → freetext mode
//
// Cert mode: fan out to ALL recognizing graders via Promise.allSettled
// (so a slow / failing grader doesn't block the others). Per-grader
// failures surface as `${graderId}_cert_lookup_failed:${CODE}` warnings
// where CODE is a CertGraderErrorCode literal — consumers can branch
// on a stable enum rather than parse free text.
//
// When hint=cert is given but NO grader recognizes the input (rare —
// user explicitly toggled "this is a cert" on ambiguous text), the
// dispatcher tries ALL registered graders rather than returning empty.
//
// Freetext mode: searchCardsRouted (CardHedge card-search) → adapter.
// Cap at 30 candidates by default (matches design §4 `take: 30`).
//
// The dispatcher itself is pure orchestration — no caching, no
// retry, no rate-limiting. Each adapter brings its own (searchCardsRouted
// inherits CardHedge's cacheWrap + retry from cardhedge.client.ts; PSA
// grader is uncached per the W3 deferred-decision lock — see
// CF-CERT-LOOKUP-CACHE in SESSION_HANDOFF.md).

import {
  findRecognizingGraders,
  listCertGraders,
} from "../certGraders/registry.js";
import {
  CertGraderError,
  type CertGrader,
  type CertGraderErrorCode,
  type CertLookupResult,
} from "../certGraders/certGrader.js";
import type { CardIdentity } from "../../types/cardIdentity.js";
import type {
  UnifiedSearchMode,
  UnifiedSearchResponse,
} from "../../types/unifiedSearch.js";
import {
  searchCardsRouted,
  chCardToRoutedCard,
  type RoutedCard,
} from "../compiq/cardsight.router.js";
import { parseCardQuery } from "../compiq/cardQueryParser.js";
import {
  identifyCard,
  getCardDetailsById,
  type CardSearchFilters,
} from "../compiq/cardhedge.client.js";
import { applyCollectorAlias } from "../compiq/parallelCollectorAliases.js";
import {
  canonicalCardSearch,
  type CanonicalSearchHit,
} from "../portfolioiq/canonicalCardSearch.service.js";

// CF-CH-FREETEXT-TAKE-100 (2026-06-28): bumped 30 → 100 to widen the
// CardHedge search window. The 30-result default was missing specific
// variants (Drake Baldwin 2025 Bowman Chrome Image Variation surfaced 0
// instances across multiple query angles); CH ranks IV-class parallels
// below the more popular base/refractor variants, so the IV likely sits
// beyond position 30 in their relevance ranking. 100 is CH's documented
// page_size ceiling (per /cards/card-search OpenAPI: max 100). Latency
// impact is minimal — CH returns the larger page from the same query;
// dispatch + adapter cost scales linearly with result count.
const FREETEXT_TAKE_DEFAULT = 100;

/**
 * CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28): the confidence floor at
 * which we trust the parser's structured fields enough to forward them
 * to CardHedge as dedicated filters (vs leaving them as free-text only).
 * Below this floor we revert to pre-CF behavior — the entire trimmed query
 * goes into `search` and CH does its own free-text matching.
 *
 * 0.5 was picked because `parseCardQuery`'s scoring adds 0.4 for a two-
 * word playerName, 0.2 each for year and brand, etc. — a hit at >=0.5
 * means at least player + (year OR brand) parsed cleanly, which is the
 * minimum CardHedge needs to apply structured filtering meaningfully.
 */
const PARSER_CONFIDENCE_FLOOR = 0.5;

/**
 * Build the structured filter shape for CardHedge from a parsed query.
 * Only emits fields when the parser extracted them with the corresponding
 * signal. Sending an undefined/empty field to CH is a no-op, but we keep
 * the object minimal to make logs + tests easier to read.
 *
 * `set` is composed as `${year} ${set} Baseball` to match CardHedge's
 * canonical set naming (per their /cards/card-search example response —
 * `"set": "2018 Topps Chrome Baseball"`). When year is missing we fall back
 * to just `${set} Baseball`. When set is missing entirely the field is
 * omitted (CH will treat the search as set-unconstrained).
 */
/**
 * CF-CH-AUTO-FROM-CARDNUMBER (2026-06-28): CardHedge's /cards/card-search
 * doesn't expose an `isAuto` field on the response (verified against
 * CardHedgeCard interface and the public API docs). routedCardToIdentity
 * therefore hardcoded `isAuto: false` on every candidate, including
 * obvious autographs (e.g. `CPA-EHA Orange Shimmer Refractor` came back
 * with `isAuto: false`). When iOS' AddHoldingRequest forwards the field
 * the backend persists non-auto, and the engine prices the holding as a
 * cheaper non-auto variant — Drew's $22 Speckle / wrong-Hartman-pricing
 * symptom.
 *
 * Fix: derive isAuto from the card_number prefix. Bowman / Topps
 * autograph subsets use consistent multi-letter prefixes ending in "A"
 * for "Autograph(s)" — CPA, CDA, BCPA, BDPA, BCDA, BCRA, TCRA, TRA, etc.
 * The patterns below are intentionally conservative (no single-letter
 * "A-" wildcard) to avoid false positives on parallel codes that
 * coincidentally end in A.
 *
 * Each entry MUST be followed by either "-" or end-of-string so a prefix
 * never matches mid-string (e.g. `CPA` must not match `BCPA-102`).
 */
const AUTO_CARDNUMBER_PREFIXES: readonly RegExp[] = [
  /^CPA(?:-|$)/i,    // Chrome Prospect Autographs (Bowman Chrome — the canonical)
  /^CDA(?:-|$)/i,    // Chrome Draft Autographs
  /^BCPA(?:-|$)/i,   // Bowman Chrome Prospect Autographs (variant naming)
  /^BCDA(?:-|$)/i,   // Bowman Chrome Draft Autographs
  /^BDPA(?:-|$)/i,   // Bowman Draft Prospect Autographs
  /^BDA(?:-|$)/i,    // Bowman Draft Autographs (paper)
  /^BPA(?:-|$)/i,    // Bowman Prospect Autographs (paper)
  /^BCRA(?:-|$)/i,   // Bowman Chrome Rookie Autographs
  /^TCRA(?:-|$)/i,   // Topps Chrome Rookie Autographs
  /^TRA(?:-|$)/i,    // Topps Rookie Autographs
  /^FCA(?:-|$)/i,    // Finest Card Autographs
  /^USA-/i,          // USA Baseball Autograph subsets
  /^AU-/i,           // Generic Autograph prefix (multi-product)
];

/**
 * CF-CH-AUTO-FROM-CARDNUMBER (2026-06-28): detect whether a card is an
 * autograph from its card-number prefix. Returns true on a confirmed
 * auto-prefix match, false otherwise. Returns false (not null) for
 * missing/empty input so the caller can safely OR with other signals.
 *
 * Exposed as a named export so the test file can pin the prefix table
 * exactly and a future addition (new product, new prefix) requires a
 * matching test row.
 */
export function detectIsAutoFromCardNumber(
  cardNumber: string | null | undefined,
): boolean {
  if (!cardNumber || typeof cardNumber !== "string") return false;
  const trimmed = cardNumber.trim();
  if (trimmed.length === 0) return false;
  return AUTO_CARDNUMBER_PREFIXES.some((re) => re.test(trimmed));
}

/**
 * CF-CH-SANITIZE-PLAYER-FILTER (2026-06-28): the parser's playerName
 * extraction strips known noise (auto, refractor, base, etc.) but leaves
 * parallel-specific tokens like "X-Fractor", "Fractor", "Shimmer",
 * "Speckle", "Geometric" intact when they appear in a query. Those
 * tokens then leak into playerName ("X-fractor Eric Hartman" from
 * "blue x-fractor eric hartman"), and CardHedge's `player` filter is
 * exact-match — a player named "X-fractor Eric Hartman" doesn't exist,
 * so the filter returns 0 results.
 *
 * Fix: strip a curated list of parallel/variant token patterns from
 * playerName before sending as the CH player filter. The list intentionally
 * skips solo color words ("Blue", "Red", "Gold", "Black", "White") because
 * those can legitimately be parts of player surnames (Black, Gold, etc.);
 * the parallel-vocabulary terms below are not common surnames so stripping
 * them is safe. Keeps the cleaned name's word ordering intact.
 *
 * Exported for direct testing — the regression cases ("X-Fractor Eric
 * Hartman" → "Eric Hartman", clean "Eric Hartman" untouched) are pinned
 * in the test file.
 */
const PLAYER_FILTER_NOISE_PATTERNS: readonly RegExp[] = [
  /\bX-?Fractor\b/gi,
  /\bRefractor\b/gi,
  /\bSuperfractor\b/gi,
  /\bFractor\b/gi,
  /\bShimmer\b/gi,
  /\bSpeckle\b/gi,
  /\bGeometric\b/gi,
  /\bWave\b/gi,
  /\bRayWave\b/gi,
  /\bLava\b/gi,
  /\bGrass\b/gi,
  /\bReptilian\b/gi,
  /\bLogoFractor\b/gi,
  /\bPearl\b/gi,
  /\bNeon\b/gi,
  /\bSteel\b/gi,
  /\bMetal\b/gi,
  /\bMini-?Diamond\b/gi,
  /\bDiamond\b/gi,
  /\bAtomic\b/gi,
  /\bPattern\b/gi,
];

/**
 * CF-CH-RERANK-BY-INTENT (2026-06-28): score a CardHedge candidate by how
 * well it matches the user's parsed intent. Higher score = better match.
 * Returns 0 when nothing matches (CH's original order remains the
 * tiebreaker via stable sort).
 *
 * Scoring components:
 *   +3 if `intentWantsAuto` AND candidate is auto (matches user intent)
 *   -1 if `intentWantsAuto` AND candidate is NOT auto (penalty — user
 *      asked for auto; non-auto rows shouldn't bubble up)
 *   +2 per parallel-token match between intentTokens and candidate.variant
 *      (case-insensitive whole-token match)
 *
 * Exported for direct testing.
 */
export function scoreCandidateForIntent(opts: {
  isAuto: boolean | undefined;
  parallel: string | null | undefined;
  intentTokens: ReadonlyArray<string>;
  intentWantsAuto: boolean;
  /** CF-CH-RERANK-YEAR-MATCH (2026-06-29): user-stated year from parser.
   *  When present AND candidate's year matches, big boost. When present
   *  AND candidate's year differs by > 1, penalty. Vol Test #2 surfaced
   *  the canonical case: query "1953 Topps Duke Snider #210" → CH search
   *  ranked the 1991 Topps Archives reissue at position 1 (high volume)
   *  even though the actual 1953 Snider exists at position 2. */
  intentYear?: number | null;
  /** Candidate's year (may be number, string, or null). Normalized inside. */
  candidateYear?: number | string | null | undefined;
}): number {
  let score = 0;
  if (opts.intentWantsAuto) {
    score += opts.isAuto === true ? 3 : -1;
  }
  if (opts.parallel && opts.intentTokens.length > 0) {
    const parallelTokens = String(opts.parallel)
      .toLowerCase()
      .replace(/-/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    const parallelTokenSet = new Set(parallelTokens);
    for (const t of opts.intentTokens) {
      if (parallelTokenSet.has(t)) score += 2;
    }
  }
  // CF-CH-RERANK-YEAR-MATCH (2026-06-29)
  if (opts.intentYear != null && opts.intentYear >= 1900) {
    const candY =
      typeof opts.candidateYear === "number" && Number.isFinite(opts.candidateYear)
        ? opts.candidateYear
        : typeof opts.candidateYear === "string"
        ? Number(opts.candidateYear)
        : NaN;
    if (Number.isFinite(candY)) {
      const delta = Math.abs(candY - opts.intentYear);
      if (delta === 0) score += 4;       // exact year match — strongest rerank signal
      else if (delta === 1) score += 0;  // off-by-1 neutral (year boundary cases like Jan releases)
      else if (delta <= 3) score -= 2;   // small drift penalty
      else score -= 5;                   // big drift (Archives reissues, wrong-decade misroutes)
    }
  }
  return score;
}

export function sanitizePlayerForCH(playerName: string): string {
  let cleaned = playerName;
  for (const re of PLAYER_FILTER_NOISE_PATTERNS) {
    cleaned = cleaned.replace(re, " ");
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

export function buildFiltersFromParsedQuery(
  parsed: ReturnType<typeof parseCardQuery>,
): CardSearchFilters | undefined {
  if (parsed.confidence < PARSER_CONFIDENCE_FLOOR) return undefined;

  const filters: CardSearchFilters = {};
  if (parsed.playerName && parsed.playerName.length > 0) {
    // CF-CH-SANITIZE-PLAYER-FILTER (2026-06-28): strip parallel-vocabulary
    // tokens that leaked into playerName via the parser. Only set the
    // filter when at least one non-empty token remains — a fully-stripped
    // name (e.g. "X-Fractor" alone) yields the empty string, which we'd
    // be wrong to send as a filter (it would tell CH "match any player
    // whose name is empty" or worse, treat as no filter).
    const cleaned = sanitizePlayerForCH(parsed.playerName);
    if (cleaned.length > 0) {
      filters.player = cleaned;
    }
  }
  // CF-CARDSEARCH-FIRSTPASS (2026-07-01): the set filter is intentionally
  // NOT emitted. CardHedge's set filter is exact-match and their canonical
  // set names vary per-product in ways our synthesizer can't predict from
  // (year, brand, subset) alone — Vlad Jr's 2016 Bowman Chrome lives at
  // "2016 Bowman Chrome Prospects Baseball" not "2016 Bowman Chrome
  // Baseball"; Hammond's 2025 Bowman Chrome auto lives at "2025 Bowman
  // Draft Chrome Baseball". The prior CF-CH-SET-FILTER-ONLY-WHEN-SPECIFIC
  // guard tried to skip the emission when parsed.set == brand, but even
  // subset-confident parses (Bowman Chrome, Topps Chrome) miss on CH's
  // real set string ~half the time — 79% NO_RESULT rate across a 92-card
  // stress test (2026-07-01), all driven by the set-filter exact-match
  // mismatch.
  //
  // Empirically verified: dropping `filters.set` moves every one of those
  // failing cases from 0 candidates → 50 candidates (CH's page_size cap).
  // The downstream rerank (scoreCandidateForIntent) already scores by
  // year-delta (+4 exact, -5 for >3-year drift), parallel-token match,
  // and auto-intent, so the right variant surfaces from the wider pool
  // without needing pre-filter narrowing. The trade-off (rerank a bigger
  // pool vs pre-filter narrowly and sometimes zero out) is unambiguous.
  //
  // When CH gains a set-alias registry we can revisit; until then, the
  // player filter carries all of the narrowing weight and the rerank
  // does variant selection.
  if (parsed.isRookie) {
    filters.rookie = "Rookie";
  }

  // Only return a filter object when at least one field was set — keeps the
  // CH request body identical to pre-CF when no structured signal exists.
  if (!filters.player && !filters.rookie) return undefined;
  return filters;
}

/**
 * Extract a CertGraderErrorCode from an arbitrary rejection reason.
 * `Promise.allSettled` types reasons as `unknown`; this helper narrows
 * to a stable enum without throwing.
 */
function extractErrorCode(reason: unknown): CertGraderErrorCode {
  if (reason instanceof CertGraderError) return reason.code;
  const maybeCode = (reason as { code?: unknown })?.code;
  if (
    typeof maybeCode === "string" &&
    (maybeCode === "TOKEN_MISSING" ||
      maybeCode === "AUTH_FAILED" ||
      maybeCode === "QUOTA_EXCEEDED" ||
      maybeCode === "NOT_FOUND" ||
      maybeCode === "TIMEOUT" ||
      maybeCode === "REQUEST_FAILED")
  ) {
    return maybeCode;
  }
  return "UNKNOWN";
}

/**
 * Resolve which graders to dispatch to given the recognizers list
 * and the optional caller hint.
 *
 * - hint=cert + no recognizers → fan out to ALL registered graders
 *   (user explicitly said "this is a cert" on ambiguous input)
 * - otherwise → use the recognizers as-is
 */
function resolveGradersForCertMode(
  recognizers: CertGrader[],
  hint: UnifiedSearchMode | undefined,
): CertGrader[] {
  if (hint === "cert" && recognizers.length === 0) {
    return listCertGraders();
  }
  return recognizers;
}

async function dispatchCertMode(
  input: string,
  trimmed: string,
  graders: CertGrader[],
): Promise<UnifiedSearchResponse> {
  const settled = await Promise.allSettled(
    graders.map((g) => g.lookup(trimmed)),
  );

  const candidates: CardIdentity[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const grader = graders[i];
    if (result.status === "fulfilled") {
      candidates.push(grader.toCardIdentity(result.value as CertLookupResult));
    } else {
      const code = extractErrorCode(result.reason);
      warnings.push(`${grader.id}_cert_lookup_failed:${code}`);
    }
  }

  return {
    input: {
      raw: input,
      detectedMode: "cert",
      recognizingGraders: graders.map((g) => g.id),
    },
    candidates,
    warnings,
  };
}

// CF-CATALOG-FIRST-SHORTCUT (Drew, 2026-08-01). Before spending a
// CardHedge round-trip on every keystroke, try our own indexed
// catalog. When it returns a strong result set (≥ threshold), skip
// CH entirely — user gets fast (~50-250ms) matches from our own
// data. Falls through to the CH path otherwise so long-tail coverage
// is preserved.
// CF-CATALOG-SHORTCUT-TUNING (Drew, 2026-08-02). Threshold lowered
// 10 → 3 so we short-circuit more aggressively. Falling through to
// CardHedge's /card-search API costs 5-20s; taking canonical hits
// (even a few) is still faster.
// CF-CATALOG-FIRST-THRESHOLD-1 (Drew, 2026-08-02). Lowered from 3 → 1.
// Real-world case: "2011 topps gold trout" returned exactly 1 catalog
// hit (2011 Topps Pro Debut Materials #MM-MT — a real Trout Gold),
// which was < 3 so dispatcher fell through to CH freetext. CH returned
// "no_freetext_matches" and the user got 0 results. Any catalog hit is
// strictly better than CH freetext's 0. Concurrent supplement in
// canonicalCardSearch adds sold_comps hits too when catalog is thin,
// so single-hit queries pick up long-tail cards from the pool.
const CATALOG_FIRST_STRONG_THRESHOLD = 1;
const CATALOG_FIRST_SPORTS = ["baseball", "basketball", "football", "hockey", "soccer"];

// CF-SEARCH-DISPLAY-TITLE (Drew, 2026-08-06). Search results were
// showing slug-format text ("topps-chrome", "fs-1") in the title and
// meta because catalog docs store setName in slug form. Convert to
// display case for the title AND expose a prettified setName so the
// web card meta line also renders nicely.
function slugToDisplay(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw)
    .replace(/-/g, " ")
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ")
    .trim();
}
function titleCaseParallel(raw: string | null | undefined): string {
  if (!raw) return "";
  // Parallel names sometimes have "refractor", "chrome", etc — same
  // slug-to-title rule works.
  return slugToDisplay(raw);
}

function catalogHitToCardIdentity(hit: CanonicalSearchHit): CardIdentity {
  const displaySet = slugToDisplay(hit.releaseName);
  const displayParallel = titleCaseParallel(hit.parallels?.[0]?.name ?? null);
  const titleParts: string[] = [];
  if (hit.player) titleParts.push(hit.player);
  if (hit.cardYear) titleParts.push(String(hit.cardYear));
  if (displaySet) titleParts.push(displaySet);
  if (displayParallel) titleParts.push(displayParallel);
  if (hit.cardNumber) titleParts.push(`#${hit.cardNumber.toUpperCase()}`);
  return {
    // CF-CATALOG-CANDIDATE-ID-FIX (Drew, 2026-08-02). Use the vendor
    // cardId (bubble.io id from CH, or CS UUID) when available so
    // client-side candidateIdToCardsightId can route to the card
    // detail page. Prior `catalog:hiq:...` shape wasn't recognized
    // by the web app — click-through failed silently with a "cert
    // lookup" error. Fall back to catalog: prefix only when we
    // truly have no vendor cardId (sold_comps fallback candidates).
    candidateId: hit.cardId
      ? `cardsight:${hit.cardId}`
      : `catalog:${hit.hobbyiqCardId ?? `${hit.player}::${hit.cardYear}::${hit.cardNumber}`}`,
    source: "catalog",
    attribution: "ranked",
    confidence: Math.max(0.1, Math.min(1.0, hit.score / 20)),
    player: hit.player,
    year: hit.cardYear,
    brand: null,
    setName: displaySet || hit.releaseName,
    cardNumber: hit.cardNumber ? hit.cardNumber.toUpperCase() : null,
    parallel: displayParallel || hit.parallels?.[0]?.name || null,
    variation: null,
    isAuto: hit.isAutographSet,
    serialNumber: null,
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,
    title: titleParts.join(" ") || (hit.player ?? "Unknown card"),
    imageUrl: hit.imageUrl,
    parallels: hit.parallels?.map((p) => ({
      id: p.id,
      name: p.name,
      numberedTo: p.numberedTo ?? undefined,
    })),
    attributes: [],
  };
}

async function tryCatalogFirst(trimmed: string): Promise<CardIdentity[] | null> {
  try {
    // skipEnrichment=true: dispatcher only needs identity/candidate
    // data, not FMV per hit. Cuts each sport's search from ~2-7s to
    // ~200-500ms because we drop 20+ per-hit sold_comps queries.
    //
    // CF-CATALOG-FIRST-TIMEOUT (Drew, 2026-08-05, revised 2026-08-08).
    // Per-sport timeout. Original 2.5s was too aggressive: when
    // card_catalog is throttled (post-batch-write RU burn), the query
    // takes >2.5s and gets raced to null. User sees "no matches" for
    // cards that ARE in catalog. Now catalog-only freetext (no CH
    // safety net), a throttled miss shows as an empty result set with
    // no fallback — so we must let cosmos actually respond. 10s
    // accommodates 429 retry + slow partitions.
    const PER_SPORT_TIMEOUT_MS = 10_000;
    const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([
        p.catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PER_SPORT_TIMEOUT_MS)),
      ]);
    const results = await Promise.all(
      CATALOG_FIRST_SPORTS.map((sport) =>
        withTimeout(canonicalCardSearch({ q: trimmed, sport, limit: 30, skipEnrichment: true })),
      ),
    );
    const allHits: CanonicalSearchHit[] = [];
    for (const r of results) {
      if (r?.hits) allHits.push(...r.hits);
    }
    // Dedup across sports by hobbyiqCardId — a search token might hit
    // multiple sport pools for cross-sport words like "gold".
    const bySlug = new Map<string, CanonicalSearchHit>();
    for (const h of allHits) {
      const key = h.hobbyiqCardId ?? `${h.player}::${h.cardYear}::${h.cardNumber}`;
      if (!key) continue;
      const existing = bySlug.get(key);
      if (!existing || h.score > existing.score) bySlug.set(key, h);
    }
    const merged = [...bySlug.values()].sort((a, b) => b.score - a.score);
    if (merged.length < CATALOG_FIRST_STRONG_THRESHOLD) return null;
    return merged.slice(0, 100).map(catalogHitToCardIdentity);
  } catch {
    return null;
  }
}

async function dispatchFreetextMode(
  input: string,
  trimmed: string,
): Promise<UnifiedSearchResponse> {
  // CF-CATALOG-ONLY-FREETEXT (Drew, 2026-08-08). "We own the data,
  // everything is within here." Freetext search is CATALOG-ONLY now —
  // no CH fallback. If catalog returns 0, we return 0 rather than
  // pretending CH can save us (CH_RUNTIME_DISABLED=true, and the
  // architectural direction is to be truly self-sufficient on our own
  // pool + catalog). The old CH fallback path below is preserved
  // behind a dead branch for now — deletable once the pricing engine's
  // CH consumers are also decommissioned.
  const catalogFast = await tryCatalogFirst(trimmed);
  const candidates = catalogFast ?? [];
  return {
    input: { raw: input, detectedMode: "freetext" },
    candidates,
    warnings: candidates.length === 0 ? ["catalog_no_matches"] : [],
  };
}

/**
 * CF-YEAR-MISMATCH-TELEMETRY (2026-06-29): extract a 4-digit year from a
 * CH set name when the card object's year field is null/missing. CH
 * always carries the year in its set string ("2025 Bowman Chrome Baseball"),
 * so a regex fallback is reliable as a secondary source.
 */
export function extractYearFromSetText(setStr: string | undefined | null): number | null {
  if (!setStr) return null;
  const m = String(setStr).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

/**
 * CF-CROSS-VENDOR-DEDUP (Drew, 2026-07-13, PR #416): normalize a parallel
 * string for cross-vendor collision. Same physical variant may be:
 *   - "Blue X-Fractor" (Cardsight)
 *   - "Blue X-Fractor" (CH bubble.io)
 *   - "Blue X Fractor" (some CH rows drop the hyphen)
 * All should collide to the same normalized key.
 */
export function normalizeParallelForDedup(parallel: string | null | undefined): string {
  if (!parallel) return "";
  return parallel
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CF-UNIFIED-SEARCH-RANK (Drew, 2026-07-14): score a resolved CardIdentity
 * against parsed query intent so CH candidates and Cardsight-exploded
 * parallels can be ranked in a single pool. Pre-fix, Cardsight rows were
 * appended after CH's re-ranked list without ever being scored — so a
 * user-searched "Eric Hartman 2026 Blue Refractor Auto" landed the correct
 * SKU at the BOTTOM of the picker (past all 100 CH rows) because CH's
 * snapshot doesn't carry that parallel and the CS-exploded row got no
 * relevance signal.
 *
 * Score composition, all additive:
 *   - Base score from scoreCandidateForIntent (isAuto ± 3, parallel-token
 *     overlap × 2, year match ± 5). Same math CH candidates already use.
 *   - Title-token overlap × 1: intent tokens present in candidate.title
 *     that DIDN'T already match the parallel field. Catches "Blue" /
 *     "Refractor" when a CH candidate lacks a `variant` string but the
 *     title carries the parallel words. Bounded at +4 to avoid a long
 *     descriptive title dominating.
 *   - Exact-parallel bonus +5: normalized(candidate.parallel) === parsed
 *     parallel (both normalized via normalizeParallelForDedup). This
 *     pins the intended variant when the user typed the exact parallel
 *     name, regardless of which vendor the candidate came from.
 */
export function scoreIdentityForIntent(opts: {
  candidate: {
    isAuto: boolean;
    parallel: string | null | undefined;
    title: string | null | undefined;
    year: number | string | null | undefined;
  };
  intentTokens: ReadonlyArray<string>;
  intentWantsAuto: boolean;
  intentYear?: number | null;
  intentParallel?: string | null | undefined;
}): number {
  let score = scoreCandidateForIntent({
    isAuto: opts.candidate.isAuto,
    parallel: opts.candidate.parallel,
    intentTokens: opts.intentTokens,
    intentWantsAuto: opts.intentWantsAuto,
    intentYear: opts.intentYear,
    candidateYear: opts.candidate.year,
  });
  // Title-token overlap, bounded — only credit tokens the parallel field
  // didn't already claim, so parallel matches aren't double-counted.
  const parallelTokenSet = new Set(
    String(opts.candidate.parallel ?? "")
      .toLowerCase()
      .replace(/-/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
  const titleTokenSet = new Set(
    String(opts.candidate.title ?? "")
      .toLowerCase()
      .replace(/-/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
  let titleBonus = 0;
  for (const t of opts.intentTokens) {
    if (parallelTokenSet.has(t)) continue;   // already counted by parallel branch
    if (titleTokenSet.has(t)) titleBonus += 1;
    if (titleBonus >= 4) break;
  }
  score += titleBonus;
  // Exact-parallel bonus.
  if (opts.intentParallel) {
    const wantParallel = normalizeParallelForDedup(opts.intentParallel);
    const haveParallel = normalizeParallelForDedup(opts.candidate.parallel);
    if (wantParallel && haveParallel && wantParallel === haveParallel) {
      score += 5;
    }
  }
  return score;
}

/**
 * Adapt a CardHedge RoutedCard to the canonical CardIdentity shape.
 *
 * Freetext hits are relevance-ranked, not authoritative — confidence
 * decays by CardHedge's returned order so the iOS picker (which sorts
 * by confidence descending) preserves CardHedge's ranking. The
 * `cardsight:` candidateId prefix is retained as the stable wire
 * contract the iOS decoder strips before calling /price-by-id.
 */
// CF-WIRE-SET-YEAR-DEDUPE (Drew, 2026-07-13): CH + Cardsight catalog rows
// carry the year baked into the set string ("2026 Bowman Baseball",
// "1998 Leaf Rookies and Stars Baseball"). When iOS' header composer
// prepends `year` to `setName`, it renders "2026 2026 Bowman…". Strip
// the leading YYYY (and any surrounding whitespace) from setName when we
// have a year from either the structured field OR extracted from the
// same set string. Idempotent — running on "Bowman Baseball" is a no-op.
export function stripLeadingYear(setStr: string | null | undefined): string | null {
  if (typeof setStr !== "string") return null;
  const trimmed = setStr.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(/^\s*(19|20)\d{2}(?:\s+|$)/, "").trim();
  return stripped.length > 0 ? stripped : null;
}

// CF-WIRE-VARIANT-AUTO-DEDUPE (Drew, 2026-07-13): CH catalog variant
// strings sometimes carry an "Auto" suffix ("True Blue Refractor Auto",
// "Blue Refractor Auto /150"). iOS composes `[variant, "Auto"]` when
// `isAuto` is true, producing "…Auto…Auto". Strip standalone auto
// tokens from the variant so iOS' single Auto pill wins. Preserves
// serial suffixes like "/150" and any other non-auto tokens.
export function stripAutoFromVariant(variant: string | null | undefined): string | null {
  if (typeof variant !== "string") return null;
  const trimmed = variant.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed
    .replace(/\b(auto(?:graph(?:ed)?)?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

function routedCardToIdentity(
  card: RoutedCard,
  index: number,
  total: number,
  attributionOverride?: "ai-matched",
): CardIdentity {
  // CF-WIRE-YEAR-EXTRACT (Drew, 2026-07-13): Cardsight catalog rows have
  // `card.year = null` with the year embedded in `card.set` ("2026 Bowman
  // Baseball"). Extract as a fallback so the wire's `year` is populated
  // AND the set-name year-prefix stripping below has a signal to fire on.
  const structuredYear =
    card.year != null && Number.isFinite(Number(card.year))
      ? Number(card.year)
      : null;
  const extractedYear =
    structuredYear == null ? extractYearFromSetText(card.set) : null;
  const yearNum = structuredYear ?? extractedYear;

  const dedupedSetName = yearNum != null ? stripLeadingYear(card.set) : (card.set ?? null);
  const dedupedVariant = stripAutoFromVariant(card.variant);
  // CF-PARALLEL-COLLECTOR-ALIASES (Drew, 2026-07-13, PR #410): rewrite
  // Cardsight-canonical parallel labels to the names collectors use
  // (e.g. "Blue X-Fractor" → "Blue Refractor" for CPA-* /150 autos).
  // Underlying cardId is unchanged — only the display-facing string
  // shifts. Aliased hits log so we can track hit rate.
  const cardNumberStr = card.number != null ? String(card.number) : null;
  const aliasResult = applyCollectorAlias(dedupedVariant, cardNumberStr);
  const wireVariant = aliasResult.parallel;
  if (aliasResult.aliased) {
    console.log(JSON.stringify({
      event: "parallel_collector_alias_applied",
      source: "unifiedSearch.dispatcher",
      cardId: card.card_id,
      cardNumber: cardNumberStr,
      cardsightName: aliasResult.alias?.cardsightName,
      collectorName: aliasResult.alias?.collectorName,
    }));
  }

  const composedTitle =
    card.title?.trim() ||
    card.name?.trim() ||
    [yearNum, dedupedSetName, card.player, card.number, dedupedVariant]
      .map((p) => (p == null ? "" : String(p).trim()))
      .filter((p) => p.length > 0)
      .join(" ");

  // CF-CH-MATCH-CARD-BOOST (2026-06-28): AI-matched candidates get
  // confidence 1.0 + attribution "ai-matched" so the iOS picker's
  // confidence-descending sort keeps them at position 0. Without the
  // override, linear decay across the result set kicks in (floor 0.3).
  const span = Math.max(total, 1);
  const confidence =
    attributionOverride === "ai-matched"
      ? 1.0
      : Math.max(0.3, 1 - (index / span) * 0.6);
  const attribution =
    attributionOverride === "ai-matched" ? "ai-matched" : "ranked";

  return {
    // CF-SOURCE-VENDOR-NEUTRAL (2026-07-08, Drew): candidateId prefix
    // stays "cardsight:" — iOS strips it before calling /price-by-id
    // and the wire contract is load-bearing. The `source` field IS
    // display-facing though; emit vendor-neutral "catalog" so iOS
    // doesn't leak the decommissioned Cardsight name to users.
    candidateId: `cardsight:${card.card_id}`,
    source: "catalog",
    attribution,
    confidence: Math.round(confidence * 100) / 100,
    player: card.player ?? null,
    year: yearNum,
    brand: null,
    setName: dedupedSetName,
    cardNumber: cardNumberStr,
    parallel: wireVariant,
    variation: null,
    // CF-CH-AUTO-FROM-CARDNUMBER (2026-06-28): derive isAuto from the
    // card_number prefix. CardHedge's API doesn't expose an isAuto field,
    // so the prior hardcoded `false` was silently downgrading every
    // autograph card to non-auto in iOS' picker → AddHoldingRequest →
    // backend persist → engine mispriced as the cheaper non-auto variant.
    isAuto: detectIsAutoFromCardNumber(card.number),
    serialNumber: null,
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,
    title: composedTitle,
    // CF-CARDHEDGE-CARD-IMAGE (2026-06-30): surface the CardHedge CDN image
    // on each candidate so the iOS search picker (CardSearchView) renders a
    // thumbnail. The compiq.routes /cardsearch proxy-patch only fires for
    // UUID-shape ids, so CardHedge candidates rely on this value directly.
    imageUrl: card.imageUrl ?? null,
    raw: card,
  };
}

/**
 * Compose the cert-grader registry with the Cardsight catalog adapter
 * into a single unified search call.
 *
 * Per design §4. Single public entry point of the W3 dispatcher.
 */
export async function dispatchSearch(
  input: string,
  hint?: UnifiedSearchMode,
): Promise<UnifiedSearchResponse> {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return {
      input: { raw: input ?? "", detectedMode: "freetext" },
      candidates: [],
      warnings: ["empty_input"],
    };
  }

  const recognizers = findRecognizingGraders(trimmed);
  const mode: UnifiedSearchMode =
    hint ?? (recognizers.length > 0 ? "cert" : "freetext");

  if (mode === "cert") {
    const graders = resolveGradersForCertMode(recognizers, hint);
    return dispatchCertMode(input, trimmed, graders);
  }

  return dispatchFreetextMode(input, trimmed);
}
