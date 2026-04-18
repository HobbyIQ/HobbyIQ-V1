import { CompIQRequest, CompIQResponse } from "./types";
import { parseCompIQInput } from "./parse";
import { estimateCardValues } from "./valuation";
import { scoreConfidence } from "./confidence";
import { buildExplanation } from "./explanation";

export async function runCompIQ(input: CompIQRequest): Promise<CompIQResponse> {
  const parsed = parseCompIQInput(input);
  const valuation = estimateCardValues(parsed);
  const confidence = scoreConfidence(parsed, valuation);
  const explanation = buildExplanation(parsed, valuation, confidence);

  // Next actions logic
  const nextActions: string[] = [];
  if (!parsed.player || !parsed.cardSet) nextActions.push("Refine your search with more details");
  else nextActions.push("View comps", "Estimate grading ROI");

  return {
    success: true,
    player: parsed.player,
    cardSet: parsed.cardSet,
    productFamily: parsed.productFamily,
    parallel: parsed.parallel,
    normalizedParallel: parsed.normalizedParallel,
    isAuto: parsed.isAuto,
    cardType: parsed.cardType,
    rawPrice: valuation.rawPrice,
    adjustedRaw: valuation.adjustedRaw,
    estimatedPsa9: valuation.estimatedPsa9,
    estimatedPsa10: valuation.estimatedPsa10,
    confidenceScore: confidence.score,
    confidenceLabel: confidence.label,
    explanation,
    warnings: [...parsed.warnings, ...valuation.warnings],
    nextActions,
  };
}
