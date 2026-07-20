// CF-CANONICAL-FMV (Drew, 2026-07-18). The single source of truth for
// "what is this card worth today." Every FMV emitter in the codebase
// eventually routes through this function so the answer is
// deterministic given inputs and identical across surfaces (iOS card
// detail, portfolio inventory row, alerts job, listing composer,
// backend estimate route, ERP valuation).
//
// Design principle: "one answer per (cardId, parallel, grade, year)."
// Same inputs → same output. Users see the same price on the detail
// page and the inventory row because it comes from the same function
// with the same cache key.
//
// FALLBACK LADDER (STRICT ORDER — the first rung that produces a
// number wins, and the method field records which rung fired):
//
//   1. direct-comp     — same-parallel + same-grade user pool has
//                        ≥1 recent priced comp. Runs through
//                        projectNextSaleFromComps (linear regression
//                        on ≥2 dated distinct points; anchor + broader
//                        trend on 1 point). This is the truest signal.
//
//   2. cross-parallel  — same cardId, sibling parallels have priced
//                        comps. Normalizes each sibling price via
//                        lookupParallelMultiplier(target) /
//                        lookupParallelMultiplier(sibling), applies
//                        the same trend, projects forward. Cold-start
//                        parallels get a defensible number here.
//
//   3. neighbor-parallel — different cardId, SAME product family, SAME
//                          parallel (e.g. 2025 Bowman Chrome
//                          #CPA-XX Blue Refractor when we want 2026
//                          #CPA-YY Blue Refractor). Adjusted by
//                          yearDeltaMultiplier + trend.
//
//   4. family-baseline — the family's Base Auto price × parallel
//                        multiplier × grade multiplier × trend.
//                        Guestimate compound-multiplier restated as a
//                        rung so its output is reproducible everywhere.
//
//   5. product-tier    — cold-start: category × era × grade tier ×
//                        trend. Confidence floor.
//
// NEVER: median across rungs, mean of rung outputs, "safe blend." The
// helper picks ONE rung and returns its number with its confidence.
//
// See feedback_no_medians_project_next_sale.md for the underlying
// principle; every rung projects the next sale, none reports a middle.

import { readCompsByCardId, recordSoldComp, inferSportFromContext } from "../portfolioiq/soldCompsStore.service.js";
import { projectNextSaleFromComps } from "./nextSaleProjection.service.js";
import { fetchPlayerInSetMomentum, momentumMultiplierToPctPerMonth } from "./playerInSetMomentum.service.js";
import { lookupParallelMultiplier } from "./neighborMultipliers.js";
import { cacheDel, cacheWrap } from "../shared/cache.service.js";
import { computeGuestimate, type PlayerTier } from "./guestimatePricing.js";
// fetchCompsByPlayer no longer used here — warmPoolFromCh retired
// (see CF-RETIRE-WARM-POOL-FROM-CH). Kept the comment references so
// git-blame trail stays intact.
import { fetchCardActiveListings } from "../ebay/ebayListingSearch.service.js";
import { CosmosClient, type Container } from "@azure/cosmos";
import { classifyFamily, lookupGradeRatio } from "./gradeCalibrationConfig.js";
import { titleMatchesParallel } from "./titleParallelMatch.js";

export type CanonicalFmvMethod =
  | "direct-comp"
  | "cross-parallel"
  | "neighbor-parallel"
  | "sibling-parallel"
  | "family-baseline"
  | "product-tier"
  | "no-basis";

export interface CanonicalFmvInput {
  /** Canonical CH cardId (or Cardsight UUID). Required for pool lookups. */
  cardId: string;
  /** Parallel name (e.g. "Blue Refractor", "Base"). Null → base holding. */
  parallel?: string | null;
  /** Grade tier — company null for raw. */
  gradeCompany?: string | null;
  gradeValue?: number | null;
  /** Card year (2026, 2020, etc.). Used for neighbor-parallel year adjustment. */
  cardYear?: number | null;
  /** Product family key (e.g. "2026 Bowman Chrome", "Panini Prizm Football").
   *  Used for family-baseline + neighbor-parallel rungs. */
  product?: string | null;
  /** Player name — used for the broader momentum signal (playerInSetMomentum). */
  player?: string | null;
  /** Card number ("CPA-EHA", "BCP-102", "#365"). Used for identity checks. */
  cardNumber?: string | null;
  /** When true, forces cache miss + fresh compute. Default false. */
  freshCompute?: boolean;
}

export interface CanonicalFmvProvenance {
  /** Human-readable summary of what drove the number ("2 same-parallel
   *  user comps + 8%/mo player momentum"). Included in log events + iOS
   *  transparency sheet. */
  summary: string;
  /** Comps that fed the projection (empty for rungs 4-5). */
  comps: Array<{
    price: number;
    soldAt: string;
    source: string;
    parallel: string | null;
    verifiedByUser: boolean;
    // Whether this comp was ratio-normalized from a sibling parallel.
    normalizedFromParallel?: string | null;
    /** The ratio applied when normalized; null for direct comps. */
    normalizationRatio?: number | null;
  }>;
  /** Broader trend applied, %/month. Null when unknown. */
  trendPctPerMonth: number | null;
  /** Multiplier stack recorded for auditability (rungs 4-5 mostly). */
  multipliers: Record<string, number>;
}

/** CF-GRADE-LADDER (Drew, 2026-07-18). Per-grade FMV projection based
 *  on the empirical grade-calibration table. iOS Card Detail renders
 *  the ladder under the FMV headline so users see "raw $1,823 · PSA 10
 *  $7,292" at a glance. Null when the product family isn't covered by
 *  the calibration table (family = "other"). */
export interface CanonicalFmvGradeLadder {
  family: string;
  sampleSize: number;
  tiers: Array<{
    grader: string;         // "Raw" | "PSA 10" | "PSA 9" | "BGS 10" | ...
    medianRatio: number;    // ratio applied to raw fmv anchor
    fmv: number;            // ratio × raw anchor, rounded
  }>;
}

export interface CanonicalFmvResult {
  /** The projected next sale price. Null when no rung produced a value. */
  fmv: number | null;
  /** Which rung fired. */
  method: CanonicalFmvMethod;
  /** 0.0-1.0 self-reported confidence. Falls with each rung down the ladder. */
  confidence: number;
  /** Full audit trail — comps used, trend applied, multipliers, etc. */
  provenance: CanonicalFmvProvenance;
  /** ISO timestamp of the compute. Cache readers compare against staleness. */
  computedAt: string;
  /** Per-grade FMV ladder (Raw / PSA 10 / BGS 10 / etc.) computed from
   *  empirical grade-ratio calibration. Null when family uncovered. */
  gradeLadder?: CanonicalFmvGradeLadder | null;
  /** CF-CONFIDENCE-BAND (Drew, 2026-07-20). Actual observed price
   *  distribution of the comps that fed the projection. iOS renders
   *  this as "sells around $X (range $Y–$Z)" so users see the range
   *  behind the point projection — the Hartman auction on 2026-07-19
   *  taught us single-point overshoots by ~18% when trend accelerates
   *  then decelerates. Providing the range prevents overpaying on
   *  the projection at negotiation time.
   *
   *  Populated for trustworthy methods (direct-comp / cross-parallel /
   *  neighbor-parallel / sibling-parallel). Null when the anchor is
   *  a family median (rungs 4-5) — the "range" would be meaningless. */
  recentRange?: {
    /** How many comps fed the range. */
    n: number;
    /** Minimum observed sale price. */
    min: number;
    /** 25th percentile. */
    p25: number;
    /** Median of observed sales. */
    median: number;
    /** 75th percentile. */
    p75: number;
    /** Maximum observed sale price. */
    max: number;
  } | null;
}

const NULL_RESULT = (reason: string): CanonicalFmvResult => ({
  fmv: null,
  method: "no-basis",
  confidence: 0,
  provenance: { summary: reason, comps: [], trendPctPerMonth: null, multipliers: {} },
  computedAt: new Date().toISOString(),
});

const MAX_POOL_AGE_DAYS = 180;
const MS_PER_DAY = 86_400_000;

/** Redis cache TTL for the canonical FMV envelope. 15 min balances
 *  "fresh enough for iOS card detail" against "not hammering the
 *  compute path on every render." Invalidated by comp writes for the
 *  same (cardId, parallel, grade). */
const FMV_CACHE_TTL_SEC = 15 * 60;

function fmvCacheKey(input: CanonicalFmvInput): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, "-") || "_";
  const gradeKey = input.gradeCompany ? `${norm(input.gradeCompany)}${input.gradeValue ?? "_"}` : "raw";
  return `fmv:v1:${norm(input.cardId)}:${norm(input.parallel)}:${gradeKey}`;
}

/**
 * Invalidate the canonical FMV cache for a specific (cardId, parallel,
 * grade). Called by every sold_comps write path (confirm/rematch/
 * suggester/backfill) so a fresh transaction is immediately reflected
 * in the next FMV read across all surfaces.
 *
 * Fire-and-forget: never blocks, swallows errors.
 */
export async function invalidateCanonicalFmvCache(input: {
  cardId: string;
  parallel?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
}): Promise<void> {
  try {
    const key = fmvCacheKey({
      cardId: input.cardId,
      parallel: input.parallel ?? null,
      gradeCompany: input.gradeCompany ?? null,
      gradeValue: input.gradeValue ?? null,
    });
    await cacheDel(key);
  } catch {
    // swallow — cache invalidation is auxiliary
  }
}

/**
 * The one function. Every FMV emission across the codebase should
 * eventually call this. Deterministic given inputs. Idempotent.
 * Fire-and-forget safe (never throws in production — returns
 * no-basis on any failure).
 *
 * Cache: Redis TTL 15 min, keyed on (cardId, parallel, grade).
 * Bypass with input.freshCompute = true.
 */
export async function computeCanonicalFmv(
  input: CanonicalFmvInput,
): Promise<CanonicalFmvResult> {
  const cardIdCheck = (input.cardId ?? "").trim();
  if (!cardIdCheck) return NULL_RESULT("missing cardId");

  if (input.freshCompute === true) {
    // Explicit bypass: skip cache read AND write. Used by callers that
    // want a re-compute after a known invalidation event.
    return computeCanonicalFmvUncached(input);
  }

  const key = fmvCacheKey(input);
  const result = await cacheWrap<CanonicalFmvResult>(
    key,
    () => computeCanonicalFmvUncached(input),
    {
      freshTtlSeconds: FMV_CACHE_TTL_SEC,
      // Don't cache no-basis results — the next call may find comps
      // (recent write, deploy warm-up finishing).
      skipCacheWhen: (r) => r.method === "no-basis",
    },
  );
  return result;
}

async function computeCanonicalFmvUncached(
  input: CanonicalFmvInput,
): Promise<CanonicalFmvResult> {
  const t0 = Date.now();
  const cardId = (input.cardId ?? "").trim();
  if (!cardId) {
    const nb = NULL_RESULT("missing cardId");
    logCompute(nb, input, t0);
    return nb;
  }

  // Fetch the broader trend signal once — every rung that needs it
  // (single-anchor projection) reads from this.
  const momentum = input.player && input.product
    ? await fetchPlayerInSetMomentum({
        playerName: input.player,
        product: input.product,
        cardYear: input.cardYear ?? undefined,
      }).catch(() => null)
    : null;
  const trendPctPerMonth = momentumMultiplierToPctPerMonth(momentum?.multiplier ?? null);

  const directResult = await tryDirectComp(cardId, input, trendPctPerMonth);
  if (directResult) return finalize(directResult, input, t0);
  const crossResult = await tryCrossParallel(cardId, input, trendPctPerMonth);
  if (crossResult) return finalize(crossResult, input, t0);
  const neighborResult = await tryNeighborParallel(cardId, input, trendPctPerMonth);
  if (neighborResult) return finalize(neighborResult, input, t0);

  // CF-SIBLING-PARALLEL-RUNG (Drew, 2026-07-19). When the specific
  // parallel has zero direct/cross/neighbor comps, look at OTHER
  // parallels of the same (year, cardNumber, product family) as
  // pricing signal. For a scarce numbered parallel like Blue Refractor
  // /150 that hasn't traded recently, sibling parallels (Purple $46,
  // Green Shimmer $69, Yellow $110) form a plausible ladder.
  //
  // Estimate = median across sibling per-variant medians. Excludes
  // Base (typically a much larger print run that would drag the
  // estimate way down). Confidence is deliberately low (0.35) because
  // this is a bridge estimate, not a direct comp; iOS should render
  // it with an "estimate" chip.
  //
  // Only fires when input specifies a non-base parallel; a base
  // request should keep falling through to family-baseline as before.
  const siblingResult = await trySiblingParallel(input, trendPctPerMonth);
  if (siblingResult) return finalize(siblingResult, input, t0);

  // CF-CANONICAL-FMV-NO-BASIS-GATE (Drew, 2026-07-19). Real regressions
  // observed at 2026-07-19 card-show prep: Jared Jones 2026 Bowman
  // Chrome Prospect Auto Blue Refractor /150 returned $3, Bobby Witt
  // Jr. 2020 Bowman Chrome BGS 9 returned $5. Both are cases where the
  // caller specified a scarce, specific parallel/grade with zero direct
  // comps, and rungs 4 (family-baseline) + 5 (product-tier) fired with
  // family MEDIANS instead. A family median is not a projected next
  // sale for a specific numbered parallel — it's a lie dressed as an
  // answer. When the request is specific (has a non-base parallel OR a
  // graded tier), refuse to fall through to family/product rungs and
  // return no-basis so iOS shows "—" with a "not enough data" chip.
  //
  // Base cards without a grade still fall through to rungs 4-5 because
  // family-baseline is legitimately what "typical 2020 Topps Chrome
  // base card" means — no scarcity to violate. The gate specifically
  // protects specific SKUs from being answered with family averages.
  //
  // Flag: CANONICAL_FMV_STRICT_NO_BASIS (default "true"). Set "false"
  // to restore the pre-2026-07-19 fall-through behavior.
  const strictNoBasis = process.env.CANONICAL_FMV_STRICT_NO_BASIS !== "false";
  const requestIsSpecific = isSpecificRequest(input);
  if (strictNoBasis && requestIsSpecific) {
    const nb = NULL_RESULT("no direct/cross/neighbor comps for specific parallel or grade");
    logCompute(nb, input, t0);
    return nb;
  }

  const familyResult = await tryFamilyBaseline(cardId, input, trendPctPerMonth);
  if (familyResult) return finalize(familyResult, input, t0);
  const tierResult = await tryProductTier(cardId, input, trendPctPerMonth);
  if (tierResult) return finalize(tierResult, input, t0);

  const nb = NULL_RESULT("no rung produced a value");
  logCompute(nb, input, t0);
  return nb;
}

/** A request is "specific" when the caller pinned down a scarce SKU
 *  attribute — either a non-base parallel string or a graded tier. In
 *  those cases the family/product-tier rungs are misleading and the
 *  no-basis gate refuses to fall through. Base-card lookups without a
 *  grade stay permissive because "typical 2020 Bowman Chrome base
 *  card" is a legitimate concept a family baseline can express. */
function isSpecificRequest(input: CanonicalFmvInput): boolean {
  const parallel = (input.parallel ?? "").trim().toLowerCase();
  const isNonBase = parallel !== "" && parallel !== "base" && parallel !== "[base]" && parallel !== "none";
  const isGraded = input.gradeCompany !== null && input.gradeCompany !== undefined && input.gradeCompany.trim().length > 0;
  return isNonBase || isGraded;
}

/** Finalize a canonical result: attach the grade ladder (when the
 *  product family is covered by empirical calibration), attach the
 *  recent-range distribution (from the comps in provenance), and log
 *  telemetry. Called at every successful-rung return point.
 */
function finalize(result: CanonicalFmvResult, input: CanonicalFmvInput, t0: number): CanonicalFmvResult {
  result.gradeLadder = buildGradeLadder(result, input);
  result.recentRange = buildRecentRange(result);
  logCompute(result, input, t0);
  return result;
}

/** CF-CONFIDENCE-BAND (Drew, 2026-07-20). Compute the price
 *  distribution of the comps that fed the projection. Only for
 *  trustworthy methods (rungs 1-4). Rungs 5+ derive from a family
 *  median where the "range" concept doesn't hold. */
function buildRecentRange(result: CanonicalFmvResult): CanonicalFmvResult["recentRange"] {
  const trustworthy = new Set<CanonicalFmvMethod>(["direct-comp", "cross-parallel", "neighbor-parallel", "sibling-parallel"]);
  if (!trustworthy.has(result.method)) return null;
  const comps = result.provenance?.comps ?? [];
  const prices = comps.map((c) => Number(c.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const percentile = (p: number): number => {
    if (prices.length === 1) return prices[0];
    const idx = Math.floor((prices.length - 1) * p);
    return prices[idx];
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    n: prices.length,
    min: round2(prices[0]),
    p25: round2(percentile(0.25)),
    median: round2(percentile(0.5)),
    p75: round2(percentile(0.75)),
    max: round2(prices[prices.length - 1]),
  };
}

/** Build the grade ladder for a canonical FMV result.
 *
 *  Anchor derivation:
 *   - If the caller asked for Raw (gradeCompany null): raw anchor = fmv
 *   - If the caller asked for a graded tier: raw anchor = fmv / gradeMultiplier
 *     (reverse the multiplier so the ladder cascades correctly)
 *
 *  Then compute each covered tier's fmv = rawAnchor × empirical ratio × sub-tier scaling. */
function buildGradeLadder(
  result: CanonicalFmvResult,
  input: CanonicalFmvInput,
): CanonicalFmvGradeLadder | null {
  if (!result.fmv || result.fmv <= 0 || !input.product) return null;
  // CF-CANONICAL-FMV-LADDER-SUPPRESSION (Drew, 2026-07-19). When the
  // FMV came from a family-baseline / product-tier / no-basis rung the
  // raw anchor is a family median, not a projected next sale for this
  // specific SKU. Multiplying that anchor by a PSA 10 ratio (e.g. 3.46×
  // for bowman-chrome) amplifies noise into an inflated ladder that
  // reads as "same card in PSA 10 = $X" but is nowhere near real. Only
  // render the ladder when the anchor is trustworthy (direct-comp /
  // cross-parallel / neighbor-parallel).
  const trustworthyMethods = new Set<CanonicalFmvMethod>(["direct-comp", "cross-parallel", "neighbor-parallel", "sibling-parallel"]);
  if (!trustworthyMethods.has(result.method)) return null;
  const family = classifyFamily(input.product);
  if (family === "other") return null;

  // Derive a raw anchor from the current FMV. If the input's grade is
  // null → the FMV IS raw. Otherwise reverse the grade multiplier to
  // recover an implied raw base.
  let rawAnchor = result.fmv;
  const sport = inferSportFromContext(input.product ?? null, null);
  const inputGradeMult = input.gradeCompany && input.gradeValue !== null && input.gradeValue !== undefined
    ? gradeTierMultiplier(input.gradeCompany, input.gradeValue, family, sport)
    : 1;
  if (inputGradeMult > 0) rawAnchor = result.fmv / inputGradeMult;

  // For each grader we have calibration for, project the top tier value.
  // Sub-tier scaling handled by gradeTierMultiplier.
  const graders = ["PSA", "BGS", "SGC", "CGC"];
  const gradeValues: Record<string, number[]> = {
    PSA: [10, 9, 8],
    BGS: [10, 9.5, 9],
    SGC: [10, 9.5],
    CGC: [10, 9.5],
  };
  const totalSample = { n: 0 };
  const tiers: CanonicalFmvGradeLadder["tiers"] = [
    { grader: "Raw", medianRatio: 1.0, fmv: Math.round(rawAnchor * 100) / 100 },
  ];
  for (const grader of graders) {
    for (const value of gradeValues[grader]) {
      const mult = gradeTierMultiplier(grader, value, family, sport);
      if (mult <= 1) continue;   // no empirical uplift → skip
      const fmv = rawAnchor * mult;
      if (!Number.isFinite(fmv) || fmv <= 0) continue;
      tiers.push({
        grader: `${grader} ${value}`,
        medianRatio: Math.round(mult * 100) / 100,
        fmv: Math.round(fmv * 100) / 100,
      });
      totalSample.n = Math.max(totalSample.n, 5);   // approximate — the config lookup already ensured n≥5
    }
  }
  if (tiers.length < 2) return null;   // only Raw known → nothing worth showing
  return {
    family,
    sampleSize: totalSample.n,
    tiers,
  };
}

/** CF-CANONICAL-FMV-TELEMETRY (Drew, 2026-07-18). Single JSON log line
 *  per compute so App Insights can chart method distribution, latency
 *  percentiles, confidence buckets, no-basis rate. Powers the KQL
 *  dashboards documented in
 *  scratchpad/canonical-fmv-app-insights-queries-*.md. */
function logCompute(result: CanonicalFmvResult, input: CanonicalFmvInput, t0: number): void {
  try {
    console.log(JSON.stringify({
      event: "compiq.canonical_fmv.computed",
      source: "canonicalFmv.service",
      cardId: input.cardId,
      parallel: input.parallel ?? null,
      gradeCompany: input.gradeCompany ?? null,
      gradeValue: input.gradeValue ?? null,
      method: result.method,
      confidence: result.confidence,
      fmv: result.fmv,
      elapsedMs: Date.now() - t0,
    }));
  } catch { /* logging never breaks compute */ }
}

// ─── CH pool-warming ──────────────────────────────────────────────────
//
// CF-CH-POOL-WARM (Drew, 2026-07-18): when the direct-comp pool for a
// (cardId, parallel, grade) target is thin, silently ingest CH's own
// player-product aggregate for the same identity. CH has the recent
// eBay sales (e.g. Eric Hartman Blue #CPA-EHA at $1,500 / $1,225 /
// $1,525) that our sold_comps pool hasn't seen yet — instead of falling
// back to sparse-data rungs, warm the pool from CH once + re-query.
//
// Idempotent via recordSoldComp's {source::sourceExternalId} dedup:
// repeat runs upsert the same doc set. Cache-invalidated writes flow
// through the recordSoldComp side-effect that already fires
// invalidateCanonicalFmvCache. Fire-and-forget: pool warming failures
// don't block the FMV compute.
/** CF-EBAY-BROWSE-ENDED-WARM (Drew, 2026-07-18, Option C).
 *
 *  ⚠ SCAFFOLDING — currently INERT.
 *
 *  Investigation on 2026-07-18 confirmed that eBay Browse's
 *  `item_summary/search` endpoint returns ONLY active listings; the
 *  `endsAt` field on responses is always a FUTURE date. This filter
 *  (endsAt < now) therefore matches zero listings against the
 *  current Browse endpoint.
 *
 *  This function is kept in place as WIRING for when a real confirmed-
 *  sold data source lands:
 *    - eBay Marketplace Insights API (approval-required), OR
 *    - the internal ch_daily_sales feed, OR
 *    - a future eBay data-license partnership
 *
 *  When that source arrives, swap the `fetchCardActiveListings` call
 *  below for the confirmed-sold endpoint. Everything else — the
 *  ingest shape, cache invalidation, direct-comp read sources, and
 *  confidence 0.85 — stays the same. The FMV pipeline activates
 *  automatically on the first fresh query.
 *
 *  Ingest shape when active:
 *  Only eBay Browse listings whose end-date has already passed. For
 *  auctions, that means the winning bid is locked in; for BIN/best-offer
 *  listings, ended = sold or expired. Skips still-active listings
 *  entirely — those are ask prices, not confirmed sales, and would
 *  pollute the pool.
 *
 *  Source: "ebay-browse-ended". Confidence 0.75 (below CH's 0.7 aggregate
 *  trust? — no, above, because these are LISTING-level attributed rather
 *  than aggregate-level; the individual sale is directly observable
 *  with itemWebUrl provenance). Actually 0.75 sits between CH 0.7 and
 *  manual-user-entry 0.9 — reflects "we watched the auction close" vs
 *  "user attested" vs "CH says trust it."
 *
 *  cardId is passed through — Browse doesn't tie to a vendor cardId, so
 *  each ingested listing goes under the query's target cardId. */
async function warmPoolFromEbayBrowseEnded(
  cardId: string,
  input: CanonicalFmvInput,
): Promise<number> {
  if (!input.player) return 0;
  try {
    const result = await fetchCardActiveListings({
      year: input.cardYear ?? undefined,
      set: input.product ?? undefined,
      player: input.player,
      cardNumber: input.cardNumber ?? undefined,
      parallel: input.parallel ?? undefined,
      gradeCompany: input.gradeCompany ?? undefined,
      gradeValue: input.gradeValue !== null && input.gradeValue !== undefined
        ? String(input.gradeValue)
        : undefined,
    });
    if (!result || result.listings.length === 0) return 0;
    const nowMs = Date.now();
    // A tiny buffer past endDate to let the auction settle (avoid
    // racing the seller/eBay on final-bid confirmation).
    const SETTLED_BUFFER_MS = 15 * 60 * 1000;   // 15 min
    let ingested = 0;
    for (const l of result.listings) {
      if (!Number.isFinite(l.price) || l.price <= 0) continue;
      if (!l.endsAt) continue;
      const endMs = Date.parse(l.endsAt);
      if (!Number.isFinite(endMs)) continue;
      // ENDED-ONLY GATE: skip listings still active or ending
      // imminently (unsettled). Only ingest ones whose endDate is
      // clearly in the past.
      if (endMs > nowMs - SETTLED_BUFFER_MS) continue;
      // CF-EBAY-BROWSE-ENDED-TITLE-VERIFY (Drew, 2026-07-19). eBay
      // Browse fuzzy-matches parallel — a "Blue Refractor" query
      // returns "Blue X-Fractor" listings and worse. Without this
      // gate we'd write the wrong-parallel listing into sold_comps
      // tagged with input.parallel, permanently corrupting FMV
      // downstream. Same class of bug as retired warmPoolFromCh.
      if (!titleMatchesParallel(l.title ?? "", input.parallel ?? null, input.cardNumber ?? null, input.player ?? null)) continue;
      try {
        await recordSoldComp({
          cardId,
          playerName: input.player,
          cardYear: input.cardYear ?? null,
          setName: input.product ?? null,
          parallel: input.parallel ?? null,
          cardNumber: input.cardNumber ?? null,
          isAuto: detectIsAuto(input),
          gradeCompany: input.gradeCompany ?? null,
          gradeValue: input.gradeValue ?? null,
          price: l.price,
          // Use endsAt as the sale-date proxy — that's when the auction
          // closed (winning bid locked) or the BIN listing expired /
          // sold. Matches what the iOS Sales tab already shows.
          soldAt: l.endsAt,
          source: "ebay-browse-ended",
          sourceExternalId: `ebay-browse-ended::${l.id}`,
          contributorUserId: null,
          title: l.title,
          imageUrl: l.imageUrl,
          sellerHandle: l.seller.username,
          verifiedByUser: false,
          // CF-EBAY-ENDED-CONFIDENCE (Drew, 2026-07-18): 0.85 —
          // direct listing provenance (itemWebUrl, seller, endsAt),
          // legally-binding winning-bid semantic. Slightly below
          // manual-user-entry 0.9 (we didn't personally verify) but
          // above CH's 0.7 aggregate (no aggregation/interpolation).
          // Follow-on: when we can add bidCount to ActiveListing from
          // Browse, gate on bidCount > 0 for auctions and raise this
          // to 0.90 for confirmed-sold rows.
          confidence: 0.85,
        });
        ingested++;
      } catch { /* per-listing errors swallowed */ }
    }
    return ingested;
  } catch { return 0; }
}

/** CF-CH-DAILY-SALES-WARM (Drew, 2026-07-18). Query ch_daily_sales
 *  directly by cardId + grader for scoped, high-precision sold data.
 *  This is the LOCALLY-CACHED CH nightly ingest — same underlying
 *  source as fetchCompsByPlayer but queried by cardId directly, so
 *  no player/product fuzzy match issues and no cross-cardId noise.
 *
 *  When Marketplace Insights lands, this remains useful as a fast
 *  local read; the two sources complement each other.
 *
 *  Confidence 0.8 — direct listing-level provenance in our own
 *  container, sitting between manual-user-entry 0.9 and CH aggregate
 *  0.7. Higher than the aggregate because we see the individual sale
 *  row, not a bucket median.
 */
let sharedChDailyContainer: Container | null = null;
async function getChDailyContainer(): Promise<Container | null> {
  if (sharedChDailyContainer) return sharedChDailyContainer;
  try {
    const cs = process.env.COSMOS_CONNECTION_STRING;
    if (!cs) return null;
    const client = new CosmosClient(cs);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    sharedChDailyContainer = db.container(
      process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales",
    );
    return sharedChDailyContainer;
  } catch { return null; }
}

async function warmPoolFromChDailySales(
  cardId: string,
  input: CanonicalFmvInput,
): Promise<number> {
  const container = await getChDailyContainer();
  if (!container) return 0;
  try {
    // CF-CH-GRADE-FIELD-FIX (Drew, 2026-07-20). ch_daily_sales has TWO
    // grade fields: c.grader is company-only ("BGS", "PSA"), c.grade
    // is the full tier string ("BGS 9.5", "PSA 10", "Raw"). Earlier
    // code filtered c.grader = "PSA 10" — no rows matched because
    // grader stores just "PSA". Filter c.grade for exact-tier match,
    // "Raw" for raw. This fixes the graded-tier ch_daily_sales lookup
    // that was silently returning 0 hits for every graded query.
    const graderQuery = input.gradeCompany && input.gradeValue !== null && input.gradeValue !== undefined
      ? `${input.gradeCompany.toUpperCase()} ${input.gradeValue}`
      : "Raw";
    const cutoff = new Date(Date.now() - MAX_POOL_AGE_DAYS * MS_PER_DAY).toISOString();
    // Query ch_daily_sales for the target cardId + grader.
    // Filter by parallel in memory (variant field format varies).
    const iter = container.items.query<{
      card_id: string;
      player: string;
      year: number;
      card_set: string;
      variant: string;
      number: string;
      price: number;
      grader: string;
      sale_date: string;
      image_url: string | null;
    }>({
      query: `SELECT TOP 50 c.card_id, c.player, c.year, c.card_set, c.variant,
                            c.number, c.price, c.grader, c.sale_date, c.image_url
              FROM c
              WHERE c.card_id = @cardId
                AND c.grade = @grader
                AND c.sale_date >= @cutoff
                AND c.price > 0
              ORDER BY c.sale_date DESC`,
      parameters: [
        { name: "@cardId", value: cardId },
        { name: "@grader", value: graderQuery },
        { name: "@cutoff", value: cutoff },
      ],
    });
    const { resources } = await iter.fetchAll();
    if (resources.length === 0) return 0;

    // Optional in-memory parallel filter — normalize to handle
    // "Blue" vs "Blue Refractor" the same way soldCompsStore does.
    const stripRefr = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, "");
    const wantParallel = input.parallel ? stripRefr(input.parallel) : null;

    let ingested = 0;
    for (const row of resources) {
      if (!Number.isFinite(row.price) || row.price <= 0) continue;
      if (wantParallel && stripRefr(row.variant ?? "") !== wantParallel) continue;
      try {
        await recordSoldComp({
          cardId: row.card_id,
          playerName: row.player,
          cardYear: row.year ?? null,
          setName: row.card_set ?? null,
          parallel: row.variant ?? null,
          cardNumber: row.number ?? null,
          isAuto: detectIsAuto(input),
          gradeCompany: input.gradeCompany ?? null,
          gradeValue: input.gradeValue ?? null,
          price: row.price,
          soldAt: row.sale_date,
          source: "cardhedge",
          sourceExternalId: `ch-daily::${row.card_id}::${row.sale_date}::${Math.round(row.price * 100)}`,
          contributorUserId: null,
          title: `${row.year} ${row.card_set} #${row.number} ${row.variant}`.trim(),
          imageUrl: row.image_url ?? null,
          sellerHandle: null,
          verifiedByUser: false,
          confidence: 0.8,
        });
        ingested++;
      } catch { /* swallow per-row errors */ }
    }
    return ingested;
  } catch { return 0; }
}

// CF-RETIRE-WARM-POOL-FROM-CH (Drew, 2026-07-19). warmPoolFromCh was
// removed here — see the note at the call site in
// computeCanonicalFmvUncached. Cross-parallel pollution was leaking
// input.parallel into the stored row's parallel field because
// fetchCompsByPlayer doesn't return per-row parallel. Kept
// warmPoolFromChDailySales instead (correct per-row variant from CH's
// daily dump).

// ─── Rung 1: direct same-parallel same-grade comps ────────────────────
async function tryDirectComp(
  cardId: string,
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  const sources = [
    "ebay-user-purchase",
    "ebay-user-sale",
    "manual-user-entry",
    "cardhedge",             // CF-CH-POOL-WARM
    "ebay-browse-ended",     // CF-EBAY-BROWSE-ENDED-WARM (Option C)
  ] as const;
  const readPool = async () => readCompsByCardId({
    cardId,
    sources: [...sources] as never,
    parallel: input.parallel ?? undefined,
    gradeCompany: input.gradeCompany ?? undefined,
    gradeValue: input.gradeValue ?? undefined,
  }).catch(() => [] as Awaited<ReturnType<typeof readCompsByCardId>>);
  let comps = await readPool();

  const nowMs = Date.now();
  const filterFresh = (arr: typeof comps) => arr.filter((c) => {
    const soldMs = Date.parse(c.soldAt ?? "");
    if (!Number.isFinite(soldMs)) return false;
    if (nowMs - soldMs > MAX_POOL_AGE_DAYS * MS_PER_DAY) return false;
    if ((c as { flaggedWrong?: boolean }).flaggedWrong === true) return false;
    return true;
  });
  let fresh = filterFresh(comps);

  // CF-POOL-WARM (Drew, 2026-07-18): pool is thin — warm from CH's
  // aggregate AND eBay Browse ended listings. Runs both in parallel;
  // each is idempotent and fire-and-forget-safe. Re-query once after
  // both settle so downstream sees the augmented sample.
  //
  // ebay-browse-ended is scoped to listings whose endDate has passed
  // (auction winning bids + expired BINs), so we don't pollute the
  // pool with active ask prices.
  if (fresh.length < 3 && input.player) {
    // CF-RETIRE-WARM-POOL-FROM-CH (Drew, 2026-07-19). Dropped
    // warmPoolFromCh — it wrote CH-search-API comps tagged with
    // input.parallel instead of per-comp parallel, causing cross-
    // parallel pollution in sold_comps (e.g. Blue X-Fractor $550 sale
    // was written with parallel="Refractor" AND parallel="Blue
    // X-Fractor" from separate queries). warmPoolFromChDailySales
    // reads the same underlying CH data from local ch_daily_sales but
    // uses the correct per-row variant field. Freshness gap is at
    // most ~24hr (CH nightly ingest cadence) which is acceptable.
    const [chDailyAdded, ebayEndedAdded] = await Promise.all([
      warmPoolFromChDailySales(cardId, input),
      warmPoolFromEbayBrowseEnded(cardId, input),
    ]);
    if (chDailyAdded + ebayEndedAdded > 0) {
      comps = await readPool();
      fresh = filterFresh(comps);
    }
  }
  if (fresh.length === 0) return null;

  const projection = projectNextSaleFromComps(
    fresh.map((c) => ({ price: c.price, soldDate: c.soldAt })),
    {
      broaderTrendPctPerMonth: trendPctPerMonth,
      // CF-FORWARD-WINDOW-0D (Drew, 2026-07-18): canonical FMV projects
      // AT now, not into the future — "what is this worth today," not
      // "what will it sell for in 30 days." When we do have a proper
      // regression (n≥3), the OLS fits and evaluates at now; when we
      // don't (n<3), branch 2 anchors on the newest sale and applies
      // the broader-trend backfill from soldAt→now only.
      forwardDays: 0,
      // Require ≥3 comps for regression — at n=2 the OLS extrapolates
      // an unbounded straight line even at t=now, which over-projects
      // steep slopes.
      minNForRegression: 3,
    },
  );
  if (!projection || projection.nextSaleValue <= 0) return null;

  return {
    fmv: projection.nextSaleValue,
    method: "direct-comp",
    confidence: Math.min(0.95, projection.confidence + 0.05),
    provenance: {
      summary: `${fresh.length} same-parallel user comp${fresh.length === 1 ? "" : "s"} + ${
        trendPctPerMonth === null ? "no trend" : `${trendPctPerMonth.toFixed(1)}%/mo trend`
      }`,
      comps: fresh.slice(0, 8).map((c) => ({
        price: c.price,
        soldAt: c.soldAt,
        source: c.source,
        parallel: c.parallel,
        verifiedByUser: c.verifiedByUser === true,
      })),
      trendPctPerMonth,
      multipliers: {},
    },
    computedAt: new Date().toISOString(),
  };
}

// ─── Rung 2: same cardId, sibling parallels, ratio-normalized ─────────
async function tryCrossParallel(
  cardId: string,
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  const targetParallel = (input.parallel ?? "").trim();
  if (!targetParallel) return null;   // no target to normalize toward
  const targetMult = lookupParallelMultiplier(targetParallel);
  if (targetMult === null || targetMult <= 0) return null;

  // Pull ALL parallels for this cardId (no parallel filter).
  const allComps = await readCompsByCardId({
    cardId,
    sources: ["ebay-user-purchase", "ebay-user-sale", "manual-user-entry"],
    gradeCompany: input.gradeCompany ?? undefined,
    gradeValue: input.gradeValue ?? undefined,
  }).catch(() => []);

  const nowMs = Date.now();
  // CF-PARALLEL-REFRACTOR-ALIAS (Drew, 2026-07-18): match the
  // soldCompsStore normalization so same-parallel comps under
  // alias variants ("Blue" vs "Blue Refractor") aren't classified
  // as siblings in this rung.
  const stripRefr = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, "");
  const targetKey = stripRefr(targetParallel);
  // CF-CROSS-PARALLEL-AUTO-BOUNDARY (Drew, 2026-07-20). Same as
  // sibling-parallel: filter out siblings whose isAuto is opposite
  // of the target. When cardIds are properly-scoped per SKU this
  // filter is a no-op; when a cardId conflates auto + non-auto it
  // prevents the wrong-boundary sibling from poisoning the anchor.
  const wantAuto = detectIsAuto(input);
  const normalized: Array<{
    price: number;
    soldAt: string;
    source: string;
    parallel: string | null;
    verifiedByUser: boolean;
    normalizedFromParallel: string | null;
    normalizationRatio: number;
  }> = [];
  let droppedCrossAuto = 0;

  for (const c of allComps) {
    const soldMs = Date.parse(c.soldAt ?? "");
    if (!Number.isFinite(soldMs)) continue;
    if (nowMs - soldMs > MAX_POOL_AGE_DAYS * MS_PER_DAY) continue;
    if ((c as { flaggedWrong?: boolean }).flaggedWrong === true) continue;
    // sold_comps has isAuto as a proper boolean field — trust it.
    if ((c as { isAuto?: boolean }).isAuto === true !== wantAuto) {
      droppedCrossAuto++;
      continue;
    }
    const cParallel = stripRefr((c.parallel ?? "").trim());
    if (cParallel === targetKey) continue;   // handled by rung 1 already
    const sibMult = lookupParallelMultiplier(c.parallel ?? "");
    if (sibMult === null || sibMult <= 0) continue;
    const ratio = targetMult / sibMult;
    // Guard: don't normalize across implausible ratios.
    if (ratio < 0.15 || ratio > 6.5) continue;
    const price = c.price * ratio;
    if (!Number.isFinite(price) || price <= 0) continue;
    normalized.push({
      price,
      soldAt: c.soldAt,
      source: c.source,
      parallel: c.parallel,
      verifiedByUser: c.verifiedByUser === true,
      normalizedFromParallel: c.parallel,
      normalizationRatio: ratio,
    });
  }
  if (droppedCrossAuto > 0) {
    console.log(JSON.stringify({
      event: "cross_parallel_cross_auto_filtered",
      source: "canonicalFmv.tryCrossParallel",
      cardId,
      wantAuto,
      droppedCrossAuto,
      keptNormalized: normalized.length,
    }));
  }
  if (normalized.length === 0) return null;

  const projection = projectNextSaleFromComps(
    normalized.map((n) => ({ price: n.price, soldDate: n.soldAt })),
    { broaderTrendPctPerMonth: trendPctPerMonth, forwardDays: 0, minNForRegression: 3 },
  );
  if (!projection || projection.nextSaleValue <= 0) return null;

  return {
    fmv: projection.nextSaleValue,
    method: "cross-parallel",
    // Rung 2 is inherently noisier than rung 1 — 40% haircut on the
    // projection's own confidence.
    confidence: Math.min(0.7, projection.confidence * 0.6),
    provenance: {
      summary: `${normalized.length} sibling-parallel comp${normalized.length === 1 ? "" : "s"} × parallel ratio + ${
        trendPctPerMonth === null ? "no trend" : `${trendPctPerMonth.toFixed(1)}%/mo trend`
      }`,
      comps: normalized.slice(0, 8).map((n) => ({
        price: n.price,
        soldAt: n.soldAt,
        source: n.source,
        parallel: n.parallel,
        verifiedByUser: n.verifiedByUser,
        normalizedFromParallel: n.normalizedFromParallel,
        normalizationRatio: n.normalizationRatio,
      })),
      trendPctPerMonth,
      multipliers: { targetParallel: targetMult },
    },
    computedAt: new Date().toISOString(),
  };
}

// ─── Rung 3: different cardId, same product + parallel, year-adjusted ─
//
// CF-RUNG-3-NEIGHBOR-PARALLEL (Drew, 2026-07-18). When rungs 1 and 2
// both fail (no same-parallel comps for this specific cardId, no
// sibling-parallel comps for this cardId either), pull sales for the
// SAME product-family and SAME parallel from a DIFFERENT year's
// cardIds. Adjust the resulting price by yearDeltaMultiplier — a card
// from an older year typically trades at 70-90% of the current-year
// equivalent, older still at 50-70%.
//
// Data source: ch_daily_sales queried directly. Rung 3 does NOT
// ingest to sold_comps (would attribute to wrong cardId + would
// contaminate the pool over time); it produces a one-shot projection
// with lower confidence.
//
// Requirements to fire:
//   - input.product (needed to filter ch_daily_sales by card_set)
//   - input.parallel (needed to match variant)
//   - input.cardYear (needed for year-delta calculation)
async function tryNeighborParallel(
  cardId: string,
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  if (!input.product || !input.parallel || typeof input.cardYear !== "number") return null;
  const container = await getChDailyContainer();
  if (!container) return null;

  try {
    const graderQuery = input.gradeCompany && input.gradeValue !== null && input.gradeValue !== undefined
      ? `${input.gradeCompany.toUpperCase()} ${input.gradeValue}`
      : "Raw";
    const cutoff = new Date(Date.now() - MAX_POOL_AGE_DAYS * MS_PER_DAY).toISOString();
    // Product-family LIKE match — "2026 Bowman Chrome" matches "2026
    // Bowman Chrome Prospects", "2026 Bowman Chrome Baseball", etc.
    // Strip the year for the LIKE token so we match sibling years.
    const productToken = input.product
      .replace(/^\s*(?:19|20)\d{2}\s*/, "")   // strip leading year
      .trim();
    if (!productToken) return null;
    const productLike = `%${productToken}%`;

    // Case-insensitive variant equality is done in-code (Cosmos SQL
    // string ops are less forgiving than string.toLowerCase compare).
    const iter = container.items.query<{
      card_id: string;
      year: number;
      card_set: string;
      variant: string;
      number: string;
      price: number;
      sale_date: string;
      image_url: string | null;
    }>({
      query: `SELECT TOP 100 c.card_id, c.year, c.card_set, c.variant, c.number,
                              c.price, c.sale_date, c.image_url
              FROM c
              WHERE CONTAINS(LOWER(c.card_set), LOWER(@productLike))
                AND c.year != @targetYear
                AND c.grade = @grader
                AND c.sale_date >= @cutoff
                AND c.price > 0
              ORDER BY c.sale_date DESC`,
      parameters: [
        { name: "@productLike", value: productToken.toLowerCase() },
        { name: "@targetYear", value: input.cardYear },
        { name: "@grader", value: graderQuery },
        { name: "@cutoff", value: cutoff },
      ],
    });
    const { resources } = await iter.fetchAll();

    // Filter to same-parallel rows in memory (variant string).
    // CF-NEIGHBOR-PARALLEL-AUTO-BOUNDARY-REVERT (Drew, 2026-07-20):
    // dropped the isAutoRow text filter — CH's card_set for auto rows
    // is generic "Bowman Baseball" (no "auto" token), so classifying
    // by /auto|autograph/i incorrectly filtered legitimate siblings.
    // The neighbor-year data still filters on strict variant match
    // and productToken family — cross-boundary pollution across
    // years is bounded to variant text mismatches, not card_set.
    const stripRefr = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, "");
    const targetParallelNorm = stripRefr(input.parallel);
    const matches = resources.filter((r) => stripRefr(r.variant ?? "") === targetParallelNorm);
    if (matches.length === 0) return null;

    // For each neighbor sale, apply year-delta multiplier.
    // yearDeltaMultiplier(neighborYear, targetYear) returns the ratio
    // to normalize a neighbor-year price to a target-year price.
    const { yearDeltaMultiplier } = await import("./neighborMultipliers.js");
    const normalized: Array<{ price: number; soldDate: string; sourceYear: number; ratio: number }> = [];
    for (const r of matches) {
      const ratio = yearDeltaMultiplier(r.year, input.cardYear);
      if (!Number.isFinite(ratio) || ratio <= 0) continue;
      const price = r.price * ratio;
      if (!Number.isFinite(price) || price <= 0) continue;
      // Guard against wild ratios — same as rung 2's band.
      if (ratio < 0.2 || ratio > 5.0) continue;
      normalized.push({
        price,
        soldDate: r.sale_date,
        sourceYear: r.year,
        ratio,
      });
    }
    if (normalized.length === 0) return null;

    const projection = projectNextSaleFromComps(
      normalized.map((n) => ({ price: n.price, soldDate: n.soldDate })),
      {
        broaderTrendPctPerMonth: trendPctPerMonth,
        forwardDays: 0,
        minNForRegression: 3,
      },
    );
    if (!projection || projection.nextSaleValue <= 0) return null;

    // Rung 3 confidence: cap at 0.55 — neighbor-year data is
    // informative but two-hops-noisy (variant match may drift, year
    // ratio may not fully absorb the market cycle).
    const confidence = Math.min(0.55, projection.confidence * 0.7);

    return {
      fmv: projection.nextSaleValue,
      method: "neighbor-parallel",
      confidence,
      provenance: {
        summary: `${normalized.length} neighbor-year comp${normalized.length === 1 ? "" : "s"} for ${input.parallel} × year-delta + ${
          trendPctPerMonth === null ? "no trend" : `${trendPctPerMonth.toFixed(1)}%/mo trend`
        }`,
        comps: normalized.slice(0, 8).map((n) => ({
          price: n.price,
          soldAt: n.soldDate,
          source: "cardhedge",
          parallel: input.parallel ?? null,
          verifiedByUser: false,
          normalizedFromParallel: `${n.sourceYear} ${input.product ?? ""}`,
          normalizationRatio: n.ratio,
        })),
        trendPctPerMonth,
        multipliers: {
          // Median year-delta ratio applied across the neighbor pool;
          // per-row ratios are in provenance.comps[].normalizationRatio.
          yearDeltaMedian: normalized.length > 0
            ? Math.round(normalized.map((n) => n.ratio).sort((a, b) => a - b)[Math.floor(normalized.length / 2)] * 1000) / 1000
            : 1,
        },
      },
      computedAt: new Date().toISOString(),
    };
  } catch { return null; }
  void cardId;
}

// ─── Rung 4: family-baseline compound-multiplier ──────────────────────
//
// Wraps computeGuestimate (services/compiq/guestimatePricing.ts) — the
// existing family-baseline × player-tier × parallel × auto × grade ×
// era engine. Rung 4 is stronger than rung 5 because guestimate
// consumes richer input signals (player tier, print run, real family
// medians) even though both are ultimately model outputs, not direct
// transactions.
//
// Guestimate itself requires a familyBaseRawPrice input — we derive
// it from productTierBaseFor (same table as rung 5). When product is
// unknown, rung 4 returns null and the ladder falls through to rung 5.
/** CF-SIBLING-PARALLEL-RUNG (Drew, 2026-07-19). Bridge rung between
 *  neighbor-parallel and the no-basis gate. Uses OTHER parallels of
 *  the same (year, cardNumber, product) as a pricing signal for
 *  scarce numbered parallels that haven't traded recently.
 *
 *  Anchor = median across per-variant medians. Excludes Base (huge
 *  print run drags estimate too low) and excludes the target parallel
 *  itself. Confidence 0.35 — bridge estimate, not a direct comp.
 *
 *  Guard: min 3 distinct sibling parallels with at least 1 sale each.
 *  Fewer than that produces an unstable anchor.
 *
 *  Grader match: if input is graded, filter siblings to that grader
 *  (mixing raw and PSA 10 sibling data would poison the anchor). Raw
 *  request → only raw siblings.
 */
async function trySiblingParallel(
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  if (!input.cardNumber || !input.cardYear || !input.product) return null;
  const parallel = (input.parallel ?? "").trim();
  if (parallel === "" || parallel.toLowerCase() === "base") return null;

  const container = await getChDailyContainer();
  if (!container) return null;

  const graderQuery = input.gradeCompany && input.gradeValue !== null && input.gradeValue !== undefined
    ? `${input.gradeCompany.toUpperCase()} ${input.gradeValue}`
    : "Raw";
  const cutoff = new Date(Date.now() - MAX_POOL_AGE_DAYS * MS_PER_DAY).toISOString();
  const productToken = extractProductFamilyToken(input.product);
  // CF-SIBLING-PARALLEL-AUTO-BOUNDARY-REVERT (Drew, 2026-07-20). The
  // prior isAutoRow text-based filter over-dropped legitimate siblings.
  // CH tags auto cards' card_set as generic "2026 Bowman Baseball"
  // (no "auto" token in card_set OR variant text), so classifying rows
  // by /auto|autograph/i incorrectly dropped 100% of siblings for
  // auto-prefix cardNumbers like CPA-BA (Antunez auto). Since this
  // query filters by strict cardNumber match AND CH's card numbering
  // conventions (CPA-/BCPA-/BSPA-/CDA-/BCDA-/BDCA-/PA- prefixes ARE
  // the auto/non-auto boundary), all returned rows share the same
  // auto tier as the target by construction. No filter needed.

  try {
    const { resources } = await container.items.query<{
      variant: string;
      price: number;
      sale_date: string;
    }>({
      query: `SELECT c.variant, c.price, c.sale_date
              FROM c
              WHERE c.number = @cn
                AND c.year = @yr
                AND c.grade = @grader
                AND CONTAINS(LOWER(c.card_set), @productToken)
                AND c.sale_date >= @cutoff
                AND c.price > 0`,
      parameters: [
        { name: "@cn", value: input.cardNumber },
        { name: "@yr", value: input.cardYear },
        { name: "@grader", value: graderQuery },
        { name: "@productToken", value: productToken },
        { name: "@cutoff", value: cutoff },
      ],
    }).fetchAll();

    if (resources.length === 0) return null;

    // Group by variant, excluding Base and the target parallel itself.
    const stripRefr = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, "");
    const target = stripRefr(parallel);
    const byVariant = new Map<string, number[]>();
    for (const r of resources) {
      const v = (r.variant ?? "").trim();
      const vNorm = stripRefr(v);
      if (vNorm === "" || vNorm === "base" || vNorm === target) continue;
      if (!Number.isFinite(r.price) || r.price <= 0) continue;
      const arr = byVariant.get(v) ?? [];
      arr.push(r.price);
      byVariant.set(v, arr);
    }
    if (byVariant.size < 3) return null;

    // Per-variant median → median across the per-variant medians.
    const variantMedians: Array<{ variant: string; median: number; n: number }> = [];
    for (const [variant, prices] of byVariant) {
      const sorted = prices.slice().sort((a, b) => a - b);
      variantMedians.push({
        variant,
        median: sorted[Math.floor(sorted.length / 2)],
        n: sorted.length,
      });
    }
    const medians = variantMedians.map((v) => v.median).sort((a, b) => a - b);
    const anchor = medians[Math.floor(medians.length / 2)];
    if (!Number.isFinite(anchor) || anchor <= 0) return null;

    // Apply trend if present. Sibling anchor is a "current-price"
    // snapshot; we project ~0 days forward to keep the estimate as
    // "worth today" rather than an aggressive forward projection.
    const fmv = Math.round(anchor * 100) / 100;

    return {
      fmv,
      method: "sibling-parallel",
      confidence: 0.35,
      provenance: {
        summary: `sibling-parallel estimate from ${variantMedians.length} sibling variants of #${input.cardNumber} in ${input.cardYear} ${productToken}`,
        comps: variantMedians.slice(0, 10).map((v) => ({
          price: v.median,
          soldAt: new Date().toISOString(),
          source: "cardhedge",
          parallel: v.variant,
          verifiedByUser: false,
        })),
        trendPctPerMonth,
        multipliers: {
          siblingVariantCount: variantMedians.length,
          siblingMedianOfMedians: anchor,
        },
      },
      computedAt: new Date().toISOString(),
    };
  } catch { return null; }
}

/** Extract a family token for LOWER-CONTAINS matching against
 *  ch_daily_sales.card_set. e.g. "2026 Bowman Chrome Prospects" →
 *  "bowman chrome" (the most distinctive multi-word token). Falls
 *  back to the first two words of the product. */
function extractProductFamilyToken(product: string): string {
  const lower = product.toLowerCase();
  if (lower.includes("bowman chrome")) return "bowman chrome";
  if (lower.includes("bowman draft")) return "bowman draft";
  if (lower.includes("bowman")) return "bowman";
  if (lower.includes("topps chrome")) return "topps chrome";
  if (lower.includes("panini prizm")) return "panini prizm";
  if (lower.includes("panini donruss") || lower.includes("donruss")) return "donruss";
  if (lower.includes("topps")) return "topps";
  return lower.split(/\s+/).slice(0, 2).join(" ");
}

async function tryFamilyBaseline(
  _cardId: string,
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  const productBase = productTierBaseFor(input.product ?? null);
  if (productBase === null) return null;
  const familyLabel = String(input.product ?? "unknown");
  const gradeTier = gradeTierLabel(input.gradeCompany ?? null, input.gradeValue ?? null);
  const nowYear = new Date().getUTCFullYear();
  const ageYears = typeof input.cardYear === "number" ? Math.max(0, nowYear - input.cardYear) : null;
  const isAuto = detectIsAuto(input);
  const playerTier = derivePlayerTier(input.player ?? null);

  const g = computeGuestimate({
    familyBaseRawPrice: productBase,
    familyLabel,
    playerTier,
    parallel: input.parallel ?? null,
    gradeTier,
    printRun: null,   // caller doesn't know print-run here; guestimate
                     //  will skip that multiplier
    isAuto,
    ageYears,
  });
  if (!g || !Number.isFinite(g.price) || g.price <= 0) return null;

  // Apply broader trend forward by 1 month (matches other rungs).
  const monthlyPct = trendPctPerMonth ?? 0;
  const projected = g.price * (1 + monthlyPct / 100);

  // Guestimate's own confidence tier → numeric; rung 4 caps below rung 3.
  const confidenceMap: Record<string, number> = {
    estimate: 0.35,
    rough: 0.28,
    ballpark: 0.22,
    insufficient: 0.15,
  };
  const confidence = confidenceMap[g.confidence] ?? 0.22;

  return {
    fmv: Math.round(projected * 100) / 100,
    method: "family-baseline",
    confidence,
    provenance: {
      summary: `guestimate: ${familyLabel} baseline × player-${playerTier} × parallel × ${isAuto ? "auto" : "no-auto"} × ${gradeTier} × era + ${monthlyPct.toFixed(1)}%/mo trend (${g.confidence} tier, ${g.hops} hops)`,
      comps: [],
      trendPctPerMonth,
      multipliers: {
        familyBase: productBase,
        guestimatePrice: g.price,
      },
    },
    computedAt: new Date().toISOString(),
  };
}

function gradeTierLabel(company: string | null, value: number | null): string {
  if (!company || value === null) return "Raw";
  return `${company.toUpperCase()} ${value}`;
}

/** Heuristic player tier from player name. Real production uses a
 *  player-tier registry (portfolioiq.playerTierRegistry) — we default
 *  to "prospect" here so most cards get a reasonable multiplier. Once
 *  the registry is wired, replace this with a lookup. */
function derivePlayerTier(_playerName: string | null): PlayerTier {
  return "prospect";
}

// ─── Rung 5: product-tier cold-start ──────────────────────────────────
//
// Last-resort fallback. Every input with at least (cardId, product) gets
// a defensible ballpark so iOS never renders a hard null. Confidence
// stays low (0.15-0.2) and iOS should render a "estimate only" chip.
//
// Formula:
//   fmv = productTierBase(product) × autoMultiplier × parallelMultiplier
//         × gradeMultiplier × eraDecay
//
// Where:
//   productTierBase: hardcoded per family (Bowman Chrome $8 base, Prizm
//     $5, Panini Select $6, etc.). Base is Raw base non-auto median.
//   autoMultiplier: 6× when isAuto/cardNumber-implies-auto, else 1×.
//   parallelMultiplier: lookupParallelMultiplier fallback.
//   gradeMultiplier: 4× PSA 10, 1.6× PSA 9, 1× raw, etc.
//   eraDecay: shared with guestimate; deprecates older cards.
async function tryProductTier(
  _cardId: string,
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  const productBase = productTierBaseFor(input.product ?? null);
  if (productBase === null) return null;

  const isAuto = detectIsAuto(input);
  const autoMultiplier = isAuto ? 6 : 1;
  const parallelMult = input.parallel
    ? (lookupParallelMultiplier(input.parallel) ?? 1)
    : 1;
  const productFamily = classifyFamily(input.product);
  const gradeMult = gradeTierMultiplier(input.gradeCompany ?? null, input.gradeValue ?? null, productFamily, inferSportFromContext(input.product ?? null, null));
  const era = eraDecayForYear(input.cardYear ?? null);

  const raw = productBase * autoMultiplier * parallelMult * gradeMult * era;
  // CF-FORWARD-WINDOW-0D: canonical FMV is "worth today," no forward
  // extrapolation. Rungs 4-5 are model-based rather than transaction-
  // anchored, so there's no anchor-date to backfill from — return the
  // raw model output as-is.
  const projected = raw;
  const monthlyPct = trendPctPerMonth ?? 0;
  void monthlyPct;   // recorded in provenance below

  if (!Number.isFinite(projected) || projected <= 0) return null;

  return {
    fmv: Math.round(projected * 100) / 100,
    method: "product-tier",
    confidence: 0.18,
    provenance: {
      summary: `product-tier fallback: ${input.product ?? "generic"} × auto${isAuto ? "" : "-not"} × parallel × grade × era + ${monthlyPct.toFixed(1)}%/mo trend`,
      comps: [],
      trendPctPerMonth,
      multipliers: {
        productBase,
        auto: autoMultiplier,
        parallel: parallelMult,
        grade: gradeMult,
        era,
      },
    },
    computedAt: new Date().toISOString(),
  };
}

/** Product-family base price ($) for a Raw non-auto base card. Hardcoded
 *  medians from recent aggregate data; refresh periodically. Unknown
 *  families return null so rung 5 becomes no-basis for unrecognized
 *  products. */
function productTierBaseFor(product: string | null): number | null {
  if (!product) return null;
  const p = product.toLowerCase();
  if (/bowman.*chrome.*draft/i.test(p)) return 12;
  if (/bowman.*chrome/i.test(p)) return 8;
  if (/bowman.*sterling/i.test(p)) return 20;
  if (/bowman(?!.*chrome|.*sterling)/i.test(p)) return 4;
  if (/topps.*chrome.*update/i.test(p)) return 6;
  if (/topps.*chrome/i.test(p)) return 5;
  if (/topps.*update/i.test(p)) return 3;
  if (/topps(?!.*chrome|.*update)/i.test(p)) return 2;
  if (/panini.*prizm/i.test(p)) return 5;
  if (/panini.*select/i.test(p)) return 6;
  if (/panini.*mosaic/i.test(p)) return 3;
  if (/panini.*donruss/i.test(p)) return 2;
  if (/panini.*optic/i.test(p)) return 4;
  if (/upper deck/i.test(p)) return 4;
  return null;
}

function detectIsAuto(input: CanonicalFmvInput): boolean {
  const cn = (input.cardNumber ?? "").toUpperCase();
  return /^(CPA-|BCPA-|BSPA-|CDA-|BCDA-|BDCA-|PA-)/i.test(cn);
}

/** CF-GRADE-CALIBRATION-INTEGRATION (Drew, 2026-07-18). Grade-tier
 *  multiplier now sources from empirical per-family per-grader ratios
 *  in gradeCalibrationConfig.ts (computed from 365d of ch_daily_sales).
 *
 *  Lookup order:
 *   1. product-family + grader → empirical median ratio (best signal)
 *   2. product-family missing / uncovered → hardcoded fallback per grader
 *   3. company unknown → 1× (safe raw-equivalent)
 *
 *  Sub-tier scaling: the calibration lumps all PSA/BGS/SGC grades of a
 *  company together (ch_daily_sales.grader is company-level). To
 *  approximate per-grade-value, apply a downstream scaling factor:
 *   - Top grade (10.0):     × 1.00  (full empirical ratio)
 *   - Near-top (9.5):       × 0.65
 *   - Below (9.0):          × 0.35
 *   - Way below (< 9):      × 0.20
 *
 *  Once ch_daily_sales sold-data includes explicit grade values, refine
 *  the calibration script to per-tier granularity and drop this scaler.
 */
function gradeTierMultiplier(
  company: string | null,
  value: number | null,
  productFamily: string | null,
  sport?: string | null,
): number {
  if (!company || value === null) return 1;   // raw
  const c = company.toUpperCase();

  // Sub-tier scaling — top grade gets the full empirical ratio.
  const subTierScale = value >= 10 ? 1.0
    : value >= 9.5 ? 0.65
    : value >= 9 ? 0.35
    : 0.20;

  // CF-GRADE-CALIBRATION-SPORT (Drew, 2026-07-20). Sport-aware
  // empirical lookup: passes sport to prefer per-sport calibration
  // (basketball/football rookies have very different PSA 10 uplifts
  // than baseball). Falls back to baseline table when sport-specific
  // isn't populated yet.
  if (productFamily) {
    const empiricalRatio = lookupGradeRatio(productFamily, c, sport ?? null);
    if (empiricalRatio !== null && Number.isFinite(empiricalRatio) && empiricalRatio > 0) {
      return empiricalRatio * subTierScale;
    }
  }

  // Fallback: hardcoded per-company/per-tier defaults.
  if (c === "PSA") {
    if (value >= 10) return 4;
    if (value >= 9) return 1.6;
    if (value >= 8) return 1.2;
    return 1;
  }
  if (c === "BGS") {
    if (value >= 10) return 5;
    if (value >= 9.5) return 3;
    if (value >= 9) return 1.5;
    return 1;
  }
  if (c === "SGC") {
    if (value >= 10) return 3;
    if (value >= 9.5) return 2;
    return 1;
  }
  if (c === "CGC") {
    if (value >= 10) return 3.5;
    if (value >= 9.5) return 2;
    return 1;
  }
  return 1;
}

/** Shared era decay: <1y = 1.2× (hot), <2y = 1.0×, <4y = 0.85×, else 0.7×. */
function eraDecayForYear(cardYear: number | null): number {
  if (cardYear === null) return 1;
  const nowYear = new Date().getUTCFullYear();
  const age = nowYear - cardYear;
  if (age < 0) return 1;
  if (age < 1) return 1.2;
  if (age < 2) return 1;
  if (age < 4) return 0.85;
  return 0.7;
}
