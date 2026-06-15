// CF-CARDSIGHT-RESOLVER-REDESIGN — title-matching with specificity guard.
//
// Pure function that filters a Cardsight pricing response by parallel
// when Cardsight's own parallel_id filter returned empty but the catalog
// confirms the parallel exists. Used by cardsight.router after the
// concurrent getPricing + getCardDetail fetch completes.
//
// Architecture (per docs/phase0/resolver_redesign_design.md):
//   1. resolveCardId binds the user's parallel input to a Cardsight
//      parallelId in detail.parallels[] via tokenizeParallel + strict-set
//      equality (the wrapper-strip in 4effbf4 handles "Limited Edition
//      (Tiffany)" → ["tiffany"]).
//   2. getPricing tries the parallel_id filter; if empty it retries
//      without filter and flags priceSource="unified-fallback" on the
//      response (this commit).
//   3. THIS HELPER: when the fallback fired AND the user specified a
//      parallel AND the parallelId is non-null, apply a title-match
//      filter to the unified bucket. The match condition is gated by a
//      specificity guard built from sibling parallels[] tokens to avoid
//      generic-token over-pull (e.g. "Refractor" matching every
//      "Blue Refractor"/"Gold Refractor"/etc. sale).
//
// The helper emits a 7-value internal priceSource enum; the response-
// shaping layer collapses to 3 user-facing categories (exact /
// approximate / broad) per design doc §3g.

import type { CardsightPricingResponse } from "./cardsight.client.js";
import { tokenizeParallel } from "./cardsight.mapper.js";
import {
  CHROME_DRAFT_MULTIPLIERS,
  BOWMAN_2022_FAMILY_ENTRIES,
} from "./chromeDraftMultipliers.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "parallelTitleMatch", ...fields })),
};

/** Number of records required to consider a title-matched sample "normal" confidence. */
const LOW_SAMPLE_THRESHOLD = 3;

/**
 * CF-PINNED-PARALLEL-RECOVERY (2026-06-11) — registry-independent
 * specificity guard.
 *
 * Tokens that describe the card CATEGORY (autograph variant, refractor
 * family, base version) but do NOT discriminate between sibling finishes
 * within that category. The variant tier ladder handles auto/non-auto +
 * base/non-base distinctions on the value path; this guard only needs
 * to reject MORE-SPECIFIC sibling parallels (e.g. "Blue Wave Refractor"
 * for a target "Blue Refractor"), so common category labels must not
 * trigger rejection.
 */
const CATEGORY_LABEL_TOKENS: ReadonlySet<string> = new Set([
  "auto",
  "autograph",
  "refractor",
  "base",
]);

/**
 * CF-PINNED-PARALLEL-RECOVERY (2026-06-11) — finish/qualifier vocabulary
 * derived at module load from every canonical parallel name in the
 * owner-curated multiplier tables. Used as a registry-INDEPENDENT
 * backstop to the existing siblingParallels-based specificity guard:
 * even when Cardsight's detail.parallels[] omits a sibling (Leo De
 * Vries Blue Refractor /150 case — the registry didn't list "Blue Wave
 * Refractor", so the registry guard had no token to subtract; the leak
 * surfaced a $285 Blue Wave at "Blue Refractor"), the vocab catches
 * extra finish tokens in candidate titles.
 *
 * Updates automatically when the curated tables grow. Subtracting the
 * CATEGORY_LABEL_TOKENS up-front keeps "auto"/"refractor"-suffixed
 * titles from incorrectly triggering rejection.
 */
const PARALLEL_QUALIFIER_VOCAB: ReadonlySet<string> = (() => {
  const tokens = new Set<string>();
  const collect = (parallelName: string): void => {
    for (const t of tokenizeParallel(parallelName)) {
      if (CATEGORY_LABEL_TOKENS.has(t)) continue;
      tokens.add(t);
    }
  };
  for (const entry of Object.values(CHROME_DRAFT_MULTIPLIERS)) {
    collect(entry.parallelName);
  }
  for (const entry of BOWMAN_2022_FAMILY_ENTRIES) {
    collect(entry.parallelName);
  }
  return tokens;
})();

/**
 * CF-GRADED-PRICE-PROJECTION (2026-06-12): exported "is this title a
 * base record?" predicate. Single source of truth for base/parallel
 * splitting across the value path (recovery's specificity guard) and
 * the new graded-price estimator. Returns TRUE when the title carries
 * NO finish-qualifier tokens beyond the category labels (auto /
 * autograph / refractor / base) — i.e., no color/finish word that
 * would mark it as a more-specific sibling.
 *
 * Whitespace + hyphen + slash + comma + period + hash split, parens
 * dropped (not their content extracted — different from
 * tokenizeParallel's wrapper-strip; titles use parens for sample
 * markers, not for canonical-name aliasing). Case-insensitive.
 *
 * Empty/missing title → treat as base (can't classify; default to
 * inclusion, the value path already filters by parallel_id elsewhere).
 */
export function isBaseTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  const stripped = String(title).replace(/\([^)]*\)/g, " ");
  const tokens = stripped
    .split(/[\s\-\/.,#]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
  for (const t of tokens) {
    if (CATEGORY_LABEL_TOKENS.has(t)) continue;
    if (PARALLEL_QUALIFIER_VOCAB.has(t)) return false;
  }
  return true;
}

export type ParallelPriceSource =
  | "cardsight-parallel-id"
  | "title-matched-parallel"
  | "title-match-low-sample"
  | "unified-fallback-generic"
  | "unified-fallback-no-match"
  | "unified-no-parallel"
  | "unified-no-cardsight-match";

export type UserFacingPriceSource = "exact" | "approximate" | "broad";

export function collapsePriceSource(internal: ParallelPriceSource): UserFacingPriceSource {
  switch (internal) {
    case "cardsight-parallel-id":
    case "title-matched-parallel":
      return "exact";
    case "title-match-low-sample":
    case "unified-fallback-generic":
      return "approximate";
    case "unified-fallback-no-match":
    case "unified-no-parallel":
    case "unified-no-cardsight-match":
      return "broad";
  }
}

export interface ParallelTitleMatchInput {
  pricingResponse: CardsightPricingResponse;
  /** Did _getPricing fall back to unified (parallel_id filter returned empty)? */
  pricingCameFromUnifiedFallback: boolean;
  /** Raw user input from the request (the parallel string they typed). */
  userParallelInput: string | null | undefined;
  /** The parallelId resolveCardId bound the user's input to, or null. */
  matchedParallelId: string | null;
  /** detail.parallels[] from getCardDetail — for the specificity guard. */
  siblingParallels: Array<{ id: string; name: string }>;
}

export interface ParallelTitleMatchResult {
  response: CardsightPricingResponse;
  priceSource: ParallelPriceSource;
  filteredCount: number;
  totalUnifiedCount: number;
  /** Tokens used for the title match (empty when no filter applied). */
  matchTokens: string[];
  /** Distinguishing tokens excluded by the specificity guard (empty when guard didn't fire). */
  excludedTokens: string[];
}

export function applyParallelTitleMatch(
  input: ParallelTitleMatchInput,
): ParallelTitleMatchResult {
  const totalUnifiedCount = countRecords(input.pricingResponse);

  // ─── No user parallel → unified, no filter ────────────────────────────
  const userInput = (input.userParallelInput ?? "").trim();
  if (!userInput) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-no-parallel",
      filteredCount: totalUnifiedCount,
      totalUnifiedCount,
      matchTokens: [],
      excludedTokens: [],
    };
  }

  // ─── User parallel didn't match any Cardsight sibling → integrity-gate ─
  if (!input.matchedParallelId) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-no-cardsight-match",
      filteredCount: totalUnifiedCount,
      totalUnifiedCount,
      matchTokens: [],
      excludedTokens: [],
    };
  }

  // ─── parallel_id filter delivered → no title-match needed ─────────────
  if (!input.pricingCameFromUnifiedFallback) {
    return {
      response: input.pricingResponse,
      priceSource: "cardsight-parallel-id",
      filteredCount: totalUnifiedCount,
      totalUnifiedCount,
      matchTokens: [],
      excludedTokens: [],
    };
  }

  // ─── Title-match path: compute tokens + specificity guard ─────────────
  const built = buildParallelTitleMatcher(userInput, input.siblingParallels, {
    matchedParallelId: input.matchedParallelId,
  });
  if (built === null) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-no-parallel",
      filteredCount: totalUnifiedCount,
      totalUnifiedCount,
      matchTokens: [],
      excludedTokens: [],
    };
  }
  const { matches, userTokens, excludedTokens: excludedTokensList } = built;

  const filtered = filterPricingRecords(input.pricingResponse, matches);
  const filteredCount = countRecords(filtered);

  // ─── Filtered set decision ─────────────────────────────────────────────
  if (filteredCount === 0) {
    log.info("title_match_no_match", {
      matchedParallelId: input.matchedParallelId,
      userInput,
      userTokens,
      excludedTokens: excludedTokensList,
      siblingCount: input.siblingParallels.length,
      totalUnifiedCount,
    });
    return {
      response: input.pricingResponse,
      priceSource: "unified-fallback-no-match",
      filteredCount: 0,
      totalUnifiedCount,
      matchTokens: userTokens,
      excludedTokens: excludedTokensList,
    };
  }

  if (filteredCount < LOW_SAMPLE_THRESHOLD) {
    log.info("title_match_low_sample", {
      matchedParallelId: input.matchedParallelId,
      userInput,
      userTokens,
      excludedTokens: excludedTokensList,
      filteredCount,
      totalUnifiedCount,
    });
    return {
      response: filtered,
      priceSource: "title-match-low-sample",
      filteredCount,
      totalUnifiedCount,
      matchTokens: userTokens,
      excludedTokens: excludedTokensList,
    };
  }

  log.info("title_match_applied", {
    matchedParallelId: input.matchedParallelId,
    userInput,
    userTokens,
    excludedTokens: excludedTokensList,
    filteredCount,
    totalUnifiedCount,
  });
  return {
    response: filtered,
    priceSource: "title-matched-parallel",
    filteredCount,
    totalUnifiedCount,
    matchTokens: userTokens,
    excludedTokens: excludedTokensList,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * CF-GRADED-PRECEDENCE-OBSERVED (2026-06-15): canonical title-matcher
 * factory. Extracted from applyParallelTitleMatch so the graded-tier
 * precedence path (computeSameParallelRawMedian in gradedPriceProjection)
 * can reuse the SAME word-boundary + catalog-derived sibling-exclusion +
 * finish-vocab span-backstop semantics that the resolver already enforces
 * for the unified-fallback comp filter.
 *
 * Returns null when no tokens can be derived (empty/whitespace input);
 * otherwise returns the predicate plus the tokens/exclusions it used (the
 * resolver caller logs them in telemetry; new graded-tier caller doesn't).
 *
 * `matchedParallelId` may be omitted when the caller doesn't have one
 * (graded-tier caller passes the targetParallelId; resolver passes the
 * already-bound matched id) — it's only used to exclude that parallel
 * from the sibling-token derivation. Pass null to skip the self-exclusion.
 */
export function buildParallelTitleMatcher(
  parallelName: string,
  siblingParallels: ReadonlyArray<{ id: string; name: string }>,
  opts: { matchedParallelId?: string | null } = {},
): {
  matches: (title: string | undefined | null) => boolean;
  userTokens: string[];
  excludedTokens: string[];
} | null {
  const userTokens = tokenizeParallel(parallelName);
  if (userTokens.length === 0) return null;

  const userTokenSet = new Set(userTokens);

  // Specificity guard: find siblings where userTokens is a PROPER SUBSET
  // of siblingTokens. Such siblings produce "distinguishing tokens" we
  // must exclude from match.
  const matchedId = opts.matchedParallelId ?? null;
  const otherSiblings = siblingParallels.filter(
    (p) => matchedId === null || p.id !== matchedId,
  );
  const distinguishingTokens = new Set<string>();
  for (const sibling of otherSiblings) {
    const sTokens = tokenizeParallel(sibling.name);
    if (sTokens.length <= userTokens.length) continue;
    const allUserInSibling = userTokens.every((t) => sTokens.includes(t));
    if (!allUserInSibling) continue;
    for (const t of sTokens) {
      if (!userTokenSet.has(t)) distinguishingTokens.add(t);
    }
  }
  const excludedTokens = Array.from(distinguishingTokens);

  // Match function: title contains ALL userTokens AND NONE of distinguishingTokens.
  // Word-boundary semantics (NOT substring): user token "refractor" must NOT
  // match "superfractor" inside a title.
  const wordMatchPatterns = userTokens.map((t) => buildWordBoundaryPattern(t));
  const exclusionPatterns = excludedTokens.map((t) =>
    buildWordBoundaryPattern(t),
  );
  const matches = (title: string | undefined | null): boolean => {
    if (!title) return false;
    for (const pattern of wordMatchPatterns) {
      if (!pattern.test(title)) return false;
    }
    for (const pattern of exclusionPatterns) {
      if (pattern.test(title)) return false;
    }
    // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): span-scoped finish-vocab
    // backstop. AUGMENTS the registry-based exclusion above — never
    // replaces it. A candidate title that carries a vocab token
    // INTERIOR to the user-token span is a more-specific sibling and is
    // rejected even when detail.parallels[] didn't enumerate it.
    //
    // Span-scoping (not full-title) matters because color/finish tokens
    // often appear elsewhere in real titles as TEAM context — "Toronto
    // Blue Jays ... Gold Refractor" must NOT reject on "blue".
    const titleTokens = tokenizeParallel(title);
    const userTokenPositions: number[] = [];
    for (let i = 0; i < titleTokens.length; i++) {
      if (userTokenSet.has(titleTokens[i]!)) userTokenPositions.push(i);
    }
    if (userTokenPositions.length > 0) {
      const spanStart = userTokenPositions[0]!;
      const spanEnd = userTokenPositions[userTokenPositions.length - 1]!;
      for (let i = spanStart + 1; i < spanEnd; i++) {
        const t = titleTokens[i]!;
        if (userTokenSet.has(t)) continue;
        if (CATEGORY_LABEL_TOKENS.has(t)) continue;
        if (PARALLEL_QUALIFIER_VOCAB.has(t)) return false;
      }
    }
    return true;
  };

  return { matches, userTokens, excludedTokens };
}

/**
 * Build a case-insensitive word-boundary regex for a token. Word boundary
 * (\b) prevents substring over-pull — `buildWordBoundaryPattern("refractor")`
 * does NOT match "superfractor" in a title. Escapes regex metacharacters in
 * the token defensively (tokens come from user input + tokenizeParallel).
 */
function buildWordBoundaryPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function countRecords(response: CardsightPricingResponse): number {
  const rawCount = response.raw?.records?.length ?? 0;
  const gradedCount = (response.graded ?? []).reduce(
    (sum, company) =>
      sum +
      (company.grades ?? []).reduce(
        (s, grade) => s + (grade.records?.length ?? 0),
        0,
      ),
    0,
  );
  return rawCount + gradedCount;
}

function filterPricingRecords(
  response: CardsightPricingResponse,
  matches: (title: string | undefined) => boolean,
): CardsightPricingResponse {
  const filteredRawRecords = (response.raw?.records ?? []).filter((r) =>
    matches(r.title),
  );
  const filteredGraded = (response.graded ?? [])
    .map((company) => ({
      ...company,
      grades: (company.grades ?? [])
        .map((grade) => ({
          ...grade,
          records: (grade.records ?? []).filter((r) => matches(r.title)),
        }))
        .filter((grade) => grade.records.length > 0),
    }))
    .filter((company) => company.grades.length > 0);

  return {
    ...response,
    raw: {
      ...(response.raw ?? { count: 0, records: [] }),
      count: filteredRawRecords.length,
      records: filteredRawRecords,
    },
    graded: filteredGraded,
  };
}
