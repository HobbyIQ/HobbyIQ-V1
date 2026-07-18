// CF-COMMUNITY-INTELLIGENCE (Drew, 2026-07-17). Pure aggregation math
// for the community signal surface with k-anonymity gating.
//
// Model:
//   • Tiered opt-in: READ default ON, WRITE explicit opt-in.
//     Any user can consume aggregates; only opted-in users contribute
//     to them.
//   • k-anonymity: no aggregate exposed until at least K distinct
//     users have contributed. K=5 by default. Prevents "which user
//     owns this rare card" inference from a per-SKU count.
//   • Aggregation-only: signals returned are bucket-level counts and
//     ratios. No per-user data ever crosses the wire.
//
// This file is pure — no I/O. Consumers pass in the contributor
// counts + sale counts + estimate arrays; we do the arithmetic and
// gate the k-anonymity return.

export const DEFAULT_K_ANONYMITY = 5;

export interface CommunityAggregationInputs {
  cardId: string;
  /** Number of DISTINCT consenting users who currently own >=1 unit of
   *  this cardId. Feeds share-of-holders. */
  holderCount: number;
  /** Number of DISTINCT consenting users tracked (denominator for
   *  share-of-holders). Feeds "X% of pros are holding this SKU." */
  totalContributors: number;
  /** Number of DISTINCT consenting users who owned this cardId at any
   *  point in the last `turnoverWindowDays` AND have since recorded a
   *  sale. Feeds cohort turnover rate. */
  soldInWindowCount: number;
  /** Denominator for turnover — total distinct owners of cardId in
   *  the same window. */
  ownersInWindowCount: number;
  turnoverWindowDays: number;
  /** Optional per-user contributed engine estimates for this cardId
   *  (deduped one-per-user upstream). Feeds consensus predicted price
   *  via median. */
  contributedEstimates?: number[];
  /** Override k-anonymity (test seam). */
  kAnonymity?: number;
}

export type CommunitySignalReason =
  | "below_k_anonymity"
  | "no_contributors"
  | "ok";

export interface CommunityAggregationResult {
  cardId: string;
  kAnonymity: number;
  holderShare: {
    value: number | null;                // 0..1, null when suppressed
    reason: CommunitySignalReason;
    /** Total contributors — surfaced only when aggregated already,
     *  never a per-cardId denominator that could leak. */
    contributorPool: number;
  };
  turnover: {
    value: number | null;                // 0..1
    reason: CommunitySignalReason;
    windowDays: number;
  };
  consensusPrice: {
    value: number | null;
    reason: CommunitySignalReason;
    sampleSize: number;
  };
}

export function aggregateCommunitySignal(inp: CommunityAggregationInputs): CommunityAggregationResult {
  const K = inp.kAnonymity ?? DEFAULT_K_ANONYMITY;

  // ── Holder share ────────────────────────────────────────────────
  let holderValue: number | null = null;
  let holderReason: CommunitySignalReason = "ok";
  if (inp.totalContributors <= 0) {
    holderReason = "no_contributors";
  } else if (inp.holderCount < K) {
    holderReason = "below_k_anonymity";
  } else {
    holderValue = round4(inp.holderCount / inp.totalContributors);
  }

  // ── Cohort turnover ─────────────────────────────────────────────
  let turnoverValue: number | null = null;
  let turnoverReason: CommunitySignalReason = "ok";
  if (inp.ownersInWindowCount < K) {
    turnoverReason = "below_k_anonymity";
  } else if (inp.ownersInWindowCount === 0) {
    turnoverReason = "no_contributors";
  } else {
    turnoverValue = round4(inp.soldInWindowCount / inp.ownersInWindowCount);
  }

  // ── Consensus predicted price ───────────────────────────────────
  const estimates = (inp.contributedEstimates ?? [])
    .filter((n) => Number.isFinite(n) && n > 0);
  let consensusValue: number | null = null;
  let consensusReason: CommunitySignalReason = "ok";
  if (estimates.length < K) {
    consensusReason = "below_k_anonymity";
  } else {
    consensusValue = round2(median(estimates));
  }

  return {
    cardId: inp.cardId,
    kAnonymity: K,
    holderShare: {
      value: holderValue,
      reason: holderReason,
      contributorPool: inp.totalContributors,
    },
    turnover: {
      value: turnoverValue,
      reason: turnoverReason,
      windowDays: inp.turnoverWindowDays,
    },
    consensusPrice: {
      value: consensusValue,
      reason: consensusReason,
      sampleSize: estimates.length,
    },
  };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
