// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): "tell me when my card moves N%".
//
// The PURE decision half of per-holding move alerts. No Cosmos, no APNs, no
// clock of its own — the caller passes `nowMs`. Everything here is a
// function of (rule, observation pair), so the pins Drew named are unit
// tests, not integration archaeology:
//
//   threshold fire / non-fire, direction, speculative labeling, rate limit,
//   and NO DOUBLE-FIRE on an idempotent reprice.
//
// Why a new module rather than a condition kind on advancedAlerts:
// conditionEvaluator's conditions all read ONE computeEstimate slice — they
// answer "what is this card doing now". A move alert is a question about a
// PAIR of observations of the same holding ("what changed since the value I
// last told you about"), and its `predicted_pct_move` neighbour is a
// prediction-vs-FMV spread, not an observed move at all. Same repository
// pattern, same notification service, different question. The two live side
// by side; this one is wired to the reprice write, not to a 4h timer.
//
// ─── The observed / speculative distinction ─────────────────────────────────
//
// Drew's pin: "alerts fire on OBSERVED value changes with the basis quoted;
// speculative-rung-only moves are labeled as such". The rung vocabulary in
// compiq/fmvRung.ts already draws exactly this line — `isExactPoolRung` is
// true only when the number was read from the pool of the exact (identity,
// grade). Everything else — a grade-curve estimate, a graded-pool inverse, a
// player-index projection, a sibling estimate — is a fallback rung: real
// evidence, but not a sale OF THIS CARD AT THIS GRADE.
//
// So a move is OBSERVED only when BOTH ends of the pair sat on an exact-pool
// rung. If either end is a fallback rung, the move may be an artifact of the
// rung changing underneath the card rather than the market moving, and the
// alert says so in its own words. We do NOT suppress those — Drew's
// standing PUBLISH + LABEL doctrine is that the value still shows and the
// label rides along with it. A user who set a 20% alert and got a 22% move
// off a player index deserves to hear it, and deserves to be told what it
// rests on.

import { isExactPoolRung } from "../compiq/fmvRung.js";

/** Which way a move has to go for the user to care. */
export type MoveDirection = "up" | "down" | "any";

/**
 * One user's move rule for one holding.
 *
 * `windowHours` is the LOOKBACK: the move is measured against the last value
 * we alerted on (or the oldest observation still inside the window), not
 * against the immediately preceding reprice. A 5%-a-day drift that never
 * trips a 10% rule on any single 6h reprice still trips it over a 48h
 * window, which is what a user means by "tell me when it moves 10%".
 */
export interface HoldingMoveRule {
  ruleId: string;
  userId: string;
  holdingId: string;
  /** Percent move that fires the alert. Positive magnitude, e.g. 10 = 10%. */
  thresholdPct: number;
  direction: MoveDirection;
  /** Lookback window in hours. */
  windowHours: number;
  isActive: boolean;
  createdAt: string;
  /** The value the last fired alert quoted — the baseline the next move is
   *  measured from. Null until the rule has ever fired. */
  lastFiredValue: number | null;
  /** The RUNG that produced `lastFiredValue`. Stored rather than re-read
   *  from the holding, because once a rule has fired the holding has moved
   *  on: the pre-write rung on the next pass is the rung of the last
   *  REPRICE, not of the last ALERT, and using it would let an
   *  exact-pool→fallback transition be reported as an observed move. */
  lastFiredRung: string | null;
  lastFiredAt: string | null;
  /** Idempotency fingerprint of the last fire — see `fireFingerprint`. */
  lastFiredFingerprint: string | null;
  triggerCount: number;
}

/** One end of the comparison: a value and the rung that produced it. */
export interface ValueObservation {
  value: number | null;
  rungLabel: string | null | undefined;
  /** ISO timestamp of the observation. */
  at: string;
}

export const MIN_THRESHOLD_PCT = 1;
export const MAX_THRESHOLD_PCT = 500;
export const MIN_WINDOW_HOURS = 1;
export const MAX_WINDOW_HOURS = 24 * 90;

/**
 * Default alerts a user gets per day before we stop sending. Deliberately
 * low — a portfolio of 300 holdings repricing every 6h could otherwise emit
 * hundreds of pushes in a day and train the user to swipe them away.
 * Override with HOLDING_MOVE_ALERT_DAILY_CAP.
 */
export const DEFAULT_DAILY_CAP = 10;

export function dailyCap(): number {
  const raw = Number(process.env.HOLDING_MOVE_ALERT_DAILY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_CAP;
}

/**
 * The reason a candidate move did not become an alert. Every non-fire path
 * names itself so the evaluator's counters decompose without guessing.
 */
export type NoFireReason =
  | "inactive"
  | "no-baseline"          // first observation of this holding — nothing to compare
  | "unpriced"             // one end has no value (null / <= 0)
  | "below-threshold"
  | "wrong-direction"
  | "stale-baseline"       // baseline older than the window
  | "duplicate"            // same fingerprint as the last fire — idempotent reprice
  | "rate-limited";

export interface FireDecision {
  fire: boolean;
  reason: NoFireReason | null;
  /** Signed percent move, previous → current. Null when unmeasurable. */
  movePct: number | null;
  /** True only when BOTH ends read the exact (identity, grade) pool. */
  observed: boolean;
  /** The rung that produced the CURRENT value — quoted in the alert. */
  currentRung: string | null;
  previousRung: string | null;
  fingerprint: string | null;
}

/**
 * The idempotency key for a fire.
 *
 * A reprice that recomputes the SAME number from the SAME rung is not new
 * information, and the reprice job is explicitly allowed to run more than
 * once over the same market state (a 6h scheduler, a manual dispatch, a
 * retry after a Cosmos blip). Fingerprinting (holding, baseline, current
 * value, rung) means the second pass over an unchanged pair recognizes
 * itself and stays silent.
 *
 * Values are rounded to the cent before hashing: a float that re-derives as
 * 41.20000000000001 is the same observation as 41.20, and a user would be
 * rightly baffled to be told twice.
 */
export function fireFingerprint(
  holdingId: string,
  previousValue: number,
  currentValue: number,
  currentRung: string | null | undefined,
): string {
  const p = previousValue.toFixed(2);
  const c = currentValue.toFixed(2);
  return `${holdingId}|${p}|${c}|${currentRung ?? "unknown"}`;
}

function isUsableValue(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Decide whether a (previous, current) observation pair fires `rule`.
 *
 * `previous` is the BASELINE: the value the last alert quoted when the rule
 * has fired before, otherwise the prior stored value. `dailyCount` is how
 * many alerts this user has already been sent inside the current UTC day.
 *
 * Pure. Ordering of the gates is deliberate — cheap, rule-level rejections
 * first, then the measurement, then duplicate/rate-limit last so a suppressed
 * fire still reports the move it would have made (the caller logs it).
 */
export function decideFire(
  rule: HoldingMoveRule,
  previous: ValueObservation,
  current: ValueObservation,
  dailyCount: number,
  nowMs: number = Date.now(),
): FireDecision {
  const base: Omit<FireDecision, "fire" | "reason"> = {
    movePct: null,
    observed: false,
    currentRung: current.rungLabel ?? null,
    previousRung: previous.rungLabel ?? null,
    fingerprint: null,
  };

  if (!rule.isActive) return { ...base, fire: false, reason: "inactive" };

  if (!isUsableValue(previous.value)) {
    // No baseline is not a defect — it's the first time we've seen this
    // holding priced. Establish the baseline silently; the NEXT move alerts.
    return { ...base, fire: false, reason: "no-baseline" };
  }
  if (!isUsableValue(current.value)) {
    return { ...base, fire: false, reason: "unpriced" };
  }

  // Window gate: a baseline older than the lookback is not evidence of a
  // move "in the last N hours". The caller re-baselines on this reason
  // rather than firing on a months-old anchor.
  const baselineMs = Date.parse(previous.at);
  if (Number.isFinite(baselineMs)) {
    const ageHours = (nowMs - baselineMs) / (60 * 60 * 1000);
    if (ageHours > rule.windowHours) {
      return { ...base, fire: false, reason: "stale-baseline" };
    }
  }

  const movePct = ((current.value - previous.value) / previous.value) * 100;
  // Both ends must have read the exact pool for the move to be OBSERVED.
  const observed =
    isExactPoolRung(previous.rungLabel) && isExactPoolRung(current.rungLabel);
  const fingerprint = fireFingerprint(
    rule.holdingId,
    previous.value,
    current.value,
    current.rungLabel,
  );
  const measured = { ...base, movePct, observed, fingerprint };

  if (rule.direction === "up" && movePct <= 0) {
    return { ...measured, fire: false, reason: "wrong-direction" };
  }
  if (rule.direction === "down" && movePct >= 0) {
    return { ...measured, fire: false, reason: "wrong-direction" };
  }

  // Threshold is on MAGNITUDE; direction is a separate gate above so a
  // "down" rule never fires on a big move up.
  if (Math.abs(movePct) < rule.thresholdPct) {
    return { ...measured, fire: false, reason: "below-threshold" };
  }

  if (rule.lastFiredFingerprint && rule.lastFiredFingerprint === fingerprint) {
    return { ...measured, fire: false, reason: "duplicate" };
  }

  if (dailyCount >= dailyCap()) {
    return { ...measured, fire: false, reason: "rate-limited" };
  }

  return { ...measured, fire: true, reason: null };
}

/**
 * The user-facing alert text.
 *
 * Two contracts Drew pinned live here:
 *   1. the BASIS is quoted — the move is always shown as "$X → $Y", never a
 *      bare percentage, so the number in the push reconciles with the number
 *      on the card page;
 *   2. a move that did not read the exact pool at both ends SAYS SO, in
 *      words a collector reads rather than a rung label they don't know.
 */
export function formatMoveAlert(
  rule: HoldingMoveRule,
  playerName: string,
  cardTitle: string,
  decision: FireDecision,
  previousValue: number,
  currentValue: number,
): { title: string; body: string } {
  const pct = decision.movePct ?? 0;
  const up = pct >= 0;
  const arrow = up ? "↑" : "↓";
  const sign = up ? "+" : "";
  const title = `${arrow} ${playerName} ${sign}${pct.toFixed(1)}%`;
  const money = `$${previousValue.toFixed(2)} → $${currentValue.toFixed(2)}`;
  const tail = decision.observed
    ? ""
    : " Estimated — no recent sale of this exact card at this grade; value carried from related sales.";
  return {
    title,
    body: `${cardTitle}: ${money} over ${describeWindow(rule.windowHours)}.${tail}`,
  };
}

export function describeWindow(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 2) return "24h";
  return `${Math.round(days)}d`;
}

/** Clamp + validate a user-supplied rule body. Returns null when unusable. */
export function normalizeRuleInput(raw: unknown): {
  thresholdPct: number;
  direction: MoveDirection;
  windowHours: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const threshold = Number(r.thresholdPct);
  if (!Number.isFinite(threshold)) return null;
  const magnitude = Math.abs(threshold);
  if (magnitude < MIN_THRESHOLD_PCT || magnitude > MAX_THRESHOLD_PCT) return null;

  const dir = r.direction;
  const direction: MoveDirection =
    dir === "up" || dir === "down" || dir === "any" ? dir : "any";

  const windowRaw = r.windowHours == null ? 24 : Number(r.windowHours);
  if (!Number.isFinite(windowRaw)) return null;
  const windowHours = Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, Math.floor(windowRaw)));

  return { thresholdPct: magnitude, direction, windowHours };
}
