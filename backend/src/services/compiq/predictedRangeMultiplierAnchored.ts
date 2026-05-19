// ---------------------------------------------------------------------------
// Predicted Range — Multiplier-Anchored (Issue #25 Phase 3 REBUILD)
//
// Replaces the coarse 8-tier integer system (predictedRangeTierAnchored.ts)
// with per-parallel-name multipliers from the owner-curated Chrome/Draft
// multiplier table (chromeDraftMultipliers.ts).
//
// Forward-looking { low, high } range derived from a peer pool of comps for
// OTHER parallels of the SAME card (same player, same set, different
// parallelName). Each peer comp's price is divided by its parallel's
// `baseMultiplier` to derive the implied player baseline. The median
// baseline is then scaled by the SUBJECT parallel's multiplier, and a
// regime-aware spread is applied.
//
// Math
// ----
//  1. For each peer comp:
//       impliedBaseline_i = peerPrice_i / peerEntry.baseMultiplier
//  2. midBaseline = median(impliedBaseline_i)
//  3. midpoint   = midBaseline × subjectEntry.baseMultiplier
//  4. Regime-aware spread → { low, high }
//
// Returns `predictedRange: null` (with `nullReason`) when:
//   • subject parallel is uncurated (not in multiplier table)
//   • fewer than MIN_PEERS curated peers remain after filtering
//   • regime has no defined spread model
//
// Pure function. No I/O. No engine dependencies beyond the multiplier
// table and the Regime type.
// ---------------------------------------------------------------------------

import { lookupMultiplier, type ChromeDraftEntry } from "./chromeDraftMultipliers.js";
import type { Regime } from "./regimeClassifier.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface MultiplierAnchoredPeerComp {
  /** Peer comp's parallel name (e.g., "Refractor", "Blue", "Gold Sapphire"). */
  parallelName: string;
  /** Sale price in USD. Must be > 0 and finite. */
  price: number;
  /** Optional age in days — currently informational, not used for weighting. */
  daysOld?: number;
}

export interface MultiplierAnchoredInput {
  /** Subject card's parallel name. */
  subjectParallelName: string | null | undefined;
  /** Subject's classified regime. Drives the spread model. */
  subjectRegime: Regime | null | undefined;
  /** Peer pool — same player, same set, different parallels. */
  peerComps: ReadonlyArray<MultiplierAnchoredPeerComp>;
}

export type MultiplierAnchoredSpreadModel =
  | "stable"
  | "gradually_rising"
  | "sharply_breaking_out"
  | "declining"
  | "sharply_crashing"
  | "volatile"
  | "null_unsupported_regime";

export type MultiplierAnchoredNullReason =
  | "uncurated_subject_parallel"
  | "insufficient_curated_peers"
  | "regime_insufficient_data"
  | "subject_parallel_missing";

export interface MultiplierAnchoredDiagnostics {
  peerCount: number;
  curatedPeerCount: number;
  subjectParallelName: string | null;
  subjectMultiplier: number | null;
  subjectColorTier: string | null;
  playerBaseline: number | null;
  midpoint: number | null;
  spreadModel: MultiplierAnchoredSpreadModel;
  /** Set when a null range is returned; null when a range was produced. */
  nullReason: MultiplierAnchoredNullReason | null;
  /** Top peers used in the baseline median (capped at 10 for response size). */
  peerBreakdown: Array<{
    parallelName: string;
    canonicalParallel: string;
    price: number;
    multiplier: number;
    impliedBaseline: number;
  }>;
}

export interface MultiplierAnchoredResult {
  predictedRange: { low: number; high: number } | null;
  /** Always "multiplier-anchored" — distinguishes from "live" / "tier-anchored". */
  source: "multiplier-anchored";
  diagnostics: MultiplierAnchoredDiagnostics;
}

// ─── Internals ──────────────────────────────────────────────────────────────

const MIN_PEERS = 3;

interface SpreadRule {
  model: MultiplierAnchoredSpreadModel;
  low: number;
  high: number;
}

const SPREADS: Readonly<Record<Regime, SpreadRule | null>> = Object.freeze({
  stable:               { model: "stable",               low: 0.85, high: 1.15 },
  gradually_rising:     { model: "gradually_rising",     low: 0.95, high: 1.15 },
  sharply_breaking_out: { model: "sharply_breaking_out", low: 1.00, high: 1.30 },
  declining:            { model: "declining",            low: 0.85, high: 0.95 },
  sharply_crashing:     { model: "sharply_crashing",     low: 0.70, high: 0.95 },
  volatile:             { model: "volatile",             low: 0.75, high: 1.25 },
  insufficient_data:    null,
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) >>> 1];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function nullResult(
  reason: MultiplierAnchoredNullReason,
  partial: Partial<MultiplierAnchoredDiagnostics>,
): MultiplierAnchoredResult {
  return {
    predictedRange: null,
    source: "multiplier-anchored",
    diagnostics: {
      peerCount: partial.peerCount ?? 0,
      curatedPeerCount: partial.curatedPeerCount ?? 0,
      subjectParallelName: partial.subjectParallelName ?? null,
      subjectMultiplier: partial.subjectMultiplier ?? null,
      subjectColorTier: partial.subjectColorTier ?? null,
      playerBaseline: partial.playerBaseline ?? null,
      midpoint: partial.midpoint ?? null,
      spreadModel: partial.spreadModel ?? "null_unsupported_regime",
      nullReason: reason,
      peerBreakdown: partial.peerBreakdown ?? [],
    },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute the multiplier-anchored predicted range.
 *
 * Never throws. Returns `predictedRange: null` with a documented `nullReason`
 * whenever a precondition fails.
 */
export function computeMultiplierAnchoredRange(
  input: MultiplierAnchoredInput,
): MultiplierAnchoredResult {
  const peerComps = Array.isArray(input?.peerComps) ? input.peerComps : [];
  const peerCount = peerComps.length;

  // (a) Subject parallel must be present and curated.
  const subjectNameRaw =
    typeof input?.subjectParallelName === "string" ? input.subjectParallelName.trim() : "";
  if (!subjectNameRaw) {
    return nullResult("subject_parallel_missing", { peerCount });
  }
  const subjectEntry = lookupMultiplier(subjectNameRaw);
  if (!subjectEntry || !Number.isFinite(subjectEntry.baseMultiplier) || subjectEntry.baseMultiplier <= 0) {
    return nullResult("uncurated_subject_parallel", {
      peerCount,
      subjectParallelName: subjectNameRaw,
    });
  }

  // (b) Regime must have a defined spread model.
  const regime: Regime | null | undefined = input?.subjectRegime ?? null;
  const spread = regime ? SPREADS[regime] : null;
  if (!spread) {
    return nullResult("regime_insufficient_data", {
      peerCount,
      subjectParallelName: subjectEntry.parallelName,
      subjectMultiplier: subjectEntry.baseMultiplier,
      subjectColorTier: subjectEntry.colorTier,
    });
  }

  // (c) Filter peers to those with a curated multiplier and valid price.
  type Usable = {
    parallelName: string;
    canonicalParallel: string;
    price: number;
    multiplier: number;
    impliedBaseline: number;
  };
  const usable: Usable[] = [];
  for (const peer of peerComps) {
    if (!peer || typeof peer.parallelName !== "string") continue;
    if (typeof peer.price !== "number" || !Number.isFinite(peer.price) || peer.price <= 0) continue;
    const peerEntry: ChromeDraftEntry | null = lookupMultiplier(peer.parallelName);
    if (!peerEntry || !Number.isFinite(peerEntry.baseMultiplier) || peerEntry.baseMultiplier <= 0) continue;
    const impliedBaseline = peer.price / peerEntry.baseMultiplier;
    if (!Number.isFinite(impliedBaseline) || impliedBaseline <= 0) continue;
    usable.push({
      parallelName: peer.parallelName,
      canonicalParallel: peerEntry.parallelName,
      price: peer.price,
      multiplier: peerEntry.baseMultiplier,
      impliedBaseline,
    });
  }

  if (usable.length < MIN_PEERS) {
    return nullResult("insufficient_curated_peers", {
      peerCount,
      curatedPeerCount: usable.length,
      subjectParallelName: subjectEntry.parallelName,
      subjectMultiplier: subjectEntry.baseMultiplier,
      subjectColorTier: subjectEntry.colorTier,
      spreadModel: spread.model,
      peerBreakdown: usable.slice(0, 10).map((u) => ({
        parallelName: u.parallelName,
        canonicalParallel: u.canonicalParallel,
        price: round2(u.price),
        multiplier: u.multiplier,
        impliedBaseline: round2(u.impliedBaseline),
      })),
    });
  }

  // (d) Median of implied baselines, then scale by subject multiplier.
  const baselines = usable.map((u) => u.impliedBaseline).sort((a, b) => a - b);
  const midBaseline = median(baselines);
  const midpoint = midBaseline * subjectEntry.baseMultiplier;

  // (e) Regime-aware spread.
  const low = midpoint * spread.low;
  const high = midpoint * spread.high;
  const finalLow = Math.min(low, high);
  const finalHigh = Math.max(low, high);

  return {
    predictedRange: { low: round2(finalLow), high: round2(finalHigh) },
    source: "multiplier-anchored",
    diagnostics: {
      peerCount,
      curatedPeerCount: usable.length,
      subjectParallelName: subjectEntry.parallelName,
      subjectMultiplier: subjectEntry.baseMultiplier,
      subjectColorTier: subjectEntry.colorTier,
      playerBaseline: round2(midBaseline),
      midpoint: round2(midpoint),
      spreadModel: spread.model,
      nullReason: null,
      peerBreakdown: usable.slice(0, 10).map((u) => ({
        parallelName: u.parallelName,
        canonicalParallel: u.canonicalParallel,
        price: round2(u.price),
        multiplier: u.multiplier,
        impliedBaseline: round2(u.impliedBaseline),
      })),
    },
  };
}
