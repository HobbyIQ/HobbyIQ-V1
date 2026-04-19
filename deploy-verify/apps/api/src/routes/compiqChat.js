"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const compiq_1 = require("../services/compiq");
const router = (0, express_1.Router)();
// POST /api/compiq/chat
router.post("/chat", async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body !== "object" || (!body.query && !body.player)) {
            return res.status(400).json({ success: false, error: "Missing required input: query or player" });
        }
        const result = await (0, compiq_1.runCompIQ)(body);
        // Always return clean, frontend-consumable JSON
        return res.json(result);
    }
    catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
