// UnsoldListingEngine: evaluates stale/unsold inventory
export class UnsoldListingEngine {
  static score(listingAge: number, relistCount?: number, hadPriceCut?: boolean): number {
    // TODO: Penalize high relist count, price cuts, long age
    return 50;
  }
}
