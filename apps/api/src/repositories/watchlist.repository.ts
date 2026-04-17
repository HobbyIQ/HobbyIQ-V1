import { WatchlistItem } from "../domain/alerts/watchlist-item";

export interface WatchlistRepository {
  add(item: WatchlistItem): Promise<void>;
  remove(userId: string, entityType: string, entityKey: string): Promise<void>;
  listByUser(userId: string): Promise<WatchlistItem[]>;
  listByEntity(entityType: string, entityKey: string): Promise<WatchlistItem[]>;
}
