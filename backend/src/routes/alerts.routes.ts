// Routes: /api/alerts/preferences — user opt-in for DailyIQ + price alerts.
//
// All requests require `x-session-id`.

import { Router, Request, Response } from "express";
import { getUserBySession } from "../services/authService.js";
import {
  getUserAlertPreference,
  setDailyIQAlert,
  setPriceAlert,
} from "../repositories/alertPreferences.repository.js";
import {
  listAlertsForUser,
  createAlert,
  deleteAlert,
  type PriceAlertDirection,
  type PriceAlertCardSnapshot,
} from "../repositories/priceAlerts.repository.js";

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

// GET /api/alerts/preferences
router.get("/preferences", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const pref = await getUserAlertPreference(userId);
  res.json({
    success: true,
    preferences: pref ?? {
      userId,
      dailyIQAlerts: false,
      priceAlerts: false,
      updatedAt: null,
    },
  });
});

// PUT /api/alerts/preferences  body: { dailyIQAlerts?, priceAlerts? }
router.put("/preferences", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  try {
    if (typeof req.body?.dailyIQAlerts === "boolean") {
      await setDailyIQAlert(userId, req.body.dailyIQAlerts);
    }
    if (typeof req.body?.priceAlerts === "boolean") {
      await setPriceAlert(userId, req.body.priceAlerts);
    }
    const pref = await getUserAlertPreference(userId);
    res.json({ success: true, preferences: pref });
  } catch (err: any) {
    console.error("[alerts.routes] preferences update failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to update preferences" });
  }
});

// ---------------------------------------------------------------------------
// Per-card price alert CRUD. iOS `PriceAlertService.swift` consumes these.
// Records live in Cosmos container `compiq_alerts` (partition /userId) and
// are picked up by fn-price-alert-checker which re-prices each active alert
// and fires APNs on threshold cross.
// ---------------------------------------------------------------------------

function sanitizeSnapshot(raw: unknown): PriceAlertCardSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.playerName !== "string" || !s.playerName.trim()) return null;
  return {
    playerName: String(s.playerName).trim(),
    year: typeof s.year === "number" ? s.year : null,
    setName: typeof s.setName === "string" ? s.setName : null,
    cardNumber: typeof s.cardNumber === "string" ? s.cardNumber : null,
    grade: typeof s.grade === "string" ? s.grade : null,
    variant: typeof s.variant === "string" ? s.variant : null,
    printRun: typeof s.printRun === "number" ? s.printRun : null,
    isRookie: typeof s.isRookie === "boolean" ? s.isRookie : null,
  };
}

// GET /api/alerts — list this user's price alerts.
router.get("/", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  try {
    const alerts = await listAlertsForUser(userId);
    res.json({ success: true, alerts });
  } catch (err: any) {
    console.error("[alerts.routes] list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to load alerts" });
  }
});

// POST /api/alerts — create a price alert.
//   body: { cardId, playerName, targetPrice, direction: "above"|"below",
//           currentPrice?, cardSnapshot? }
router.post("/", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  const playerName = typeof body.playerName === "string" ? body.playerName.trim() : "";
  const targetPrice = typeof body.targetPrice === "number" ? body.targetPrice : Number(body.targetPrice);
  const dirRaw = String(body.direction ?? "").toLowerCase();
  const direction: PriceAlertDirection | null =
    dirRaw === "above" ? "above" : dirRaw === "below" ? "below" : null;
  const currentPrice = typeof body.currentPrice === "number" ? body.currentPrice : null;

  if (!cardId || !playerName || !Number.isFinite(targetPrice) || targetPrice <= 0 || !direction) {
    res.status(400).json({
      success: false,
      error: "cardId, playerName, targetPrice (>0), direction (above|below) are required",
    });
    return;
  }

  try {
    const created = await createAlert({
      userId,
      cardId,
      playerName,
      targetPrice,
      direction,
      currentPrice,
      cardSnapshot: sanitizeSnapshot(body.cardSnapshot),
    });
    if (!created) {
      res.status(500).json({ success: false, error: "Alert store unavailable" });
      return;
    }
    res.status(201).json({ success: true, alert: created });
  } catch (err: any) {
    console.error("[alerts.routes] create failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to create alert" });
  }
});

// DELETE /api/alerts/:alertId — remove a price alert (must belong to caller).
router.delete("/:alertId", async (req: Request, res: Response) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const alertId = String(req.params.alertId ?? "").trim();
  if (!alertId) {
    res.status(400).json({ success: false, error: "alertId is required" });
    return;
  }
  try {
    const ok = await deleteAlert(userId, alertId);
    if (!ok) {
      res.status(404).json({ success: false, error: "Alert not found" });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("[alerts.routes] delete failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to delete alert" });
  }
});

export default router;