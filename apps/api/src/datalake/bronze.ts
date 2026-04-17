// Bronze Layer: Raw Ingestion
// Stores raw payloads for listings, stats, rankings, etc.

export interface BronzeRecord {
  id: string;
  source: string;
  sourceRecordId: string;
  ingestedAt: Date;
  entityKey: string;
  rawPayload: any;
  dedupeHash: string;
}
