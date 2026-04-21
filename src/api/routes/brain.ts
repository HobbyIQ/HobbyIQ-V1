import { Router, Request, Response } from "express";

const router = Router();


router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "Brain running" });
});

// POST /api/brain/full-analysis
router.post("/full-analysis", (req: Request, res: Response) => {
  // Example: { player: "Mookie Betts", season: 2023, metrics: ["home_runs","RBIs"] }
  const { player, season, metrics } = req.body;
  if (!player || !season || !Array.isArray(metrics)) {
    return res.status(400).json({ error: "Missing required fields: player, season, metrics[]" });
  }
  res.json({
    player,
    season,
    metrics,
    analysis: metrics.map((m: string) => ({ metric: m, value: Math.floor(Math.random()*50)+1 })),
    summary: "Mock analysis complete.",
    source: "mock"
  });
});

export default router;
