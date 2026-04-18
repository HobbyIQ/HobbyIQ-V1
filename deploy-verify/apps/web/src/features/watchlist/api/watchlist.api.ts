import { WatchlistItemDto } from "../types/watchlist.types";
import { apiClient } from "../../../services/api/client";

export async function listWatchlist(): Promise<WatchlistItemDto[]> {
  return apiClient.get("/api/watchlist");
}

export async function addWatchlistItem(input: Partial<WatchlistItemDto>): Promise<WatchlistItemDto> {
  return apiClient.post("/api/watchlist", input);
}

export async function removeWatchlistItem(entityType: string, entityKey: string): Promise<void> {
  return apiClient.delete(`/api/watchlist/${entityType}/${entityKey}`);
}
