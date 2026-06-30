// priceAlertEvaluator.job.ts — Scheduled scan over every active price alert.
//
// For each active, not-yet-triggered alert in the `compiq_alerts` Cosmos
// container, builds a structured CompIQ estimate request from the alert's
// card snapshot, re-prices via the CompIQ estimate service, and on
// threshold-cross:
//   - flips `triggeredAt` + `isActive=false` in Cosmos
//   - fires an APNs push via notification.service.sendPriceAlertNotification
//
// Defaults:
//   - Runs every 30 minutes (override via PRICE_ALERT_INTERVAL_MIN)
//   - First run fires 90 seconds after server startup
//   - Disable with PRICE_ALERT_EVALUATOR_DISABLE=true
//
// Safe to import even when Cosmos / APNs are not configured — both layers
// already no-op gracefully in that case.

import {
  listAllActiveAlerts,
  recordAlertEvaluation,
  PriceAlert,
} from "../repositories/priceAlerts.repository.js";
import { computeEstimate } from "../services/compiq/compiqEstimate.service.js";
import type { CompIQEstimateRequest } from "../types/compiq.types.js";
import { sendPriceAlertNotification } from "../services/notification.service.js";

interface EvaluatorSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  evaluated: number;
  triggered: number;
  unchanged: number;
  pricingErrors: number;
  pushSent: number;
  pushFailed: number;
}

const DEFAULT_INTERVAL_MIN = 30;
const DEFAULT_FIRST_DELAY_MS = 90 * 1000;
const PER_ALERT_DELAY_MS = 250;

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;
let _running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a freeform grade string like "PSA 10" / "BGS 9.5" / "SGC 10" into
 * structured `{ gradeCompany, gradeValue }`. Returns an empty object for
 * empty, raw, or unrecognized inputs — caller treats those as ungraded.
 */
function parseGrade(grade: string | null | undefined): {
  gradeCompany?: string;
  gradeValue?: number;
} {
  if (!grade) return {};
  const trimmed = grade.trim();
  if (!trimmed) return {};
  if (/^raw$/i.test(trimmed)) return {};
  const m = trimmed.match(/^([A-Za-z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return {};
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return {};
  return { gradeCompany: m[1].toUpperCase(), gradeValue: value };
}

/**
 * Build a structured CompIQ estimate request from the alert's stored card
 * snapshot. Returns null when the snapshot lacks the minimum signal required
 * to price (a player name) so the evaluator can skip without firing pricing.
 */
function buildEstimateRequest(alert: PriceAlert): CompIQEstimateRequest | null {
  const playerName = alert.playerName?.trim();
  if (!playerName) return null;
  const snap = alert.cardSnapshot;
  const req: CompIQEstimateRequest = { playerName };
  if (snap?.year) req.cardYear = snap.year;
  if (snap?.setName?.trim()) req.product = snap.setName.trim();
  if (snap?.variant?.trim()) req.parallel = snap.variant.trim();
  const grade = parseGrade(snap?.grade);
  if (grade.gradeCompany) req.gradeCompany = grade.gradeCompany;
  if (typeof grade.gradeValue === "number") req.gradeValue = grade.gradeValue;
  return req;
}

function thresholdCrossed(alert: PriceAlert, currentPrice: number): boolean {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  if (alert.direction === "above") return currentPrice >= alert.targetPrice;
  if (alert.direction === "below") return currentPrice <= alert.targetPrice;
  return false;
}

function formatPushBody(alert: PriceAlert, currentPrice: number): {
  title: string;
  body: string;
} {
  const arrow = alert.direction === "above" ? "↑" : "↓";
  const direction = alert.direction === "above" ? "above" : "below";
  return {
    title: `${arrow} ${alert.playerName} hit your alert`,
    body: `Now $${currentPrice.toFixed(2)} — ${direction} your $${alert.targetPrice.toFixed(2)} target.`,
  };
}

/**
 * Walk every active alert and reprice. Guards against overlapping runs.
 * Safe to call manually from an admin endpoint or test.
 */
export async function runPriceAlertEvaluator(): Promise<EvaluatorSummary> {
  const startedAt = new Date();
  if (_running) {
    console.warn("[price.alert.evaluator] already running; skipping overlap");
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      evaluated: 0,
      triggered: 0,
      unchanged: 0,
      pricingErrors: 0,
      pushSent: 0,
      pushFailed: 0,
    };
  }
  _running = true;

  let evaluated = 0;
  let triggered = 0;
  let unchanged = 0;
  let pricingErrors = 0;
  let pushSent = 0;
  let pushFailed = 0;

  try {
    const alerts = await listAllActiveAlerts();
    console.log(`[price.alert.evaluator] start active=${alerts.length}`);

    for (const alert of alerts) {
      evaluated += 1;
      const req = buildEstimateRequest(alert);
      if (!req) {
        // Nothing to price on — skip and record null price so it surfaces.
        await recordAlertEvaluation(alert.userId, alert.alertId, {
          currentPrice: null,
          triggered: false,
        });
        continue;
      }

      let currentPrice: number | null = null;
      try {
        // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): PriceAlert
        // schema (priceAlerts.repository.ts:25-37) has no holdingId
        // field — only userId + cardId (where cardId is a Cardsight
        // catalog UUID, not a portfolio reference). buildEstimateRequest
        // above builds a free-text-style CompIQEstimateRequest from
        // alert.cardSnapshot, not a cardId-pinned one. So:
        // userId known, holdingId null, routedFromHolding=false per
        // the conservative explicit-opt-in rule. If alerts ever grow
        // a holdingId field, the routedFromHolding=true path is one
        // edit away.
        const result = await computeEstimate(req, {
          source: "price-alert-evaluator",
          userId: alert.userId,
          holdingId: null,
          routedFromHolding: false,
        });
        const fair = (result as { fairMarketValue?: unknown })?.fairMarketValue;
        currentPrice = typeof fair === "number" && fair > 0 ? fair : null;
      } catch (err: any) {
        pricingErrors += 1;
        console.warn(
          `[price.alert.evaluator] pricing failed alert=${alert.alertId}:`,
          err?.message ?? err,
        );
      }

      const crossed = currentPrice !== null && thresholdCrossed(alert, currentPrice);

      try {
        await recordAlertEvaluation(alert.userId, alert.alertId, {
          currentPrice,
          triggered: crossed,
        });
      } catch (err: any) {
        console.error(
          `[price.alert.evaluator] persist failed alert=${alert.alertId}:`,
          err?.message ?? err,
        );
      }

      if (crossed && currentPrice !== null) {
        triggered += 1;
        const payload = formatPushBody(alert, currentPrice);
        try {
          const res = await sendPriceAlertNotification(alert.userId, {
            title: payload.title,
            body: payload.body,
            cardId: alert.cardId,
            alertId: alert.alertId,
          });
          pushSent += res.sent;
          pushFailed += res.failed;
        } catch (err: any) {
          pushFailed += 1;
          console.error(
            `[price.alert.evaluator] push failed alert=${alert.alertId}:`,
            err?.message ?? err,
          );
        }
      } else {
        unchanged += 1;
      }

      if (PER_ALERT_DELAY_MS > 0) await sleep(PER_ALERT_DELAY_MS);
    }
  } catch (err: any) {
    console.error("[price.alert.evaluator] fatal:", err?.message ?? err);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  const summary: EvaluatorSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    evaluated,
    triggered,
    unchanged,
    pricingErrors,
    pushSent,
    pushFailed,
  };
  console.log(
    `[price.alert.evaluator] done evaluated=${evaluated} triggered=${triggered} ` +
      `unchanged=${unchanged} pricingErrors=${pricingErrors} pushSent=${pushSent} ` +
      `pushFailed=${pushFailed} durationMs=${summary.durationMs}`,
  );

  return summary;
}

export function startPriceAlertEvaluatorJob(): void {
  if (process.env.PRICE_ALERT_EVALUATOR_DISABLE === "true") {
    console.log("[price.alert.evaluator] disabled via PRICE_ALERT_EVALUATOR_DISABLE");
    return;
  }
  if (_firstRunTimer || _intervalTimer) {
    console.warn("[price.alert.evaluator] scheduler already running; ignoring duplicate start");
    return;
  }

  const minutes = Number(process.env.PRICE_ALERT_INTERVAL_MIN ?? DEFAULT_INTERVAL_MIN);
  const intervalMs = Math.max(5 * 60 * 1000, minutes * 60 * 1000); // floor at 5 min
  const firstDelayMs = Math.max(
    0,
    Number(process.env.PRICE_ALERT_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS),
  );

  console.log(
    `[price.alert.evaluator] scheduling first run in ${Math.round(firstDelayMs / 1000)}s, ` +
      `then every ${(intervalMs / 1000 / 60).toFixed(1)}min`,
  );

  _firstRunTimer = setTimeout(() => {
    runPriceAlertEvaluator().catch((err) => {
      console.error("[price.alert.evaluator] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runPriceAlertEvaluator().catch((err) => {
        console.error("[price.alert.evaluator] interval run threw:", err?.message ?? err);
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopPriceAlertEvaluatorJob(): void {
  if (_firstRunTimer) {
    clearTimeout(_firstRunTimer);
    _firstRunTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}
