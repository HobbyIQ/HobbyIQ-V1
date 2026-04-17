// Helper functions for Decision Engine

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function normalizeTrend(trend: number): number {
  // Normalize trend from -1..1 to 0..100
  return clamp(((trend + 1) / 2) * 100, 0, 100);
}

export function getRecommendation(score: number):
  'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' {
  if (score >= 85) return 'strong_buy';
  if (score >= 70) return 'buy';
  if (score >= 50) return 'hold';
  if (score >= 30) return 'sell';
  return 'strong_sell';
}
