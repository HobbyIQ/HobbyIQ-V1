"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const universalRouter_1 = require("../engines/universalRouter");
const router = (0, express_1.Router)();
router.post("/search", async (req, res) => {
    const { query, context } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
        return res.status(400).json({ error: "Missing or invalid query" });
    }
    try {
        const result = await (0, universalRouter_1.routeUniversalSearch)({ query, context });
        return res.json(result);
    }
    catch (err) {
        return res.status(500).json({ error: err.message || "Unknown error" });
    }
});
exports.default = router;
