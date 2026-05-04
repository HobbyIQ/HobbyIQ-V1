"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/health", (req, res) => {
    res.json({ status: "CompIQ running" });
});
// POST /api/compiq/query
router.post("/query", (req, res) => {
    // Example baseball query: { player: "Aaron Judge", stat: "home_runs", season: 2023 }
    const { player, stat, season } = req.body;
    if (!player || !stat || !season) {
        return res.status(400).json({ error: "Missing required fields: player, stat, season" });
    }
    res.json({
        player,
        stat,
        season,
        value: 52, // mock value
        source: "mock"
    });
});
// POST /api/compiq/estimate
router.post("/estimate", (req, res) => {
    // Example: { player: "Aaron Judge", stat: "batting_average", games: 10 }
    const { player, stat, games } = req.body;
    if (!player || !stat || !games) {
        return res.status(400).json({ error: "Missing required fields: player, stat, games" });
    }
    res.json({
        player,
        stat,
        games,
        estimate: 0.312, // mock value
        confidence: 0.85,
        source: "mock"
    });
});
exports.default = router;
