import { Router, Request, Response } from "express";
import { runHobbyIQAnalysis } from "./service";

const router = Router();

// POST /api/hobbyiq/analyze
router.post("/analyze", async (req: Request, res: Response) => {
  try {
    const result = await runHobbyIQAnalysis(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Analysis failed", details: err instanceof Error ? err.message : err });
  }
});

export default router;
