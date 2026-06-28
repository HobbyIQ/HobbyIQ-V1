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
  type RoutedCard,
} from "../compiq/cardsight.router.js";
import { parseCardQuery } from "../compiq/cardQueryParser.js";
import type { CardSearchFilters } from "../compiq/cardhedge.client.js";

const FREETEXT_TAKE_DEFAULT = 30;

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
export function buildFiltersFromParsedQuery(
  parsed: ReturnType<typeof parseCardQuery>,
): CardSearchFilters | undefined {
  if (parsed.confidence < PARSER_CONFIDENCE_FLOOR) return undefined;

  const filters: CardSearchFilters = {};
  if (parsed.playerName && parsed.playerName.length > 0) {
    filters.player = parsed.playerName;
  }
  if (parsed.set && parsed.set.length > 0) {
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
  const parsed = parseCardQuery(trimmed);
  const filters = buildFiltersFromParsedQuery(parsed);
  let hits: RoutedCard[];
  try {
    hits = await searchCardsRouted(trimmed, FREETEXT_TAKE_DEFAULT, filters);
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

  const candidates = hits
    .filter((c) => typeof c.card_id === "string" && c.card_id.length > 0)
    .map((card, index) => routedCardToIdentity(card, index, hits.length));

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

  // Linear decay across the result set, floored at 0.3 so even the last
  // hit reads as a plausible (low) relevance match rather than zero.
  const span = Math.max(total, 1);
  const confidence = Math.max(0.3, 1 - (index / span) * 0.6);

  return {
    candidateId: `cardsight:${card.card_id}`,
    source: "cardsight-catalog",
    attribution: "ranked",
    confidence: Math.round(confidence * 100) / 100,
    player: card.player ?? null,
    year: yearNum,
    brand: null,
    setName: card.set ?? null,
    cardNumber: card.number != null ? String(card.number) : null,
    parallel: card.variant ?? null,
    variation: null,
    isAuto: false,
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
