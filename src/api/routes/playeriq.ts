import { Router, Request, Response } from "express";

const router = Router();


router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "PlayerIQ running" });
});

// POST /api/playeriq/query
router.post("/query", (req: Request, res: Response) => {
  // Example: { player: "Shohei Ohtani", query: "stolen_bases", season: 2023 }
  const { player, query, season } = req.body;
  if (!player || !query || !season) {
    return res.status(400).json({ error: "Missing required fields: player, query, season" });
  }
  res.json({
    player,
    query,
    season,
    result: 18, // mock value
    source: "mock"
  });
});

export default router;
