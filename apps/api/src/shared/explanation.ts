// Explanation generator for CompIQ
import type { CompIQRequest } from "./types";

export function generateExplanation(parsed: any, confidenceScore: number): string {
  let explanation = `Valuation based on detected details: `;
  if (parsed.player) explanation += `Player: ${parsed.player}. `;
  if (parsed.cardSet) explanation += `Set: ${parsed.cardSet}. `;
  if (parsed.parallel) explanation += `Parallel: ${parsed.parallel}. `;
  if (parsed.isAuto) explanation += `Auto detected. `;
  explanation += `Confidence: ${confidenceScore}%.`;
  return explanation;
}
