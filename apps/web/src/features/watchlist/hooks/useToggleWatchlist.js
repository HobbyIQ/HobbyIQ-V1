"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useToggleWatchlist = useToggleWatchlist;
const react_query_1 = require("react-query");
const watchlist_api_1 = require("../api/watchlist.api");
function useToggleWatchlist(entityType, entityKey, existingItem) {
    const queryClient = (0, react_query_1.useQueryClient)();
    const add = (0, react_query_1.useMutation)(() => (0, watchlist_api_1.addWatchlistItem)({ entityType, entityKey }), {
        onSuccess: () => queryClient.invalidateQueries(["watchlist"]),
    });
    const remove = (0, react_query_1.useMutation)(() => (0, watchlist_api_1.removeWatchlistItem)(entityType, entityKey), {
        onSuccess: () => queryClient.invalidateQueries(["watchlist"]),
    });
    return {
        isWatched: !!existingItem,
        toggle: () => (existingItem ? remove.mutate() : add.mutate()),
        loading: add.isLoading || remove.isLoading,
    };
}
