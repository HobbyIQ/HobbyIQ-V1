export function clampScore(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}
