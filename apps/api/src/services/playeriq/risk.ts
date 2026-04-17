import { PlayerIQScores } from "./scoring";

export function getRiskBand(scores: PlayerIQScores): { riskScore: number; riskLabel: string } {
  // Example: lower overall = higher risk
  let riskScore = 100 - scores.overall;
  let riskLabel = "Low";
  if (riskScore > 40) riskLabel = "High";
  else if (riskScore > 20) riskLabel = "Medium";
  return { riskScore, riskLabel };
}
