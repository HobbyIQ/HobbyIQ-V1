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
  // CF-CH-SET-FILTER-ONLY-WHEN-SPECIFIC (2026-06-28): only send the set
  // filter when the parser identified a SUBSET more specific than the
  // brand alone (e.g. "Bowman Chrome", "Bowman Draft Chrome", "Topps
  // Chrome", "Topps Heritage"). When parsed.set equals parsed.brand
  // (user only typed "Bowman" / "Topps"), the composed set name
  // "${year} Bowman Baseball" doesn't match any CardHedge set — CH's
  // set names are granular and brand-only doesn't correspond to any
  // real set row. The exact-match filter then narrows to 0 candidates
  // even though hundreds of cards exist.
  //
  // Observable pre-fix: "2025 bowman josh hammond" → 0 candidates
  // (Hammond CPA-JH Refractor lives in "2025 Bowman Draft Chrome
  // Baseball" but the filter sent "2025 Bowman Baseball"). Bare
  // "josh hammond" returned 50 candidates including the Refractor auto.
  //
  // When user types a specific subset, the composition may still fail
  // (CH might use "Bowman Draft Chrome Baseball" vs our "Bowman Chrome
  // Baseball"), but at least the user expressed intent and a slight
  // mismatch is recoverable via the free-text search ranking. The
  // brand-only case has NO recovery — set filter just kills everything.
  if (parsed.set && parsed.set.length > 0 && parsed.set !== parsed.brand) {
    filters.set = parsed.year
      ? `${parsed.year} ${parsed.set} Baseball`
      : `${parsed.set} Baseball`;
  }
  if (parsed.isRookie) {
    filters.rookie = "Rookie";
  }

  // Only return a filter object when at least one field was set — keeps the
  // CH request body identical to pre-CF when no structured signal exists.
  if (!filters.player && !filters.set && !filters.rookie) return undefined;
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

async function dispatchFreetextMode(
  input: string,
  trimmed: string,
): Promise<UnifiedSearchResponse> {
  // Freetext catalog search is served by CardHedge's card-search
  // (POST /cards/card-search via cardhedge.client → searchCardsRouted).
  // The prior implementation returned zero candidates because the
  // Cardsight catalog was decommissioned; CardHedge exposes the same
  // free-text card lookup, so we route through it here. Each hit is
  // adapted to the canonical CardIdentity shape the iOS picker decodes.
  //
  // CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28): parse the trimmed query
  // backend-side and forward structured player/set/rookie fields to CH
  // when the parser's confidence clears PARSER_CONFIDENCE_FLOOR. CH's
  // tokenizer can then narrow by dedicated filter fields instead of
  // chewing through everything as one free-text blob. Observable on
  // Drake Baldwin 2025 Bowman Chrome Image Variation, which returned 0
  // candidates pre-CF because the parallel-name noise dominated the
  // free-text match.
  /**
   * CF-CH-RERANK-BY-INTENT (2026-06-28): tokens extracted from the raw user
   * query that we'll use to re-rank CardHedge's returned candidates. CH's
   * relevance ranker often buries the user's actually-intended variant
   * (e.g. CPA-NK Green Lava at position 35 for "nick kurtz green lava auto")
   * because its tokenizer doesn't bridge parallel + player + auto signals
   * the way we need it to.
   *
   * Tokens are length>=3, lowercase, alphanumeric. The auto flag is
   * extracted separately because it has its own scoring branch.
   */
  const intentTokens = trimmed
    .toLowerCase()
    .replace(/-/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && t !== "the" && t !== "and");
  const intentWantsAuto = /\bauto(graph(ed)?)?\b/i.test(trimmed);

  /**
   * CF-CH-MATCH-CARD-BOOST (2026-06-28): in parallel with the existing
   * token-search, ask CardHedge's AI matcher (/v1/cards/card-match)
   * to identify the most likely card from the user's raw query.
   * When it returns a high-confidence (>=0.80) card_id, we boost
   * that card to position 1 in the candidate list — either by
   * promoting an existing search hit OR by fetching its details
   * via /v1/cards/card-details and prepending.
   *
   * Solves the "card exists in CH but token-search ranks it
   * beyond position 50" class of issues (Kurtz CPA-NK Green Lava
   * sat at position 35+ for "nick kurtz green lava auto"). The AI
   * matcher understands semantic intent that token-search misses.
   *
   * Raw `trimmed` (not the sanitized search query) is passed to the
   * AI matcher — natural-language nuance is exactly what the AI
   * needs. Both calls fire concurrently to minimize latency.
   */
  const aiMatchPromise = identifyCard(trimmed).catch(() => null);

  const parsed = parseCardQuery(trimmed);
  const filters = buildFiltersFromParsedQuery(parsed);
  // CF-CH-QUERY-HYPHEN-NORMALIZE (2026-06-28): collapse hyphens to spaces
  // so CH's tokenizer doesn't split hyphenated parallel names like
  // "X-Fractor" / "Mini-Diamond" into unmatched fragments.
  const hyphenStripped = trimmed.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  //
  // CF-CH-SEARCH-MINIMAL-WHEN-FILTERED (2026-06-28): CardHedge's `search`
  // field indexes card title/description but NOT the parallel name. When
  // the user types "blue x-fractor" or "speckle refractor", those tokens
  // never match a description and CH's relevance scoring zeros out the
  // result set even though the player+set filter could narrow correctly.
  // Observable: live curl on
  //   "2026 bowman blue x fractor eric hartman auto" → 0 candidates
  //   "2026 bowman eric hartman auto" → 50 candidates (filter alone wins)
  //
  // Strategy: when structured filters are present (parser confidence
  // cleared PARSER_CONFIDENCE_FLOOR), trust the filter to do the
  // narrowing. Send just the player name as the search string so CH's
  // relevance scoring runs on a token guaranteed to appear in titles
  // (player name is always in the description). The user gets the full
  // filtered candidate set and can pick the parallel variant they want
  // from the picker UI. Without filters, fall back to the hyphen-stripped
  // full query as the search — the prior behavior.
  // CF-CH-SANITIZE-PLAYER-FILTER (2026-06-28): use the SAME sanitized
  // playerName for the search field so a polluted parser result doesn't
  // get sent twice (once as the filter, once as the search) — both must
  // be the same clean player name for CH to narrow + rank correctly.
  const chSearchQuery =
    filters && parsed.playerName
      ? sanitizePlayerForCH(parsed.playerName)
      : hyphenStripped;
  let hits: RoutedCard[];
  try {
    hits = await searchCardsRouted(chSearchQuery, FREETEXT_TAKE_DEFAULT, filters);
  } catch {
    // Surface a non-fatal warning rather than throwing — the route
    // layer maps thrown upstream timeouts to a 200 graceful shell, but
    // any other failure here should still yield an empty-but-valid
    // response so the picker degrades cleanly instead of erroring.
    return {
      input: { raw: input, detectedMode: "freetext" },
      candidates: [],
      warnings: ["freetext_search_failed"],
    };
  }

  // CF-CH-RERANK-BY-INTENT (2026-06-28): re-rank CH's results by parsed
  // intent (isAuto match + parallel-token match). CH's relevance ranking
  // sometimes buries the user's actually-intended variant deep in the
  // list — Kurtz CPA-NK Green Lava sat at position 35 for "green lava
  // auto" pre-rerank. Stable sort preserves CH's original order as the
  // tiebreaker for equal-scored candidates.
  const filteredHits = hits.filter(
    (c) => typeof c.card_id === "string" && c.card_id.length > 0,
  );
  // Detect if every candidate is auto from card-number prefix; we use the
  // same prefix detector the adapter uses so the rerank score's
  // `isAuto` matches what we'll surface to iOS.
  const scoredHits = filteredHits
    .map((card, originalIndex) => {
      const isAuto = detectIsAutoFromCardNumber(card.number);
      const score = scoreCandidateForIntent({
        isAuto,
        parallel: card.variant,
        intentTokens,
        intentWantsAuto,
      });
      return { card, originalIndex, score };
    })
    // Stable sort: higher score first; ties → preserve CH's original order.
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);

  /**
   * CF-CH-MATCH-CARD-BOOST (2026-06-28): consume the AI-match result.
   * `aiMatchPromise` resolves to either a high-confidence match or null.
   * Three outcomes:
   *   1. null / no match           → no boost, candidates ranked purely by intent score
   *   2. match_id IS in scoredHits → promote that card to position 0
   *   3. match_id NOT in scoredHits → fetch details, prepend as a synthetic position 0
   *
   * Outcome (3) is the load-bearing case — it surfaces cards that CH's
   * token search ranks beyond the 100-result window (Kurtz CPA-NK Green
   * Lava sat at position 35+ for "nick kurtz green lava auto"; with
   * other parallel-noisy queries it can sit beyond 100). The AI matcher
   * uses semantic understanding to find the right card_id even when
   * tokens don't line up, and we backfill the full card record via
   * /v1/cards/card-details so the iOS picker has everything it needs.
   *
   * Boosted candidates get `attribution: "ai-matched"` and `confidence: 1.0`
   * so the picker's confidence-descending sort keeps them at position 0
   * even if a downstream sort runs.
   */
  const aiMatch = await aiMatchPromise;
  let aiMatchedId: string | null = null;
  let prependedCard: RoutedCard | null = null;
  if (aiMatch && typeof aiMatch.card_id === "string" && aiMatch.card_id.length > 0) {
    aiMatchedId = aiMatch.card_id;
    const existingIdx = scoredHits.findIndex((h) => h.card.card_id === aiMatchedId);
    if (existingIdx > 0) {
      // Promote existing hit to the front (rerank didn't already).
      const [promoted] = scoredHits.splice(existingIdx, 1);
      scoredHits.unshift(promoted);
    } else if (existingIdx === -1) {
      // Not in our search window — fetch the card record directly.
      try {
        const fetched = await getCardDetailsById(aiMatchedId);
        if (fetched && fetched.card_id) {
          prependedCard = chCardToRoutedCard(fetched);
        } else {
          // Couldn't recover — drop the attribution so we don't tag the
          // (unrelated) search-result that's about to occupy position 0.
          aiMatchedId = null;
        }
      } catch {
        // Silently degrade — search hits already ranked, just no boost.
        aiMatchedId = null;
      }
    }
    // existingIdx === 0 → already first, no move needed. attribution stays.
  }

  const aiAttributedIds = new Set<string>();
  if (aiMatchedId) {
    aiAttributedIds.add(aiMatchedId);
  }

  const orderedCards: RoutedCard[] = prependedCard
    ? [prependedCard, ...scoredHits.map((s) => s.card)]
    : scoredHits.map((s) => s.card);

  const candidates = orderedCards.map((card, newIndex) =>
    routedCardToIdentity(
      card,
      newIndex,
      orderedCards.length,
      aiAttributedIds.has(card.card_id) ? "ai-matched" : undefined,
    ),
  );

  return {
    input: { raw: input, detectedMode: "freetext" },
    candidates,
    warnings: candidates.length === 0 ? ["no_freetext_matches"] : [],
  };
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
function routedCardToIdentity(
  card: RoutedCard,
  index: number,
  total: number,
  attributionOverride?: "ai-matched",
): CardIdentity {
  const yearNum =
    card.year != null && Number.isFinite(Number(card.year))
      ? Number(card.year)
      : null;

  const composedTitle =
    card.title?.trim() ||
    card.name?.trim() ||
    [card.year, card.set, card.player, card.number, card.variant]
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
    candidateId: `cardsight:${card.card_id}`,
    source: "cardsight-catalog",
    attribution,
    confidence: Math.round(confidence * 100) / 100,
    player: card.player ?? null,
    year: yearNum,
    brand: null,
    setName: card.set ?? null,
    cardNumber: card.number != null ? String(card.number) : null,
    parallel: card.variant ?? null,
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
