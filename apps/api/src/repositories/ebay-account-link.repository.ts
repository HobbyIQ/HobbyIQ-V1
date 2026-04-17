import { EbayAccountLink } from '../domain/integrations/ebay-account-link';

export interface EbayAccountLinkRepository {
  create(link: EbayAccountLink): Promise<EbayAccountLink>;
  update(link: EbayAccountLink): Promise<EbayAccountLink>;
  upsert(link: EbayAccountLink): Promise<EbayAccountLink>;
  findActiveLinkByUser(userId: string): Promise<EbayAccountLink | null>;
  listByUser(userId: string): Promise<EbayAccountLink[]>;
}
