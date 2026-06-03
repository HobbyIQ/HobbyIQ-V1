// CF-PAYMENTS-A (2026-06-02): requireSession middleware.
//
// Validates x-session-id, looks up the user via getUserBySession, attaches
// req.user (typed AuthUser including `plan`). 401 on absent/invalid.
//
// Replaces the inline `resolveUser` / `requireUserId` / `requireSessionUser`
// helpers that were repeated across 10 route files. Each retrofitted route
// declares `requireSession` either at router-level (router.use) or per-
// endpoint, depending on whether all sibling routes need auth.

import type { Request, Response, NextFunction } from "express";
import { getUserBySession } from "../services/authService.js";

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // If a previous instance of requireSession already attached a user (e.g.
  // multiple mounts under different path prefixes), short-circuit.
  if (req.user) {
    next();
    return;
  }

  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  req.user = user;
  next();
}
