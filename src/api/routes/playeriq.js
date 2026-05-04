"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/health", (req, res) => {
    res.json({ status: "PlayerIQ running" });
});
// POST /api/playeriq/query
router.post("/query", (req, res) => {
    // Example: { player: "Shohei Ohtani", query: "stolen_bases", season: 2023 }
    const { player, query, season } = req.body;
    if (!player || !query || !season) {
        return res.status(400).json({ error: "Missing required fields: player, query, season" });
    }
    res.json({
        player,
        query,
        season,
        result: 18, // mock value
        source: "mock"
    });
});
exports.default = router;
