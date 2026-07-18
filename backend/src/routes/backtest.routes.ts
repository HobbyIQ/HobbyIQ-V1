// CF-BACKTEST-ACCURACY (Drew, 2026-07-17). Routes for the engine
// prediction-accuracy backtest. User-scoped: reads the user's
// inventory, computes accuracy against real sales in the same
// window. Trust builder — sellers see how often our predictions land.

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();

async function requireUserId(req: Request, res: Response): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return user.userId;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/backtest/predicted-price-accuracy?windowDays=90
//
// For each card in the caller's inventory, join persisted valuation
// snapshots with actual sold_comps in the same window; compute
// median absolute % error, hit rates, and over/undershoot bias.
// ────────────────────────────────────────────────────────────────────
router.get("/predicted-price-accuracy", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const rawWindow = String(req.query.windowDays ?? "90");
    const windowDays = Math.max(30, Math.min(365, Number(rawWindow) || 90));

    const { readUserDoc } = await import("../services/portfolioiq/portfolioStore.service.js");
    const doc = await readUserDoc(userId);
    const allItems = Object.values(doc.holdings ?? {});
    const holdings = allItems.filter((h) => (h as { cardStatus?: string }).cardStatus !== "pending-review");

    const { runBacktest } = await import("../services/backtest/backtestAccuracyAnalyze.service.js");
    const result = await runBacktest(holdings, windowDays);
    res.json({
      computedAt: new Date().toISOString(),
      scope: "user",
      totalCards: new Set(
        holdings.map((h) => (h.cardId ?? "").trim()).filter((s) => s.length > 0),
      ).size,
      accuracy: result,
    });
  } catch (err) { next(err); }
});

export default router;
