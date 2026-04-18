import { Router } from "express";
import type { Request, Response } from "express";
import { getPlans } from "../services/plan";

const router = Router();

// GET /api/plans
router.get("/plans", (_req: Request, res: Response) => {
  const plans = getPlans();
  res.json({ plans });
});

export default router;
