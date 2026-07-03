import { Router } from "express";
import {
  compiqEstimate,
  computeEstimate,
  simulateWhatIf,
  logFmvDriftObserved,
  deriveSalesMomentum,
  logSalesMomentumObserved,
  deriveGradeLadderAnchor,
  type GradeLadderGrade,
} from "../services/compiq/compiqEstimate.service.js";
import {
  getCardFmv,
  getPriceEstimate,
  getSalesStatsByPlayer,
  getTotalSalesByPlayer,
  // CF-COMPIQ-SCAN-ROUTE (2026-06-30): iOS slab scanning entry point.
  // Uses CH's image-match + cert-OCR endpoints to identify a card
  // from a photo and return a structured response iOS can hand to
  // /price-by-id for pricing.
  identifyCardByImage,
  getCardDetailsByCertImage,
  type ImageInput,
} from "../services/compiq/cardhedge.client.js";
import { cacheWrap, cacheSet, cacheDel } from "../services/shared/cache.service.js";
import { CompIQEstimateRequest } from "../types/compiq.types.js";
// CF-MARKET-READ (2026-06-08): grounded prose summary of the comp pool
// for /price-by-id. Reads from the cs:pricing cached payload — no new
// Cardsight wire op. See marketRead.service.ts header for architecture.
import {
  generateMarketRead,
  pickCardImageUrl,
  buildGradeBreakdown,
  type MarketReadResult,
  type GradeBreakdownEntry,
} from "../services/compiq/marketRead.service.js";
// CF-PLAYER-IN-SET-HISTORY (2026-06-09): seed (player, set, year) tuples
// to the nightly compute queue. Fire-and-forget; service swallows
// errors so a blob hiccup never affects the response.
import { enqueuePlayerSetTuple } from "../services/compiq/playerSetQueue.service.js";
import {
  getPricing as getPricingForMarketRead,
  getCardImage,
  autocompleteCards,
} from "../services/compiq/catalogSource.js";
// CF-CARDHEDGE-CARD-IMAGE (2026-06-30): recover the CardHedge CDN image for
// the pinned /price-by-id hero from the RoutedCard meta cache (populated by
// the search that preceded the tap).
import { getCardMetaById } from "../services/compiq/cardsight.router.js";
// CF-GRADED-PRICE-PROJECTION Phase 2 (2026-06-13): wire graded estimator
// into /price-by-id. Grounded-only (estimate + rough); ballpark + insufficient
// dropped. Display-not-train: every entry has fairMarketValue=null.
// Phase 1c (2026-06-14): tier-2b release-level grade-premium curve plumbed
// via computeReleaseGradeCurve; cached (release, year) at 6h.
// CF-COMPILE-GRADED-ESTIMATES (2026-06-14): assembly extracted to
// compileGradedEstimatesForCard so autoPriceHolding can reuse the same
// canonical path. Behavior here is unchanged — see helper header.
import type { GradedProjectionResult } from "../services/compiq/gradedPriceProjection.js";
import { compileGradedEstimatesForCard } from "../services/compiq/compileGradedEstimatesForCard.js";

// CF-CARD-IMAGE-PROXY (2026-06-08): build an absolute URL for the
// `/api/compiq/card-image/:id` proxy route from the request context.
// Honors x-forwarded-* set by Azure App Service's reverse proxy so the
// emitted URL is publicly hittable. Falls back to req.protocol + host.
function absoluteApiUrl(req: import("express").Request, path: string): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol ?? "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers.host as string | undefined) ??
    "";
  return `${proto}://${host}${path}`;
}

// UUID-shape check for the proxy route. Cardsight cardIds are UUIDv4-
// shaped 32 hex with 4 hyphens. Reject anything else without making a
// Cardsight call (defense against random-path scrapers).
const CARDSIGHT_CARD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { getNormalizationDictionary } from "../services/compiq/normalizationDictionary.service.js";
import { dispatchSearch } from "../services/unifiedSearch/dispatcher.js";
import {
  identifyCard,
  searchCards,
  getPricesByCard,
  getCardDetailsById,
} from "../services/compiq/cardhedge.client.js";
import {
  parseCardQuery,
  buildCompSearchQuery,
  type ParsedCardQuery,
} from "../services/compiq/cardQueryParser.js";
import { fetchCompsByPlayer } from "../services/compiq/compsByPlayer.service.js";
import { fetchPlayerInSetMomentum } from "../services/compiq/playerInSetMomentum.service.js";
import { getPlayerTrendSnapshot } from "../services/playerTrend/index.js";
import {
  evaluateMomentumProjection,
  isMomentumProjectionEnabled,
} from "../services/compiq/momentumProjection.service.js";
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

// ─────────────────────────────────────────────────────────────────────────────
// CF-PRICE-AUTO-PROJECTION-HELPERS (2026-07-02)
//
// Hoisted at module scope so both /price and /price-by-id can reuse the
// autograph projection fallback stack (Layer 4 sibling anchor → Layer 2
// base × auto multiplier). Previously Layer 2 + 4 were inline in /price only.
// ─────────────────────────────────────────────────────────────────────────────

/** Autograph card-number prefixes recognized by the projection fallbacks. */
const AUTO_PROJECT_PREFIX_RE =
  /^(CPA|CDA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA|AU|HSA|RRA|PRV)(-|$)/i;

/** Rare/special-insert autograph prefixes — priced at a higher premium than
 *  the regular CPA-family. */
const RARE_AUTO_PROJECT_PREFIX_RE = /^(HSA|RRA|PRV|USA|AU)(-|$)/i;

/**
 * Empirical auto-premium multiplier per prefix class, calibrated from CH
 * sampling on 2026-07-02:
 *   CPA-family (regular prospect autos)   — median 42.7× (n=13 pairs)
 *   HSA/RRA/PRV/USA/AU (rare inserts)     — no calibrated sample (kept
 *                                            conservatively at 50×)
 *
 * See scratchpad/calibrate_multipliers.py for the sampling procedure. To
 * recalibrate, rerun the script and update these constants.
 */
function autoProjectMultiplierFor(num: string): number {
  return RARE_AUTO_PROJECT_PREFIX_RE.test(num) ? 50 : 40;
}

/**
 * CH's /cards/card-search returns year: null on every row (verified 2026-07-01
 * during PR #243 rerank fix). Extract from the set string ("2025 Bowman
 * Baseball") instead.
 */
function autoProjectExtractYearFromSet(setStr: unknown): number | null {
  if (typeof setStr !== "string") return null;
  const m = setStr.match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

/**
 * Apply the autograph projection fallback stack to a computeEstimate result.
 * When the target auto card has zero recent comps, tries in order:
 *   1. Sibling auto (same player + year + auto prefix, different card_id)
 *      priced as latest_sale × trend_factor. Preferred — tightest anchor.
 *   2. Base × auto multiplier — fixed empirical premium by prefix class.
 *
 * Mutates `est` in place with predictedPrice / predictedPriceRange /
 * predictedPriceAttribution + upgrades `est.source` to "projected". Silently
 * no-ops when the trigger conditions aren't met OR when neither anchor path
 * finds ≥3 valid Raw prices.
 */
async function applyAutoProjectionFallbacks(
  est: Record<string, unknown>,
  query: string,
): Promise<void> {
  const cardIdentity =
    est.cardIdentity && typeof est.cardIdentity === "object"
      ? (est.cardIdentity as Record<string, unknown>)
      : {};
  const ciPlayer = typeof cardIdentity.player === "string" ? cardIdentity.player : null;
  const ciYear =
    typeof cardIdentity.year === "number" ? cardIdentity.year : null;
  const ciNumber = typeof cardIdentity.number === "string" ? cardIdentity.number : null;
  const ciCardId = typeof cardIdentity.card_id === "string" ? cardIdentity.card_id : null;
  const estSource = typeof est.source === "string" ? est.source : null;
  const estCompsAvail =
    typeof est.compsAvailable === "number" ? est.compsAvailable : null;

  const triggerBase =
    estSource === "no-recent-comps" &&
    estCompsAvail === 0 &&
    !!ciPlayer &&
    !!ciYear &&
    !!ciNumber &&
    AUTO_PROJECT_PREFIX_RE.test(ciNumber);

  if (!triggerBase) return;

  let siblingUsed = false;

  // ── Layer 4: sibling auto (latest × trend) ──────────────────────────────
  if (ciCardId) {
    try {
      const playerCards = await searchCards("", 50, { player: ciPlayer as string }, 1);
      const siblingCandidates = playerCards.filter((c) => {
        const cYear = autoProjectExtractYearFromSet(c.set);
        const cNum = typeof c.number === "string" ? c.number : "";
        return (
          cYear === ciYear &&
          AUTO_PROJECT_PREFIX_RE.test(cNum) &&
          c.card_id !== ciCardId
        );
      });
      const priced = await Promise.all(
        siblingCandidates.slice(0, 8).map(async (c) => {
          const dailyPrices = await getPricesByCard(c.card_id, "Raw", 90);
          return { card: c, dailyPrices };
        }),
      );
      const withData = priced.filter((r) => r.dailyPrices.length >= 3);
      withData.sort((a, b) => b.dailyPrices.length - a.dailyPrices.length);
      const winner = withData[0];
      if (winner && winner.dailyPrices.length >= 3) {
        const dp = winner.dailyPrices;
        const latestSale = dp[dp.length - 1].price;
        const window = 14;
        const recentSlice = dp.slice(-window);
        const priorSlice = dp.slice(-2 * window, -window);
        const avg = (arr: typeof dp) =>
          arr.length > 0 ? arr.reduce((s, p) => s + p.price, 0) / arr.length : 0;
        const recentAvg = avg(recentSlice);
        const priorAvg = avg(priorSlice);
        let trendFactor = priorAvg > 0 ? recentAvg / priorAvg : 1.0;
        if (!Number.isFinite(trendFactor) || trendFactor <= 0) trendFactor = 1.0;
        trendFactor = Math.max(0.5, Math.min(2.0, trendFactor));

        const parallelMultiplier = 1.0; // v1
        const projected = latestSale * trendFactor * parallelMultiplier;
        const low = projected * 0.6;
        const high = projected * 1.6;
        console.log(
          JSON.stringify({
            event: "price_sibling_auto_anchor",
            source: "compiq.routes",
            originalQuery: query,
            targetCardId: ciCardId,
            targetNumber: ciNumber,
            anchorCardId: winner.card.card_id,
            anchorNumber: winner.card.number,
            anchorVariant: winner.card.variant,
            anchorLatestSale: latestSale,
            anchorRecentAvg: Math.round(recentAvg * 100) / 100,
            anchorPriorAvg: Math.round(priorAvg * 100) / 100,
            trendFactor: Math.round(trendFactor * 100) / 100,
            parallelMultiplier,
            anchorSampleSize: dp.length,
            projected,
          }),
        );
        est.predictedPrice = projected;
        est.predictedPriceRange = { low, high };
        est.predictedPriceAttribution = {
          mechanism: "sibling_auto_latest_x_trend",
          anchorCardId: winner.card.card_id,
          anchorPrice: latestSale,
          anchorLatestSale: latestSale,
          anchorRecentAvg: recentAvg,
          anchorPriorAvg: priorAvg,
          trendFactor,
          parallelMultiplier,
          anchorSampleSize: dp.length,
          anchorNumber: winner.card.number,
          anchorVariant: winner.card.variant,
          anchorSet: winner.card.set,
          note: "Estimated from sibling autograph's latest sale × recent momentum; actual target-parallel premium not modeled in v1",
        };
        est.source = "projected";
        siblingUsed = true;
      }
    } catch {
      // fall through to Layer 2
    }
  }

  if (siblingUsed) return;

  // ── Layer 2: base × auto multiplier ─────────────────────────────────────
  try {
    const playerCards = await searchCards("", 50, { player: ciPlayer as string }, 1);
    const sameYearBase = playerCards.find((c) => {
      const cYearNumeric =
        typeof c.year === "number"
          ? c.year
          : typeof c.year === "string"
          ? Number(c.year)
          : NaN;
      const cYear = Number.isFinite(cYearNumeric)
        ? (cYearNumeric as number)
        : autoProjectExtractYearFromSet(c.set);
      const cNum = typeof c.number === "string" ? c.number : "";
      const cVar = typeof c.variant === "string" ? c.variant.toLowerCase() : "";
      return (
        cYear === ciYear &&
        !AUTO_PROJECT_PREFIX_RE.test(cNum) &&
        cVar === "base"
      );
    });
    if (sameYearBase && sameYearBase.card_id) {
      const prices = await getPricesByCard(sameYearBase.card_id, "Raw", 90);
      const sorted = prices
        .map((p) => p.price)
        .filter((p) => Number.isFinite(p) && p > 0)
        .sort((a, b) => a - b);
      if (sorted.length >= 3) {
        const median = sorted[Math.floor(sorted.length / 2)];
        const autoPremium = autoProjectMultiplierFor(ciNumber as string);
        const projected = median * autoPremium;
        const low = projected * 0.5;
        const high = projected * 1.5;
        console.log(
          JSON.stringify({
            event: "price_base_x_auto_projection",
            source: "compiq.routes",
            originalQuery: query,
            anchorCardId: sameYearBase.card_id,
            anchorMedian: median,
            anchorSampleSize: sorted.length,
            multiplier: autoPremium,
            projected,
          }),
        );
        est.predictedPrice = projected;
        est.predictedPriceRange = { low, high };
        est.predictedPriceAttribution = {
          mechanism: "base_x_auto_premium",
          anchorCardId: sameYearBase.card_id,
          anchorPrice: median,
          anchorSampleSize: sorted.length,
          anchorNumber: sameYearBase.number,
          anchorSet: sameYearBase.set,
          multiplier: autoPremium,
          note: "Rough projection — empirical median CPA-family multiplier is ~42×; rare inserts kept conservatively at 50×",
        };
        est.source = "projected";
      }
    }
  } catch {
    // Layer 2 best-effort; leave est untouched on failure.
  }
}

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

// CF-MARKETVALUE-HONESTY (2026-06-09): explicit guards for the
// "valid source but pipeline couldn't price" case — e.g. a parallel
// request with only 2 sales (TrendIQ coverage=no_card, FMV pipeline
// returns 0 because the trajectory window can't form). The legacy
// isThin gate only catches sources in THIN_SOURCES; the FMV pipeline
// can also produce 0 / null / NaN on the LIVE source when the
// post-filter pool is too thin to anchor.
//
// Rule (any one suffices to hide the price tiers):
//   - isThinFromEst already returns true
//   - est.fairMarketValue is null / undefined / 0 / negative / NaN
//   - est.trendIQ.coverage === "no_card" (Layer 2 missing — pipeline
//     fundamentally can't anchor the card)
//   - est.compsUsed < 3 (sub-threshold data — the FMV's value is the
//     same as the median of two prices, which is too brittle to
//     surface as an FMV)
//
// When this returns true, the response builder emits null / [null,
// null] across marketTier / buyZone / holdZone / sellZone /
// fairMarketValueLive / marketValue. NEVER emit 0 as a real price.
// iOS reads any-null as the "no-estimate" state.
function cannotPriceFromEst(est: Record<string, unknown>): boolean {
  if (isThinFromEst(est)) return true;
  const fmv = est.fairMarketValue;
  if (fmv === null || fmv === undefined) return true;
  if (typeof fmv !== "number" || !Number.isFinite(fmv) || fmv <= 0) return true;
  const trendIQ = est.trendIQ as { coverage?: string } | undefined;
  if (trendIQ?.coverage === "no_card") return true;
  // CF-PINNED-PARALLEL-RECOVERY (2026-06-11) #3: skip the compsUsed<3
  // thin gate for title-match-recovered pools. Same rationale as the
  // upstream variant-tier-ladder + dataSufficiency + insufficient-
  // short-circuit bypasses: the recovery isolated a CLEAN parallel-
  // specific sub-market via title tokens + sibling-registry guard +
  // span-scoped finish-vocab backstop. 1-2 records of THAT pool are
  // the honest market value; nulling the price tiers here would
  // contradict the rest of the pipeline. iOS reads priceSource=
  // "approximate" for the thin-data disclosure.
  const priceSourceInternal = est.priceSourceInternal;
  const isRecoveryIsolatedPool =
    priceSourceInternal === "title-matched-parallel"
    || priceSourceInternal === "title-match-low-sample";
  const compsUsed = est.compsUsed;
  if (
    typeof compsUsed === "number"
    && compsUsed < 3
    && !isRecoveryIsolatedPool
  ) {
    return true;
  }
  return false;
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

/**
 * CF-CH-TELEMETRY-FANOUT (2026-06-28): fire-and-forget helper that posts
 * the two CardHedge-reference telemetry events (`fmv_drift_observed` +
 * `sales_momentum_observed`) for a freshly-priced card. Called from
 * `/search`, `/price`, and `/price-by-id` so the evidence base accumulates
 * uniformly regardless of which user-facing route fires.
 *
 * Pure side-effect: void return, never throws (every CH call and every
 * log is guarded). Caller MUST invoke as `void recordCHReferenceTelemetry(...)`
 * — awaiting it would block the response path and defeat the purpose.
 *
 * `source` is the App Insights `source` field, used downstream KQL to
 * separate per-route base rates ("which route gives best drift signal
 * coverage?"). `engineFmv` should be null when the route surfaced null
 * (thin/can't-price) — matches what the user actually sees.
 */
function recordCHReferenceTelemetry(opts: {
  source: string;
  cardId: string | null;
  player: string | null;
  gradingCompany: string | null;
  gradeValue: number | null;
  engineFmv: number | null;
}): void {
  if (!opts.cardId) return;
  const grade =
    opts.gradingCompany && typeof opts.gradeValue === "number"
      ? `${opts.gradingCompany} ${opts.gradeValue}`
      : "Raw";
  // FMV drift telemetry
  void (async () => {
    try {
      const [chFmv, chEst] = await Promise.all([
        getCardFmv(opts.cardId!, grade),
        getPriceEstimate(opts.cardId!, grade),
      ]);
      logFmvDriftObserved({
        source: opts.source,
        player: opts.player,
        cardId: opts.cardId!,
        gradingCompany: opts.gradingCompany,
        grade,
        engineFmv: opts.engineFmv,
        chCardFmv: chFmv
          ? {
              price: chFmv.price,
              confidence: chFmv.confidence,
              confidenceGrade: chFmv.confidence_grade ?? null,
              freshnessDays: chFmv.freshness_days,
              method: chFmv.method,
            }
          : null,
        chPriceEstimate: chEst
          ? { price: chEst.price, confidence: chEst.confidence, method: chEst.method }
          : null,
      });
    } catch (err) {
      console.warn(
        `[${opts.source}] fmv-drift telemetry failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  })();
  // Sales-momentum telemetry — player-keyed, so skip if we don't have one.
  if (!opts.player) return;
  void (async () => {
    try {
      const [stats, totals] = await Promise.all([
        getSalesStatsByPlayer([opts.player!], "week"),
        getTotalSalesByPlayer([opts.player!]),
      ]);
      const playerResult = stats?.results?.find((r) => r.player === opts.player);
      if (!playerResult) return;
      const signal = deriveSalesMomentum(playerResult.buckets);
      const totals30d =
        totals?.results?.find((r) => r.player === opts.player)?.total_sales ?? null;
      logSalesMomentumObserved({
        source: opts.source,
        player: opts.player!,
        cardId: opts.cardId,
        signal,
        totalSales30d: totals30d,
      });
    } catch (err) {
      console.warn(
        `[${opts.source}] sales-momentum telemetry failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  })();
}

/**
 * CF-PLAYER-MOMENTUM-THIN-COMP-PROJECTION (2026-07-01):
 * Fire-and-forget telemetry that evaluates the momentum projection
 * against the just-served response and logs the result. Runs alongside
 * recordCHReferenceTelemetry — same fire-and-forget contract, same
 * player-keyed gate, same never-throws guarantee.
 *
 * Purely observational for now:
 * - Fetches getPlayerTrendSnapshot (vendor-neutral via services/playerTrend/)
 * - Evaluates evaluateMomentumProjection with the response's implied
 *   lastCardSale + daysSinceNewestComp
 * - Emits player_momentum_projection_evaluated with the full attribution
 * - Does NOT touch the response — the response is already flushed to
 *   the client by the time this callback fires
 *
 * Once prod data validates the projection is producing sensible numbers,
 * a follow-up CF plumbs the momentumAnchor field onto the wire response
 * and (optionally) drives estimatedValue for thin-comp cases.
 *
 * Gated by PLAYER_MOMENTUM_PROJECTION_ENABLED — same flag that later
 * turns on the pricing path. Setting flag → false disables telemetry
 * too (matches "the whole feature is off" semantics).
 */
function recordMomentumProjectionEvaluated(opts: {
  source: string;
  cardId: string | null;
  player: string | null;
  result: Record<string, unknown>;
}): void {
  if (!opts.player) return;
  if (!isMomentumProjectionEnabled()) return;
  void (async () => {
    try {
      const snapshot = await getPlayerTrendSnapshot(opts.player!);
      if (!snapshot) {
        console.log(JSON.stringify({
          event: "player_momentum_projection_evaluated",
          source: opts.source,
          player: opts.player,
          cardId: opts.cardId,
          applied: false,
          reason: "no_trend_snapshot",
        }));
        return;
      }

      // Derive last card sale + days-since-newest from the response's
      // recentComps. If the response didn't carry any, we still evaluate
      // so we can distinguish "no comp visible" from "comp too stale".
      const recentComps = Array.isArray(opts.result.recentComps)
        ? (opts.result.recentComps as Array<{ price?: unknown; soldDate?: unknown; date?: unknown }>)
        : [];
      let lastCardSalePrice: number | null = null;
      let lastCardSaleDate: string | null = null;
      let newestTs = 0;
      for (const c of recentComps) {
        const ds = (typeof c.soldDate === "string" ? c.soldDate : typeof c.date === "string" ? c.date : null) as string | null;
        const ts = ds ? Date.parse(ds) || 0 : 0;
        const p = typeof c.price === "number" ? c.price : null;
        if (ts > newestTs && p !== null && p > 0) {
          newestTs = ts;
          lastCardSalePrice = p;
          lastCardSaleDate = ds;
        }
      }
      const daysSinceNewestComp =
        newestTs > 0 ? Math.floor((Date.now() - newestTs) / (24 * 3600 * 1000)) : null;

      const projection = evaluateMomentumProjection({
        playerName: opts.player!,
        trendSnapshot: snapshot,
        lastCardSalePrice,
        lastCardSaleDate,
        directCompCount: recentComps.length,
        daysSinceNewestComp,
      });

      console.log(JSON.stringify({
        event: "player_momentum_projection_evaluated",
        source: opts.source,
        player: opts.player,
        cardId: opts.cardId,
        supplyTrend: snapshot.supplyTrend,
        momentumRatio: snapshot.momentum.momentumRatio,
        volumeRatio: snapshot.momentum.volumeRatio,
        latestWeekCount: snapshot.momentum.latestCompleteWeek?.count ?? null,
        providerName: snapshot.providerName,
        applied: projection.applied,
        ...(projection.applied
          ? {
              projectedPrice: projection.projectedPrice,
              confidence: projection.confidence,
              attribution: projection.attribution,
              engineFairMarketValueLive:
                typeof opts.result.fairMarketValueLive === "number"
                  ? (opts.result.fairMarketValueLive as number)
                  : null,
              engineSource: typeof opts.result.source === "string" ? opts.result.source : null,
            }
          : { reason: projection.reason }),
      }));
    } catch (err) {
      console.warn(
        `[${opts.source}] momentum-projection telemetry failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  })();
}

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

// CF-MCP-PLAYER-IN-SET-BRIDGE (2026-06-10): expose the live per-(player,
// release, year) momentum so MCP /predict can override the player-wide
// compsMomentum from fn-serve-signals with the release-aware signal.
//
// Returns the same per-card median-ratio computation the backend's
// TrendIQ Layer 1 already uses (CF-PLAYER-IN-SET-PER-CARD-DIRECTION).
// Single source of truth — MCP doesn't re-implement the algorithm.
//
// Shape mirrors the aggregator's `compsMomentum` contract (multiplier +
// signal direction), plus the full per-card breakdown for the optional
// advisor-prose use. Null payload when the per-(player, release, year)
// pool can't form a signal (< MIN_QUALIFYING_CARDS); MCP falls back to
// the player-wide value in that case.
//
// Query params: player (req), release (req), year (req).
// No auth — same posture as /comps-by-player; MCP is the only caller.
router.get("/player-in-set-momentum", async (req, res, next) => {
  try {
    const player = typeof req.query.player === "string" ? req.query.player.trim() : "";
    const release = typeof req.query.release === "string" ? req.query.release.trim() : "";
    const yearRaw = typeof req.query.year === "string" ? req.query.year.trim() : "";

    if (!player) return res.status(400).json({ error: "player query parameter is required" });
    if (!release) return res.status(400).json({ error: "release query parameter is required" });
    if (!yearRaw) return res.status(400).json({ error: "year query parameter is required" });
    const year = Number(yearRaw);
    if (!Number.isFinite(year) || year < 1900 || year > 2100) {
      return res.status(400).json({ error: "year must be a 4-digit year between 1900 and 2100" });
    }

    const component = await fetchPlayerInSetMomentum({
      playerName: player,
      product: release,
      cardYear: year,
    });

    if (!component) {
      // Honest null — caller (MCP) falls back to player-wide signal.
      return res.json({
        player,
        release,
        year,
        signal: null,
        multiplier: null,
        source: "playerInSet",
      });
    }

    // Surface compsMomentum-compatible shape so MCP can drop it into the
    // aggregator's `components.compsMomentum` slot without translation.
    // `signal` derives from the multiplier-vs-threshold logic baked into
    // fetchPlayerInSetMomentum's flags array; "rising"/"falling"/"stable".
    const directionFlag = component.flags.find((f) => f === "rising" || f === "falling" || f === "stable");
    const signal = directionFlag ?? "stable";

    res.json({
      player,
      release,
      year,
      signal,
      multiplier: component.multiplier,
      source: "playerInSet",
      // Full per-card breakdown for advisor / debugging.
      componentSignals: component.componentSignals,
      flags: component.flags,
      lastUpdated: component.lastUpdated,
    });
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
    // CF-CARD-IMAGE-PROXY (2026-06-08): patch each candidate's imageUrl
    // to point at our card-image proxy route. The catalog adapter emits
    // imageUrl: null (Cardsight's catalog/search response carries no
    // image — confirmed in the CF-C recon); we fill it in with the
    // proxy URL here so iOS can render thumbnails on each picker row.
    // Candidates whose `candidateId` is shaped `cardsight:<uuid>` get a
    // URL; cert-grader rows (different attribution) keep imageUrl null.
    const candidates: any[] = Array.isArray((response as any)?.candidates)
      ? (response as any).candidates
      : [];
    for (const c of candidates) {
      // CF-CARDHEDGE-CARD-IMAGE (2026-06-30): a candidate that already
      // carries a real http(s) image (CardHedge CDN URL set by the
      // dispatcher) is authoritative — never overwrite it with the
      // dead Cardsight proxy URL.
      if (typeof c?.imageUrl === "string" && /^https?:\/\//i.test(c.imageUrl)) {
        continue;
      }
      const cid: string | undefined =
        typeof c?.candidateId === "string" ? c.candidateId : undefined;
      const m = cid?.match(/^cardsight:([0-9a-f-]+)$/i);
      const csId = m?.[1];
      if (csId && CARDSIGHT_CARD_ID_RE.test(csId)) {
        c.imageUrl = absoluteApiUrl(req, `/api/compiq/card-image/${csId}`);
      }
    }
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

// GET /api/compiq/card-image/:cardId
//
// CF-CARD-IMAGE-PROXY (2026-06-08): backend proxy for Cardsight's
// catalog card-image endpoint (/v1/images/cards/<id>). iOS cannot hit
// Cardsight directly because the upstream needs our X-API-Key header
// (auth must stay server-side). This route validates the cardId shape,
// proxies the upstream call, and streams the JPEG bytes back with a
// Cache-Control header matching Cardsight's max-age=86400 so iOS
// (URLSession / AsyncImage) caches each card image for 24h.
//
// Unauthenticated by design: iOS embeds these as `<img src=...>` /
// AsyncImage URLs, which use a default URLSession that can't inject
// session headers. Card photos are non-sensitive (Cardsight serves
// them on the same API); the proxy's job is hiding our X-API-Key,
// NOT gating access to the images. If scraping becomes an issue we
// can tighten with a short-lived signed URL or Referer check later.
//
// Returns 404 when Cardsight 404s (parallel ids share the base card
// image and aren't served directly; the caller is expected to use the
// base cardId from search / detail). Returns 504 on upstream timeout.
router.get("/card-image/:cardId", async (req, res, next) => {
  try {
    const cardId = req.params.cardId;
    if (!cardId || !CARDSIGHT_CARD_ID_RE.test(cardId)) {
      return res.status(400).json({ success: false, error: "Invalid cardId" });
    }
    const result = await getCardImage(cardId);
    if (result.notFound) {
      return res.status(404).json({ success: false, error: "Image not found" });
    }
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Length", String(result.bytes.length));
    return res.status(200).send(result.bytes);
  } catch (err) {
    if (isCardsightTimeoutError(err)) {
      return res.status(504).json({ success: false, error: "Upstream timeout" });
    }
    next(err);
  }
});

// CF-SEARCH-SUGGEST (2026-06-12): GET /api/compiq/suggest
// Thin proxy to Cardsight autocomplete for iOS search-box typeahead.
// Public route (matches /cardsearch posture) — fires on every keystroke;
// auth-gating would just shift the freeze elsewhere.
//
// Contract:
//   • q < 3 chars after normalization → 200 { suggestions: [] }, no vendor call
//   • take default 8, cap 10
//   • vendor failure (timeout, 5xx, weird shape) → 200 { suggestions: [] }
//   • in-process Map cache, 120s TTL, key = `${normalizedQ}:${take}`
const SUGGEST_MIN_CHARS = 3;
const SUGGEST_DEFAULT_TAKE = 8;
const SUGGEST_MAX_TAKE = 10;
const SUGGEST_CACHE_TTL_MS = 120_000;
const suggestCache = new Map<string, { suggestions: string[]; expiresAt: number }>();

router.get("/suggest", async (req, res, next) => {
  try {
    const rawQ = typeof req.query.q === "string" ? req.query.q : "";
    const normalizedQ = rawQ.trim().toLowerCase();

    const rawTake = typeof req.query.take === "string" ? parseInt(req.query.take, 10) : NaN;
    const take =
      Number.isFinite(rawTake) && rawTake > 0
        ? Math.min(rawTake, SUGGEST_MAX_TAKE)
        : SUGGEST_DEFAULT_TAKE;

    if (normalizedQ.length < SUGGEST_MIN_CHARS) {
      return res.status(200).json({ query: normalizedQ, suggestions: [] });
    }

    const cacheKey = `${normalizedQ}:${take}`;
    const now = Date.now();
    const cached = suggestCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      console.log(
        JSON.stringify({
          event: "suggest_cache_hit",
          source: "compiq.routes",
          subsystem: "cardsight",
          q: normalizedQ,
          take,
          n: cached.suggestions.length,
        }),
      );
      return res.status(200).json({ query: normalizedQ, suggestions: cached.suggestions });
    }

    console.log(
      JSON.stringify({
        event: "suggest_cache_miss",
        source: "compiq.routes",
        subsystem: "cardsight",
        q: normalizedQ,
        take,
      }),
    );

    let suggestions: string[] = [];
    try {
      suggestions = await autocompleteCards(normalizedQ, { take });
    } catch {
      suggestions = [];
    }

    suggestCache.set(cacheKey, {
      suggestions,
      expiresAt: now + SUGGEST_CACHE_TTL_MS,
    });

    return res.status(200).json({ query: normalizedQ, suggestions });
  } catch (err) {
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
          // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
          // thin/null branch — no post-filter sub-market pool to derive
          // last-sale from, so the trend-extrapolated path can't fire
          // either. All three null.
          lastSale: null,
          estimateSource: null,
          // CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27): surface the
          // trend-aware sub-blocks + CH comp count on every response
          // shape. Always emit the keys (null when helper didn't fire)
          // so the iOS decoder has a stable contract — same writeback-
          // clear pattern as the persistence layer.
          modelExpectation: (est as any).modelExpectation ?? null,
          modelSignal: (est as any).modelSignal ?? null,
          chCompCount: (est as any).chCompCount ?? null,
          estimatedValue: null,
          estimateRange: null,
          estimateBasis: null,
          // CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27): always
          // emit the gradedEstimates rail so the iOS decoder has a stable
          // contract. Thin-null branches emit empty array; full-priced
          // branches below emit the compileGradedEstimatesForCard result.
          gradedEstimates: [],
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
      // CF-MARKETVALUE-HONESTY (2026-06-09): swap from the legacy
      // isThinFromEst (thin SOURCES only) to cannotPriceFromEst (also
      // catches the LIVE-source-but-pipeline-couldn't-anchor cases:
      // FMV ≤ 0, coverage=no_card, compsUsed<3). The variable name is
      // preserved so downstream reads stay legible — the contract
      // ("hide price tiers + emit null on this field set") is
      // unchanged; the predicate is just stricter.
      const isThin = cannotPriceFromEst(est);
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

      // CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27): mirror the
      // gradedEstimates assembly already shipping on /price-by-id so
      // /search responses carry the same rail data. Uses the same helpers
      // (getPricingForMarketRead → buildGradeBreakdown →
      // compileGradedEstimatesForCard). Failure is non-fatal: assembly
      // throws → caught + logged → empty array. Response shape stays
      // stable regardless. parallelId=null because /search resolves card
      // identity from the parsed query, not a UUID — base-scope rail.
      let gradedEstimates: GradedProjectionResult[] = [];
      // CF-CARDIDENTITY-FIELD-CASE-FIX (2026-06-29): engine emits
      // `cardIdentity: { card_id: ... }` (snake_case) at
      // compiqEstimate.service.ts line 3532; prior code read
      // `cardIdentity?.cardId` (camelCase) which was ALWAYS undefined,
      // so this block was a no-op for /search since CF-CH-RESPONSE-
      // SURFACE-GRADED-ESTIMATES shipped on 2026-06-27. Silent for ~2
      // days — iOS rail rendered empty on /search even when the card
      // had populated graded estimates. Same fix applied to /price below.
      const cardIdForGraded = (est as any).cardIdentity?.card_id;
      if (typeof cardIdForGraded === "string" && cardIdForGraded.length > 0) {
        try {
          const pricingForMR = await getPricingForMarketRead(cardIdForGraded);
          if (pricingForMR && !pricingForMR.notFound) {
            const gradeBreakdown = buildGradeBreakdown(pricingForMR, null);
            const compiled = await compileGradedEstimatesForCard({
              pricing: pricingForMR,
              estimate: est as any,
              parallelId: null,
              parallelName: parsed.parallel ?? null,
              isRawScope: false,
              isThinMarket: isThin,
              gradeBreakdown,
              source: "compiq.search",
              cardId: cardIdForGraded,
            });
            gradedEstimates = compiled.estimates;
          }
        } catch (err) {
          console.warn(
            `[compiq.search] gradedEstimates assembly failed (non-fatal): ${(err as Error)?.message ?? err}`,
          );
        }
      }

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
        // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
        // mirror the service's record + source signal so iOS can
        // render "last sold $X, N ago" or "Estimated $X (range Y–Z)
        // — based on the last sale N ago, adjusted for the set's
        // recent trend." estimateSource discriminates between
        // "observed" / "trend-extrapolated" / "last-sale" / null.
        lastSale: (est as any).lastSale ?? null,
        estimateSource: (est as any).estimateSource ?? null,
        // CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27): surface the
        // trend-aware sub-blocks + CH comp count. Always emit the keys
        // (null when helper didn't fire) so the iOS decoder has a stable
        // contract — same writeback-clear pattern as the persistence layer.
        modelExpectation: (est as any).modelExpectation ?? null,
        modelSignal: (est as any).modelSignal ?? null,
        chCompCount: (est as any).chCompCount ?? null,
        estimatedValue: (est as any).estimatedValue ?? null,
        estimateRange: (est as any).estimateRange ?? null,
        estimateBasis: (est as any).estimateBasis ?? null,
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
        // CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27): emit the
        // gradedEstimates rail symmetric with /price-by-id. Empty array
        // when the assembly produced none; always present so iOS decoder
        // contract is stable.
        gradedEstimates,
      };
    }, CACHE_TTL_SECONDS);
    // CF-CH-TELEMETRY-OUTSIDE-CACHE (2026-06-28): fire on EVERY response
    // (cache hit + miss) by reading from `result` instead of nesting
    // inside the producer. The route is cacheWrapped at 6h TTL — a hit
    // bypasses the producer entirely, so the in-producer call we shipped
    // in #161 only fired on cache misses (~1 in N). Cache itself caches
    // CH calls inside recordCHReferenceTelemetry (12h getCardFmv +
    // getPriceEstimate + getSalesStatsByPlayer), so emitting on every
    // cache hit doesn't multiply CH traffic — it just lets the App
    // Insights event flow through on every priced response.
    recordCHReferenceTelemetry({
      source: "compiq.search",
      // CF-CARDIDENTITY-FIELD-CASE-FIX (2026-06-29): cardIdentity emits
      // `card_id` snake_case; prior `cardId` was always undefined.
      cardId: ((result as any).cardIdentity?.card_id as string | undefined) ?? null,
      player: ((result as any).cardIdentity?.player as string | undefined) ?? null,
      gradingCompany: null,
      gradeValue: null,
      engineFmv:
        typeof (result as any).fairMarketValueLive === "number"
          ? ((result as any).fairMarketValueLive as number)
          : null,
    });
    // CF-PLAYER-MOMENTUM-THIN-COMP-PROJECTION observational telemetry —
    // runs alongside recordCHReferenceTelemetry, gated by the same flag
    // that later drives pricing.
    recordMomentumProjectionEvaluated({
      source: "compiq.search",
      cardId: ((result as any).cardIdentity?.card_id as string | undefined) ?? null,
      player: ((result as any).cardIdentity?.player as string | undefined) ?? null,
      result: result as Record<string, unknown>,
    });
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
      let est = await computeEstimate(body, {
        source: "compiq-price-freetext",
        userId: null,
        holdingId: null,
        routedFromHolding: false,
      });

      // CF-PRICE-AI-MATCHER-FALLBACK (2026-07-02): free-text catalog-miss
      // hardening. computeEstimate's fetchComps uses a token-based search
      // + subset filter; that path silently misses cards whose autograph
      // SKU uses a non-CPA prefix (verified against CH: 2025 Bowman Paul
      // Skenes auto is HSA-PS, Dylan Crews RRA-DC, Jackson Holliday
      // PRV-JH, none of which the token search reliably surfaces). For
      // real prospects the batch failure rate on
      //   "2025 Bowman <name> Auto"
      // was 75% (12/16) even though CH's AI matcher /cards/card-match
      // resolves the same queries at 0.96 confidence.
      //
      // Fix: on catalog-miss (never the pinned-id branch, which is
      // definitionally "no-recent-comps" not a miss), ask CH's AI
      // matcher for a card_id. If it returns a high-confidence match
      // (>= 0.85) AND the parser had enough signal to trust the query
      // (>= 0.5 confidence), re-run the estimator pinned to that
      // card_id. The pinned-id branch trusts the ID and skips fetchComps'
      // free-text step, so cards CH can identify but our token search
      // can't find get priced correctly.
      //
      // Worst case: pinned-id retry yields no-recent-comps (still
      // cardIdentity-populated), which is a strictly better UX than
      // "catalog-miss" (users see "we found the card, no recent sales"
      // vs "we couldn't find this card in our catalog").
      // CF-PRICE-FALLBACK-LAYER-1 (2026-07-02): trigger the AI-matcher
      // fallback on BOTH catalog-miss AND (no-recent-comps + 0 comps).
      // Original #250 only fired on catalog-miss, so queries like
      // "2024 Bowman Chrome Paul Skenes Auto" (initial estimator found
      // A card but zero comps, source=no-recent-comps) never got the
      // fallback even when the AI matcher could resolve to a better
      // card_id with real sales. Widening the trigger closes that gap.
      const estCompsAvail =
        typeof (est as { compsAvailable?: unknown }).compsAvailable === "number"
          ? ((est as { compsAvailable: number }).compsAvailable)
          : null;
      const triggerFallback =
        !body.cardId &&
        parsed.confidence >= 0.5 &&
        (est.source === "catalog-miss" ||
          (est.source === "no-recent-comps" && estCompsAvail === 0));
      if (triggerFallback) {
        try {
          let aiMatch = await identifyCard(query);
          let conf =
            aiMatch && typeof (aiMatch as { confidence?: unknown }).confidence === "number"
              ? ((aiMatch as { confidence: number }).confidence)
              : 0;
          let broaderYearUsed = false;

          // CF-PRICE-FALLBACK-LAYER-3 (2026-07-02): broader-year retry.
          // When the initial AI match returns nothing (or below the 0.85
          // confidence floor), the user's stated year may not exist as
          // an auto SKU for that player (real observed cases: Ethan
          // Salas 2025 Bowman Auto → no 2025, but 2023/2024 Bowman
          // Chrome autos exist; same shape for Roman Anthony, Cam
          // Smith, Termarr Johnson, Junior Caminero). Strip the year
          // from the query and retry — if the broader match clears the
          // confidence floor, use it. Attribution surfaces that we
          // used a year-broadened lookup so downstream corpus + iOS UX
          // can flag the year mismatch.
          if ((!aiMatch || conf < 0.85) && /\b(19|20)\d{2}\b/.test(query)) {
            const yearStripped = query
              .replace(/\b(19|20)\d{2}\b/g, "")
              .replace(/\s+/g, " ")
              .trim();
            if (yearStripped.length > 0 && yearStripped !== query.trim()) {
              try {
                const broaderMatch = await identifyCard(yearStripped);
                const broaderConf =
                  broaderMatch && typeof (broaderMatch as { confidence?: unknown }).confidence === "number"
                    ? ((broaderMatch as { confidence: number }).confidence)
                    : 0;
                if (broaderMatch && broaderMatch.card_id && broaderConf >= 0.85) {
                  console.log(
                    JSON.stringify({
                      event: "price_broader_year_match",
                      source: "compiq.routes",
                      originalQuery: query,
                      broadenedQuery: yearStripped,
                      broaderMatchCardId: broaderMatch.card_id,
                      broaderMatchConfidence: broaderConf,
                      broaderMatchNumber: (broaderMatch as { number?: string }).number ?? null,
                    }),
                  );
                  aiMatch = broaderMatch;
                  conf = broaderConf;
                  broaderYearUsed = true;
                }
              } catch {
                // absorb; keep primary result
              }
            }
          }

          if (aiMatch && aiMatch.card_id && conf >= 0.85) {
            console.log(
              JSON.stringify({
                event: "price_ai_matcher_fallback",
                source: "compiq.routes",
                originalQuery: query,
                originalEstSource: est.source,
                originalCompsAvailable: estCompsAvail,
                aiMatchCardId: aiMatch.card_id,
                aiMatchConfidence: conf,
                aiMatchNumber: (aiMatch as { number?: string }).number ?? null,
                broaderYearUsed,
              }),
            );
            const pinnedBody: CompIQEstimateRequest = {
              ...body,
              cardId: aiMatch.card_id,
            };
            est = await computeEstimate(pinnedBody, {
              source: "compiq-price-ai-matched",
              userId: null,
              holdingId: null,
              routedFromHolding: false,
            });

            // CF-PRICE-FALLBACK-LAYER-1 (2026-07-02): enrich cardIdentity
            // from the AI-match metadata so iOS can render "we found
            // <player> <year> <set> <number>" even when the pinned
            // lookup yields no-recent-comps (empty cardIdentity is
            // useless — the whole point of surfacing the resolved SKU
            // is telling the user which card the engine identified).
            const aiPlayer = (aiMatch as { player?: string }).player ?? null;
            const aiSet = (aiMatch as { set?: string }).set ?? null;
            const aiNumber = (aiMatch as { number?: string }).number ?? null;
            const aiVariant = (aiMatch as { variant?: string }).variant ?? null;
            const aiDescription = (aiMatch as { description?: string }).description ?? null;
            const aiYearMatch = aiSet ? aiSet.match(/\b(19|20)\d{2}\b/) : null;
            const aiYear = aiYearMatch ? Number(aiYearMatch[0]) : null;
            const enriched = {
              card_id: aiMatch.card_id,
              title: aiDescription,
              player: aiPlayer,
              set: aiSet,
              release: aiSet,
              year: aiYear,
              number: aiNumber,
              variant: aiVariant,
            };
            const existing =
              (est as { cardIdentity?: unknown }).cardIdentity &&
              typeof (est as { cardIdentity?: unknown }).cardIdentity === "object"
                ? ((est as { cardIdentity: Record<string, unknown> }).cardIdentity)
                : {};
            (est as { cardIdentity?: unknown }).cardIdentity = {
              ...existing,
              ...enriched,
            };
          }
        } catch {
          // Fallback is best-effort — swallow errors and return the
          // original result untouched.
        }
      }

      // CF-PRICE-AUTO-PROJECTION-HELPERS (2026-07-02): Layer 2 + Layer 4
      // are now shared with /price-by-id via applyAutoProjectionFallbacks
      // at module scope. The helper checks the same trigger (no-recent-
      // comps + auto prefix) and mutates est with sibling_auto_latest_
      // x_trend (Layer 4) OR base_x_auto_premium (Layer 2 fallback).
      await applyAutoProjectionFallbacks(est as Record<string, unknown>, query);


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
          // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
          // thin/null branch — no post-filter sub-market pool to derive
          // last-sale from, so the trend-extrapolated path can't fire
          // either. All three null.
          lastSale: null,
          estimateSource: null,
          // CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27): surface the
          // trend-aware sub-blocks + CH comp count on every response
          // shape. Always emit the keys (null when helper didn't fire)
          // so the iOS decoder has a stable contract — same writeback-
          // clear pattern as the persistence layer.
          modelExpectation: (est as any).modelExpectation ?? null,
          modelSignal: (est as any).modelSignal ?? null,
          chCompCount: (est as any).chCompCount ?? null,
          estimatedValue: null,
          estimateRange: null,
          estimateBasis: null,
          // CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27): always
          // emit the gradedEstimates rail so the iOS decoder has a stable
          // contract. Thin-null branches emit empty array; full-priced
          // branches below emit the compileGradedEstimatesForCard result.
          gradedEstimates: [],
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
      // CF-MARKETVALUE-HONESTY (2026-06-09): swap from the legacy
      // isThinFromEst (thin SOURCES only) to cannotPriceFromEst (also
      // catches the LIVE-source-but-pipeline-couldn't-anchor cases:
      // FMV ≤ 0, coverage=no_card, compsUsed<3). The variable name is
      // preserved so downstream reads stay legible — the contract
      // ("hide price tiers + emit null on this field set") is
      // unchanged; the predicate is just stricter.
      const isThin = cannotPriceFromEst(est);
      const approximate = approximateFromEst(est);
      const variantWarning: string[] = (est as any).variantWarning ?? [];
      const hasWarn = variantWarning.length > 0;
      const baseSummary = est.verdict ?? "Estimate based on available market data.";
      const summary = hasWarn
        ? `No exact match for requested variant (missing: ${variantWarning.join(", ")}). Showing closest available comp. ${baseSummary}`
        : baseSummary;
      const finalConfidence = hasWarn ? Math.min(confidence, 0.45) : confidence;

      // CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27): mirror the
      // gradedEstimates assembly already shipping on /price-by-id so /price
      // responses carry the same rail data. parallelId=null because /price
      // (like /search) resolves card identity from the parsed query, not a
      // UUID — base-scope rail. Failure is non-fatal.
      let gradedEstimates: GradedProjectionResult[] = [];
      // CF-CARDIDENTITY-FIELD-CASE-FIX (2026-06-29): same field-case
      // bug as /search above — engine emits `card_id` (snake_case) but
      // the prior code read `cardId` (camelCase). Always undefined →
      // /price never populated gradedEstimates for ~2 days.
      const cardIdForGraded = (est as any).cardIdentity?.card_id;
      if (typeof cardIdForGraded === "string" && cardIdForGraded.length > 0) {
        try {
          const pricingForMR = await getPricingForMarketRead(cardIdForGraded);
          if (pricingForMR && !pricingForMR.notFound) {
            const gradeBreakdown = buildGradeBreakdown(pricingForMR, null);
            const compiled = await compileGradedEstimatesForCard({
              pricing: pricingForMR,
              estimate: est as any,
              parallelId: null,
              parallelName: parsed.parallel ?? null,
              isRawScope: false,
              isThinMarket: isThin,
              gradeBreakdown,
              source: "compiq.price",
              cardId: cardIdForGraded,
            });
            gradedEstimates = compiled.estimates;
          }
        } catch (err) {
          console.warn(
            `[compiq.price] gradedEstimates assembly failed (non-fatal): ${(err as Error)?.message ?? err}`,
          );
        }
      }

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
        // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
        // mirror the service's record + source signal so iOS can
        // render "last sold $X, N ago" or "Estimated $X (range Y–Z)
        // — based on the last sale N ago, adjusted for the set's
        // recent trend." estimateSource discriminates between
        // "observed" / "trend-extrapolated" / "last-sale" / null.
        lastSale: (est as any).lastSale ?? null,
        estimateSource: (est as any).estimateSource ?? null,
        // CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27): surface the
        // trend-aware sub-blocks + CH comp count. Always emit the keys
        // (null when helper didn't fire) so the iOS decoder has a stable
        // contract — same writeback-clear pattern as the persistence layer.
        modelExpectation: (est as any).modelExpectation ?? null,
        modelSignal: (est as any).modelSignal ?? null,
        chCompCount: (est as any).chCompCount ?? null,
        estimatedValue: (est as any).estimatedValue ?? null,
        estimateRange: (est as any).estimateRange ?? null,
        estimateBasis: (est as any).estimateBasis ?? null,
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
        // CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27): emit the
        // gradedEstimates rail symmetric with /price-by-id. Empty array
        // when the assembly produced none; always present so iOS decoder
        // contract is stable.
        gradedEstimates,
      };
    }, CACHE_TTL_SECONDS);
    // CF-CH-TELEMETRY-OUTSIDE-CACHE (2026-06-28): see /search for rationale.
    recordCHReferenceTelemetry({
      source: "compiq.price",
      // CF-CARDIDENTITY-FIELD-CASE-FIX (2026-06-29): see /search above.
      cardId: ((result as any).cardIdentity?.card_id as string | undefined) ?? null,
      player: ((result as any).cardIdentity?.player as string | undefined) ?? null,
      gradingCompany: null,
      gradeValue: null,
      engineFmv:
        typeof (result as any).fairMarketValueLive === "number"
          ? ((result as any).fairMarketValueLive as number)
          : null,
    });
    recordMomentumProjectionEvaluated({
      source: "compiq.price",
      cardId: ((result as any).cardIdentity?.card_id as string | undefined) ?? null,
      player: ((result as any).cardIdentity?.player as string | undefined) ?? null,
      result: result as Record<string, unknown>,
    });
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
//                                     Request body wire key: cardId.
//
// `/api/compiq/search-list` was the legacy CardHedge-shape picker endpoint.
// **Deleted** in this commit per Phase 1 caller grep (no runtime consumers
// outside the route itself; only doc references remained). iOS picker as
// currently deployed uses /api/compiq/cardsearch; W5-iOS rebuilds it
// against UnifiedSearchResponse.
// ---------------------------------------------------------------------------

// CF-PAYMENTS-B1: standalone FMV user-initiated check.
// CF-COMPIQ-PER-GRADE-BREAKDOWN (2026-07-01): return per-grade comp
// breakdown for a card. iOS renders as a grade picker on the card
// detail — user sees live comps for grades that have them + projected
// prices for grades that don't. See services/compiq/perGradeBreakdown.
router.post("/card-grades", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  try {
    const { cardId, cardYear, isAutograph } = req.body || {};
    if (!cardId || typeof cardId !== "string" || !cardId.trim()) {
      return res.status(400).json({ success: false, error: 'Missing or invalid "cardId" field' });
    }
    const { computeCardGradesBreakdown } = await import(
      "../services/compiq/perGradeBreakdown.service.js"
    );
    const result = await computeCardGradesBreakdown(cardId.trim(), {
      cardYear: typeof cardYear === "number" ? cardYear : null,
      isAutograph: typeof isAutograph === "boolean" ? isAutograph : false,
    });
    res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/price-by-id", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { cardId, query, gradeCompany, gradeValue, parallelId, parallelName, parallel } =
      req.body || {};

    // CF-CARDID-RENAME (2026-06-30): accept the legacy `cardsightCardId`
    // field for back-compat with iOS clients that haven't migrated yet.
    // Prefer the new field when both are present; iOS sends one or the
    // other, never both. Drop in a future CF once iOS minimum supported
    // version emits only `cardId`.
    const legacyCardId =
      typeof (req.body as any)?.cardsightCardId === "string" && (req.body as any).cardsightCardId.length > 0
        ? (req.body as any).cardsightCardId
        : null;
    const resolvedCardId =
      typeof cardId === "string" && cardId.length > 0
        ? cardId
        : legacyCardId;
    if (!resolvedCardId) {
      return res.status(400).json({ success: false, error: 'Missing "cardId" field' });
    }

    // CF-PARALLEL-AWARE-VALUE (2026-06-09): UUID-shape validation on
    // the optional parallelId. Reject malformed ids at the route layer
    // so downstream code can trust the shape. parallelName is purely
    // informational; no validation beyond string type.
    let resolvedParallelId: string | undefined;
    if (parallelId !== undefined && parallelId !== null) {
      if (typeof parallelId !== "string" || !CARDSIGHT_CARD_ID_RE.test(parallelId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid "parallelId" — must be UUID-shape' });
      }
      resolvedParallelId = parallelId;
    }
    // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): accept either `parallelName`
    // (the legacy iOS field, informational) OR `parallel` (the
    // queryContext field the title-match recovery needs). parallelName
    // takes precedence so existing iOS callers keep their wire shape.
    const resolvedParallelName =
      typeof parallelName === "string" && parallelName.length > 0
        ? parallelName
        : typeof parallel === "string" && parallel.length > 0
        ? parallel
        : undefined;

    const cacheKey = normalizeCacheKey(
      "compiq:price-by-id:v4",
      // parallelId on the cache key so a Gold parallel and a base sit
      // at separate entries. Empty string when absent — matches the
      // "base only" semantics of the filter.
      `${resolvedCardId}|${gradeCompany ?? ""}${gradeValue ?? ""}|${resolvedParallelId ?? ""}`,
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
        cardId: resolvedCardId,
        gradeCompany: typeof gradeCompany === "string" ? gradeCompany : undefined,
        gradeValue: typeof gradeValue === "number" ? gradeValue : undefined,
        // CF-PARALLEL-AWARE-VALUE (2026-06-09)
        parallelId: resolvedParallelId,
        parallelName: resolvedParallelName,
        // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): also thread
        // parallelName into `body.parallel`. The downstream queryContext
        // (compiqEstimate.service.ts:2273) reads `body.parallel` —
        // `body.parallelName` is documented as "informational only —
        // not part of any filter decision" (compiq.types.ts:42-45). The
        // pinned-id branch's title-match recovery needs a string to
        // match against, so without this the recovery sees
        // userParallelInput="" and collapses to "unified-no-parallel"
        // regardless of how good the unified pool is. Verified live on
        // 2026-06-11: SHA dfc81fe deployed, probes A+B returned
        // "unified-no-parallel"; recovery log confirmed parallel="".
        parallel: resolvedParallelName,
      };
      // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): /api/compiq/price-by-id
      // pins to a Cardsight UUID. Public route, no auth context.
      const est = await computeEstimate(body, {
        source: "compiq-price-by-id",
        userId: null,
        holdingId: null,
        routedFromHolding: false,
      });

      // CF-PRICE-BY-ID-AUTO-PROJECTION-FALLBACKS (2026-07-02): apply
      // Layer 4 (sibling auto latest × trend) → Layer 2 (base × auto
      // multiplier) when the pinned card has 0 recent comps AND is an
      // autograph. Same behavior /price gets via the shared helper.
      // Layer 1 / Layer 3 (AI-matcher + broader-year retry) are NOT
      // applicable here — the card is already pinned.
      const priceByIdQueryHint =
        typeof query === "string" && query.trim().length > 0
          ? query.trim()
          : `cardId:${resolvedCardId}`;

      // CF-PRICE-BY-ID-CARDIDENTITY-ENRICHMENT (2026-07-02): the pinned
      // path's cardIdentity is minimal by design — the engine returns
      // { card_id, player: card_id_string, set: null, year: null,
      // number: null, variant: null } for the /price-by-id branch, and
      // the shared projection helper requires populated player/year/
      // number to fire the trigger. Fetch card-details via CH and merge
      // real metadata into est.cardIdentity so the helper can see the
      // autograph prefix and same-year sibling/base candidates.
      const priceByIdEstSource =
        typeof (est as { source?: unknown }).source === "string"
          ? ((est as { source: string }).source)
          : null;
      const priceByIdCompsAvail =
        typeof (est as { compsAvailable?: unknown }).compsAvailable === "number"
          ? ((est as { compsAvailable: number }).compsAvailable)
          : null;
      if (priceByIdEstSource === "no-recent-comps" && priceByIdCompsAvail === 0) {
        try {
          const chCard = await getCardDetailsById(resolvedCardId);
          if (chCard) {
            const chSet = typeof chCard.set === "string" ? chCard.set : null;
            const chYearMatch = chSet ? chSet.match(/\b(19|20)\d{2}\b/) : null;
            const chYear = chYearMatch ? Number(chYearMatch[0]) : null;
            const existing =
              (est as { cardIdentity?: unknown }).cardIdentity &&
              typeof (est as { cardIdentity?: unknown }).cardIdentity === "object"
                ? ((est as { cardIdentity: Record<string, unknown> }).cardIdentity)
                : {};
            (est as { cardIdentity?: unknown }).cardIdentity = {
              ...existing,
              card_id: resolvedCardId,
              player: chCard.player ?? existing.player ?? null,
              set: chSet ?? existing.set ?? null,
              year: chYear ?? existing.year ?? null,
              number: chCard.number ?? existing.number ?? null,
              variant: chCard.variant ?? existing.variant ?? null,
              title:
                (typeof chCard.title === "string" ? chCard.title : null) ??
                existing.title ??
                null,
            };
          }
        } catch {
          // Enrichment best-effort; helper will simply no-op if cardIdentity
          // stays sparse.
        }
      }
      await applyAutoProjectionFallbacks(est as Record<string, unknown>, priceByIdQueryHint);

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
          cardId: resolvedCardId,
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
          // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
          // thin/null branch — no post-filter sub-market pool to derive
          // last-sale from, so the trend-extrapolated path can't fire
          // either. All three null.
          lastSale: null,
          estimateSource: null,
          // CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27): surface the
          // trend-aware sub-blocks + CH comp count on every response
          // shape. Always emit the keys (null when helper didn't fire)
          // so the iOS decoder has a stable contract — same writeback-
          // clear pattern as the persistence layer.
          modelExpectation: (est as any).modelExpectation ?? null,
          modelSignal: (est as any).modelSignal ?? null,
          chCompCount: (est as any).chCompCount ?? null,
          estimatedValue: null,
          estimateRange: null,
          estimateBasis: null,
          broaderTrend: null,
          // CF-GRADED-PRICE-PROJECTION Phase 2 — empty on unsupported_sport
          // (no pricing payload to estimate from). Field present for shape
          // stability across all branches.
          gradedEstimates: [],
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
      // CF-MARKETVALUE-HONESTY (2026-06-09): swap from the legacy
      // isThinFromEst (thin SOURCES only) to cannotPriceFromEst (also
      // catches the LIVE-source-but-pipeline-couldn't-anchor cases:
      // FMV ≤ 0, coverage=no_card, compsUsed<3). The variable name is
      // preserved so downstream reads stay legible — the contract
      // ("hide price tiers + emit null on this field set") is
      // unchanged; the predicate is just stricter.
      const isThin = cannotPriceFromEst(est);
      const approximate = approximateFromEst(est);

      // CF-PLAYER-IN-SET-HISTORY (2026-06-09): fire-and-forget seed
      // the (player, release, year) tuple to the nightly compute
      // queue. The nightly fn-comps-momentum extension walks this
      // queue and writes per-(player, release, year) snapshots +
      // appends to a history file. Every card priced via /price-by-id
      // queues its tuple, so the history covers any player iOS has
      // actually touched — not just the 5-player tracked-list
      // default. Best-effort; a throw is swallowed inside the
      // service.
      //
      // CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): the tuple is keyed
      // by (player, RELEASE, year) — NOT (player, set, year). The
      // Cardsight subset name "Base Set" collides across products;
      // the release/product line ("Bowman Draft", "Topps Update") is
      // the unique scope. Skip the enqueue when release or year is
      // missing — the nightly can't form a unique storage key
      // without both, and a malformed entry would be dropped anyway.
      const identityForSeed = (est as any).cardIdentity;
      if (
        identityForSeed?.player
        && identityForSeed?.release
        && typeof identityForSeed.year === "number"
        && identityForSeed.year > 0
      ) {
        void enqueuePlayerSetTuple({
          player: identityForSeed.player,
          release: identityForSeed.release,
          year: identityForSeed.year,
        });
      }

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
      // CF-CARDHEDGE-CARD-IMAGE (2026-06-30): Cardsight is decommissioned and
      // the `/api/compiq/card-image/:id` proxy it backed always 404s. CardHedge
      // surfaces a public bubble.io CDN image per card, stashed on the
      // RoutedCard meta by the preceding search (cardsight.router.cacheCardMeta).
      // Pull it directly — iOS loads the CDN URL with no proxy needed. Falls
      // back to undefined on a cold-cache miss (iOS then renders the neutral
      // placeholder), and `cardImageThumbUrl` below still provides the eBay
      // most-recent-comp secondary.
      const cardMetaForImage = await getCardMetaById(resolvedCardId);
      let cardImageUrl: string | undefined = cardMetaForImage?.imageUrl ?? undefined;
      let cardImageThumbUrl: string | undefined;
      // CF-GRADE-BREAKDOWN (2026-06-09): per-graded-bucket menu off the
      // same cached cs:pricing payload — zero new Cardsight ops.
      // Filtered through the same parallelId guard so a Gold-parallel
      // request sees Gold counts/medians per grade tier (not the
      // base-mixed pool).
      let gradeBreakdown: GradeBreakdownEntry[] = [];
      // Hoisted so the CF-GRADED-PRICE-PROJECTION Phase 2 block below can
      // reuse the same fetched payload without a second cache lookup.
      let pricingForMR: Awaited<ReturnType<typeof getPricingForMarketRead>> | null = null;
      try {
        pricingForMR = await getPricingForMarketRead(resolvedCardId);
        if (!pricingForMR.notFound) {
          const gradeKey =
            body.gradeCompany && body.gradeValue !== undefined
              ? `${body.gradeCompany} ${body.gradeValue}`
              : "Raw";
          // CF-FACTPACK-SUB-MARKET-ISOLATION (2026-06-10): pass parallelId
          // so the fact-pack pool derives from the SAME post-filter set
          // (selectSalesByGrade → filterRecordsByParallel) as the value
          // path. Previously this call omitted parallelId, so a Gold
          // parallel response had fmv=null (post-filter) alongside
          // binMedian=$450 (pre-filter base figure).
          marketReadResult = await generateMarketRead(
            pricingForMR,
            gradeKey,
            est as Record<string, unknown>,
            resolvedCardId,
            resolvedParallelId ?? null,
          );
          cardImageThumbUrl = pickCardImageUrl(
            pricingForMR,
            gradeKey,
            marketReadResult?.factPack?.binMedian ?? null,
          );
          gradeBreakdown = buildGradeBreakdown(pricingForMR, resolvedParallelId ?? null);
        }
      } catch (err) {
        console.warn(
          `[compiq.price-by-id] marketRead build failed (non-fatal): ${(err as Error)?.message ?? err}`,
        );
        marketReadResult = null;
        cardImageThumbUrl = undefined;
        gradeBreakdown = [];
      }

      // CF-GRADED-PRICE-PROJECTION Phase 2 (2026-06-13): graded estimates.
      // Calls the engine on the same cs:pricing payload already in hand.
      // Grounded-only filter ("gaps honest"): only ratioSource ∈
      // {card, player-set} grades survive; tier-3 market-table "ballpark"
      // estimates are dropped so we never put a generic number on the wire
      // for a card without grounded data. Parallel scope passes through
      // resolvedParallelId/Name + the observed parallel raw FMV (only when
      // gradeKey is "Raw" — else `fmv` would be the parallel's PSA 10/
      // SGC 10/etc. median, not the raw anchor the engine wants). Tier 2
      // is currently no-op pending CF-1c (graded-capable sibling source).
      //
      // NO-MUTATION GUARD: buildGradedEstimates snapshots pricingForMR +
      // marketTier.value + recentComps + gradeBreakdown before the engine
      // call and asserts byte-identical after. On mismatch: estimates=[],
      // mutationDetected=true (logged here). Structural firewall in
      // gradedEstimates ≠ gradeBreakdown: gradeBreakdown stays purely
      // observed (real, trainable); gradedEstimates is purely estimated
      // (display-not-train, fairMarketValue=null per result).
      // CF-COMPILE-GRADED-ESTIMATES (2026-06-14): assembly extracted to
      // compileGradedEstimatesForCard so autoPriceHolding can reuse the
      // same canonical path. Helper traps internal errors → returns
      // { estimates: [], mutationDetected: false }; no outer try/catch
      // needed here.
      //
      // CF-DECOUPLE-RAIL-SCOPE (2026-06-12): the gradedEstimates rail
      // ALWAYS assembles in graded scope (isRawScope=false), regardless
      // of whether the request's top-level scope is raw or graded.
      // Pre-CF, the rail inherited isRawScope from body.gradeCompany +
      // body.gradeValue presence, which meant a raw-scope request
      // returned a raw-anchored rail (PSA 9 $1,200 for Leo Blue) that
      // didn't match what autoPriceHolding stores ($1,400 graded-scope
      // for the same holding). iOS rail render couldn't get
      // holding-matching gradedEstimates without ALSO flipping
      // top-level (marketTier / recentComps / trend / history /
      // strategy) into graded scope.
      //
      // Now the rail is invariant to top-level scope: it always anchors
      // on the parallel-COMPOSED value (base raw × multiplier) for
      // parallel-scope requests, and on the base raw median for
      // base-scope requests. Top-level fields keep honoring the
      // request's grade fields — unchanged. iOS can render a holding-
      // matching rail next to a raw-scope comp card in one request.
      let gradedEstimates: GradedProjectionResult[] = [];
      if (pricingForMR && !pricingForMR.notFound) {
        const compiled = await compileGradedEstimatesForCard({
          pricing: pricingForMR,
          estimate: est as {
            fairMarketValue?: number | null;
            lastSale?: { price?: number | null } | null;
            daysSinceNewestComp?: number | null;
            recentComps?: ReadonlyArray<unknown>;
            trendIQ?: import("../services/compiq/trendIQ.types.js").TrendIQResult | null;
            // CF-CH-GRADED-FROM-COMPOSED-ANCHOR (2026-06-28): Build B's
            // composed raw FMV. Helper falls back to this anchor when fmv
            // (observed) and lastSale.price are both null on thin parallels
            // — without it, gradedEstimates was empty for Hartman Blue
            // X-Fractor / Speckle Refractor / etc.
            estimatedValue?: number | null;
          },
          parallelId: resolvedParallelId ?? null,
          parallelName: resolvedParallelName ?? null,
          isRawScope: false,
          isThinMarket: isThin,
          gradeBreakdown,
          source: "compiq.price-by-id",
          cardId: resolvedCardId,
        });
        gradedEstimates = compiled.estimates;
      }

      return {
        ...buildEngineMeta(),
        success: true,
        cardId: resolvedCardId,
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
        // CF-PRICEHISTORY-60D (2026-06-10): 60d comp-page chart series.
        // Display-only — never enters predictionCorpus (verified at the
        // service's emitPredictionToCorpus call site, which doesn't
        // accept recentComps/priceHistory). Empty [] on non-success
        // branches that don't build one.
        priceHistory: (est as any).priceHistory ?? [],
        // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): surface the parallel-
        // match attribution to iOS / sweeps / backtests. priceSource is
        // the 3-category collapse (exact / approximate / broad);
        // priceSourceInternal is the 7-value telemetry detail. Both are
        // null on base requests + on the success path where the pinned-
        // branch didn't trip the recovery (priceSource fields are
        // omitted from the service return there).
        priceSource: (est as any).priceSource ?? null,
        priceSourceInternal: (est as any).priceSourceInternal ?? null,
        parallelMatchFilteredCount: (est as any).parallelMatchFilteredCount ?? null,
        parallelMatchUnifiedCount: (est as any).parallelMatchUnifiedCount ?? null,
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
        // mirror the service's record + source signal so iOS can
        // render "last sold $X, N ago" or "Estimated $X (range Y–Z)
        // — based on the last sale N ago, adjusted for the set's
        // recent trend." estimateSource discriminates between
        // "observed" / "trend-extrapolated" / "last-sale" / null.
        lastSale: (est as any).lastSale ?? null,
        estimateSource: (est as any).estimateSource ?? null,
        // CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27): surface the
        // trend-aware sub-blocks + CH comp count. Always emit the keys
        // (null when helper didn't fire) so the iOS decoder has a stable
        // contract — same writeback-clear pattern as the persistence layer.
        modelExpectation: (est as any).modelExpectation ?? null,
        modelSignal: (est as any).modelSignal ?? null,
        chCompCount: (est as any).chCompCount ?? null,
        estimatedValue: (est as any).estimatedValue ?? null,
        estimateRange: (est as any).estimateRange ?? null,
        estimateBasis: (est as any).estimateBasis ?? null,
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
        // CF-CARD-HERO-IMAGE (2026-06-08) — STABLE Cardsight catalog
        // asset, proxied through our backend. Same URL forever for a
        // given cardId. iOS should render this as the primary hero.
        cardImageUrl,
        // EPHEMERAL fallback — eBay thumb of the most-recent clean comp
        // (most recent at/above 0.65 × binMedian). Useful when Cardsight's
        // catalog asset 404s (parallel ids, edge cases) or when iOS
        // wants to show "what the most recent sale looked like."
        // Field omitted when no usable thumb was found.
        cardImageThumbUrl,
        // CF-GRADE-BREAKDOWN (2026-06-09) — lean per-graded-bucket menu.
        // iOS uses this to render the grade selector AND fan out
        // additional /price-by-id calls when the user picks a grade.
        // Buckets with zero records (or zero records after the
        // parallel filter) are dropped — honest empty list rather
        // than fabricated medians on thin pools.
        gradeBreakdown,
        // CF-GRADED-PRICE-PROJECTION Phase 2 (2026-06-13) — graded
        // estimates for the LIQUID grade set (PSA 10/9, BGS 9.5,
        // SGC 10) where no observed sale exists. Grounded only
        // (confidenceTier ∈ {estimate, rough}); ballpark + insufficient
        // are dropped to keep gaps honest. STRUCTURALLY SEPARATE from
        // gradeBreakdown: that field stays purely observed (real,
        // trainable); this is purely estimated (display-not-train,
        // every entry has fairMarketValue=null).
        gradedEstimates,
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
    // cardIdentity.card_id matches the requested cardId. On
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
      cardId: resolvedCardId,
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
      // CF-GRADED-PRICE-PROJECTION Phase 2 — empty on unresolved (no
      // pricing payload to estimate from).
      gradedEstimates: [],
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
    // CF-CH-TELEMETRY-OUTSIDE-CACHE (2026-06-28): see /search for rationale.
    recordCHReferenceTelemetry({
      source: "compiq.price-by-id",
      cardId: resolvedCardId,
      player: ((result as any).cardIdentity?.player as string | undefined) ?? null,
      gradingCompany: typeof gradeCompany === "string" ? gradeCompany : null,
      gradeValue: typeof gradeValue === "number" ? gradeValue : null,
      engineFmv:
        typeof (result as any).fairMarketValueLive === "number"
          ? ((result as any).fairMarketValueLive as number)
          : null,
    });
    recordMomentumProjectionEvaluated({
      source: "compiq.price-by-id",
      cardId: resolvedCardId,
      player: ((result as any).cardIdentity?.player as string | undefined) ?? null,
      result: result as Record<string, unknown>,
    });

    // CF-CH-NEAREST-GRADED-ANCHOR (2026-06-28): surface the best graded
    // anchor we know about on EVERY priced response, regardless of
    // whether the engine FMV is healthy or degenerate. iOS uses this to
    // render honest disclosure when the raw FMV is uncertain:
    //   "Last sold: PSA 9 $1325 · 236 days ago"
    //
    // Per Drew's framing — "scalable trustworthy product with the best
    // approach" — we deliberately do NOT fabricate a derived raw FMV
    // via inverse-multiplier math today: the existing GRADER_PREMIUMS
    // table is base-card-calibrated and produces wrong inverses for
    // autos at high anchor prices (Kurtz Green Lava PSA 9 at $1325 →
    // inverse implies Raw at $1559, vs CH's $278 truth). Surfacing the
    // anchor without converting is the honest interim; the auto-aware
    // multiplier-calibration CF follows once we have telemetry to
    // justify the conversion math.
    //
    // The deriveGradeLadderAnchor function ships in the engine module
    // unused-by-default for now — same-grade fast path is sound; cross-
    // grade conversion will activate when the calibrated table lands.
    try {
      // CF-AUTO-AWARE-MULTIPLIERS (2026-06-28): cardClass passes through
      // to gradeLadderConversionRatio so the autograph-empirical table
      // is used when the card is autograph-class. cardIdentity.isAuto
      // is populated by CF-CH-AUTO-FROM-CARDNUMBER.
      const isAutoForLadder = ((result as any).cardIdentity?.isAuto as boolean | undefined) === true;
      const anchorResult = await deriveGradeLadderAnchor({
        cardId: resolvedCardId,
        // Request "Raw" so we ALWAYS get a graded anchor even when the
        // user is viewing the raw price (PSA 10/9/8 anchors get
        // identified; we surface them without conversion).
        requestedGrade: "Raw",
        cardClass: isAutoForLadder ? "autograph" : "base",
      });
      if (anchorResult) {
        (result as any).nearestGradedAnchor = {
          grade: anchorResult.anchorGrade,
          price: anchorResult.anchorPrice,
          daysOld: anchorResult.anchorDaysOld,
          sampleSize: anchorResult.anchorSampleSize,
          confidence: anchorResult.confidence,
        };
        try {
          console.log(JSON.stringify({
            event: "nearest_graded_anchor_surfaced",
            source: "compiq.price-by-id",
            cardId: resolvedCardId,
            engineFmv:
              typeof (result as any).fairMarketValueLive === "number"
                ? (result as any).fairMarketValueLive
                : null,
            engineCompsUsed:
              typeof (result as any).compsUsed === "number" ? (result as any).compsUsed : null,
            anchorGrade: anchorResult.anchorGrade,
            anchorPrice: anchorResult.anchorPrice,
            anchorDaysOld: anchorResult.anchorDaysOld,
            anchorSampleSize: anchorResult.anchorSampleSize,
            confidence: anchorResult.confidence,
            timestamp: new Date().toISOString(),
          }));
        } catch {
          // Telemetry must never propagate.
        }
      }
    } catch (err) {
      console.warn(
        `[compiq.price-by-id] nearest-graded-anchor failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }

    res.json(result);
    // Corpus collector â€” fire-and-forget, gated by COMPIQ_CORPUS_DISABLED
    // and COMPIQ_CORPUS_SAMPLE_RATE. querySource rule: if the request
    // carried a non-empty free-text `query`, store that with
    // querySource="free_text"; otherwise store cardId in the
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
    // 200 with pinned cardId exposed.
    if (isCardsightTimeoutError(err)) {
      const { cardId } = req.body || {};
      const pinnedId = typeof cardId === "string" ? cardId : "";
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
    cardId?: unknown;
    query?: unknown;
    gradeCompany?: unknown;
    gradeValue?: unknown;
  };
  const resolvedCardId =
    typeof body.cardId === "string" && body.cardId.length > 0
      ? body.cardId
      : null;
  if (!resolvedCardId) {
    return { error: 'Missing "cardId" field' as const };
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
            cardId: resolvedCardId,
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
            cardId: resolvedCardId,
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
          cardId:
            typeof (req.body ?? {}).cardId === "string"
              ? (req.body as any).cardId
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
            cardId: resolvedCardId,
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
            cardId: resolvedCardId,
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
          cardId:
            typeof (req.body ?? {}).cardId === "string"
              ? (req.body as any).cardId
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

// CF-COMPIQ-SCAN-ROUTE (2026-06-30) — iOS slab scanning entry point.
// Takes a photo (URL or base64) and identifies the card, returning a
// structured shape iOS can hand to /price-by-id for pricing.
//
// HEURISTIC (when `hint` is "auto" or omitted):
//   1. Try cert-OCR first — if the photo shows a graded slab, this
//      identifies the cert number, grader, and card in one call
//   2. If cert-OCR yields no card_id (raw card OR slab too blurry to
//      OCR), fall back to image-match for AI-driven identification
//
// REQUEST  POST /api/compiq/scan
//   { imageUrl?: string,
//     imageBase64?: string,    // at least one required
//     hint?: "raw" | "graded" | "auto" }   // default "auto"
//
// RESPONSE
//   { success: boolean,
//     cardId: string | null,    // pass to /price-by-id
//     player, set, number, variant,
//     matchPath: "cert-ocr" | "image-match" | null,
//     matchConfidence: number | null,
//     // When matchPath = cert-ocr:
//     certInfo: { certNumber, grader, grade } | null }
//
// AUTH: requireSession + requireRateLimited("priceChecksPerDay").
// Same rate budget as text-based scans — one image scan = one priceCheck.

// CF-COMPIQ-SCAN-TELEMETRY (2026-06-30): emit one structured event per
// scan attempt so Drew can monitor matchPath success rates and tune the
// cert-OCR-vs-image-match heuristic threshold. Privacy-safe: NEVER logs
// imageUrl (may contain SAS sig) or imageBase64 content.
export function logCompiqScanAttempt(opts: {
  hint: "raw" | "graded" | "auto";
  matchPath: "cert-ocr" | "image-match" | null;
  matchConfidence: number | null;
  hadCertInfo: boolean;
  certGrader: string | null;
  imageInputKind: "url" | "base64";
  durationMs: number;
}): void {
  try {
    console.log(JSON.stringify({
      event: "compiq_scan_attempt",
      hint: opts.hint,
      matchPath: opts.matchPath,
      matchConfidence: opts.matchConfidence,
      matchConfidenceBucket:
        opts.matchConfidence == null ? "none"
        : opts.matchConfidence >= 0.9 ? "high"
        : opts.matchConfidence >= 0.7 ? "medium"
        : opts.matchConfidence >= 0.5 ? "low"
        : "very_low",
      hadCertInfo: opts.hadCertInfo,
      certGrader: opts.certGrader,
      imageInputKind: opts.imageInputKind,
      durationMs: opts.durationMs,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // Telemetry failures must never propagate.
  }
}

router.post("/scan", requireSession, requireRateLimited("priceChecksPerDay"), async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { imageUrl, imageBase64, hint } = (req.body ?? {}) as {
      imageUrl?: unknown;
      imageBase64?: unknown;
      hint?: unknown;
    };
    const input: ImageInput = {
      imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
      imageBase64: typeof imageBase64 === "string" ? imageBase64 : undefined,
    };
    if (!input.imageUrl && !input.imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing image — provide "imageUrl" or "imageBase64"',
      });
    }
    const resolvedHint: "raw" | "graded" | "auto" =
      hint === "raw" || hint === "graded" ? hint : "auto";
    const imageInputKind: "url" | "base64" = input.imageUrl ? "url" : "base64";

    // ── Step 1: cert-OCR (slab path) ──────────────────────────────
    let certResult: Awaited<ReturnType<typeof getCardDetailsByCertImage>> = null;
    if (resolvedHint !== "raw") {
      certResult = await getCardDetailsByCertImage(input);
    }
    if (certResult && certResult.card?.card_id) {
      const ci = certResult.cert_info ?? {};
      const certGrader = typeof ci.grader === "string" ? ci.grader : null;
      const matchConfidence =
        typeof certResult.match_confidence === "number" ? certResult.match_confidence : null;
      logCompiqScanAttempt({
        hint: resolvedHint,
        matchPath: "cert-ocr",
        matchConfidence,
        hadCertInfo: Boolean(ci.cert_number),
        certGrader,
        imageInputKind,
        durationMs: Date.now() - startMs,
      });
      return res.json({
        success: true,
        cardId: String(certResult.card.card_id),
        player: typeof certResult.card.player === "string" ? certResult.card.player : null,
        set: typeof certResult.card.set === "string" ? certResult.card.set : null,
        number: typeof certResult.card.number === "string" ? certResult.card.number : null,
        variant: typeof certResult.card.variant === "string" ? certResult.card.variant : null,
        matchPath: "cert-ocr" as const,
        matchConfidence,
        certInfo: {
          certNumber: typeof ci.cert_number === "string" ? ci.cert_number : null,
          grader: certGrader,
          grade: typeof ci.grade === "string" ? ci.grade : null,
        },
      });
    }

    // ── Step 2: image-match (raw or cert-OCR-miss path) ─────────────
    if (resolvedHint !== "graded") {
      const matchResult = await identifyCardByImage(input);
      const best = matchResult?.best_match;
      if (best && typeof best.card_id === "string" && best.card_id.length > 0) {
        const matchConfidence = typeof best.confidence === "number" ? best.confidence : null;
        logCompiqScanAttempt({
          hint: resolvedHint,
          matchPath: "image-match",
          matchConfidence,
          hadCertInfo: false,
          certGrader: null,
          imageInputKind,
          durationMs: Date.now() - startMs,
        });
        return res.json({
          success: true,
          cardId: best.card_id,
          player: typeof best.player === "string" ? best.player : null,
          set: typeof best.set === "string" ? best.set : null,
          number: typeof best.number === "string" ? best.number : null,
          variant: typeof best.variant === "string" ? best.variant : null,
          matchPath: "image-match" as const,
          matchConfidence,
          certInfo: null,
        });
      }
    }

    // No path resolved a card_id.
    logCompiqScanAttempt({
      hint: resolvedHint,
      matchPath: null,
      matchConfidence: null,
      hadCertInfo: false,
      certGrader: null,
      imageInputKind,
      durationMs: Date.now() - startMs,
    });
    return res.json({
      success: true,
      cardId: null,
      player: null,
      set: null,
      number: null,
      variant: null,
      matchPath: null,
      matchConfidence: null,
      certInfo: null,
    });
  } catch (err) {
    next(err);
  }
});

// Test-only export â€” keeps `regimeFieldsFromEstimate` reachable from unit
// tests without exposing it on the public router surface.
export const __testing__ = {
  regimeFieldsFromEstimate,
  predictedRangeFieldsFromEstimate,
  cannotPriceFromEst,
};

export default router;
