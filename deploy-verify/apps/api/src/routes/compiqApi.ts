import { Router, Request, Response } from "express";
import { runCompIQ } from "../services/compiq";

const router = Router();


// POST /api/compiq/run
router.post("/run", async (req: Request, res: Response) => {
  try {
    const result = await runCompIQ(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : err });
  }
});

export default router;
