// TrendIQ composite computation — combines the three input layers into a
// single forward-looking score per docs/phase0/trendiq_design.md.
//
// Phase 1 implementation: this module owns the weight-table lookup,
// composite math, deadband direction, and impliedPct rounding. Per-layer
// computation (Layer 1 fetch, Layer 2 windowing, Layer 3 anchor handling)
// lives in their respective modules; this module composes pre-built
// component objects.

import {
  type CardTrajectoryComponent,
  type PlayerMomentumComponent,
  type SegmentTrajectoryComponent,
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

// ─── Layer 2: card-level comp trajectory ────────────────────────────────────
//
// Locked methodology (docs/phase0/trendiq_design.md "Phase 1 methodology
// locks"):
//   - Recent window: 0..14 days from now (inclusive)
//   - Older window: (14, 45] days from now
//   - Minimum: 2 comps in recent AND 2 in older — else null
//   - pctChange clamp: ±50%
//   - Multiplier conversion: clamp(0.70, 1.50, 1 + pctChange / 100)
//
// Median choice: plain unweighted median per window (NOT
// computeWeightedMedian from compiqEstimate.service.ts). For trend
// comparison we want each window's median to fairly represent that
// window's price level; velocity weighting inside the older window
// (which decays from 1.0x at 15-21d to 0.1x past 30d) would bias the
// older median upward toward the recent edge and dampen apparent trend
// changes. The median is also naturally outlier-robust, so we skip the
// `applyCompQualityFilter` pre-filter that the pricing path uses.
//
// Coupling note: we intentionally do NOT apply variant / parallel /
// grade filters here. The caller (computeEstimate) passes its raw
// `fetched.comps` set — comps for the resolved card_id, all variants.
// Same-card variants tend to move directionally together (a hot player
// pulls all his cards), so the trend signal is meaningful without the
// extra filter. Layer 3 (segment trajectory) and the pricing path
// handle finer-grained filtering for their own purposes.

interface CardTrajectoryInput {
  price: number;
  soldDate: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function simpleMedian(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function computeCardTrajectory(
  comps: ReadonlyArray<CardTrajectoryInput>,
  nowMs: number = Date.now(),
): CardTrajectoryComponent | null {
  const recent: number[] = [];
  const older: number[] = [];

  for (const c of comps) {
    if (!c.soldDate) continue;
    if (!Number.isFinite(c.price) || c.price <= 0) continue;
    const ts = Date.parse(c.soldDate);
    if (!Number.isFinite(ts)) continue;
    const ageDays = (nowMs - ts) / DAY_MS;
    if (ageDays < 0) continue;             // future-dated comp — skip
    if (ageDays <= 14) {
      recent.push(c.price);
    } else if (ageDays <= 45) {
      older.push(c.price);
    }
  }

  if (recent.length < 2 || older.length < 2) return null;

  const recentMedian = simpleMedian(recent);
  const olderMedian = simpleMedian(older);
  if (
    recentMedian === null ||
    olderMedian === null ||
    olderMedian <= 0
  ) {
    return null;
  }

  const rawPct = ((recentMedian - olderMedian) / olderMedian) * 100;
  const pctChange = clamp(rawPct, -50, 50);
  const multiplier = clamp(1 + pctChange / 100, 0.70, 1.50);

  return {
    multiplier: Math.round(multiplier * 1000) / 1000,
    pctChange: Math.round(pctChange * 10) / 10,
    recentMedian: Math.round(recentMedian * 100) / 100,
    olderMedian: Math.round(olderMedian * 100) / 100,
    recentCount: recent.length,
    olderCount: older.length,
    windowRecentDays: 14,
    windowOlderDays: 30, // duration span 15..45 = 30 days
  };
}

// ─── Layer 3: segment trajectory anchored to card's last sale date ──────────
//
// Locked methodology (docs/phase0/trendiq_design.md "Phase 1 methodology
// locks") + 2026-05-26 re-anchor resolution (Option C — anchor-relative
// pre-window):
//
//   - Anchor source: this card's most recent sale timestamp (`newestTs` from
//     fetched.comps). `originalAnchorDate` = the true last-sale date.
//   - If `newestTs <= 0` (card never sold): return null.
//   - If anchor < 7 days ago: post-window too short → return null.
//   - Re-anchoring: when anchor > 180 days ago, `effectiveAnchorDate` moves
//     forward to `now - 90d` so re-anchored cards still get a meaningful
//     segment trajectory. `originalAnchorDate` stays the true last-sale date
//     so the UI can show "Last sale: 250 days ago — segment trajectory uses
//     90-day window".
//   - Pre-window: ALWAYS 30 days immediately before `effectiveAnchorDate`.
//     This decouples pre-window length from `windowDays` and resolves a
//     spec inconsistency:
//       Original spec said `windowDays = 60` AND `preAnchor: soldDate >=
//       (now - windowDays)`. When re-anchor moved effectiveAnchorDate to
//       now-90d, the original preAnchor pool became `[now-60d, now-90d]` =
//       empty interval, defeating the re-anchor mechanism. Option C
//       (anchor-relative 30d pre-window) makes pre/post windows consistent
//       regardless of anchor position. Total span = 30 + (now - eff anchor).
//   - Post-window: `(effectiveAnchorDate, now]`.
//   - Pool: SIBLING sales only (exact card_id excluded — see fetchSiblingSales
//     in compiqEstimate.service.ts). fetchBroaderTrend uses the same pool
//     but folds in exactComps; computeSegmentTrajectory does NOT.
//   - Minimum: 2 comps in pre-anchor AND 2 in post-anchor — else null.
//   - pctChange clamp: ±50%
//   - Multiplier: clamp(0.70, 1.50, 1 + pctChange / 100). Same asymmetric
//     clamp as Layer 2 — a -50% pctChange contributes 0.70 (not 0.50) to
//     the composite. See trendiq_design.md and Layer 2 test for rationale.
//   - Median: same plain unweighted median as Layer 2 (no velocity
//     weighting — would bias the window-edge data).

/** Minimal shape this function needs from the sibling-sales pool. Structurally
 *  compatible with `SiblingSalesPool` from compiqEstimate.service.ts; defining
 *  it locally avoids a circular import. */
export interface SegmentPoolInput {
  siblingCardIds: ReadonlyArray<string>;
  sales: ReadonlyArray<{ price: number; ts: number }>;
}

const PRE_WINDOW_DAYS = 30;
const POST_WINDOW_MIN_AGE_DAYS = 7;
const REANCHOR_AGE_THRESHOLD_DAYS = 180;
const REANCHOR_TARGET_AGE_DAYS = 90;

export function computeSegmentTrajectory(
  pool: SegmentPoolInput,
  newestTs: number,
  nowMs: number = Date.now(),
): SegmentTrajectoryComponent | null {
  // Temporary diagnostic for B.4.c.3 live smoke — emits null reason + pool
  // sizes per call so we can verify which gate fires in production paths.
  // TODO: remove this `nullDiag` block once Layer 3 behavior is verified
  // in the wild and we have confidence in the production cohort.
  const nullDiag = (reason: string, extra?: Record<string, unknown>) => {
    console.log(
      `[compiq.trendIQ.L3] null reason=${reason} ` +
        `siblings=${pool.siblingCardIds.length} ` +
        `poolSales=${pool.sales.length}` +
        (extra
          ? " " +
            Object.entries(extra)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")
          : ""),
    );
  };

  // No anchor — card has never sold (or no usable timestamp). Layer 3 needs
  // a pivot point; no anchor means no trajectory.
  if (!Number.isFinite(newestTs) || newestTs <= 0) {
    nullDiag("no_anchor");
    return null;
  }

  const originalAnchorDate = new Date(newestTs).toISOString();
  const anchorAgeDays = (nowMs - newestTs) / DAY_MS;

  // Recent anchor — post-window would be < 7 days, too short for a meaningful
  // post-anchor median.
  if (anchorAgeDays < POST_WINDOW_MIN_AGE_DAYS) {
    nullDiag("anchor_too_recent", { anchorAgeDays: anchorAgeDays.toFixed(1) });
    return null;
  }

  // Re-anchor very-old anchors to keep Layer 3 useful for stale-last-sale
  // cards. Surface BOTH dates so the UI can communicate the re-anchor
  // transparently.
  const isReanchored = anchorAgeDays > REANCHOR_AGE_THRESHOLD_DAYS;
  const effectiveAnchorTs = isReanchored
    ? nowMs - REANCHOR_TARGET_AGE_DAYS * DAY_MS
    : newestTs;
  const effectiveAnchorDate = new Date(effectiveAnchorTs).toISOString();

  // Pre-window: [effectiveAnchor - 30d, effectiveAnchor]
  // Post-window: (effectiveAnchor, now]
  const preWindowStart = effectiveAnchorTs - PRE_WINDOW_DAYS * DAY_MS;
  const totalWindowDays = Math.round(
    (nowMs - preWindowStart) / DAY_MS,
  );

  const preAnchor: number[] = [];
  const postAnchor: number[] = [];
  for (const s of pool.sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    if (!Number.isFinite(s.ts)) continue;
    if (s.ts > effectiveAnchorTs && s.ts <= nowMs) {
      postAnchor.push(s.price);
    } else if (s.ts <= effectiveAnchorTs && s.ts >= preWindowStart) {
      preAnchor.push(s.price);
    }
  }

  if (preAnchor.length < 2 || postAnchor.length < 2) {
    nullDiag("sparse_pool", {
      anchorAgeDays: anchorAgeDays.toFixed(1),
      pre: preAnchor.length,
      post: postAnchor.length,
      reanchored: isReanchored,
    });
    return null;
  }

  const preAnchorMedian = simpleMedian(preAnchor);
  const postAnchorMedian = simpleMedian(postAnchor);
  if (
    preAnchorMedian === null ||
    postAnchorMedian === null ||
    preAnchorMedian <= 0
  ) {
    return null;
  }

  const rawPct = ((postAnchorMedian - preAnchorMedian) / preAnchorMedian) * 100;
  const pctChange = clamp(rawPct, -50, 50);
  const multiplier = clamp(1 + pctChange / 100, 0.70, 1.50);

  return {
    multiplier: Math.round(multiplier * 1000) / 1000,
    pctChange: Math.round(pctChange * 10) / 10,
    effectiveAnchorDate,
    originalAnchorDate,
    windowDays: totalWindowDays,
    preAnchorMedian: Math.round(preAnchorMedian * 100) / 100,
    postAnchorMedian: Math.round(postAnchorMedian * 100) / 100,
    preAnchorCount: preAnchor.length,
    postAnchorCount: postAnchor.length,
    siblingsScanned: pool.siblingCardIds.length,
    totalSamples: pool.sales.length,
  };
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
