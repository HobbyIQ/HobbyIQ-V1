// Utility functions for pricing engines

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function safeDivide(numerator: number, denominator: number): number {
  if (!denominator || denominator === 0) return 0;
  return numerator / denominator;
}
