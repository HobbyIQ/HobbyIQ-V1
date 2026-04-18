"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
// In-memory feedback store (for demo; replace with DB in prod)
const feedbacks = [];
// Accept: query, intent, summary, feedback, timestamp
router.post("/", (req, res) => {
    const { query, intent, summary, feedback, timestamp } = req.body;
    if (!query || !intent || !feedback) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    feedbacks.push({ query, intent, summary, feedback, timestamp: timestamp || new Date().toISOString() });
    res.json({ ok: true });
});
router.get("/", (req, res) => {
    res.json(feedbacks.slice(-20)); // last 20 feedbacks
});
exports.default = router;
