"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const runner_1 = require("../jobs/runner");
const router = (0, express_1.Router)();
// POST /api/jobs/run
router.post("/jobs/run", async (_req, res) => {
    try {
        const result = await (0, runner_1.runAllJobs)();
        res.json({ success: true, result });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
exports.default = router;
