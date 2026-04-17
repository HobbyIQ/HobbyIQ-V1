// Silver Layer: Normalized Entities
// Stores normalized, deduped, and validated entities

export interface SilverEntity {
  id: string;
  entityType: string;
  entityKey: string;
  normalizedPayload: any;
  dedupeHash: string;
  contaminationFlags: string[];
  createdAt: Date;
}
