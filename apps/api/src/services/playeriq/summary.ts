import { PlayerIQRequest } from "./types";
import { PlayerIQScores } from "./scoring";
import { getRiskBand } from "./risk";

export function buildPlayerIQSummary(input: PlayerIQRequest, scores: PlayerIQScores, risk: { riskScore: number; riskLabel: string }) {
  let summary = "";
  let strengths: string[] = [];
  let risks: string[] = [];
  let recommendation = "Hold";
  let confidence = 90;

  // Example logic for demo
  if (/brady ebel/i.test(input.player)) {
    summary = "Elite prospect with top-tier talent and strong market support.";
    strengths = ["Elite bat speed", "Advanced approach", "Strong market hype"];
    risks = ["Injury risk", "Small sample size"];
    recommendation = "Buy";
    confidence = 97;
  } else if (/roman anthony/i.test(input.player)) {
    summary = "High-upside hitter with solid market interest.";
    strengths = ["Power potential", "Plate discipline"];
    risks = ["Unproven at upper levels"];
    recommendation = "Hold";
    confidence = 90;
  } else if (/bonemer/i.test(input.player)) {
    summary = "Raw tools, but market is skeptical.";
    strengths = ["Athleticism"];
    risks = ["Unrefined skills", "Low market demand"];
    recommendation = "Sell";
    confidence = 70;
  } else {
    summary = "Insufficient data for a strong PlayerIQ read. Use more details.";
    strengths = [];
    risks = ["Unknown player or missing data"];
    recommendation = "Hold";
    confidence = 50;
  }

  return { summary, strengths, risks, recommendation, confidence };
}
