// CF-ADVANCED-ALERTS (2026-06-03): pure condition + rule evaluation.
//
// Takes a single computeEstimate result (or a "previous + current" pair for
// crossing-class conditions) and evaluates each condition independently,
// then combines via AND/OR. NO side effects, NO async — keeps the
// orchestrator (ruleEvaluator.ts) trivially testable.
//
// Crossing semantics: `price_crosses` / `predicted_price_crosses` need a
// "before vs now" comparison. The evaluator accepts an optional
// `previousEstimate` slice; when absent (first-evaluation case for the
// rule), crossing conditions evaluate to FALSE — we don't fire on initial
// observation of "currently above target". Subsequent passes get the
// previous slice from the repo's prior `lastEvaluatedAt` snapshot (see
// ruleEvaluator.ts).

import type {
  AdvancedAlertCondition,
  AdvancedAlertCombinator,
} from "../../repositories/advancedAlertRules.repository.js";
import type { TrendIQCoverage } from "../compiq/trendIQ.types.js";

/**
 * Minimum slice of a computeEstimate response needed by the evaluator.
 * Mirrors the fields the orchestrator extracts from `est` — keeps this
 * module decoupled from the full estimate shape.
 */
export interface EvaluationEstimateSlice {
  fairMarketValue: number | null;
  predictedPrice: number | null;
  pricingConfidence: number | null;       // 0..100
  trendIQ: {
    composite: number;
    direction: "up" | "flat" | "down";
    coverage: TrendIQCoverage;
  } | null;
}

const COVERAGE_RANK: Record<TrendIQCoverage, number> = {
  insufficient: 0,
  player_only: 1,
  card_only: 2,
  segment_only: 2,
  no_segment: 3,
  no_card: 3,
  full: 4,
};

function coverageMeetsMin(actual: TrendIQCoverage, min: TrendIQCoverage): boolean {
  return COVERAGE_RANK[actual] >= COVERAGE_RANK[min];
}

function pctMove(estimate: EvaluationEstimateSlice): number | null {
  const { fairMarketValue: fmv, predictedPrice: pred } = estimate;
  if (typeof fmv !== "number" || !Number.isFinite(fmv) || fmv <= 0) return null;
  if (typeof pred !== "number" || !Number.isFinite(pred)) return null;
  return ((pred - fmv) / fmv) * 100;
}

/**
 * Evaluate a single condition against an estimate slice. Crossing-class
 * conditions need both `previousEstimate` and `currentEstimate`; without
 * a previous slice they return FALSE (no spurious "currently above" fires
 * on the first evaluation of a rule).
 */
export function evaluateCondition(
  condition: AdvancedAlertCondition,
  currentEstimate: EvaluationEstimateSlice,
  previousEstimate: EvaluationEstimateSlice | null = null,
): boolean {
  switch (condition.kind) {
    case "predicted_direction": {
      const dir = currentEstimate.trendIQ?.direction;
      if (!dir) return false;
      return dir === condition.equals;
    }
    case "predicted_pct_move": {
      const move = pctMove(currentEstimate);
      if (move === null) return false;
      return condition.op === "gte" ? move >= condition.value : move <= condition.value;
    }
    case "trendiq_composite": {
      const c = currentEstimate.trendIQ?.composite;
      if (typeof c !== "number") return false;
      return condition.op === "gte" ? c >= condition.value : c <= condition.value;
    }
    case "trendiq_coverage_min": {
      const cov = currentEstimate.trendIQ?.coverage;
      if (!cov) return false;
      return coverageMeetsMin(cov, condition.value);
    }
    case "confidence_min": {
      const conf = currentEstimate.pricingConfidence;
      if (typeof conf !== "number" || !Number.isFinite(conf)) return false;
      return conf >= condition.value;
    }
    case "price_crosses": {
      if (!previousEstimate) return false;
      const before = previousEstimate.fairMarketValue;
      const after = currentEstimate.fairMarketValue;
      if (typeof before !== "number" || typeof after !== "number") return false;
      if (condition.op === "above") {
        return before < condition.value && after >= condition.value;
      }
      return before > condition.value && after <= condition.value;
    }
    case "predicted_price_crosses": {
      if (!previousEstimate) return false;
      const before = previousEstimate.predictedPrice;
      const after = currentEstimate.predictedPrice;
      if (typeof before !== "number" || typeof after !== "number") return false;
      if (condition.op === "above") {
        return before < condition.value && after >= condition.value;
      }
      return before > condition.value && after <= condition.value;
    }
    // Exhaustiveness check — tsc rejects unhandled future kinds.
    default: {
      const _exhaustive: never = condition;
      return _exhaustive;
    }
  }
}

/** Combine condition results via flat AND/OR. */
export function evaluateRule(
  combinator: AdvancedAlertCombinator,
  conditions: AdvancedAlertCondition[],
  currentEstimate: EvaluationEstimateSlice,
  previousEstimate: EvaluationEstimateSlice | null = null,
): boolean {
  if (conditions.length === 0) return false;
  if (combinator === "AND") {
    return conditions.every((c) => evaluateCondition(c, currentEstimate, previousEstimate));
  }
  return conditions.some((c) => evaluateCondition(c, currentEstimate, previousEstimate));
}
