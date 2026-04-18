import { ParsedCompInput } from "./parse";
import { ValuationResult } from "./valuation";
import { ConfidenceResult } from "./confidence";

export function buildExplanation(parsed: ParsedCompInput, valuation: ValuationResult, confidence: ConfidenceResult): string {
  const parts: string[] = [];
  if (parsed.player && parsed.cardSet && parsed.parallel) {
    parts.push(`Estimated value for ${parsed.player} ${parsed.cardSet} ${parsed.parallel}`);
  } else {
    parts.push("Could not fully parse card details.");
  }
  if (valuation.rawPrice) {
    parts.push(`Raw: $${valuation.rawPrice}`);
    parts.push(`PSA 9: $${valuation.estimatedPsa9}`);
    parts.push(`PSA 10: $${valuation.estimatedPsa10}`);
  } else {
    parts.push("No comps found for valuation.");
  }
  parts.push(`Confidence: ${confidence.label} (${confidence.score}%)`);
  if (parsed.warnings.length) {
    parts.push("Warnings: " + parsed.warnings.join(", "));
  }
  return parts.join("\n");
}
