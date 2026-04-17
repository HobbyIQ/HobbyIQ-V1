// PlayerRecommendationService: Generates player-level card recommendations
import type { PlayerRecommendationSet } from "../../../types/marketDecision";

export function buildPlayerRecommendationSet(context: any): PlayerRecommendationSet {
  // TODO: Use real comp, ladder, and catalyst data
  return {
    bestRiskAdjustedCard: {
      cardName: "Gold Auto Raw",
      actionTag: "buy",
      estimatedFmv: context.weightedMedian,
      entryTarget: context.priceBands?.buyZoneLow,
      upsideLabel: "Strong",
      safetyLabel: "Moderate",
      liquidityLabel: "Medium",
      reason: ["Best risk/reward for current market."],
      risk: ["Thin market for gold parallels."]
    },
    bestUpsideCard: {
      cardName: "Base Auto PSA 10",
      actionTag: "buy",
      estimatedFmv: context.weightedMedian * 2,
      entryTarget: context.priceBands?.buyZoneLow,
      upsideLabel: "High",
      safetyLabel: "High",
      liquidityLabel: "High",
      reason: ["High upside if player is promoted."],
      risk: ["Low risk due to strong comp base."]
    },
    safestLiquidCard: {
      cardName: "Base Auto Raw",
      actionTag: "hold",
      estimatedFmv: context.weightedMedian,
      entryTarget: context.priceBands?.buyZoneLow,
      upsideLabel: "Moderate",
      safetyLabel: "High",
      liquidityLabel: "High",
      reason: ["Most liquid card for this player."],
      risk: ["Low downside risk."]
    },
    topCardsToBuyNow: [
      {
        cardName: "Gold Auto Raw",
        actionTag: "buy",
        estimatedFmv: context.weightedMedian,
        entryTarget: context.priceBands?.buyZoneLow,
        upsideLabel: "Strong",
        safetyLabel: "Moderate",
        liquidityLabel: "Medium",
        reason: ["Best risk/reward for current market."],
        risk: ["Thin market for gold parallels."]
      }
    ],
    topCardsToAvoidNow: [
      {
        cardName: "Mega Mojo Refractor",
        actionTag: "avoid",
        estimatedFmv: context.weightedMedian * 0.8,
        reason: ["Contamination risk from non-matching comps."],
        risk: ["High normalization risk."]
      }
    ]
  };
}
