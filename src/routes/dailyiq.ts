// @ts-nocheck
export {};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dailyiqService_1 = require("../services/dailyiqService");
const watchPlayersRepository_1 = require("../repositories/watchPlayersRepository");
const router = (0, express_1.Router)();

const getYesterdayDateStr = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
};

// GET /api/dailyiq/health
router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "DailyIQ" });
});

// GET /api/dailyiq/mlb
router.get("/mlb", (_req, res) => {
    try {
        const stats = (0, dailyiqService_1.getDailyMLB)();
        res.json({ date: getYesterdayDateStr(), stats });
    }
    catch (err) {
        console.error("[dailyiq] /mlb error:", err);
        res.status(500).json({ error: "Failed to fetch MLB daily stats" });
    }
});

// GET /api/dailyiq/milb
router.get("/milb", (_req, res) => {
    try {
        const stats = (0, dailyiqService_1.getDailyMiLB)();
        res.json({ date: getYesterdayDateStr(), stats });
    }
    catch (err) {
        console.error("[dailyiq] /milb error:", err);
        res.status(500).json({ error: "Failed to fetch MiLB daily stats" });
    }
});

// POST /api/dailyiq/highlights
router.post("/highlights", (req, res) => {
    const { userId } = req.body;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        res.status(400).json({ error: "userId is required" });
        return;
    }

    try {
        const result = (0, dailyiqService_1.buildPersonalizedHighlights)(userId.trim());
        res.json(result);
    }
    catch (err) {
        console.error("[dailyiq] /highlights error:", err);
        res.status(500).json({ error: "Failed to build personalized highlights" });
    }
});

// GET /api/dailyiq/summary?userId=...
// Unified payload for yesterday: MLB best performers, MiLB best performers, and watch list player stats.
router.get("/summary", async (req, res) => {
    const { userId } = req.query;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        res.status(400).json({ error: "userId is required" });
        return;
    }

    try {
        const summary = await (0, dailyiqService_1.buildDailyIQSummary)(userId.trim());
        res.json({ userId: userId.trim(), ...summary });
    }
    catch (err) {
        console.error("[dailyiq] /summary error:", err);
        res.status(500).json({ error: "Failed to build DailyIQ summary" });
    }
});

// GET /api/dailyiq/watch?userId=...
// Returns the watch list for a user with the most recent game stat for each player
router.get("/watch", async (req, res) => {
    const { userId } = req.query;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        res.status(400).json({ error: "userId is required" });
        return;
    }

    try {
        const feed = await (0, dailyiqService_1.getWatchPlayerFeed)(userId.trim());
        const watchList = watchPlayersRepository_1.watchPlayersRepository.getList(userId.trim());
        res.json({ userId: userId.trim(), count: watchList.length, players: feed });
    }
    catch (err) {
        console.error("[dailyiq] /watch GET error:", err);
        res.status(500).json({ error: "Failed to load watch player feed" });
    }
});

// POST /api/dailyiq/watch
// Body: { userId: string, playerName: string }
router.post("/watch", (req, res) => {
    const { userId, playerName } = req.body;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        res.status(400).json({ error: "userId is required" });
        return;
    }
    if (!playerName || typeof playerName !== "string" || playerName.trim() === "") {
        res.status(400).json({ error: "playerName is required" });
        return;
    }

    const added = watchPlayersRepository_1.watchPlayersRepository.addPlayer(userId.trim(), playerName.trim());
    if (!added) {
        res.status(409).json({ error: `${playerName.trim()} is already on your watch list` });
        return;
    }

    res.status(201).json({ message: `${playerName.trim()} added to watch list` });
});

// DELETE /api/dailyiq/watch
// Body: { userId: string, playerName: string }
router.delete("/watch", (req, res) => {
    const { userId, playerName } = req.body;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        res.status(400).json({ error: "userId is required" });
        return;
    }
    if (!playerName || typeof playerName !== "string" || playerName.trim() === "") {
        res.status(400).json({ error: "playerName is required" });
        return;
    }

    const removed = watchPlayersRepository_1.watchPlayersRepository.removePlayer(userId.trim(), playerName.trim());
    if (!removed) {
        res.status(404).json({ error: `${playerName.trim()} not found on your watch list` });
        return;
    }

    res.json({ message: `${playerName.trim()} removed from watch list` });
});

exports.default = router;
