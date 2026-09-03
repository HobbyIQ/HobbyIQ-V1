// CF-GRADE-ARB (Drew, 2026-09-02). Orchestration for the grade-arb
// surface: holding -> the ONE valuation path -> the pure arithmetic in
// gradeArbCompute.
//
// This file is deliberately thin. It resolves identity, asks
// oneValuationPath for the card's curve (the SAME call the holding's own
// FMV comes from, so the arb surface and the headline can never
// disagree), derives the product family for the basis sentence, and
// hands the curve to computeGradeArb. It performs no pricing of its own
// and mutates nothing.

import { valueIdentity } from "../compiq/oneValuationPath.service.js";
import { classifyFamily } from "../compiq/gradeCalibrationConfig.js";
import { holdingValuationIds } from "./holdingValuation.js";
import {
  computeGradeArb,
  resolveGradingCostUsd,
  GRADE_ARB_DISCLOSURE,
  type GradeArbResult,
} from "./gradeArbCompute.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

/** A holding is raw when it carries no grading company. Mirrors the
 *  check gradeWorthy and the reprice paths already use. */
export function isRawHolding(holding: PortfolioHolding): boolean {
  const g = holding.gradingCompany ?? holding.gradeCompany;
  return !g || String(g).trim().length === 0;
}

/** The refusal shape, for every path that cannot produce numbers. Keeps
 *  the disclosure attached even when there is nothing to disclose it
 *  about, so no caller can render a bare number later. */
function refuse(
  refusal: NonNullable<GradeArbResult["refusal"]>,
  reason: string,
): GradeArbResult {
  return {
    available: false,
    refusal,
    refusalReason: reason,
    rawValue: null,
    gradingCostUsd: resolveGradingCostUsd(),
    tiers: [],
    bestTier: null,
    disclosure: GRADE_ARB_DISCLOSURE,
  };
}

/**
 * Analyze one holding. Never throws: an engine failure is a refusal, not
 * a 500 — this surface is additive and must never take down a portfolio
 * read.
 */
export async function analyzeHoldingGradeArb(
  holding: PortfolioHolding,
  opts: { userId?: string | null } = {},
): Promise<GradeArbResult> {
  if (!isRawHolding(holding)) {
    return refuse("not-raw", "Holding is already graded — grade arbitrage applies to raw cards only.");
  }

  const ids = holdingValuationIds(holding);
  if (!ids) {
    return refuse("no-raw-basis", "Holding has no resolvable card identity — no pool to read.");
  }

  let curve;
  let family: string | null = null;
  try {
    const printRunRaw = (holding as { printRun?: unknown }).printRun;
    const printRun = typeof printRunRaw === "number" && printRunRaw > 0 ? printRunRaw : null;
    const v = await valueIdentity({
      id: ids.id,
      cardId: ids.cardId,
      // Raw tier: the arb baseline is always the ungraded card.
      grade: null,
      printRun,
      playerName: typeof holding.playerName === "string" ? holding.playerName : null,
      excludeContributorUserId: opts.userId ?? null,
    });
    curve = v.gradeCurve;
    const setForFamily = v.identity.setName ?? v.identity.setKey
      ?? (typeof holding.setName === "string" ? holding.setName : null);
    family = setForFamily ? classifyFamily(setForFamily) : null;
    // "other" is the classifier's catch-all, not a family worth naming
    // in prose — drop it rather than write "in other".
    if (family === "other") family = null;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "grade_arb_valuation_error",
      source: "gradeArbAnalyze.analyzeHoldingGradeArb",
      holdingId: holding.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return refuse("no-raw-basis", "Could not read this card's grade curve.");
  }

  return computeGradeArb({
    gradeCurve: curve ?? [],
    isRaw: true,
    family,
  });
}
