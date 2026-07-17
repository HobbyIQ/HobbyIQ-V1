// CF-SOCIAL-SURFACES (Drew, 2026-07-17): "I Called It" auto-flex detection.
//
// Detects flex-worthy moments from the user's own inventory: purchases that
// have appreciated meaningfully since acquisition, and price alerts that
// have fired at the user's target. Pure math + shape functions — no I/O,
// no Cosmos — so the surface stays trivial to test and the orchestration
// layer in iCalledItAnalyze.service.ts owns all the data fan-out.
//
// Two event classes today:
//   1. "purchase_appreciated" — user paid $X ≥60d ago, currentMarketValue
//      is now ≥ 1.30× $X (a real "I called it" win the user can share).
//   2. "alert_hit" — user set a price alert that has since triggered
//      (targetPrice hit in the direction they specified).
//
// Both classes produce the same FlexMoment shape so iOS can render one
// social-card template with an event-type badge. The shareablePayload
// carries pre-composed strings so iOS doesn't need to duplicate the
// copy logic client-side.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { PriceAlert } from "../../repositories/priceAlerts.repository.js";

// ── Thresholds ──────────────────────────────────────────────────────────────
// PINNED — these move together with the tests in iCalledItDetect.test.ts.
// A change to any of the three below should re-pin the corresponding
// "pins constants" test so a downstream reviewer sees the intent shift.
export const MOMENT_APPRECIATED_MULTIPLIER = 1.30;
export const MOMENT_DEPRECIATED_MULTIPLIER = 0.70;
export const MOMENT_MIN_HOLD_DAYS = 60;

export type FlexEventType = "purchase_appreciated" | "alert_hit";

export interface SharePayload {
  headline: string;         // "+94% on Eric Hartman"
  subline: string;          // "Bought at $80 in May, now $155"
  cta: string;              // "See the analysis"
  cardTitleShort: string;   // "Hartman CPA-EHA"
}

export interface FlexMoment {
  holdingId: string;
  player: string;
  cardTitle: string;
  eventType: FlexEventType;
  originalPrice: number;
  currentMarketValue: number;
  gainPct: number;          // percent change vs originalPrice, signed
  gainUsd: number;          // dollar change vs originalPrice, signed
  eventDate: string;        // ISO — purchaseDate for purchase_appreciated,
                            // alert.triggeredAt for alert_hit
  shareablePayload: SharePayload;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Days between two dates. Accepts Date, ISO string, or ms number.
 * Returns null on unparseable input so callers can short-circuit
 * (better than silently propagating NaN through comparisons).
 */
export function daysBetween(
  later: Date | number | string,
  earlier: Date | number | string,
): number | null {
  const l = toMs(later);
  const e = toMs(earlier);
  if (l === null || e === null) return null;
  const diff = l - e;
  return diff / 86_400_000;
}

function toMs(v: Date | number | string): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Current market value of a holding, per-unit. Prefers observed FMV over
 * the graded-rail estimatedValue — a flex moment should never fire off an
 * estimate for a card we can't actually anchor with real comps. Returns
 * null when neither is present.
 */
export function currentMarketValueOf(
  holding: PortfolioHolding | undefined | null,
): number | null {
  if (!holding) return null;
  const fmv = (holding as { fairMarketValue?: number | null }).fairMarketValue;
  if (typeof fmv === "number" && Number.isFinite(fmv) && fmv > 0) return fmv;
  const est = (holding as { estimatedValue?: number | null }).estimatedValue;
  if (typeof est === "number" && Number.isFinite(est) && est > 0) return est;
  return null;
}

/**
 * Short card title suitable for a social overlay ("Hartman CPA-EHA").
 * Uses last-name of player + cardNumber when present, otherwise falls
 * back to player + set slice. Never exceeds 32 chars — social overlays
 * don't wrap gracefully.
 */
export function shortCardTitle(
  holding: PortfolioHolding | undefined | null,
): string {
  if (!holding) return "Card";
  const player = String(holding.playerName ?? "").trim();
  const lastName = player.split(/\s+/).pop() ?? player;
  const cardNumber = String(holding.cardNumber ?? "").trim();
  if (lastName && cardNumber) {
    const s = `${lastName} ${cardNumber}`;
    return s.length > 32 ? s.slice(0, 31) + "…" : s;
  }
  if (lastName) {
    const set = String(holding.setName ?? holding.product ?? "").trim();
    const s = set ? `${lastName} · ${set}` : lastName;
    return s.length > 32 ? s.slice(0, 31) + "…" : s;
  }
  return String(holding.cardTitle ?? "Card").slice(0, 32);
}

/**
 * Format the purchase date "May" style — month name from an ISO string
 * or number. Returns "recently" on unparseable input so shareable copy
 * never renders a broken date.
 */
export function monthLabel(iso: string | number | Date | undefined | null): string {
  if (iso == null) return "recently";
  const ms = toMs(iso);
  if (ms === null) return "recently";
  const d = new Date(ms);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return months[d.getUTCMonth()] ?? "recently";
}

function usd(n: number): string {
  const rounded = Math.round(n);
  return `$${rounded.toLocaleString("en-US")}`;
}

function pct(n: number): string {
  const rounded = Math.round(n);
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

// ── Payload builder ─────────────────────────────────────────────────────────

export interface PayloadInputs {
  eventType: FlexEventType;
  player: string;
  originalPrice: number;
  currentMarketValue: number;
  gainPct: number;
  cardTitleShort: string;
  eventDate: string;
}

export function buildShareablePayload(inputs: PayloadInputs): SharePayload {
  const monthPart = monthLabel(inputs.eventDate);
  const headline = `${pct(inputs.gainPct)} on ${inputs.player}`;
  const verb =
    inputs.eventType === "alert_hit"
      ? "Alerted at"
      : "Bought at";
  const subline = `${verb} ${usd(inputs.originalPrice)} in ${monthPart}, now ${usd(inputs.currentMarketValue)}`;
  return {
    headline,
    subline,
    cta: "See the analysis",
    cardTitleShort: inputs.cardTitleShort,
  };
}

// ── Detectors ───────────────────────────────────────────────────────────────

/**
 * "purchase_appreciated" — the user bought this card, held it ≥60d, and
 * the market has moved to ≥ MOMENT_APPRECIATED_MULTIPLIER × the purchase
 * price. Returns null if any guard fails; a null return is intentional
 * (fail-closed — no fake moments).
 */
export function detectPurchaseAppreciated(
  holding: PortfolioHolding | undefined | null,
  now: Date = new Date(),
): FlexMoment | null {
  if (!holding) return null;
  const originalPrice = Number(holding.purchasePrice);
  if (!Number.isFinite(originalPrice) || originalPrice <= 0) return null;

  const purchaseDate = holding.purchaseDate;
  if (purchaseDate == null) return null;
  const held = daysBetween(now, purchaseDate);
  if (held == null || held < MOMENT_MIN_HOLD_DAYS) return null;

  const currentMarketValue = currentMarketValueOf(holding);
  if (currentMarketValue == null) return null;

  if (currentMarketValue < originalPrice * MOMENT_APPRECIATED_MULTIPLIER) return null;

  const gainUsd = currentMarketValue - originalPrice;
  const gainPct = (gainUsd / originalPrice) * 100;

  const player = String(holding.playerName ?? "").trim() || "Unknown Player";
  const cardTitleShort = shortCardTitle(holding);
  const eventDateIso = coerceIso(purchaseDate) ?? new Date(toMs(purchaseDate) ?? Date.now()).toISOString();

  return {
    holdingId: String(holding.id ?? ""),
    player,
    cardTitle: String(holding.cardTitle ?? cardTitleShort),
    eventType: "purchase_appreciated",
    originalPrice: r2(originalPrice),
    currentMarketValue: r2(currentMarketValue),
    gainPct: r2(gainPct),
    gainUsd: r2(gainUsd),
    eventDate: eventDateIso,
    shareablePayload: buildShareablePayload({
      eventType: "purchase_appreciated",
      player,
      originalPrice,
      currentMarketValue,
      gainPct,
      cardTitleShort,
      eventDate: eventDateIso,
    }),
  };
}

/**
 * "alert_hit" — the user set a price alert that has fired. The alert
 * carries the user's target price and the current price at trigger time;
 * combined with the holding's current market value they yield a clean
 * "you called it" moment. Guards:
 *   - alert.triggeredAt must be set (haven't fired → not flex-worthy)
 *   - direction must have been satisfied (above target for direction=above,
 *     below for direction=below) at trigger time
 *   - the holding must still exist AND have a current market value in the
 *     direction the alert predicted (otherwise the market has reversed)
 */
export function detectAlertHit(
  holding: PortfolioHolding | undefined | null,
  alert: PriceAlert | undefined | null,
  _now: Date = new Date(),
): FlexMoment | null {
  if (!holding || !alert) return null;
  if (!alert.triggeredAt) return null;

  const target = Number(alert.targetPrice);
  if (!Number.isFinite(target) || target <= 0) return null;

  const currentMarketValue = currentMarketValueOf(holding);
  if (currentMarketValue == null) return null;

  // Direction verification: for "above" alerts, current must still be at
  // or above target (otherwise the market has reversed and the flex is
  // stale). Symmetric for "below". This is the same directional check
  // priceAlertEvaluator uses to fire the alert originally.
  if (alert.direction === "above" && currentMarketValue < target) return null;
  if (alert.direction === "below" && currentMarketValue > target) return null;

  const gainUsd = currentMarketValue - target;
  const gainPct = (gainUsd / target) * 100;

  // Prefer alert.playerName when it's a non-empty string; otherwise the
  // holding's own playerName. Empty-string on the alert must fall through
  // (?? treats "" as present — that's not what we want here).
  const rawAlertName = String(alert.playerName ?? "").trim();
  const rawHoldingName = String(holding.playerName ?? "").trim();
  const player = rawAlertName || rawHoldingName || "Unknown Player";
  const cardTitleShort = shortCardTitle(holding);
  const eventDateIso = alert.triggeredAt;

  return {
    holdingId: String(holding.id ?? ""),
    player,
    cardTitle: String(holding.cardTitle ?? cardTitleShort),
    eventType: "alert_hit",
    originalPrice: r2(target),
    currentMarketValue: r2(currentMarketValue),
    gainPct: r2(gainPct),
    gainUsd: r2(gainUsd),
    eventDate: eventDateIso,
    shareablePayload: buildShareablePayload({
      eventType: "alert_hit",
      player,
      originalPrice: target,
      currentMarketValue,
      gainPct,
      cardTitleShort,
      eventDate: eventDateIso,
    }),
  };
}

function coerceIso(v: string | number | Date | undefined | null): string | null {
  if (v == null) return null;
  const ms = toMs(v);
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
