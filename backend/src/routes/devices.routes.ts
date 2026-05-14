// Routes: /api/devices/* — register & remove APNs device tokens for the
// currently-signed-in user. Requires `x-session-id` header.

import { Router, Request, Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { registerToken, removeToken } from "../repositories/deviceToken.repository.js";

const router = Router();

async function requireUserId(req: Request, res: Response): Promise<string | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid session" });
    return null;
  }
  return user.userId;
}

// POST /api/devices/token  body: { token, platform?, bundleId? }
router.post("/token", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;

  const token = String(req.body?.token ?? req.body?.deviceToken ?? "").trim();
  const platformRaw = String(req.body?.platform ?? "ios").trim().toLowerCase();
  const platform: "ios" | "android" = platformRaw === "android" ? "android" : "ios";
  const bundleId = typeof req.body?.bundleId === "string" ? req.body.bundleId : undefined;

  if (!token || token.length < 16 || token.length > 256) {
    res.status(400).json({ success: false, error: "Invalid token" });
    return;
  }

  try {
    await registerToken(userId, token, platform, bundleId);
    res.json({ success: true });
  } catch (err: any) {
    console.error("[devices.routes] registerToken failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to register token" });
  }
});

// DELETE /api/devices/token  body: { token }
router.delete("/token", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const token = String(req.body?.token ?? req.body?.deviceToken ?? "").trim();
  if (!token) {
    res.status(400).json({ success: false, error: "Missing token" });
    return;
  }
  try {
    await removeToken(userId, token);
    res.json({ success: true });
  } catch (err: any) {
    console.error("[devices.routes] removeToken failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to remove token" });
  }
});

export default router;
