// ---------------------------------------------------------------------------
// Predicted Range — Tier-Anchored Fallback (Issue #25 Phase 3)
//
// Forward-looking { low, high } range derived from a peer pool of comps for
// OTHER parallels of the SAME card (same player, same set, different
// parallelName), normalized through the owner-curated tier multiplier table
// (tierMultipliers.ts). Activates ONLY when Phase 2 (computePredictedRange)
// returns null AND the subject card has a known tierWithinSet AND a peer
// pool of ≥ 3 valid same-player comps exists.
//
// Authoritative design: issue #25 Phase 3 prompt (2026-05-17).
//
// Math
// ----
//  1. For each peer comp:
//       impliedBaseline_i = peerPrice_i / tierMultiplier(peerTier_i)
//     (this normalizes every parallel back to the subject's player-implied
//     tier-1 baseline)
//  2. midBaseline = median(impliedBaseline_i)
//  3. midpoint = midBaseline * tierMultiplier(subjectTier)
//  4. Apply regime-aware spread (see SPREADS below) to get { low, high }.
//
// Spread by regime (multipliers on midpoint):
//   stable               low * 0.85, high * 1.15        (±15%)
//   gradually_rising     low * 0.95, high * 1.15
//   sharply_breaking_out low * 1.00, high * 1.30
//   declining            low * 0.85, high * 0.95
//   sharply_crashing     low * 0.70, high * 0.95
//   volatile             low * 0.75, high * 1.25
//   insufficient_data    null (engine should have not reached here)
//
// Confidence (engine consumer applies):
//   Tier-anchored fallback emits source="tier-anchored". The caller is
//   responsible for demoting the confidence by one tier vs Phase 2-equivalent
//   ranges, since this is a synthesized signal, not a same-card observed
//   range.
//
// Pure function. No I/O. No engine dependencies beyond tierMultiplier.
// ---------------------------------------------------------------------------

import { tierMultiplier } from "./tierMultipliers.js";
import type { Regime } from "./regimeClassifier.js";

// ─── Public types ───────────────────────────────────────────────────────────

/** A single peer comp used by the tier-anchored synthesis. */
export interface TierAnchoredPeerComp {
  /** Sale price in USD. Must be > 0 and finite. */
  price: number;
  /** Peer parallel's tierWithinSet (positive integer per schema §2.1). */
  tier: number;
}

export interface TierAnchoredInput {
  /** Subject card's tierWithinSet. Null disables the fallback. */
  subjectTier: number | null;
  /** Subject's classified regime. Drives the spread model. */
  subjectRegime: Regime | null;
  /** Peer pool — same player, same set, different parallels. */
  peerPool: ReadonlyArray<TierAnchoredPeerComp>;
}

export type TierAnchoredSpreadModel =
  | "stable"
  | "gradually_rising"
  | "sharply_breaking_out"
  | "declining"
  | "sharply_crashing"
  | "volatile"
  | "null_unsupported_regime";

export type TierAnchoredNullReason =
  | "subject_tier_missing"
  | "subject_tier_unknown_multiplier"
  | "regime_insufficient_data"
  | "peer_pool_too_small"
  | "peer_pool_no_usable_comps";

export interface TierAnchoredDiagnostics {
  peerCount: number;
  usablePeerCount: number;
  subjectTier: number | null;
  subjectMultiplier: number | null;
  impliedBaseline: number | null;
  midpoint: number | null;
  spreadModel: TierAnchoredSpreadModel;
  /** Populated when the result is null; null when a range was produced. */
  nullReason: TierAnchoredNullReason | null;
}

export interface TierAnchoredResult {
  predictedRange: { low: number; high: number } | null;
  /** Always "tier-anchored" so the iOS / API consumer can distinguish from Phase 2 "live". */
  source: "tier-anchored";
  diagnostics: TierAnchoredDiagnostics;
}

// ─── Internals ──────────────────────────────────────────────────────────────

const MIN_PEERS = 3;

interface SpreadRule {
  model: TierAnchoredSpreadModel;
  low: number;
  high: number;
}

const SPREADS: Readonly<Record<Regime, SpreadRule | null>> = Object.freeze({
  stable: { model: "stable", low: 0.85, high: 1.15 },
  gradually_rising: { model: "gradually_rising", low: 0.95, high: 1.15 },
  sharply_breaking_out: { model: "sharply_breaking_out", low: 1.0, high: 1.3 },
  declining: { model: "declining", low: 0.85, high: 0.95 },
  sharply_crashing: { model: "sharply_crashing", low: 0.7, high: 0.95 },
  volatile: { model: "volatile", low: 0.75, high: 1.25 },
  insufficient_data: null,
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(sorted: number[]): number {
  // Caller guarantees sorted ascending and non-empty.
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) >>> 1];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function nullResult(
  reason: TierAnchoredNullReason,
  diagnostics: Partial<TierAnchoredDiagnostics>,
): TierAnchoredResult {
  return {
    predictedRange: null,
    source: "tier-anchored",
    diagnostics: {
      peerCount: diagnostics.peerCount ?? 0,
      usablePeerCount: diagnostics.usablePeerCount ?? 0,
      subjectTier: diagnostics.subjectTier ?? null,
      subjectMultiplier: diagnostics.subjectMultiplier ?? null,
      impliedBaseline: diagnostics.impliedBaseline ?? null,
      midpoint: diagnostics.midpoint ?? null,
      spreadModel: diagnostics.spreadModel ?? "null_unsupported_regime",
      nullReason: reason,
    },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute the tier-anchored fallback predicted range.
 *
 * Returns `predictedRange: null` (with a non-null `nullReason`) when any
 * precondition fails. Never throws on bad inputs — pure, defensive.
 */
export function computeTierAnchoredRange(
  input: TierAnchoredInput,
): TierAnchoredResult {
  const peerCount = Array.isArray(input?.peerPool) ? input.peerPool.length : 0;

  // (a) Subject tier must resolve to a known multiplier.
  const subjectTier = input?.subjectTier ?? null;
  if (subjectTier === null) {
    return nullResult("subject_tier_missing", { peerCount });
  }
  const subjectMultiplier = tierMultiplier(subjectTier);
  if (subjectMultiplier === null) {
    return nullResult("subject_tier_unknown_multiplier", {
      peerCount,
      subjectTier,
    });
  }

  // (b) Regime must produce a defined spread model. insufficient_data /
  //     null / anything unknown → null result with a documented reason.
  const regime: Regime | null = input?.subjectRegime ?? null;
  const spread = regime ? SPREADS[regime] : null;
  if (!spread) {
    return nullResult("regime_insufficient_data", {
      peerCount,
      subjectTier,
      subjectMultiplier,
    });
  }

  // (c) Filter the peer pool to USABLE comps: price > 0 finite, tier maps
  //     to a known multiplier, and resulting impliedBaseline is finite.
  const impliedBaselines: number[] = [];
  for (const peer of input.peerPool ?? []) {
    if (!peer || typeof peer.price !== "number") continue;
    if (!Number.isFinite(peer.price) || peer.price <= 0) continue;
    const peerMult = tierMultiplier(peer.tier);
    if (peerMult === null || peerMult <= 0) continue;
    const baseline = peer.price / peerMult;
    if (!Number.isFinite(baseline) || baseline <= 0) continue;
    impliedBaselines.push(baseline);
  }

  if (impliedBaselines.length === 0) {
    return nullResult("peer_pool_no_usable_comps", {
      peerCount,
      usablePeerCount: 0,
      subjectTier,
      subjectMultiplier,
      spreadModel: spread.model,
    });
  }
  if (impliedBaselines.length < MIN_PEERS) {
    return nullResult("peer_pool_too_small", {
      peerCount,
      usablePeerCount: impliedBaselines.length,
      subjectTier,
      subjectMultiplier,
      spreadModel: spread.model,
    });
  }

  // (d) Median of implied baselines, then scale by the subject multiplier.
  impliedBaselines.sort((a, b) => a - b);
  const midBaseline = median(impliedBaselines);
  const midpoint = midBaseline * subjectMultiplier;

  // (e) Apply regime-aware spread. Guarantee low ≤ high by construction.
  const low = midpoint * spread.low;
  const high = midpoint * spread.high;
  // Defensive: every SPREADS entry is authored with low ≤ high, but if a
  // future edit inverts that, collapse rather than emit an inverted range.
  const finalLow = Math.min(low, high);
  const finalHigh = Math.max(low, high);

  return {
    predictedRange: { low: round2(finalLow), high: round2(finalHigh) },
    source: "tier-anchored",
    diagnostics: {
      peerCount,
      usablePeerCount: impliedBaselines.length,
      subjectTier,
      subjectMultiplier,
      impliedBaseline: round2(midBaseline),
      midpoint: round2(midpoint),
      spreadModel: spread.model,
      nullReason: null,
    },
  };
}
