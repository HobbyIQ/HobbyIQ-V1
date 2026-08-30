// D20 — the web says what the engine says (2026-08-30).
//
// The ONE way the web reads a number off a grade-curve tier. The tier's
// `trendAdjustedValue` is the engine's projected next sale for that grade
// (the unified overlay), `value` is the tier's own read; both are the
// engine's answer under its rung. `weightedMedianPrice` / `plainMedianPrice`
// are the pool's medians — descriptive statistics that ride along for
// inspection, never a price. BuyerIQ used to fall through to the weighted
// median and print it as "Market $X"; that fallback is gone. A tier with no
// engine number is "no price yet" with the reason, not a median.
//
// Pure (no DOM, no fetch) so vitest can pin it.

import { describeRung, type RungDescription } from "./rung";

/** The tier fields the pick reads — structural so fixtures stay small. */
export interface GradeCurveTierLike {
  trendAdjustedValue?: number | null;
  value?: number | null;
  valueSource?: "observed" | "estimated" | "unavailable" | null;
  sampleCount?: number | null;
  rungLabel?: string | null;
  /** Present on the pool medians so a test can prove they are ignored. */
  weightedMedianPrice?: number | null;
  plainMedianPrice?: number | null;
}

export interface GradeCurveTierValue {
  /** The engine's number for the tier, or null. Never a median. */
  value: number | null;
  /** The rung behind `value` in words; "unpriced" + the reason when null. */
  rung: RungDescription;
  /** Why there is no number, when there is none. */
  reason: string | null;
}

function positive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** `trendAdjustedValue ?? value`, positive only — the same expression the
 *  grade-curve tile and the card page's hero use, so every surface that
 *  reads a tier shows the same number. `entry` null means the curve had
 *  no tier for the requested grade; `curveReason` is the route-level
 *  `fmvReason` when the engine declined the whole identity. */
export function pickGradeCurveTierValue(
  entry: GradeCurveTierLike | null | undefined,
  opts: { curveReason?: string | null } = {},
): GradeCurveTierValue {
  if (!entry) {
    const reason = opts.curveReason ?? "no tier for this grade";
    return { value: null, rung: { kind: "unpriced", text: reason, label: null }, reason };
  }
  const value = positive(entry.trendAdjustedValue) ?? positive(entry.value);
  if (value == null) {
    const n = entry.sampleCount ?? 0;
    const reason =
      opts.curveReason
      ?? (n > 0 ? `no price at this grade (${n} sale${n === 1 ? "" : "s"} observed)` : "no sales at this grade yet");
    return { value: null, rung: { kind: "unpriced", text: reason, label: entry.rungLabel ?? null }, reason };
  }
  return {
    value,
    rung: describeRung(entry.rungLabel, { compsUsed: entry.sampleCount }),
    reason: null,
  };
}
