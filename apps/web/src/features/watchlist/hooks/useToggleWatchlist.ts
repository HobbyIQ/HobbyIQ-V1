import { useMutation, useQueryClient } from "react-query";
import { addWatchlistItem, removeWatchlistItem } from "../api/watchlist.api";
import { WatchlistItemDto } from "../types/watchlist.types";

export function useToggleWatchlist(entityType: string, entityKey: string, existingItem?: WatchlistItemDto) {
  const queryClient = useQueryClient();
  const add = useMutation(() => addWatchlistItem({ entityType, entityKey }), {
    onSuccess: () => queryClient.invalidateQueries(["watchlist"]),
  });
  const remove = useMutation(() => removeWatchlistItem(entityType, entityKey), {
    onSuccess: () => queryClient.invalidateQueries(["watchlist"]),
  });
  return {
    isWatched: !!existingItem,
    toggle: () => (existingItem ? remove.mutate() : add.mutate()),
    loading: add.isLoading || remove.isLoading,
  };
}
