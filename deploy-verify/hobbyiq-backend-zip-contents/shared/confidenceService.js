// confidenceService.js - Confidence scoring
function calculateConfidence({directCompCount, adjacentCompCount, compScores, trendStrength, normalizationCertainty}) {
  let score = 60;
  let reasons = [];
  if (directCompCount >= 4) {
    score += 25;
    reasons.push('Strong direct comp evidence');
  } else if (directCompCount >= 2) {
    score += 10;
    reasons.push('Some direct comp evidence');
  } else if (adjacentCompCount >= 2) {
    score += 5;
    reasons.push('Used adjacent tier comps');
  } else {
    reasons.push('Sparse direct evidence');
  }
  const avgCompScore = compScores.length ? compScores.reduce((a, b) => a + b, 0) / compScores.length : 0.7;
  score += Math.round((avgCompScore - 0.7) * 40);
  if (trendStrength > 0.08) {
    score += 5;
    reasons.push('Strong market trend');
  }
  if (normalizationCertainty < 0.7) {
    score -= 10;
    reasons.push('Low normalization certainty');
  }
  let label = 'Medium';
  if (score >= 85) label = 'High';
  else if (score < 65) label = 'Low';
  return { score: Math.max(0, Math.min(100, score)), label, reasons };
}
module.exports = { calculateConfidence };
