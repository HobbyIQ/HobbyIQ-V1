export function confidenceEngine({ compCount, recencyScore, varianceScore, supplyScore, matchQualityScore }: any): number {
  // All scores 0-1
  const confidence =
    (compCount * 0.25) +
    (recencyScore * 0.25) +
    (varianceScore * 0.2) +
    (supplyScore * 0.15) +
    (matchQualityScore * 0.15);
  return Math.round(confidence * 100);
}
