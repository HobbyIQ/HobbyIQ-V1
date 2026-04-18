import { EbayInventoryItem } from '../domain/integrations/ebay-inventory-item';

export interface EbayInventoryRepository {
  create(item: EbayInventoryItem): Promise<EbayInventoryItem>;
  update(item: EbayInventoryItem): Promise<EbayInventoryItem>;
  upsert(item: EbayInventoryItem): Promise<EbayInventoryItem>;
  findByExternalId(userId: string, externalListingId: string): Promise<EbayInventoryItem | null>;
  listByUser(userId: string): Promise<EbayInventoryItem[]>;
}
