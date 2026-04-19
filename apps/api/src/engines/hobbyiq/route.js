"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("./service");
const router = (0, express_1.Router)();
// POST /api/hobbyiq/analyze
router.post("/analyze", async (req, res) => {
    try {
        const result = await (0, service_1.runHobbyIQAnalysis)(req.body);
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: "Analysis failed", details: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
