/**
 * CF-ONE-VALUATION-PATH (D16, 2026-08-30). The four pricing routes' wire
 * shapes, each derived from ONE Valuation (oneValuationPath.service). Pure:
 * no engine is called here — tests/oneValuationPath.pin.test.ts fails if one
 * is — so the only way a route's number can move is the entry's.
 *
 * Shapes are the ones iOS and web already decode (HobbyIQ/CanonicalFmvModels
 * .swift, CompIQSearchModels.swift CompIQPriceByIdResponse, CompIQCardGrades
 * .swift, apps/web/src/lib/api.ts). Every surface now also carries:
 *   rungLabel     the rung in the closed vocabulary (fmvRung.ts)
 *   valueSource   observed | estimated | unavailable
 *   identity      the catalog identity priced (slug, setKey, …)
 *   fmvReason     why there is no number, when there is none
 * Additive fields; both decoders ignore unknown keys.
 */
import type { Valuation, ValuationIdentity } from "./oneValuationPath.service.js";
import { isExactPoolRung, type FmvRungLabel } from "./fmvRung.js";
import {
  computeCanonicalBuyPrice,
  type CanonicalFmvMethod,
  type CanonicalFmvResult,
} from "./canonicalFmv.service.js";
import type { HobbyIqFmvMethod, HobbyIqFmvResult } from "../portfolioiq/hobbyIqFmv.service.js";
import type { ObservedGradeEntry } from "./observedGradeCurve.service.js";
import { gradeCurveEntryLabel } from "./gradeCurveEntry.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const CANONICAL_METHODS: ReadonlySet<string> = new Set<CanonicalFmvMethod>([
  "direct-comp", "cross-parallel", "neighbor-parallel", "sibling-parallel", "hot-raw-same-card-anchor",
  "family-baseline", "product-tier", "tiered-momentum-card", "tiered-momentum-player", "no-basis",
  "grade-curve-estimate", "cross-setkey", "cross-printrun", "same-printrun-cross-parallel",
  "printrun-discovery", "grade-cross-raw", "composite-neighbor", "rare-card-anchor",
]);
const HOBBYIQ_METHODS: ReadonlySet<string> = new Set<HobbyIqFmvMethod>([
  "direct-slug", "cross-setkey", "cross-printrun", "same-printrun-cross-parallel", "printrun-discovery",
  "sibling-parallel", "family-baseline", "grade-cross-raw", "composite-neighbor", "rare-card-anchor", "no-basis",
]);

/** canonical-fmv's `method` for a rung: the exact pool is direct-comp; a
 *  cross-grade fill is grade-cross-raw; the ladder rungs keep their names. */
export function canonicalMethodForRung(rung: FmvRungLabel): CanonicalFmvMethod {
  if (isExactPoolRung(rung)) return "direct-comp";
  if (rung === "cross-grade-fallback") return "grade-cross-raw";
  if (rung === "sibling-estimate") return "sibling-parallel";
  if (CANONICAL_METHODS.has(rung)) return rung as CanonicalFmvMethod;
  return "family-baseline";
}

/** hobbyiq-fmv's `method` for a rung: the exact pool is direct-slug; a
 *  cross-grade fill is grade-cross-raw; the ladder rungs keep their names. */
export function hobbyIqMethodForRung(rung: FmvRungLabel): HobbyIqFmvMethod {
  if (isExactPoolRung(rung)) return "direct-slug";
  if (rung === "cross-grade-fallback" || rung === "grade-curve-estimate") return "grade-cross-raw";
  if (rung === "sibling-estimate") return "sibling-parallel";
  if (HOBBYIQ_METHODS.has(rung)) return rung as HobbyIqFmvMethod;
  return "family-baseline";
}

function recentRangeFrom(sales: ReadonlyArray<{ price: number }>): CanonicalFmvResult["recentRange"] {
  const prices = sales.map((s) => Number(s.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const pct = (p: number): number => (prices.length === 1 ? prices[0] : prices[Math.floor((prices.length - 1) * p)]);
  return { n: prices.length, min: round2(prices[0]), p25: round2(pct(0.25)), median: round2(pct(0.5)), p75: round2(pct(0.75)), max: round2(prices[prices.length - 1]) };
}

function gradeNumberOf(entry: ObservedGradeEntry): number | null {
  const m = String(entry.grade).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function confidenceTier(score: number | null | undefined): "estimate" | "rough" | "ballpark" | "no-data" {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return "no-data";
  if (n >= 0.70) return "estimate";
  if (n >= 0.45) return "rough";
  return "ballpark";
}

/** The identity block every wire carries. `card_id` / `slug` are the
 *  catalog slug (the requested id when unresolved). */
export function wireIdentity(identity: ValuationIdentity): Record<string, unknown> {
  const id = identity.slug ?? identity.requestedId;
  const prettySetKey = String(identity.setKey ?? "").split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return {
    card_id: id,
    slug: identity.slug,
    sport: identity.sport,
    year: identity.year,
    set: identity.setName ?? (prettySetKey || null),
    setKey: identity.setKey,
    number: identity.cardNumber,
    cardNumber: identity.cardNumber,
    parallel: identity.parallel,
    isAuto: identity.isAuto,
    printRun: identity.printRun,
    player: identity.playerName,
    playerName: identity.playerName,
    imageUrl: identity.imageUrl,
  };
}

// ─── POST /api/compiq/hobbyiq-fmv ────────────────────────────────────────────

export function toHobbyIqFmvResponse(
  v: Valuation,
  opts: { previewLimit?: number } = {},
): HobbyIqFmvResult & { identity: Record<string, unknown>; valueSource: Valuation["valueSource"]; fmvReason: Valuation["reason"] } {
  const previewLimit = Math.max(0, Math.trunc(opts.previewLimit ?? 10));
  const identity = wireIdentity(v.identity);
  const extras = { identity, valueSource: v.valueSource, fmvReason: v.reason };
  // The gated ladder answered: its envelope IS the answer (comp breakdown,
  // population, quality); the number and the label are the valuation's.
  if (v.fallback && v.valueSource === "estimated" && v.fallback.rungLabel === v.rungLabel && v.fairMarketValue !== null) {
    return {
      ...v.fallback,
      slug: v.identity.slug ?? v.fallback.slug,
      fmv: v.fairMarketValue,
      rungLabel: v.rungLabel,
      recentComps: v.fallback.recentComps.slice(0, previewLimit),
      ...extras,
    };
  }
  const bySource: Record<string, number> = {};
  for (const s of v.sales) { const k = s.source ?? "sold_comps"; bySource[k] = (bySource[k] ?? 0) + 1; }
  const method = v.fairMarketValue === null ? "no-basis" : hobbyIqMethodForRung(v.rungLabel);
  return {
    slug: v.identity.slug ?? v.identity.requestedId,
    fmv: v.fairMarketValue,
    compCount: v.compsUsed,
    min: v.weightedMedian,
    max: v.predictedPrice,
    breakdown: {
      bySource,
      byAutoStyle: { onCard: 0, sticker: 0, unknown: v.sales.length },
      byGradeQualifier: {},
    },
    trend: {
      direction: v.trend.direction,
      slopePerMonthPct: v.trend.pctPerWeek != null ? round2(v.trend.pctPerWeek * (30 / 7)) : 0,
      method: isExactPoolRung(v.rungLabel) && v.trend.pctPerWeek != null ? "regression" : "none",
    },
    recentComps: v.sales.slice(0, previewLimit).map((s) => ({
      price: s.price,
      soldAt: s.soldAt,
      source: s.source ?? "sold_comps",
      parallel: v.identity.parallel,
      autoStyle: null,
      gradeQualifier: null,
      url: null,
    })),
    method,
    rungLabel: v.rungLabel,
    basisNote: v.basis || (v.fairMarketValue === null ? "No comparable sales in the last 180 days" : ""),
    confidence: v.confidence,
    population: null,
    quality: {
      score: v.confidence,
      flaggedCompCount: 0,
      sources: Object.keys(bySource).length > 0 ? Object.keys(bySource) : (v.fairMarketValue !== null ? ["unified"] : []),
    },
    computedAt: v.computedAt,
    cachedFrom: "sold_comps",
    ...extras,
  };
}

// ─── POST /api/compiq/canonical-fmv ──────────────────────────────────────────

function ladderFromCurve(v: Valuation): CanonicalFmvResult["gradeLadder"] {
  const priced = v.gradeCurve.filter((e) => typeof e.value === "number" && (e.value as number) > 0);
  if (priced.length === 0) return null;
  const raw = priced.find((e) => gradeCurveEntryLabel(e) === "Raw");
  const anchor = raw?.value ?? v.fairMarketValue;
  if (!anchor || anchor <= 0) return null;
  return {
    family: v.identity.setKey ?? "unknown",
    sampleSize: v.totalSampleCount,
    tiers: priced.map((e) => ({
      grader: gradeCurveEntryLabel(e),
      medianRatio: round2((e.value as number) / anchor),
      fmv: round2(e.value as number),
    })),
  };
}

export function toCanonicalFmvResponse(
  v: Valuation,
): CanonicalFmvResult & { identity: Record<string, unknown>; valueSource: Valuation["valueSource"]; fmvReason: Valuation["reason"]; compsUsed: number } {
  const exact = isExactPoolRung(v.rungLabel);
  const method: CanonicalFmvMethod = v.fairMarketValue === null ? "no-basis" : canonicalMethodForRung(v.rungLabel);
  const result: CanonicalFmvResult = {
    fmv: v.fairMarketValue,
    method,
    rungLabel: v.rungLabel,
    confidence: v.confidence,
    provenance: {
      summary: v.basis,
      // CF-COMP-COUNT-IS-THE-POOL (Drew, 2026-09-02). `compsUsed` is the
      // tier's pool size (see Valuation.compsUsed); `comps` below is the
      // truncated display sample. A reader is told the pool, never the
      // sample length.
      compCount: v.compsUsed,
      comps: v.sales.slice(0, 8).map((s) => ({
        price: s.price,
        soldAt: s.soldAt,
        source: s.source ?? "sold_comps",
        parallel: v.identity.parallel,
        verifiedByUser: false,
      })),
      trendPctPerMonth: v.trend.pctPerWeek != null ? round2(v.trend.pctPerWeek * (30 / 7)) : null,
      multipliers: {},
    },
    computedAt: v.computedAt,
    gradeLadder: ladderFromCurve(v),
    recentRange: exact ? recentRangeFrom(v.sales) : null,
  };
  result.buyPrice = computeCanonicalBuyPrice(result);
  return { ...result, identity: wireIdentity(v.identity), valueSource: v.valueSource, fmvReason: v.reason, compsUsed: v.compsUsed };
}

// ─── POST /api/compiq/price-by-id ────────────────────────────────────────────

export function toPriceByIdResponse(v: Valuation): Record<string, unknown> {
  const id = v.identity.slug ?? v.identity.requestedId;
  const cardIdentity = wireIdentity(v.identity);
  const fmv = v.fairMarketValue;
  const gradedEstimates = v.gradeCurve
    .filter((e) => gradeCurveEntryLabel(e) !== "Raw" && typeof e.value === "number" && (e.value as number) > 0)
    .map((e) => ({
      gradeCompany: e.grader,
      gradeValue: gradeNumberOf(e),
      estimatedValue: round2(e.value as number),
      estimateLow: e.priceRangeLow,
      estimateHigh: e.priceRangeHigh,
      fairMarketValue: null,
      estimateConfidence: confidenceTier(e.confidenceScore),
      estimateBasis: e.rungLabel ?? null,
      rungLabel: e.rungLabel ?? null,
      valueSource: e.valueSource,
      sampleCount: e.sampleCount,
    }));
  if (fmv === null) {
    return {
      success: true,
      cardsightCardId: id,
      cardId: id,
      // iOS reads `source == "no-recent-comps" || marketTier?.value == nil`
      // as its no-data state (CompIQSearchModels.swift); the rung says why.
      source: "no-recent-comps",
      rungLabel: "no-basis",
      valueSource: "unavailable",
      fmvReason: v.reason,
      provenance: { summary: v.basis },
      marketTier: null,
      fairMarketValueLive: null,
      marketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      confidence: 0,
      approximate: false,
      recentComps: [],
      compsUsed: 0,
      compsAvailable: v.totalSampleCount,
      lastSale: null,
      gradedEstimates,
      cardIdentity,
      cardImageUrl: v.identity.imageUrl,
    };
  }
  const buyZone: [number, number] = [Math.round(fmv * 0.85), Math.round(fmv * 0.95)];
  const holdZone: [number, number] = [Math.round(fmv * 0.95), Math.round(fmv * 1.10)];
  const sellZone: [number, number] = [Math.round(fmv * 1.10), Math.round(fmv * 1.25)];
  const recentComps = v.sales.slice(0, 20).map((s) => ({
    price: s.price,
    soldDate: s.soldAt,
    grader: null,
    gradeValue: null,
    parallel: v.identity.parallel,
    marketplace: s.source ?? undefined,
  })).filter((r) => r.price > 0 && !!r.soldDate);
  const lastSale = recentComps.length > 0
    ? { price: recentComps[0].price, soldDate: recentComps[0].soldDate, grader: null, gradeValue: null }
    : null;
  return {
    success: true,
    cardsightCardId: id,
    cardId: id,
    provenance: v.basis ? { summary: v.basis } : undefined,
    marketTier: { value: fmv, high: sellZone[1] },
    buyZone, holdZone, sellZone,
    fairMarketValueLive: fmv,
    marketValue: fmv,
    predictedPrice: v.predictedPrice ?? fmv,
    predictedPriceRange: [Math.round(fmv * 0.95), Math.round(fmv * 1.05)] as [number, number],
    confidence: v.confidence,
    approximate: !isExactPoolRung(v.rungLabel),
    // D16: `source` used to carry canonical-fmv's METHOD ("direct-comp"); it
    // now carries the rung, the same name every other wire carries.
    source: v.rungLabel,
    rungLabel: v.rungLabel,
    valueSource: v.valueSource,
    fmvReason: null,
    recentComps,
    compsUsed: v.compsUsed,
    compsAvailable: v.totalSampleCount,
    lastSale,
    gradedEstimates,
    cardIdentity,
    cardImageUrl: v.identity.imageUrl,
  };
}

// ─── GET /api/compiq/observed-grade-curve/:cardId ────────────────────────────

export function toObservedGradeCurveResponse(v: Valuation): Record<string, unknown> {
  return {
    success: true,
    cardId: v.identity.slug ?? v.identity.requestedId,
    totalSampleCount: v.totalSampleCount,
    computedAt: v.computedAt,
    entries: v.gradeCurve,
    ratePerWeek: null,
    signalSource: null,
    siblingFallback: null,
    rungLabel: v.rungLabel,
    valueSource: v.valueSource,
    fmvReason: v.reason,
    identity: wireIdentity(v.identity),
  };
}
