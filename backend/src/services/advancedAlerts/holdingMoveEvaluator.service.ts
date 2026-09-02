// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): the impure half — reads the
// user's rules, asks the pure decider, sends the push, persists the baseline.
//
// WHERE THIS RUNS, and why it matters: post-write on the reprice path, never
// inside valuation. `evaluateHoldingMoveAlerts` is handed a holding that has
// ALREADY been priced and written; it reads `fairMarketValue` + `fmvRung` off
// the persisted row and compares them to the stored baseline. It never calls
// computeEstimate, valueIdentity, or any pricing entry point. A move alert
// cannot change a price, delay a reprice, or fail one — the worst a bug in
// here can do is send a wrong push, and every call site wraps it so a throw
// cannot break the reprice that produced the number.
//
// The alert also lands in the user's in-portfolio alerts feed (the same
// `doc.alerts` array the existing value-move / cost-basis-cross alerts use)
// so the web bell and the iOS feed show it without a second store — the push
// is the notification, the feed row is the record.

import {
  decideFire,
  formatMoveAlert,
  type FireDecision,
  type HoldingMoveRule,
  type ValueObservation,
} from "./holdingMoveRule.js";
import {
  activeRulesByHolding,
  getDailyCount,
  incrementDailyCount,
  rebaseline,
  recordFire,
  utcDay,
} from "../../repositories/holdingMoveAlerts.repository.js";
import { sendPriceAlertNotification } from "../notification.service.js";

/**
 * The per-pass context. Built ONCE per user per reprice pass and threaded
 * through every holding so the rules query and the quota read each happen a
 * single time rather than per card.
 */
export interface HoldingMoveAlertContext {
  userId: string;
  rules: Map<string, HoldingMoveRule>;
  /** Alerts already sent to this user today, incremented as we fire. */
  dailyCount: number;
  day: string;
  /** Fires this pass — what the caller logs. */
  fired: number;
  suppressed: Record<string, number>;
}

/** Null when the user has no active move rules — the caller then skips the
 *  whole feature for this pass at zero further cost. */
export async function buildHoldingMoveAlertContext(
  userId: string,
): Promise<HoldingMoveAlertContext | null> {
  let rules: Map<string, HoldingMoveRule>;
  try {
    rules = await activeRulesByHolding(userId);
  } catch (err: any) {
    console.warn(
      `[holding.move.alert] rules read failed user=${userId}: ${err?.message ?? err}`,
    );
    return null;
  }
  if (rules.size === 0) return null;
  const day = utcDay();
  let dailyCount = 0;
  try {
    dailyCount = await getDailyCount(userId, day);
  } catch {
    dailyCount = 0;
  }
  return { userId, rules, dailyCount, day, fired: 0, suppressed: {} };
}

function note(ctx: HoldingMoveAlertContext, reason: string): void {
  ctx.suppressed[reason] = (ctx.suppressed[reason] ?? 0) + 1;
}

/** The alert row appended to the user's portfolio feed on a fire. */
export interface HoldingMoveFeedAlert {
  level: "info" | "warning" | "critical";
  holdingId: string;
  playerName: string;
  cardTitle: string;
  message: string;
  context: Record<string, number | string | boolean | null>;
}

export interface MoveAlertOutcome {
  decision: FireDecision;
  feedAlert: HoldingMoveFeedAlert | null;
}

/**
 * Evaluate ONE holding against its user's move rule, after the reprice has
 * written it.
 *
 * `previousValue` / `previousRung` come from the pre-write holding when the
 * rule has never fired; once it has fired, the stored `lastFiredValue` is the
 * baseline instead — the user is told about movement since the last thing we
 * told them, not since the last 6h tick, which is what makes a slow drift
 * eventually alert rather than never alerting.
 *
 * Returns the feed row for the caller to append (the caller owns the user
 * doc; this service must not write it) or null when nothing fired. Never
 * throws — a failure here is logged and swallowed so the reprice stands.
 */
export async function evaluateHoldingMoveAlert(
  ctx: HoldingMoveAlertContext,
  holding: {
    id: string;
    playerName?: string | null;
    cardTitle?: string | null;
    fairMarketValue?: number | null;
    fmvRung?: string | null;
    lastUpdated?: string | number | null;
  },
  previous: { fairMarketValue?: number | null; fmvRung?: string | null; lastUpdated?: string | number | null } | undefined,
  nowMs: number = Date.now(),
): Promise<MoveAlertOutcome | null> {
  const rule = ctx.rules.get(String(holding.id));
  if (!rule) return null;

  try {
    const nowIso = new Date(nowMs).toISOString();
    // Baseline: the last value we ALERTED on, else the pre-write value.
    const usingFiredBaseline = rule.lastFiredValue != null && rule.lastFiredAt != null;
    const baseline: ValueObservation = usingFiredBaseline
      ? {
          value: rule.lastFiredValue,
          // The rung STORED with that fire — not the pre-write holding's
          // rung, which by now is the rung of the last REPRICE and can
          // differ. Getting this wrong would let an exact-pool → fallback
          // transition be announced as an observed market move.
          rungLabel: rule.lastFiredRung,
          at: rule.lastFiredAt!,
        }
      : {
          value: previous?.fairMarketValue ?? null,
          rungLabel: previous?.fmvRung ?? null,
          at: toIsoLoose(previous?.lastUpdated) ?? nowIso,
        };

    const current: ValueObservation = {
      value: holding.fairMarketValue ?? null,
      rungLabel: holding.fmvRung ?? null,
      at: nowIso,
    };

    const decision = decideFire(rule, baseline, current, ctx.dailyCount, nowMs);

    if (!decision.fire) {
      if (decision.reason) note(ctx, decision.reason);
      // A stale baseline is re-anchored so the window slides forward rather
      // than the rule silently never firing again.
      if (decision.reason === "stale-baseline" && typeof current.value === "number") {
        await rebaseline(ctx.userId, rule.ruleId, current.value, current.rungLabel ?? null, nowIso);
      }
      // A first observation establishes the anchor the same way.
      if (decision.reason === "no-baseline" && typeof current.value === "number") {
        await rebaseline(ctx.userId, rule.ruleId, current.value, current.rungLabel ?? null, nowIso);
      }
      return { decision, feedAlert: null };
    }

    const prevValue = baseline.value as number;
    const currValue = current.value as number;
    const playerName = String(holding.playerName ?? "Unknown");
    const cardTitle = String(holding.cardTitle ?? "Card");
    const payload = formatMoveAlert(rule, playerName, cardTitle, decision, prevValue, currValue);

    // Persist the fire BEFORE sending: a duplicate push is a worse failure
    // than a missed one, and a crash between send and persist would re-fire
    // the identical move on the next pass. The fingerprint written here is
    // exactly what the next pass compares against.
    await recordFire(ctx.userId, rule.ruleId, {
      firedValue: currValue,
      firedRung: decision.currentRung,
      fingerprint: decision.fingerprint!,
      firedAt: new Date(nowMs).toISOString(),
    });
    ctx.dailyCount = await incrementDailyCount(ctx.userId, ctx.day) || ctx.dailyCount + 1;
    ctx.fired += 1;

    try {
      await sendPriceAlertNotification(ctx.userId, {
        title: payload.title,
        body: payload.body,
        alertId: rule.ruleId,
      });
    } catch (err: any) {
      console.warn(
        `[holding.move.alert] push failed user=${ctx.userId} rule=${rule.ruleId}: ${err?.message ?? err}`,
      );
    }

    console.log(
      JSON.stringify({
        event: "holding_move_alert_fired",
        source: "holdingMoveEvaluator",
        userId: ctx.userId,
        holdingId: holding.id,
        ruleId: rule.ruleId,
        thresholdPct: rule.thresholdPct,
        direction: rule.direction,
        windowHours: rule.windowHours,
        movePct: Number((decision.movePct ?? 0).toFixed(2)),
        previousValue: prevValue,
        currentValue: currValue,
        observed: decision.observed,
        previousRung: decision.previousRung,
        currentRung: decision.currentRung,
        dailyCount: ctx.dailyCount,
      }),
    );

    return {
      decision,
      feedAlert: {
        level: Math.abs(decision.movePct ?? 0) >= rule.thresholdPct * 2 ? "critical" : "warning",
        holdingId: String(holding.id),
        playerName,
        cardTitle,
        message: `${payload.title} — ${payload.body}`,
        context: {
          movePct: Number((decision.movePct ?? 0).toFixed(2)),
          previousValue: prevValue,
          currentValue: currValue,
          thresholdPct: rule.thresholdPct,
          direction: rule.direction,
          windowHours: rule.windowHours,
          observed: decision.observed,
          currentRung: decision.currentRung,
          previousRung: decision.previousRung,
        },
      },
    };
  } catch (err: any) {
    console.warn(
      `[holding.move.alert] evaluate failed user=${ctx.userId} holding=${holding.id}: ${err?.message ?? err}`,
    );
    return null;
  }
}

function toIsoLoose(v: string | number | null | undefined): string | null {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}
