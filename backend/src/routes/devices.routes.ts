// Routes: /api/devices/* — register & remove APNs device tokens for the
// currently-signed-in user. Requires `x-session-id` via requireSession.
// Available on all plans (free included) so users can receive auth /
// system notifications regardless of subscription state.

import { Router, Request, Response } from "express";
import { registerToken, removeToken } from "../repositories/deviceToken.repository.js";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();
router.use(requireSession);

// POST /api/devices/token  body: { token, platform?, bundleId? }
router.post("/token", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

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
  const userId = req.user!.userId;
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
