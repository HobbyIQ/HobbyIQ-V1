"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("./service");
const router = (0, express_1.Router)();
// POST /api/selliq/run
router.post("/run", (req, res) => {
    try {
        const result = (0, service_1.runSellIQ)(req.body);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: "Invalid input", details: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
