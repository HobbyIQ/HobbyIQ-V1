
export interface ListingFloorAnalysis {
  listingFloor: number | null;
  listingGap: number | null;
  floorVsLastSaleDelta: number | null;
  marketResetSignal: boolean;
  notes: string[];
}

interface Listing {
  price: number;
}

export function getListingFloorAnalysis(listings: Listing[], lastSale: number): ListingFloorAnalysis {
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
  const notes: string[] = [];
  if (marketResetSignal) notes.push('Listing floor much higher than last sale (upward reset)');
  else if (listingFloor < lastSale * 0.85) notes.push('Listing floor much lower than last sale (weak market)');
  else notes.push('Listing floor near last sale');
  return { listingFloor, listingGap, floorVsLastSaleDelta, marketResetSignal, notes };
}
