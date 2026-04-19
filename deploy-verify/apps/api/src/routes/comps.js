"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const apifyClient_1 = require("../services/comps/apifyClient");
const normalize_1 = require("../services/comps/normalize");
const fmv_1 = require("../services/comps/fmv");
const cache_1 = require("../services/comps/cache");
// In-memory cache for FMV results (by query string)
const fmvCache = new cache_1.InMemoryCache(5 * 60 * 1000, 100);
const router = (0, express_1.Router)();
router.get("/search", async (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== "string" || !q.trim()) {
        return res.status(400).json({ error: "Missing or invalid query parameter 'q'" });
    }
    // Check cache first
    const cacheKey = q.trim().toLowerCase();
    const cached = fmvCache.get(cacheKey);
    if (cached) {
        return res.json({
            query: q,
            summary: cached.summary,
            buckets: cached.buckets,
            comps: cached.comps,
            cached: true,
        });
    }
    try {
        // 1. Fetch raw comps from Apify
        const rawComps = await (0, apifyClient_1.fetchApifySoldComps)(q);
        // 2. Normalize comps
        const normalized = (0, normalize_1.normalizeComps)(rawComps, q);
        // 3. Calculate FMV and grade buckets
        const { summary, buckets } = (0, fmv_1.calculateFmv)(normalized);
        // 4. Sort comps by matchScore desc, then soldDate desc
        const comps = normalized
            .slice()
            .sort((a, b) => {
            if (b.matchScore !== a.matchScore)
                return b.matchScore - a.matchScore;
            const da = a.soldDate ? new Date(a.soldDate).getTime() : 0;
            const db = b.soldDate ? new Date(b.soldDate).getTime() : 0;
            return db - da;
        })
            .slice(0, 50); // Limit to 50 most relevant comps
        // Store in cache
        fmvCache.set(cacheKey, { summary, buckets, comps });
        // 5. Return response
        return res.json({
            query: q,
            summary,
            buckets,
            comps,
        });
    }
    catch (err) {
        return res.status(500).json({
            error: err.message || "Internal server error",
        });
    }
});
exports.default = router;
