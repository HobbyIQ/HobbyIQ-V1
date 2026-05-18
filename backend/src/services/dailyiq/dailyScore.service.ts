// DailyIQ explainable score.
//
// Goal: a single number per player per day that is easy to defend.
// We deliberately do NOT use the DK fantasy weights here — those are
// optimized for fantasy contests, not for "who had a great game today".
//
// Hitter weights (per event):
//   HR        4.0   home runs dwarf everything else for a single game
//   Hit       2.0   reward contact; a 3-hit day already scores 6 here
//   RBI       1.5   driving in runs matters; small to avoid double-count w/ HR
//   Run       1.0   getting on and scoring
//   SB        2.0   stolen bases are rare, score them well
//   BB        0.8   walks count, but less than a hit
//   TB-extra  1.0 * (TB - hits)   extra bases (doubles/triples) when present
//   Multi-hit +1.0  flat bonus when hits >= 2 — matches the badge logic
//
// Pitcher weights:
//   K         2.0   strikeouts are the cleanest pitcher event
//   IP        3.0   per inning pitched (3 outs); rewards depth
//   ER       -2.0   damage done
//   BB       -0.6   free passes
//   H allowed -0.4  hits allowed are penalized less than walks (less avoidable)
//   W         4.0   bonus on a win
//   SV        5.0   bonus on a save (rare, high-leverage)
//   HLD       2.0   bonus on a hold
//   QS        3.0   quality start = 6+ IP and ER <= 3
//   Eff       +1.0  bonus when pitches/IP <= 15 (efficient outing)
//
// Movement baseline derives from seasonStats / gamesPlayed — see
// movement.service.ts. The scoring service does not know about baselines.

export interface DailyScoreHitter {
  hits?: number;
  homeRuns?: number;
  rbi?: number;
  rbis?: number;
  runs?: number;
  walks?: number;
  stolenBases?: number;
  doubles?: number;
  triples?: number;
  totalBases?: number;
}

export interface DailyScorePitcher {
  inningsPitched?: string | number;
  strikeouts?: number;
  earnedRuns?: number;
  walks?: number;
  hitsAllowed?: number;
  homeRunsAllowed?: number;
  wins?: number;
  losses?: number;
  saves?: number;
  holds?: number;
  qualityStart?: boolean;
  pitchCount?: number;
}

function ipToOuts(ip: string | number | undefined): number {
  if (ip == null) return 0;
  const raw = typeof ip === "number" ? ip : Number.parseFloat(ip);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const whole = Math.floor(raw);
  const frac = Number((raw - whole).toFixed(1));
  const partial = frac === 0.1 ? 1 : frac === 0.2 ? 2 : 0;
  return whole * 3 + partial;
}

export function scoreHitterDay(s: DailyScoreHitter): number {
  const hits = Math.max(0, s.hits ?? 0);
  const hr = Math.max(0, s.homeRuns ?? 0);
  const rbi = Math.max(0, s.rbi ?? s.rbis ?? 0);
  const runs = Math.max(0, s.runs ?? 0);
  const sb = Math.max(0, s.stolenBases ?? 0);
  const bb = Math.max(0, s.walks ?? 0);
  // Extra bases only counted when boxscore provides 2B/3B/TB; otherwise zero.
  const totalBases = s.totalBases ?? (hits + (s.doubles ?? 0) + 2 * (s.triples ?? 0) + 3 * hr);
  const extraBases = Math.max(0, totalBases - hits);
  const multiHit = hits >= 2 ? 1 : 0;
  const score =
    4.0 * hr +
    2.0 * hits +
    1.5 * rbi +
    1.0 * runs +
    2.0 * sb +
    0.8 * bb +
    1.0 * extraBases +
    1.0 * multiHit;
  return Number(score.toFixed(2));
}

export function scorePitcherDay(s: DailyScorePitcher): number {
  const outs = ipToOuts(s.inningsPitched);
  const ip = outs / 3;
  if (outs === 0) return 0; // didn't pitch
  const k = Math.max(0, s.strikeouts ?? 0);
  const er = Math.max(0, s.earnedRuns ?? 0);
  const bb = Math.max(0, s.walks ?? 0);
  const h = Math.max(0, s.hitsAllowed ?? 0);
  const w = Math.max(0, s.wins ?? 0);
  const sv = Math.max(0, s.saves ?? 0);
  const hld = Math.max(0, s.holds ?? 0);
  const qs = s.qualityStart ? 1 : 0;
  const pitches = s.pitchCount ?? 0;
  const efficient = pitches > 0 && ip > 0 && pitches / ip <= 15 ? 1 : 0;
  const score =
    2.0 * k +
    3.0 * ip +
    -2.0 * er +
    -0.6 * bb +
    -0.4 * h +
    4.0 * w +
    5.0 * sv +
    2.0 * hld +
    3.0 * qs +
    1.0 * efficient;
  return Number(score.toFixed(2));
}

const PITCHER_POSITIONS = new Set(["SP", "RP", "CP", "CL", "P", "TWP"]);

/** Decide which side of a two-way / messy position to score. Prefers
 *  the explicit statsType on the daily payload — falls back to position. */
export function isPitcherDay(opts: {
  position?: string;
  statsType?: "batting" | "pitching";
  inningsPitched?: string | number;
}): boolean {
  if (opts.statsType === "pitching") return true;
  if (opts.statsType === "batting") return false;
  if (ipToOuts(opts.inningsPitched) > 0) return true;
  return PITCHER_POSITIONS.has((opts.position ?? "").toUpperCase());
}

export function computeDailyScore(
  position: string,
  daily: (DailyScoreHitter & DailyScorePitcher & { statsType?: "batting" | "pitching" }) | undefined,
): number {
  if (!daily) return 0;
  return isPitcherDay({ position, statsType: daily.statsType, inningsPitched: daily.inningsPitched })
    ? scorePitcherDay(daily)
    : scoreHitterDay(daily);
}

/** Approximate per-game baseline from season stats. */
export function baselineFromSeason(
  position: string,
  season:
    | {
        gamesPlayed?: number;
        hits?: number;
        homeRuns?: number;
        rbi?: number;
        rbis?: number;
        runs?: number;
        walks?: number;
        stolenBases?: number;
        strikeouts?: number;
        wins?: number;
        saves?: number;
        era?: string;
        statsType?: "batting" | "pitching";
      }
    | undefined,
): number {
  if (!season) return 0;
  const games = Math.max(1, season.gamesPlayed ?? 1);
  const isPitcher = season.statsType === "pitching" || PITCHER_POSITIONS.has((position ?? "").toUpperCase());
  if (isPitcher) {
    const kPerG = (season.strikeouts ?? 0) / games;
    const wPerG = (season.wins ?? 0) / games;
    const svPerG = (season.saves ?? 0) / games;
    const era = Number.parseFloat(season.era ?? "4.50");
    const eraGoodness = Math.max(0, 5 - era); // 5.00 ERA -> 0; 2.00 ERA -> 3
    return Number((2 * kPerG + 4 * wPerG + 5 * svPerG + eraGoodness).toFixed(2));
  }
  const hitsPerG = (season.hits ?? 0) / games;
  const hrPerG = (season.homeRuns ?? 0) / games;
  const rbiPerG = (season.rbi ?? season.rbis ?? 0) / games;
  const runsPerG = (season.runs ?? 0) / games;
  const sbPerG = (season.stolenBases ?? 0) / games;
  const bbPerG = (season.walks ?? 0) / games;
  return Number((4 * hrPerG + 2 * hitsPerG + 1.5 * rbiPerG + runsPerG + 2 * sbPerG + 0.8 * bbPerG).toFixed(2));
}
