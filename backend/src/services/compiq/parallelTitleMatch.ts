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

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "parallelTitleMatch", ...fields })),
};

/** Number of records required to consider a title-matched sample "normal" confidence. */
const LOW_SAMPLE_THRESHOLD = 3;

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
  const userTokens = tokenizeParallel(userInput);
  if (userTokens.length === 0) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-no-parallel",
      filteredCount: totalUnifiedCount,
      totalUnifiedCount,
      matchTokens: [],
      excludedTokens: [],
    };
  }

  const userTokenSet = new Set(userTokens);

  // Specificity guard: find siblings (excluding the matched parallel
  // itself) where userTokens is a PROPER SUBSET of siblingTokens. Such
  // siblings produce "distinguishing tokens" we must exclude from match.
  const otherSiblings = input.siblingParallels.filter(
    (p) => p.id !== input.matchedParallelId,
  );
  const distinguishingTokens = new Set<string>();
  for (const sibling of otherSiblings) {
    const sTokens = tokenizeParallel(sibling.name);
    // Proper subset: user has fewer tokens than sibling, all present in sibling.
    if (sTokens.length <= userTokens.length) continue;
    const allUserInSibling = userTokens.every((t) => sTokens.includes(t));
    if (!allUserInSibling) continue;
    for (const t of sTokens) {
      if (!userTokenSet.has(t)) distinguishingTokens.add(t);
    }
  }
  const excludedTokensList = Array.from(distinguishingTokens);

  // Match function: title contains ALL userTokens AND NONE of distinguishingTokens.
  // Word-boundary semantics (NOT substring): user token "refractor" must NOT
  // match "superfractor" inside a title. Substring matching would over-pull
  // fused-word parallels (SuperFractor, LogoFractor, etc.) into a generic
  // "Refractor" filter result.
  const wordMatchPatterns = userTokens.map((t) => buildWordBoundaryPattern(t));
  const exclusionPatterns = Array.from(distinguishingTokens).map((t) =>
    buildWordBoundaryPattern(t),
  );
  const matches = (title: string | undefined): boolean => {
    if (!title) return false;
    for (const pattern of wordMatchPatterns) {
      if (!pattern.test(title)) return false;
    }
    for (const pattern of exclusionPatterns) {
      if (pattern.test(title)) return false;
    }
    return true;
  };

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
