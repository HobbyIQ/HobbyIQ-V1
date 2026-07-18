// CF-DAILYIQ-ACTION-PLAN (Drew, 2026-07-17). Route surface for the
// master DailyIQ Action Plan aggregator. Kept in its own file so the
// (currently broken-imports-riddled) dailyiq.routes.ts doesn't gate
// this addition — this file has clean, minimal imports.
//
// Mount: app.ts mounts under both /api/dailyiq and /api/dailyIQ so
// iOS's existing casing tolerance works without new client code.

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
// GET /api/dailyiq/action-plan
//
// Reads the current user's inventory + all per-holding signals we've
// built over the past week (matched-cohort momentum, sell-radar,
// grade-worthy, cascade), emits a sorted list of per-card verdicts
// (SELL_NOW / GRADE_UP / LIST_HIGHER / WAIT_TO_LIST / HOLD) with
// urgency scores. iOS renders the top N as the DailyIQ tab hero.
// ────────────────────────────────────────────────────────────────────
router.get("/action-plan", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const { readUserDoc } = await import("../services/portfolioiq/portfolioStore.service.js");
    const doc = await readUserDoc(userId);
    const allItems = Object.values(doc.holdings ?? {});
    const holdings = allItems.filter((h) => (h as { cardStatus?: string }).cardStatus !== "pending-review");

    const { buildActionPlan } = await import("../services/dailyiq/dailyIqActionPlanAnalyze.service.js");
    const plan = await buildActionPlan(holdings);
    res.json(plan);
  } catch (err) { next(err); }
});

export default router;
