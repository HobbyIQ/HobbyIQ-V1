import { Router, Request, Response } from "express";
import { runHobbyIQAnalysis, HobbyIQAnalysisInput, HobbyIQAnalysisOutput } from "../engines/hobbyiq/service";

const router = Router();

// POST /api/hobbyiq/analyze
router.post("/analyze", async (req: Request, res: Response) => {
  try {
    const input: HobbyIQAnalysisInput = req.body;
    // Removed debug log
    const result = await runHobbyIQAnalysis(input);

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
  } catch (err) {
    // Removed debug log
    res.status(500).json({ success: false, engine: "hobbyiq", error: err instanceof Error ? err.message : err });
  }
});

export default router;
