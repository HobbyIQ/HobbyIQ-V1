import { EbayOrderEvent } from '../domain/integrations/ebay-order-event';

export interface EbayOrderEventRepository {
  create(event: EbayOrderEvent): Promise<EbayOrderEvent>;
  upsert(event: EbayOrderEvent): Promise<EbayOrderEvent>;
  findByExternalId(userId: string, externalOrderId: string): Promise<EbayOrderEvent | null>;
  listByUser(userId: string): Promise<EbayOrderEvent[]>;
}
