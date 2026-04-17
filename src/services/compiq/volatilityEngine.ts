export function volatilityEngine(comps: any[]): { volatilityScore: number, classification: string } {
  if (!comps.length) return { volatilityScore: 0, classification: 'low' };
  const prices = comps.map(c => c.price);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const std = Math.sqrt(prices.map(p => Math.pow(p - mean, 2)).reduce((a, b) => a + b, 0) / prices.length);
  let classification = 'low';
  if (std > mean * 0.2) classification = 'medium';
  if (std > mean * 0.35) classification = 'high';
  return { volatilityScore: std, classification };
}
