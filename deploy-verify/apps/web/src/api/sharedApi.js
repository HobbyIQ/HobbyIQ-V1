"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCompIQ = fetchCompIQ;
exports.fetchPlayerIQ = fetchPlayerIQ;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
function getApiUrl(path) {
    if (path.startsWith("http"))
        return path;
    if (API_BASE_URL) {
        return `${API_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : "/" + path}`;
    }
    return path;
}
async function apiFetch(path, options = {}) {
    const url = getApiUrl(path);
    let res;
    try {
        res = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {}),
            },
        });
    }
    catch (err) {
        throw new Error("Network error. Please check your connection.");
    }
    let data;
    try {
        data = await res.json();
    }
    catch {
        data = undefined;
    }
    if (!res.ok) {
        const msg = (data && data.error) || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return data;
}
async function fetchCompIQ(query) {
    return apiFetch("/api/compiq/live-estimate", {
        method: "POST",
        body: JSON.stringify(query),
    });
}
async function fetchPlayerIQ(player) {
    return apiFetch("/api/playeriq/evaluate", {
        method: "POST",
        body: JSON.stringify(player),
    });
}
