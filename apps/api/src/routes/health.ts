import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();

// GET /api/health
router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

export default router;
