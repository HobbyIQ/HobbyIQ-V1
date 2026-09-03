/**
 * CF-ONE-VALUATION-PATH (D17, 2026-08-30). The portfolio persist site prices
 * a holding through the ONE valuation entry — the same call the card page
 * answers from — so the number persisted on a holding IS the number every
 * pricing route serves for that holding's slug + grade. A holding priced at
 * $182.50 shows $182.50 on its card page, because both are one computation.
 *
 * Before D17 portfolioStore priced the exact pool three ways of its own:
 * the grade-curve tile rung (the legacy curve build on the majority vendor
 * cardId), the unified early exit (priceHoldingFromExactPool), and the
 * supremacy gate's re-price (priceHoldingFromExactPool again). Each read the
 * same pool through a different engine call, and the unified engine's
 * cross-grade rescale — another grade's pool × getGraderPremium's hardcoded
 * tables, rung `cross-grade-fallback` — could be persisted as "observed".
 *
 * This module is the persist site's adapter over the entry. It decides
 * nothing about the price; it decides what a valuation BECOMES on a holding:
 *
 *   observed       an exact-pool rung: the unified write (fairMarketValue,
 *                  fmvRung, predictedPrice, the labels), valuationStatus
 *                  "observed" — the shape the early exits always wrote;
 *   estimated      `grade-curve-estimate`: this identity's other tiers × the
 *                  empirical ratio — persisted as an ESTIMATE (isEstimate,
 *                  valuationStatus "estimated", the rung named), never as an
 *                  observed number; the seam that replaces cross-grade-
 *                  fallback (D4 PR 6's tables are not consulted);
 *   cost-basis-floor  the entry's number failed CF-COST-BASIS-SANITY-FLOOR
 *                  (< 15% of a > $50 cost basis is a slug mismatch, not a
 *                  market) — nothing written, the caller falls through;
 *   unresolved     the catalog holds no identity for the holding (no slug
 *                  on a catalog row, a vendor id no slug maps to) — the
 *                  entry declines; the caller's legacy chain is the only
 *                  path, exactly as before D17;
 *   unpriced       the identity resolved but the entry has no exact-pool
 *                  number for the tier (the gated ladder's answer, if any,
 *                  is a cross-identity estimate and belongs to the caller's
 *                  gated estimate sites) — the caller's exact-pool re-reads
 *                  must NOT run: they could only produce the number the
 *                  entry declined to.
 *
 * Kept from #1462 / D4 PR 5: the identity order (slug alone, its twin, then
 * cardId ∪ slug — the entry takes `cardId`), the ≥ 1 sale rule, the
 * cost-basis floor, the fmvRung / pricingSource / pricingSourceMeta stamps
 * (every write that sets fairMarketValue sets fmvRung in the same literal).
 */
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { valueIdentity, type Valuation } from "../compiq/oneValuationPath.service.js";
import { isExactPoolRung } from "../compiq/fmvRung.js";
import { persistedLabelsForValuation } from "../compiq/valuationLabels.js";

export type HoldingValuationOutcome =
  | { outcome: "observed"; holding: PortfolioHolding; valuation: Valuation }
  | { outcome: "estimated"; holding: PortfolioHolding; valuation: Valuation }
  | { outcome: "cost-basis-floor"; valuation: Valuation; costBasis: number; proposedTotal: number }
  | { outcome: "unresolved"; valuation: Valuation | null }
  | { outcome: "unpriced"; valuation: Valuation };

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** The holding's grade for the entry: `{ company, value }`, or null for Raw. */
export function holdingGrade(holding: PortfolioHolding): { company: string; value: number | null } | null {
  const company = String((holding as { gradeCompany?: unknown }).gradeCompany ?? "").trim();
  if (!company) return null;
  const raw = (holding as { gradeValue?: unknown }).gradeValue;
  const value = typeof raw === "number" ? raw : (raw ? Number(raw) : null);
  return { company, value: value !== null && Number.isFinite(value) ? value : null };
}

/** The identities the entry is asked for: the slug as `id`, the cardId as
 *  the second identity. Null when the holding names none. */
export function holdingValuationIds(holding: PortfolioHolding): { id: string; cardId: string | null } | null {
  const slug = String((holding as { hobbyiqCardId?: unknown }).hobbyiqCardId ?? "").trim();
  const cardId = String(holding.cardId ?? "").trim();
  if (slug.startsWith("hiq:")) return { id: slug, cardId: cardId && cardId !== slug ? cardId : null };
  if (cardId) return { id: cardId, cardId: null };
  return null;
}

/** CF-COST-BASIS-SANITY-FLOOR, as at every unified write: a price under 15%
 *  of a > $50 cost basis is a slug mismatch, not a market. */
export function costBasisFloor(holding: PortfolioHolding, proposedUnit: number): { rejects: boolean; costBasis: number; proposedTotal: number } {
  const qty = Math.max(1, num(holding.quantity, 1));
  const costBasis = num(holding.totalCostBasis, num(holding.purchasePrice, 0) * qty);
  const proposedTotal = proposedUnit * qty;
  return { rejects: costBasis > 50 && proposedTotal > 0 && proposedTotal / costBasis < 0.15, costBasis, proposedTotal };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The observed write: the exact-pool rung on the holding, in the shape the
 *  unified early exits and the supremacy gate always wrote. */
export function observedHoldingWrite(holding: PortfolioHolding, v: Valuation, nowIso: string): PortfolioHolding {
  const fmv = v.fairMarketValue as number;
  return {
    ...holding,
    fairMarketValue: fmv,
    fmvRung: v.rungLabel,
    // C-7: the kind of evidence, alongside the ladder step. Observed = real
    // comps in the exact pool; this is the branch that requires them.
    valueSource: "observed",
    predictedPrice: v.predictedPrice ?? fmv,
    predictedPriceLow: null,
    predictedPriceHigh: null,
    predictedPriceMechanism: "unified-trend",
    predictedPriceUpdatedAt: nowIso,
    movementDirection: v.trend.direction === "up" ? "up" : v.trend.direction === "down" ? "down" : null,
    movementUpdatedAt: nowIso,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: null,
    estimateBasis: `${v.basis} id=${v.identity.pooledVia ?? "hobbyiqCardId"}`,
    isEstimate: false,
    valuationStatus: "observed",
    pricingSource: "unified-pricing",
    pricingSourceMeta: {
      slug: v.identity.pooledAs ?? v.identity.slug ?? v.identity.requestedId,
      method: v.rungLabel,
      compsUsed: v.compsUsed,
      // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the same
      // label set the live canonical-fmv response carries for this holding,
      // derived through the same two functions (valuationLabels.ts). A
      // self-anchored $251 must SAY so on the portfolio row, not only to a
      // reader who thinks to open the card page.
      ...persistedLabelsForValuation(v),
    },
    nearestGradedAnchor: undefined,
    verdict: "Observed",
    recommendation: holding.recommendation ?? "Hold",
    lastUpdated: nowIso,
    sourceVendor: "hobbyiq-pool" as unknown as PortfolioHolding["sourceVendor"],
    sourceVendorUpdatedAt: nowIso,
  };
}

/** The estimate write: this identity's other tiers × the empirical ratio,
 *  persisted as an estimate with its rung named — never as observed. */
export function gradeCurveEstimateHoldingWrite(holding: PortfolioHolding, v: Valuation, nowIso: string): PortfolioHolding {
  const fmv = round2(v.fairMarketValue as number);
  return {
    ...holding,
    fairMarketValue: fmv,
    fmvRung: "grade-curve-estimate",
    // C-7: derived from this identity's OTHER tiers via the empirical ratio —
    // never comps of this tier, so it can never claim "observed".
    valueSource: "estimated",
    predictedPrice: v.predictedPrice ?? fmv,
    predictedPriceLow: null,
    predictedPriceHigh: null,
    predictedPriceMechanism: "grade-curve-estimate",
    predictedPriceUpdatedAt: nowIso,
    movementDirection: null,
    movementUpdatedAt: nowIso,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: "rough",
    estimateBasis: v.basis,
    isEstimate: true,
    valuationStatus: "estimated",
    pricingSource: "unified-pricing",
    pricingSourceMeta: {
      slug: v.identity.pooledAs ?? v.identity.slug ?? v.identity.requestedId,
      method: "grade-curve-estimate",
      compsUsed: v.compsUsed,
      // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS: an estimate carries its
      // labels too — a grade-curve fill IS a fallback rung, and it says so.
      ...persistedLabelsForValuation(v),
    },
    nearestGradedAnchor: undefined,
    verdict: "Estimated",
    recommendation: holding.recommendation ?? "Hold",
    lastUpdated: nowIso,
    sourceVendor: "hobbyiq-pool" as unknown as PortfolioHolding["sourceVendor"],
    sourceVendorUpdatedAt: nowIso,
  };
}

/**
 * Value a holding through the one entry and say what the valuation becomes.
 * Never throws on the entry's own errors: an entry failure is `unresolved`
 * (logged) so the caller's legacy chain still runs, as it did before D17.
 */
export async function valueHoldingThroughOneEntry(
  holding: PortfolioHolding,
  opts: { userId?: string | null; caller: string; nowIso?: string },
): Promise<HoldingValuationOutcome> {
  const ids = holdingValuationIds(holding);
  if (!ids) return { outcome: "unresolved", valuation: null };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  let v: Valuation;
  try {
    const printRunRaw = (holding as { printRun?: unknown }).printRun;
    const printRun = num(printRunRaw, 0);
    v = await valueIdentity({
      id: ids.id,
      cardId: ids.cardId,
      grade: holdingGrade(holding),
      printRun: printRun > 0 ? printRun : null,
      playerName: typeof holding.playerName === "string" ? holding.playerName : null,
      excludeContributorUserId: opts.userId ?? null,
    });
  } catch (err) {
    console.warn(JSON.stringify({
      event: "one_valuation_path_holding_error",
      source: "holdingValuation.valueHoldingThroughOneEntry",
      site: opts.caller,
      holdingId: holding.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return { outcome: "unresolved", valuation: null };
  }
  if (!v.identity.slug) return { outcome: "unresolved", valuation: v };

  const priced = v.fairMarketValue !== null && v.fairMarketValue > 0;
  const observed = priced && v.valueSource === "observed" && isExactPoolRung(v.rungLabel);
  const estimated = priced && v.valueSource === "estimated" && v.rungLabel === "grade-curve-estimate";
  if (!observed && !estimated) return { outcome: "unpriced", valuation: v };

  const floor = costBasisFloor(holding, v.fairMarketValue as number);
  if (floor.rejects) {
    console.warn(JSON.stringify({
      event: "one_valuation_path_rejected_cost_basis_floor",
      source: "holdingValuation.valueHoldingThroughOneEntry",
      site: opts.caller,
      holdingId: holding.id,
      slug: v.identity.slug,
      pricedId: v.identity.pooledAs,
      rung: v.rungLabel,
      proposedTotal: floor.proposedTotal,
      costBasis: floor.costBasis,
    }));
    return { outcome: "cost-basis-floor", valuation: v, costBasis: floor.costBasis, proposedTotal: floor.proposedTotal };
  }
  console.log(JSON.stringify({
    event: observed ? "one_valuation_path_holding_priced" : "one_valuation_path_holding_estimated",
    source: "holdingValuation.valueHoldingThroughOneEntry",
    site: opts.caller,
    userId: opts.userId ?? null,
    holdingId: holding.id,
    slug: v.identity.slug,
    pricedId: v.identity.pooledAs,
    identityAttempt: v.identity.pooledVia,
    tier: v.requestedTier,
    fair_market_value: v.fairMarketValue,
    rung: v.rungLabel,
    compsUsed: v.compsUsed,
    window_days: v.windowDays,
    trend_direction: v.trend.direction,
    trend_pct_per_week: v.trend.pctPerWeek,
  }));
  return observed
    ? { outcome: "observed", holding: observedHoldingWrite(holding, v, nowIso), valuation: v }
    : { outcome: "estimated", holding: gradeCurveEstimateHoldingWrite(holding, v, nowIso), valuation: v };
}
