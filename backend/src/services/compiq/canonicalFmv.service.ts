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

import { readCompsByCardId } from "../portfolioiq/soldCompsStore.service.js";
import { projectNextSaleFromComps } from "./nextSaleProjection.service.js";
import { fetchPlayerInSetMomentum, momentumMultiplierToPctPerMonth } from "./playerInSetMomentum.service.js";
import { lookupParallelMultiplier } from "./neighborMultipliers.js";
import { cacheDel, cacheWrap } from "../shared/cache.service.js";

export type CanonicalFmvMethod =
  | "direct-comp"
  | "cross-parallel"
  | "neighbor-parallel"
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
  const cardId = (input.cardId ?? "").trim();
  if (!cardId) return NULL_RESULT("missing cardId");

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

  // ── Rung 1: direct-comp ────────────────────────────────────────────
  const directResult = await tryDirectComp(cardId, input, trendPctPerMonth);
  if (directResult) return directResult;

  // ── Rung 2: cross-parallel ─────────────────────────────────────────
  const crossResult = await tryCrossParallel(cardId, input, trendPctPerMonth);
  if (crossResult) return crossResult;

  // ── Rung 3: neighbor-parallel ──────────────────────────────────────
  // Same product family, same parallel, different cardId. NOT WIRED YET
  // in this initial cut — requires reference-catalog / family-lookup
  // integration. See tryNeighborParallel below (returns null placeholder).
  const neighborResult = await tryNeighborParallel(cardId, input, trendPctPerMonth);
  if (neighborResult) return neighborResult;

  // ── Rung 4: family-baseline ────────────────────────────────────────
  // Guestimate compound-multiplier restated. NOT WIRED YET — will
  // wrap the existing guestimate helper. Returns null for now.
  const familyResult = await tryFamilyBaseline(cardId, input, trendPctPerMonth);
  if (familyResult) return familyResult;

  // ── Rung 5: product-tier ────────────────────────────────────────────
  // Cold-start last resort. NOT WIRED YET.
  const tierResult = await tryProductTier(cardId, input, trendPctPerMonth);
  if (tierResult) return tierResult;

  // Every rung fell through — honest no-basis.
  return NULL_RESULT("no rung produced a value");
}

// ─── Rung 1: direct same-parallel same-grade comps ────────────────────
async function tryDirectComp(
  cardId: string,
  input: CanonicalFmvInput,
  trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  const comps = await readCompsByCardId({
    cardId,
    sources: ["ebay-user-purchase", "ebay-user-sale", "manual-user-entry"],
    parallel: input.parallel ?? undefined,
    gradeCompany: input.gradeCompany ?? undefined,
    gradeValue: input.gradeValue ?? undefined,
  }).catch(() => []);

  const nowMs = Date.now();
  const fresh = comps.filter((c) => {
    const soldMs = Date.parse(c.soldAt ?? "");
    if (!Number.isFinite(soldMs)) return false;
    if (nowMs - soldMs > MAX_POOL_AGE_DAYS * MS_PER_DAY) return false;
    if ((c as { flaggedWrong?: boolean }).flaggedWrong === true) return false;
    return true;
  });
  if (fresh.length === 0) return null;

  const projection = projectNextSaleFromComps(
    fresh.map((c) => ({ price: c.price, soldDate: c.soldAt })),
    { broaderTrendPctPerMonth: trendPctPerMonth },
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
  const targetKey = targetParallel.toLowerCase().replace(/\s+/g, " ");
  const normalized: Array<{
    price: number;
    soldAt: string;
    source: string;
    parallel: string | null;
    verifiedByUser: boolean;
    normalizedFromParallel: string | null;
    normalizationRatio: number;
  }> = [];

  for (const c of allComps) {
    const soldMs = Date.parse(c.soldAt ?? "");
    if (!Number.isFinite(soldMs)) continue;
    if (nowMs - soldMs > MAX_POOL_AGE_DAYS * MS_PER_DAY) continue;
    if ((c as { flaggedWrong?: boolean }).flaggedWrong === true) continue;
    const cParallel = (c.parallel ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
  if (normalized.length === 0) return null;

  const projection = projectNextSaleFromComps(
    normalized.map((n) => ({ price: n.price, soldDate: n.soldAt })),
    { broaderTrendPctPerMonth: trendPctPerMonth },
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
async function tryNeighborParallel(
  _cardId: string,
  _input: CanonicalFmvInput,
  _trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  // TODO(follow-on): reference-catalog lookup to resolve the sibling
  // cardId for (product, year - N, cardNumber-ish, parallel). Uses
  // yearDeltaMultiplier + projectNextSaleFromComps on that neighbor's
  // pool. Requires either a per-family neighbor index or a cross-
  // partition query over sold_comps by (product + parallel + grade).
  //
  // Deferred: needs a design pass on the neighbor-index shape before
  // shipping so we don't lock in an inefficient query pattern.
  return null;
}

// ─── Rung 4: family-baseline compound-multiplier ──────────────────────
async function tryFamilyBaseline(
  _cardId: string,
  _input: CanonicalFmvInput,
  _trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  // TODO(follow-on): wrap the existing guestimate compound-multiplier
  // (family baseline × player tier × parallel × auto premium × print
  // run × grade × era decay). Existing helper lives in
  // compiqEstimate.service.ts (`buildGuestimatePricing` or similar).
  // Restating it here consolidates the fallback so every consumer
  // gets the same guestimate output.
  return null;
}

// ─── Rung 5: product-tier cold-start ──────────────────────────────────
async function tryProductTier(
  _cardId: string,
  _input: CanonicalFmvInput,
  _trendPctPerMonth: number | null,
): Promise<CanonicalFmvResult | null> {
  // TODO(follow-on): last-resort category × era × grade tier × trend.
  // Confidence floor 0.15-0.2. Emits an explicit "cold-start" method
  // so iOS can render a "estimate only" chip.
  return null;
}
