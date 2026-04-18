// compQualityService.js - Comp quality scoring
function scoreComp(comp, normalizedCard) {
  let score = 1.0;
  if (comp.parallelBucket !== normalizedCard.parallelBucket) score -= 0.2;
  if (comp.playerName !== normalizedCard.playerName) score -= 0.15;
  if (comp.brand !== normalizedCard.brand) score -= 0.1;
  if (comp.product !== normalizedCard.product) score -= 0.1;
  if (comp.gradeCompany && normalizedCard.grade && comp.gradeCompany !== normalizedCard.grade) score -= 0.05;
  // Recentness (last 30 days = full, 31-90 = -0.1, older = -0.2)
  const daysAgo = (Date.now() - new Date(comp.soldDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo > 90) score -= 0.2;
  else if (daysAgo > 30) score -= 0.1;
  // Outlier flag
  if (comp.notes && comp.notes.toLowerCase().includes('outlier')) score -= 0.3;
  return Math.max(0, Math.round(score * 100) / 100);
}
module.exports = { scoreComp };
