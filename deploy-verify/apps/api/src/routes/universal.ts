import { Router } from "express";
import type { Request, Response } from "express";
import { routeUniversalSearch } from "../engines/universalRouter";

const router = Router();

router.post("/search", async (req: Request, res: Response) => {
  const { query, context } = req.body || {};
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "Missing or invalid query" });
  }
  try {
    const result = await routeUniversalSearch({ query, context });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
});

export default router;
