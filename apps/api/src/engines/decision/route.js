"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("./service");
const router = (0, express_1.Router)();
// POST /api/decision/run
router.post('/run', (req, res) => {
    const input = req.body;
    try {
        const result = (0, service_1.runDecisionEngine)(input);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: 'Invalid input', details: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
