export type MarketDataEventType =
  | "new_sale"
  | "listing_added"
  | "listing_removed"
  | "listing_price_changed"
  | "player_stats_updated"
  | "ranking_updated"
  | "injury_updated"
  | "promotion_signal"
  | "news_signal"
  | "manual_refresh_requested";

export type MarketEntityType = "card" | "player";

export interface MarketDataEvent {
  eventId: string;
  eventType: MarketDataEventType;
  entityType: MarketEntityType;
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  occurredAt: string;
  source: string;
  payloadJson: Record<string, unknown>;
  importanceScore?: number;
  dedupeKey?: string;
}
