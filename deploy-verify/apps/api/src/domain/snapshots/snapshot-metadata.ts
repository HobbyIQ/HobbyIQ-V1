export interface SnapshotMetadata {
  asOf: Date;
  expiresAt: Date;
  freshnessTier: 'hot' | 'medium' | 'cold';
  confidenceScore: number;
  sourceCount: number;
  dataCompletenessScore: number;
  buildVersion: string;
  methodologyVersion: string;
  isStale: boolean;
  createdAt: Date;
}
