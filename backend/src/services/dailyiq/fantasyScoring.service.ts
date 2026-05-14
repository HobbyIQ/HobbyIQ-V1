// DraftKings-style fantasy scoring for DailyIQ.
//
// Ported from the dailyiq.jsx reference scoring tables. The values here are
// the DK MLB classic-contest weights. We expose a SECONDARY ranking signal
// alongside the existing `rankingScore` so the iOS app can show a
// "DK points" badge without changing the existing rank order.
//
// IMPORTANT: PlayerDailyStats in dailyiq.routes.ts does NOT carry doubles,
// triples, HBP, complete games, shutouts, or no-hitters — those columns
// aren't sourced today. We score with the fields we have and treat all
// non-HR hits as singles. This is a deliberate approximation; do NOT add
// fake values for missing columns.

export const HITTER_POINTS = {
  single: 3,
  double: 5,
  triple: 8,
  homeRun: 10,
  rbi: 2,
  run: 2,
  walk: 2,
  hbp: 2,
  stolenBase: 5,
} as const;

export const PITCHER_POINTS = {
  out: 0.75,
  strikeout: 2,
  win: 4,
  earnedRun: -2,
  hit: -0.6,
  walk: -0.6,
  hbp: -0.6,
  completeGame: 2.5,
  completeGameShutout: 2.5,
  noHitter: 5,
} as const;

export interface FantasyHitterStats {
  hits?: number;
  homeRuns?: number;
  doubles?: number;       // optional — not currently populated
  triples?: number;       // optional — not currently populated
  rbi?: number;
  rbis?: number;
  runs?: number;
  walks?: number;
  hitByPitch?: number;    // optional — not currently populated
  stolenBases?: number;
}

export interface FantasyPitcherStats {
  inningsPitched?: string | number;
  strikeouts?: number;
  earnedRuns?: number;
  hits?: number;
  walks?: number;
  hitByPitch?: number;    // optional — not currently populated
  wins?: number;
  completeGames?: number; // optional — not currently populated
  shutouts?: number;      // optional — not currently populated
  noHitters?: number;     // optional — not currently populated
}

/** Convert "5.2" innings-pitched (5 IP + 2 outs) into total outs recorded. */
export function inningsPitchedToOuts(ip: string | number | undefined): number {
  if (ip == null) return 0;
  const raw = typeof ip === "number" ? ip : Number.parseFloat(ip);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const whole = Math.floor(raw);
  const frac = Number((raw - whole).toFixed(1));
  const partialOuts = frac === 0.1 ? 1 : frac === 0.2 ? 2 : 0;
  return whole * 3 + partialOuts;
}

export function scoreHitter(stats: FantasyHitterStats): number {
  const hits = Math.max(0, stats.hits ?? 0);
  const hr = Math.max(0, stats.homeRuns ?? 0);
  const doubles = Math.max(0, stats.doubles ?? 0);
  const triples = Math.max(0, stats.triples ?? 0);
  // Single = hits - HR - 2B - 3B (clamped to zero in case data is partial).
  const singles = Math.max(0, hits - hr - doubles - triples);
  const rbi = stats.rbi ?? stats.rbis ?? 0;
  const points =
    singles * HITTER_POINTS.single +
    doubles * HITTER_POINTS.double +
    triples * HITTER_POINTS.triple +
    hr * HITTER_POINTS.homeRun +
    (rbi ?? 0) * HITTER_POINTS.rbi +
    (stats.runs ?? 0) * HITTER_POINTS.run +
    (stats.walks ?? 0) * HITTER_POINTS.walk +
    (stats.hitByPitch ?? 0) * HITTER_POINTS.hbp +
    (stats.stolenBases ?? 0) * HITTER_POINTS.stolenBase;
  return Number(points.toFixed(2));
}

export function scorePitcher(stats: FantasyPitcherStats): number {
  const outs = inningsPitchedToOuts(stats.inningsPitched);
  const points =
    outs * PITCHER_POINTS.out +
    (stats.strikeouts ?? 0) * PITCHER_POINTS.strikeout +
    (stats.wins ?? 0) * PITCHER_POINTS.win +
    (stats.earnedRuns ?? 0) * PITCHER_POINTS.earnedRun +
    (stats.hits ?? 0) * PITCHER_POINTS.hit +
    (stats.walks ?? 0) * PITCHER_POINTS.walk +
    (stats.hitByPitch ?? 0) * PITCHER_POINTS.hbp +
    (stats.completeGames ?? 0) * PITCHER_POINTS.completeGame +
    (stats.shutouts ?? 0) * PITCHER_POINTS.completeGameShutout +
    (stats.noHitters ?? 0) * PITCHER_POINTS.noHitter;
  return Number(points.toFixed(2));
}

/**
 * Compute DK fantasy points for one DailyIQ player using their position to
 * decide which formula to apply. Returns null when the player has no daily
 * stats (e.g. didn't play).
 */
export function computeFantasyPoints(
  position: string,
  dailyStats: FantasyHitterStats & FantasyPitcherStats & { statsType?: "batting" | "pitching" } | undefined,
): number | null {
  if (!dailyStats) return null;
  const isPitcher = dailyStats.statsType === "pitching"
    || ["SP", "RP", "P", "CP"].includes((position ?? "").toUpperCase());
  return isPitcher ? scorePitcher(dailyStats) : scoreHitter(dailyStats);
}
