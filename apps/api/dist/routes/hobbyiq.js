"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("../engines/hobbyiq/service");
const router = (0, express_1.Router)();
// POST /api/hobbyiq/analyze
router.post("/analyze", async (req, res) => {
    try {
        const input = req.body;
        console.log("[HobbyIQ] Analysis request received", JSON.stringify(input));
        const result = await (0, service_1.runHobbyIQAnalysis)(input);
        // Build summary block
        const summary = {
            recommendation: result.decisionOutput?.recommendation || null,
            confidence: result.decisionOutput?.confidenceScore || null,
            keyDrivers: result.decisionOutput?.majorDrivers || [],
            risks: result.negativePressureOutput?.score && result.negativePressureOutput.score > 20 ? ["Negative pressure"] : [],
            action: result.sellOutput?.expectedStrategy || null
        };
        res.json({
            success: true,
            engine: "hobbyiq",
            result: {
                pricing: result.pricingOutput,
                negativePressure: result.negativePressureOutput,
                decision: result.decisionOutput,
                sell: result.sellOutput,
                summary
            }
        });
    }
    catch (err) {
        console.error("[HobbyIQ] Analysis error", err);
        res.status(500).json({ success: false, engine: "hobbyiq", error: err instanceof Error ? err.message : err });
    }
});
exports.default = router;
