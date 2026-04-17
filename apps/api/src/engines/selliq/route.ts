import { Router, Request, Response } from "express";
import { runSellIQ } from "./service";

const router = Router();

// POST /api/selliq/run
router.post("/run", (req: Request, res: Response) => {
  try {
    const result = runSellIQ(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: "Invalid input", details: err instanceof Error ? err.message : err });
  }
});

export default router;
