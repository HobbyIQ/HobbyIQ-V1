// CF-ADVANCED-ALERTS (2026-06-03): scheduled rule evaluator orchestrator.
//
// Walks every active advanced rule, resolves the rule's `scope` into a set
// of concrete (target, gradeFilter) pairs, dedups identical targets across
// rules within the pass (Cardsight cache works at upstream layer; this
// dedups computeEstimate orchestration calls too), runs computeEstimate
// per target, applies `conditionEvaluator.evaluateRule`, respects per-rule
// cooldown, fires APNs `sendPriceAlertNotification` with
// `data.type = "advanced_alert"` on hit.
//
// Target cap per rule (default 50) — see ADVANCED_ALERT_TARGETS_PER_RULE_MAX.
// When a scope exceeds the cap, we evaluate up to the cap and log a single
// structured overflow line so we can spot rules that are exploding the
// per-cycle compute budget.
//
// All APNs sends route through notification.service which no-ops cleanly
// when APNS_* env vars are not configured.

import {
  listAllActiveRules,
  recordRuleEvaluation,
  type AdvancedAlertRule,
  type AdvancedAlertScope,
  type AdvancedAlertCondition,
} from "../../repositories/advancedAlertRules.repository.js";
import { computeEstimate } from "../compiq/compiqEstimate.service.js";
import { sendAdvancedAlertNotification } from "../notification.service.js";
import {
  evaluateRule,
  type EvaluationEstimateSlice,
} from "./conditionEvaluator.js";
import type {
  CompIQEstimateRequest,
  PredictionCallContext,
} from "../../types/compiq.types.js";
import { getWatchlistEntries } from "../dailyiq/watchlistStore.service.js";
import {
  buildEstimateRequestFromHolding,
  readUserDoc,
} from "../portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

export const ADVANCED_ALERT_TARGETS_PER_RULE_DEFAULT = 50;

function targetsPerRuleCap(): number {
  const raw = Number(process.env.ADVANCED_ALERT_TARGETS_PER_RULE_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : ADVANCED_ALERT_TARGETS_PER_RULE_DEFAULT;
}

// ─── Target model ───────────────────────────────────────────────────────────

/**
 * A single computeEstimate invocation the evaluator wants to make.
 * `key` is the per-pass dedup string — identical keys resolve to one fetch.
 * `holdingId` is set ONLY for scope=holdings so the prediction corpus
 * attribution stays honest.
 */
export interface EvaluationTarget {
  key: string;
  request: CompIQEstimateRequest;
  holdingId: string | null;
}

function gradeSuffix(
  gradeCompany?: string,
  gradeValue?: number,
): string {
  if (!gradeCompany || typeof gradeValue !== "number") return "raw";
  return `${gradeCompany.toUpperCase()}_${gradeValue}`;
}

function targetFromCard(
  cardsightCardId: string,
  gradeCompany?: string,
  gradeValue?: number,
): EvaluationTarget {
  return {
    key: `card:${cardsightCardId}:${gradeSuffix(gradeCompany, gradeValue)}`,
    request: {
      playerName: cardsightCardId,
      cardsightCardId,
      gradeCompany,
      gradeValue,
    },
    holdingId: null,
  };
}

function targetFromPlayer(
  playerName: string,
  gradeCompany?: string,
  gradeValue?: number,
): EvaluationTarget {
  const norm = playerName.trim();
  return {
    key: `player:${norm.toLowerCase()}:${gradeSuffix(gradeCompany, gradeValue)}`,
    request: { playerName: norm, gradeCompany, gradeValue },
    holdingId: null,
  };
}

function parseGradeString(raw: string | null | undefined): {
  gradeCompany?: string;
  gradeValue?: number;
} {
  if (!raw) return {};
  const m = raw.trim().match(/^([A-Za-z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return {};
  const v = Number(m[2]);
  if (!Number.isFinite(v)) return {};
  return { gradeCompany: m[1].toUpperCase(), gradeValue: v };
}

function targetFromHolding(holding: PortfolioHolding): EvaluationTarget | null {
  if (!holding.playerName?.trim()) return null;
  // CF-HOLDING-ESTIMATE-INPUT-CONSOLIDATION (2026-06-18): route through the
  // single helper in portfolioStore.service.ts. Brings this site up to the
  // canonical shape sites 1 and 2 already use — see the helper's doc comment
  // for the seven drift corrections this site adopts (primarily: pinned
  // cardsightCardId + pinnedAuthoritative flag for stored-cardId holdings,
  // and `isAuto` declaration so auto holdings stop mixing with non-auto
  // comps in alert pricing). Key/holdingId semantics preserved — the
  // dedup key still includes the per-target grade suffix derived from the
  // canonical fallback order.
  const request = buildEstimateRequestFromHolding(holding);
  return {
    key: `holding:${holding.id}:${gradeSuffix(request.gradeCompany, request.gradeValue)}`,
    request,
    holdingId: holding.id,
  };
}

/**
 * Resolve a rule's scope into a list of concrete targets to evaluate.
 * Logs + truncates when the resolved set exceeds the per-rule cap (default
 * 50). Returns `{targets, overflow}` so the caller can decide whether to
 * keep going + so tests can assert overflow semantics.
 */
export async function resolveTargets(
  rule: AdvancedAlertRule,
): Promise<{ targets: EvaluationTarget[]; overflow: boolean }> {
  const cap = targetsPerRuleCap();
  const scope: AdvancedAlertScope = rule.scope;
  let resolved: EvaluationTarget[] = [];

  switch (scope.type) {
    case "card":
      resolved = [
        targetFromCard(scope.cardsightCardId, scope.gradeCompany, scope.gradeValue),
      ];
      break;
    case "player":
      resolved = [
        targetFromPlayer(scope.playerName, scope.gradeCompany, scope.gradeValue),
      ];
      break;
    case "watchlist": {
      try {
        const entries = await getWatchlistEntries(rule.userId);
        resolved = entries
          .filter((e) => !!e.playerName?.trim())
          .map((e) => targetFromPlayer(e.playerName!));
      } catch (err: any) {
        console.warn(
          `[advanced.alert.evaluator] watchlist resolve failed rule=${rule.ruleId}:`,
          err?.message ?? err,
        );
      }
      break;
    }
    case "holdings": {
      try {
        const doc = await readUserDoc(rule.userId);
        resolved = Object.values(doc.holdings ?? {})
          .map((h) => targetFromHolding(h))
          .filter((t): t is EvaluationTarget => t !== null);
      } catch (err: any) {
        console.warn(
          `[advanced.alert.evaluator] holdings resolve failed rule=${rule.ruleId}:`,
          err?.message ?? err,
        );
      }
      break;
    }
  }

  if (resolved.length > cap) {
    console.warn(
      `[advanced.alert.evaluator] rule overflow rule=${rule.ruleId} userId=${rule.userId} ` +
        `scope=${scope.type} resolved=${resolved.length} cap=${cap} — evaluating first ${cap} targets`,
    );
    return { targets: resolved.slice(0, cap), overflow: true };
  }
  return { targets: resolved, overflow: false };
}

// ─── Estimate slicing ───────────────────────────────────────────────────────

export function sliceEstimate(est: Record<string, unknown>): EvaluationEstimateSlice {
  const fmv = (est as { fairMarketValue?: unknown }).fairMarketValue;
  const pred = (est as { predictedPrice?: unknown }).predictedPrice;
  const conf = (est as { confidence?: { pricingConfidence?: number } | number }).confidence;
  const pc =
    typeof conf === "number"
      ? conf
      : typeof conf === "object" && conf !== null && typeof conf.pricingConfidence === "number"
      ? conf.pricingConfidence
      : null;
  const trendIQ = (est as { trendIQ?: any }).trendIQ;
  return {
    fairMarketValue: typeof fmv === "number" ? fmv : null,
    predictedPrice: typeof pred === "number" ? pred : null,
    pricingConfidence: pc,
    trendIQ:
      trendIQ && typeof trendIQ === "object"
        ? {
            composite: Number(trendIQ.composite),
            direction: trendIQ.direction,
            coverage: trendIQ.coverage,
          }
        : null,
  };
}

// ─── Cooldown gate ──────────────────────────────────────────────────────────

export function cooldownActive(rule: AdvancedAlertRule, nowMs: number = Date.now()): boolean {
  if (!rule.lastTriggeredAt) return false;
  const last = Date.parse(rule.lastTriggeredAt);
  if (!Number.isFinite(last)) return false;
  return nowMs - last < rule.cooldownMin * 60 * 1000;
}

// ─── Push payload formatter ─────────────────────────────────────────────────

function describeCondition(c: AdvancedAlertCondition): string {
  switch (c.kind) {
    case "predicted_direction":
      return `Predicted ${c.equals}`;
    case "predicted_pct_move":
      return `Predicted move ${c.op === "gte" ? "≥" : "≤"} ${c.value}%`;
    case "trendiq_composite":
      return `TrendIQ ${c.op === "gte" ? "≥" : "≤"} ${c.value}`;
    case "trendiq_coverage_min":
      return `Coverage ≥ ${c.value}`;
    case "confidence_min":
      return `Confidence ≥ ${c.value}`;
    case "price_crosses":
      return `Price crossed ${c.op} $${c.value}`;
    case "predicted_price_crosses":
      return `Predicted price crossed ${c.op} $${c.value}`;
  }
}

function buildPushPayload(rule: AdvancedAlertRule): { title: string; body: string } {
  const title = `🎯 ${rule.name}`;
  const summary = rule.conditions.slice(0, 2).map(describeCondition).join(", ");
  const tail = rule.conditions.length > 2 ? "…" : "";
  return {
    title,
    body: `${summary}${tail}`,
  };
}

// ─── Pass-level orchestration ───────────────────────────────────────────────

export interface AdvancedAlertEvaluatorSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  rulesEvaluated: number;
  rulesTriggered: number;
  cooldownSkipped: number;
  pushSent: number;
  pushFailed: number;
  rulesOverflowed: number;
  estimatesFetched: number;
  estimatesCached: number; // dedup hits within this pass
}

const PER_TARGET_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _running = false;

export async function runAdvancedAlertsEvaluator(): Promise<AdvancedAlertEvaluatorSummary> {
  const startedAt = new Date();
  if (_running) {
    console.warn("[advanced.alert.evaluator] already running; skipping overlap");
    return emptySummary(startedAt);
  }
  _running = true;

  const summary: AdvancedAlertEvaluatorSummary = emptySummary(startedAt);

  try {
    const rules = await listAllActiveRules();
    console.log(`[advanced.alert.evaluator] start active=${rules.length}`);

    // Per-pass dedup cache: identical target keys share one computeEstimate
    // Promise. The Cardsight client already caches by cardId at the
    // upstream layer; this dedups the local orchestration too.
    const estimateCache = new Map<string, Promise<EvaluationEstimateSlice | null>>();

    for (const rule of rules) {
      summary.rulesEvaluated += 1;

      if (cooldownActive(rule)) {
        summary.cooldownSkipped += 1;
        continue;
      }

      const { targets, overflow } = await resolveTargets(rule);
      if (overflow) summary.rulesOverflowed += 1;

      let triggeredAtLeastOnce = false;
      for (const target of targets) {
        const existing = estimateCache.get(target.key);
        let slicePromise: Promise<EvaluationEstimateSlice | null>;
        if (existing) {
          summary.estimatesCached += 1;
          slicePromise = existing;
        } else {
          slicePromise = (async () => {
            try {
              const callContext: PredictionCallContext = {
                source: "advanced-alert-evaluator",
                userId: rule.userId,
                holdingId: target.holdingId,
                routedFromHolding: target.holdingId !== null,
              };
              const est = await computeEstimate(target.request, callContext);
              return sliceEstimate(est as Record<string, unknown>);
            } catch (err: any) {
              console.warn(
                `[advanced.alert.evaluator] computeEstimate failed rule=${rule.ruleId} target=${target.key}:`,
                err?.message ?? err,
              );
              return null;
            }
          })();
          estimateCache.set(target.key, slicePromise);
          summary.estimatesFetched += 1;
          if (PER_TARGET_DELAY_MS > 0) await sleep(PER_TARGET_DELAY_MS);
        }

        const slice = await slicePromise;
        if (!slice) continue;

        const matched = evaluateRule(rule.combinator, rule.conditions, slice, null);
        if (!matched) continue;

        triggeredAtLeastOnce = true;
        const payload = buildPushPayload(rule);
        try {
          const res = await sendAdvancedAlertNotification(rule.userId, {
            title: payload.title,
            body: payload.body,
            ruleId: rule.ruleId,
            cardsightCardId: target.request.cardsightCardId ?? null,
            scopeType: rule.scope.type,
          });
          summary.pushSent += res.sent;
          summary.pushFailed += res.failed;
        } catch (err: any) {
          summary.pushFailed += 1;
          console.error(
            `[advanced.alert.evaluator] APNs send threw rule=${rule.ruleId}:`,
            err?.message ?? err,
          );
        }
        // Cooldown is per RULE — once any target fires, the whole rule
        // enters cooldown. Stop scanning the rest of the targets this pass.
        break;
      }

      try {
        await recordRuleEvaluation(rule.userId, rule.ruleId, {
          triggered: triggeredAtLeastOnce,
        });
      } catch (err: any) {
        console.error(
          `[advanced.alert.evaluator] persist failed rule=${rule.ruleId}:`,
          err?.message ?? err,
        );
      }

      if (triggeredAtLeastOnce) summary.rulesTriggered += 1;
    }
  } catch (err: any) {
    console.error("[advanced.alert.evaluator] fatal:", err?.message ?? err);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  summary.finishedAt = finishedAt.toISOString();
  summary.durationMs = finishedAt.getTime() - startedAt.getTime();
  console.log(
    `[advanced.alert.evaluator] done evaluated=${summary.rulesEvaluated} triggered=${summary.rulesTriggered} ` +
      `cooldownSkipped=${summary.cooldownSkipped} pushSent=${summary.pushSent} pushFailed=${summary.pushFailed} ` +
      `overflow=${summary.rulesOverflowed} estimates=${summary.estimatesFetched} dedupHits=${summary.estimatesCached} ` +
      `durationMs=${summary.durationMs}`,
  );
  return summary;
}

function emptySummary(startedAt: Date): AdvancedAlertEvaluatorSummary {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    rulesEvaluated: 0,
    rulesTriggered: 0,
    cooldownSkipped: 0,
    pushSent: 0,
    pushFailed: 0,
    rulesOverflowed: 0,
    estimatesFetched: 0,
    estimatesCached: 0,
  };
}

// Test hook so tests can reset the per-process running flag if a prior
// test threw mid-run.
export function __resetAdvancedAlertEvaluatorForTests(): void {
  _running = false;
}

// ─── Standalone scheduler ───────────────────────────────────────────────────
//
// CF-ADVANCED-ALERTS cadence (2026-06-03 pre-deploy fix): advanced rules run
// on their OWN timer — 4h default — NOT the basic-price 30-min cycle. All
// advanced conditions are FMV/prediction/signal-based (slow-moving), and a
// 4h cadence is the difference between ~70 and ~555+ sustainable monitored
// cards on the 100k getPricing budget. Override via
// ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN (minimum 30 min floor).
//
// Kill switch: ADVANCED_ALERTS_EVALUATOR_DISABLE=true.

const ADVANCED_DEFAULT_INTERVAL_MIN = 240;             // 4h
const ADVANCED_DEFAULT_FIRST_DELAY_MS = 120 * 1000;    // 2 min after boot
const ADVANCED_MIN_INTERVAL_MIN = 30;                  // floor

let _advancedFirstRunTimer: NodeJS.Timeout | null = null;
let _advancedIntervalTimer: NodeJS.Timeout | null = null;

export function startAdvancedAlertsEvaluatorJob(): void {
  if (process.env.ADVANCED_ALERTS_EVALUATOR_DISABLE === "true") {
    console.log(
      "[advanced.alert.evaluator] disabled via ADVANCED_ALERTS_EVALUATOR_DISABLE",
    );
    return;
  }
  if (_advancedFirstRunTimer || _advancedIntervalTimer) {
    console.warn(
      "[advanced.alert.evaluator] scheduler already running; ignoring duplicate start",
    );
    return;
  }

  const minutesRaw = Number(
    process.env.ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN ??
      ADVANCED_DEFAULT_INTERVAL_MIN,
  );
  const minutes =
    Number.isFinite(minutesRaw) && minutesRaw >= ADVANCED_MIN_INTERVAL_MIN
      ? minutesRaw
      : ADVANCED_DEFAULT_INTERVAL_MIN;
  const intervalMs = minutes * 60 * 1000;
  const firstDelayMs = Math.max(
    0,
    Number(
      process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS ??
        ADVANCED_DEFAULT_FIRST_DELAY_MS,
    ),
  );

  console.log(
    `[advanced.alert.evaluator] scheduling first run in ${Math.round(firstDelayMs / 1000)}s, ` +
      `then every ${(intervalMs / 1000 / 60).toFixed(1)}min`,
  );

  _advancedFirstRunTimer = setTimeout(() => {
    runAdvancedAlertsEvaluator().catch((err) => {
      console.error(
        "[advanced.alert.evaluator] first run threw:",
        err?.message ?? err,
      );
    });
    _advancedIntervalTimer = setInterval(() => {
      runAdvancedAlertsEvaluator().catch((err) => {
        console.error(
          "[advanced.alert.evaluator] interval run threw:",
          err?.message ?? err,
        );
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopAdvancedAlertsEvaluatorJob(): void {
  if (_advancedFirstRunTimer) {
    clearTimeout(_advancedFirstRunTimer);
    _advancedFirstRunTimer = null;
  }
  if (_advancedIntervalTimer) {
    clearInterval(_advancedIntervalTimer);
    _advancedIntervalTimer = null;
  }
}
