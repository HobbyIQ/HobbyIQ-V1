// PREDICTION-ROBUSTNESS-RECON #1 (2026-06-02) — graceful CardsightTimeoutError
// handling for the 5 prediction-path routes.
//
// PROBLEM (before this CF):
//   /price, /search, /price-by-id, /cardsearch, /bulk all bubble
//   CardsightTimeoutError to Express's default error handler, which emits
//   HTTP 500 with body `{"error": "Cardsight API request timed out after 20s"}`.
//   iOS surfaces this as "save failed" toast instead of a soft-fail shape.
//   Trigger: the Cardsight catalog search times out at 20s on some queries
//   (e.g. "Elly De La Cruz 2024 Topps Chrome" — reproducible 500).
//
// FIX (this module):
//   Per-route builders that produce the same shape the unsupported_sport
//   short-circuit emits — HTTP 200 with `source: "upstream-timeout"`, null
//   pricing fields, summary "Couldn't reach the catalog in time. Try again
//   in a moment.", and shape-stable defaults for every documented field so
//   iOS clients can render uniformly across all branches.
//
// PARKED (NOT fixed here): the underlying Cardsight timeout itself. This
// module makes the failure graceful but the card still won't predict on
// these timed-out queries. Root-cause investigation + retry tuning is
// `CF-CARDSIGHT-TIMEOUT-ROOT-CAUSE-INVESTIGATION`.
//
// Design notes:
// - The helper functions return the FULL ready-to-send response object,
//   so routes just call `res.json(buildUpstreamTimeoutPriceResponse(query))`
//   in their `catch (err)` block.
// - Source = "upstream-timeout" is a new source string. Add to
//   compLogMapping.ts + predictedRange.ts NON_LIVE_SOURCES if you want
//   the corpus + regime classifier to treat it consistently with
//   no-recent-comps / unsupported_sport. (Followup CF; not done here —
//   the corpus tolerates unknown source strings by storing them verbatim.)
// - buildEngineMeta is intentionally NOT imported here. The route still
//   spreads it before the helper return so engine metadata stays close
//   to the route concern; the helper covers ONLY the pricing payload.

import type { UnifiedSearchResponse } from "../../types/unifiedSearch.js";

/**
 * Upstream catalog/pricing timeout error. Relocated here (inline) during the
 * Cardsight removal arc (Phase 3 Wave 3) — was previously exported from the
 * now-deleted cardsight.client.ts. Kept under the legacy name so the route
 * call sites that use `isCardsightTimeoutError` continue to compile and any
 * upstream layer that throws it is still classified as a graceful timeout.
 */
export class CardsightTimeoutError extends Error {
  constructor(message = "Upstream catalog request timed out") {
    super(message);
    this.name = "CardsightTimeoutError";
  }
}

/** Type guard — usable anywhere we have `catch (err)`. */
export function isCardsightTimeoutError(err: unknown): err is CardsightTimeoutError {
  return err instanceof CardsightTimeoutError;
}

/** Shared summary copy — surface-stable across all routes. */
export const UPSTREAM_TIMEOUT_SUMMARY =
  "Couldn't reach the catalog in time. Try again in a moment.";

/** Source string emitted on the response + corpus row. */
export const UPSTREAM_TIMEOUT_SOURCE = "upstream-timeout" as const;

/**
 * /price + /search response payload on Cardsight timeout. The shape
 * mirrors the existing `unsupported_sport` short-circuit at
 * compiq.routes.ts:578-632 (/price) and L355-410 (/search) — null
 * pricing fields + shape-stable defaults across every documented field.
 *
 * Route still spreads buildEngineMeta() around the return.
 */
export function buildUpstreamTimeoutPriceResponse(query: string): Record<string, unknown> {
  return {
    success: true,
    query: query.trim(),
    summary: UPSTREAM_TIMEOUT_SUMMARY,
    marketTier: { value: null, high: null },
    buyZone: [null, null],
    holdZone: [null, null],
    sellZone: [null, null],
    fairMarketValueLive: null,
    marketValue: null,
    predictedPrice: null,
    predictedPriceRange: null,
    predictedPriceAttribution: {
      mechanism: "unavailable",
      failureReason: "upstream-timeout",
    },
    trendIQ: null,
    signalsLastUpdated: null,
    confidence: 0,
    source: UPSTREAM_TIMEOUT_SOURCE,
    trendAnalysis: {
      market_direction: "flat",
      change_from_older_to_recent: null,
      liquidity: "Normal",
    },
    regime: "insufficient_data",
    regimeConfidence: "low",
    regimeDiagnostics: {
      classificationReason: `skipped_classification: source=${UPSTREAM_TIMEOUT_SOURCE}`,
    },
    supply: null,
    recentComps: [],
    cardIdentity: null,
    gradeUsed: null,
    compsUsed: 0,
    compsAvailable: 0,
    daysSinceNewestComp: null,
    variantWarning: [],
    neighborSynthesis: null,
    crossParallelAnchor: null,
    buySignal: null,
  };
}

/**
 * /price-by-id response payload on Cardsight timeout. Mirrors the
 * /price-by-id unsupported-sport branch at compiq.routes.ts:788-826;
 * difference vs /price: exposes `cardId` (pinned id) instead
 * of the parsed query.
 */
export function buildUpstreamTimeoutPriceByIdResponse(
  cardId: string,
): Record<string, unknown> {
  return {
    success: true,
    cardId,
    summary: UPSTREAM_TIMEOUT_SUMMARY,
    marketTier: { value: null, high: null },
    buyZone: [null, null],
    holdZone: [null, null],
    sellZone: [null, null],
    fairMarketValueLive: null,
    marketValue: null,
    predictedPrice: null,
    predictedPriceRange: null,
    predictedPriceAttribution: {
      mechanism: "unavailable",
      failureReason: "upstream-timeout",
    },
    trendIQ: null,
    signalsLastUpdated: null,
    confidence: 0,
    source: UPSTREAM_TIMEOUT_SOURCE,
    trendAnalysis: {
      market_direction: "flat",
      change_from_older_to_recent: null,
      liquidity: "Normal",
      broaderTrend: null,
    },
    regime: "insufficient_data",
    regimeConfidence: "low",
    regimeDiagnostics: {
      classificationReason: `skipped_classification: source=${UPSTREAM_TIMEOUT_SOURCE}`,
    },
    recentComps: [],
    cardIdentity: null,
    gradeUsed: null,
    compsUsed: 0,
    compsAvailable: 0,
    daysSinceNewestComp: null,
    broaderTrend: null,
  };
}

/**
 * /cardsearch response payload on Cardsight timeout. Returns the
 * documented UnifiedSearchResponse shape with empty candidates +
 * a structured warning so iOS clients can detect the timeout vs an
 * empty-catalog miss without parsing free-text strings.
 *
 * Warning string format: "upstream_timeout:cardsight_search" — stable
 * key for downstream parsing per the UnifiedSearchResponse contract
 * (warnings field is documented to carry structured "code:detail"
 * tokens).
 */
export function buildUpstreamTimeoutCardSearchResponse(
  query: string,
  detectedMode: "freetext" | "cert" = "freetext",
): UnifiedSearchResponse {
  return {
    input: {
      raw: query,
      detectedMode,
    },
    candidates: [],
    warnings: ["upstream_timeout:cardsight_search"],
  };
}

/**
 * /bulk per-item response data on Cardsight timeout. The route wraps
 * this in `{ query, status: "ok", data, error: null }` to keep the
 * bulk envelope consistent — a timeout on ONE item should NOT take
 * down the whole bulk request, and the iOS row for that item still
 * gets a well-shaped data object.
 *
 * Compact shape mirrors the unsupported_sport per-item shape at
 * compiq.routes.ts:960-984.
 */
export function buildUpstreamTimeoutBulkItemData(query: string): Record<string, unknown> {
  return {
    success: true,
    query,
    summary: UPSTREAM_TIMEOUT_SUMMARY,
    marketTier: { value: null, high: null },
    fairMarketValueLive: null,
    marketValue: null,
    predictedPrice: null,
    predictedPriceRange: null,
    predictedPriceAttribution: {
      mechanism: "unavailable",
      failureReason: "upstream-timeout",
    },
    trendIQ: null,
    signalsLastUpdated: null,
    confidence: 0,
    trendAnalysis: { market_direction: "flat" },
    source: UPSTREAM_TIMEOUT_SOURCE,
    regime: "insufficient_data",
    regimeConfidence: "low",
    regimeDiagnostics: {
      classificationReason: `skipped_classification: source=${UPSTREAM_TIMEOUT_SOURCE}`,
    },
    compsUsed: 0,
    compsAvailable: 0,
  };
}
