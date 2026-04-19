"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listWatchlist = listWatchlist;
exports.addWatchlistItem = addWatchlistItem;
exports.removeWatchlistItem = removeWatchlistItem;
const client_1 = require("../../../services/api/client");
async function listWatchlist() {
    return client_1.apiClient.get("/api/watchlist");
}
async function addWatchlistItem(input) {
    return client_1.apiClient.post("/api/watchlist", input);
}
async function removeWatchlistItem(entityType, entityKey) {
    return client_1.apiClient.delete(`/api/watchlist/${entityType}/${entityKey}`);
}
