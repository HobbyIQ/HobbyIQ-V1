import { Router } from "express";
import { compiqEstimate, computeEstimate, simulateWhatIf } from "../services/compiq/compiqEstimate.service.js";
import { cacheWrap, cacheSet, cacheDel } from "../services/shared/cache.service.js";
import { CompIQEstimateRequest } from "../types/compiq.types.js";
// CF-MARKET-READ (2026-06-08): grounded prose summary of the comp pool
// for /price-by-id. Reads from the cs:pricing cached payload — no new
// Cardsight wire op. See marketRead.service.ts header for architecture.
import {
  generateMarketRead,
  type MarketReadResult,
} from "../services/compiq/marketRead.service.js";
import { getPricing as getPricingForMarketRead } from "../services/compiq/cardsight.client.js";
import { getNormalizationDictionary } from "../services/compiq/normalizationDictionary.service.js";
import { dispatchSearch } from "../services/unifiedSearch/dispatcher.js";
import {
  parseCardQuery,
  buildCompSearchQuery,
  type ParsedCardQuery,
} from "../services/compiq/cardQueryParser.js";
import { fetchCompsByPlayer } from "../services/compiq/compsByPlayer.service.js";
import { buildEngineMeta } from "../services/compiq/engineMeta.js";
import {
  classifyRegime,
  type RegimeResult,
} from "../services/compiq/regimeClassifier.js";
import {
  computePredictedRange,
  type PredictedRangeResult,
} from "../services/compiq/predictedRange.js";
import {
  writeTelemetryEntries,
  extractTelemetryCohortFromResult,
} from "../services/corpus/writeTelemetryEntries.js";
// PREDICTION-ROBUSTNESS-RECON #1 (2026-06-02): graceful CardsightTimeoutError
// handling. Each prediction-path route catches the timeout and emits a
// shape-stable 200 response per buildUpstreamTimeout*Response so iOS clients
// render uniformly. See upstreamTimeout.helpers.ts header for the contract.
import {
  isCardsightTimeoutError,
  buildUpstreamTimeoutPriceResponse,
  buildUpstreamTimeoutPriceByIdResponse,
  buildUpstreamTimeoutCardSearchResponse,
  buildUpstreamTimeoutBulkItemData,
} from "../services/compiq/upstreamTimeout.helpers.js";
// CF-PAYMENTS-B1 (2026-06-02): per-route session gate + rate limit on the
// FMV-bearing user-initiated endpoints. Two cap classes:
//   - requireRateLimited("priceChecksPerDay") on: /price, /estimate,
//     /price-by-id, /search (alias of /price; closes the bypass loophole
//     where a free user could route around /price by calling /search),
//     and /what-if (hypothetical FMV is also a user-initiated check).
//   - requireEntitlement("predictions") on: /bulk (power-user batch up
//     to 20 queries; per-item caps would be restrictive and per-call
//     would defeat the cap purpose — bulk is a paid power feature),
//     /sell-window (seasonal sell recommendation), /grade-premium (PSA-10
//     vs raw value delta + worth-grading verdict).
// /cardsearch + /comps-by-player + /parse + /normalization-dictionary +
// /health remain anonymous. /comps-by-player is a future paid-gate
// candidate (collector+ via "predictions") — deferred pending iOS usage
// signal.
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import { requireRateLimited } from "../middleware/requireRateLimited.js";

// CF-LAUNCH-HARDENING (2026-06-02): centralized thin-data + approximate
// helpers used by /search, /price, /price-by-id, /bulk happy-path response
// builders. Two distinct iOS signals:
//   - isThinFromEst: FMV is null OR genuinely unavailable; iOS hides
//     pricing tiers + shows the "no recent comps / not in catalog / out
//     of scope" empty state.
//   - approximateFromEst: FMV is a number, but the number is uncertain
//     (sibling-pool rescue, variant-mismatch, low-confidence-live);
//     iOS shows the number with an "approximate" badge so users don't
//     over-trust thin estimates.
const THIN_SOURCES: ReadonlySet<string> = new Set([
  "no-recent-comps",
  "out-of-scope",
  "catalog-miss",
  "upstream-timeout",
  // unsupported_sport already short-circuits BEFORE the happy-path branch
  // runs; left out here so the legacy `source === "unsupported_sport"`
  // check at the branch entry stays the only gate for that path.
]);
const APPROXIMATE_SOURCES: ReadonlySet<string> = new Set([
  "sibling-pool",
  "variant-mismatch",
]);
const LOW_CONFIDENCE_THRESHOLD = 0.5;

function isThinFromEst(est: Record<string, unknown>): boolean {
  const source = typeof est.source === "string" ? est.source : null;
  return source !== null && THIN_SOURCES.has(source);
}

function approximateFromEst(est: Record<string, unknown>): boolean {
  const source = typeof est.source === "string" ? est.source : null;
  if (source !== null && APPROXIMATE_SOURCES.has(source)) return true;
  // Low-confidence live: FMV is from the main pipeline but the pricing
  // confidence signal flags thin data.
  if (source === "live" || source === undefined) {
    const conf = (est.confidence as { pricingConfidence?: number } | null)
      ?.pricingConfidence;
    if (typeof conf === "number" && conf < LOW_CONFIDENCE_THRESHOLD * 100) {
      return true;
    }
  }
  return false;
}

// Issue #25 Phase 1 â€” read-only regime fields. Prefers the estimate's
// embedded `regimeClassification` (computed inside computeEstimate against
// the FULL 90-day comp pool). Falls back to classifying whatever
// `recentComps` happens to be on the response (truncated/empty paths) and
// finally to insufficient_data so every route emits the field uniformly.
//
// Phase 1 deploy follow-up: when `est.source` is a non-live fallback
// (including legacy values plus no-recent-comps/unsupported_sport/variant-mismatch)
// the comp pool the classifier sees does NOT characterize the queried card's
// own market. Force regime â†’ insufficient_data / low in that case so the
// emitted field stays honest. The classifier itself is unchanged.
const NON_LIVE_SOURCES_FOR_REGIME: ReadonlySet<string> = new Set([
  "neighbor-synthesis",
  "no-recent-comps",
  "unsupported_sport",
  "variant-mismatch",
  // CF-LAUNCH-HARDENING (2026-06-02): new short-circuit sources from
  // computeEstimate. Treat them the same as the existing non-live sources
  // for regime classification — the embedded recentComps pool doesn't
  // characterize the queried card.
  "out-of-scope",
  "catalog-miss",
  "upstream-timeout",
]);

function regimeFieldsFromEstimate(est: Record<string, unknown>): {
  regime: RegimeResult["regime"];
  regimeConfidence: RegimeResult["confidence"];
  regimeDiagnostics: RegimeResult["diagnostics"];
} {
  const embedded = est.regimeClassification as RegimeResult | undefined;
  const result: RegimeResult =
    embedded ??
    classifyRegime(
      ((est.recentComps as Array<{ price: number; soldDate?: string | null; date?: string | null }>) ??
        []) as ReadonlyArray<{
        price: number;
        soldDate?: string | null;
        date?: string | null;
      }>,
    );

  const source = typeof est.source === "string" ? est.source : null;
  if (source && NON_LIVE_SOURCES_FOR_REGIME.has(source)) {
    return {
      regime: "insufficient_data",
      regimeConfidence: "low",
      regimeDiagnostics: {
        ...result.diagnostics,
        classificationReason: `skipped_classification: source=${source} (classifier output discarded: ${result.diagnostics.classificationReason})`,
      },
    };
  }

  return {
    regime: result.regime,
    regimeConfidence: result.confidence,
    regimeDiagnostics: result.diagnostics,
  };
}

// Issue #25 Phase 2 â€” read-only predicted range fields. Prefers the
// estimate's embedded `predictedRangeResult` (computed inside computeEstimate
// against the FULL comp pool with grade filter). Falls back to null+sentinel
// math on non-live source or absent embedded result so every route emits the
// field uniformly.
const NON_LIVE_SOURCES_FOR_PREDICTED_RANGE: ReadonlySet<string> = new Set([
  "neighbor-synthesis",
  "no-recent-comps",
  "unsupported_sport",
  "variant-mismatch",
]);

function predictedRangeFieldsFromEstimate(est: Record<string, unknown>): {
  predictedRange: PredictedRangeResult["predictedRange"];
  predictedRangeDiagnostics: PredictedRangeResult["diagnostics"];
  predictedRangeAdjustedConfidence: PredictedRangeResult["adjustedConfidence"];
  regimeConfidence?: RegimeResult["confidence"];
} {
  const source = typeof est.source === "string" ? est.source : null;
  if (source && NON_LIVE_SOURCES_FOR_PREDICTED_RANGE.has(source)) {
    return {
      predictedRange: { low: null, high: null },
      predictedRangeDiagnostics: {
        windowAppliedDays: null,
        compsAfterFilter: 0,
        mathApplied: "null_non_live_source",
        sanityCapsApplied: [],
        weightedPercentileBuckets: null,
      },
      predictedRangeAdjustedConfidence: null,
    };
  }

  const embedded = est.predictedRangeResult as PredictedRangeResult | undefined;
  if (embedded) {
    const out: {
      predictedRange: PredictedRangeResult["predictedRange"];
      predictedRangeDiagnostics: PredictedRangeResult["diagnostics"];
      predictedRangeAdjustedConfidence: PredictedRangeResult["adjustedConfidence"];
      regimeConfidence?: RegimeResult["confidence"];
    } = {
      predictedRange: embedded.predictedRange,
      predictedRangeDiagnostics: embedded.diagnostics,
      predictedRangeAdjustedConfidence: embedded.adjustedConfidence,
    };
    if (
      embedded.adjustedConfidence !== null &&
      embedded.diagnostics.sanityCapsApplied.length > 0
    ) {
      out.regimeConfidence = embedded.adjustedConfidence;
    }
    return out;
  }

  return {
    predictedRange: { low: null, high: null },
    predictedRangeDiagnostics: {
      windowAppliedDays: null,
      compsAfterFilter: 0,
      mathApplied: "null_insufficient_data",
      sanityCapsApplied: [],
      weightedPercentileBuckets: null,
    },
    predictedRangeAdjustedConfidence: null,
  };
}

// Build a structured CompIQEstimateRequest from a parsed free-text query.
// The parser fills in every field the estimate service needs (year, brand,
// parallel, isAuto, grade), so downstream filters can fire â€” instead of the
// whole query string being shoved into playerName.
function requestFromParsed(parsed: ParsedCardQuery): CompIQEstimateRequest {
  return {
    playerName: parsed.playerName ?? parsed.rawQuery,
    cardYear: parsed.year ?? undefined,
    product: parsed.set ?? parsed.brand ?? undefined,
    parallel: parsed.parallel ?? undefined,
    // Phase 2 v2 defect #11 — propagate parsed cardNumber so downstream
    // computeEstimate + queryContext + resolveCardId can use it for
    // disambiguation and proper cache-key construction.
    cardNumber: parsed.cardNumber ?? undefined,
    isAuto: parsed.isAuto || undefined,
    gradeCompany: parsed.gradingCompany ?? undefined,
    gradeValue: parsed.grade && parsed.grade !== "raw" ? Number(parsed.grade) : undefined,
  };
}

const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes

function normalizeCacheKey(prefix: string, query: string): string {
  return `${prefix}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

const router = Router();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "CompIQ",
    timestamp: new Date().toISOString()
  });
});

router.post(
  "/estimate",
  requireSession,
  requireRateLimited("priceChecksPerDay"),
  (req, res, next) => compiqEstimate(req, res).catch(next),
);

router.get("/normalization-dictionary", (req, res) => {
  res.json({ success: true, dictionary: getNormalizationDictionary() });
});

// GET /api/compiq/parse?q=2024+bowman+blue+auto+Caleb+Bonemer
// Debug/preview endpoint â€” returns ParsedCardQuery and the comp search
// string the engine would issue. No comps fetched, no pricing run.
router.get("/parse", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q.trim()) {
    return res.status(400).json({ success: false, error: 'Missing "q" query param' });
  }
  const parsed = parseCardQuery(q);
  const searchQuery = buildCompSearchQuery(parsed);
  const summaryParts = [
    parsed.year ?? "",
    parsed.brand ?? "",
    parsed.set && parsed.set !== parsed.brand ? parsed.set : "",
    parsed.parallel ?? "",
    parsed.isAuto ? "Auto" : "",
    parsed.playerName ?? "",
  ].filter(Boolean);
  res.json({
    success: true,
    parsed,
    searchQuery,
    explanation: `Searching for: ${summaryParts.join(" ")}`.replace(/\s+/g, " ").trim(),
  });
});

router.post("/what-if", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "playerName" field' });
    }
    const result = await simulateWhatIf(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// MCP rewire Phase 1 — backend grows player+product comp aggregation so
// mcp-server's compsLoader can drop the fn-cardhedge-comps blob dependency.
// Design: docs/phase0/mcp_rewire_design.md (61e2d5c) — see addendum.
// product is REQUIRED per Q1 finding (Cardsight catalog text-relevance buries
// Topps Update Base Sets under player-only queries; product narrowing fixes
// it). 400 when product missing.
//
// Query params: playerName (req), product (req), cardYear, parallel,
// gradeCompany, gradeValue.
router.get("/comps-by-player", async (req, res, next) => {
  try {
    const playerName = typeof req.query.playerName === "string" ? req.query.playerName.trim() : "";
    const product = typeof req.query.product === "string" ? req.query.product.trim() : "";
    if (!playerName) {
      return res.status(400).json({ error: "playerName query parameter is required" });
    }
    if (!product) {
      return res.status(400).json({ error: "product query parameter is required" });
    }

    const cardYearRaw = typeof req.query.cardYear === "string" ? req.query.cardYear.trim() : "";
    let cardYear: number | undefined;
    if (cardYearRaw) {
      const parsed = Number(cardYearRaw);
      if (!Number.isFinite(parsed) || parsed < 1900 || parsed > 2100) {
        return res.status(400).json({ error: "cardYear must be a 4-digit year between 1900 and 2100" });
      }
      cardYear = parsed;
    }

    const parallel = typeof req.query.parallel === "string" && req.query.parallel.trim()
      ? req.query.parallel.trim()
      : undefined;
    const gradeCompany = typeof req.query.gradeCompany === "string" && req.query.gradeCompany.trim()
      ? req.query.gradeCompany.trim()
      : undefined;
    const gradeValue = typeof req.query.gradeValue === "string" && req.query.gradeValue.trim()
      ? req.query.gradeValue.trim()
      : undefined;

    const result = await fetchCompsByPlayer({
      playerName,
      product,
      cardYear,
      parallel,
      gradeCompany,
      gradeValue,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/cardsearch
//
// Per CF-UNIFIED-SEARCH-AND-CERT W5-Windows (2026-05-29): migrated
// from CardHedge to the unified-search dispatcher (Cardsight + cert-
// grader registry). Returns `UnifiedSearchResponse` per the W3
// design (23038d7 §4) — same shape as /api/search/cards.
//
// **Picker breakage during W5-iOS gap window is an accepted trade-off**
// per the Phase 1 coordination resolution: the iOS picker as currently
// deployed expects the legacy `{ ok: true, hits: [...] }` shape; the
// W5-iOS rebuild migrates it to the new shape. Drew's operational
// picker use during the gap routes through /api/search/cards directly.
//
// CardHedge is dead; the next CF (CF-CARDHEDGE-DECOMMISSION-FULL,
// HIGH backlog) handles the remaining /price-by-id migration +
// cardhedge.client.ts deletion + Azure Function disable + env-var
// cleanup. W5-Windows handles the user-facing endpoint migration;
// the decommission CF handles the rest.
router.post("/cardsearch", async (req, res, next) => {
  try {
    const { query, hint } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing or invalid "query" field' });
    }
    let hintParam: "cert" | "freetext" | undefined;
    if (hint === "cert" || hint === "freetext") {
      hintParam = hint;
    } else if (hint !== undefined) {
      return res
        .status(400)
        .json({ success: false, error: '`hint` must be either "cert" or "freetext" when provided' });
    }
    const response = await dispatchSearch(query, hintParam);
    res.json(response);
  } catch (err) {
    // PREDICTION-ROBUSTNESS-RECON #1: Cardsight upstream timeout -> graceful
    // 200 with empty candidates + structured warning, NOT 500.
    if (isCardsightTimeoutError(err)) {
      const { query: rawQuery, hint } = req.body || {};
      const detectedMode: "cert" | "freetext" =
        hint === "cert" ? "cert" : "freetext";
      return res
        .status(200)
        .json(
          buildUpstreamTimeoutCardSearchResponse(
            typeof rawQuery === "string" ? rawQuery : "",
            detectedMode,
          ),
        );
    }
    next(err);
  }
});

// POST /api/compiq/search
// Accepts { query: string } â€” used by DashboardView free-text search
// CF-PAYMENTS-B1 tweak: /search is the original endpoint; /price was an
// alias added later. The alias bypass would let a free user route around
// the /price cap by calling /search with the same body. Same gate stack.
router.post("/search", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const cacheKey = normalizeCacheKey("compiq:search", query);
    const result = await cacheWrap(cacheKey, async () => {
      // Parse free-text â†’ structured fields so downstream filters fire.
      const parsed = parseCardQuery(query);
      const body: CompIQEstimateRequest = requestFromParsed(parsed);
      const searchQuery = buildCompSearchQuery(parsed);
      console.log(
        `[compiq.search] parsed query="${query}" â†’ player="${parsed.playerName}" year=${parsed.year} brand=${parsed.brand} parallel=${parsed.parallel} isAuto=${parsed.isAuto} confidence=${parsed.confidence} searchQuery="${searchQuery}"`
      );
      // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): /api/compiq/search
      // is the free-text DashboardView search. Public route, no auth context.
      const est = await computeEstimate(body, {
        source: "compiq-search-freetext",
        userId: null,
        holdingId: null,
        routedFromHolding: false,
      });

      // Unsupported-sport short-circuit (issue #7). computeEstimate returns
      // source="unsupported_sport" when CH's AI identified the query as a
      // non-baseball card. Emit a fully-shaped response with all standard
      // pricing fields nulled out and the new unsupportedSportReason /
      // detectedSport fields populated so iOS clients can present a clean
      // message instead of receiving a silently mis-priced result.
      if (est.source === "unsupported_sport") {
        return {
          ...buildEngineMeta(),
          success: true,
          query: query.trim(),
          summary: (est.verdict as string) ?? "Unsupported sport.",
          marketTier: { value: null, high: null },
          buyZone: [null, null],
          holdZone: [null, null],
          sellZone: [null, null],
          fairMarketValueLive: null,
          marketValue: null,
          predictedPrice: null,
          predictedPriceRange: null,
          predictedPriceAttribution: null,
          trendIQ: null,
          signalsLastUpdated: null,
          confidence: 0,
          source: "unsupported_sport",
          unsupportedSportReason: (est.unsupportedSportReason as string) ?? null,
          detectedSport: (est.detectedSport as string) ?? null,
          trendAnalysis: {
            market_direction: "flat",
            change_from_older_to_recent: null,
            liquidity: "Normal",
          },
          ...regimeFieldsFromEstimate(est as Record<string, unknown>),
          ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
          supply: null,
          recentComps: [],
          cardIdentity: (est.cardIdentity as any) ?? null,
          gradeUsed: (est.gradeUsed as any) ?? null,
          compsUsed: 0,
          compsAvailable: 0,
          daysSinceNewestComp: null,
          variantWarning: [],
          neighborSynthesis: null,
          crossParallelAnchor: null,
          buySignal: null,
          parsedQuery: {
            playerName: parsed.playerName,
            year: parsed.year,
            brand: parsed.brand,
            set: parsed.set,
            parallel: parsed.parallel,
            isAuto: parsed.isAuto,
            isPatch: parsed.isPatch,
            isRookie: parsed.isRookie,
            printRun: parsed.printRun,
            cardNumber: parsed.cardNumber,
            grade: parsed.grade,
            gradingCompany: parsed.gradingCompany,
            confidence: parsed.confidence,
          },
          searchQuery,
        };
      }

      const fmv = (est.fairMarketValue as number) ?? 0;
      const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
      const premium = (est.premiumValue as number) ?? fmv * 1.15;
      const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
      const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
      const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
      const trendDeltaPct = Number(((est as any)?.pricingAnalytics?.anchorModel?.impliedTrendPct ?? 0));
      const source = (est.source as string | undefined) ?? "live";
      // CF-LAUNCH-HARDENING: extended thin-source taxonomy + approximate.
      const isThin = isThinFromEst(est);
      const approximate = approximateFromEst(est);
      const variantWarning: string[] = (est as any).variantWarning ?? [];
      const hasWarn = variantWarning.length > 0;
      const baseSummary = est.verdict ?? "Estimate based on available market data.";
      const summary = hasWarn
        ? `No exact match for requested variant (missing: ${variantWarning.join(", ")}). Showing closest available comp. ${baseSummary}`
        : baseSummary;
      const finalConfidence = hasWarn ? Math.min(confidence, 0.45) : confidence;

      // Prefer momentum-adjusted FMV when available so the headline price
      // reflects fresh sibling-parallel trend rather than a stale live
      // anchor. `fairMarketValue` (live) is still returned separately.
      const effectiveFmv =
        typeof (est as any).effectiveFmv === "number" && (est as any).effectiveFmv > 0
          ? ((est as any).effectiveFmv as number)
          : fmv;
      const liftRatio = fmv > 0 ? effectiveFmv / fmv : 1;
      const effQuick = quick * liftRatio;
      const effPremium = premium * liftRatio;

      // If we have NO direct comps but DO have a sibling-parallel synthetic
      // anchor, surface that as the headline instead of null. Quick/premium
      // bands derived from the synthetic FMV. Applies both to thin-market
      // (no-recent-comps) and variant-mismatch sources.
      const xpa = (est as any).crossParallelAnchor as any;
      const isVariantMismatch = source === "variant-mismatch";
      const noUsableLiveFmv = isThin || isVariantMismatch || !(fmv > 0);
      const hasSyntheticFallback =
        noUsableLiveFmv && typeof xpa?.fmv === "number" && xpa.fmv > 0;
      const syntheticFmv: number = hasSyntheticFallback
        ? (typeof (est as any).effectiveFmv === "number" && (est as any).effectiveFmv > 0
            ? ((est as any).effectiveFmv as number)
            : (xpa.fmv as number))
        : 0;
      const syntheticQuick = syntheticFmv * 0.88;
      const syntheticPremium = syntheticFmv * 1.15;

      return {
        ...buildEngineMeta(),
        success: true,
        query: query.trim(),
        summary,
        marketTier: hasSyntheticFallback
          ? { value: syntheticFmv, high: syntheticPremium }
          : noUsableLiveFmv
            ? { value: null, high: null }
            : { value: effectiveFmv, high: effPremium },
        buyZone: hasSyntheticFallback
          ? [syntheticQuick * 0.9, syntheticQuick]
          : noUsableLiveFmv
            ? [null, null]
            : [effQuick * 0.9, effQuick],
        holdZone: hasSyntheticFallback
          ? [syntheticQuick, syntheticFmv]
          : noUsableLiveFmv
            ? [null, null]
            : [effQuick, effectiveFmv],
        sellZone: hasSyntheticFallback
          ? [syntheticFmv, syntheticPremium]
          : noUsableLiveFmv
            ? [null, null]
            : [effectiveFmv, effPremium],
        fairMarketValueLive: noUsableLiveFmv ? null : fmv,
        marketValue: noUsableLiveFmv ? null : fmv,
        // CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — propagate the new
        // prediction-layer fields so /search response stays in shape parity
        // with /estimate. Same identity + same comp pool ⇒ same predictedPrice.
        predictedPrice: (est as any).predictedPrice ?? null,
        predictedPriceRange: (est as any).predictedPriceRange ?? null,
        predictedPriceAttribution: (est as any).predictedPriceAttribution ?? null,
        trendIQ: (est as any).trendIQ ?? null,
        signalsLastUpdated: (est as any).signalsLastUpdated ?? null,
        confidence: finalConfidence,
        // CF-LAUNCH-HARDENING (2026-06-02): top-level taxonomy fields iOS
        // uses to render uniformly:
        //   - approximate: true when FMV is a number but uncertain
        //     (sibling-pool / variant-mismatch / low-confidence-live).
        //   - outOfScopeReason: surfaces "pre-modern" or
        //     "unsupported-sport" when the card is intentionally outside
        //     CompIQ's launch scope (distinct from "we couldn't find data").
        approximate,
        outOfScopeReason: (est as any).outOfScopeReason ?? null,
        source,
        trendAnalysis: {
          market_direction: direction,
          change_from_older_to_recent: Number.isFinite(trendDeltaPct) ? trendDeltaPct : null,
          liquidity: (est.marketDNA as any)?.speed ?? "Normal",
        },
        ...regimeFieldsFromEstimate(est as Record<string, unknown>),
        ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
        supply: null,
        recentComps: (est as any).recentComps ?? [],
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        variantWarning,
        neighborSynthesis: (est as any).neighborSynthesis ?? null,
        crossParallelAnchor: (est as any).crossParallelAnchor ?? null,
        buySignal: null,
        parsedQuery: {
          playerName: parsed.playerName,
          year: parsed.year,
          brand: parsed.brand,
          set: parsed.set,
          parallel: parsed.parallel,
          isAuto: parsed.isAuto,
          isPatch: parsed.isPatch,
          isRookie: parsed.isRookie,
          printRun: parsed.printRun,
          cardNumber: parsed.cardNumber,
          grade: parsed.grade,
          gradingCompany: parsed.gradingCompany,
          confidence: parsed.confidence,
        },
        searchQuery,
      };
    }, CACHE_TTL_SECONDS);
    res.json(result);
    // Telemetry â€” fire-and-forget. Drives BOTH compiq_corpus (ML
    // training table) and comp_logs (operational/cohort table) from a
    // single capture. Each writer self-gates on its own env vars
    // (COMPIQ_CORPUS_* and COMPIQ_COMP_LOGS_*).
    writeTelemetryEntries({
      query: query.trim(),
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: Date.now() - handlerStart,
      result,
      ...extractTelemetryCohortFromResult(result, query.trim()),
    });
  } catch (err) {
    // PREDICTION-ROBUSTNESS-RECON #1: Cardsight upstream timeout -> graceful
    // 200 with shape-stable null pricing payload, NOT 500.
    if (isCardsightTimeoutError(err)) {
      const { query: rawQuery } = req.body || {};
      const q = typeof rawQuery === "string" ? rawQuery : "";
      return res
        .status(200)
        .json({ ...buildEngineMeta(), ...buildUpstreamTimeoutPriceResponse(q) });
    }
    next(err);
  }
});

// POST /api/compiq/price  (alias for /search â€” same contract)
// CF-PAYMENTS-B1: standalone FMV user-initiated check.
router.post("/price", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const cacheKey = normalizeCacheKey("compiq:price", query);
    const result = await cacheWrap(cacheKey, async () => {
      const parsed = parseCardQuery(query);
      const body: CompIQEstimateRequest = requestFromParsed(parsed);
      const searchQuery = buildCompSearchQuery(parsed);
      console.log(
        `[compiq.price] parsed query="${query}" â†’ player="${parsed.playerName}" year=${parsed.year} brand=${parsed.brand} parallel=${parsed.parallel} isAuto=${parsed.isAuto} confidence=${parsed.confidence}`
      );
      // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): /api/compiq/price
      // is the free-text alias of /search.
      const est = await computeEstimate(body, {
        source: "compiq-price-freetext",
        userId: null,
        holdingId: null,
        routedFromHolding: false,
      });

      // Unsupported-sport short-circuit â€” mirrors /search response shape so
      // iOS clients receive identical behavior across the two endpoints.
      if (est.source === "unsupported_sport") {
        return {
          ...buildEngineMeta(),
          success: true,
          query: query.trim(),
          summary: (est.verdict as string) ?? "Unsupported sport.",
          marketTier: { value: null, high: null },
          buyZone: [null, null],
          holdZone: [null, null],
          sellZone: [null, null],
          fairMarketValueLive: null,
          marketValue: null,
          predictedPrice: null,
          predictedPriceRange: null,
          predictedPriceAttribution: null,
          // TrendIQ — null on unsupported-sport short-circuit. Field
          // present for response-shape stability across all /price branches.
          trendIQ: null,
          signalsLastUpdated: null,
          confidence: 0,
          source: "unsupported_sport",
          unsupportedSportReason: (est.unsupportedSportReason as string) ?? null,
          detectedSport: (est.detectedSport as string) ?? null,
          trendAnalysis: {
            market_direction: "flat",
            change_from_older_to_recent: null,
          },
          ...regimeFieldsFromEstimate(est as Record<string, unknown>),
          ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
          supply: null,
          recentComps: [],
          cardIdentity: (est.cardIdentity as any) ?? null,
          gradeUsed: (est.gradeUsed as any) ?? null,
          compsUsed: 0,
          compsAvailable: 0,
          daysSinceNewestComp: null,
          variantWarning: [],
          neighborSynthesis: null,
          crossParallelAnchor: null,
          buySignal: null,
          parsedQuery: {
            playerName: parsed.playerName,
            year: parsed.year,
            brand: parsed.brand,
            set: parsed.set,
            parallel: parsed.parallel,
            isAuto: parsed.isAuto,
            isPatch: parsed.isPatch,
            isRookie: parsed.isRookie,
            printRun: parsed.printRun,
            cardNumber: parsed.cardNumber,
            grade: parsed.grade,
            gradingCompany: parsed.gradingCompany,
            confidence: parsed.confidence,
          },
          searchQuery,
        };
      }

      const fmv = (est.fairMarketValue as number) ?? 0;
      const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
      const premium = (est.premiumValue as number) ?? fmv * 1.15;
      const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
      const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
      const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
      const trendDeltaPct = Number(((est as any)?.pricingAnalytics?.anchorModel?.impliedTrendPct ?? 0));
      const source = (est.source as string | undefined) ?? "live";
      // CF-LAUNCH-HARDENING: extended thin-source taxonomy + approximate.
      const isThin = isThinFromEst(est);
      const approximate = approximateFromEst(est);
      const variantWarning: string[] = (est as any).variantWarning ?? [];
      const hasWarn = variantWarning.length > 0;
      const baseSummary = est.verdict ?? "Estimate based on available market data.";
      const summary = hasWarn
        ? `No exact match for requested variant (missing: ${variantWarning.join(", ")}). Showing closest available comp. ${baseSummary}`
        : baseSummary;
      const finalConfidence = hasWarn ? Math.min(confidence, 0.45) : confidence;
      return {
        ...buildEngineMeta(),
        success: true,
        query: query.trim(),
        summary,
        marketTier: isThin
          ? { value: null, high: null }
          : { value: fmv, high: premium },
        buyZone: isThin ? [null, null] : [quick * 0.9, quick],
        holdZone: isThin ? [null, null] : [quick, fmv],
        sellZone: isThin ? [null, null] : [fmv, premium],
        // Live FMV emitted at top level for engine-emission symmetry with
        // /search (Option X). Mirrors marketTier.value's null-when-thin
        // semantic so both fields agree within a response.
        fairMarketValueLive: isThin ? null : fmv,
        marketValue: isThin ? null : fmv,
        // CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — propagate prediction-
        // layer fields for /search-equivalent shape parity.
        predictedPrice: (est as any).predictedPrice ?? null,
        predictedPriceRange: (est as any).predictedPriceRange ?? null,
        predictedPriceAttribution: (est as any).predictedPriceAttribution ?? null,
        // TrendIQ Phase 1 — forward-looking composite score (Layer 1 only
        // in B.4.a; L2/L3 follow). Always present in the happy path; null
        // on the short-circuit branches above.
        trendIQ: (est as any).trendIQ ?? null,
        signalsLastUpdated: (est as any).signalsLastUpdated ?? null,
        confidence: finalConfidence,
        // CF-LAUNCH-HARDENING (2026-06-02): top-level taxonomy fields iOS
        // uses to render uniformly:
        //   - approximate: true when FMV is a number but uncertain
        //     (sibling-pool / variant-mismatch / low-confidence-live).
        //   - outOfScopeReason: surfaces "pre-modern" or
        //     "unsupported-sport" when the card is intentionally outside
        //     CompIQ's launch scope (distinct from "we couldn't find data").
        approximate,
        outOfScopeReason: (est as any).outOfScopeReason ?? null,
        source,
        trendAnalysis: {
          market_direction: direction,
          change_from_older_to_recent: Number.isFinite(trendDeltaPct) ? trendDeltaPct : null,
        },
        ...regimeFieldsFromEstimate(est as Record<string, unknown>),
        ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
        supply: null,
        recentComps: (est as any).recentComps ?? [],
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        variantWarning,
        neighborSynthesis: (est as any).neighborSynthesis ?? null,
        crossParallelAnchor: (est as any).crossParallelAnchor ?? null,
        buySignal: null,
        parsedQuery: {
          playerName: parsed.playerName,
          year: parsed.year,
          brand: parsed.brand,
          set: parsed.set,
          parallel: parsed.parallel,
          isAuto: parsed.isAuto,
          isPatch: parsed.isPatch,
          isRookie: parsed.isRookie,
          printRun: parsed.printRun,
          cardNumber: parsed.cardNumber,
          grade: parsed.grade,
          gradingCompany: parsed.gradingCompany,
          confidence: parsed.confidence,
        },
        searchQuery,
      };
    }, CACHE_TTL_SECONDS);
    res.json(result);
    // Telemetry â€” see /search for rationale.
    writeTelemetryEntries({
      query: query.trim(),
      querySource: "free_text",
      endpoint: "/api/compiq/price",
      durationMs: Date.now() - handlerStart,
      result,
      ...extractTelemetryCohortFromResult(result, query.trim()),
    });
  } catch (err) {
    // PREDICTION-ROBUSTNESS-RECON #1: Cardsight upstream timeout -> graceful
    // 200 with shape-stable null pricing payload, NOT 500.
    if (isCardsightTimeoutError(err)) {
      const { query: rawQuery } = req.body || {};
      const q = typeof rawQuery === "string" ? rawQuery : "";
      return res
        .status(200)
        .json({ ...buildEngineMeta(), ...buildUpstreamTimeoutPriceResponse(q) });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Two-step pricing flow (W5-Windows state):
//
// 1. POST /api/compiq/cardsearch    — Cardsight-backed search via unified
//                                     dispatcher; returns UnifiedSearchResponse
//                                     (W3 shape). Migrated from CardHedge
//                                     2026-05-29 (CF-UNIFIED-SEARCH-AND-CERT
//                                     W5-Windows).
// 2. POST /api/compiq/price-by-id   — pins a CompIQ estimate to a specific
//                                     Cardsight cardId (UUID).
//                                     fetchComps's pinned-id branch calls
//                                     cardsight.client.getPricing() directly.
//                                     Request body wire key: cardsightCardId.
//
// `/api/compiq/search-list` was the legacy CardHedge-shape picker endpoint.
// **Deleted** in this commit per Phase 1 caller grep (no runtime consumers
// outside the route itself; only doc references remained). iOS picker as
// currently deployed uses /api/compiq/cardsearch; W5-iOS rebuilds it
// against UnifiedSearchResponse.
// ---------------------------------------------------------------------------

// CF-PAYMENTS-B1: standalone FMV user-initiated check.
router.post("/price-by-id", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { cardsightCardId, query, gradeCompany, gradeValue } = req.body || {};

    const resolvedCardId =
      typeof cardsightCardId === "string" && cardsightCardId.length > 0
        ? cardsightCardId
        : null;
    if (!resolvedCardId) {
      return res.status(400).json({ success: false, error: 'Missing "cardsightCardId" field' });
    }
    const cacheKey = normalizeCacheKey(
      "compiq:price-by-id:v4",
      `${resolvedCardId}|${gradeCompany ?? ""}${gradeValue ?? ""}`
    );
    // CF-ROUTE-CACHE-VALIDATION (2026-06-08): producer extracted to a
    // named arrow so the read-time validator can call it DIRECTLY
    // (bypassing cacheWrap) after busting a poisoned entry. Running
    // through cacheWrap on the bust-and-recompute path would either
    // hit the still-bad upstream cache or, worse, re-cache a poisoned
    // result. The direct-call path produces a guaranteed-fresh response
    // and the validator decides whether to re-cache it.
    const producePriceByIdResponse = async () => {
      const body: CompIQEstimateRequest = {
        playerName: typeof query === "string" ? query.trim() : resolvedCardId,
        cardsightCardId: resolvedCardId,
        gradeCompany: typeof gradeCompany === "string" ? gradeCompany : undefined,
        gradeValue: typeof gradeValue === "number" ? gradeValue : undefined,
      };
      // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): /api/compiq/price-by-id
      // pins to a Cardsight UUID. Public route, no auth context.
      const est = await computeEstimate(body, {
        source: "compiq-price-by-id",
        userId: null,
        holdingId: null,
        routedFromHolding: false,
      });

      // Unsupported-sport short-circuit — defensive guard for /price-by-id.
      // UI normally only pins card_ids surfaced via the picker
      // (Baseball-locked at the search layer), so this branch should never
      // fire in practice. But if a non-baseball card_id ever leaks through,
      // we return the same shape as /search / /price rather than silently
      // mis-pricing.
      if (est.source === "unsupported_sport") {
        return {
          ...buildEngineMeta(),
          success: true,
          cardsightCardId: resolvedCardId,
          summary: (est.verdict as string) ?? "Unsupported sport.",
          marketTier: { value: null, high: null },
          buyZone: [null, null],
          holdZone: [null, null],
          sellZone: [null, null],
          fairMarketValueLive: null,
          marketValue: null,
          predictedPrice: null,
          predictedPriceRange: null,
          predictedPriceAttribution: null,
          // TrendIQ — null on unsupported-sport short-circuit. Field
          // present for response-shape stability across all branches.
          trendIQ: null,
          signalsLastUpdated: null,
          confidence: 0,
          source: "unsupported_sport",
          unsupportedSportReason: (est.unsupportedSportReason as string) ?? null,
          detectedSport: (est.detectedSport as string) ?? null,
          trendAnalysis: {
            market_direction: "flat",
            change_from_older_to_recent: null,
            liquidity: "Normal",
            broaderTrend: null,
          },
          ...regimeFieldsFromEstimate(est as Record<string, unknown>),
          ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
          recentComps: [],
          cardIdentity: (est.cardIdentity as any) ?? null,
          gradeUsed: (est.gradeUsed as any) ?? null,
          compsUsed: 0,
          compsAvailable: 0,
          daysSinceNewestComp: null,
          broaderTrend: null,
        };
      }

      const fmv = (est.fairMarketValue as number) ?? 0;
      const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
      const premium = (est.premiumValue as number) ?? fmv * 1.15;
      const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
      const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
      const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
      const trendDeltaPct = Number(((est as any)?.pricingAnalytics?.anchorModel?.impliedTrendPct ?? 0));
      const source = (est.source as string | undefined) ?? "live";
      // CF-LAUNCH-HARDENING: extended thin-source taxonomy + approximate.
      const isThin = isThinFromEst(est);
      const approximate = approximateFromEst(est);

      // CF-MARKET-READ (2026-06-08): generate the calm-style prose
      // summary of how the comp pool actually behaves. Reads from the
      // cs:pricing cached payload (cache-hit — computeEstimate above
      // already warmed it) so no extra Cardsight wire op. Best-effort:
      // a thrown fact-pack build does NOT fail the primary response;
      // marketRead falls to null. Output is cached at the marketRead
      // layer (24h TTL keyed on fact-pack hash) so repeat requests
      // with unchanged comp sets reuse the prose without burning LLM
      // tokens (once wired up).
      let marketReadResult: MarketReadResult | null = null;
      try {
        const pricingForMR = await getPricingForMarketRead(resolvedCardId);
        if (!pricingForMR.notFound) {
          const gradeKey =
            body.gradeCompany && body.gradeValue !== undefined
              ? `${body.gradeCompany} ${body.gradeValue}`
              : "Raw";
          marketReadResult = await generateMarketRead(
            pricingForMR,
            gradeKey,
            est as Record<string, unknown>,
            resolvedCardId,
          );
        }
      } catch (err) {
        console.warn(
          `[compiq.price-by-id] marketRead build failed (non-fatal): ${(err as Error)?.message ?? err}`,
        );
        marketReadResult = null;
      }

      return {
        ...buildEngineMeta(),
        success: true,
        cardsightCardId: resolvedCardId,
        summary: est.verdict ?? "Estimate based on available market data.",
        marketTier: isThin ? { value: null, high: null } : { value: fmv, high: premium },
        buyZone: isThin ? [null, null] : [quick * 0.9, quick],
        holdZone: isThin ? [null, null] : [quick, fmv],
        sellZone: isThin ? [null, null] : [fmv, premium],
        // Live FMV emitted at top level for engine-emission symmetry
        // with /search and /price (Option X). null when thin market.
        fairMarketValueLive: isThin ? null : fmv,
        marketValue: isThin ? null : fmv,
        // CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — propagate prediction-
        // layer fields. /price-by-id is the pinned-card analog of /price; the
        // estimate ⇒ response contract matches.
        predictedPrice: (est as any).predictedPrice ?? null,
        predictedPriceRange: (est as any).predictedPriceRange ?? null,
        predictedPriceAttribution: (est as any).predictedPriceAttribution ?? null,
        // TrendIQ Phase 1 — forward-looking composite score. Same shape
        // as /price; computeEstimate populates est.trendIQ in all happy-
        // path branches. Layer 3 currently null in production pending
        // CF-CARDSIGHT-SIBLING-DISCOVERY; composite is two-layer
        // (player + card) until then.
        trendIQ: (est as any).trendIQ ?? null,
        signalsLastUpdated: (est as any).signalsLastUpdated ?? null,
        confidence,
        // CF-LAUNCH-HARDENING (2026-06-02): see /search for field rationale.
        approximate: approximateFromEst(est as Record<string, unknown>),
        outOfScopeReason: (est as any).outOfScopeReason ?? null,
        source,
        trendAnalysis: {
          market_direction: direction,
          change_from_older_to_recent: Number.isFinite(trendDeltaPct) ? trendDeltaPct : null,
          liquidity: (est.marketDNA as any)?.speed ?? "Normal",
          broaderTrend: (est as any).broaderTrend ?? null,
        },
        ...regimeFieldsFromEstimate(est as Record<string, unknown>),
        ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
        recentComps: (est as any).recentComps ?? [],
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        broaderTrend: (est as any).broaderTrend ?? null,
        // CF-MARKET-READ (2026-06-08): prose + fact-pack pair. iOS
        // should render `marketRead` as a calm prose paragraph; the
        // fact pack is the same set of figures the prose references
        // (every number in the prose traces to one of these values).
        // null when the build fails or the card is genuinely thin.
        marketRead: marketReadResult?.marketRead ?? null,
        marketReadFactPack: marketReadResult?.factPack ?? null,
        marketReadSource: marketReadResult?.source ?? null,
        // CF-MARKET-READ-EXCLUDED-CALLOUT (2026-06-08): in-window comps
        // dropped by applyCompQualityFilter with per-comp reasons + plain-
        // language labels. iOS should render these below `recentComps`,
        // de-emphasized (greyed price + condition tag + "not counted" note)
        // so the prose's "don't value a clean card against them" callout is
        // visible in the comp list.
        excludedComps: marketReadResult?.excludedComps ?? [],
      };
    };

    // CF-ROUTE-CACHE-VALIDATION (2026-06-08): read-time consistency
    // validator. The route-level cacheWrap memoizes the FULL response
    // (cardIdentity, marketTier, recentComps, etc.) for 15 min. The
    // upstream consistency guard in fetchComps only fires when
    // computeEstimate actually runs — i.e. on cache MISS. A poisoned
    // entry written during a vendor flap (Cardsight returning a wrong
    // card under a fda530ab request) would replay for the full TTL on
    // every identical request, never re-validated.
    //
    // Fix: after cacheWrap returns, assert that the served response's
    // cardIdentity.card_id matches the requested cardsightCardId. On
    // mismatch: bust the poisoned entry, recompute ONCE via the direct
    // producer (bypassing cacheWrap so we get fresh Cardsight data), and
    // either cache + return the corrected result OR — if the fresh
    // recompute is STILL mismatched — return the unresolved shape and
    // refuse to re-cache. No loop; one bypass attempt per request.
    //
    // KNOWN LIMIT: this catches MISMATCH poison only (Frazier's
    // card_id under Trout's key). It does NOT catch "right-id,
    // wrong-data" (Cardsight returning wrong content under the
    // correct id) — that's a rarer corruption requiring a content
    // check, out of scope here.
    const buildUnresolvedRouteResponse = (): Record<string, unknown> => ({
      ...buildEngineMeta(),
      success: true,
      cardsightCardId: resolvedCardId,
      summary: "Couldn't price reliably right now — try again shortly.",
      marketTier: { value: null, high: null },
      buyZone: [null, null],
      holdZone: [null, null],
      sellZone: [null, null],
      fairMarketValueLive: null,
      marketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: null,
      trendIQ: null,
      signalsLastUpdated: null,
      confidence: 0,
      approximate: false,
      outOfScopeReason: null,
      source: "unresolved",
      trendAnalysis: {
        market_direction: "flat",
        change_from_older_to_recent: null,
        liquidity: "Normal",
        broaderTrend: null,
      },
      recentComps: [],
      cardIdentity: {
        card_id: resolvedCardId,
        title: null,
        player: null,
        set: null,
        year: null,
        number: null,
        variant: null,
      },
      gradeUsed: null,
      compsUsed: 0,
      compsAvailable: 0,
      daysSinceNewestComp: null,
      broaderTrend: null,
    });

    // `result` is widened to Record<string, unknown> so the
    // buildUnresolvedRouteResponse fallback path on the still-mismatched
    // branch reassigns cleanly without TS narrowing complaints.
    let result: Record<string, unknown> = await cacheWrap(
      cacheKey,
      producePriceByIdResponse,
      CACHE_TTL_SECONDS,
    ) as Record<string, unknown>;

    // Validator: pull card_id off cardIdentity. Treat absent identity as
    // unverifiable but not poisoned (the existing un-pinned fall-through
    // already legitimately returns null cardIdentity in some unresolved
    // branches; don't bust those).
    const servedIdentity = (result as any)?.cardIdentity as
      | { card_id?: string; player?: string | null; number?: string | null }
      | null
      | undefined;
    const servedCardId = servedIdentity?.card_id;
    const isMismatch = typeof servedCardId === "string"
      && servedCardId.length > 0
      && servedCardId !== resolvedCardId;

    if (isMismatch) {
      console.error(JSON.stringify({
        event: "route_cache_card_id_mismatch",
        source: "compiq.routes",
        subsystem: "cardsight",
        routeKey: cacheKey,
        requestedId: resolvedCardId,
        cachedCardId: servedCardId,
        cachedPlayer: servedIdentity?.player ?? null,
      }));
      await cacheDel(cacheKey);
      const recomputed = await producePriceByIdResponse();
      const recomputedIdentity = (recomputed as any)?.cardIdentity as
        | { card_id?: string }
        | null
        | undefined;
      const recomputedCardId = recomputedIdentity?.card_id;
      const stillMismatched = typeof recomputedCardId === "string"
        && recomputedCardId.length > 0
        && recomputedCardId !== resolvedCardId;
      if (stillMismatched) {
        // Vendor / upstream still returning a wrong-card response.
        // Do NOT re-cache. Return the unresolved shape so iOS renders
        // "couldn't price" rather than confidently-wrong wrong-card data.
        console.error(JSON.stringify({
          event: "route_cache_recompute_still_mismatched",
          source: "compiq.routes",
          subsystem: "cardsight",
          routeKey: cacheKey,
          requestedId: resolvedCardId,
          recomputedCardId,
        }));
        result = buildUnresolvedRouteResponse();
      } else {
        // Fresh recompute is clean. Cache it under the same key so the
        // next 15 min of identical requests get the correct response.
        result = recomputed;
        await cacheSet(
          cacheKey,
          JSON.stringify({ _v: recomputed, _ts: Date.now() }),
          CACHE_TTL_SECONDS,
        );
      }
    }
    res.json(result);
    // Corpus collector â€” fire-and-forget, gated by COMPIQ_CORPUS_DISABLED
    // and COMPIQ_CORPUS_SAMPLE_RATE. querySource rule: if the request
    // carried a non-empty free-text `query`, store that with
    // querySource="free_text"; otherwise store cardsightCardId in the
    // query slot with querySource="card_id" (self-describing semantics).
    {
      const trimmedQuery =
        typeof query === "string" ? query.trim() : "";
      const queryForCorpus = trimmedQuery.length > 0 ? trimmedQuery : resolvedCardId;
      const querySource: "free_text" | "card_id" =
        trimmedQuery.length > 0 ? "free_text" : "card_id";
      // /price-by-id is pinned to a Cardsight cardId post-CF-PRICE-BY-ID-
      // MIGRATION; override cardIdSource regardless of whether cardIdentity
      // made it into the response.
      writeTelemetryEntries({
        query: queryForCorpus,
        querySource,
        endpoint: "/api/compiq/price-by-id",
        durationMs: Date.now() - handlerStart,
        result,
        ...extractTelemetryCohortFromResult(result, queryForCorpus, "cardsight"),
        // Force cardId to the pinned id even if cardIdentity is absent.
        cardId: resolvedCardId,
      });
    }
  } catch (err) {
    // PREDICTION-ROBUSTNESS-RECON #1: Cardsight upstream timeout -> graceful
    // 200 with pinned cardsightCardId exposed.
    if (isCardsightTimeoutError(err)) {
      const { cardsightCardId } = req.body || {};
      const pinnedId = typeof cardsightCardId === "string" ? cardsightCardId : "";
      return res
        .status(200)
        .json({ ...buildEngineMeta(), ...buildUpstreamTimeoutPriceByIdResponse(pinnedId) });
    }
    next(err);
  }
});

// POST /api/compiq/bulk
// Accepts { queries: string[] } — per-item bulk pricing for free-text queries.
//
// No observed consumer in 7d App Insights window or in iOS Swift source as of
// 2026-05-27. (Prior comment attributed this to PortfolioIQViewModel.refreshPortfolio;
// iOS actually uses a TaskGroup over per-card /api/compiq/estimate calls and
// never reaches this endpoint.)
//
// Defect F1 fixed 2026-05-24 — set-bearing queries previously returned
// source=no-recent-comps because the handler passed the raw query as
// playerName, and the CH-identity guard at compiqEstimate.service.ts:1194-1219
// tokenized the full string, then wiped comps when tokens like "topps"/"update"
// weren't in the card.player + card.title haystack. Fix: parse the query
// into structured fields (parseCardQuery + requestFromParsed) before calling
// computeEstimate — same pattern /search (line 356-357) and /price (line
// 567-568) already use. Preventive ship: no current consumer (App Insights 7d
// + iOS Swift source confirm), but next time someone wires this endpoint
// up, the guard won't wipe set-bearing queries.
// CF-PAYMENTS-B1 tweak: /bulk is a power-user batch (up to 20 queries per
// call; iOS does not currently use it per the precursor comment above).
// Gating as "predictions" (collector+) rather than per-item rate-limit
// because per-item would restrict free users to bulks of size ≤ remaining
// daily quota and per-call would defeat the cap entirely.
router.post("/bulk", requireSession, requireEntitlement("predictions"), async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { queries } = req.body || {};
    if (!Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "queries" array' });
    }
    const safeQueries: string[] = queries.slice(0, 20).map(String);

    const settled = await Promise.allSettled(
      safeQueries.map(async (query) => {
        const parsed = parseCardQuery(query);
        const body: CompIQEstimateRequest = requestFromParsed(parsed);
        // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): /api/compiq/bulk
        // per-query — same source for every item in a single bulk request.
        // PREDICTION-ROBUSTNESS-RECON #1: a Cardsight timeout on ONE item
        // gets the graceful shape so the whole bulk doesn't half-fail.
        let est: Awaited<ReturnType<typeof computeEstimate>>;
        try {
          est = await computeEstimate(body, {
            source: "compiq-bulk-freetext",
            userId: null,
            holdingId: null,
            routedFromHolding: false,
          });
        } catch (err) {
          if (isCardsightTimeoutError(err)) {
            const data = {
              ...buildEngineMeta(),
              ...buildUpstreamTimeoutBulkItemData(query),
            };
            writeTelemetryEntries({
              query,
              querySource: "free_text",
              endpoint: "/api/compiq/bulk",
              durationMs: Date.now() - handlerStart,
              result: data,
              ...extractTelemetryCohortFromResult(data, query),
            });
            return {
              query,
              status: "ok" as const,
              data,
              error: null,
            };
          }
          throw err;
        }

        // Unsupported-sport short-circuit â€” per-item. Bulk responses can
        // include a mix of baseball + non-baseball queries; each item gets
        // its own well-formed response so the iOS client can render every
        // row consistently.
        if (est.source === "unsupported_sport") {
          const unsupportedData = {
            ...buildEngineMeta(),
            success: true,
            query,
            summary: (est.verdict as string) ?? "Unsupported sport.",
            marketTier: { value: null, high: null },
            fairMarketValueLive: null,
            marketValue: null,
            predictedPrice: null,
            predictedPriceRange: null,
            predictedPriceAttribution: null,
            // TrendIQ — null on unsupported-sport short-circuit (per-item
            // in bulk). Shape stability across all branches.
            trendIQ: null,
            signalsLastUpdated: null,
            confidence: 0,
            trendAnalysis: { market_direction: "flat" },
            source: "unsupported_sport",
            unsupportedSportReason: (est.unsupportedSportReason as string) ?? null,
            detectedSport: (est.detectedSport as string) ?? null,
            ...regimeFieldsFromEstimate(est as Record<string, unknown>),
            ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
            compsUsed: 0,
            compsAvailable: 0,
          };
          writeTelemetryEntries({
            query,
            querySource: "free_text",
            endpoint: "/api/compiq/bulk",
            durationMs: Date.now() - handlerStart,
            result: unsupportedData,
            ...extractTelemetryCohortFromResult(unsupportedData, query),
          });
          return {
            query,
            status: "ok" as const,
            data: unsupportedData,
            error: null,
          };
        }

        const fmv = (est.fairMarketValue as number) ?? 0;
        const premium = (est.premiumValue as number) ?? fmv * 1.15;
        const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
        const data = {
          ...buildEngineMeta(),
          success: true,
          query,
          summary: est.verdict,
          marketTier: { value: fmv, high: premium },
          // Engine-emission symmetry with /search, /price, /price-by-id
          // (Option X). null when the engine produced no usable FMV.
          fairMarketValueLive: fmv > 0 ? fmv : null,
          marketValue: fmv > 0 ? fmv : null,
          // CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — per-item prediction-
          // layer fields. Matches /search, /price, /price-by-id contract.
          predictedPrice: (est as any).predictedPrice ?? null,
          predictedPriceRange: (est as any).predictedPriceRange ?? null,
          predictedPriceAttribution: (est as any).predictedPriceAttribution ?? null,
          // TrendIQ Phase 1 — per-item composite score. Same shape as
          // /price and /price-by-id. Layer 3 currently null in
          // production pending CF-CARDSIGHT-SIBLING-DISCOVERY.
          trendIQ: (est as any).trendIQ ?? null,
          signalsLastUpdated: (est as any).signalsLastUpdated ?? null,
          confidence: Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100),
          // CF-LAUNCH-HARDENING (2026-06-02): see /search for field rationale.
          approximate: approximateFromEst(est as Record<string, unknown>),
          outOfScopeReason: (est as any).outOfScopeReason ?? null,
          trendAnalysis: {
            market_direction: trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat",
          },
          ...regimeFieldsFromEstimate(est as Record<string, unknown>),
          ...predictedRangeFieldsFromEstimate(est as Record<string, unknown>),
          source: est.source ?? "live",
          // Comp counts emitted per-item for symmetry with /search and
          // /price; corpus sampleSize maps from compsUsed.
          compsUsed: (est as any).compsUsed ?? 0,
          compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        };
        // Per-item telemetry â€” fire-and-forget. Each writer rolls its
        // sample-rate gate independently per call, so a 20-item bulk
        // request produces up to 20 independent sampling rolls per
        // stream.
        writeTelemetryEntries({
          query,
          querySource: "free_text",
          endpoint: "/api/compiq/bulk",
          durationMs: Date.now() - handlerStart,
          result: data,
          ...extractTelemetryCohortFromResult(data, query),
        });
        return {
          query,
          status: "ok" as const,
          data,
          error: null,
        };
      })
    );

    const results = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { query: safeQueries[i], status: "error" as const, data: null, error: (r.reason as Error)?.message ?? "Unknown error" }
    );

    const succeeded = results.filter((r) => r.status === "ok").length;
    res.json({ requested: safeQueries.length, succeeded, failed: safeQueries.length - succeeded, results });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/compiq/grade-premium
// Returns the estimated value premium for PSA 10 vs raw for a given card.
// Body: { playerName, cardYear?, product?, parallel?, isAuto? }
// ---------------------------------------------------------------------------
// CF-PAYMENTS-B1 tweak: /grade-premium returns PSA10-vs-raw FMV delta +
// "worth grading" verdict — prediction-class analytical surface.
router.post("/grade-premium", requireSession, requireEntitlement("predictions"), async (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "playerName" field' });
    }

    const base = req.body as CompIQEstimateRequest;

    // Run two estimates in parallel â€” raw and PSA 10
    // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): both halves of the
    // grade-premium calc emit under the same source so the corpus can
    // count grade-premium-driven rows as one cohort.
    const gradePremiumCtx = {
      source: "compiq-grade-premium" as const,
      userId: null,
      holdingId: null,
      routedFromHolding: false,
    };
    const [rawResult, psa10Result] = await Promise.all([
      computeEstimate({ ...base, gradeCompany: undefined, gradeValue: undefined }, gradePremiumCtx),
      computeEstimate({ ...base, gradeCompany: "PSA", gradeValue: 10 }, gradePremiumCtx),
    ]);

    const rawFmv = (rawResult.fairMarketValue as number) ?? 0;
    const psa10Fmv = (psa10Result.fairMarketValue as number) ?? 0;
    const premiumDollars = Math.max(0, psa10Fmv - rawFmv);
    const premiumPct = rawFmv > 0 ? (premiumDollars / rawFmv) * 100 : 0;

    // Grade worthwhile if premium covers typical grading cost ($25-50) with margin
    const gradingCostEstimate = 35;
    const worthGrading = premiumDollars > gradingCostEstimate * 2;

    res.json({
      success: true,
      playerName: base.playerName,
      rawFmv,
      psa10Fmv,
      premiumDollars,
      premiumPct: Math.round(premiumPct * 10) / 10,
      worthGrading,
      verdict: worthGrading
        ? `PSA 10 adds ~$${Math.round(premiumDollars)} over raw â€” likely worth grading.`
        : `PSA 10 only adds ~$${Math.round(premiumDollars)} over raw â€” grading may not pencil out.`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/compiq/sell-window
// Returns a seasonal sell-window recommendation for a card/player.
// Body: { playerName, cardYear?, isRookie?, sport? }
// ---------------------------------------------------------------------------
// CF-PAYMENTS-B1 tweak: /sell-window returns a seasonal sell recommendation
// — prediction-class.
router.post("/sell-window", requireSession, requireEntitlement("predictions"), async (req, res, next) => {
  try {
    const { playerName, isRookie, cardYear, sport } = req.body || {};
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "playerName" field' });
    }

    const now = new Date();
    const month = now.getMonth() + 1; // 1-indexed
    const currentYear = now.getFullYear();
    const cardAge = cardYear ? currentYear - Number(cardYear) : null;

    // Seasonal windows per sport
    const sportNorm = (typeof sport === "string" ? sport : "").toLowerCase();
    const isBaseball = sportNorm.includes("baseball") || sportNorm === "mlb" || sportNorm === "";
    const isFootball = sportNorm.includes("football") || sportNorm === "nfl";
    const isBasketball = sportNorm.includes("basketball") || sportNorm === "nba";

    interface SellWindow { startMonth: number; endMonth: number; label: string; reason: string }
    let windows: SellWindow[] = [];

    if (isBaseball) {
      if (isRookie) {
        windows = [
          { startMonth: 6, endMonth: 8, label: "Post-Draft Hype (Junâ€“Aug)", reason: "Rookie cards peak after the draft when prospect hype is highest." },
          { startMonth: 10, endMonth: 11, label: "Playoff Run (Octâ€“Nov)", reason: "Postseason exposure drives spikes for players on contending teams." },
        ];
      } else {
        windows = [
          { startMonth: 3, endMonth: 5, label: "Opening Day Buzz (Marâ€“May)", reason: "Veteran cards see renewed interest at the start of the season." },
          { startMonth: 9, endMonth: 10, label: "Late Season / Playoffs (Sepâ€“Oct)", reason: "Award race narratives and playoff push drive collector demand." },
        ];
      }
    } else if (isFootball) {
      if (isRookie) {
        windows = [
          { startMonth: 4, endMonth: 5, label: "NFL Draft Window (Aprâ€“May)", reason: "Rookie selections drive immediate hype for top picks." },
          { startMonth: 9, endMonth: 11, label: "Regular Season Breakout (Sepâ€“Nov)", reason: "Strong early performances push rookie values to their seasonal peak." },
        ];
      } else {
        windows = [
          { startMonth: 8, endMonth: 9, label: "Preseason Optimism (Augâ€“Sep)", reason: "Offseason moves and training camp buzz lift veterans before the season." },
          { startMonth: 1, endMonth: 2, label: "Super Bowl Run (Janâ€“Feb)", reason: "Playoff participants see sharp spikes as national interest peaks." },
        ];
      }
    } else if (isBasketball) {
      if (isRookie) {
        windows = [
          { startMonth: 6, endMonth: 7, label: "NBA Draft Hype (Junâ€“Jul)", reason: "Top picks peak in the days immediately after draft night." },
          { startMonth: 1, endMonth: 3, label: "All-Star Season (Janâ€“Mar)", reason: "All-Star selections and award races drive mid-season peaks." },
        ];
      } else {
        windows = [
          { startMonth: 10, endMonth: 12, label: "Season Opener Buzz (Octâ€“Dec)", reason: "Renewed interest at the start of a new NBA season." },
          { startMonth: 4, endMonth: 5, label: "Playoff Push (Aprâ€“May)", reason: "Playoff performers see sharp demand from casual collectors." },
        ];
      }
    } else {
      windows = [{ startMonth: 1, endMonth: 12, label: "Year-Round", reason: "No seasonal pattern available for this sport." }];
    }

    // Determine if we're currently in a window
    const activeWindow = windows.find((w) => month >= w.startMonth && month <= w.endMonth) ?? null;
    const nextWindow = !activeWindow
      ? windows.find((w) => w.startMonth > month) ?? windows[0]
      : null;

    const inWindowNow = activeWindow !== null;
    const monthsUntilNext = nextWindow
      ? nextWindow.startMonth > month
        ? nextWindow.startMonth - month
        : 12 - month + nextWindow.startMonth
      : 0;

    const cardAgeNote =
      cardAge !== null && cardAge <= 2
        ? " This is a recent card â€” collectors are still actively tracking this player."
        : cardAge !== null && cardAge > 10
        ? " This is a vintage card â€” prices are driven more by condition than season."
        : null;

    res.json({
      success: true,
      playerName,
      inWindowNow,
      activeWindow,
      nextWindow,
      monthsUntilNext: inWindowNow ? 0 : monthsUntilNext,
      allWindows: windows,
      verdict: inWindowNow
        ? `You're in a sell window now (${activeWindow!.label}). ${activeWindow!.reason}${cardAgeNote ?? ""}`
        : `Next sell window: ${nextWindow?.label} (${monthsUntilNext} month${monthsUntilNext !== 1 ? "s" : ""} away). ${nextWindow?.reason ?? ""}${cardAgeNote ?? ""}`,
    });
  } catch (err) {
    next(err);
  }
});

// ─── CF-TRENDIQ-SURFACES (2026-06-03) ───────────────────────────────────────
//
// Standalone TrendIQ surfaces, piggybacking computeEstimate (Option A from
// HALT GATE 1). The Cardsight + signals upstream fetches are deduped at the
// Cardsight client's lower-layer cacheWrap, so back-to-back /price-by-id
// and /trendiq for the same cardId issue no double network fetch.
//
// Two endpoints:
//   POST /api/compiq/trendiq       — investor+ composite
//   POST /api/compiq/trendiq/full  — pro_seller composite + raw L3 detail
//
// Gates: requireSession → requireEntitlement(<flag>) → requireRateLimited
// ("priceChecksPerDay"). Cap is defense-in-depth: only investor / pro_seller
// can pass entitlement, and both have unlimited priceChecksPerDay, so the
// cap never bites in practice — but it stays consistent with the FMV
// endpoints and protects against future matrix changes.
//
// Cardsight TOS hedge: `TRENDIQ_FULL_RAW_SALES_DISABLED=1` strips the raw
// preAnchorSales / postAnchorSales rows from the /full response in ONE
// place (the projection helper below). siblingCardIds + counts + perWindow
// percentiles are preserved.

import type { SegmentTrajectoryFull } from "../services/compiq/trendIQ.types.js";

const TRENDIQ_FULL_RAW_SALES_DISABLED = () =>
  ["1", "true", "TRUE", "yes"].includes(
    String(process.env.TRENDIQ_FULL_RAW_SALES_DISABLED ?? "").trim(),
  );

function projectSegmentTrajectoryFull(
  full: SegmentTrajectoryFull | null,
): SegmentTrajectoryFull | (Omit<SegmentTrajectoryFull, "preAnchorSales" | "postAnchorSales"> & { rawSalesOmitted: true }) | null {
  if (!full) return null;
  if (TRENDIQ_FULL_RAW_SALES_DISABLED()) {
    const {
      siblingCardIds,
      reanchorApplied,
      effectiveAnchorDate,
      originalAnchorDate,
      perWindow,
    } = full;
    return {
      siblingCardIds,
      reanchorApplied,
      effectiveAnchorDate,
      originalAnchorDate,
      perWindow,
      rawSalesOmitted: true,
    };
  }
  return full;
}

function parseTrendIQBody(req: import("express").Request) {
  const body = (req.body ?? {}) as {
    cardsightCardId?: unknown;
    query?: unknown;
    gradeCompany?: unknown;
    gradeValue?: unknown;
  };
  const resolvedCardId =
    typeof body.cardsightCardId === "string" && body.cardsightCardId.length > 0
      ? body.cardsightCardId
      : null;
  if (!resolvedCardId) {
    return { error: 'Missing "cardsightCardId" field' as const };
  }
  return {
    resolvedCardId,
    query: typeof body.query === "string" ? body.query : undefined,
    gradeCompany:
      typeof body.gradeCompany === "string" && body.gradeCompany.length > 0
        ? body.gradeCompany
        : undefined,
    gradeValue:
      typeof body.gradeValue === "number" ? body.gradeValue : undefined,
  };
}

router.post(
  "/trendiq",
  requireSession,
  requireEntitlement("trendIQComposite"),
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const parsed = parseTrendIQBody(req);
      if ("error" in parsed) {
        return res.status(400).json({ success: false, error: parsed.error });
      }
      const { resolvedCardId, query, gradeCompany, gradeValue } = parsed;
      const cacheKey = normalizeCacheKey(
        "compiq:trendiq:v1",
        `${resolvedCardId}|${gradeCompany ?? ""}${gradeValue ?? ""}`,
      );
      const result = await cacheWrap(
        cacheKey,
        async () => {
          const body: CompIQEstimateRequest = {
            playerName: typeof query === "string" ? query.trim() : resolvedCardId,
            cardsightCardId: resolvedCardId,
            gradeCompany,
            gradeValue,
          };
          const est = await computeEstimate(body, {
            source: "compiq-trendiq",
            userId: null,
            holdingId: null,
            routedFromHolding: false,
          });
          return {
            success: true,
            cardsightCardId: resolvedCardId,
            trendIQ: (est as any).trendIQ ?? null,
            signalsLastUpdated: (est as any).signalsLastUpdated ?? null,
            cardIdentity: (est as any).cardIdentity ?? null,
            gradeUsed: (est as any).gradeUsed ?? null,
          };
        },
        CACHE_TTL_SECONDS,
      );
      res.json(result);
    } catch (err) {
      if (isCardsightTimeoutError(err)) {
        return res.status(200).json({
          success: true,
          cardsightCardId:
            typeof (req.body ?? {}).cardsightCardId === "string"
              ? (req.body as any).cardsightCardId
              : "",
          trendIQ: null,
          signalsLastUpdated: null,
          cardIdentity: null,
          gradeUsed: null,
          warning: "upstream-timeout",
        });
      }
      next(err);
    }
  },
);

router.post(
  "/trendiq/full",
  requireSession,
  requireEntitlement("trendIQLayer3Full"),
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const parsed = parseTrendIQBody(req);
      if ("error" in parsed) {
        return res.status(400).json({ success: false, error: parsed.error });
      }
      const { resolvedCardId, query, gradeCompany, gradeValue } = parsed;
      const cacheKey = normalizeCacheKey(
        "compiq:trendiq-full:v1",
        `${resolvedCardId}|${gradeCompany ?? ""}${gradeValue ?? ""}`,
      );
      const result = await cacheWrap(
        cacheKey,
        async () => {
          let captured: SegmentTrajectoryFull | null = null;
          const body: CompIQEstimateRequest = {
            playerName: typeof query === "string" ? query.trim() : resolvedCardId,
            cardsightCardId: resolvedCardId,
            gradeCompany,
            gradeValue,
          };
          const est = await computeEstimate(
            body,
            {
              source: "compiq-trendiq-full",
              userId: null,
              holdingId: null,
              routedFromHolding: false,
            },
            {
              captureSegmentTrajectoryFull: (full) => {
                captured = full;
              },
            },
          );
          return {
            success: true,
            cardsightCardId: resolvedCardId,
            trendIQ: (est as any).trendIQ ?? null,
            signalsLastUpdated: (est as any).signalsLastUpdated ?? null,
            cardIdentity: (est as any).cardIdentity ?? null,
            gradeUsed: (est as any).gradeUsed ?? null,
            segmentTrajectoryFull: projectSegmentTrajectoryFull(captured),
          };
        },
        CACHE_TTL_SECONDS,
      );
      res.json(result);
    } catch (err) {
      if (isCardsightTimeoutError(err)) {
        return res.status(200).json({
          success: true,
          cardsightCardId:
            typeof (req.body ?? {}).cardsightCardId === "string"
              ? (req.body as any).cardsightCardId
              : "",
          trendIQ: null,
          signalsLastUpdated: null,
          cardIdentity: null,
          gradeUsed: null,
          segmentTrajectoryFull: null,
          warning: "upstream-timeout",
        });
      }
      next(err);
    }
  },
);

// ─── CF-MARKET-TREND-INDEXES (2026-06-03) ──────────────────────────────────
//
// marketDelta is computed per-player from Cosmos `comp_logs` and consumed
// internally by DailyIQ brief assembly. This block exposes it as a gated
// surface (investor+ via `marketTrendIndexes`). 3 routes:
//   GET  /api/compiq/market-trend?playerName=<name>      — single player
//   GET  /api/compiq/market-trend/batch?playerNames=a,b,c — ≤ 20 players
//   GET  /api/compiq/market-trend/top-movers?window=1d|7d|30d&limit=20
//
// Cap decision: NONE. marketDelta hits Cosmos `comp_logs` only (10-min
// in-process cache); no Cardsight/upstream cost per call. Charging
// `priceChecksPerDay` would create false negatives for users browsing
// their watchlist.
//
// pct30d field: marketDelta documents this as a 7d-vs-30d MOMENTUM
// approximation, NOT a true 30d-vs-prior-30d delta. The response carries
// the label so iOS rendering can show "vs prior window (approx)" instead
// of falsely labeling it "30-day change". True 30d-vs-prior-30d + by-sport
// / by-set aggregations are explicitly deferred to a Phase 2 CF.
import {
  getMarketDelta,
  getMarketDeltasForPlayers,
  type MarketDelta,
} from "../services/dailyiq/marketDelta.service.js";
import { getLatestBrief } from "../repositories/dailyiq.repository.js";

type MarketTrendConfidence = "high" | "low" | "none";

function deriveConfidence(delta: MarketDelta | null): MarketTrendConfidence {
  if (!delta) return "none";
  if (delta.sampleCount < 5) return "low";
  return "high";
}

const PCT30D_WINDOW_LABEL =
  "pct30d is 7d-vs-30d momentum (approximation); true 30d-vs-prior-30d arrives in Phase 2";

type MarketTrendSelectedWindow = "1d" | "7d" | "30d";

/**
 * Shared response-shape contract across all 3 market-trend routes so iOS
 * can decode `window` into a single `MarketTrendWindow` Codable. Always an
 * object; never a bare string. `selected` is present only on top-movers
 * (where the user picks the ranking window); per-player + batch responses
 * carry no `selected` field because all three windows are returned at once.
 */
interface MarketTrendWindow {
  selected?: MarketTrendSelectedWindow;
  pct30dLabel: string;
}

function buildWindow(selected?: MarketTrendSelectedWindow): MarketTrendWindow {
  return selected
    ? { selected, pct30dLabel: PCT30D_WINDOW_LABEL }
    : { pct30dLabel: PCT30D_WINDOW_LABEL };
}

function shapeDelta(delta: MarketDelta | null): {
  delta: MarketDelta | null;
  confidence: MarketTrendConfidence;
  window: MarketTrendWindow;
} {
  return {
    delta,
    confidence: deriveConfidence(delta),
    window: buildWindow(),
  };
}

router.get(
  "/market-trend",
  requireSession,
  requireEntitlement("marketTrendIndexes"),
  async (req, res, next) => {
    try {
      const playerName =
        typeof req.query.playerName === "string"
          ? req.query.playerName.trim()
          : "";
      if (!playerName) {
        return res
          .status(400)
          .json({ success: false, error: "playerName query param is required" });
      }
      const delta = await getMarketDelta(playerName);
      res.json({
        success: true,
        playerName,
        ...shapeDelta(delta),
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/market-trend/batch",
  requireSession,
  requireEntitlement("marketTrendIndexes"),
  async (req, res, next) => {
    try {
      const raw =
        typeof req.query.playerNames === "string" ? req.query.playerNames : "";
      const names = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: "playerNames query param is required (comma-separated)" });
      }
      const safe = names.slice(0, 20);
      const map = await getMarketDeltasForPlayers(safe);
      const deltas: Record<
        string,
        { delta: MarketDelta | null; confidence: MarketTrendConfidence }
      > = {};
      for (const name of safe) {
        const d = map.get(name) ?? null;
        deltas[name] = { delta: d, confidence: deriveConfidence(d) };
      }
      res.json({
        success: true,
        deltas,
        window: buildWindow(),
        truncated: names.length > safe.length ? { requested: names.length, served: safe.length } : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

const TOP_MOVERS_VALID_WINDOWS = new Set(["1d", "7d", "30d"]);

router.get(
  "/market-trend/top-movers",
  requireSession,
  requireEntitlement("marketTrendIndexes"),
  async (req, res, next) => {
    try {
      const windowRaw =
        typeof req.query.window === "string" ? req.query.window.trim() : "";
      if (!TOP_MOVERS_VALID_WINDOWS.has(windowRaw)) {
        return res.status(400).json({
          success: false,
          error: "window must be one of: 1d, 7d, 30d",
        });
      }
      const selected = windowRaw as MarketTrendSelectedWindow;
      const limitRaw = Number(req.query.limit ?? 20);
      const limit =
        Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 50
          ? Math.floor(limitRaw)
          : 20;

      // Candidate pool: latest cached DailyIQ brief (MLB + MiLB top players).
      // Reuses the 10-min marketDelta cache; no new Cardsight calls.
      const brief = await getLatestBrief();
      const pool: string[] = brief
        ? [
            ...(brief.mlb ?? []).map((p) => p.playerName),
            ...(brief.milb ?? []).map((p) => p.playerName),
          ].filter((n): n is string => typeof n === "string" && n.length > 0)
        : [];
      if (pool.length === 0) {
        return res.json({
          success: true,
          window: buildWindow(selected),
          limit,
          movers: [],
          poolSize: 0,
        });
      }
      const map = await getMarketDeltasForPlayers(pool);
      const field: keyof MarketDelta =
        selected === "1d" ? "pct1d" : selected === "7d" ? "pct7d" : "pct30d";
      const ranked = Array.from(map.entries())
        .map(([playerName, delta]) => ({ playerName, delta }))
        .filter(
          (row): row is { playerName: string; delta: MarketDelta } =>
            row.delta !== null,
        )
        .sort((a, b) => Math.abs(b.delta[field]) - Math.abs(a.delta[field]))
        .slice(0, limit)
        .map((row) => ({
          playerName: row.playerName,
          delta: row.delta,
          confidence: deriveConfidence(row.delta),
        }));
      res.json({
        success: true,
        window: buildWindow(selected),
        limit,
        movers: ranked,
        poolSize: pool.length,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Test-only export â€” keeps `regimeFieldsFromEstimate` reachable from unit
// tests without exposing it on the public router surface.
export const __testing__ = { regimeFieldsFromEstimate, predictedRangeFieldsFromEstimate };

export default router;
