



import express from "express";
import { runCompIQ } from "../services/compiq";
import type { CompIQRequest } from "../services/compiq/types";
import { z } from "zod";

const router = express.Router();


// Zod schema for CompIQRequest
const compIQSchema = z.object({
  query: z.string().optional(),
  player: z.string().optional(),
  set: z.string().optional(),
  parallel: z.string().optional(),
  gradeTarget: z.string().optional(),
  isAuto: z.boolean().optional(),
});


// POST /api/compiq/query
router.post("/query", async (req, res) => {
  const parseResult = compIQSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ success: false, error: parseResult.error.issues.map(issue => issue.message) });
  }
  // All fields are optional, so type assertion is safe
  const input = parseResult.data as CompIQRequest;
  try {
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


// POST /api/compiq/estimate (alias for /query for now)
router.post("/estimate", async (req, res) => {
  const parseResult = compIQSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ success: false, error: parseResult.error.issues.map(issue => issue.message) });
  }
  const input = parseResult.data as CompIQRequest;
  try {
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
