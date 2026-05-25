// TrendIQ composite computation — combines the three input layers into a
// single forward-looking score per docs/phase0/trendiq_design.md.
//
// Phase 1 implementation: this module owns the weight-table lookup,
// composite math, deadband direction, and impliedPct rounding. Per-layer
// computation (Layer 1 fetch, Layer 2 windowing, Layer 3 anchor handling)
// lives in their respective modules; this module composes pre-built
// component objects.

import {
  type PlayerMomentumComponent,
  type TrendIQComponents,
  type TrendIQCoverage,
  type TrendIQDirection,
  type TrendIQResult,
  type TrendIQWeights,
} from "./trendIQ.types.js";
import { type SignalPayload } from "../signals/signals.types.js";
import { type FetchPlayerSignalsResult } from "../signals/fetchSignals.js";

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

interface WeightEntry {
  weights: TrendIQWeights;
  coverage: TrendIQCoverage;
}

// Locked 8-row availability matrix — docs/phase0/trendiq_design.md
// "Phase 1 methodology locks". Key format: `${pBit}${cBit}${sBit}`
// where each bit is 1 when the corresponding layer is populated.
const WEIGHT_TABLE: Record<string, WeightEntry> = {
  "111": { weights: { playerMomentum: 0.20, cardTrajectory: 0.40, segmentTrajectory: 0.40 }, coverage: "full" },
  "110": { weights: { playerMomentum: 0.30, cardTrajectory: 0.70, segmentTrajectory: 0.00 }, coverage: "no_segment" },
  "101": { weights: { playerMomentum: 0.30, cardTrajectory: 0.00, segmentTrajectory: 0.70 }, coverage: "no_card" },
  "100": { weights: { playerMomentum: 1.00, cardTrajectory: 0.00, segmentTrajectory: 0.00 }, coverage: "player_only" },
  "011": { weights: { playerMomentum: 0.00, cardTrajectory: 0.50, segmentTrajectory: 0.50 }, coverage: "full" },
  "010": { weights: { playerMomentum: 0.00, cardTrajectory: 1.00, segmentTrajectory: 0.00 }, coverage: "card_only" },
  "001": { weights: { playerMomentum: 0.00, cardTrajectory: 0.00, segmentTrajectory: 1.00 }, coverage: "segment_only" },
  // "000" handled separately as insufficient — composite = 1.0, direction = flat.
};

function deriveDirection(composite: number): TrendIQDirection {
  if (composite < 0.97) return "down";
  if (composite > 1.03) return "up";
  return "flat";
}

/** Build the Layer 1 component from a signal fetch result. Returns null when
 *  no real aggregator data was available (per fetchPlayerSignals contract). */
export function buildPlayerMomentumComponent(
  result: FetchPlayerSignalsResult,
): PlayerMomentumComponent | null {
  if (!result.payload) return null;
  const p: SignalPayload = result.payload;
  return {
    multiplier: p.final_multiplier,
    flags: p.signal_flags ?? [],
    componentSignals: (p.components ?? {}) as Record<string, number>,
    lastUpdated: p.updated_at ?? null,
    sourceUrl: result.sourceUrl,
  };
}

export function computeTrendIQ(components: TrendIQComponents): TrendIQResult {
  const p = components.playerMomentum;
  const c = components.cardTrajectory;
  const s = components.segmentTrajectory;
  const key = `${p ? 1 : 0}${c ? 1 : 0}${s ? 1 : 0}`;

  if (key === "000") {
    return {
      composite: 1.0,
      direction: "flat",
      impliedPct: 0,
      lastUpdated: null,
      components,
      weights: { playerMomentum: 0, cardTrajectory: 0, segmentTrajectory: 0 },
      coverage: "insufficient",
    };
  }

  const entry = WEIGHT_TABLE[key];
  const rawComposite =
    entry.weights.playerMomentum * (p?.multiplier ?? 0) +
    entry.weights.cardTrajectory * (c?.multiplier ?? 0) +
    entry.weights.segmentTrajectory * (s?.multiplier ?? 0);
  const composite = clamp(rawComposite, 0.70, 1.50);

  return {
    composite: Math.round(composite * 1000) / 1000,
    direction: deriveDirection(composite),
    impliedPct: Math.round((composite - 1) * 1000) / 10,
    // Layer 1's lastUpdated is the only meaningful timestamp; L2/L3 are
    // computed in-process from live data fetched this request.
    lastUpdated: p?.lastUpdated ?? null,
    components,
    weights: entry.weights,
    coverage: entry.coverage,
  };
}

/** One-line grep-able log per estimate. Format locked in trendiq_design.md. */
export function formatTrendIQLogLine(result: TrendIQResult): string {
  const w = result.weights;
  return (
    `[compiq.trendIQ] composite=${result.composite.toFixed(2)} ` +
    `direction=${result.direction} coverage=${result.coverage} ` +
    `weights=p:${w.playerMomentum.toFixed(2)}/` +
    `c:${w.cardTrajectory.toFixed(2)}/` +
    `s:${w.segmentTrajectory.toFixed(2)}`
  );
}
