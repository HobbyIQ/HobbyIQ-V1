import { Router } from "express";
import type { Request, Response } from "express";
import { runAllJobs } from "../jobs/runner";

const router = Router();

// POST /api/jobs/run
router.post("/jobs/run", async (_req: Request, res: Response) => {
  try {
    const result = await runAllJobs();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
