// Handles ingestion, dedupe, and routing of domain events
export interface EventIngestionService {
  ingestEvent(event: MarketDataEvent): Promise<void>;
}

export interface MarketDataEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  occurredAt: Date;
  source: string;
  payloadJson: any;
  importanceScore?: number;
  dedupeKey?: string;
}
