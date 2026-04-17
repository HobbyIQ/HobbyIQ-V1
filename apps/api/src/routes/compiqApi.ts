import { Router, Request, Response } from "express";
import { getLiveEstimate, searchCompiq, getPlayerCompiq } from "../services/compiq";

const router = Router();

// GET /api/compiq/live-estimate
router.get("/live-estimate", async (req: Request, res: Response) => {
  try {
    const result = await getLiveEstimate(req.query);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
  }
});

// POST /api/compiq/search
router.post("/search", async (req: Request, res: Response) => {
  try {
    const result = await searchCompiq(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
  }
});

// GET /api/compiq/player
router.get("/player", async (req: Request, res: Response) => {
  try {
    const result = await getPlayerCompiq(req.query);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
  }
});

export default router;
