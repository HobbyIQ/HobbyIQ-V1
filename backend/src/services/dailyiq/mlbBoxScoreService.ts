// Real MLB daily stats from the MLB Stats API boxscores for sportId=1.
// Mirrors the MiLB service but adds pitching daily stats so the DailyIQ
// scoring engine ranks pool players by their actual day, not synthetic data.

import { resolveCurrentPlayerAssignments, type MiLBPlayerProfileLike } from "./milbBoxScoreService.js";

export interface MLBDailyStats {
  gameDate: string;
  opponent: string;
  atBats: number;
  runs: number;
  hits: number;
  homeRuns: number;
  rbi: number;
  rbis: number;
  walks: number;
  strikeouts: number;
  stolenBases: number;
  battingAverage: string;
  ops: string;
  dailyStatsStatus: string;
  statsType?: "batting" | "pitching";
  inningsPitched?: string;
  earnedRuns?: number;
  pitchCount?: number;
}

export interface MLBSeasonStats {
  gamesPlayed: number;
  atBats: number;
  runs: number;
  hits: number;
  homeRuns: number;
  rbi: number;
  rbis: number;
  walks: number;
  strikeouts: number;
  stolenBases: number;
  battingAverage: string;
  onBasePercentage: string;
  sluggingPercentage: string;
  ops: string;
  obp: string;
  slg: string;
  statsType?: "batting" | "pitching";
  era?: string;
  wins?: number;
  losses?: number;
  saves?: number;
  gamesStarted?: number;
  whip?: string;
}

export interface ResolvedMLBPlayerStats {
  dailyStats: MLBDailyStats;
  seasonStats: MLBSeasonStats;
  source: "boxscore";
}

interface CachedDatePayload {
  cachedAtMs: number;
  statsByPlayerId: Map<string, ResolvedMLBPlayerStats>;
}

interface ScheduleResponse {
  dates?: Array<{
    games?: Array<{
      gamePk: number;
      teams: {
        home: { team: { id?: number; name: string; abbreviation?: string } };
        away: { team: { id?: number; name: string; abbreviation?: string } };
      };
    }>;
  }>;
}

interface BoxStatBatting {
  gamesPlayed?: string | number;
  atBats?: string | number;
  runs?: string | number;
  hits?: string | number;
  homeRuns?: string | number;
  rbi?: string | number;
  baseOnBalls?: string | number;
  strikeOuts?: string | number;
  stolenBases?: string | number;
  avg?: string;
  obp?: string;
  slg?: string;
  ops?: string;
}

interface BoxStatPitching {
  gamesPlayed?: string | number;
  gamesStarted?: string | number;
  inningsPitched?: string;
  earnedRuns?: string | number;
  baseOnBalls?: string | number;
  strikeOuts?: string | number;
  pitchesThrown?: string | number;
  numberOfPitches?: string | number;
  wins?: string | number;
  losses?: string | number;
  saves?: string | number;
  era?: string;
  whip?: string;
}

interface BoxScorePlayerEntry {
  person?: { id?: number; fullName?: string };
  stats?: { batting?: BoxStatBatting; pitching?: BoxStatPitching };
  seasonStats?: { batting?: BoxStatBatting; pitching?: BoxStatPitching };
  position?: { abbreviation?: string };
}

interface BoxScoreTeam {
  team: { id?: number; name: string; abbreviation?: string };
  players?: Record<string, BoxScorePlayerEntry>;
}

interface BoxScoreResponse {
  teams?: { home?: BoxScoreTeam; away?: BoxScoreTeam };
}

const CACHE_TTL_MS = Number(process.env.DAILYIQ_MLB_BOX_CACHE_MS ?? 15 * 60 * 1000);
const cache = new Map<string, CachedDatePayload>();

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toThreeDecimal(value: number): string {
  return value.toFixed(3).replace(/^0/, "");
}

function toRate(value: string | undefined, fallback: number): string {
  if (value && /^\.?\d+$/.test(value)) return value.startsWith(".") ? value : `.${value}`;
  return toThreeDecimal(fallback);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`MLB Stats API failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function buildHitterStats(
  date: string,
  opponentAbbr: string,
  player: BoxScorePlayerEntry,
): ResolvedMLBPlayerStats | null {
  const batting = player.stats?.batting;
  const seasonBatting = player.seasonStats?.batting;
  if (!batting || !seasonBatting) return null;

  const atBats = toNumber(batting.atBats);
  const hits = toNumber(batting.hits);
  const runs = toNumber(batting.runs);
  const homeRuns = toNumber(batting.homeRuns);
  const rbi = toNumber(batting.rbi);
  const walks = toNumber(batting.baseOnBalls);
  const strikeouts = toNumber(batting.strikeOuts);
  const stolenBases = toNumber(batting.stolenBases);

  const seasonAtBats = toNumber(seasonBatting.atBats);
  const seasonHits = toNumber(seasonBatting.hits);

  const blank = ".000";
  return {
    source: "boxscore",
    dailyStats: {
      gameDate: date,
      opponent: opponentAbbr,
      atBats,
      runs,
      hits,
      homeRuns,
      rbi,
      rbis: rbi,
      walks,
      strikeouts,
      stolenBases,
      battingAverage: toRate(batting.avg, hits / Math.max(atBats, 1)),
      ops: toRate(batting.ops, 0.55),
      dailyStatsStatus: atBats > 0 || walks > 0 ? "boxscore" : "boxscore-no-pa",
      statsType: "batting",
    },
    seasonStats: {
      gamesPlayed: toNumber(seasonBatting.gamesPlayed),
      atBats: seasonAtBats,
      runs: toNumber(seasonBatting.runs),
      hits: seasonHits,
      homeRuns: toNumber(seasonBatting.homeRuns),
      rbi: toNumber(seasonBatting.rbi),
      rbis: toNumber(seasonBatting.rbi),
      walks: toNumber(seasonBatting.baseOnBalls),
      strikeouts: toNumber(seasonBatting.strikeOuts),
      stolenBases: toNumber(seasonBatting.stolenBases),
      battingAverage: toRate(seasonBatting.avg, seasonHits / Math.max(seasonAtBats, 1)),
      onBasePercentage: toRate(seasonBatting.obp, 0.3),
      sluggingPercentage: toRate(seasonBatting.slg, 0.4),
      ops: toRate(seasonBatting.ops, 0.7),
      obp: toRate(seasonBatting.obp, 0.3),
      slg: toRate(seasonBatting.slg, 0.4),
      statsType: "batting",
      era: blank,
      wins: 0,
      losses: 0,
      saves: 0,
      gamesStarted: 0,
      whip: blank,
    },
  };
}

function buildPitcherStats(
  date: string,
  opponentAbbr: string,
  player: BoxScorePlayerEntry,
): ResolvedMLBPlayerStats | null {
  const pitching = player.stats?.pitching;
  const seasonPitching = player.seasonStats?.pitching;
  if (!pitching || !seasonPitching) return null;

  const inningsPitched = pitching.inningsPitched ?? "0.0";
  const earnedRuns = toNumber(pitching.earnedRuns);
  const strikeouts = toNumber(pitching.strikeOuts);
  const walks = toNumber(pitching.baseOnBalls);
  const pitchCount = toNumber(pitching.pitchesThrown ?? pitching.numberOfPitches);

  const blank = ".000";
  return {
    source: "boxscore",
    dailyStats: {
      gameDate: date,
      opponent: opponentAbbr,
      atBats: 0,
      runs: 0,
      hits: 0,
      homeRuns: 0,
      rbi: 0,
      rbis: 0,
      walks,
      strikeouts,
      stolenBases: 0,
      battingAverage: blank,
      ops: blank,
      dailyStatsStatus: pitchCount > 0 || strikeouts > 0 ? "boxscore" : "boxscore-no-app",
      statsType: "pitching",
      inningsPitched: String(inningsPitched),
      earnedRuns,
      pitchCount,
    },
    seasonStats: {
      gamesPlayed: toNumber(seasonPitching.gamesPlayed),
      gamesStarted: toNumber(seasonPitching.gamesStarted),
      atBats: 0,
      runs: 0,
      hits: 0,
      homeRuns: 0,
      rbi: 0,
      rbis: 0,
      walks: toNumber(seasonPitching.baseOnBalls),
      strikeouts: toNumber(seasonPitching.strikeOuts),
      stolenBases: 0,
      battingAverage: blank,
      onBasePercentage: blank,
      sluggingPercentage: blank,
      ops: blank,
      obp: blank,
      slg: blank,
      statsType: "pitching",
      era: seasonPitching.era ?? "0.00",
      wins: toNumber(seasonPitching.wins),
      losses: toNumber(seasonPitching.losses),
      saves: toNumber(seasonPitching.saves),
      whip: seasonPitching.whip ?? blank,
    },
  };
}

async function buildStatsMapForDate(
  date: string,
  players: MiLBPlayerProfileLike[],
): Promise<Map<string, ResolvedMLBPlayerStats>> {
  const results = new Map<string, ResolvedMLBPlayerStats>();
  const assignments = await resolveCurrentPlayerAssignments(players);

  // Fetch MLB schedule for the date.
  const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
  const schedule = await fetchJson<ScheduleResponse>(scheduleUrl);
  const games = (schedule.dates ?? []).flatMap((entry) => entry.games ?? []);
  if (games.length === 0) return results;

  // Build a quick playerId -> mlbPersonId index for MLB players in pool.
  const personIdToPoolPlayer = new Map<number, MiLBPlayerProfileLike>();
  for (const p of players) {
    const a = assignments.get(p.playerId);
    if (a?.league === "MLB" && typeof a.mlbPersonId === "number") {
      personIdToPoolPlayer.set(a.mlbPersonId, p);
    }
  }
  if (personIdToPoolPlayer.size === 0) return results;

  for (const game of games) {
    try {
      const box = await fetchJson<BoxScoreResponse>(
        `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`,
      );
      const sides: Array<{ team?: BoxScoreTeam; opponent?: BoxScoreTeam }> = [
        { team: box.teams?.home, opponent: box.teams?.away },
        { team: box.teams?.away, opponent: box.teams?.home },
      ];

      for (const { team, opponent } of sides) {
        if (!team?.players) continue;
        const opponentAbbr = String(opponent?.team.abbreviation ?? opponent?.team.name ?? "TBD");

        for (const entry of Object.values(team.players)) {
          const personId = typeof entry.person?.id === "number" ? entry.person.id : undefined;
          if (personId == null) continue;
          const poolPlayer = personIdToPoolPlayer.get(personId);
          if (!poolPlayer) continue;

          // Prefer pitcher line if pitching stats exist with non-zero IP; else hitter.
          const pitching = entry.stats?.pitching;
          const ip = pitching?.inningsPitched;
          const hasPitched = pitching && ip != null && Number(ip) > 0;
          const resolved = hasPitched
            ? buildPitcherStats(date, opponentAbbr, entry)
            : buildHitterStats(date, opponentAbbr, entry);
          if (resolved) {
            results.set(poolPlayer.playerId, resolved);
          }
        }
      }
    } catch {
      // Skip games that fail to load — keep partial results.
    }
  }

  return results;
}

export async function getMLBBoxScoreStats(
  date: string,
  players: MiLBPlayerProfileLike[],
): Promise<Map<string, ResolvedMLBPlayerStats>> {
  const cached = cache.get(date);
  if (cached && Date.now() - cached.cachedAtMs < CACHE_TTL_MS) {
    return cached.statsByPlayerId;
  }
  try {
    const statsByPlayerId = await buildStatsMapForDate(date, players);
    cache.set(date, { cachedAtMs: Date.now(), statsByPlayerId });
    return statsByPlayerId;
  } catch {
    return new Map();
  }
}
