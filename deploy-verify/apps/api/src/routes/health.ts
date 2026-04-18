import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();

// GET /
router.get("/", (_req: Request, res: Response) => {
  res.json({ success: true, status: "ok" });
});

export default router;
