import { Router, Request, Response } from "express";
import { searchAndPrice } from "../../services/compiqSearchService";

const router = Router();

router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "CompIQ running" });
});

// POST /api/compiq/search — live eBay comps
router.post("/search", async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query?: string };
    if (!query || typeof query !== "string" || query.trim() === "") {
      return res.status(400).json({ error: "Missing required field: query" });
    }
    const result = await searchAndPrice(query.trim());
    return res.json(result);
  } catch (err) {
    console.error("[compiq/search] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/compiq/price — alias for search
router.post("/price", async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query?: string };
    if (!query || typeof query !== "string" || query.trim() === "") {
      return res.status(400).json({ error: "Missing required field: query" });
    }
    const result = await searchAndPrice(query.trim());
    return res.json(result);
  } catch (err) {
    console.error("[compiq/price] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/compiq/query
router.post("/query", (req: Request, res: Response) => {
  // Example baseball query: { player: "Aaron Judge", stat: "home_runs", season: 2023 }
  const { player, stat, season } = req.body;
  if (!player || !stat || !season) {
    return res.status(400).json({ error: "Missing required fields: player, stat, season" });
  }
  res.json({
    player,
    stat,
    season,
    value: 52, // mock value
    source: "mock"
  });
});

// POST /api/compiq/estimate
router.post("/estimate", (req: Request, res: Response) => {
  // Example: { player: "Aaron Judge", stat: "batting_average", games: 10 }
  const { player, stat, games } = req.body;
  if (!player || !stat || !games) {
    return res.status(400).json({ error: "Missing required fields: player, stat, games" });
  }
  res.json({
    player,
    stat,
    games,
    estimate: 0.312, // mock value
    confidence: 0.85,
    source: "mock"
  });
});

export default router;
