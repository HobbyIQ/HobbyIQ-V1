import { Router, Request, Response } from "express";
import { getUserBySession } from "../services/authService.js";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  toggleAlert,
} from "../services/watchlist/watchlist.service.js";

const router = Router();

async function requireUser(req: Request, res: Response): Promise<{ userId: string } | null> {
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
  return { userId: user.userId };
}

// GET /api/watchlist
router.get("/", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  try {
    const items = await getWatchlist(auth.userId);
    res.json({ success: true, items });
  } catch (err: any) {
    console.error("[watchlist] GET failed:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Internal error" });
  }
});

// POST /api/watchlist  body: { playerId, playerName, sport?, alertEnabled? }
router.post("/", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const playerId = String(req.body?.playerId ?? "").trim();
  const playerName = String(req.body?.playerName ?? "").trim();
  if (!playerId || !playerName) {
    res.status(400).json({ success: false, error: "playerId and playerName are required" });
    return;
  }
  try {
    const item = await addToWatchlist(auth.userId, {
      playerId,
      playerName,
      sport: req.body?.sport,
      alertEnabled: req.body?.alertEnabled,
    });
    res.json({ success: true, watchlistItemId: item.id, item });
  } catch (err: any) {
    console.error("[watchlist] POST failed:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Internal error" });
  }
});

// DELETE /api/watchlist/:itemId
router.delete("/:itemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const itemId = String(req.params.itemId ?? "").trim();
  if (!itemId) {
    res.status(400).json({ success: false, error: "itemId is required" });
    return;
  }
  try {
    const removed = await removeFromWatchlist(auth.userId, itemId);
    if (!removed) {
      res.status(404).json({ success: false, error: "Watchlist item not found" });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("[watchlist] DELETE failed:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Internal error" });
  }
});

// PATCH /api/watchlist/:itemId  body: { alertEnabled }
router.patch("/:itemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const itemId = String(req.params.itemId ?? "").trim();
  if (!itemId) {
    res.status(400).json({ success: false, error: "itemId is required" });
    return;
  }
  if (typeof req.body?.alertEnabled !== "boolean") {
    res.status(400).json({ success: false, error: "alertEnabled (boolean) is required" });
    return;
  }
  try {
    const item = await toggleAlert(auth.userId, itemId, req.body.alertEnabled);
    if (!item) {
      res.status(404).json({ success: false, error: "Watchlist item not found" });
      return;
    }
    res.json({ success: true, item });
  } catch (err: any) {
    console.error("[watchlist] PATCH failed:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Internal error" });
  }
});

export default router;
