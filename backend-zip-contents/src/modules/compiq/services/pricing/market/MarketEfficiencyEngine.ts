// MarketEfficiencyEngine
// const { CompInput } = require('../../../models/comp.types');
// Type-only import removed for CommonJS compatibility

export class MarketEfficiencyEngine {
  static daysOnMarket(comp: any) {
    if (!comp.listingStartDate || !comp.saleDate) return null;
    const start = new Date(comp.listingStartDate);
    const end = new Date(comp.saleDate);
    const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 ? Math.round(diff) : null;
  }

  static timeToSellScore(days: any) {
    if (days === null || days < 0) return 0;
    if (days <= 2) return 98;
    if (days <= 7) return 88;
    if (days <= 14) return 74;
    if (days <= 21) return 62;
    if (days <= 45) return 45;
    return 25;
  }
}
