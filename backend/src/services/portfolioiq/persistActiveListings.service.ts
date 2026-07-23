// CF-PERSIST-ACTIVE-LISTINGS (Drew, 2026-07-23, issue #722 listings).
// Every active listing we observe from eBay Browse → our active_listings
// container with an observedAt timestamp. Enables demand-curve analysis
// (how long a listing sat, how price moved during listing).
//
// Flag: PERSIST_ACTIVE_LISTINGS_ENABLED (default OFF).
// Container: active_listings (partition /cardId).

import {
  getContainer,
  contentHashOf,
  runInBackground,
  logPersistEvent,
  isDomainEnabled,
} from "./vendorPersistenceCommon.service.js";

export interface ActiveListing {
  listingId: string;               // eBay itemId or similar external id
  cardId: string;                  // OUR mapping for this listing
  title?: string | null;
  price: number | null | undefined;
  askType?: "auction" | "fixed" | "auction-with-bin" | null;
  currentBid?: number | null;
  endDate?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  sellerHandle?: string | null;
}

export interface ActiveListingsPersistResult {
  inserted: number;
  deduped: number;
  skipped: number;
}

export function isPersistActiveListingsEnabled(): boolean {
  return isDomainEnabled("PERSIST_ACTIVE_LISTINGS_ENABLED");
}

/** Persist a batch of active listings. Each observation snapshots the
 *  listing state at time T; dedup is per (listingId, price, endDate,
 *  observedDay) so the same listing observed twice on the same day
 *  with the same price doesn't double-write. */
export async function persistActiveListings(
  source: "ebay",
  listings: ActiveListing[],
): Promise<ActiveListingsPersistResult> {
  const result: ActiveListingsPersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!isPersistActiveListingsEnabled()) return result;
  if (!Array.isArray(listings) || listings.length === 0) return result;
  const container = await getContainer("active_listings");
  if (!container) return result;

  const observedDay = new Date().toISOString().slice(0, 10);
  for (const l of listings) {
    const listingId = String(l.listingId ?? "").trim();
    const cardId = String(l.cardId ?? "").trim();
    const price = Number(l.price);
    if (!listingId || !cardId || !Number.isFinite(price) || price <= 0) {
      result.skipped++;
      continue;
    }
    const contentHash = contentHashOf(
      source, listingId, price.toFixed(2), l.endDate ?? "", observedDay,
    );
    try {
      const { resources: existing } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.cardId = @c AND c.contentHash = @h",
        parameters: [{ name: "@c", value: cardId }, { name: "@h", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) { result.deduped++; continue; }
      const doc = {
        id: `${source}::${listingId}::${observedDay}`,
        cardId,
        source,
        contentHash,
        listingId,
        title: l.title ?? null,
        price,
        askType: l.askType ?? null,
        currentBid: l.currentBid ?? null,
        endDate: l.endDate ?? null,
        url: l.url ?? null,
        imageUrl: l.imageUrl ?? null,
        sellerHandle: l.sellerHandle ?? null,
        observedAt: new Date().toISOString(),
        observedDay,
      };
      await container.items.upsert(doc);
      result.inserted++;
    } catch {
      result.skipped++;
    }
  }
  logPersistEvent("active_listings", source, result);
  return result;
}

export function persistActiveListingsInBackground(
  source: "ebay",
  listings: ActiveListing[],
): void {
  runInBackground(() => persistActiveListings(source, listings).then(() => {}));
}
