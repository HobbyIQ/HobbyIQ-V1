// CF-GRADE-WORTHY (Drew, 2026-07-17). Orchestration: given a holding,
// pull the SKU's grader premium curve from local comp store, pull
// applicable grading costs from the catalog, and analyze.
//
// v1 scope:
//  - Analyzes a SINGLE holding (per-card endpoint)
//  - Portfolio-scan is built by iterating this in the routes handler
//
// The pure math is in gradeWorthyCompute.service.ts.

import { lookupLocalComps } from "./localCompStore.service.js";
import { readPlayerTrend } from "./playerTrendStore.service.js";
import { analyzeGradeWorthy } from "./gradeWorthyCompute.service.js";
import { GRADING_TIERS, type GraderId } from "./gradingTiers.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type {
  GradeWorthyAnalysis,
  GraderPremiumInput,
} from "../../types/gradeWorthy.types.js";

/** Derive a { "psa-regular": 79.99, "bgs-regular": 65, ... } Record from
 *  the catalog. Picks the cheapest ACTIVE tier per grader — v1 doesn't
 *  match declared-value cap; a follow-up can pick per-tier by expected
 *  graded price. */
export function buildGradingCostCatalog(): Record<string, number> {
  const out: Record<string, number> = {};
  const cheapestByGrader = new Map<GraderId, number>();
  for (const tier of GRADING_TIERS) {
    if (!tier.active) continue;
    if (typeof tier.pricePerCard !== "number") continue;
    const existing = cheapestByGrader.get(tier.grader);
    if (existing === undefined || tier.pricePerCard < existing) {
      cheapestByGrader.set(tier.grader, tier.pricePerCard);
    }
  }
  for (const [grader, price] of cheapestByGrader.entries()) {
    const graderLower = grader.toLowerCase();
    out[`${graderLower}-regular`] = price; // matches compute's preferred-key order
    out[graderLower] = price;
  }
  // Default when a grader isn't in the catalog (CGC, TAG, etc).
  if (!("default" in out)) out.default = 60;
  return out;
}

/** Analyze a single holding. Bails cleanly (insufficient_data) when
 *  the SKU has no local corpus coverage or when the holding is already
 *  graded. */
export async function analyzeHoldingGradeWorthy(
  holding: PortfolioHolding,
): Promise<{
  analysis: GradeWorthyAnalysis;
  diagnostics: {
    localCorpusRows: number;
    playerMomentum: number | null;
    playerMomentumDirection: "up" | "flat" | "down" | null;
  };
}> {
  // Only raw holdings are candidates. Already-graded cards don't get
  // regrade recommendations from this service.
  const gradeCompany = holding.gradingCompany ?? holding.gradeCompany;
  if (gradeCompany && String(gradeCompany).trim().length > 0) {
    return {
      analysis: {
        rawPrice: 0,
        bestTier: null,
        allTiers: [],
        overallRecommendation: "not_worth",
        reason: "Already graded — regrade analysis out of scope",
      },
      diagnostics: {
        localCorpusRows: 0,
        playerMomentum: null,
        playerMomentumDirection: null,
      },
    };
  }

  const player = (holding.playerName ?? "").trim();
  const year = typeof holding.cardYear === "number" ? holding.cardYear : undefined;
  const number = (holding.cardNumber ?? "").trim();

  if (!player) {
    return {
      analysis: {
        rawPrice: 0,
        bestTier: null,
        allTiers: [],
        overallRecommendation: "insufficient_data",
        reason: "Holding is missing player identity — cannot look up corpus",
      },
      diagnostics: {
        localCorpusRows: 0,
        playerMomentum: null,
        playerMomentumDirection: null,
      },
    };
  }

  // Pull local corpus for this SKU — allGrades=true so we get raw + all
  // graded tiers to build the grader premium curve.
  const localResult = await lookupLocalComps(
    {
      player,
      year,
      number: number || undefined,
      allGrades: true,
    },
    { skipPremiums: false },
  );

  // Cheap-side derivation: rawPrice = graderPremiums["Raw"].meanPrice
  // if present, else fall back to holding.fairMarketValue.
  const rawEntry: GraderPremiumInput | undefined = localResult.graderPremiums["Raw"];
  const rawPrice =
    rawEntry && rawEntry.n >= 3 ? rawEntry.meanPrice :
    typeof holding.fairMarketValue === "number" ? holding.fairMarketValue :
    0;

  // Player-level momentum context.
  let playerMomentum: number | null = null;
  let playerMomentumDirection: "up" | "flat" | "down" | null = null;
  try {
    const trend = await readPlayerTrend(player);
    if (trend) {
      playerMomentum = trend.momentum;
      playerMomentumDirection = trend.direction;
    }
  } catch {
    // best-effort — don't fail the analysis just because trend store is offline
  }

  const analysis = analyzeGradeWorthy({
    rawPrice,
    graderPremiums: localResult.graderPremiums,
    gradingCosts: buildGradingCostCatalog(),
    playerMomentumDirection: playerMomentumDirection ?? undefined,
  });

  return {
    analysis,
    diagnostics: {
      localCorpusRows: localResult.totalSales,
      playerMomentum,
      playerMomentumDirection,
    },
  };
}
