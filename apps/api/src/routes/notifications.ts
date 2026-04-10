import { Router } from "express";
import type { Request, Response } from "express";
import { getNotifications } from "../services/notification";

const router = Router();

// GET /api/notifications
router.get("/notifications", (_req: Request, res: Response) => {
  // In production, use userId from auth/session
  const notifications = getNotifications("demo");
  res.json({ notifications });
});

export default router;
