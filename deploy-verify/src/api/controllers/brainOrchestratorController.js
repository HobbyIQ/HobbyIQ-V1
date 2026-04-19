"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullAnalysisController = fullAnalysisController;
const brainOrchestrator_1 = require("../../brain/orchestration/brainOrchestrator");
async function fullAnalysisController(req, res, next) {
    try {
        const result = await (0, brainOrchestrator_1.brainOrchestrator)(req.body);
        res.json({ success: true, ...result });
    }
    catch (err) {
        next(err);
    }
}
