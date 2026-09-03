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
//
// ── CF-PRO-SELLER-GATE (Drew, 2026-09-02): DELIBERATELY LEFT UNGATED ──
//
// This route is the known conflict in that ruling, and it is recorded here
// rather than resolved silently, because the next person to read the gate
// list will otherwise find this route and assume it was simply missed.
//
// buildActionPlan() calls detectSellNowCandidates (the sell-now-radar
// engine) at dailyIqActionPlanAnalyze.service.ts:93 and analyzeHoldingGradeWorthy
// (the grade-arb engine) at :179 — the SAME two engines whose dedicated HTTP
// routes this CF just put behind requireEntitlement("sellerIntelligence").
// Those are in-process service calls, so gating the routes does not touch
// this path: a free user still receives SELL_NOW and GRADE_UP verdicts here.
//
// That is INTENTIONAL and it is the ruling's own constraint. This surface
// shipped free (PR #546, 2026-07-17) and iOS has rendered it as the DailyIQ
// tab hero for a free user ever since. The ruling gates the five Pro Seller
// routes; it does not authorize taking away a surface the free tier already
// had. Gating this route would be a REGRESSION of a free surface, which was
// explicitly excluded — so the free tier keeps the action plan exactly as it
// is today, verdicts included.
//
// What the free tier does NOT get, after this CF: the dedicated seller
// surfaces themselves — the ranked sell-now-radar candidate list with its
// velocity multiples and urgency scores, the notable-sales deal feed, the
// portfolio-wide grade-arb scan with expected-gain figures, the per-holding
// sellSignal on the portfolio wire, and the fee/P&L summary. The action plan
// emits a VERDICT per card ("SELL_NOW", with a reason sentence); the gated
// surfaces emit the underlying seller intelligence — the measured numbers,
// ranked and quantified. Free keeps the conclusion it already had; the paid
// tiers get the evidence. Anyone narrowing that line later should change it
// deliberately, with Drew, and not by adding a middleware here.
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
    const plan = await buildActionPlan(holdings, userId);
    res.json(plan);
  } catch (err) { next(err); }
});

export default router;
