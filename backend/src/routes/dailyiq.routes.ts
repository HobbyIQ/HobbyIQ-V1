import { Request, Response, Router } from "express";
import { getUserBySession } from "../services/authService.js";
import { getMiLBBoxScoreStats, resolveCurrentPlayerAssignments, type ResolvedMiLBPlayerStats } from "../services/dailyiq/milbBoxScoreService.js";
import { getMLBBoxScoreStats, type ResolvedMLBPlayerStats } from "../services/dailyiq/mlbBoxScoreService.js";
import { fetchRecentForm, type RecentForm } from "../services/dailyiq/recentFormService.js";
import { fetchTomorrowProbablePitchers, getTomorrowDateUTC, type TomorrowMatchup } from "../services/dailyiq/probablePitchersService.js";
import {
  getAllWatchCounts,
  getWatchlistEntries,
  getWatchlistSet,
  removeWatchlistEntry,
  upsertWatchlistEntry,
  type WatchlistEntry,
} from "../services/dailyiq/watchlistStore.service.js";
import { getPersistedBriefByDate,
  upsertPersistedBrief,
  type PersistedBriefPayload,
} from "../services/dailyiq/briefStore.service.js";
import { getTopPlayers as cosmosGetTopPlayers } from "../repositories/dailyiq.repository.js";
import { getPlayerScoreByName } from "../services/playerScore/playerScore.service.js";
import { computeFantasyPoints } from "../services/dailyiq/fantasyScoring.service.js";
import {
  computeDailyScore,
  baselineFromSeason,
} from "../services/dailyiq/dailyScore.service.js";
import { computeMovement } from "../services/dailyiq/movement.service.js";
import { getMarketDeltasForPlayers } from "../services/dailyiq/marketDelta.service.js";
import { searchMlbPerson, levelFromSport } from "../services/playerScore/mlbStats.service.js";

type PlayerIQEnrichment = {
  playerIQScore: number | null;
  playerIQDirection: "rising" | "falling" | "stable" | null;
  playerIQLabel: string | null;
};

/**
 * Enrich a list of players with PlayerIQ scores in parallel. Every lookup is
 * isolated in its own try/catch so a single failed read never blocks the
 * DailyIQ response — missing scores fall through as null fields.
 */
async function enrichWithPlayerIQ<T extends { playerName: string }>(
  players: T[],
): Promise<Array<T & PlayerIQEnrichment>> {
  return Promise.all(
    players.map(async (p): Promise<T & PlayerIQEnrichment> => {
      try {
        const score = await getPlayerScoreByName(p.playerName);
        if (!score) {
          return { ...p, playerIQScore: null, playerIQDirection: null, playerIQLabel: null };
        }
        return {
          ...p,
          playerIQScore: score.playerIQScore,
          playerIQDirection: score.playerIQDirection,
          playerIQLabel: score.playerIQLabel,
        };
      } catch {
        return { ...p, playerIQScore: null, playerIQDirection: null, playerIQLabel: null };
      }
    }),
  );
}

type League = "MLB" | "MiLB";
type MiLBLevel = "Triple-A" | "Double-A" | "High-A" | "Single-A" | "Rookie" | null;

interface PlayerProfile {
  playerId: string;
  playerName: string;
  league: League;
  level: MiLBLevel;
  teamName: string;
  teamAbbreviation: string;
  position: string;
  isActive: boolean;
}

interface PlayerDailyStats {
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
  // pitcher-only fields
  statsType?: 'batting' | 'pitching';
  inningsPitched?: string;
  earnedRuns?: number;
  pitchCount?: number;
  hitsAllowed?: number;
  runsAllowed?: number;
  homeRunsAllowed?: number;
  decision?: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
  qualityStart?: boolean;
  pitched?: boolean;
  // two-way (Ohtani-style) hitter line attached to pitcher day
  secondaryStats?: PlayerDailyStats;
}

interface PlayerSeasonStats {
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
  // pitcher-only fields
  statsType?: 'batting' | 'pitching';
  era?: string;
  wins?: number;
  losses?: number;
  saves?: number;
  gamesStarted?: number;
  whip?: string;
  inningsPitched?: string;
}

interface BasePlayerResponse {
  playerId: string;
  rank: number;
  rankingScore: number;
  /** DraftKings-style fantasy points for the day. Null when the player didn't play. */
  fantasyPoints: number | null;
  /** DailyIQ score — product-defined daily impact score (weighted by HR, K, IP, decision, etc). */
  dailyScore: number;
  /** Movement badge derived from dailyScore vs rolling baseline + optional market comp delta. */
  movement?: PlayerMovement | null;
  league: League;
  level: MiLBLevel;
  playerName: string;
  team: string;
  teamName: string;
  teamAbbreviation: string;
  position: string;
  dailyStats: PlayerDailyStats;
  seasonStats: PlayerSeasonStats;
  lastUpdated: string;
}

interface PlayerMovement {
  direction: 'up' | 'down' | 'neutral';
  label: string;
  reason: string;
  performanceDelta: number;       // (score - baseline) / max(baseline, 1)
  marketDelta?: {
    pct1d: number;
    pct7d: number;
    pct30d: number;
    avg30dPrice?: number;
    sampleCount?: number;
  } | null;
}

interface PlayerResponse extends BasePlayerResponse {
  isOnWatchlist: boolean;
}

type MiLBLevelKey = "Triple-A" | "Double-A" | "High-A" | "Single-A" | "Rookie";
type ByLevelMap = Partial<Record<MiLBLevelKey, BasePlayerResponse[]>>;

interface BriefCache {
  date: string;
  generatedAt: string;
  mlb: BasePlayerResponse[];
  milb: BasePlayerResponse[];
  /** Top players bucketed by MiLB level (top 5 each). MLB sits in `mlb`. */
  byLevel?: ByLevelMap;
  cachedAtMs: number;
}

const router = Router();

const PLAYER_POOL: PlayerProfile[] = [
  // ── MLB (50) ──────────────────────────────────────────────────────────────
  { playerId: "shohei-ohtani",        playerName: "Shohei Ohtani",         league: "MLB", level: null, teamName: "Los Angeles Dodgers",    teamAbbreviation: "LAD", position: "DH",  isActive: true },
  { playerId: "paul-skenes",          playerName: "Paul Skenes",           league: "MLB", level: null, teamName: "Pittsburgh Pirates",      teamAbbreviation: "PIT", position: "SP",  isActive: true },
  { playerId: "jackson-chourio",      playerName: "Jackson Chourio",       league: "MLB", level: null, teamName: "Milwaukee Brewers",       teamAbbreviation: "MIL", position: "OF",  isActive: true },
  { playerId: "junior-caminero",      playerName: "Junior Caminero",       league: "MLB", level: null, teamName: "Tampa Bay Rays",          teamAbbreviation: "TB",  position: "3B",  isActive: true },
  { playerId: "gunnar-henderson",     playerName: "Gunnar Henderson",      league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "SS",  isActive: true },
  { playerId: "elly-de-la-cruz",      playerName: "Elly De La Cruz",       league: "MLB", level: null, teamName: "Cincinnati Reds",         teamAbbreviation: "CIN", position: "SS",  isActive: true },
  { playerId: "victor-scott-ii",      playerName: "Victor Scott II",       league: "MLB", level: null, teamName: "St. Louis Cardinals",     teamAbbreviation: "STL", position: "OF",  isActive: true },
  { playerId: "dylan-crews",          playerName: "Dylan Crews",           league: "MLB", level: null, teamName: "Washington Nationals",    teamAbbreviation: "WSH", position: "OF",  isActive: true },
  { playerId: "wyatt-langford",       playerName: "Wyatt Langford",        league: "MLB", level: null, teamName: "Texas Rangers",           teamAbbreviation: "TEX", position: "OF",  isActive: true },
  { playerId: "yoshinobu-yamamoto",   playerName: "Yoshinobu Yamamoto",    league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "SP",  isActive: true },
  { playerId: "colton-cowser",        playerName: "Colton Cowser",         league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "OF",  isActive: true },
  { playerId: "jackson-holliday",     playerName: "Jackson Holliday",      league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "2B",  isActive: true },
  { playerId: "jacob-wilson",         playerName: "Jacob Wilson",          league: "MLB", level: null, teamName: "Athletics",               teamAbbreviation: "OAK", position: "SS",  isActive: true },
  { playerId: "cal-raleigh",          playerName: "Cal Raleigh",           league: "MLB", level: null, teamName: "Seattle Mariners",        teamAbbreviation: "SEA", position: "C",   isActive: true },
  { playerId: "brice-turang",         playerName: "Brice Turang",          league: "MLB", level: null, teamName: "Milwaukee Brewers",       teamAbbreviation: "MIL", position: "2B",  isActive: true },
  { playerId: "roki-sasaki",          playerName: "Roki Sasaki",           league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "SP",  isActive: true },
  { playerId: "kyle-stowers",         playerName: "Kyle Stowers",          league: "MLB", level: null, teamName: "Miami Marlins",           teamAbbreviation: "MIA", position: "OF",  isActive: true },
  { playerId: "aaron-judge",          playerName: "Aaron Judge",           league: "MLB", level: null, teamName: "New York Yankees",        teamAbbreviation: "NYY", position: "OF",  isActive: true },
  { playerId: "juan-soto",            playerName: "Juan Soto",             league: "MLB", level: null, teamName: "New York Mets",           teamAbbreviation: "NYM", position: "OF",  isActive: true },
  { playerId: "mookie-betts",         playerName: "Mookie Betts",          league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "OF",  isActive: true },
  { playerId: "freddie-freeman",      playerName: "Freddie Freeman",       league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "1B",  isActive: true },
  { playerId: "fernando-tatis-jr",    playerName: "Fernando Tatis Jr.",    league: "MLB", level: null, teamName: "San Diego Padres",        teamAbbreviation: "SD",  position: "OF",  isActive: true },
  { playerId: "ronald-acuna-jr",      playerName: "Ronald Acuña Jr.",      league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "OF",  isActive: true },
  { playerId: "bryce-harper",         playerName: "Bryce Harper",          league: "MLB", level: null, teamName: "Philadelphia Phillies",   teamAbbreviation: "PHI", position: "1B",  isActive: true },
  { playerId: "trea-turner",          playerName: "Trea Turner",           league: "MLB", level: null, teamName: "Philadelphia Phillies",   teamAbbreviation: "PHI", position: "SS",  isActive: true },
  { playerId: "francisco-lindor",     playerName: "Francisco Lindor",      league: "MLB", level: null, teamName: "New York Mets",           teamAbbreviation: "NYM", position: "SS",  isActive: true },
  { playerId: "pete-alonso",          playerName: "Pete Alonso",           league: "MLB", level: null, teamName: "New York Mets",           teamAbbreviation: "NYM", position: "1B",  isActive: true },
  { playerId: "bobby-witt-jr",        playerName: "Bobby Witt Jr.",        league: "MLB", level: null, teamName: "Kansas City Royals",      teamAbbreviation: "KC",  position: "SS",  isActive: true },
  { playerId: "julio-rodriguez",      playerName: "Julio Rodríguez",       league: "MLB", level: null, teamName: "Seattle Mariners",        teamAbbreviation: "SEA", position: "OF",  isActive: true },
  { playerId: "yordan-alvarez",       playerName: "Yordan Alvarez",        league: "MLB", level: null, teamName: "Houston Astros",          teamAbbreviation: "HOU", position: "DH",  isActive: true },
  { playerId: "corey-seager",         playerName: "Corey Seager",          league: "MLB", level: null, teamName: "Texas Rangers",           teamAbbreviation: "TEX", position: "SS",  isActive: true },
  { playerId: "adley-rutschman",      playerName: "Adley Rutschman",       league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "C",   isActive: true },
  { playerId: "vladimir-guerrero-jr", playerName: "Vladimir Guerrero Jr.", league: "MLB", level: null, teamName: "Toronto Blue Jays",       teamAbbreviation: "TOR", position: "1B",  isActive: true },
  { playerId: "bo-bichette",          playerName: "Bo Bichette",           league: "MLB", level: null, teamName: "Toronto Blue Jays",       teamAbbreviation: "TOR", position: "SS",  isActive: true },
  { playerId: "matt-olson",           playerName: "Matt Olson",            league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "1B",  isActive: true },
  { playerId: "ozzie-albies",         playerName: "Ozzie Albies",          league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "2B",  isActive: true },
  { playerId: "corbin-carroll",       playerName: "Corbin Carroll",        league: "MLB", level: null, teamName: "Arizona Diamondbacks",    teamAbbreviation: "ARI", position: "OF",  isActive: true },
  { playerId: "ketel-marte",          playerName: "Ketel Marte",           league: "MLB", level: null, teamName: "Arizona Diamondbacks",    teamAbbreviation: "ARI", position: "2B",  isActive: true },
  { playerId: "spencer-strider",      playerName: "Spencer Strider",       league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "SP",  isActive: true },
  { playerId: "zack-wheeler",         playerName: "Zack Wheeler",          league: "MLB", level: null, teamName: "Philadelphia Phillies",   teamAbbreviation: "PHI", position: "SP",  isActive: true },
  { playerId: "gerrit-cole",          playerName: "Gerrit Cole",           league: "MLB", level: null, teamName: "New York Yankees",        teamAbbreviation: "NYY", position: "SP",  isActive: true },
  { playerId: "max-fried",            playerName: "Max Fried",             league: "MLB", level: null, teamName: "New York Yankees",        teamAbbreviation: "NYY", position: "SP",  isActive: true },
  { playerId: "willy-adames",         playerName: "Willy Adames",          league: "MLB", level: null, teamName: "San Francisco Giants",    teamAbbreviation: "SF",  position: "SS",  isActive: true },
  { playerId: "rafael-devers",        playerName: "Rafael Devers",         league: "MLB", level: null, teamName: "Boston Red Sox",          teamAbbreviation: "BOS", position: "3B",  isActive: true },
  { playerId: "nolan-arenado",        playerName: "Nolan Arenado",         league: "MLB", level: null, teamName: "St. Louis Cardinals",     teamAbbreviation: "STL", position: "3B",  isActive: true },
  { playerId: "marcus-semien",        playerName: "Marcus Semien",         league: "MLB", level: null, teamName: "Texas Rangers",           teamAbbreviation: "TEX", position: "2B",  isActive: true },
  { playerId: "kyle-tucker",          playerName: "Kyle Tucker",           league: "MLB", level: null, teamName: "Chicago Cubs",            teamAbbreviation: "CHC", position: "OF",  isActive: true },
  { playerId: "jose-altuve",          playerName: "José Altuve",           league: "MLB", level: null, teamName: "Houston Astros",          teamAbbreviation: "HOU", position: "2B",  isActive: true },
  { playerId: "austin-riley",         playerName: "Austin Riley",          league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "3B",  isActive: true },
  { playerId: "michael-harris-ii",    playerName: "Michael Harris II",     league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "OF",  isActive: true },
  { playerId: "james-wood",           playerName: "James Wood",            league: "MLB", level: null, teamName: "Washington Nationals",    teamAbbreviation: "WSH", position: "OF",  isActive: true },
  // 2026 call-ups (confirmed active MLB rosters as of May 2026):
  { playerId: "marcelo-mayer",        playerName: "Marcelo Mayer",         league: "MLB", level: null, teamName: "Boston Red Sox",           teamAbbreviation: "BOS", position: "SS",  isActive: true },
  { playerId: "chase-dollander",      playerName: "Chase Dollander",       league: "MLB", level: null, teamName: "Colorado Rockies",         teamAbbreviation: "COL", position: "SP",  isActive: true },
  { playerId: "brady-house",          playerName: "Brady House",           league: "MLB", level: null, teamName: "Washington Nationals",     teamAbbreviation: "WSH", position: "SS",  isActive: true },
  { playerId: "jace-jung",            playerName: "Jace Jung",             league: "MLB", level: null, teamName: "Detroit Tigers",           teamAbbreviation: "DET", position: "2B",  isActive: true },
  { playerId: "noah-schultz",         playerName: "Noah Schultz",          league: "MLB", level: null, teamName: "Chicago White Sox",        teamAbbreviation: "CWS", position: "SP",  isActive: true },
  { playerId: "bubba-chandler",       playerName: "Bubba Chandler",        league: "MLB", level: null, teamName: "Pittsburgh Pirates",       teamAbbreviation: "PIT", position: "SP",  isActive: true },
  { playerId: "konnor-griffin",       playerName: "Konnor Griffin",        league: "MLB", level: null, teamName: "St. Louis Cardinals",      teamAbbreviation: "STL", position: "SS",  isActive: true },
  { playerId: "bryce-eldridge",       playerName: "Bryce Eldridge",        league: "MLB", level: null, teamName: "San Francisco Giants",     teamAbbreviation: "SF",  position: "1B",  isActive: true },
  { playerId: "rhett-lowder",         playerName: "Rhett Lowder",          league: "MLB", level: null, teamName: "Cincinnati Reds",          teamAbbreviation: "CIN", position: "SP",  isActive: true },
  { playerId: "chase-meidroth",       playerName: "Chase Meidroth",        league: "MLB", level: null, teamName: "Boston Red Sox",           teamAbbreviation: "BOS", position: "2B",  isActive: true },
  { playerId: "jac-caglianone",       playerName: "Jac Caglianone",        league: "MLB", level: null, teamName: "Kansas City Royals",       teamAbbreviation: "KC",  position: "1B",  isActive: true },
  { playerId: "christian-scott",      playerName: "Christian Scott",       league: "MLB", level: null, teamName: "New York Mets",            teamAbbreviation: "NYM", position: "SP",  isActive: true },
  // ── MiLB ──────────────────────────────────────────────────────────────────
  // NOTE: Verify uncertain call-up status periodically:
  //   ricky-tiedemann (TOR – back surgery 2025, may still be rehabbing)
  //   jackson-jobe     (DET – top pitching prospect, may have debuted)
  //   andrew-painter   (PHI – Tommy John 2023, confirm current level)
  // Triple-A
  { playerId: "spencer-jones",        playerName: "Spencer Jones",         league: "MiLB", level: "Triple-A",  teamName: "Scranton/WB RailRiders",  teamAbbreviation: "SWB", position: "OF",  isActive: true },
  { playerId: "ethan-salas",          playerName: "Ethan Salas",           league: "MiLB", level: "Triple-A",  teamName: "El Paso Chihuahuas",       teamAbbreviation: "ELP", position: "C",   isActive: true },
  { playerId: "jackson-jobe",         playerName: "Jackson Jobe",          league: "MiLB", level: "Triple-A",  teamName: "Toledo Mud Hens",          teamAbbreviation: "TOL", position: "SP",  isActive: true },
  { playerId: "andrew-painter",       playerName: "Andrew Painter",        league: "MiLB", level: "Triple-A",  teamName: "Lehigh Valley IronPigs",   teamAbbreviation: "LHV", position: "SP",  isActive: true },
  { playerId: "marco-luciano",        playerName: "Marco Luciano",         league: "MiLB", level: "Triple-A",  teamName: "Sacramento River Cats",    teamAbbreviation: "SAC", position: "SS",  isActive: true },
  { playerId: "termarr-johnson",      playerName: "Termarr Johnson",       league: "MiLB", level: "Triple-A",  teamName: "Indianapolis Indians",     teamAbbreviation: "IND", position: "2B",  isActive: true },
  { playerId: "elijah-green",         playerName: "Elijah Green",          league: "MiLB", level: "Triple-A",  teamName: "Rochester Red Wings",      teamAbbreviation: "ROC", position: "OF",  isActive: true },
  { playerId: "emerson-hancock",      playerName: "Emerson Hancock",       league: "MiLB", level: "Triple-A",  teamName: "Tacoma Rainiers",          teamAbbreviation: "TAC", position: "SP",  isActive: true },
  { playerId: "ricky-tiedemann",      playerName: "Ricky Tiedemann",       league: "MiLB", level: "Triple-A",  teamName: "Buffalo Bisons",           teamAbbreviation: "BUF", position: "SP",  isActive: true },
  { playerId: "harry-ford",           playerName: "Harry Ford",            league: "MiLB", level: "Triple-A",  teamName: "Tacoma Rainiers",          teamAbbreviation: "TAC", position: "C",   isActive: true },
  { playerId: "kyle-teel",            playerName: "Kyle Teel",             league: "MiLB", level: "Triple-A",  teamName: "Worcester Red Sox",        teamAbbreviation: "WOR", position: "C",   isActive: true },
  { playerId: "emmanuel-rodriguez",   playerName: "Emmanuel Rodriguez",    league: "MiLB", level: "Triple-A",  teamName: "St. Paul Saints",          teamAbbreviation: "STP", position: "OF",  isActive: true },
  // Double-A
  { playerId: "hagen-smith",          playerName: "Hagen Smith",           league: "MiLB", level: "Double-A",  teamName: "Midland RockHounds",       teamAbbreviation: "MID", position: "SP",  isActive: true },
  { playerId: "noble-meyer",          playerName: "Noble Meyer",           league: "MiLB", level: "Double-A",  teamName: "Biloxi Shuckers",          teamAbbreviation: "BLX", position: "SP",  isActive: true },
  { playerId: "max-clark",            playerName: "Max Clark",             league: "MiLB", level: "Double-A",  teamName: "Erie SeaWolves",           teamAbbreviation: "ERI", position: "OF",  isActive: true },
  { playerId: "cam-collier",          playerName: "Cam Collier",           league: "MiLB", level: "Double-A",  teamName: "Chattanooga Lookouts",     teamAbbreviation: "CHA", position: "3B",  isActive: true },
  { playerId: "cole-carrigg",         playerName: "Cole Carrigg",          league: "MiLB", level: "Double-A",  teamName: "Arkansas Travelers",       teamAbbreviation: "ARK", position: "OF",  isActive: true },
  { playerId: "kevin-mcgonigle",      playerName: "Kevin McGonigle",       league: "MiLB", level: "Double-A",  teamName: "Mississippi Braves",       teamAbbreviation: "MIS", position: "SS",  isActive: true },
  { playerId: "blake-mitchell",       playerName: "Blake Mitchell",        league: "MiLB", level: "Double-A",  teamName: "NW Arkansas Naturals",     teamAbbreviation: "NWA", position: "C",   isActive: true },
  { playerId: "jurrangelo-cijntje",   playerName: "Jurrangelo Cijntje",    league: "MiLB", level: "Double-A",  teamName: "Birmingham Barons",        teamAbbreviation: "BIR", position: "SP",  isActive: true },
  { playerId: "yohandy-morales",      playerName: "Yohandy Morales",       league: "MiLB", level: "Double-A",  teamName: "Pensacola Blue Wahoos",    teamAbbreviation: "PNS", position: "3B",  isActive: true },
  { playerId: "xavier-isaac",         playerName: "Xavier Isaac",          league: "MiLB", level: "Double-A",  teamName: "Montgomery Biscuits",      teamAbbreviation: "MTG", position: "1B",  isActive: true },
  { playerId: "thomas-harrington",    playerName: "Thomas Harrington",     league: "MiLB", level: "Double-A",  teamName: "Altoona Curve",            teamAbbreviation: "ALT", position: "SP",  isActive: true },
  { playerId: "jett-williams",        playerName: "Jett Williams",         league: "MiLB", level: "Double-A",  teamName: "Binghamton Rumble Ponies", teamAbbreviation: "BIN", position: "SS",  isActive: true },
  // High-A
  { playerId: "tommy-troy",           playerName: "Tommy Troy",            league: "MiLB", level: "High-A",    teamName: "Asheville Tourists",       teamAbbreviation: "ASH", position: "SS",  isActive: true },
  { playerId: "aidan-miller",         playerName: "Aidan Miller",          league: "MiLB", level: "High-A",    teamName: "Jersey Shore BlueClaws",   teamAbbreviation: "JS",  position: "SS",  isActive: true },
  { playerId: "dillon-head",          playerName: "Dillon Head",           league: "MiLB", level: "High-A",    teamName: "Winston-Salem Dash",       teamAbbreviation: "WS",  position: "OF",  isActive: true },
  { playerId: "colt-emerson",         playerName: "Colt Emerson",          league: "MiLB", level: "High-A",    teamName: "Everett AquaSox",          teamAbbreviation: "EVE", position: "SS",  isActive: true },
  { playerId: "brayden-taylor",       playerName: "Brayden Taylor",        league: "MiLB", level: "High-A",    teamName: "Vancouver Canadians",      teamAbbreviation: "VAN", position: "3B",  isActive: true },
  { playerId: "jarlin-susana",        playerName: "Jarlin Susana",         league: "MiLB", level: "High-A",    teamName: "Fredericksburg Nationals", teamAbbreviation: "FBG", position: "SP",  isActive: true },
  { playerId: "chase-davis",          playerName: "Chase Davis",           league: "MiLB", level: "High-A",    teamName: "Peoria Chiefs",            teamAbbreviation: "PEO", position: "OF",  isActive: true },
  { playerId: "porter-brown",         playerName: "Porter Brown",          league: "MiLB", level: "High-A",    teamName: "Bradenton Marauders",      teamAbbreviation: "BRD", position: "OF",  isActive: true },
  { playerId: "braden-montgomery",    playerName: "Braden Montgomery",     league: "MiLB", level: "High-A",    teamName: "Tri-City Dust Devils",     teamAbbreviation: "TRI", position: "OF",  isActive: true },
  { playerId: "enrique-bradfield-jr", playerName: "Enrique Bradfield Jr.", league: "MiLB", level: "High-A",    teamName: "Bowie Baysox",             teamAbbreviation: "BOW", position: "OF",  isActive: true },
  // Single-A (Low-A)
  { playerId: "sebastian-walcott",    playerName: "Sebastian Walcott",     league: "MiLB", level: "Single-A",  teamName: "Down East Wood Ducks",     teamAbbreviation: "DE",  position: "SS",  isActive: true },
  { playerId: "arjun-nimmala",        playerName: "Arjun Nimmala",         league: "MiLB", level: "Single-A",  teamName: "Dunedin Blue Jays",        teamAbbreviation: "DUN", position: "SS",  isActive: true },
  { playerId: "hyun-seok-hong",       playerName: "Hyun-Seok Hong",        league: "MiLB", level: "Single-A",  teamName: "Clearwater Threshers",     teamAbbreviation: "CLW", position: "OF",  isActive: true },
  { playerId: "charlee-soto",         playerName: "Charlee Soto",          league: "MiLB", level: "Single-A",  teamName: "Clearwater Threshers",     teamAbbreviation: "CLW", position: "SP",  isActive: true },
  { playerId: "bryan-acuna",          playerName: "Bryan Acuña",           league: "MiLB", level: "Single-A",  teamName: "Fort Myers Mighty Mussels", teamAbbreviation: "FTM", position: "SS",  isActive: true },
  { playerId: "bruin-agbayani",       playerName: "Bruin Agbayani",        league: "MiLB", level: "Single-A",  teamName: "Fort Myers Mighty Mussels", teamAbbreviation: "FTM", position: "SS",  isActive: true },
  { playerId: "starlin-aguilar",      playerName: "Starlin Aguilar",       league: "MiLB", level: "Single-A",  teamName: "Inland Empire 66ers",      teamAbbreviation: "IE",  position: "2B",  isActive: true },
  { playerId: "slate-alford",         playerName: "Slate Alford",          league: "MiLB", level: "Single-A",  teamName: "Rancho Cucamonga Quakes",  teamAbbreviation: "RC",  position: "3B",  isActive: true },
  { playerId: "luis-almeyda",         playerName: "Luis Almeyda",          league: "MiLB", level: "Single-A",  teamName: "Delmarva Shorebirds",      teamAbbreviation: "DEL", position: "SS",  isActive: true },
  { playerId: "jeremy-almonte",       playerName: "Jeremy Almonte",        league: "MiLB", level: "Single-A",  teamName: "Jupiter Hammerheads",      teamAbbreviation: "JUP", position: "C",   isActive: true },
  { playerId: "leo-de-vries",         playerName: "Leo De Vries",          league: "MiLB", level: "Single-A",  teamName: "Lake Elsinore Storm",       teamAbbreviation: "LE",  position: "SS",  isActive: true },
  // FCL – Florida Complex League (Rookie)
  { playerId: "george-lombard-jr",    playerName: "George Lombard Jr.",    league: "MiLB", level: "Rookie",    teamName: "FCL Dodgers",              teamAbbreviation: "FCL", position: "OF",  isActive: true },
  { playerId: "angel-abreu",          playerName: "Angel Abreu",           league: "MiLB", level: "Rookie",    teamName: "ACL Guardians",            teamAbbreviation: "A-GUA", position: "SS",  isActive: true },
  { playerId: "agustin-acosta",       playerName: "Agustin Acosta",        league: "MiLB", level: "Rookie",    teamName: "ACL Dodgers",              teamAbbreviation: "A-DOD", position: "CF",  isActive: true },
  { playerId: "victor-acosta",        playerName: "Victor Acosta",         league: "MiLB", level: "Rookie",    teamName: "ACL Reds",                 teamAbbreviation: "A-RED", position: "SS",  isActive: true },
  { playerId: "moises-acacio",        playerName: "Moises Acacio",         league: "MiLB", level: "Rookie",    teamName: "DSL LAD Mega",             teamAbbreviation: "D-LAM", position: "SS",  isActive: true },
  { playerId: "julio-acosta",         playerName: "Julio Acosta",          league: "MiLB", level: "Rookie",    teamName: "DSL Cubs Blue",            teamAbbreviation: "D-CUB", position: "SS",  isActive: true },
];

const OPPONENTS: Record<League, string[]> = {
  MLB: ["ATL", "CHC", "CLE", "DET", "HOU", "NYY", "PHI", "SD", "SEA", "SF"],
  MiLB: ["BUF", "DUR", "JAX", "LHV", "LOU", "MEM", "NSH", "RIC", "TOL", "WOR"],
};

const BRIEF_BACKGROUND_REFRESH_MS = Number(process.env.DAILYIQ_BACKGROUND_REFRESH_MS ?? 300000);
// Per-date in-memory cache. Previously this was a single slot which clobbered
// itself whenever requests for different dates arrived (e.g. iOS picker on
// yesterday vs -3d). LRU-bounded to 14 entries so two weeks of date browsing
// stays warm without unbounded growth.
const BRIEF_CACHE_MAX_ENTRIES = 14;
const _briefCacheByDate = new Map<string, BriefCache>();
const _briefRefreshByDate = new Map<string, Promise<void>>();

function setBriefCache(date: string, value: BriefCache): void {
  // Re-insert to move to end (Map preserves insertion order = LRU MRU at end).
  _briefCacheByDate.delete(date);
  _briefCacheByDate.set(date, value);
  while (_briefCacheByDate.size > BRIEF_CACHE_MAX_ENTRIES) {
    const oldestKey = _briefCacheByDate.keys().next().value;
    if (oldestKey === undefined) break;
    _briefCacheByDate.delete(oldestKey);
  }
}

function getBriefCache(date: string): BriefCache | null {
  const hit = _briefCacheByDate.get(date);
  if (!hit) return null;
  // Touch to refresh MRU position.
  _briefCacheByDate.delete(date);
  _briefCacheByDate.set(date, hit);
  return hit;
}

let _mlbSeasonStatsCache: { data: Map<string, PlayerSeasonStats>; season: number; cachedAtMs: number } | null = null;
const MLB_SEASON_STATS_TTL_MS = 3_600_000; // 1 hour

type PlayerStatsOverride = {
  dailyStats: PlayerDailyStats;
  seasonStats: PlayerSeasonStats;
};

function stableHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function toThreeDecimal(value: number): string {
  return value.toFixed(3).replace(/^0/, "");
}

function inningsToDecimal(inningsPitched?: string): number {
  if (!inningsPitched) return 0;
  const match = inningsPitched.trim().match(/^(\d+)(?:\.(\d))?$/);
  if (!match) return 0;
  const fullInnings = Number(match[1]);
  const outs = Math.min(2, Math.max(0, Number(match[2] ?? "0")));
  return fullInnings + outs / 3;
}

function clampLimit(rawLimit: unknown): number {
  const parsed = Number(rawLimit ?? 50);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(Math.floor(parsed), 50);
}

// DailyIQ defaults to the previous calendar day in America/Los_Angeles
// because the brief reports completed MLB / MiLB box scores. Today's games
// have not been played yet when the brief is first generated at 06:00 PT,
// so anchoring to "today" produces an empty board.
function defaultBriefDate(): string {
  const tz = process.env.DAILYIQ_JOB_TIMEZONE ?? "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function normalizeDate(rawDate: unknown): string {
  if (typeof rawDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return defaultBriefDate();
  return rawDate;
}

function getRequestedMiLBLevel(rawLevel: unknown): MiLBLevel | "All" {
  if (typeof rawLevel !== "string" || rawLevel.trim().length === 0) return "All";
  const normalized = rawLevel.trim().toLowerCase();
  if (normalized === "all") return "All";
  if (normalized === "triple-a") return "Triple-A";
  if (normalized === "double-a") return "Double-A";
  if (normalized === "high-a") return "High-A";
  if (normalized === "single-a") return "Single-A";
  if (normalized === "rookie") return "Rookie";
  return "All";
}

function getOpponent(profile: PlayerProfile, date: string): string {
  const opponents = OPPONENTS[profile.league];
  return opponents[stableHash(`${profile.playerId}:${date}:opp`) % opponents.length];
}

const PITCHER_POSITIONS = ["SP", "RP", "CL", "CP", "P", "TWP"];

function buildDailyStats(profile: PlayerProfile, date: string): PlayerDailyStats {
  const seed = stableHash(`${profile.playerId}:${date}:daily`);
  const opponent = getOpponent(profile, date);

  if (PITCHER_POSITIONS.includes(profile.position)) {
    const fullInnings = 1 + (seed % 7); // 1–7 full innings
    const partialOuts = (seed >> 3) % 3; // 0–2 partial outs
    const inningsPitched = partialOuts === 0 ? `${fullInnings}.0` : `${fullInnings}.${partialOuts}`;
    const strikeouts = 1 + (seed >> 4) % 9;
    const walks = (seed >> 6) % 4;
    const earnedRuns = (seed >> 8) % 5;
    const pitchCount = 15 * fullInnings + 3 * strikeouts + 4 * walks + ((seed >> 10) % 10);
    return {
      gameDate: date,
      opponent,
      atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0, stolenBases: 0,
      battingAverage: ".000",
      ops: ".000",
      dailyStatsStatus: "available",
      statsType: "pitching",
      strikeouts,
      walks,
      inningsPitched,
      earnedRuns,
      pitchCount,
    };
  }

  const atBats = 3 + (seed % 3);
  const hits = Math.min(atBats, 1 + ((seed >> 2) % atBats));
  const walks = (seed >> 4) % 2;
  const strikeouts = (seed >> 5) % 3;
  const homeRuns = hits > 1 && (seed >> 6) % 4 === 0 ? 1 : 0;
  const runs = Math.min(hits + walks, 1 + ((seed >> 7) % 3));
  const rbi = Math.min(5, hits + homeRuns + ((seed >> 8) % 2));
  const stolenBases = ["OF", "SS", "2B"].includes(profile.position) ? (seed >> 9) % 2 : 0;
  return {
    gameDate: date,
    opponent,
    atBats,
    runs,
    hits,
    homeRuns,
    rbi,
    rbis: rbi,
    walks,
    strikeouts,
    stolenBases,
    battingAverage: toThreeDecimal(hits / Math.max(atBats, 1)),
    ops: toThreeDecimal(0.55 + ((seed >> 10) % 650) / 1000),
    dailyStatsStatus: "available",
    statsType: "batting",
  };
}

async function fetchMLBSeasonStatsForPool(profiles: PlayerProfile[]): Promise<void> {
  const season = new Date().getFullYear();
  if (_mlbSeasonStatsCache && _mlbSeasonStatsCache.season === season && Date.now() - _mlbSeasonStatsCache.cachedAtMs < MLB_SEASON_STATS_TTL_MS) return;

  try {
    const base = `https://statsapi.mlb.com/api/v1/stats?stats=season&playerPool=All&gameType=R&season=${season}&sportId=1`;
    const headers = { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" };
    const signal = AbortSignal.timeout(8000);
    const [hittingRes, pitchingRes] = await Promise.all([
      fetch(`${base}&group=hitting`, { headers, signal }),
      fetch(`${base}&group=pitching`, { headers, signal }),
    ]);

    type HittingSplit = { player?: { fullName?: string }; stat?: { gamesPlayed?: number; atBats?: number; runs?: number; hits?: number; homeRuns?: number; rbi?: number; baseOnBalls?: number; strikeOuts?: number; stolenBases?: number; avg?: string; obp?: string; slg?: string; ops?: string } };
    type PitchingSplit = { player?: { fullName?: string }; stat?: { gamesPlayed?: number; gamesStarted?: number; wins?: number; losses?: number; saves?: number; strikeOuts?: number; baseOnBalls?: number; era?: string; whip?: string } };
    type StatsApiResponse = { stats?: Array<{ splits?: unknown[] }> };

    const hittingData = hittingRes.ok ? (await hittingRes.json() as StatsApiResponse) : null;
    const pitchingData = pitchingRes.ok ? (await pitchingRes.json() as StatsApiResponse) : null;

    const hittersByName = new Map<string, PlayerSeasonStats>();
    for (const split of (hittingData?.stats?.[0]?.splits ?? []) as HittingSplit[]) {
      const name = split.player?.fullName;
      const s = split.stat;
      if (!name || !s) continue;
      hittersByName.set(name, {
        gamesPlayed: s.gamesPlayed ?? 0, atBats: s.atBats ?? 0, runs: s.runs ?? 0,
        hits: s.hits ?? 0, homeRuns: s.homeRuns ?? 0, rbi: s.rbi ?? 0, rbis: s.rbi ?? 0,
        walks: s.baseOnBalls ?? 0, strikeouts: s.strikeOuts ?? 0, stolenBases: s.stolenBases ?? 0,
        battingAverage: s.avg ?? ".000", onBasePercentage: s.obp ?? ".000",
        sluggingPercentage: s.slg ?? ".000", ops: s.ops ?? ".000",
        obp: s.obp ?? ".000", slg: s.slg ?? ".000", statsType: "batting",
      });
    }

    const pitchersByName = new Map<string, PlayerSeasonStats>();
    const blank = ".000";
    for (const split of (pitchingData?.stats?.[0]?.splits ?? []) as PitchingSplit[]) {
      const name = split.player?.fullName;
      const s = split.stat;
      if (!name || !s) continue;
      pitchersByName.set(name, {
        gamesPlayed: s.gamesPlayed ?? 0, gamesStarted: s.gamesStarted ?? 0,
        wins: s.wins ?? 0, losses: s.losses ?? 0, saves: s.saves ?? 0,
        strikeouts: s.strikeOuts ?? 0, walks: s.baseOnBalls ?? 0,
        era: s.era ?? "0.00",
        whip: s.whip != null ? toThreeDecimal(parseFloat(s.whip)) : "0.000",
        statsType: "pitching",
        atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0, stolenBases: 0,
        battingAverage: blank, onBasePercentage: blank, sluggingPercentage: blank,
        ops: blank, obp: blank, slg: blank,
      });
    }

    const result = new Map<string, PlayerSeasonStats>();
    for (const profile of profiles) {
      if (profile.league !== "MLB") continue;
      const isPitcher = PITCHER_POSITIONS.includes(profile.position);
      const realStats = isPitcher ? pitchersByName.get(profile.playerName) : hittersByName.get(profile.playerName);
      if (realStats) result.set(profile.playerId, realStats);
    }
    _mlbSeasonStatsCache = { data: result, season, cachedAtMs: Date.now() };
  } catch {
    // Keep previous cache on error; getResolvedStats will fall back to synthetic stats
  }
}

function buildSeasonStats(profile: PlayerProfile): PlayerSeasonStats {
  const seed = stableHash(`${profile.playerId}:season`);

  if (PITCHER_POSITIONS.includes(profile.position)) {
    const gamesPlayed = 5 + (seed % 20);
    const gamesStarted = profile.position === "SP" ? gamesPlayed : 0;
    const wins = (seed >> 2) % (gamesStarted > 0 ? Math.min(gamesStarted, 10) : 5);
    const losses = (seed >> 4) % Math.max(1, gamesStarted - wins + 3);
    const saves = profile.position === "CL" ? 5 + (seed >> 6) % 20 : profile.position === "RP" ? (seed >> 6) % 5 : 0;
    const strikeouts = gamesPlayed * (4 + (seed >> 8) % 5);
    const walks = gamesPlayed * (1 + (seed >> 10) % 3);
    const inningsFloat = gamesStarted > 0 ? gamesStarted * (5 + (seed >> 12) % 3) : gamesPlayed * (1 + (seed >> 12) % 1);
    const earnedRuns = Math.max(1, Math.floor(inningsFloat * (0.3 + ((seed >> 14) % 40) / 100)));
    const eraRaw = (earnedRuns * 9) / Math.max(inningsFloat, 1);
    const era = toThreeDecimal(eraRaw);
    const whipRaw = (walks + strikeouts * 0.35) / Math.max(inningsFloat, 1);
    const whip = toThreeDecimal(Math.min(2.0, whipRaw));
    const blank = ".000";
    return {
      gamesPlayed, gamesStarted,
      wins, losses, saves,
      strikeouts, walks,
      era, whip,
      statsType: "pitching",
      // zero out batting fields
      atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0, stolenBases: 0,
      battingAverage: blank, onBasePercentage: blank, sluggingPercentage: blank, ops: blank, obp: blank, slg: blank,
    };
  }

  const gamesPlayed = 20 + (seed % 40);
  const atBats = gamesPlayed * (3 + (seed % 2));
  const hits = Math.max(1, Math.min(atBats, Math.floor(atBats * (0.24 + ((seed >> 3) % 90) / 1000))));
  const walks = 10 + ((seed >> 4) % 30);
  const strikeouts = 15 + ((seed >> 5) % 55);
  const homeRuns = (seed >> 6) % 15;
  const rbi = 12 + ((seed >> 7) % 45);
  const runs = 12 + ((seed >> 8) % 40);
  const stolenBases = ["OF", "SS", "2B"].includes(profile.position) ? (seed >> 9) % 18 : 0;
  const battingAverage = toThreeDecimal(hits / Math.max(atBats, 1));
  const onBasePercentage = toThreeDecimal(Math.min(0.48, parseFloat(battingAverage) + 0.08 + (walks / Math.max(atBats + walks, 1)) * 0.1));
  const sluggingPercentage = toThreeDecimal(Math.min(0.72, parseFloat(battingAverage) + 0.12 + (homeRuns / Math.max(gamesPlayed, 1)) * 0.25));
  const ops = toThreeDecimal(parseFloat(onBasePercentage) + parseFloat(sluggingPercentage));
  return {
    gamesPlayed,
    atBats,
    runs,
    hits,
    homeRuns,
    rbi,
    rbis: rbi,
    walks,
    strikeouts,
    stolenBases,
    battingAverage,
    onBasePercentage,
    sluggingPercentage,
    ops,
    obp: onBasePercentage,
    slg: sluggingPercentage,
    statsType: "batting",
  };
}

function getResolvedStats(profile: PlayerProfile, date: string, statsOverride?: PlayerStatsOverride): PlayerStatsOverride {
  if (statsOverride) return statsOverride;
  const realSeasonStats = profile.league === "MLB" ? _mlbSeasonStatsCache?.data.get(profile.playerId) : undefined;
  return {
    dailyStats: buildDailyStats(profile, date),
    seasonStats: realSeasonStats ?? buildSeasonStats(profile),
  };
}

function scorePlayerForDay(profile: PlayerProfile, date: string, statsOverride?: PlayerStatsOverride): number {
  const stats = getResolvedStats(profile, date, statsOverride);
  const daily = stats.dailyStats;
  const season = stats.seasonStats;
  const levelBonus = profile.level === "Triple-A" ? 0.8 : profile.level === "Double-A" ? 0.5 : 0;
  if (PITCHER_POSITIONS.includes(profile.position)) {
    const ip = inningsToDecimal(daily.inningsPitched);
    const strikeouts = daily.strikeouts ?? 0;
    const walks = daily.walks ?? 0;
    const earnedRuns = daily.earnedRuns ?? 0;
    const qualityStart = ip >= 6 && earnedRuns <= 3 ? 1 : 0;

    // Fantasy-style daily base for pitchers.
    const dailyFantasyPoints = 3 * ip + 2 * strikeouts - 2 * earnedRuns - 0.5 * walks + 4 * qualityStart;

    const gamesPlayed = Math.max(1, season.gamesPlayed || 1);
    const seasonEra = Number.parseFloat(season.era ?? "4.5");
    const seasonKPerGame = (season.strikeouts ?? 0) / gamesPlayed;
    const seasonBBPerGame = (season.walks ?? 0) / gamesPlayed;
    const seasonWPerGame = (season.wins ?? 0) / gamesPlayed;
    const seasonSavePerGame = (season.saves ?? 0) / gamesPlayed;

    // Stabilizer uses season rates so one outing does not over-rank low-volume lines.
    const seasonProxy = Math.max(0, (5 - seasonEra) * 3) + seasonKPerGame * 2 - seasonBBPerGame * 0.6 + seasonWPerGame * 3 + seasonSavePerGame * 4;
    const trend = dailyFantasyPoints - seasonProxy;
    const confidence = Math.min(1, ip / 4);
    const blended = confidence * (0.7 * dailyFantasyPoints + 0.2 * seasonProxy + 0.1 * trend) + (1 - confidence) * seasonProxy;
    return Number((blended + levelBonus).toFixed(1));
  }

  const hits = daily.hits ?? 0;
  const homeRuns = daily.homeRuns ?? 0;
  const runs = daily.runs ?? 0;
  const rbi = daily.rbi ?? daily.rbis ?? 0;
  const walks = daily.walks ?? 0;
  const stolenBases = daily.stolenBases ?? 0;
  const strikeouts = daily.strikeouts ?? 0;

  // Fantasy-style daily base for hitters.
  const dailyFantasyPoints = 3 * Math.max(0, hits - homeRuns) + 10 * homeRuns + 2 * runs + 2 * rbi + 2 * walks + 5 * stolenBases - strikeouts;

  const gamesPlayed = Math.max(1, season.gamesPlayed || 1);
  const seasonSingles = Math.max(0, (season.hits ?? 0) - (season.homeRuns ?? 0));
  const seasonRbi = season.rbi ?? season.rbis ?? 0;
  const seasonFantasyPerGame =
    (3 * seasonSingles + 10 * (season.homeRuns ?? 0) + 2 * (season.runs ?? 0) + 2 * seasonRbi + 2 * (season.walks ?? 0) + 5 * (season.stolenBases ?? 0) - (season.strikeouts ?? 0)) /
    gamesPlayed;

  const trend = dailyFantasyPoints - seasonFantasyPerGame;
  const plateAppearances = (daily.atBats ?? 0) + walks;
  const confidence = Math.min(1, plateAppearances / 4);
  const blended = confidence * (0.7 * dailyFantasyPoints + 0.2 * seasonFantasyPerGame + 0.1 * trend) + (1 - confidence) * seasonFantasyPerGame;
  return Number((blended + levelBonus).toFixed(1));
}

function buildBasePlayerResponse(profile: PlayerProfile, date: string, rank: number, rankingScore: number, lastUpdated: string, statsOverride?: PlayerStatsOverride): BasePlayerResponse {
  const stats = getResolvedStats(profile, date, statsOverride);
  // DK-style fantasy points are best-effort: only computed when an override
  // exists (i.e. real stats were resolved). Synthetic daily lines stay null
  // so the iOS app can hide the badge when the player didn't actually play.
  const fantasyPoints = statsOverride
    ? computeFantasyPoints(profile.position, stats.dailyStats as unknown as Parameters<typeof computeFantasyPoints>[1])
    : null;
  // DailyIQ score: position-aware weighted impact, separate from DK fantasy.
  const dailyScore = computeDailyScore(
    profile.position,
    stats.dailyStats as unknown as Parameters<typeof computeDailyScore>[1],
  );
  return {
    playerId: profile.playerId,
    rank,
    rankingScore,
    fantasyPoints,
    dailyScore,
    movement: null, // populated later by decorateWithMovement
    league: profile.league,
    level: profile.level,
    playerName: profile.playerName,
    team: profile.teamAbbreviation,
    teamName: profile.teamName,
    teamAbbreviation: profile.teamAbbreviation,
    position: profile.position,
    dailyStats: stats.dailyStats,
    seasonStats: stats.seasonStats,
    lastUpdated,
  };
}

function decorateWithWatchlistStatus(players: BasePlayerResponse[], watchlist: Set<string>): PlayerResponse[] {
  return players.map((player) => ({ ...player, isOnWatchlist: watchlist.has(player.playerId) }));
}

/**
 * Decorate the supplied player list with movement badges, re-sort by
 * dailyScore desc, and reassign rank. Market deltas are fetched in ONE
 * batched call across MLB+MiLB so we don't fan out per-player.
 *
 * - dailyScore is already computed in buildBasePlayerResponse.
 * - baseline comes from per-game season production (position-aware).
 * - marketDelta is folded into the reason text when |pct7d| >= 5.
 *
 * Returns a new array — input is not mutated.
 */
type MarketDeltaMap = Awaited<ReturnType<typeof getMarketDeltasForPlayers>>;

/** Pure: apply movement decoration using a pre-fetched market-delta map. */
function applyMovementWithMap(
  players: BasePlayerResponse[],
  marketMap: MarketDeltaMap,
): BasePlayerResponse[] {
  return players.map((p) => {
    const baseline = baselineFromSeason(
      p.position,
      p.seasonStats as unknown as Parameters<typeof baselineFromSeason>[1],
    );
    const marketDelta = marketMap.get(p.playerName) ?? null;
    const movement = computeMovement({
      score: p.dailyScore ?? 0,
      baseline,
      marketDelta: marketDelta as any,
    });
    return { ...p, movement };
  });
}

/** Fetch market deltas for a deduped set of player names. ONE Cosmos batch. */
async function fetchMarketDeltaMap(
  allPlayers: BasePlayerResponse[],
): Promise<MarketDeltaMap> {
  const names = Array.from(new Set(allPlayers.map((p) => p.playerName).filter(Boolean)));
  if (names.length === 0) return new Map();
  try {
    return await getMarketDeltasForPlayers(names);
  } catch (err: any) {
    // Market deltas are best-effort: if comp_logs is unavailable we still
    // emit movement based on performance vs baseline alone.
    console.warn("[dailyiq.routes] getMarketDeltasForPlayers failed:", err?.message ?? err);
    return new Map();
  }
}

async function decorateWithMovement(allPlayers: BasePlayerResponse[]): Promise<BasePlayerResponse[]> {
  if (allPlayers.length === 0) return allPlayers;
  const marketMap = await fetchMarketDeltaMap(allPlayers);
  return applyMovementWithMap(allPlayers, marketMap);
}

/** Re-rank by dailyScore desc (with watchlist +10% boost), reassign rank 1..N. */
function rerankByDailyScore(players: BasePlayerResponse[], watchlist: Set<string>): BasePlayerResponse[] {
  const adjusted = players
    .map((p) => ({
      player: p,
      effective: (p.dailyScore ?? 0) * (watchlist.has(p.playerId) ? 1.1 : 1),
    }))
    .sort((a, b) => b.effective - a.effective);
  return adjusted.map(({ player }, idx) => ({ ...player, rank: idx + 1 }));
}

/** Pick top movers for the dashboard strips. Operates on movement-decorated rows. */
function pickMovers(players: BasePlayerResponse[]): {
  risers: BasePlayerResponse[];
  fallers: BasePlayerResponse[];
  breakouts: BasePlayerResponse[];
} {
  const withMv = players.filter((p) => p.movement);
  const risers = withMv
    .filter((p) => p.movement!.direction === "up" && p.movement!.label !== "Breakout Alert")
    .sort((a, b) => (b.movement!.performanceDelta ?? 0) - (a.movement!.performanceDelta ?? 0))
    .slice(0, 5);
  const fallers = withMv
    .filter((p) => p.movement!.direction === "down")
    .sort((a, b) => (a.movement!.performanceDelta ?? 0) - (b.movement!.performanceDelta ?? 0))
    .slice(0, 5);
  const breakouts = withMv
    .filter((p) => p.movement!.label === "Breakout Alert")
    .sort((a, b) => (b.dailyScore ?? 0) - (a.dailyScore ?? 0))
    .slice(0, 5);
  return { risers, fallers, breakouts };
}

async function getPlayerPool(league: League, level: MiLBLevel | "All" = "All"): Promise<PlayerProfile[]> {
  const basePlayers = PLAYER_POOL.filter((player) => player.isActive);

  if (basePlayers.length === 0) return [];

  let assignments = new Map<string, Awaited<ReturnType<typeof resolveCurrentPlayerAssignments>> extends Map<string, infer TValue> ? TValue : never>();
  try {
    assignments = await resolveCurrentPlayerAssignments(basePlayers);
  } catch {
    assignments = new Map();
  }

  return basePlayers.filter((player) => {
    const assignment = assignments.get(player.playerId);
    // Static MLB players are never demoted to MiLB by API assignments.
    // Name collisions, rehab assignments, and IL absences can cause the real-time
    // API to return a MiLB team for an active MLB player — ignore those overrides.
    const effectiveLeague = player.league === "MLB" ? "MLB" : (assignment?.league ?? player.league);
    if (effectiveLeague !== league) return false;
    const effectiveLevel = assignment?.league === "MiLB" ? assignment.level : player.level;
    if (league === "MiLB" && level !== "All" && effectiveLevel !== level) return false;
    return true;
  }).map((player) => {
    const assignment = assignments.get(player.playerId);
    // Only apply assignment overrides for MiLB players (level/team updates for transfers or promotions).
    // Never overwrite an MLB player's team info with a minor-league assignment.
    if (!assignment || player.league === "MLB" || assignment.league !== league) return { ...player, league };
    return {
      ...player,
      league,
      level: assignment.level,
      teamName: assignment.teamName,
      teamAbbreviation: assignment.teamAbbreviation,
    };
  });
}

async function getMiLBStatsOverrides(date: string, profiles: PlayerProfile[]): Promise<Map<string, ResolvedMiLBPlayerStats>> {
  if (profiles.length === 0) return new Map<string, ResolvedMiLBPlayerStats>();

  try {
    return await getMiLBBoxScoreStats(date, profiles);
  } catch {
    return new Map<string, ResolvedMiLBPlayerStats>();
  }
}

async function getMLBTeamsPlayingOnDate(date: string): Promise<Set<string>> {
  try {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
    const response = await fetch(url, { headers: { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" } });
    if (!response.ok) return new Set<string>();
    const data = await response.json() as { dates?: Array<{ games?: Array<{ teams?: { away?: { team?: { abbreviation?: string } }, home?: { team?: { abbreviation?: string } } } }> }> };
    const teams = new Set<string>();
    for (const dateObj of data.dates ?? []) {
      for (const game of dateObj.games ?? []) {
        const away = game.teams?.away?.team?.abbreviation;
        const home = game.teams?.home?.team?.abbreviation;
        if (away) teams.add(away);
        if (home) teams.add(home);
      }
    }
    return teams;
  } catch {
    return new Set<string>(); // empty = don't filter (safe fallback)
  }
}

async function getRankedPlayers(league: League, date: string, limit: number, lastUpdated: string, level: MiLBLevel | "All" = "All"): Promise<BasePlayerResponse[]> {
  const profiles = await getPlayerPool(league, level);
  const milbStats = league === "MiLB" ? await getMiLBStatsOverrides(date, profiles) : new Map<string, ResolvedMiLBPlayerStats>();
  let mlbStats: Map<string, ResolvedMLBPlayerStats> = new Map();

  let filteredProfiles = profiles;
  if (league === "MLB") {
    const [playingTeams, realDaily] = await Promise.all([
      getMLBTeamsPlayingOnDate(date),
      // Pull real daily MLB box-score stats for the pool so the scoring engine
      // ranks players by their actual day instead of synthetic data.
      getMLBBoxScoreStats(date, profiles).catch(() => new Map<string, ResolvedMLBPlayerStats>()),
      // Warm real season stats cache; await on first load, background-refresh thereafter
      _mlbSeasonStatsCache ? fetchMLBSeasonStatsForPool(profiles).catch(() => undefined) : fetchMLBSeasonStatsForPool(profiles),
    ]);
    mlbStats = realDaily;
    // Prefer players who actually appeared in a boxscore today. The synthetic
    // daily stats are seed-hashed and identical day-to-day, so ranking against
    // them surfaces players who did not play. Falling through to schedule-only
    // (teams playing) only happens when no boxscore matches resolved at all —
    // that keeps the brief non-empty when the API is unhappy.
    const withRealStats = profiles.filter((p) => mlbStats.has(p.playerId));
    if (withRealStats.length > 0) {
      filteredProfiles = withRealStats;
    } else if (playingTeams.size > 0) {
      filteredProfiles = profiles.filter((p) => playingTeams.has(p.teamAbbreviation));
    }
  } else {
    // MiLB: only show players with real box score stats from that day
    const withRealStats = profiles.filter((p) => milbStats.has(p.playerId));
    // Fall back to all profiles only if the box score API returned nothing at all
    filteredProfiles = withRealStats.length > 0 ? withRealStats : profiles;
  }

  return filteredProfiles
    .map((profile) => {
      const statsOverride: PlayerStatsOverride | undefined = profile.league === "MLB"
        ? (mlbStats.get(profile.playerId) as PlayerStatsOverride | undefined)
        : (milbStats.get(profile.playerId) as PlayerStatsOverride | undefined);
      return { profile, rankingScore: scorePlayerForDay(profile, date, statsOverride), statsOverride };
    })
    .sort((left, right) => right.rankingScore - left.rankingScore)
    .slice(0, limit)
    .map(({ profile, rankingScore, statsOverride }, index) => buildBasePlayerResponse(profile, date, index + 1, rankingScore, lastUpdated, statsOverride));
}

function findPlayerById(playerId: string): PlayerProfile | undefined {
  return PLAYER_POOL.find((player) => player.playerId === playerId);
}

function findPlayerByQuery(query: string, league?: League | "All"): PlayerProfile | undefined {
  const normalized = query.trim().toLowerCase();
  return PLAYER_POOL.find((player) => {
    if (league && league !== "All" && player.league !== league) return false;
    return [player.playerId, player.playerName, player.teamName, player.teamAbbreviation].some((value) => value.toLowerCase().includes(normalized));
  });
}

function slugifyPlayerId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLevelValue(raw: string | null | undefined): MiLBLevel {
  if (!raw) return null;
  const v = raw.trim();
  if (v === "Triple-A" || v === "Double-A" || v === "High-A" || v === "Single-A" || v === "Rookie") return v;
  return null;
}

/**
 * Build a synthetic PlayerProfile from a hydrated MLB Stats /people record.
 * Returns null when the record is missing enough data to be useful.
 */
function profileFromMlbPerson(person: any, fallbackName: string): { profile: PlayerProfile; mlbPersonId: number | null } | null {
  if (!person) return null;
  const playerName = (person.fullName ?? fallbackName ?? "").trim();
  if (!playerName) return null;

  const sportId = person?.currentTeam?.sport?.id ?? null;
  const level = normalizeLevelValue(levelFromSport(sportId));
  const league: League = sportId === 1 ? "MLB" : level ? "MiLB" : "MLB";
  const teamName = person?.currentTeam?.name ?? "";
  const teamAbbreviation = person?.currentTeam?.abbreviation ?? teamName.slice(0, 3).toUpperCase();
  const position = person?.primaryPosition?.abbreviation ?? "";
  const isActive = person?.active !== false;
  const mlbPersonId = typeof person?.id === "number" ? person.id : Number(person?.id) || null;

  return {
    profile: {
      playerId: slugifyPlayerId(playerName),
      playerName,
      league,
      level,
      teamName,
      teamAbbreviation,
      position,
      isActive,
    },
    mlbPersonId,
  };
}

/**
 * Synthesize a PlayerProfile from a persisted WatchlistEntry's stored metadata.
 * Used by GET /watchlist when the player isn't part of the curated PLAYER_POOL.
 */
function profileFromWatchlistEntry(entry: WatchlistEntry): PlayerProfile | null {
  const playerName = (entry.playerName ?? "").trim();
  if (!playerName) return null;
  const league: League = entry.league === "MiLB" ? "MiLB" : "MLB";
  return {
    playerId: entry.playerId,
    playerName,
    league,
    level: normalizeLevelValue(entry.level),
    teamName: entry.teamName ?? "",
    teamAbbreviation: entry.teamAbbreviation ?? "",
    position: entry.position ?? "",
    isActive: true,
  };
}

/**
 * Resolve a player to a profile + metadata to persist. Order of preference:
 *   1. PLAYER_POOL by id, then by query.
 *   2. MLB Stats API live search (covers MLB + MiLB rosters).
 *   3. Fall back to a freeform profile built from the caller-supplied name
 *      so the user can still add anyone they want (e.g. retired players or
 *      names the API doesn't recognize).
 */
async function resolveAddablePlayer(args: {
  playerId?: string;
  playerName?: string;
  query?: string;
  league?: League | "All";
}): Promise<{ profile: PlayerProfile; mlbPersonId?: number; resolvedVia: "pool" | "mlb-api" | "freeform" } | null> {
  const requestedPlayerId = (args.playerId ?? "").trim();
  const requestedName = (args.playerName ?? args.query ?? "").trim();
  const league = args.league ?? "All";

  if (requestedPlayerId) {
    const hit = findPlayerById(requestedPlayerId);
    if (hit) return { profile: hit, resolvedVia: "pool" };
  }
  if (requestedName) {
    const hit = findPlayerByQuery(requestedName, league);
    if (hit) return { profile: hit, resolvedVia: "pool" };
  }

  const searchTerm = requestedName || requestedPlayerId.replace(/-/g, " ");
  if (!searchTerm) return null;

  try {
    const person = await searchMlbPerson(searchTerm);
    const built = profileFromMlbPerson(person, searchTerm);
    if (built) {
      return {
        profile: built.profile,
        mlbPersonId: built.mlbPersonId ?? undefined,
        resolvedVia: "mlb-api",
      };
    }
  } catch (err) {
    console.warn("[dailyiq.routes] searchMlbPerson failed:", (err as Error)?.message ?? err);
  }

  // Freeform fallback — only when we have at least a name.
  if (!requestedName) return null;
  return {
    profile: {
      playerId: requestedPlayerId || slugifyPlayerId(requestedName),
      playerName: requestedName,
      league: league === "MiLB" ? "MiLB" : "MLB",
      level: null,
      teamName: "",
      teamAbbreviation: "",
      position: "",
      isActive: true,
    },
    resolvedVia: "freeform",
  };
}

async function getOptionalUserId(req: Request): Promise<string | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) return null;
  const user = await getUserBySession(sessionId);
  return user?.userId ?? null;
}

async function requireUserId(req: Request, res: Response): Promise<string | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  return user.userId;
}


function buildByLevelMap(milbPlayers: BasePlayerResponse[]): ByLevelMap {
  // milbPlayers is already sorted by rankingScore desc — preserve that order
  // and slice the top 5 per level. Levels not present in the response are
  // omitted entirely so the iOS app can hide empty sections.
  const levels: MiLBLevelKey[] = ["Triple-A", "Double-A", "High-A", "Single-A", "Rookie"];
  const map: ByLevelMap = {};
  for (const level of levels) {
    const bucket = milbPlayers.filter((p) => p.level === level).slice(0, 5);
    if (bucket.length > 0) map[level] = bucket;
  }
  return map;
}

async function buildBriefPayload(date: string): Promise<BriefCache> {
  const generatedAt = new Date().toISOString();
  const mlb = await getRankedPlayers("MLB", date, 50, generatedAt);
  const milb = await getRankedPlayers("MiLB", date, 50, generatedAt);
  return {
    date,
    generatedAt,
    mlb,
    milb,
    byLevel: buildByLevelMap(milb),
    cachedAtMs: Date.now(),
  };
}

function toPersistedPayload(payload: BriefCache): PersistedBriefPayload<BasePlayerResponse> {
  return {
    date: payload.date,
    generatedAt: payload.generatedAt,
    mlb: payload.mlb,
    milb: payload.milb,
  };
}

function hydrateBriefCache(payload: PersistedBriefPayload<BasePlayerResponse>): BriefCache {
  return {
    ...payload,
    // Persisted payloads written before byLevel existed won't have it — rebuild
    // on the fly so older Cosmos rows still surface the level breakdown.
    byLevel: buildByLevelMap(payload.milb),
    cachedAtMs: Date.now(),
  };
}

async function buildAndPersistBriefPayload(date: string): Promise<BriefCache> {
  const payload = await buildBriefPayload(date);
  await upsertPersistedBrief(toPersistedPayload(payload));
  return payload;
}

// Exported wrapper so the scheduled daily job can drive a fresh build
// from src/jobs/dailyiq.job.ts without duplicating the route logic.
export async function buildDailyBrief(date: string): Promise<BriefCache> {
  return buildAndPersistBriefPayload(date);
}

// POST /admin/run-job  — manual trigger for smoke testing the daily push.
// Guarded by DAILYIQ_ADMIN_TOKEN header (x-admin-token).
router.post("/admin/run-job", async (req: Request, res: Response) => {
  const expected = process.env.DAILYIQ_ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ success: false, error: "DAILYIQ_ADMIN_TOKEN not configured" });
  }
  if (String(req.headers["x-admin-token"] ?? "") !== expected) {
    return res.status(401).json({ success: false, error: "Invalid admin token" });
  }
  try {
    const { runDailyIQJob } = await import("../jobs/dailyiq.job.js");
    const result = await runDailyIQJob({ force: true });
    return res.json({ success: true, result });
  } catch (err: any) {
    console.error("[dailyiq.admin] runDailyIQJob failed:", err?.message ?? err);
    return res.status(500).json({ success: false, error: err?.message ?? "Job failed" });
  }
});

function currentBriefCache(date: string): BriefCache | null {
  return getBriefCache(date);
}

function refreshBriefCache(date: string): Promise<void> {
  const existing = _briefRefreshByDate.get(date);
  if (existing) return existing;
  const promise = (async () => {
    const built = await buildAndPersistBriefPayload(date);
    setBriefCache(date, built);
  })().finally(() => {
    _briefRefreshByDate.delete(date);
  });
  _briefRefreshByDate.set(date, promise);
  return promise;
}

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "DailyIQ", timestamp: new Date().toISOString() });
});

async function respondWithTopPlayers(req: Request, res: Response, league: League): Promise<void> {
  const date = normalizeDate(req.query.date);
  const limit = clampLimit(req.query.limit);
  const level = league === "MiLB" ? getRequestedMiLBLevel(req.query.level) : "All";
  const userId = await getOptionalUserId(req);
  const watchlist = userId ? await getWatchlistSet(userId) : new Set<string>();
  const lastUpdated = new Date().toISOString();
  const rankedPlayers = await getRankedPlayers(league, date, limit, lastUpdated, level);
  const players = decorateWithWatchlistStatus(rankedPlayers, watchlist);
  const enriched = await enrichWithPlayerIQ(players);
  res.json({ league, level: league === "MiLB" ? level : null, date, lastUpdated, limit, count: enriched.length, players: enriched });
}

router.get("/players/top/mlb", async (req, res) => {
  await respondWithTopPlayers(req, res, "MLB");
});

router.get("/players/top/milb", async (req, res) => {
  await respondWithTopPlayers(req, res, "MiLB");
});

router.get("/dashboard/player-stats", async (req, res) => {
  const date = normalizeDate(req.query.date);
  const userId = await getOptionalUserId(req);
  const watchlistSet = userId ? await getWatchlistSet(userId) : new Set<string>();
  const lastUpdated = new Date().toISOString();
  const [mlbRankedPlayers, milbRankedPlayers] = await Promise.all([
    getRankedPlayers("MLB", date, 50, lastUpdated),
    getRankedPlayers("MiLB", date, 50, lastUpdated),
  ]);
  const mlbTopPlayers = decorateWithWatchlistStatus(mlbRankedPlayers, watchlistSet);
  const milbTopPlayers = decorateWithWatchlistStatus(milbRankedPlayers, watchlistSet);
  const watchlistEntries = userId ? await getWatchlistEntries(userId) : [];
  const watchlistProfiles = userId
    ? watchlistEntries
        .map((entry) => ({ entry, profile: findPlayerById(entry.playerId) }))
        .filter((value): value is { entry: WatchlistEntry; profile: PlayerProfile } => Boolean(value.profile))
    : [];
  const milbWatchlistOverrides = await getMiLBStatsOverrides(
    date,
    watchlistProfiles.filter(({ profile }) => profile.league === "MiLB").map(({ profile }) => profile),
  );
  const watchlistPlayers = userId
    ? watchlistProfiles
        .map(({ entry, profile }) => {
          const statsOverride = profile.league === "MiLB" ? milbWatchlistOverrides.get(profile.playerId) : undefined;
          return buildBasePlayerResponse(profile, date, 0, scorePlayerForDay(profile, date, statsOverride), entry.createdAt, statsOverride);
        })
        .map((entry) => ({ ...entry, isOnWatchlist: true }))
    : [];

  res.json({ dashboardDate: date, lastUpdated, mlbTopPlayers, milbTopPlayers, watchlistPlayers });
});

/**
 * Build the watchlist section for the brief response.
 *
 * Mirrors GET /watchlist but stays lightweight: no recentForm or tomorrow
 * matchup lookups — those are slower per-player calls that the dedicated
 * /watchlist endpoint owns. Returns plain BasePlayerResponse rows that the
 * brief handler then decorates with movement using the shared market map.
 */
async function buildWatchlistSectionPlayers(
  userId: string,
  date: string,
): Promise<BasePlayerResponse[]> {
  const entries = await getWatchlistEntries(userId);
  const resolved = entries
    .map((entry) => {
      const pooled = findPlayerById(entry.playerId);
      const profile = pooled ?? profileFromWatchlistEntry(entry);
      return profile ? { entry, profile } : null;
    })
    .filter((v): v is { entry: WatchlistEntry; profile: PlayerProfile } => Boolean(v));

  const milbProfiles = resolved
    .filter(({ profile }) => profile.league === "MiLB")
    .map(({ profile }) => profile);
  const milbOverrides = milbProfiles.length
    ? await getMiLBStatsOverrides(date, milbProfiles).catch(() => new Map<string, ResolvedMiLBPlayerStats>())
    : new Map<string, ResolvedMiLBPlayerStats>();

  return resolved.map(({ entry, profile }) => {
    const statsOverride =
      profile.league === "MiLB" ? milbOverrides.get(profile.playerId) : undefined;
    return buildBasePlayerResponse(
      profile,
      date,
      0,
      scorePlayerForDay(profile, date, statsOverride),
      entry.createdAt,
      statsOverride,
    );
  });
}

const handleBriefRequest = async (req: Request, res: Response) => {
  const date = normalizeDate(req.query.date);
  const wantFresh = req.query.fresh === "true";
  const userId = await getOptionalUserId(req);
  const watchlist = userId ? await getWatchlistSet(userId) : new Set<string>();
  const meta = {
    path: req.path,
    baseUrl: req.baseUrl,
    fullPath: `${req.baseUrl}${req.path}`,
    cacheStatus: "miss",
  };

  try {
    const cachedForDate = getBriefCache(date);
    if (wantFresh) {
      meta.cacheStatus = "fresh";
      setBriefCache(date, await buildAndPersistBriefPayload(date));
    } else if (cachedForDate) {
      const isToday = date === defaultBriefDate();
      const isStale = Date.now() - cachedForDate.cachedAtMs >= BRIEF_BACKGROUND_REFRESH_MS;
      if (isToday && isStale) {
        meta.cacheStatus = "stale";
        refreshBriefCache(date).catch(() => undefined);
      } else {
        meta.cacheStatus = "hit";
      }
    } else {
      // Prefer Cosmos (written by the scheduled daily job); fall back to the
      // file-based persisted brief if Cosmos isn't configured / unavailable.
      let persisted: PersistedBriefPayload<BasePlayerResponse> | null = null;
      try {
        const cosmosBrief = await cosmosGetTopPlayers(date);
        if (cosmosBrief) {
          persisted = {
            date,
            generatedAt: cosmosBrief.generatedAt,
            mlb: cosmosBrief.mlb as unknown as BasePlayerResponse[],
            milb: cosmosBrief.milb as unknown as BasePlayerResponse[],
          };
        }
      } catch (err: any) {
        console.warn("[dailyiq.routes] cosmos brief read failed; falling back to file:", err?.message ?? err);
      }
      if (!persisted) {
        persisted = await getPersistedBriefByDate<BasePlayerResponse>(date);
      }
      if (persisted) {
        meta.cacheStatus = "persisted-hit";
        setBriefCache(date, hydrateBriefCache(persisted));
      } else {
        meta.cacheStatus = "cold";
        setBriefCache(date, await buildAndPersistBriefPayload(date));
      }
    }

    const payload = currentBriefCache(date) ?? await buildAndPersistBriefPayload(date);

    // Build the watchlist section in parallel with the brief cache hydration.
    // When the caller isn't signed in this resolves to an empty array.
    const watchlistSectionRaw = userId
      ? await buildWatchlistSectionPlayers(userId, date)
      : [];

    // BATCH STEP: collect every unique player name across mlb + milb + watchlist
    // and fetch market deltas in ONE Cosmos query batch. The shared map is then
    // re-used by applyMovementWithMap for each section — no per-player fan-out.
    const allForBatch = [...payload.mlb, ...payload.milb, ...watchlistSectionRaw];
    const marketMap = await fetchMarketDeltaMap(allForBatch);
    (meta as Record<string, unknown>).marketDeltaBatchCount = 1;
    (meta as Record<string, unknown>).marketDeltaBatchSize = new Set(
      allForBatch.map((p) => p.playerName).filter(Boolean),
    ).size;

    const mlbDecorated = applyMovementWithMap(payload.mlb, marketMap);
    const milbDecorated = applyMovementWithMap(payload.milb, marketMap);
    const watchlistDecorated = applyMovementWithMap(watchlistSectionRaw, marketMap);

    // MLB / MiLB: rerank by dailyScore desc (with +10% watchlist boost), stable
    // secondary sort by existing rankingScore handled inside rerankByDailyScore.
    const mlbRanked = rerankByDailyScore(mlbDecorated, watchlist);
    const milbRanked = rerankByDailyScore(milbDecorated, watchlist);

    // Watchlist: apply +10% dailyScore boost (multiplier 1.10), then sort by
    // abs(performanceDelta) desc so the biggest movers surface first.
    const watchlistRanked = watchlistDecorated
      .map((p) => ({
        ...p,
        dailyScore: Number(((p.dailyScore ?? 0) * 1.1).toFixed(2)),
      }))
      .sort(
        (a, b) =>
          Math.abs(b.movement?.performanceDelta ?? 0) -
          Math.abs(a.movement?.performanceDelta ?? 0),
      )
      .map((p, idx) => ({ ...p, rank: idx + 1 }));

    const { risers, fallers, breakouts } = pickMovers([...mlbRanked, ...milbRanked]);
    const [mlbEnriched, milbEnriched, watchlistEnriched, risersEnriched, fallersEnriched, breakoutsEnriched] = await Promise.all([
      enrichWithPlayerIQ(decorateWithWatchlistStatus(mlbRanked, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(milbRanked, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(watchlistRanked, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(risers, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(fallers, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(breakouts, watchlist)),
    ]);
    // Rebuild byLevel from the watchlist-decorated + IQ-enriched MiLB list so
    // per-level buckets carry the same flags (isOnWatchlist, playerIQ*) as the
    // top-level milb array. buildByLevelMap is order-preserving so the top-5
    // per level remains stable.
    const byLevel = buildByLevelMap(milbEnriched as unknown as BasePlayerResponse[]);
    return res.json({
      date: payload.date,
      generatedAt: payload.generatedAt,
      lastUpdated: payload.generatedAt,
      mlb: mlbEnriched,
      milb: milbEnriched,
      byLevel,
      watchlist: watchlistEnriched,
      risers: risersEnriched,
      fallers: fallersEnriched,
      breakouts: breakoutsEnriched,
      _meta: meta,
    });
  } catch (error: any) {
    const payload = currentBriefCache(date);
    if (payload) {
      const decoratedMilb = decorateWithWatchlistStatus(payload.milb, watchlist);
      return res.json({
        date: payload.date,
        generatedAt: payload.generatedAt,
        lastUpdated: payload.generatedAt,
        mlb: decorateWithWatchlistStatus(payload.mlb, watchlist),
        milb: decoratedMilb,
        byLevel: buildByLevelMap(decoratedMilb as unknown as BasePlayerResponse[]),
        risers: [],
        fallers: [],
        breakouts: [],
        _meta: { ...meta, cacheStatus: "error-fallback" },
      });
    }
    return res.status(500).json({ error: error?.message ?? "DailyIQ brief failed" });
  }
};

router.get("/", handleBriefRequest);
router.get("/brief", handleBriefRequest);

router.get("/watchlist", async (req, res) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const date = normalizeDate(req.query.date);
  const watchlistEntries = await getWatchlistEntries(userId);
  const watchlistSet = await getWatchlistSet(userId);
  const entries = watchlistEntries
    .map((entry) => {
      const pooled = findPlayerById(entry.playerId);
      const profile = pooled ?? profileFromWatchlistEntry(entry);
      return profile ? { entry, profile } : null;
    })
    .filter((value): value is { entry: WatchlistEntry; profile: PlayerProfile } => Boolean(value));

  const milbProfiles = entries.filter(({ profile }) => profile.league === "MiLB").map(({ profile }) => profile);
  const allProfiles = entries.map(({ profile }) => profile);

  // Resolve numeric MLB person IDs (for game-log / recent form lookups)
  // and tomorrow's probable pitchers (MLB schedule only) in parallel.
  const tomorrow = getTomorrowDateUTC();
  const [milbWatchlistOverrides, assignmentsByPlayerId, probableByTeam] = await Promise.all([
    getMiLBStatsOverrides(date, milbProfiles),
    allProfiles.length > 0
      ? resolveCurrentPlayerAssignments(allProfiles).catch(() => new Map<string, { mlbPersonId?: number }>())
      : Promise.resolve(new Map<string, { mlbPersonId?: number }>()),
    fetchTomorrowProbablePitchers(tomorrow).catch(() => new Map<string, TomorrowMatchup>()),
  ]);

  const season = new Date().getUTCFullYear();
  const PITCHER_POSITIONS = new Set(["SP", "RP", "CL", "P"]);

  // Fetch recent form (last 7 / last 15) for each watched player in parallel.
  const recentFormByPlayerId = new Map<string, RecentForm | null>();
  await Promise.all(
    entries.map(async ({ profile }) => {
      const assignment = assignmentsByPlayerId.get(profile.playerId) as { mlbPersonId?: number } | undefined;
      const personId = assignment?.mlbPersonId;
      if (!personId) {
        recentFormByPlayerId.set(profile.playerId, null);
        return;
      }
      const isPitcher = PITCHER_POSITIONS.has(profile.position);
      try {
        const form = await fetchRecentForm(personId, isPitcher, season);
        recentFormByPlayerId.set(profile.playerId, form);
      } catch {
        recentFormByPlayerId.set(profile.playerId, null);
      }
    }),
  );

  const items = entries
    .map(({ entry, profile }) => {
      const statsOverride = profile.league === "MiLB" ? milbWatchlistOverrides.get(profile.playerId) : undefined;
      const base = decorateWithWatchlistStatus([
        buildBasePlayerResponse(profile, date, 0, scorePlayerForDay(profile, date, statsOverride), entry.createdAt, statsOverride),
      ], watchlistSet)[0];

      const recentForm = recentFormByPlayerId.get(profile.playerId) ?? null;
      // Tomorrow matchup: MLB only (probable pitchers come from sportId=1 schedule).
      const tomorrowMatchup = profile.league === "MLB"
        ? probableByTeam.get(profile.teamAbbreviation) ?? null
        : null;

      return {
        watchlistItemId: entry.watchlistItemId,
        userId,
        createdAt: entry.createdAt,
        ...base,
        recentForm,
        tomorrowMatchup,
      };
    });
  // Decorate movement and sort by absolute performanceDelta desc so the most
  // noteworthy moves bubble to the top of the Watchlist tab.
  const decorated = await decorateWithMovement(items as unknown as BasePlayerResponse[]);
  const sorted = decorated
    .map((p, i) => ({ ...(items[i] as any), movement: p.movement }))
    .sort((a, b) => Math.abs(b.movement?.performanceDelta ?? 0) - Math.abs(a.movement?.performanceDelta ?? 0));
  res.json({ userId, date, count: sorted.length, watchlist: sorted });
});

router.post("/watchlist", async (req, res) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const requestedPlayerId = String(req.body?.playerId ?? "").trim();
  const requestedPlayerName = String(req.body?.playerName ?? "").trim();
  const requestedLeague = typeof req.body?.league === "string" && ["MLB", "MiLB"].includes(req.body.league)
    ? (req.body.league as League)
    : "All";
  if (!requestedPlayerId && !requestedPlayerName) {
    return res.status(400).json({ error: "playerId or playerName is required" });
  }

  const resolved = await resolveAddablePlayer({
    playerId: requestedPlayerId,
    playerName: requestedPlayerName,
    league: requestedLeague,
  });
  if (!resolved) {
    return res.status(404).json({ error: "Player not found" });
  }
  const { profile, mlbPersonId } = resolved;

  const { entry, created } = await upsertWatchlistEntry(userId, profile.playerId, {
    playerName: profile.playerName,
    teamName: profile.teamName || undefined,
    teamAbbreviation: profile.teamAbbreviation || undefined,
    league: profile.league,
    level: profile.level,
    position: profile.position || undefined,
    mlbPersonId,
  });

  return res.status(created ? 201 : 200).json({
    message: "Added to watchlist",
    watchlistItemId: entry.watchlistItemId,
    userId,
    playerId: profile.playerId,
    playerName: profile.playerName,
    league: profile.league,
    team: profile.teamName,
    level: profile.level,
    resolvedVia: resolved.resolvedVia,
  });
});

router.get("/watchlist/top", async (req, res) => {
  const limit = clampLimit(req.query.limit);
  const persistedCounts = await getAllWatchCounts();

  let players = [...persistedCounts.entries()]
    .map(([playerId, count]) => {
      const profile = findPlayerById(playerId);
      if (!profile) return null;
      return {
        playerId: profile.playerId,
        playerName: profile.playerName,
        teamName: profile.teamName,
        teamAbbreviation: profile.teamAbbreviation,
        team: profile.teamAbbreviation,
        league: profile.league,
        watchCount: count,
      };
    })
    .filter((value): value is {
      playerId: string;
      playerName: string;
      teamName: string;
      teamAbbreviation: string;
      team: string;
      league: League;
      watchCount: number;
    } => Boolean(value))
    .sort((left, right) => right.watchCount - left.watchCount)
    .slice(0, limit);

  if (players.length === 0) {
    const date = normalizeDate(req.query.date);
    const lastUpdated = new Date().toISOString();
    const [mlbRankedPlayers, milbRankedPlayers] = await Promise.all([
      getRankedPlayers("MLB", date, 50, lastUpdated),
      getRankedPlayers("MiLB", date, 50, lastUpdated),
    ]);

    players = [...mlbRankedPlayers, ...milbRankedPlayers]
      .sort((left, right) => right.rankingScore - left.rankingScore)
      .slice(0, limit)
      .map((entry) => ({
        playerId: entry.playerId,
        playerName: entry.playerName,
        teamName: entry.teamName,
        teamAbbreviation: entry.teamAbbreviation,
        team: entry.teamAbbreviation,
        league: entry.league,
        watchCount: 0,
      }));
  }

  res.json({ count: players.length, players });
});

router.get("/watchlist/suggest", (req, res) => {
  const query = String(req.query.q ?? "").trim().toLowerCase();
  const limit = Math.min(clampLimit(req.query.limit), 20);
  const requestedLeague = typeof req.query.league === "string" && ["MLB", "MiLB"].includes(req.query.league)
    ? req.query.league as League
    : null;
  const suggestions = PLAYER_POOL
    .filter((player) => (requestedLeague ? player.league === requestedLeague : true))
    .filter((player) => (!query ? true : [player.playerName, player.teamName, player.teamAbbreviation].some((value) => value.toLowerCase().includes(query))))
    .slice(0, limit)
    .map((player) => ({
      playerId: player.playerId,
      playerName: player.playerName,
      league: player.league,
      level: player.level,
      teamName: player.teamName,
      teamAbbreviation: player.teamAbbreviation,
      position: player.position,
    }));
  res.json({ query, suggestions });
});

router.post("/watchlist/search", async (req, res) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const query = String(req.body?.query ?? "").trim();
  if (!query) {
    return res.status(400).json({ error: "query is required" });
  }
  const requestedLeague = typeof req.body?.league === "string" && ["MLB", "MiLB"].includes(req.body.league)
    ? req.body.league as League
    : "All";
  const resolved = await resolveAddablePlayer({ query, league: requestedLeague });
  if (!resolved) {
    return res.status(404).json({ error: "No player found for that query", query });
  }
  const { profile, mlbPersonId } = resolved;
  const { entry, created } = await upsertWatchlistEntry(userId, profile.playerId, {
    playerName: profile.playerName,
    teamName: profile.teamName || undefined,
    teamAbbreviation: profile.teamAbbreviation || undefined,
    league: profile.league,
    level: profile.level,
    position: profile.position || undefined,
    mlbPersonId,
  });
  return res.json({
    message: "Added to watchlist",
    resolvedFrom: resolved.resolvedVia === "pool" ? "search" : resolved.resolvedVia,
    item: {
      watchlistItemId: entry.watchlistItemId,
      userId,
      playerId: profile.playerId,
      playerName: profile.playerName,
      league: profile.league,
      level: profile.level,
      teamName: profile.teamName,
      teamAbbreviation: profile.teamAbbreviation,
      position: profile.position,
    },
  });
});

router.delete("/watchlist/:playerId", async (req, res) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const playerId = String(req.params.playerId ?? "").trim();
  const removed = await removeWatchlistEntry(userId, playerId);
  if (!removed) {
    return res.status(404).json({ error: "Player not in watchlist" });
  }
  return res.json({ message: "Removed from watchlist", playerId, userId });
});

// GET /search?q=<name>&limit=<n>
// Server-side proxy for the MLB Stats API people search. Mobile clients
// must NEVER hit statsapi.mlb.com directly — proxying keeps observability,
// lets us swap providers later, and avoids leaking a User-Agent we don't
// control. We deliberately do NOT cache here: the volume is low and the
// search index changes whenever rosters move.
router.get("/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (query.length < 2) {
    return res.status(400).json({ error: "q must be at least 2 characters" });
  }
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 25);
  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(query)}&limit=${limit}&active=true`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" },
    });
    if (!response.ok) {
      return res.status(502).json({ error: `MLB Stats API returned ${response.status}` });
    }
    const data = (await response.json()) as {
      people?: Array<{
        id?: number;
        fullName?: string;
        primaryNumber?: string;
        primaryPosition?: { abbreviation?: string; name?: string };
        currentTeam?: { id?: number; name?: string };
        active?: boolean;
      }>;
    };
    const results = (data.people ?? []).map((person) => ({
      mlbPersonId: person.id ?? null,
      playerName: person.fullName ?? "",
      position: person.primaryPosition?.abbreviation ?? null,
      positionName: person.primaryPosition?.name ?? null,
      teamId: person.currentTeam?.id ?? null,
      teamName: person.currentTeam?.name ?? null,
      jersey: person.primaryNumber ?? null,
      active: person.active ?? null,
    }));
    return res.json({ query, count: results.length, results });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message ?? "MLB search proxy failed" });
  }
});

export default router;