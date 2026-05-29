// Dynamic league-wide ingestion for DailyIQ.
//
// Pulls today's MLB + MiLB schedules from the MLB Stats API, fetches every
// game's boxscore, extracts every player-game appearance, applies an activity
// filter, merges two-way (Ohtani-style) lines, and scores each surviving
// appearance via computeDailyScore. Output feeds buildDailyBrief (dailyiq.routes.ts)
// and the scheduled dailyiq.job.
//
// No external deps: concurrency comes from the shared worker-pool helper.
//
// Activity filter:
//   Hitters:  >= 3 plate appearances
//   Pitchers: >= 1.0 IP OR has a save / hold / blown save decision
//
// Two-way: if the same MLB person ID appears as BOTH a qualifying hitter and
// a qualifying pitcher in the same game, we keep the pitcher line as the
// primary record and attach the hitter line as `dailyStats.secondaryStats`.

import { computeDailyScore } from "./dailyScore.service.js";
import { withConcurrency } from "../shared/concurrency.js";

// ── Public types ────────────────────────────────────────────────────────────

export type League = "MLB" | "MiLB";
export type MiLBLevel = "Triple-A" | "Double-A" | "High-A" | "Single-A" | "Rookie" | null;

export interface IngestedDailyStats {
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
  hitsAllowed?: number;
  runsAllowed?: number;
  homeRunsAllowed?: number;
  decision?: "W" | "L" | "SV" | "HLD" | "BS" | null;
  qualityStart?: boolean;
  pitched?: boolean;
  secondaryStats?: IngestedDailyStats;
}

export interface IngestedSeasonStats {
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
  inningsPitched?: string;
}

export interface IngestedPlayerRecord {
  mlbPersonId: number;
  playerId: string;            // stringified mlbPersonId
  slug: string;                // url-safe player name slug
  playerName: string;
  team: string;                // == teamAbbreviation (legacy alias)
  teamName: string;
  teamAbbreviation: string;
  position: string;
  league: League;
  level: MiLBLevel;
  dailyStats: IngestedDailyStats;
  seasonStats: IngestedSeasonStats;
  dailyScore: number;
}

export interface IngestionResult {
  date: string;
  mlb: IngestedPlayerRecord[];
  milb: IngestedPlayerRecord[];
  errors: Array<{ stage: string; message: string }>;
}

// ── Configuration ──────────────────────────────────────────────────────────

const MLB_SPORT_ID = 1;
const MILB_SPORT_IDS: Array<{ id: number; level: Exclude<MiLBLevel, null> }> = [
  { id: 11, level: "Triple-A" },
  { id: 12, level: "Double-A" },
  { id: 13, level: "High-A" },
  { id: 14, level: "Single-A" },
  { id: 16, level: "Rookie" },
];

const BOXSCORE_CONCURRENCY = Number(process.env.DAILYIQ_INGEST_CONCURRENCY ?? 8);
const RETRY_DELAY_MS = Number(process.env.DAILYIQ_INGEST_RETRY_MS ?? 500);
const FETCH_TIMEOUT_MS = Number(process.env.DAILYIQ_INGEST_TIMEOUT_MS ?? 10_000);
const PER_LEAGUE_CAP = Number(process.env.DAILYIQ_INGEST_CAP ?? 50);

// ── Wire shapes from MLB Stats API ─────────────────────────────────────────

interface ScheduleGame {
  gamePk: number;
  teams: {
    home: { team: { id?: number; name?: string; abbreviation?: string } };
    away: { team: { id?: number; name?: string; abbreviation?: string } };
  };
  status?: { detailedState?: string };
}

interface ScheduleResponse {
  dates?: Array<{ games?: ScheduleGame[] }>;
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
  plateAppearances?: string | number;
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
  note?: string;
}

interface BoxScorePlayerEntry {
  note?: string;
  person?: { id?: number; fullName?: string };
  stats?: { batting?: BoxStatBatting; pitching?: BoxStatPitching };
  seasonStats?: { batting?: BoxStatBatting; pitching?: BoxStatPitching };
  position?: { abbreviation?: string };
}

interface BoxScoreTeam {
  team: { id?: number; name?: string; abbreviation?: string };
  players?: Record<string, BoxScorePlayerEntry>;
}

interface BoxScoreResponse {
  teams?: { home?: BoxScoreTeam; away?: BoxScoreTeam };
}

// ── Helpers ────────────────────────────────────────────────────────────────

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

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\.']/g, "")
    .replace(/\bjr\b|\bsr\b|\bii\b|\biii\b|\biv\b/g, (m) => m) // keep suffixes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`MLB Stats API ${response.status}: ${response.statusText} (${url})`);
  }
  return (await response.json()) as T;
}

async function fetchJsonWithRetry<T>(url: string): Promise<T> {
  try {
    return await fetchJson<T>(url);
  } catch (err) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await fetchJson<T>(url);
  }
}

// withConcurrency moved to backend/src/services/shared/concurrency.ts
// 2026-05-29 (CF-UNIFIED-SEARCH-AND-CERT W5-Windows) so the unified-
// search detail-enrichment path can share the same helper without
// reach-across-domains imports.

// ── Per-game ingestion ─────────────────────────────────────────────────────

interface PlayerAppearance {
  mlbPersonId: number;
  playerName: string;
  position: string;
  teamId?: number;
  teamName: string;
  teamAbbreviation: string;
  opponentAbbreviation: string;
  gamePk: number;
  hitterLine: IngestedDailyStats | null;
  hitterSeason: IngestedSeasonStats | null;
  hitterPA: number;
  pitcherLine: IngestedDailyStats | null;
  pitcherSeason: IngestedSeasonStats | null;
  pitcherIp: number;
  pitcherDecision: "W" | "L" | "SV" | "HLD" | "BS" | null;
}

function buildHitterLine(
  date: string,
  opponentAbbr: string,
  player: BoxScorePlayerEntry,
): { daily: IngestedDailyStats | null; season: IngestedSeasonStats | null; pa: number } {
  const batting = player.stats?.batting;
  if (!batting) return { daily: null, season: null, pa: 0 };

  const atBats = toNumber(batting.atBats);
  const walks = toNumber(batting.baseOnBalls);
  const explicitPA = toNumber(batting.plateAppearances);
  const pa = explicitPA > 0 ? explicitPA : atBats + walks;

  const hits = toNumber(batting.hits);
  const runs = toNumber(batting.runs);
  const homeRuns = toNumber(batting.homeRuns);
  const rbi = toNumber(batting.rbi);
  const strikeouts = toNumber(batting.strikeOuts);
  const stolenBases = toNumber(batting.stolenBases);

  const seasonBatting = player.seasonStats?.batting;
  const seasonAtBats = toNumber(seasonBatting?.atBats);
  const seasonHits = toNumber(seasonBatting?.hits);
  const blank = ".000";

  const daily: IngestedDailyStats = {
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
    dailyStatsStatus: pa > 0 ? "boxscore" : "boxscore-no-pa",
    statsType: "batting",
  };

  const season: IngestedSeasonStats = seasonBatting
    ? {
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
      }
    : {
        gamesPlayed: 0,
        atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0,
        walks: 0, strikeouts: 0, stolenBases: 0,
        battingAverage: blank, onBasePercentage: blank, sluggingPercentage: blank,
        ops: blank, obp: blank, slg: blank,
        statsType: "batting",
        era: blank, wins: 0, losses: 0, saves: 0, gamesStarted: 0, whip: blank,
      };

  return { daily, season, pa };
}

function buildPitcherLine(
  date: string,
  opponentAbbr: string,
  player: BoxScorePlayerEntry,
): {
  daily: IngestedDailyStats | null;
  season: IngestedSeasonStats | null;
  ip: number;
  decision: "W" | "L" | "SV" | "HLD" | "BS" | null;
} {
  const pitching = player.stats?.pitching;
  if (!pitching) return { daily: null, season: null, ip: 0, decision: null };

  const inningsPitched = String(pitching.inningsPitched ?? "0.0");
  const ipDecimal = Number.parseFloat(inningsPitched);
  const ip = Number.isFinite(ipDecimal) ? ipDecimal : 0;
  const earnedRuns = toNumber(pitching.earnedRuns);
  const strikeouts = toNumber(pitching.strikeOuts);
  const walks = toNumber(pitching.baseOnBalls);
  const pitchCount = toNumber(pitching.pitchesThrown ?? pitching.numberOfPitches);
  const hitsAllowed = toNumber(pitching.hits);
  const runsAllowed = toNumber(pitching.runs);
  const homeRunsAllowed = toNumber(pitching.homeRuns);
  const pitched = ip > 0;
  const qualityStart = pitched && ip >= 6 && earnedRuns <= 3;
  const decision = parsePitcherNote(player.note, pitching.note);

  const seasonPitching = player.seasonStats?.pitching;
  const blank = ".000";

  const daily: IngestedDailyStats = {
    gameDate: date,
    opponent: opponentAbbr,
    atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0,
    walks,
    strikeouts,
    stolenBases: 0,
    battingAverage: blank,
    ops: blank,
    dailyStatsStatus: pitched ? "boxscore" : "boxscore-no-app",
    statsType: "pitching",
    inningsPitched,
    earnedRuns,
    pitchCount,
    hitsAllowed,
    runsAllowed,
    homeRunsAllowed,
    decision,
    qualityStart,
    pitched,
  };

  const season: IngestedSeasonStats = seasonPitching
    ? {
        gamesPlayed: toNumber(seasonPitching.gamesPlayed),
        gamesStarted: toNumber(seasonPitching.gamesStarted),
        atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0,
        walks: toNumber(seasonPitching.baseOnBalls),
        strikeouts: toNumber(seasonPitching.strikeOuts),
        stolenBases: 0,
        battingAverage: blank, onBasePercentage: blank, sluggingPercentage: blank,
        ops: blank, obp: blank, slg: blank,
        statsType: "pitching",
        era: seasonPitching.era ?? "0.00",
        wins: toNumber(seasonPitching.wins),
        losses: toNumber(seasonPitching.losses),
        saves: toNumber(seasonPitching.saves),
        whip: seasonPitching.whip ?? blank,
      }
    : {
        gamesPlayed: 0, gamesStarted: 0,
        atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0,
        walks: 0, strikeouts: 0, stolenBases: 0,
        battingAverage: blank, onBasePercentage: blank, sluggingPercentage: blank,
        ops: blank, obp: blank, slg: blank,
        statsType: "pitching",
        era: "0.00", wins: 0, losses: 0, saves: 0, whip: blank,
      };

  return { daily, season, ip, decision };
}

export function extractAppearances(
  date: string,
  gamePk: number,
  boxscore: BoxScoreResponse,
): PlayerAppearance[] {
  const out: PlayerAppearance[] = [];
  const sides: Array<{ team?: BoxScoreTeam; opponent?: BoxScoreTeam }> = [
    { team: boxscore.teams?.home, opponent: boxscore.teams?.away },
    { team: boxscore.teams?.away, opponent: boxscore.teams?.home },
  ];

  for (const { team, opponent } of sides) {
    if (!team?.players) continue;
    const teamName = String(team.team?.name ?? "");
    const teamAbbreviation = String(team.team?.abbreviation ?? teamName.slice(0, 3).toUpperCase());
    const opponentAbbreviation = String(
      opponent?.team?.abbreviation ?? opponent?.team?.name ?? "TBD",
    );

    for (const entry of Object.values(team.players)) {
      const personId = typeof entry.person?.id === "number" ? entry.person.id : undefined;
      const fullName = entry.person?.fullName;
      if (personId == null || !fullName) continue;

      const hitter = buildHitterLine(date, opponentAbbreviation, entry);
      const pitcher = buildPitcherLine(date, opponentAbbreviation, entry);

      out.push({
        mlbPersonId: personId,
        playerName: fullName,
        position: String(entry.position?.abbreviation ?? "").toUpperCase(),
        teamId: team.team?.id,
        teamName,
        teamAbbreviation,
        opponentAbbreviation,
        gamePk,
        hitterLine: hitter.daily,
        hitterSeason: hitter.season,
        hitterPA: hitter.pa,
        pitcherLine: pitcher.daily,
        pitcherSeason: pitcher.season,
        pitcherIp: pitcher.ip,
        pitcherDecision: pitcher.decision,
      });
    }
  }
  return out;
}

// ── Activity filter + two-way merge ────────────────────────────────────────

const HITTER_MIN_PA = 3;
const PITCHER_MIN_IP = 1.0;

interface MergedAppearance {
  appearance: PlayerAppearance;
  primary: "pitching" | "batting";
  hitterAttached: IngestedDailyStats | null;
}

function passesActivityFilter(a: PlayerAppearance): { ok: boolean; primary: "pitching" | "batting" | null } {
  const pitcherQualifies =
    (a.pitcherIp >= PITCHER_MIN_IP) ||
    a.pitcherDecision === "SV" || a.pitcherDecision === "HLD" || a.pitcherDecision === "BS";
  const hitterQualifies = a.hitterPA >= HITTER_MIN_PA && a.hitterLine !== null;

  if (pitcherQualifies && a.pitcherLine) return { ok: true, primary: "pitching" };
  if (hitterQualifies) return { ok: true, primary: "batting" };
  return { ok: false, primary: null };
}

export function applyFilterAndMerge(appearances: PlayerAppearance[]): MergedAppearance[] {
  // Group by mlbPersonId + gamePk so a two-way player on the same day collapses.
  const grouped = new Map<string, PlayerAppearance[]>();
  for (const a of appearances) {
    const key = `${a.mlbPersonId}:${a.gamePk}`;
    const arr = grouped.get(key) ?? [];
    arr.push(a);
    grouped.set(key, arr);
  }

  const merged: MergedAppearance[] = [];
  for (const arr of grouped.values()) {
    // Boxscore yields one entry per player per team appearance — usually 1.
    // If somehow >1, prefer the one with pitching+batting populated.
    const primary = arr[0];

    const verdict = passesActivityFilter(primary);
    if (!verdict.ok || !verdict.primary) continue;

    // Two-way merge: if pitcher is primary AND the same entry has a real
    // hitter line, attach it as secondaryStats.
    let hitterAttached: IngestedDailyStats | null = null;
    if (verdict.primary === "pitching" && primary.hitterPA > 0 && primary.hitterLine) {
      hitterAttached = primary.hitterLine;
    }
    merged.push({ appearance: primary, primary: verdict.primary, hitterAttached });
  }
  return merged;
}

// ── Build IngestedPlayerRecord ─────────────────────────────────────────────

function buildRecord(
  m: MergedAppearance,
  league: League,
  level: MiLBLevel,
): IngestedPlayerRecord {
  const a = m.appearance;
  const dailyBase = m.primary === "pitching" ? a.pitcherLine! : a.hitterLine!;
  const dailyStats: IngestedDailyStats = m.hitterAttached
    ? { ...dailyBase, secondaryStats: m.hitterAttached }
    : dailyBase;
  const seasonStats = m.primary === "pitching" ? (a.pitcherSeason ?? a.hitterSeason)! : (a.hitterSeason ?? a.pitcherSeason)!;
  const playerId = String(a.mlbPersonId);
  const slug = slugify(a.playerName);

  const dailyScore = computeDailyScore(a.position, dailyStats as unknown as Parameters<typeof computeDailyScore>[1]);

  return {
    mlbPersonId: a.mlbPersonId,
    playerId,
    slug,
    playerName: a.playerName,
    team: a.teamAbbreviation,
    teamName: a.teamName,
    teamAbbreviation: a.teamAbbreviation,
    position: a.position,
    league,
    level,
    dailyStats,
    seasonStats,
    dailyScore,
  };
}

// ── Per-sport pipeline ─────────────────────────────────────────────────────

async function fetchSchedule(date: string, sportId: number): Promise<ScheduleGame[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=${sportId}&date=${date}`;
  const payload = await fetchJsonWithRetry<ScheduleResponse>(url);
  return (payload.dates ?? []).flatMap((d) => d.games ?? []);
}

async function ingestSport(
  date: string,
  sportId: number,
  league: League,
  level: MiLBLevel,
  errors: Array<{ stage: string; message: string }>,
): Promise<IngestedPlayerRecord[]> {
  let games: ScheduleGame[] = [];
  try {
    games = await fetchSchedule(date, sportId);
  } catch (err: any) {
    errors.push({ stage: `schedule:${sportId}`, message: err?.message ?? String(err) });
    return [];
  }
  if (games.length === 0) return [];

  // Skip games not yet started — we want completed/in-progress only.
  const playable = games.filter((g) => {
    const state = String(g.status?.detailedState ?? "").toLowerCase();
    return !state.includes("scheduled") && !state.includes("pre-game") && !state.includes("warmup");
  });
  const target = playable.length > 0 ? playable : games;

  const allAppearances: PlayerAppearance[] = [];

  await withConcurrency(target, BOXSCORE_CONCURRENCY, async (game) => {
    try {
      const box = await fetchJsonWithRetry<BoxScoreResponse>(
        `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`,
      );
      const appearances = extractAppearances(date, game.gamePk, box);
      allAppearances.push(...appearances);
    } catch (err: any) {
      errors.push({
        stage: `boxscore:${sportId}:${game.gamePk}`,
        message: err?.message ?? String(err),
      });
    }
  });

  const merged = applyFilterAndMerge(allAppearances);
  const records = merged.map((m) => buildRecord(m, league, level));

  // Sort by dailyScore desc, cap to PER_LEAGUE_CAP per sport; final cap is
  // applied at the league level by the caller for MiLB (5 sports collapsed).
  records.sort((a, b) => b.dailyScore - a.dailyScore);
  return records;
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function ingestDailyPlayers(date: string): Promise<IngestionResult> {
  const errors: Array<{ stage: string; message: string }> = [];

  // MLB
  const mlb = await ingestSport(date, MLB_SPORT_ID, "MLB", null, errors);

  // MiLB — fan out across all 5 sport IDs in parallel, then merge.
  const milbBuckets = await Promise.all(
    MILB_SPORT_IDS.map((s) => ingestSport(date, s.id, "MiLB", s.level, errors)),
  );
  const milbAll = milbBuckets.flat();
  milbAll.sort((a, b) => b.dailyScore - a.dailyScore);

  return {
    date,
    mlb: mlb.slice(0, PER_LEAGUE_CAP),
    milb: milbAll.slice(0, PER_LEAGUE_CAP),
    errors,
  };
}
