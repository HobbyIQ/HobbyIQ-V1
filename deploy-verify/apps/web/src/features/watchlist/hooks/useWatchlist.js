"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useWatchlist = useWatchlist;
const react_query_1 = require("react-query");
const watchlist_api_1 = require("../api/watchlist.api");
function useWatchlist() {
    return (0, react_query_1.useQuery)(["watchlist"], watchlist_api_1.listWatchlist);
}
