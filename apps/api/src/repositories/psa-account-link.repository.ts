import { PsaAccountLink } from '../domain/integrations/psa-account-link';

export interface PsaAccountLinkRepository {
  create(link: PsaAccountLink): Promise<PsaAccountLink>;
  update(link: PsaAccountLink): Promise<PsaAccountLink>;
  upsert(link: PsaAccountLink): Promise<PsaAccountLink>;
  findActiveLinkByUser(userId: string): Promise<PsaAccountLink | null>;
  listByUser(userId: string): Promise<PsaAccountLink[]>;
}
