import { Router } from "express";
import type { Request, Response } from "express";
import { getDashboard } from "../services/dashboard";

const router = Router();

// GET /api/dashboard
router.get("/dashboard", (_req: Request, res: Response) => {
  // In production, use userId from auth/session
  const dashboard = getDashboard("demo");
  res.json({ dashboard });
});

export default router;
