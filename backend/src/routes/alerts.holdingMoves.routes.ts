// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): /api/alerts/holding-moves CRUD.
//
// One rule per holding: "tell me when this card moves N%". The manage
// surface on the web holding view is the only client today; iOS can adopt
// the same three verbs unchanged.
//
// Gating: requireSession only — deliberately NOT requireEntitlement
// ("advancedAlerts"). A percent-move alert on a card you own is the plain
// meaning of a portfolio tracker, not the multi-condition rule builder the
// advancedAlerts entitlement sells; putting it behind that paywall would
// make the free tier's portfolio silently unable to tell its owner their
// card moved. The per-user/day cap is what bounds cost here, and it applies
// to every tier.

import { Router, Request, Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import {
  deleteRule,
  getRuleForHolding,
  listRulesForUser,
  upsertRule,
} from "../repositories/holdingMoveAlerts.repository.js";
import {
  dailyCap,
  normalizeRuleInput,
  MAX_THRESHOLD_PCT,
  MAX_WINDOW_HOURS,
  MIN_THRESHOLD_PCT,
  MIN_WINDOW_HOURS,
} from "../services/advancedAlerts/holdingMoveRule.js";

const router = Router();
router.use(requireSession);

function userIdFrom(req: Request): string {
  return req.user!.userId;
}

/** Every move rule the user has, plus today's remaining budget. */
router.get("/", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  try {
    const rules = await listRulesForUser(userId);
    res.json({ success: true, rules, dailyCap: dailyCap() });
  } catch (err: any) {
    console.error("[alerts.holdingMoves] list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to list rules" });
  }
});

/** The rule on one holding, or null. Drives the manage widget's initial state. */
router.get("/:holdingId", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  const holdingId = String(req.params.holdingId ?? "").trim();
  if (!holdingId) {
    return res.status(400).json({ success: false, error: "holdingId is required" });
  }
  try {
    const rule = await getRuleForHolding(userId, holdingId);
    res.json({ success: true, rule: rule ?? null, dailyCap: dailyCap() });
  } catch (err: any) {
    console.error("[alerts.holdingMoves] get failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to read rule" });
  }
});

/**
 * Create or replace the rule on a holding. PUT rather than POST because it
 * is an upsert keyed by holdingId — a second save on the same card edits the
 * existing rule rather than stacking a rival one (see upsertRule's note).
 */
router.put("/:holdingId", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  const holdingId = String(req.params.holdingId ?? "").trim();
  if (!holdingId) {
    return res.status(400).json({ success: false, error: "holdingId is required" });
  }
  const normalized = normalizeRuleInput(req.body);
  if (!normalized) {
    return res.status(400).json({
      success: false,
      error:
        `thresholdPct must be ${MIN_THRESHOLD_PCT}..${MAX_THRESHOLD_PCT}; ` +
        `windowHours ${MIN_WINDOW_HOURS}..${MAX_WINDOW_HOURS}; ` +
        `direction one of up|down|any`,
    });
  }
  const isActiveRaw = (req.body ?? {}).isActive;
  if (isActiveRaw !== undefined && typeof isActiveRaw !== "boolean") {
    return res.status(400).json({ success: false, error: "isActive must be a boolean" });
  }
  try {
    const rule = await upsertRule({
      userId,
      holdingId,
      thresholdPct: normalized.thresholdPct,
      direction: normalized.direction,
      windowHours: normalized.windowHours,
      isActive: isActiveRaw !== false,
    });
    if (!rule) {
      return res.status(503).json({ success: false, error: "Alert store unavailable" });
    }
    res.json({ success: true, rule });
  } catch (err: any) {
    console.error("[alerts.holdingMoves] upsert failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to save rule" });
  }
});

router.delete("/:holdingId", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  const holdingId = String(req.params.holdingId ?? "").trim();
  if (!holdingId) {
    return res.status(400).json({ success: false, error: "holdingId is required" });
  }
  try {
    const existing = await getRuleForHolding(userId, holdingId);
    if (!existing) return res.status(404).json({ success: false, error: "Rule not found" });
    const ok = await deleteRule(userId, existing.ruleId);
    if (!ok) return res.status(404).json({ success: false, error: "Rule not found" });
    res.json({ success: true });
  } catch (err: any) {
    console.error("[alerts.holdingMoves] delete failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to delete rule" });
  }
});

export default router;
