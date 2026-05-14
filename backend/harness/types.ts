/**
 * Harness type contracts. These shapes are STABLE — any change must
 * bump the schemaVersion and update all corpus files.
 */

export const HARNESS_SCHEMA_VERSION = 1 as const;

export type MarketState =
  | "liquid"
  | "moderate"
  | "thin"
  | "very_thin"
  | "stale_with_active_siblings"
  | "cold_no_data";

export type PricingStrategy =
  | "direct_comp"
  | "lift_adjusted"
  | "neighbor_synthesis"
  | "cross_parallel_anchor"
  | "cold_fallback";

export type ConfidenceBand = "very_low" | "low" | "moderate" | "high" | "very_high";

export type CaseConfidence = "high" | "suspicious" | "unknown";

export interface ExpectedPriceRange {
  /** Inclusive lower bound, in USD. */
  min: number;
  /** Inclusive upper bound, in USD. */
  max: number;
}

export interface HarnessCase {
  /** Stable identifier — never change once locked. */
  id: string;
  /** Free-text card query as the user would type it. */
  query: string;
  /** Optional structured override for cases that bypass the parser. */
  structuredPayload?: Record<string, unknown>;
  /** What the engine should produce. */
  expectedPriceRange: ExpectedPriceRange | null;
  expectedMarketState: MarketState;
  expectedStrategy: PricingStrategy;
  expectedConfidenceBand: ConfidenceBand;
  /** Agent's self-rated read on whether the baseline is defensible. */
  confidence: CaseConfidence;
  /** What the monolith returned at corpus-creation time, for audit. */
  monolithOutput?: {
    fairMarketValue: number | null;
    marketState?: string;
    strategy?: string;
    confidence?: number;
  };
  /** Human-readable description of why this case exists. */
  notes: string;
  /** Bumped each time the expected values change intentionally. */
  revision: number;
  /** Required when revision > 1. */
  revisionReason?: string;
  /** Optional ISO override for the harness clock. */
  asOf?: string;
  /** Coverage slot — used to verify the corpus hits all required categories. */
  slot:
    | "modern_sports_liquid"
    | "modern_sports_stale_siblings"
    | "vintage_sports"
    | "pokemon"
    | "tcg"
    | "sealed"
    | "grade_spread"
    | "edge_identity"
    | "cold_no_data";
}

export interface HarnessRunResult {
  caseId: string;
  passed: boolean;
  durationMs: number;
  failureReasons: string[];
  /** Full normalized engine response, used for snapshot comparison. */
  snapshot: Record<string, unknown>;
}

export interface TierRunSummary {
  tier: 1 | 2 | 3;
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
  skipReason?: "infrastructure-unavailable" | "budget-exceeded" | "tier-disabled";
  durationMs: number;
  budgetMs: number;
  budgetExceeded: boolean;
}

export const TIER_BUDGETS_MS = {
  1: 30_000,
  2: 120_000,
  3: 300_000,
} as const;
