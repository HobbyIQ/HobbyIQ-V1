export function recencyWeight(daysSinceSale: number): number {
  return Math.exp(-daysSinceSale / 14);
}
