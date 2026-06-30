// CF-ADVANCED-ALERTS (2026-06-03): /api/alerts/advanced CRUD.
//
// All routes: requireSession → requireEntitlement("advancedAlerts"). POST
// additionally goes through requireCapacity("priceAlerts", combinedCount)
// — basic alerts and advanced rules share the same per-tier budget (free=0,
// collector=10, investor=30, pro_seller=unlimited). iOS surfaces the sum
// as the user-facing "X / cap" count.

import { Router, Request, Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import { requireCapacity } from "../middleware/requireCapacity.js";
import {
  countActiveRulesForUser,
  createRule,
  deleteRule,
  getRuleForUser,
  listRulesForUser,
  updateRule,
  type AdvancedAlertCombinator,
  type AdvancedAlertCondition,
  type AdvancedAlertScope,
} from "../repositories/advancedAlertRules.repository.js";
import { listAlertsForUser } from "../repositories/priceAlerts.repository.js";
import type { TrendIQCoverage } from "../services/compiq/trendIQ.types.js";

const router = Router();

router.use(requireSession);
router.use(requireEntitlement("advancedAlerts"));

function userIdFrom(req: Request): string {
  return req.user!.userId;
}

// ─── Body validators ────────────────────────────────────────────────────────

const VALID_COVERAGES: ReadonlySet<TrendIQCoverage> = new Set([
  "insufficient",
  "player_only",
  "card_only",
  "segment_only",
  "no_segment",
  "no_card",
  "full",
]);

function isNumberInRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

function validateScope(raw: unknown): AdvancedAlertScope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "card":
      if (typeof r.cardId !== "string" || !r.cardId.trim()) return null;
      return {
        type: "card",
        cardId: String(r.cardId).trim(),
        gradeCompany:
          typeof r.gradeCompany === "string" && r.gradeCompany ? r.gradeCompany : undefined,
        gradeValue: typeof r.gradeValue === "number" ? r.gradeValue : undefined,
      };
    case "player":
      if (typeof r.playerName !== "string" || !r.playerName.trim()) return null;
      return {
        type: "player",
        playerName: String(r.playerName).trim(),
        gradeCompany:
          typeof r.gradeCompany === "string" && r.gradeCompany ? r.gradeCompany : undefined,
        gradeValue: typeof r.gradeValue === "number" ? r.gradeValue : undefined,
      };
    case "watchlist":
      return { type: "watchlist" };
    case "holdings":
      return { type: "holdings" };
    default:
      return null;
  }
}

/**
 * CF-ADVANCED-ALERTS pre-deploy fix (2026-06-03): the two crossing-class
 * kinds (price_crosses, predicted_price_crosses) are inert in Phase 1
 * because the evaluator has no per-rule previous-slice storage — the
 * pure-function evaluator always sees `previousEstimate=null` and returns
 * false. Accepting them at the API layer would let a user create a rule
 * that silently never alerts (launch trap). Reject explicitly with a
 * "not yet supported" error. They stay in the type enum so a future CF
 * can flip the switch by deleting this guard once last-slice storage
 * lands.
 */
const NOT_YET_SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  "price_crosses",
  "predicted_price_crosses",
]);

type ConditionResult = { ok: AdvancedAlertCondition } | { error: string };

function validateCondition(raw: unknown): ConditionResult {
  if (!raw || typeof raw !== "object") {
    return { error: "condition must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  if (NOT_YET_SUPPORTED_KINDS.has(kind)) {
    return {
      error: `condition kind "${kind}" is not yet supported (Phase 1 requires per-rule previous-slice storage; coming in a follow-up CF)`,
    };
  }
  switch (r.kind) {
    case "predicted_direction":
      if (r.equals !== "up" && r.equals !== "down") {
        return { error: "predicted_direction.equals must be 'up' or 'down'" };
      }
      return { ok: { kind: "predicted_direction", equals: r.equals } };
    case "predicted_pct_move":
      if (r.op !== "gte" && r.op !== "lte") {
        return { error: "predicted_pct_move.op must be 'gte' or 'lte'" };
      }
      if (!isNumberInRange(r.value, -100, 100)) {
        return { error: "predicted_pct_move.value must be -100..100" };
      }
      return { ok: { kind: "predicted_pct_move", op: r.op, value: r.value } };
    case "trendiq_composite":
      if (r.op !== "gte" && r.op !== "lte") {
        return { error: "trendiq_composite.op must be 'gte' or 'lte'" };
      }
      if (!isNumberInRange(r.value, 0.5, 2.0)) {
        return { error: "trendiq_composite.value must be 0.5..2.0" };
      }
      return { ok: { kind: "trendiq_composite", op: r.op, value: r.value } };
    case "trendiq_coverage_min":
      if (
        typeof r.value !== "string" ||
        !VALID_COVERAGES.has(r.value as TrendIQCoverage)
      ) {
        return { error: "trendiq_coverage_min.value must be a valid coverage tier" };
      }
      return { ok: { kind: "trendiq_coverage_min", value: r.value as TrendIQCoverage } };
    case "confidence_min":
      if (!isNumberInRange(r.value, 0, 100)) {
        return { error: "confidence_min.value must be 0..100" };
      }
      return { ok: { kind: "confidence_min", value: r.value } };
    default:
      return { error: `unknown condition kind "${kind}"` };
  }
}

interface ValidatedRuleInput {
  name: string;
  scope: AdvancedAlertScope;
  combinator: AdvancedAlertCombinator;
  conditions: AdvancedAlertCondition[];
  cooldownMin: number;
  isActive: boolean;
}

function validateRuleInput(body: unknown): { ok: ValidatedRuleInput } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) {
    return { error: "name is required (1..80 chars)" };
  }
  const scope = validateScope(b.scope);
  if (!scope) return { error: "scope is invalid (need type=card|player|watchlist|holdings)" };
  const combinator: AdvancedAlertCombinator =
    b.combinator === "OR" ? "OR" : b.combinator === "AND" ? "AND" : "AND";
  if (!Array.isArray(b.conditions) || b.conditions.length < 1 || b.conditions.length > 5) {
    return { error: "conditions must be an array of 1..5 entries" };
  }
  const conditions: AdvancedAlertCondition[] = [];
  for (const raw of b.conditions) {
    const result = validateCondition(raw);
    if ("error" in result) return { error: result.error };
    conditions.push(result.ok);
  }
  const rawCooldown = b.cooldownMin;
  const cooldownMin =
    typeof rawCooldown === "number" && isNumberInRange(rawCooldown, 60, 1440)
      ? rawCooldown
      : 360;
  const isActive = typeof b.isActive === "boolean" ? b.isActive : true;
  return { ok: { name, scope, combinator, conditions, cooldownMin, isActive } };
}

// ─── Shared-cap counter ─────────────────────────────────────────────────────

/**
 * Sum of active basic price alerts + active advanced rules — the value the
 * `priceAlerts` cap is checked against. Same helper is used by basic
 * /api/alerts POST so both creates honor the shared budget.
 */
export async function countCombinedActiveAlerts(userId: string): Promise<number> {
  // Treat `isActive` as truthy-by-default (mirrors priceAlerts.repository's
  // own `isActive: doc.isActive !== false` convention). An alert that has
  // already triggered explicitly sets `isActive: false` and drops from
  // this count; legacy alerts that never had the field stay active.
  const [basic, advanced] = await Promise.all([
    listAlertsForUser(userId).then(
      (arr) => arr.filter((a) => a?.isActive !== false).length,
    ),
    countActiveRulesForUser(userId),
  ]);
  return basic + advanced;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  try {
    const rules = await listRulesForUser(userId);
    res.json({ success: true, rules });
  } catch (err: any) {
    console.error("[alerts.advanced] list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to load advanced rules" });
  }
});

router.get("/:ruleId", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  const ruleId = String(req.params.ruleId ?? "").trim();
  if (!ruleId) {
    return res.status(400).json({ success: false, error: "ruleId is required" });
  }
  try {
    const rule = await getRuleForUser(userId, ruleId);
    if (!rule) return res.status(404).json({ success: false, error: "Rule not found" });
    res.json({ success: true, rule });
  } catch (err: any) {
    console.error("[alerts.advanced] get failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to load rule" });
  }
});

router.post(
  "/",
  requireCapacity("priceAlerts", countCombinedActiveAlerts),
  async (req: Request, res: Response) => {
    const userId = userIdFrom(req);
    const validated = validateRuleInput(req.body);
    if ("error" in validated) {
      return res.status(400).json({ success: false, error: validated.error });
    }
    try {
      const created = await createRule({
        userId,
        ...validated.ok,
      });
      if (!created) {
        return res
          .status(500)
          .json({ success: false, error: "Advanced-rule store unavailable" });
      }
      res.status(201).json({ success: true, rule: created });
    } catch (err: any) {
      console.error("[alerts.advanced] create failed:", err?.message ?? err);
      res.status(500).json({ success: false, error: "Failed to create rule" });
    }
  },
);

router.patch("/:ruleId", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  const ruleId = String(req.params.ruleId ?? "").trim();
  if (!ruleId) {
    return res.status(400).json({ success: false, error: "ruleId is required" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: {
    name?: string;
    scope?: AdvancedAlertScope;
    combinator?: AdvancedAlertCombinator;
    conditions?: AdvancedAlertCondition[];
    cooldownMin?: number;
    isActive?: boolean;
  } = {};
  if (typeof body.name === "string") {
    const n = body.name.trim();
    if (!n || n.length > 80) {
      return res.status(400).json({ success: false, error: "name must be 1..80 chars" });
    }
    patch.name = n;
  }
  if (body.scope !== undefined) {
    const s = validateScope(body.scope);
    if (!s) return res.status(400).json({ success: false, error: "scope is invalid" });
    patch.scope = s;
  }
  if (body.combinator !== undefined) {
    if (body.combinator !== "AND" && body.combinator !== "OR") {
      return res.status(400).json({ success: false, error: "combinator must be AND or OR" });
    }
    patch.combinator = body.combinator;
  }
  if (body.conditions !== undefined) {
    if (
      !Array.isArray(body.conditions) ||
      body.conditions.length < 1 ||
      body.conditions.length > 5
    ) {
      return res
        .status(400)
        .json({ success: false, error: "conditions must be an array of 1..5 entries" });
    }
    const parsed: AdvancedAlertCondition[] = [];
    for (const raw of body.conditions) {
      const result = validateCondition(raw);
      if ("error" in result) {
        return res.status(400).json({ success: false, error: result.error });
      }
      parsed.push(result.ok);
    }
    patch.conditions = parsed;
  }
  if (body.cooldownMin !== undefined) {
    if (!isNumberInRange(body.cooldownMin, 60, 1440)) {
      return res
        .status(400)
        .json({ success: false, error: "cooldownMin must be 60..1440" });
    }
    patch.cooldownMin = body.cooldownMin;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return res.status(400).json({ success: false, error: "isActive must be a boolean" });
    }
    patch.isActive = body.isActive;
  }
  try {
    const updated = await updateRule(userId, ruleId, patch);
    if (!updated) return res.status(404).json({ success: false, error: "Rule not found" });
    res.json({ success: true, rule: updated });
  } catch (err: any) {
    console.error("[alerts.advanced] patch failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to update rule" });
  }
});

router.delete("/:ruleId", async (req: Request, res: Response) => {
  const userId = userIdFrom(req);
  const ruleId = String(req.params.ruleId ?? "").trim();
  if (!ruleId) {
    return res.status(400).json({ success: false, error: "ruleId is required" });
  }
  try {
    const ok = await deleteRule(userId, ruleId);
    if (!ok) return res.status(404).json({ success: false, error: "Rule not found" });
    res.json({ success: true });
  } catch (err: any) {
    console.error("[alerts.advanced] delete failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to delete rule" });
  }
});

export default router;
