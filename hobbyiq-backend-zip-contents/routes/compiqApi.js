"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const compiq_1 = require("../services/compiq");
const router = (0, express_1.Router)();
// POST /api/compiq/run
router.post("/run", async (req, res) => {
    try {
        const result = await (0, compiq_1.runCompIQ)(req.body);
        res.json({ success: true, result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
