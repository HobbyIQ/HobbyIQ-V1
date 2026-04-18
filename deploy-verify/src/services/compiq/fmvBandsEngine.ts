// FMV Bands Engine
export function getFMVBands({ comps, blendedFMV, listingFloor }: { comps: any[], blendedFMV: number, listingFloor: number }): {
  quickSellFloor: number,
  fairMarketValue: number,
  strongRetailValue: number
} {
  if (!comps || comps.length === 0) {
    return {
      quickSellFloor: blendedFMV ? Math.round(blendedFMV * 0.85) : 0,
      fairMarketValue: blendedFMV || 0,
      strongRetailValue: blendedFMV ? Math.round(blendedFMV * 1.15) : 0
    };
  }
  const prices = comps.map(c => c.price).sort((a, b) => a - b);
  const quickSellFloor = prices[Math.floor(prices.length * 0.15)] || Math.round(blendedFMV * 0.85);
  const fairMarketValue = blendedFMV;
  const strongRetailValue = listingFloor && listingFloor > blendedFMV ? listingFloor : Math.round(blendedFMV * 1.15);
  return { quickSellFloor, fairMarketValue, strongRetailValue };
}
