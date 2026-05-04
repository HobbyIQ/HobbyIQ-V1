// MarketFreshnessEngine: recency/freshness decay
export class MarketFreshnessEngine {
  static score(daysOld: number, isRare: boolean): number {
    // TODO: Faster decay for hot/fast cards, slower for rare
    if (daysOld < 7) return 100;
    if (daysOld < 30) return isRare ? 90 : 70;
    return isRare ? 70 : 40;
  }
}
