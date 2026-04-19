"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHobbyIQ = searchHobbyIQ;
// apps/web/src/api/searchApi.ts
const api_1 = require("../api");
async function searchHobbyIQ(query) {
    const res = await fetch(`${api_1.API_BASE_URL}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
    });
    if (!res.ok)
        throw new Error("Search failed");
    return res.json();
}
