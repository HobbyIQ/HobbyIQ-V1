export function trendAnalysis(comps: any[]): { trendDirection: string, trendStrength: number } {
  if (!comps.length) return { trendDirection: 'flat', trendStrength: 0 };
  const sorted = [...comps].sort((a, b) => b.date - a.date);
  const avg3 = sorted.slice(0, 3).reduce((a, c) => a + c.price, 0) / Math.max(1, Math.min(3, sorted.length));
  const avg7 = sorted.slice(0, 7).reduce((a, c) => a + c.price, 0) / Math.max(1, Math.min(7, sorted.length));
  const avg30 = sorted.filter(c => (Date.now() - c.date) / (1000 * 60 * 60 * 24) <= 30).reduce((a, c) => a + c.price, 0) / Math.max(1, sorted.filter(c => (Date.now() - c.date) / (1000 * 60 * 60 * 24) <= 30).length);
  let trendDirection = 'flat';
  if (avg3 > avg7 && avg7 > avg30) trendDirection = 'up';
  else if (avg3 < avg7 && avg7 < avg30) trendDirection = 'down';
  const trendStrength = Math.min(1, Math.abs(avg3 - avg30) / (avg30 || 1));
  return { trendDirection, trendStrength };
}
