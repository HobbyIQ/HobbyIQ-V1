// Confidence scoring for HobbyIQ search results
// Inputs: comp count, recency, variance, liquidity, data completeness, engine agreement

export interface ConfidenceInput {
  compCount?: number;
  avgCompRecencyDays?: number;
  priceVariance?: number;
  liquidity?: number;
  dataCompleteness?: number; // 0–1
  engineAgreement?: number; // 0–1
}

export interface ConfidenceScore {
  confidenceScore: number; // 0–100
  confidenceLabel: 'Low' | 'Medium' | 'High';
  explanation: string[];
}

export function computeConfidence(input: ConfidenceInput): ConfidenceScore {
  let score = 0;
  const expl: string[] = [];

  // Comp count (max 30)
  if (input.compCount !== undefined) {
    if (input.compCount >= 10) {
      score += 25;
      expl.push('Strong sample size of comps.');
    } else if (input.compCount >= 5) {
      score += 15;
      expl.push('Moderate number of comps.');
    } else if (input.compCount > 0) {
      score += 7;
      expl.push('Low comp count; less reliable.');
    } else {
      expl.push('No comps available.');
    }
  }

  // Recency (lower avg days = better)
  if (input.avgCompRecencyDays !== undefined) {
    if (input.avgCompRecencyDays < 7) {
      score += 20;
      expl.push('Comps are very recent.');
    } else if (input.avgCompRecencyDays < 21) {
      score += 12;
      expl.push('Comps are moderately recent.');
    } else {
      score += 4;
      expl.push('Comps are stale.');
    }
  }

  // Price variance (lower = better)
  if (input.priceVariance !== undefined) {
    if (input.priceVariance < 0.08) {
      score += 18;
      expl.push('Low price variance; market is consistent.');
    } else if (input.priceVariance < 0.18) {
      score += 10;
      expl.push('Moderate price variance.');
    } else {
      score += 2;
      expl.push('High price variance; market is volatile.');
    }
  }

  // Liquidity (sales/week)
  if (input.liquidity !== undefined) {
    if (input.liquidity >= 2) {
      score += 15;
      expl.push('High liquidity; frequent sales.');
    } else if (input.liquidity >= 0.5) {
      score += 8;
      expl.push('Moderate liquidity.');
    } else {
      score += 2;
      expl.push('Low liquidity; slow market.');
    }
  }

  // Data completeness (player/parallel detected)
  if (input.dataCompleteness !== undefined) {
    if (input.dataCompleteness > 0.8) {
      score += 10;
      expl.push('All key card/player details detected.');
    } else if (input.dataCompleteness > 0.5) {
      score += 5;
      expl.push('Some card/player details missing.');
    } else {
      expl.push('Insufficient card/player details.');
    }
  }

  // Engine agreement (CompIQ vs Decision)
  if (input.engineAgreement !== undefined) {
    if (input.engineAgreement > 0.8) {
      score += 12;
      expl.push('Strong agreement between value and decision engines.');
    } else if (input.engineAgreement > 0.5) {
      score += 6;
      expl.push('Partial agreement between engines.');
    } else {
      expl.push('Engines disagree on value/decision.');
    }
  }

  // Clamp and label
  score = Math.max(0, Math.min(100, Math.round(score)));
  let label: 'Low' | 'Medium' | 'High' = 'Low';
  if (score >= 70) label = 'High';
  else if (score >= 40) label = 'Medium';
  return { confidenceScore: score, confidenceLabel: label, explanation: expl };
}
