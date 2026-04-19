"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullAnalysisController = fullAnalysisController;
const fullAnalysisHandler_1 = require("../../brain/handlers/fullAnalysisHandler");
async function fullAnalysisController(req, res) {
    try {
        console.log('[FullAnalysisController] Incoming request:', JSON.stringify(req.body));
        const result = await (0, fullAnalysisHandler_1.runFullAnalysis)(req.body ?? {});
        console.log('[FullAnalysisController] Final response:', JSON.stringify(result));
        res.json({ success: true, ...result });
    }
    catch (err) {
        console.error('[FullAnalysisController] Error:', err);
        res.status(500).json({ success: false, error: 'Full analysis failed' });
    }
}
