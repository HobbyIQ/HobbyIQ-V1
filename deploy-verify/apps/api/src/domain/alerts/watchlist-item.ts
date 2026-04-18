export interface WatchlistItem {
  watchlistItemId: string;
  userId: string;
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
