"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchDailyIQBrief = fetchDailyIQBrief;
async function fetchDailyIQBrief() {
    const res = await fetch("/api/dailyiq/brief");
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return await res.json();
}
