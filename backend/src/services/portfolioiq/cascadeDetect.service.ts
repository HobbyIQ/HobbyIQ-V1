// CF-CASCADE-ALERTS (Drew, 2026-07-17). Pure detection: given a
// stratified player trend, decides whether it fires the cascade
// signal. No IO.
//
// Cascade condition:
//   raw AND graded both have qualifyingCards ≥ K
//   graded.momentum ≥ minGradedMomentum (default 1.10)
//   graded.momentum / raw.momentum ≥ minMomentumRatio (default 1.15)
//   graded.direction = "up"
//
// Severity classification:
//   insider:   raw.direction = "flat" or "down" (graded moving alone)
//   emerging:  raw.direction = "up" but graded ≥ 1.3× raw (graded amplifying)
//   confirmed: raw.direction = "up" AND graded moving with raw (both up
//              but graded leading — later-stage of the cascade)

import type {
  CascadeDetectionInput,
  CascadeDetectionOptions,
  CascadeDetectionResult,
  CascadeEvent,
} from "../../types/cascadeAlert.types.js";

const DEFAULTS: Required<CascadeDetectionOptions> = {
  minMomentumRatio: 1.15,
  minGradedMomentum: 1.10,
  minQualifyingCardsPerVariant: 3,
};

export function detectCascades(
  inputs: CascadeDetectionInput[],
  opts: CascadeDetectionOptions = {},
  now: Date = new Date(),
): CascadeDetectionResult {
  const options = resolveOptions(opts);
  const computedAt = now.toISOString();
  const events: CascadeEvent[] = [];

  for (const t of inputs) {
    const ev = detectOne(t, options, computedAt);
    if (ev) events.push(ev);
  }

  // Sort by momentumRatio DESC so the biggest divergence surfaces first.
  events.sort((a, b) => b.detectionInput.momentumRatio - a.detectionInput.momentumRatio);

  return { computedAt, scanned: inputs.length, detected: events.length, events };
}

/** Single-player detection — exported for direct test coverage. */
export function detectOne(
  t: CascadeDetectionInput,
  options: Required<CascadeDetectionOptions>,
  detectedAt: string,
): CascadeEvent | null {
  const { minMomentumRatio, minGradedMomentum, minQualifyingCardsPerVariant } = options;

  if (!t.raw || !t.graded) return null;
  if (t.raw.qualifyingCards < minQualifyingCardsPerVariant) return null;
  if (t.graded.qualifyingCards < minQualifyingCardsPerVariant) return null;
  if (t.graded.momentum < minGradedMomentum) return null;
  if (t.graded.direction !== "up") return null;
  if (t.raw.momentum <= 0) return null;

  const ratio = t.graded.momentum / t.raw.momentum;
  if (ratio < minMomentumRatio) return null;

  const severity = classifySeverity(t.raw.direction, ratio);

  return {
    player: t.player,
    playerSlug: slugPlayer(t.player),
    detectedAt,
    detectionInput: {
      rawMomentum: t.raw.momentum,
      gradedMomentum: t.graded.momentum,
      momentumRatio: round(ratio, 3),
      gradedDirection: t.graded.direction,
      rawQualifyingCards: t.raw.qualifyingCards,
      gradedQualifyingCards: t.graded.qualifyingCards,
      playerTrendComputedAt: t.computedAt,
    },
    severity,
    reason: buildReason(t, ratio, severity),
  };
}

function classifySeverity(
  rawDirection: "up" | "flat" | "down",
  ratio: number,
): "insider" | "emerging" | "confirmed" {
  if (rawDirection === "flat" || rawDirection === "down") return "insider";
  if (ratio >= 1.3) return "emerging";
  return "confirmed";
}

function buildReason(
  t: CascadeDetectionInput,
  ratio: number,
  severity: "insider" | "emerging" | "confirmed",
): string {
  const rawMomPct = round(((t.raw?.momentum ?? 1) - 1) * 100, 1);
  const gradedMomPct = round(((t.graded?.momentum ?? 1) - 1) * 100, 1);
  const ratioPct = round((ratio - 1) * 100, 1);
  if (severity === "insider") {
    return `Graded ${signStr(gradedMomPct)}% while raw ${signStr(rawMomPct)}% — early insider signal (graded moving alone)`;
  }
  if (severity === "emerging") {
    return `Graded ${signStr(gradedMomPct)}% is ${ratioPct}% ahead of raw ${signStr(rawMomPct)}% — cascade emerging`;
  }
  return `Both raw and graded up; graded leading by ${ratioPct}% — cascade confirmed`;
}

function signStr(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct}`;
}

function slugPlayer(player: string): string {
  return player.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function resolveOptions(opts: CascadeDetectionOptions): Required<CascadeDetectionOptions> {
  return {
    minMomentumRatio: opts.minMomentumRatio ?? DEFAULTS.minMomentumRatio,
    minGradedMomentum: opts.minGradedMomentum ?? DEFAULTS.minGradedMomentum,
    minQualifyingCardsPerVariant: opts.minQualifyingCardsPerVariant ?? DEFAULTS.minQualifyingCardsPerVariant,
  };
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

export const _DEFAULTS = DEFAULTS;
