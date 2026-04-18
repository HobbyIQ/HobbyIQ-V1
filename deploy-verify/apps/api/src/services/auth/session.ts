import { Request, Response, NextFunction } from "express";
import { getSession } from "./service";

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.headers["x-session-id"] as string || req.cookies?.sessionId;
  if (!sessionId) return res.status(401).json({ success: false, error: "Not authenticated" });
  const session = await getSession(sessionId);
  if (!session) return res.status(401).json({ success: false, error: "Invalid session" });
  (req as any).sessionId = sessionId;
  (req as any).userId = session.userId;
  next();
}
