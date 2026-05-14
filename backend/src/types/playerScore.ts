// PlayerScore types — the data foundation for PlayerIQ.
//
// One PlayerScore document per player, upserted on every estimate call
// (real-time, fire-and-forget) and refreshed nightly by fn-player-score-refresh.
// Stored in Cosmos container `player_trends` (partition /playerId).
//
// playerIQScore = market * 0.60 + performance * 0.40 — never change this
// blend without updating the project brain.

export type PlayerIQDirection = "rising" | "falling" | "stable";
export type Confidence = "high" | "medium" | "low";

export interface MarketScore {
  /** 0-100 derived from broaderTrend impliedTrendPct + recent comp velocity. */
  marketScore: number;
  /** Direction inferred from the median-of-medians of cardSnapshots. */
  marketDirection: PlayerIQDirection;
  /** Average impliedTrendPct across the player's cards, capped ±60. */
  avgTrendPct: number;
  /** Total samples backing this score (sum of cardSnapshots[*].totalSamples). */
  totalSamples: number;
  /** Distinct cardIds contributing to the score. */
  cardCount: number;
  /** Top card by absolute trend movement (for UX surface). */
  topCardName: string | null;
  confidence: Confidence;
}

export interface PerformanceScore {
  /** 0-100 derived from momentum_ratio. 50 = neutral, 100 = on fire. */
  performanceScore: number;
  performanceDirection: PlayerIQDirection;
  /** Recent / baseline ratio from MLB Stats API. 1.0 = neutral. */
  momentumRatio: number;
  /** Short statline e.g. "5G: .333/.421/.667 (3 HR)". */
  statLine: string | null;
  /** "hitting" | "pitching" | null. */
  statGroup: "hitting" | "pitching" | null;
  /** "approaching 500 HR" etc, or null. */
  milestone: string | null;
  confidence: Confidence;
}

export interface PlayerIQScore {
  /** Combined 0-100 score. */
  playerIQScore: number;
  /** UX label per Step 2 rules ("Breakout Watch 🔥", "Heating Up ↑", ...). */
  playerIQLabel: string;
  /** Overall direction from the dominant signal. */
  playerIQDirection: PlayerIQDirection;
}

/**
 * Cosmos document shape stored in `player_trends`.
 * Document id = playerId. Partition key = /playerId.
 */
export interface PlayerScore {
  /** Cosmos document id (matches playerId). */
  id: string;

  // Identity
  playerId: string;          // slug e.g. "shohei-ohtani" OR mlbId as string
  playerName: string;
  mlbPlayerId: number | null;
  team: string | null;
  position: string | null;
  league: "MLB" | "MiLB" | "unknown";
  level: string | null;      // "AAA" / "AA" / null

  // Score components
  market: MarketScore;
  performance: PerformanceScore;

  // Combined
  playerIQScore: number;
  playerIQLabel: string;
  playerIQDirection: PlayerIQDirection;

  // Provenance
  updatedAt: string;            // ISO8601
  dataSource: "realtime_estimate" | "nightly_job" | "manual_seed";
  confidence: Confidence;       // Overall — based on data availability
}

/**
 * Snapshot of a single card's broaderTrend signal at a point in time.
 * Stored in Cosmos `trend_history` (partition /cardId) by the
 * fire-and-forget writer at the end of computeEstimate().
 *
 * Read by computeMarketScore() to aggregate "all this player's cards
 * over the last 7 days" into a single MarketScore.
 */
export interface TrendSnapshot {
  id: string;                 // `${cardId}_${timestamp}`
  cardId: string;             // partition key
  playerName: string;
  year: number | null;
  set: string | null;
  cardNumber: string | null;
  grade: string;

  // From BroaderTrend
  impliedTrendPct: number;
  direction: "up" | "down" | "flat";
  basedOn: "exact" | "broader" | "insufficient";
  recentMedian: number | null;
  olderMedian: number | null;
  recentCount: number;
  olderCount: number;
  similarCardsScanned: number;
  totalSamples: number;

  // Pricing context at snapshot time
  fairMarketValue: number | null;
  anchorPrice: number | null;

  timestamp: string;          // ISO8601
}

/**
 * Apply the playerIQLabel rules from Step 2.
 *
 *   score >= 80 + rising  → "Breakout Watch 🔥"
 *   score >= 70 + rising  → "Heating Up ↑"
 *   score >= 60 + stable  → "Solid Hold"
 *   score 40-60           → "Watch"
 *   score < 40 + falling  → "Cooling ↓"
 *   score < 30            → "Avoid"
 *   (anything else)       → "Watch"
 */
export function deriveLabel(score: number, direction: PlayerIQDirection): string {
  if (score >= 80 && direction === "rising") return "Breakout Watch 🔥";
  if (score >= 70 && direction === "rising") return "Heating Up ↑";
  if (score >= 60 && direction === "stable") return "Solid Hold";
  if (score < 30) return "Avoid";
  if (score < 40 && direction === "falling") return "Cooling ↓";
  if (score >= 40 && score <= 60) return "Watch";
  return "Watch";
}

/** Slug helper for playerId fallback when MLB id is unknown. */
export function playerNameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
