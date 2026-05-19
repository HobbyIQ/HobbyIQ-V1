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
  // Pitcher-only fields. All optional so the iOS Codable can default to nil.
  inningsPitched?: string;
  earnedRuns?: number;
  pitchCount?: number;
  hitsAllowed?: number;     // boxscore.pitching.hits
  runsAllowed?: number;     // boxscore.pitching.runs
  homeRunsAllowed?: number; // boxscore.pitching.homeRuns
  decision?: "W" | "L" | "SV" | "HLD" | "BS" | null;
  qualityStart?: boolean;
  pitched?: boolean;        // true when IP > 0
  // Two-way (Ohtani-style): hitter line attached to a pitcher day so the
  // iOS row can render both lines stacked under the primary pitcher card.
  secondaryStats?: MLBDailyStats;
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
  runs?: string | number;
  hits?: string | number;
  homeRuns?: string | number;
  baseOnBalls?: string | number;
  strikeOuts?: string | number;
  pitchesThrown?: string | number;
  numberOfPitches?: string | number;
  wins?: string | number;
  losses?: string | number;
  saves?: string | number;
  holds?: string | number;
  blownSaves?: string | number;
  era?: string;
  whip?: string;
  // The MLB API exposes the decision as a parenthetical note string on the
  // player entry (e.g. "(W, 3-1)", "(S, 12)"). We don't get the parsed
  // decision directly — see parsePitcherNote below.
  note?: string;
}

// Decision parsing: the boxscore entry usually carries a `note` field on the
// player itself ("(W, 3-1)"). Some seasons surface it on stats.pitching.note
// instead. We check both.
function parsePitcherNote(
  noteOnEntry: string | undefined,
  noteOnPitching: string | undefined,
): "W" | "L" | "SV" | "HLD" | "BS" | null {
  const haystack = `${noteOnEntry ?? ""} ${noteOnPitching ?? ""}`.toUpperCase();
  if (/\(\s*BS\b/.test(haystack)) return "BS";
  if (/\(\s*W\b/.test(haystack)) return "W";
  if (/\(\s*L\b/.test(haystack)) return "L";
  if (/\(\s*S\b/.test(haystack) || /\(\s*SV\b/.test(haystack)) return "SV";
  if (/\(\s*H\b/.test(haystack) || /\(\s*HLD\b/.test(haystack)) return "HLD";
  return null;
}

interface BoxScorePlayerEntry {
  note?: string;
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
  const hitsAllowed = toNumber(pitching.hits);
  const runsAllowed = toNumber(pitching.runs);
  const homeRunsAllowed = toNumber(pitching.homeRuns);
  const ipDecimal = Number.parseFloat(String(inningsPitched));
  const pitched = Number.isFinite(ipDecimal) && ipDecimal > 0;
  // Quality start: 6+ IP, 3 or fewer ER. Decimal IP "6.0" works directly.
  const qualityStart = pitched && ipDecimal >= 6 && earnedRuns <= 3;
  const decision = parsePitcherNote(player.note, pitching.note);

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
      dailyStatsStatus: pitched ? "boxscore" : "boxscore-no-app",
      statsType: "pitching",
      inningsPitched: String(inningsPitched),
      earnedRuns,
      pitchCount,
      hitsAllowed,
      runsAllowed,
      homeRunsAllowed,
      decision,
      qualityStart,
      pitched,
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

          // Decide which statline to render. Priority order:
          //   1. Pitcher who actually pitched today  -> pitcher line
          //   2. Hitter (or two-way) who had a PA    -> hitter line
          //   3. Pitcher who was on the roster but DNP -> pitcher line w/ pitched=false
          //   4. Anyone else                          -> hitter line (may be blank)
          const pitching = entry.stats?.pitching;
          const batting = entry.stats?.batting;
          const ip = Number.parseFloat(String(pitching?.inningsPitched ?? "0"));
          const hasPitched = pitching && Number.isFinite(ip) && ip > 0;
          const hadAtBat = batting && Number(batting.atBats ?? 0) > 0;
          const pos = String(entry.position?.abbreviation ?? "").toUpperCase();
          const isPitcherPosition = pos === "SP" || pos === "RP" || pos === "P" || pos === "CP" || pos === "CL";
          let resolved: ResolvedMLBPlayerStats | null = null;
          if (hasPitched) {
            // Two-way (Ohtani-style): pitcher line on top, hitter line attached as
            // secondaryStats so the iOS row can render both.
            resolved = buildPitcherStats(date, opponentAbbr, entry);
            if (resolved && hadAtBat) {
              const hitter = buildHitterStats(date, opponentAbbr, entry);
              if (hitter) {
                resolved = {
                  ...resolved,
                  dailyStats: { ...resolved.dailyStats, secondaryStats: hitter.dailyStats },
                } as ResolvedMLBPlayerStats;
              }
            }
          } else if (isPitcherPosition && pitching) {
            // Pitcher on the active roster who didn't take the mound.
            // Build the pitcher line so the UI shows "Did not pitch" instead
            // of an empty 0-for-0 batting card.
            resolved = buildPitcherStats(date, opponentAbbr, entry);
          } else {
            resolved = buildHitterStats(date, opponentAbbr, entry);
          }
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
