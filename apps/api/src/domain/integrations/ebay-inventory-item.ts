export interface EbayInventoryItem {
  inventoryId: string;
  userId: string;
  externalListingId: string;
  title: string;
  price?: number | null;
  quantityAvailable?: number | null;
  quantitySold?: number | null;
  status?: string | null;
  listingUrl?: string | null;
  entityType?: "card" | "player" | null;
  entityKey?: string | null;
  matchedPositionId?: string | null;
  rawJson: Record<string, unknown>;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}
