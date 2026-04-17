
import express from "express";
import { runCompIQ } from "../services/compiq";
import type { CompIQRequest } from "../services/compiq/types";

const router = express.Router();

// Utility: Basic request validation
function validateCompIQInput(input: any): { valid: boolean; errors?: string[] } {
  const errors = [];
  if (!input || typeof input !== "object") errors.push("Missing request body");
  if (!input.query && !input.player) errors.push("Missing required field: query or player");
  return { valid: errors.length === 0, errors };
}

// POST /api/compiq/query

router.post("/query", async (req, res) => {
  const input: CompIQRequest = req.body;
  const { valid, errors } = validateCompIQInput(input);
  if (!valid) return res.status(400).json({ success: false, error: errors });
  try {
    // Mock/live provider toggle (env or query param)
    const useMock = process.env.MOCK_COMPIQ === "true" || req.query.mock === "true";
    let result;
    if (useMock) {
      // Use sample/mock data
      const { sampleCompIQResponses } = await import("../data/sampleCompIQ");
      result = sampleCompIQResponses[0];
      result = { ...result, explanation: "(Mocked) " + result.explanation };
    } else {
      result = await runCompIQ(input);
    }
    // Ensure collector-friendly output
    result.explanation = result.explanation.replace(/liquidity|downside|constructive|pressure/gi, "");
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || "Unknown error" });
  }
});

// POST /api/compiq/estimate (alias for /query for now)

router.post("/estimate", async (req, res) => {
  const input: CompIQRequest = req.body;
  const { valid, errors } = validateCompIQInput(input);
  if (!valid) return res.status(400).json({ success: false, error: errors });
  try {
    // Mock/live provider toggle (env or query param)
    const useMock = process.env.MOCK_COMPIQ === "true" || req.query.mock === "true";
    let result;
    if (useMock) {
      const { sampleCompIQResponses } = await import("../data/sampleCompIQ");
      result = sampleCompIQResponses[0];
      result = { ...result, explanation: "(Mocked) " + result.explanation };
    } else {
      result = await runCompIQ(input);
    }
    result.explanation = result.explanation.replace(/liquidity|downside|constructive|pressure/gi, "");
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || "Unknown error" });
  }
});

// GET /api/compiq/health
router.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok", module: "CompIQ" });
});

export default router;
