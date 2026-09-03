/**
 * CF-SELLER-INTELLIGENCE-SELL-WINDOW (Drew, 2026-09-02).
 *
 * "Your player's index is rolling over while your card's own pool is still
 * hot." That sentence is the product. This module is the only thing that
 * decides whether it is TRUE for a holding, and it decides it from numbers
 * that were already measured somewhere else.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a valuation. Nothing here edits fairMarketValue, predictedPrice,
 * a rung, a multiplier or a weight. The engine's number is the engine's
 * number; this module reads it and says WHEN, never WHAT. The compsMomentum
 * weight lock is therefore untouched by construction — the weights live in
 * trendIQ.compute.ts's WEIGHT_TABLE and are neither imported nor referenced
 * here. We read a component's `multiplier`, which is the measurement, not
 * the weight applied to it.
 *
 * THE TWO INPUTS, AND WHY THESE TWO
 * ---------------------------------
 * Both ride on the holding's already-persisted TrendIQ result, so a signal
 * costs ZERO new pool reads on the portfolio path (that endpoint has never
 * computed a price and still doesn't — CF-PORTFOLIO-REFRESH-ASYNC):
 *
 *   PLAYER SIDE  — components.playerMomentum.multiplier. The player-in-set
 *                  momentum built from the #1644/#1647 basket machinery:
 *                  the player's OTHER cards, weighted, read at two times.
 *                  This is the market the card floats on.
 *
 *   OWN-POOL SIDE — components.cardTrajectory.multiplier, with its
 *                  recentCount / olderCount. This is THIS card's own pool:
 *                  its recent median against its older median.
 *
 * THE THESIS IS THE DIVERGENCE (the information cascade)
 * -----------------------------------------------------
 * A sell window is not "the card is up". A card that is up and whose player
 * is also up is simply a good card in a good market — hold it. The window
 * opens on DIVERGENCE, which is the cascade model's whole claim: information
 * reaches the liquid player market BEFORE it reaches one card's thin pool.
 * So when the player index has rolled over while the card's own pool is
 * still printing highs, the card's pool is trading on stale information and
 * the gap is the seller's edge — it closes, and it closes downward.
 *
 * The mirror case is real too and is NOT a sell window: player rising while
 * the card's own pool lags is the same cascade pointed the other way, and
 * the honest call there is "hold", because the thing that has not happened
 * yet is the card catching UP.
 *
 * HORIZON MUST MATCH THE CLASS (doctrine: signal classes attention-vs-price)
 * -------------------------------------------------------------------------
 * These are both PRICE-class signals — they are measured off realized sale
 * prices, not off attention (search volume, watcher counts, social spikes).
 * A price-class signal's horizon is bounded by the windows that produced it:
 * cardTrajectory measures a 14-day recent window against a ~30-day older
 * one. It CANNOT speak to the next 72 hours (that is attention's horizon,
 * and we do not have an attention input here), and it cannot speak to next
 * quarter (that is beyond what a 14/30-day window observed). So every signal
 * this module emits carries a horizon drawn FROM the window that produced
 * it — never a horizon we would like to have. `horizonClassMatches` is the
 * invariant, and it is pinned.
 *
 * REFUSAL IS A RESULT
 * -------------------
 * A thin pool does not get a quiet "none" — it gets `none` WITH a reason
 * naming what was missing. "No signal" and "not enough data to look" are
 * different facts and a seller deserves to know which one they are reading.
 */

import type { TrendIQResult } from "../compiq/trendIQ.types.js";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * `sell-window` — divergence favours selling INTO the current pool now.
 * `watch`       — divergence is forming but under the firing bar.
 * `hold`        — measured, and the reading argues against selling now.
 * `none`        — no call. `reason` says whether that is "nothing is
 *                 happening" or "we could not look".
 */
export type SellSignal = "none" | "watch" | "sell-window" | "hold";

/**
 * The horizon a signal is allowed to speak to. Derived from the measurement
 * window, never chosen for effect.
 *
 * `days-7-14`  — the near edge of a 14d recent window.
 * `days-14-30` — the standard price-class horizon.
 * `none`       — no signal, so no horizon to state.
 */
export type SellHorizon = "none" | "days-7-14" | "days-14-30";

/**
 * The class of evidence behind the signal. PRICE-class comes from realized
 * sales; ATTENTION-class (search/watchers/social) is a different horizon and
 * is NOT an input here. Recorded so a future attention input cannot silently
 * inherit a price horizon.
 */
export type SignalClass = "price" | "attention";

/** Why a signal is `none`, or why a firing signal was held back. */
export type SellSignalReason =
  | "no-trend-data"
  | "no-player-index"
  | "no-own-pool"
  | "thin-own-pool"
  | "stale-trend"
  | "low-confidence"
  | "unknown-confidence"
  | "no-divergence"
  | "player-and-pool-agree";

export interface SellWindowSignal {
  signal: SellSignal;
  horizon: SellHorizon;
  signalClass: SignalClass;
  /** One sentence, with the numbers quoted. Never a certainty claim. */
  basis: string;
  /** Present whenever the call is `none`, or a firing call was damped. */
  reason: SellSignalReason | null;
  /** The measured inputs, so the sentence can always be checked. */
  measures: {
    playerIndexPct: number | null;
    ownPoolPct: number | null;
    divergencePct: number | null;
    ownPoolSales: number | null;
    /** Age in days of the trend read this signal was derived from. */
    trendAgeDays: number | null;
    confidence: number | null;
  };
}

// ─── Thresholds ─────────────────────────────────────────────────────────────
// Every one of these is a DISCLOSURE bar, not a price adjustment: they decide
// whether we SAY something, never what the number is.

/**
 * The divergence (player pct minus own-pool pct, in points) at which the gap
 * is worth acting on. Below FIRE but above WATCH, we say "watch" — a forming
 * gap is information, and hiding it until it crosses a bright line would be
 * the same error as suppressing a small number as noise.
 */
export const DIVERGENCE_FIRE_PTS = 12;
export const DIVERGENCE_WATCH_PTS = 6;

/**
 * The player index must actually be ROLLING OVER — not merely rising less
 * than the card. A player up 20% and a card up 35% is a hot card in a hot
 * market, not a cascade. The window requires the player side to be flat or
 * falling on its own terms.
 */
export const PLAYER_ROLLOVER_PCT = 1.0;

/**
 * The card's own pool must still be HOT for the "sell into it" claim to
 * mean anything. Selling into a pool that is already falling is not a
 * window, it is a loss being taken late.
 */
export const OWN_POOL_HOT_PCT = 2.0;

/**
 * A pool this thin cannot testify to its own direction. Mirrors the spirit
 * of playerInSetMomentum's MIN_PER_WINDOW=3 per side: we refuse rather than
 * read direction out of noise.
 */
export const MIN_OWN_POOL_SALES = 6;

/** A trend read older than this is not describing today's market. */
export const MAX_TREND_AGE_DAYS = 14;

/** Below this pricing confidence we decline to time a sale. */
export const MIN_CONFIDENCE = 0.35;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Horizon derivation ─────────────────────────────────────────────────────

/**
 * The horizon a price-class signal derived from these windows may claim.
 *
 * The rule: a signal may not speak past the older window that produced it,
 * and may not speak inside the sub-week range that only an attention-class
 * signal can see. `windowRecentDays` is 14 in V1; a shorter recent window
 * would license the nearer band and nothing longer.
 */
export function horizonForWindows(windowRecentDays: number | null | undefined): SellHorizon {
  const recent = typeof windowRecentDays === "number" && Number.isFinite(windowRecentDays)
    ? windowRecentDays
    : 14;
  // A recent window of a week or less resolves faster, so the near band is
  // honest. Anything longer is a 14-30d statement.
  return recent <= 7 ? "days-7-14" : "days-14-30";
}

/**
 * THE INVARIANT (pinned): a price-class signal may never claim a horizon
 * shorter than days-7-14, because realized-sale windows cannot resolve
 * inside a few days — that band belongs to attention-class signals, which
 * are not an input here. A signal with no call claims no horizon.
 */
export function horizonClassMatches(
  signal: SellSignal,
  horizon: SellHorizon,
  signalClass: SignalClass,
): boolean {
  if (signal === "none") return horizon === "none";
  if (horizon === "none") return false;
  if (signalClass === "price") {
    return horizon === "days-7-14" || horizon === "days-14-30";
  }
  // An attention-class signal would carry its own (shorter) bands; none are
  // defined yet, so nothing may claim the class.
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A TrendIQ multiplier (1.0 = flat) as a percentage move. */
function pct(multiplier: number | null | undefined): number | null {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  return Math.round((multiplier - 1) * 1000) / 10;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function ageDays(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(((nowMs - t) / DAY_MS) * 10) / 10);
}

function none(reason: SellSignalReason, basis: string, measures: SellWindowSignal["measures"]): SellWindowSignal {
  return { signal: "none", horizon: "none", signalClass: "price", basis, reason, measures };
}

const EMPTY_MEASURES: SellWindowSignal["measures"] = {
  playerIndexPct: null,
  ownPoolPct: null,
  divergencePct: null,
  ownPoolSales: null,
  trendAgeDays: null,
  confidence: null,
};

// ─── The derivation ─────────────────────────────────────────────────────────

export interface DeriveSellWindowInput {
  /** The holding's persisted TrendIQ result. */
  trendIQ: TrendIQResult | null | undefined;
  /** CF-SELL-WINDOW-READS-PRICING-CONFIDENCE (2026-09-03).
   *
   *  The PRICING confidence for this holding's current price surface, 0..1 —
   *  how well-evidenced the dollar figure is. Callers MUST source it the way
   *  the pricing envelope does (`pricingEnvelope.builder.buildConfidence`):
   *  `pricingSourceMeta.confidence` first, falling back to the flat
   *  `holding.confidence` field ONLY for legacy-engine-priced rows.
   *
   *  It is NOT the holding's flat `confidence` field in general. That field
   *  carries identity/match confidence on unified-engine rows, and until the
   *  CF-PRICING-CONFIDENCE-SCALE fix it saturated to exactly 1.0 for anything
   *  at or above 1 — so reading it here quoted a match score to the user as
   *  "Pricing confidence on this card is 100%" and opened the timing gate on
   *  cards whose price is barely evidenced.
   *
   *  `null` means NOT RECORDED (the holding has not been repriced since the
   *  engine began stamping it) — not "confident". The derivation withholds
   *  the timing call rather than assuming a number it does not have. */
  confidence?: number | null;
  /** When the trend was last written (holding.lastUpdated / trendIQ.lastUpdated). */
  trendUpdatedAt?: string | null;
  nowMs?: number;
}

/**
 * Pure. Persisted trend in, signal out. No Cosmos, no clock of its own, no
 * price touched.
 */
export function deriveSellWindowSignal(input: DeriveSellWindowInput): SellWindowSignal {
  const nowMs = input.nowMs ?? Date.now();
  const trend = input.trendIQ ?? null;

  if (!trend || !trend.components) {
    return none("no-trend-data", "No trend has been measured for this card yet.", EMPTY_MEASURES);
  }

  const player = trend.components.playerMomentum;
  const card = trend.components.cardTrajectory;

  const playerPct = pct(player?.multiplier);
  const ownPct = pct(card?.multiplier);
  const ownSales =
    card && Number.isFinite(card.recentCount) && Number.isFinite(card.olderCount)
      ? card.recentCount + card.olderCount
      : null;
  const confidence =
    typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? input.confidence
      : null;
  const trendAgeDays = ageDays(input.trendUpdatedAt ?? trend.lastUpdated, nowMs);

  const measures: SellWindowSignal["measures"] = {
    playerIndexPct: playerPct,
    ownPoolPct: ownPct,
    divergencePct: playerPct !== null && ownPct !== null ? round1(playerPct - ownPct) : null,
    ownPoolSales: ownSales,
    trendAgeDays,
    confidence,
  };

  // ── Refusals. Each names what was missing; none of them is a silent none.
  if (playerPct === null) {
    return none(
      "no-player-index",
      "This player's market has too few liquid cards trading to build an index, so there is nothing to compare this card against.",
      measures,
    );
  }
  if (ownPct === null) {
    return none(
      "no-own-pool",
      "This card's own pool has no measured direction, so a divergence cannot be read.",
      measures,
    );
  }
  if (ownSales !== null && ownSales < MIN_OWN_POOL_SALES) {
    return none(
      "thin-own-pool",
      `This card's own pool has only ${ownSales} sale${ownSales === 1 ? "" : "s"} across both windows (${MIN_OWN_POOL_SALES} needed), too thin to call its direction against the player index.`,
      measures,
    );
  }
  if (trendAgeDays !== null && trendAgeDays > MAX_TREND_AGE_DAYS) {
    return none(
      "stale-trend",
      `The trend behind this card was last measured ${trendAgeDays} days ago, past the ${MAX_TREND_AGE_DAYS}-day line where it still describes today's market.`,
      measures,
    );
  }
  // CF-SELL-WINDOW-READS-PRICING-CONFIDENCE (2026-09-03). Two distinct
  // refusals, because "measured and too low" and "never measured" are
  // different facts and the user is owed the difference.
  //
  // A null confidence previously fell straight through this gate and the
  // signal fired as though the price were fully evidenced. It is not: it is
  // unmeasured. Per this file's own doctrine — every threshold here is a
  // disclosure bar, and we refuse rather than read a call out of noise — an
  // unrecorded pricing confidence withholds the timing call and NAMES why,
  // quoting no percentage it cannot substantiate.
  if (confidence === null) {
    return none(
      "unknown-confidence",
      "The pricing confidence behind this card's value has not been recorded yet, so there is no basis to say how well-evidenced the price is — timing a sale on it would be guessing. It will be available after this card's next reprice.",
      measures,
    );
  }
  if (confidence < MIN_CONFIDENCE) {
    return none(
      "low-confidence",
      `Pricing confidence on this card is ${Math.round(confidence * 100)}%, below the ${Math.round(MIN_CONFIDENCE * 100)}% needed to time a sale.`,
      measures,
    );
  }

  const divergence = round1(playerPct - ownPct);
  const horizon = horizonForWindows(card?.windowRecentDays);
  const gap = Math.abs(divergence);

  // ── The cascade, pointed down: player rolling over, own pool still hot.
  const playerRollingOver = playerPct <= PLAYER_ROLLOVER_PCT;
  const ownPoolHot = ownPct >= OWN_POOL_HOT_PCT;

  if (playerRollingOver && ownPoolHot && divergence <= -DIVERGENCE_FIRE_PTS) {
    return {
      signal: "sell-window",
      horizon,
      signalClass: "price",
      basis:
        `${player?.flags?.includes("falling") ? "The player index is falling" : "The player index is flat to falling"} at ` +
        `${playerPct > 0 ? "+" : ""}${playerPct}% while this card's own pool is still up ${ownPct}% across ${ownSales ?? "its"} recent sales — ` +
        `a ${Math.abs(divergence)}-point gap that has historically closed toward the player's market, not away from it.`,
      reason: null,
      measures,
    };
  }

  // ── Forming: the same shape, under the firing bar.
  if (playerRollingOver && ownPoolHot && gap >= DIVERGENCE_WATCH_PTS && divergence < 0) {
    return {
      signal: "watch",
      horizon,
      signalClass: "price",
      basis:
        `The player index is at ${playerPct > 0 ? "+" : ""}${playerPct}% while this card's own pool is up ${ownPct}%, ` +
        `a ${gap}-point gap that is forming but has not reached the ${DIVERGENCE_FIRE_PTS}-point bar this signal fires on.`,
      reason: null,
      measures,
    };
  }

  // ── The cascade, pointed up: the player is running and the card has not
  //    caught up yet. Explicitly NOT a sell window.
  if (divergence >= DIVERGENCE_FIRE_PTS && playerPct > PLAYER_ROLLOVER_PCT) {
    return {
      signal: "hold",
      horizon,
      signalClass: "price",
      basis:
        `The player index is up ${playerPct}% while this card's own pool has only moved ${ownPct}% — ` +
        `a ${divergence}-point gap in the card's favour. Player-level moves often lead individual cards, so selling now may be early — watch this card's own pool for confirmation.`,
      reason: null,
      measures,
    };
  }

  // ── Measured, and nothing is diverging.
  if (gap < DIVERGENCE_WATCH_PTS) {
    return {
      signal: "none",
      horizon: "none",
      signalClass: "price",
      basis:
        `This card's own pool (${ownPct > 0 ? "+" : ""}${ownPct}%) and the player index (${playerPct > 0 ? "+" : ""}${playerPct}%) ` +
        `are moving together within ${gap} points, so there is no timing edge to act on.`,
      reason: "player-and-pool-agree",
      measures,
    };
  }

  // ── A gap exists but does not have the cascade's shape (e.g. the player is
  //    rolling over and the card is falling too — both sides already know).
  return {
    signal: "none",
    horizon: "none",
    signalClass: "price",
    basis:
      `The player index (${playerPct > 0 ? "+" : ""}${playerPct}%) and this card's pool (${ownPct > 0 ? "+" : ""}${ownPct}%) ` +
      `differ by ${gap} points, but not in the shape this signal reads — the card's own pool is not holding a level the player's market has left.`,
    reason: "no-divergence",
    measures,
  };
}
