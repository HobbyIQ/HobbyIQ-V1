import express from "express";
import { handlePlayerIQEvaluate } from "../engines/playeriq";
import type { PlayerIQRequest } from "../shared/types";

const router = express.Router();


// POST /api/playeriq/query (alias for /evaluate)
router.post("/query", async (req, res) => {
  try {
    const input: PlayerIQRequest = req.body;
    const result = await handlePlayerIQEvaluate(input);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/playeriq/evaluate: Player + Card Intelligence
router.post("/evaluate", async (req, res) => {
  try {
    const input: PlayerIQRequest = req.body;
    const result = await handlePlayerIQEvaluate(input);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
