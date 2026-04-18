import { Router, Request, Response } from "express";
import { runCompIQ } from "../services/compiq";
import { CompIQRequest } from "../services/compiq/types";

const router = Router();

// POST /api/compiq/chat
router.post("/chat", async (req: Request, res: Response) => {
  try {
    const body: CompIQRequest = req.body;
    if (!body || typeof body !== "object" || (!body.query && !body.player)) {
      return res.status(400).json({ success: false, error: "Missing required input: query or player" });
    }
    const result = await runCompIQ(body);
    // Always return clean, frontend-consumable JSON
    return res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
  }
});

export default router;