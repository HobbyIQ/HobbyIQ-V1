import { PsaCertItem } from '../domain/integrations/psa-cert-item';

export interface PsaCertItemRepository {
  create(item: PsaCertItem): Promise<PsaCertItem>;
  update(item: PsaCertItem): Promise<PsaCertItem>;
  upsert(item: PsaCertItem): Promise<PsaCertItem>;
  findByExternalCertNumber(userId: string, externalCertNumber: string): Promise<PsaCertItem | null>;
  listByUser(userId: string): Promise<PsaCertItem[]>;
}
