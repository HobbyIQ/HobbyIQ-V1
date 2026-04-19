"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dealAnalyzer_1 = require("../services/dealAnalyzer");
const router = (0, express_1.Router)();
// POST /
router.post("/", (req, res) => {
    try {
        const { enteredPrice, compIQ } = req.body;
        const result = (0, dealAnalyzer_1.analyzeDeal)(enteredPrice, compIQ);
        res.json({ success: true, result });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
