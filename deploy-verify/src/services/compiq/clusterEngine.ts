// Cluster Engine
export function getClusterAnalysis(prices: number[]): {
  weightedMedian: number,
  clusterCenter: number,
  variance: number,
  clusterTightness: string
} {
  if (!prices || prices.length === 0) {
    return {
      weightedMedian: null,
      clusterCenter: null,
      variance: null,
      clusterTightness: 'wide'
    };
  }
  const sorted = prices.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const weightedMedian = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const clusterCenter = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const mean = clusterCenter;
  const variance = sorted.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sorted.length;
  let clusterTightness = 'normal';
  if (variance < 100) clusterTightness = 'tight';
  else if (variance > 500) clusterTightness = 'wide';
  return { weightedMedian, clusterCenter, variance, clusterTightness };
}
