export function compQualityScore(comp: any): number {
  let score = 0;
  score += comp.exactMatch ? 1 : 0;
  score += comp.gradeMatch ? 1 : 0;
  score += comp.cleanTitle ? 1 : 0;
  score += comp.saleType === 'auction' ? 1 : 0.7;
  score += comp.dataConfidence || 0.7;
  return Math.min(score / 5, 1);
}
