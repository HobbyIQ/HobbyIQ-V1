import { Request, Response, Router } from "express";
import { getUserBySession } from "../services/authService.js";
import { getMiLBBoxScoreStats, resolveCurrentPlayerAssignments, type ResolvedMiLBPlayerStats } from "../services/dailyiq/milbBoxScoreService.js";
import {
  getWatchlistEntries,
  getWatchlistSet,
  removeWatchlistEntry,
  upsertWatchlistEntry,
  type WatchlistEntry,
} from "../services/dailyiq/watchlistStore.service.js";

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
}

interface BasePlayerResponse {
  playerId: string;
  rank: number;
  rankingScore: number;
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

interface PlayerResponse extends BasePlayerResponse {
  isOnWatchlist: boolean;
}

interface BriefCache {
  date: string;
  generatedAt: string;
  mlb: BasePlayerResponse[];
  milb: BasePlayerResponse[];
  cachedAtMs: number;
}

const router = Router();

const _watchCounts = new Map<string, { playerId: string; playerName: string; teamName: string; teamAbbreviation: string; league: League; count: number }>();

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
  // ── MiLB (51) ─────────────────────────────────────────────────────────────
  // NOTE: Verify uncertain call-up status periodically:
  //   ricky-tiedemann (TOR – back surgery 2025, may still be rehabbing)
  //   christian-scott  (NYM – Tommy John 2024, likely starting 2026 in minors)
  //   jace-jung        (DET – optioned/called up multiple times, confirm status)
  //   jackson-jobe     (DET – top pitching prospect, may have debuted)
  //   andrew-painter   (PHI – Tommy John 2023, confirm current level)
  //   marcelo-mayer    (BOS – may have debuted in 2025/2026)
  // Confirmed REMOVED (now on active MLB rosters):
  //   chase-burns → CIN Reds (debuted 2025)
  //   hurston-waldrep → ATL Braves (debuted 2024)
  //   tink-hence → STL Cardinals (debuted 2025)
  //   gavin-williams → CLE Guardians (debuted 2024)
  //   colt-keith → DET Tigers (debuted 2024)
  //   travis-bazzana → CLE Guardians (2024 AL ROY)
  //   roman-anthony → BOS Red Sox (debuted 2025)
  // Triple-A
  { playerId: "spencer-jones",        playerName: "Spencer Jones",         league: "MiLB", level: "Triple-A",  teamName: "Scranton/WB RailRiders",  teamAbbreviation: "SWB", position: "OF",  isActive: true },
  { playerId: "marcelo-mayer",        playerName: "Marcelo Mayer",         league: "MiLB", level: "Triple-A",  teamName: "Worcester Red Sox",        teamAbbreviation: "WOR", position: "SS",  isActive: true },
  { playerId: "ethan-salas",          playerName: "Ethan Salas",           league: "MiLB", level: "Triple-A",  teamName: "El Paso Chihuahuas",       teamAbbreviation: "ELP", position: "C",   isActive: true },
  { playerId: "jackson-jobe",         playerName: "Jackson Jobe",          league: "MiLB", level: "Triple-A",  teamName: "Toledo Mud Hens",          teamAbbreviation: "TOL", position: "SP",  isActive: true },
  { playerId: "andrew-painter",       playerName: "Andrew Painter",        league: "MiLB", level: "Triple-A",  teamName: "Lehigh Valley IronPigs",   teamAbbreviation: "LHV", position: "SP",  isActive: true },
  { playerId: "brady-house",          playerName: "Brady House",           league: "MiLB", level: "Triple-A",  teamName: "Rochester Red Wings",      teamAbbreviation: "ROC", position: "SS",  isActive: true },
  { playerId: "marco-luciano",        playerName: "Marco Luciano",         league: "MiLB", level: "Triple-A",  teamName: "Sacramento River Cats",    teamAbbreviation: "SAC", position: "SS",  isActive: true },
  { playerId: "termarr-johnson",      playerName: "Termarr Johnson",       league: "MiLB", level: "Triple-A",  teamName: "Indianapolis Indians",     teamAbbreviation: "IND", position: "2B",  isActive: true },
  { playerId: "elijah-green",         playerName: "Elijah Green",          league: "MiLB", level: "Triple-A",  teamName: "Rochester Red Wings",      teamAbbreviation: "ROC", position: "OF",  isActive: true },
  { playerId: "emerson-hancock",      playerName: "Emerson Hancock",       league: "MiLB", level: "Triple-A",  teamName: "Tacoma Rainiers",          teamAbbreviation: "TAC", position: "SP",  isActive: true },
  { playerId: "noah-schultz",         playerName: "Noah Schultz",          league: "MiLB", level: "Triple-A",  teamName: "Charlotte Knights",        teamAbbreviation: "CLT", position: "SP",  isActive: true },
  { playerId: "ricky-tiedemann",      playerName: "Ricky Tiedemann",       league: "MiLB", level: "Triple-A",  teamName: "Buffalo Bisons",           teamAbbreviation: "BUF", position: "SP",  isActive: true },
  { playerId: "jace-jung",            playerName: "Jace Jung",             league: "MiLB", level: "Triple-A",  teamName: "Toledo Mud Hens",          teamAbbreviation: "TOL", position: "2B",  isActive: true },
  { playerId: "harry-ford",           playerName: "Harry Ford",            league: "MiLB", level: "Triple-A",  teamName: "Tacoma Rainiers",          teamAbbreviation: "TAC", position: "C",   isActive: true },
  { playerId: "kyle-teel",            playerName: "Kyle Teel",             league: "MiLB", level: "Triple-A",  teamName: "Worcester Red Sox",        teamAbbreviation: "WOR", position: "C",   isActive: true },
  { playerId: "christian-scott",      playerName: "Christian Scott",       league: "MiLB", level: "Triple-A",  teamName: "Syracuse Mets",            teamAbbreviation: "SYR", position: "SP",  isActive: true },
  { playerId: "chase-meidroth",       playerName: "Chase Meidroth",        league: "MiLB", level: "Triple-A",  teamName: "Worcester Red Sox",        teamAbbreviation: "WOR", position: "2B",  isActive: true },
  { playerId: "chase-dollander",      playerName: "Chase Dollander",       league: "MiLB", level: "Triple-A",  teamName: "Albuquerque Isotopes",     teamAbbreviation: "ABQ", position: "SP",  isActive: true },
  { playerId: "emmanuel-rodriguez",   playerName: "Emmanuel Rodriguez",    league: "MiLB", level: "Triple-A",  teamName: "St. Paul Saints",          teamAbbreviation: "STP", position: "OF",  isActive: true },
  // Double-A
  { playerId: "bryce-eldridge",       playerName: "Bryce Eldridge",        league: "MiLB", level: "Double-A",  teamName: "Richmond Flying Squirrels",teamAbbreviation: "RIC", position: "1B",  isActive: true },
  { playerId: "bubba-chandler",       playerName: "Bubba Chandler",        league: "MiLB", level: "Double-A",  teamName: "Altoona Curve",            teamAbbreviation: "ALT", position: "SP",  isActive: true },
  { playerId: "hagen-smith",          playerName: "Hagen Smith",           league: "MiLB", level: "Double-A",  teamName: "Midland RockHounds",       teamAbbreviation: "MID", position: "SP",  isActive: true },
  { playerId: "noble-meyer",          playerName: "Noble Meyer",           league: "MiLB", level: "Double-A",  teamName: "Biloxi Shuckers",          teamAbbreviation: "BLX", position: "SP",  isActive: true },
  { playerId: "max-clark",            playerName: "Max Clark",             league: "MiLB", level: "Double-A",  teamName: "Erie SeaWolves",           teamAbbreviation: "ERI", position: "OF",  isActive: true },
  { playerId: "konnor-griffin",       playerName: "Konnor Griffin",        league: "MiLB", level: "Double-A",  teamName: "Springfield Cardinals",    teamAbbreviation: "SFD", position: "SS",  isActive: true },
  { playerId: "cam-collier",          playerName: "Cam Collier",           league: "MiLB", level: "Double-A",  teamName: "Chattanooga Lookouts",     teamAbbreviation: "CHA", position: "3B",  isActive: true },
  { playerId: "rhett-lowder",         playerName: "Rhett Lowder",          league: "MiLB", level: "Double-A",  teamName: "Chattanooga Lookouts",     teamAbbreviation: "CHA", position: "SP",  isActive: true },
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
  { playerId: "jac-caglianone",       playerName: "Jac Caglianone",        league: "MiLB", level: "High-A",    teamName: "Quad Cities River Bandits",teamAbbreviation: "QC",  position: "1B",  isActive: true },
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
let _briefCache: BriefCache | null = null;
let _briefRefreshPromise: Promise<void> | null = null;

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

function clampLimit(rawLimit: unknown): number {
  const parsed = Number(rawLimit ?? 50);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(Math.floor(parsed), 50);
}

function normalizeDate(rawDate: unknown): string {
  const fallback = new Date().toISOString().slice(0, 10);
  if (typeof rawDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return fallback;
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

function buildDailyStats(profile: PlayerProfile, date: string): PlayerDailyStats {
  const seed = stableHash(`${profile.playerId}:${date}:daily`);
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
    opponent: getOpponent(profile, date),
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
  };
}

function buildSeasonStats(profile: PlayerProfile): PlayerSeasonStats {
  const seed = stableHash(`${profile.playerId}:season`);
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
  };
}

function getResolvedStats(profile: PlayerProfile, date: string, statsOverride?: PlayerStatsOverride): PlayerStatsOverride {
  if (statsOverride) return statsOverride;
  return {
    dailyStats: buildDailyStats(profile, date),
    seasonStats: buildSeasonStats(profile),
  };
}

function scorePlayerForDay(profile: PlayerProfile, date: string, statsOverride?: PlayerStatsOverride): number {
  const stats = getResolvedStats(profile, date, statsOverride);
  const daily = stats.dailyStats;
  const season = stats.seasonStats;
  const levelBonus = profile.level === "Triple-A" ? 1.2 : profile.level === "Double-A" ? 0.8 : 0;
  return Number((parseFloat(daily.ops) * 45 + parseFloat(season.ops) * 55 + daily.homeRuns * 2 + season.homeRuns * 0.35 + daily.hits + levelBonus).toFixed(1));
}

function buildBasePlayerResponse(profile: PlayerProfile, date: string, rank: number, rankingScore: number, lastUpdated: string, statsOverride?: PlayerStatsOverride): BasePlayerResponse {
  const stats = getResolvedStats(profile, date, statsOverride);
  return {
    playerId: profile.playerId,
    rank,
    rankingScore,
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
    const effectiveLeague = assignment?.league ?? player.league;
    if (effectiveLeague !== league) return false;
    const effectiveLevel = assignment?.league === "MiLB" ? assignment.level : player.level;
    if (league === "MiLB" && level !== "All" && effectiveLevel !== level) return false;
    return true;
  }).map((player) => {
    const assignment = assignments.get(player.playerId);
    if (!assignment || assignment.league !== league) return { ...player, league };
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

async function getRankedPlayers(league: League, date: string, limit: number, lastUpdated: string, level: MiLBLevel | "All" = "All"): Promise<BasePlayerResponse[]> {
  const profiles = await getPlayerPool(league, level);
  const milbStats = league === "MiLB" ? await getMiLBStatsOverrides(date, profiles) : new Map<string, ResolvedMiLBPlayerStats>();

  return profiles
    .map((profile) => {
      const statsOverride = milbStats.get(profile.playerId);
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

function bumpWatchCount(profile: PlayerProfile): void {
  const existing = _watchCounts.get(profile.playerId);
  if (existing) {
    existing.count += 1;
    return;
  }

  _watchCounts.set(profile.playerId, {
    playerId: profile.playerId,
    playerName: profile.playerName,
    teamName: profile.teamName,
    teamAbbreviation: profile.teamAbbreviation,
    league: profile.league,
    count: 1,
  });
}

async function buildBriefPayload(date: string): Promise<BriefCache> {
  const generatedAt = new Date().toISOString();
  return {
    date,
    generatedAt,
    mlb: await getRankedPlayers("MLB", date, 50, generatedAt),
    milb: await getRankedPlayers("MiLB", date, 50, generatedAt),
    cachedAtMs: Date.now(),
  };
}

function currentBriefCache(): BriefCache | null {
  return _briefCache;
}

function refreshBriefCache(date: string): Promise<void> {
  if (_briefRefreshPromise) return _briefRefreshPromise;
  _briefRefreshPromise = (async () => {
    _briefCache = await buildBriefPayload(date);
  })().finally(() => {
    _briefRefreshPromise = null;
  });
  return _briefRefreshPromise;
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
  res.json({ league, level: league === "MiLB" ? level : null, date, lastUpdated, limit, count: players.length, players });
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
    if (wantFresh) {
      meta.cacheStatus = "fresh";
      _briefCache = await buildBriefPayload(date);
    } else if (_briefCache) {
      const isToday = _briefCache.date === date;
      const isStale = Date.now() - _briefCache.cachedAtMs >= BRIEF_BACKGROUND_REFRESH_MS;
      if (!isToday || isStale) {
        meta.cacheStatus = isStale ? "stale" : "expired";
        refreshBriefCache(date).catch(() => undefined);
      } else {
        meta.cacheStatus = "hit";
      }
    } else {
      meta.cacheStatus = "cold";
      _briefCache = await buildBriefPayload(date);
    }

    const payload = currentBriefCache() ?? await buildBriefPayload(date);
    return res.json({
      date: payload.date,
      generatedAt: payload.generatedAt,
      lastUpdated: payload.generatedAt,
      mlb: decorateWithWatchlistStatus(payload.mlb, watchlist),
      milb: decorateWithWatchlistStatus(payload.milb, watchlist),
      _meta: meta,
    });
  } catch (error: any) {
    const payload = currentBriefCache();
    if (payload) {
      return res.json({
        date: payload.date,
        generatedAt: payload.generatedAt,
        lastUpdated: payload.generatedAt,
        mlb: decorateWithWatchlistStatus(payload.mlb, watchlist),
        milb: decorateWithWatchlistStatus(payload.milb, watchlist),
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
    .map((entry) => ({ entry, profile: findPlayerById(entry.playerId) }))
    .filter((value): value is { entry: WatchlistEntry; profile: PlayerProfile } => Boolean(value.profile));
  const milbWatchlistOverrides = await getMiLBStatsOverrides(
    date,
    entries.filter(({ profile }) => profile.league === "MiLB").map(({ profile }) => profile),
  );
  const items = entries
    .map(({ entry, profile }) => {
      const statsOverride = profile.league === "MiLB" ? milbWatchlistOverrides.get(profile.playerId) : undefined;
      return {
        watchlistItemId: entry.watchlistItemId,
        userId,
        createdAt: entry.createdAt,
        ...decorateWithWatchlistStatus([
          buildBasePlayerResponse(profile, date, 0, scorePlayerForDay(profile, date, statsOverride), entry.createdAt, statsOverride),
        ], watchlistSet)[0],
      };
    });
  res.json({ userId, date, count: items.length, watchlist: items });
});

router.post("/watchlist", async (req, res) => {
  const userId = await requireUserId(req, res);
  if (!userId) return;
  const requestedPlayerId = String(req.body?.playerId ?? "").trim();
  const requestedPlayerName = String(req.body?.playerName ?? "").trim();
  const profile = requestedPlayerId ? findPlayerById(requestedPlayerId) : findPlayerByQuery(requestedPlayerName, "All");
  if (!profile) {
    return res.status(404).json({ error: "Player not found" });
  }

  const { entry, created } = await upsertWatchlistEntry(userId, profile.playerId);
  if (created) {
    bumpWatchCount(profile);
  }

  return res.status(created ? 201 : 200).json({
    message: "Added to watchlist",
    watchlistItemId: entry.watchlistItemId,
    userId,
    playerId: profile.playerId,
    playerName: profile.playerName,
    league: profile.league,
  });
});

router.get("/watchlist/top", (req, res) => {
  const limit = clampLimit(req.query.limit);
  const players = [..._watchCounts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, limit)
    .map((entry) => ({
      playerId: entry.playerId,
      playerName: entry.playerName,
      teamName: entry.teamName,
      teamAbbreviation: entry.teamAbbreviation,
      team: entry.teamAbbreviation,
      league: entry.league,
      watchCount: entry.count,
    }));
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
  const profile = findPlayerByQuery(query, requestedLeague);
  if (!profile) {
    return res.status(404).json({ error: "No player found for that query", query });
  }
  const { entry, created } = await upsertWatchlistEntry(userId, profile.playerId);
  if (created) {
    bumpWatchCount(profile);
  }
  return res.json({
    message: "Added to watchlist",
    resolvedFrom: "search",
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

export default router;