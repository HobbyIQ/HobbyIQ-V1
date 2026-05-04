"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/health", (req, res) => {
    res.json({ status: "Brain running" });
});
// POST /api/brain/full-analysis
router.post("/full-analysis", (req, res) => {
    // Example: { player: "Mookie Betts", season: 2023, metrics: ["home_runs","RBIs"] }
    const { player, season, metrics } = req.body;
    if (!player || !season || !Array.isArray(metrics)) {
        return res.status(400).json({ error: "Missing required fields: player, season, metrics[]" });
    }
    res.json({
        player,
        season,
        metrics,
        analysis: metrics.map((m) => ({ metric: m, value: Math.floor(Math.random() * 50) + 1 })),
        summary: "Mock analysis complete.",
        source: "mock"
    });
});
exports.default = router;
