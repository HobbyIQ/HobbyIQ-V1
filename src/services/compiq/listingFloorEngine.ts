// Listing Floor Engine
export function getListingFloorAnalysis(listings: any[], lastSale: number): {
  listingFloor: number,
  listingGap: number,
  floorVsLastSaleDelta: number,
  marketResetSignal: boolean,
  notes: string[]
} {
  if (!listings || listings.length === 0 || !lastSale) {
    return {
      listingFloor: null,
      listingGap: null,
      floorVsLastSaleDelta: null,
      marketResetSignal: false,
      notes: ['No listing or last sale data']
    };
  }
  const sorted = listings.map(l => l.price).sort((a, b) => a - b);
  const listingFloor = sorted[0];
  const listingGap = sorted[1] ? sorted[1] - sorted[0] : 0;
  const floorVsLastSaleDelta = listingFloor - lastSale;
  const marketResetSignal = listingFloor > lastSale * 1.15;
  let notes = [];
  if (marketResetSignal) notes.push('Listing floor much higher than last sale (upward reset)');
  else if (listingFloor < lastSale * 0.85) notes.push('Listing floor much lower than last sale (weak market)');
  else notes.push('Listing floor near last sale');
  return { listingFloor, listingGap, floorVsLastSaleDelta, marketResetSignal, notes };
}
