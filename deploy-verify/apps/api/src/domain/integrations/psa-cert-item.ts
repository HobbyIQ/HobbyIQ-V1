export interface PsaCertItem {
  certItemId: string;
  userId: string;
  externalCertNumber: string;
  playerName?: string | null;
  cardName?: string | null;
  year?: string | null;
  grade?: string | null;
  setName?: string | null;
  entityKey?: string | null;
  matchedPositionId?: string | null;
  rawJson: Record<string, unknown>;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}
