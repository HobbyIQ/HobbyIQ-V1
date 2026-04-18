// Confidence scoring for CompIQ
import type { CompIQRequest } from "./types";

export function generateConfidenceScore(parsed: any, rawPrice: number): number {
  let score = 80;
  if (!parsed.player) score -= 30;
  if (!parsed.cardSet) score -= 20;
  if (!parsed.parallel) score -= 10;
  if (rawPrice < 20) score -= 10;
  if (parsed.isAuto) score += 5;
  return Math.max(0, Math.min(100, score));
}

export function getConfidenceLabel(score: number): string {
  if (score >= 85) return "High";
  if (score >= 65) return "Medium";
  return "Low";
}
