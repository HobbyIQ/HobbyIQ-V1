// LiquidityDepthEngine
// Type-only import removed for CommonJS compatibility

export class LiquidityDepthEngine {
  static absorptionRate(soldCount30d?: number, activeListings?: number): number {
    if (!soldCount30d || !activeListings || activeListings === 0) return 0;
    return Math.round((soldCount30d / activeListings) * 100) / 100;
  }

  static marketSpeed(avgDaysToSell?: number): 'fast' | 'normal' | 'slow' {
    if (avgDaysToSell === undefined || avgDaysToSell === null) return 'normal';
    if (avgDaysToSell <= 4) return 'fast';
    if (avgDaysToSell <= 14) return 'normal';
    return 'slow';
  }

  static marketPressure(absorptionRate: number): 'buyers' | 'balanced' | 'sellers' {
    if (absorptionRate > 1.5) return 'buyers';
    if (absorptionRate < 0.5) return 'sellers';
    return 'balanced';
  }
}
