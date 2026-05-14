type League = "MLB" | "MiLB";
type MiLBLevel = "Triple-A" | "Double-A" | "High-A" | "Single-A" | "Rookie" | null;

export interface DailyIQDailyStats {
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
}

export interface DailyIQSeasonStats {
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
}

export interface MiLBPlayerProfileLike {
  playerId: string;
  playerName: string;
  level: MiLBLevel;
  teamName: string;
  teamAbbreviation: string;
}

export interface CurrentPlayerAssignment {
  league: League;
  level: MiLBLevel;
  teamName: string;
  teamAbbreviation: string;
  mlbPersonId?: number;
}

export interface ResolvedMiLBPlayerStats {
  dailyStats: DailyIQDailyStats;
  seasonStats: DailyIQSeasonStats;
  source: "boxscore";
}

interface CachedDatePayload {
  cachedAtMs: number;
  statsByPlayerId: Map<string, ResolvedMiLBPlayerStats>;
}

interface ResolvedMiLBAssignment {
  level: Exclude<MiLBLevel, null>;
  teamName: string;
  teamAbbreviation: string;
}

interface SportTeamSummary {
  id: number;
  name: string;
  abbreviation?: string;
}

interface TeamsResponse {
  teams?: SportTeamSummary[];
}

interface SportPlayerSummary {
  id?: number;
  fullName: string;
  currentTeam?: { id?: number };
}

interface SportPlayersResponse {
  people?: SportPlayerSummary[];
}

interface ScheduleResponse {
  dates?: Array<{
    games?: Array<{
      gamePk: number;
      teams: {
        home: { team: { name: string; abbreviation?: string } };
        away: { team: { name: string; abbreviation?: string } };
      };
      status?: { detailedState?: string };
    }>;
  }>;
}

interface BoxScorePlayerEntry {
  person?: { fullName?: string };
  stats?: {
    batting?: {
      atBats?: string | number;
      runs?: string | number;
      hits?: string | number;
      homeRuns?: string | number;
      rbi?: string | number;
      baseOnBalls?: string | number;
      strikeOuts?: string | number;
      stolenBases?: string | number;
      avg?: string;
      ops?: string;
    };
  };
  seasonStats?: {
    batting?: {
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
    };
  };
}

interface BoxScoreTeam {
  team: { name: string; abbreviation?: string };
  players?: Record<string, BoxScorePlayerEntry>;
}

interface BoxScoreResponse {
  teams?: {
    home?: BoxScoreTeam;
    away?: BoxScoreTeam;
  };
}

const SPORT_ID_BY_LEVEL: Record<Exclude<MiLBLevel, null>, number> = {
  "Triple-A": 11,
  "Double-A": 12,
  "High-A": 13,
  "Single-A": 14,
  Rookie: 16,
};

const CACHE_TTL_MS = Number(process.env.DAILYIQ_MILB_BOX_CACHE_MS ?? 15 * 60 * 1000);
const cache = new Map<string, CachedDatePayload>();
const LEVEL_ORDER: Exclude<MiLBLevel, null>[] = ["Triple-A", "Double-A", "High-A", "Single-A", "Rookie"];
let assignmentCache:
  | {
      cachedAtMs: number;
      assignmentsByName: Map<string, CurrentPlayerAssignment>;
    }
  | null = null;

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeTeam(value: string): string {
  return normalizeName(
    value
      .replace(/wilkes-barre/gi, "wb")
      .replace(/northwest/gi, "nw")
      .replace(/saint\.?/gi, "st")
  );
}

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

function matchTeam(profile: MiLBPlayerProfileLike, team: { name: string; abbreviation?: string }): boolean {
  const profileAbbr = profile.teamAbbreviation.trim().toUpperCase();
  const apiAbbr = String(team.abbreviation ?? "").trim().toUpperCase();
  if (profileAbbr && apiAbbr && profileAbbr === apiAbbr) return true;

  const left = normalizeTeam(profile.teamName);
  const right = normalizeTeam(team.name);
  return left === right || left.includes(right) || right.includes(left);
}

function getOpponent(team: BoxScoreTeam | undefined): string {
  return String(team?.team.abbreviation ?? team?.team.name ?? "TBD");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "HobbyIQ/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Stats API request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function getGamesForLevel(date: string, level: Exclude<MiLBLevel, null>): Promise<ScheduleResponse["dates"]> {
  const sportId = SPORT_ID_BY_LEVEL[level];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=${sportId}&date=${date}`;
  const payload = await fetchJson<ScheduleResponse>(url);
  return payload.dates ?? [];
}

async function getAssignmentsByName(): Promise<Map<string, CurrentPlayerAssignment>> {
  if (assignmentCache && Date.now() - assignmentCache.cachedAtMs < CACHE_TTL_MS) {
    return assignmentCache.assignmentsByName;
  }

  const teamsBySport = new Map<number, Map<number, SportTeamSummary>>();
  const sportDefinitions: Array<{ sportId: number; league: League; level: MiLBLevel }> = [
    { sportId: 1, league: "MLB", level: null },
    ...LEVEL_ORDER.map((level) => ({ sportId: SPORT_ID_BY_LEVEL[level], league: "MiLB" as const, level })),
  ];

  for (const definition of sportDefinitions) {
    const teamsPayload = await fetchJson<TeamsResponse>(`https://statsapi.mlb.com/api/v1/teams?sportId=${definition.sportId}&season=2026`);
    teamsBySport.set(definition.sportId, new Map((teamsPayload.teams ?? []).map((team) => [team.id, team])));
  }

  const assignmentsByName = new Map<string, CurrentPlayerAssignment>();

  for (const definition of sportDefinitions) {
    const sportPlayers = await fetchJson<SportPlayersResponse>(`https://statsapi.mlb.com/api/v1/sports/${definition.sportId}/players`);
    const teams = teamsBySport.get(definition.sportId) ?? new Map<number, SportTeamSummary>();

    for (const person of sportPlayers.people ?? []) {
      const key = normalizeName(person.fullName);
      if (!key || assignmentsByName.has(key)) continue;

      const team = typeof person.currentTeam?.id === "number" ? teams.get(person.currentTeam.id) : undefined;
      if (!team?.abbreviation || !team.name) continue;

      assignmentsByName.set(key, {
        league: definition.league,
        level: definition.level,
        teamName: team.name,
        teamAbbreviation: team.abbreviation,
        mlbPersonId: typeof person.id === "number" ? person.id : undefined,
      });
    }
  }

  assignmentCache = { cachedAtMs: Date.now(), assignmentsByName };
  return assignmentsByName;
}

export async function resolveCurrentPlayerAssignments(players: MiLBPlayerProfileLike[]): Promise<Map<string, CurrentPlayerAssignment>> {
  const assignmentsByName = await getAssignmentsByName();
  const assignments = new Map<string, CurrentPlayerAssignment>();

  for (const player of players) {
    const assignment = assignmentsByName.get(normalizeName(player.playerName));
    if (assignment) {
      assignments.set(player.playerId, assignment);
    }
  }

  return assignments;
}

function buildResolvedStats(date: string, player: BoxScorePlayerEntry, playerTeam: BoxScoreTeam | undefined, opponentTeam: BoxScoreTeam | undefined): ResolvedMiLBPlayerStats | null {
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
  const seasonRuns = toNumber(seasonBatting.runs);
  const seasonHomeRuns = toNumber(seasonBatting.homeRuns);
  const seasonRbi = toNumber(seasonBatting.rbi);
  const seasonWalks = toNumber(seasonBatting.baseOnBalls);
  const seasonStrikeouts = toNumber(seasonBatting.strikeOuts);
  const seasonStolenBases = toNumber(seasonBatting.stolenBases);
  const gamesPlayed = toNumber(seasonBatting.gamesPlayed);

  return {
    source: "boxscore",
    dailyStats: {
      gameDate: date,
      opponent: getOpponent(opponentTeam),
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
    },
    seasonStats: {
      gamesPlayed,
      atBats: seasonAtBats,
      runs: seasonRuns,
      hits: seasonHits,
      homeRuns: seasonHomeRuns,
      rbi: seasonRbi,
      rbis: seasonRbi,
      walks: seasonWalks,
      strikeouts: seasonStrikeouts,
      stolenBases: seasonStolenBases,
      battingAverage: toRate(seasonBatting.avg, seasonHits / Math.max(seasonAtBats, 1)),
      onBasePercentage: toRate(seasonBatting.obp, 0.3),
      sluggingPercentage: toRate(seasonBatting.slg, 0.4),
      ops: toRate(seasonBatting.ops, 0.7),
      obp: toRate(seasonBatting.obp, 0.3),
      slg: toRate(seasonBatting.slg, 0.4),
    },
  };
}

async function buildStatsMapForDate(date: string, players: MiLBPlayerProfileLike[]): Promise<Map<string, ResolvedMiLBPlayerStats>> {
  const assignments = await resolveCurrentPlayerAssignments(players);
  const byLevel = new Map<Exclude<MiLBLevel, null>, MiLBPlayerProfileLike[]>();
  for (const player of players) {
    const assignment = assignments.get(player.playerId);
    const level = assignment?.league === "MiLB" ? assignment.level : player.level;
    if (!level) continue;
    const existing = byLevel.get(level) ?? [];
    existing.push({
      ...player,
      level,
      teamName: assignment?.league === "MiLB" ? assignment.teamName : player.teamName,
      teamAbbreviation: assignment?.league === "MiLB" ? assignment.teamAbbreviation : player.teamAbbreviation,
    });
    byLevel.set(level, existing);
  }

  const results = new Map<string, ResolvedMiLBPlayerStats>();

  for (const [level, levelPlayers] of byLevel.entries()) {
    const dates = await getGamesForLevel(date, level);
    const games = (dates ?? []).flatMap((entry) => entry.games ?? []);
    const relevantGames = games.filter((game) => {
      const homeTeam = game.teams.home.team;
      const awayTeam = game.teams.away.team;
      return levelPlayers.some((player) => matchTeam(player, homeTeam) || matchTeam(player, awayTeam));
    });

    for (const game of relevantGames) {
      const boxUrl = `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`;
      const box = await fetchJson<BoxScoreResponse>(boxUrl);
      const home = box.teams?.home;
      const away = box.teams?.away;
      const sides: Array<{ team?: BoxScoreTeam; opponent?: BoxScoreTeam }> = [
        { team: home, opponent: away },
        { team: away, opponent: home },
      ];

      for (const playerProfile of levelPlayers) {
        const side = sides.find(({ team }) => team && matchTeam(playerProfile, team.team));
        if (!side?.team?.players) continue;

        for (const playerEntry of Object.values(side.team.players)) {
          if (normalizeName(playerEntry.person?.fullName ?? "") !== normalizeName(playerProfile.playerName)) continue;
          const resolved = buildResolvedStats(date, playerEntry, side.team, side.opponent);
          if (resolved) {
            results.set(playerProfile.playerId, resolved);
          }
          break;
        }
      }
    }
  }

  return results;
}

export async function getMiLBBoxScoreStats(date: string, players: MiLBPlayerProfileLike[]): Promise<Map<string, ResolvedMiLBPlayerStats>> {
  const cached = cache.get(date);
  if (cached && Date.now() - cached.cachedAtMs < CACHE_TTL_MS) {
    return cached.statsByPlayerId;
  }

  const statsByPlayerId = await buildStatsMapForDate(date, players);
  cache.set(date, { cachedAtMs: Date.now(), statsByPlayerId });
  return statsByPlayerId;
}
