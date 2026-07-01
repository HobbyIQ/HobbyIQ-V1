import { Request, Response, Router } from "express";
import { getUserBySession } from "../services/authService.js";
import { resolveCurrentPlayerAssignments } from "../services/dailyiq/milbBoxScoreService.js";
import { fetchRecentForm, type RecentForm } from "../services/dailyiq/recentFormService.js";
import { readMarketPlayersPayload } from "../services/dailyiq/marketPlayers.service.js";
import { fetchTomorrowProbablePitchers, getTomorrowDateUTC, type TomorrowMatchup } from "../services/dailyiq/probablePitchersService.js";
import {
  getAllWatchCounts,
  getWatchlistEntries,
  getWatchlistSet,
  removeWatchlistEntry,
  upsertWatchlistEntry,
  type WatchlistEntry,
} from "../services/dailyiq/watchlistStore.service.js";
// CF-DAILYIQ-BRIEFS-UNIFY (2026-06-02): briefStore retired. Repository is
// the sole writer + reader for dailyiq_briefs. Local-dev disk fallback is
// gone — when Cosmos is unconfigured locally, the route's in-memory cache
// (getBriefCache/setBriefCache) holds today's brief for the process
// lifetime; restart triggers a fresh build via buildAndPersistBriefPayload.
//
// PersistedBriefPayload is now a local-only type for the read-path adapter
// between repository.getTopPlayers and hydrateBriefCache.
interface PersistedBriefPayload<TPlayer = unknown> {
  date: string;
  generatedAt: string;
  mlb: TPlayer[];
  milb: TPlayer[];
}
import {
  getTopPlayers as cosmosGetTopPlayers,
  saveTopPlayers,
  type RankedPlayerLike,
} from "../repositories/dailyiq.repository.js";
import { getPlayerScoreByName } from "../services/playerScore/playerScore.service.js";
import { computeFantasyPoints } from "../services/dailyiq/fantasyScoring.service.js";
import {
  computeDailyScore,
  baselineFromSeason,
} from "../services/dailyiq/dailyScore.service.js";
import { computeMovement } from "../services/dailyiq/movement.service.js";
import { getMarketDeltasForPlayers } from "../services/dailyiq/marketDelta.service.js";
// CF-DAILYIQ-CARD-MOVERS (2026-06-30): CardHedge's server-side computed
// weekly top movers. Adds a card-centric surface alongside the existing
// player-centric DailyIQ brief. iOS renders as an optional new tile if
// the field is present (back-compat: clients on older versions ignore
// the unknown field).
import { getTopMovers, type TopMoverCard } from "../services/compiq/cardhedge.client.js";
import { searchMlbPerson, levelFromSport } from "../services/playerScore/mlbStats.service.js";
import {
  ingestDailyPlayers,
  type IngestedPlayerRecord,
  type IngestionResult,
} from "../services/dailyiq/dynamicIngestion.service.js";
// CF-PAYMENTS-A: requireSession + requireEntitlement gates for watchlist
// routes (watchlist feature is collector+). DailyIQ brief routes (/brief,
// /players/top/*, /dashboard/player-stats) were gated by CF-FINALIZE
// (dailyIQBriefs, investor+). trendIQComposite + trendIQLayer3Full attached
// at POST /api/compiq/trendiq + /trendiq/full (CF-TRENDIQ-SURFACES).
// marketTrendIndexes attached at GET /api/compiq/market-trend +
// /market-trend/batch + /market-trend/top-movers (CF-MARKET-TREND-INDEXES).
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";

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
  statsType?: "batting" | "pitching";
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
  /** DailyIQ score — product-defined daily impact score. */
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
  direction: "up" | "down" | "neutral";
  label: string;
  reason: string;
  performanceDelta: number;
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
  byLevel?: ByLevelMap;
  cachedAtMs: number;
}

const router = Router();

const BRIEF_BACKGROUND_REFRESH_MS = Number(process.env.DAILYIQ_BACKGROUND_REFRESH_MS ?? 300000);
const BRIEF_CACHE_MAX_ENTRIES = 14;
const _briefCacheByDate = new Map<string, BriefCache>();
const _briefRefreshByDate = new Map<string, Promise<void>>();

function setBriefCache(date: string, value: BriefCache): void {
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
  _briefCacheByDate.delete(date);
  _briefCacheByDate.set(date, hit);
  return hit;
}

function clampLimit(rawLimit: unknown): number {
  const parsed = Number(rawLimit ?? 50);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(Math.floor(parsed), 50);
}

/**
 * DailyIQ defaults to the previous calendar day in America/Los_Angeles —
 * the brief reports completed MLB / MiLB box scores. Today's games haven't
 * been played yet when the brief is first generated at 06:00 PT, so
 * anchoring to "today" produces an empty board.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Brief assembly from dynamic ingestion
// ─────────────────────────────────────────────────────────────────────────────

function toBasePlayerResponse(
  record: IngestedPlayerRecord,
  rank: number,
  lastUpdated: string,
): BasePlayerResponse {
  const dailyStats = record.dailyStats as unknown as PlayerDailyStats;
  const seasonStats = record.seasonStats as unknown as PlayerSeasonStats;
  // dailyScore is already computed by the ingestion service from real boxscore
  // stats — persist it so the wire response carries the real number (PR #61).
  const dailyScore = record.dailyScore;
  const fantasyPoints = computeFantasyPoints(
    record.position,
    dailyStats as unknown as Parameters<typeof computeFantasyPoints>[1],
  );
  return {
    playerId: record.playerId,
    rank,
    rankingScore: dailyScore,
    fantasyPoints,
    dailyScore,
    movement: null,
    league: record.league,
    level: record.level,
    playerName: record.playerName,
    team: record.teamAbbreviation,
    teamName: record.teamName,
    teamAbbreviation: record.teamAbbreviation,
    position: record.position,
    dailyStats,
    seasonStats,
    lastUpdated,
  };
}

function buildByLevelMap(milbPlayers: BasePlayerResponse[]): ByLevelMap {
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
  let result: IngestionResult;
  try {
    result = await ingestDailyPlayers(date);
  } catch (err: any) {
    console.error("[dailyiq.routes] ingestDailyPlayers threw:", err?.message ?? err);
    result = { date, mlb: [], milb: [], errors: [{ stage: "fatal", message: String(err?.message ?? err) }] };
  }
  if (result.errors.length > 0) {
    console.warn(
      `[dailyiq.routes] ingestion completed with ${result.errors.length} errors for ${date}`,
    );
  }
  const mlb = result.mlb
    .sort((a, b) => b.dailyScore - a.dailyScore)
    .map((r, i) => toBasePlayerResponse(r, i + 1, generatedAt));
  const milb = result.milb
    .sort((a, b) => b.dailyScore - a.dailyScore)
    .map((r, i) => toBasePlayerResponse(r, i + 1, generatedAt));
  return {
    date,
    generatedAt,
    mlb,
    milb,
    byLevel: buildByLevelMap(milb),
    cachedAtMs: Date.now(),
  };
}

function hydrateBriefCache(payload: PersistedBriefPayload<BasePlayerResponse>): BriefCache {
  return {
    ...payload,
    byLevel: buildByLevelMap(payload.milb),
    cachedAtMs: Date.now(),
  };
}

async function buildAndPersistBriefPayload(date: string): Promise<BriefCache> {
  const payload = await buildBriefPayload(date);
  // CF-DAILYIQ-BRIEFS-UNIFY: single-writer path. Repository (saveTopPlayers)
  // is the sole persistence call — it owns notifiedAt / updatedAt + dedup
  // by id=date. Cast through RankedPlayerLike because BasePlayerResponse
  // is the route's richer projection (rank, dailyScore, etc.); repository
  // doesn't care about field shape beyond what it serializes. The whole-doc
  // upsert preserves everything BasePlayerResponse carries.
  try {
    await saveTopPlayers(date, {
      mlb: payload.mlb as unknown as RankedPlayerLike[],
      milb: payload.milb as unknown as RankedPlayerLike[],
    });
  } catch (err: any) {
    console.warn("[dailyiq.routes] saveTopPlayers failed:", err?.message ?? err);
  }
  return payload;
}

// Exported wrapper so src/jobs/dailyiq.job.ts can drive a fresh build without
// duplicating route logic.
export async function buildDailyBrief(date: string): Promise<BriefCache> {
  return buildAndPersistBriefPayload(date);
}

/**
 * Read-through brief accessor. Returns the in-memory cache for the date,
 * falling back to Cosmos / file-store, finally building fresh.
 */
async function ensureBriefForDate(date: string): Promise<BriefCache> {
  const cached = getBriefCache(date);
  if (cached) return cached;

  // CF-DAILYIQ-BRIEFS-UNIFY: cosmos is the sole persistent read; the
  // file-store fallback is retired with briefStore.service.ts. When Cosmos
  // is unconfigured (local dev), cosmosGetTopPlayers returns null and we
  // fall through to building fresh — process-lifetime in-memory cache
  // (getBriefCache/setBriefCache around this call) handles the local
  // hot-path; restart triggers a fresh build.
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
    console.warn("[dailyiq.routes] cosmos brief read failed:", err?.message ?? err);
  }
  if (persisted && (persisted.mlb.length > 0 || persisted.milb.length > 0)) {
    const hydrated = hydrateBriefCache(persisted);
    setBriefCache(date, hydrated);
    return hydrated;
  }

  const built = await buildAndPersistBriefPayload(date);
  setBriefCache(date, built);
  return built;
}

// ─────────────────────────────────────────────────────────────────────────────
// Movement / decoration
// ─────────────────────────────────────────────────────────────────────────────

function decorateWithWatchlistStatus(players: BasePlayerResponse[], watchlist: Set<string>): PlayerResponse[] {
  return players.map((player) => ({ ...player, isOnWatchlist: watchlist.has(player.playerId) }));
}

type MarketDeltaMap = Awaited<ReturnType<typeof getMarketDeltasForPlayers>>;

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

async function fetchMarketDeltaMap(
  allPlayers: BasePlayerResponse[],
): Promise<MarketDeltaMap> {
  const names = Array.from(new Set(allPlayers.map((p) => p.playerName).filter(Boolean)));
  if (names.length === 0) return new Map();
  try {
    return await getMarketDeltasForPlayers(names);
  } catch (err: any) {
    console.warn("[dailyiq.routes] getMarketDeltasForPlayers failed:", err?.message ?? err);
    return new Map();
  }
}

async function decorateWithMovement(allPlayers: BasePlayerResponse[]): Promise<BasePlayerResponse[]> {
  if (allPlayers.length === 0) return allPlayers;
  const marketMap = await fetchMarketDeltaMap(allPlayers);
  return applyMovementWithMap(allPlayers, marketMap);
}

function rerankByDailyScore(players: BasePlayerResponse[], watchlist: Set<string>): BasePlayerResponse[] {
  const adjusted = players
    .map((p) => ({
      player: p,
      effective: (p.dailyScore ?? 0) * (watchlist.has(p.playerId) ? 1.1 : 1),
    }))
    .sort((a, b) => b.effective - a.effective);
  return adjusted.map(({ player }, idx) => ({ ...player, rank: idx + 1 }));
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Watchlist helpers (no PLAYER_POOL anymore)
// ─────────────────────────────────────────────────────────────────────────────

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

function profileFromMlbPerson(
  person: any,
  fallbackName: string,
): { profile: PlayerProfile; mlbPersonId: number | null } | null {
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
      playerId: mlbPersonId ? String(mlbPersonId) : slugifyPlayerId(playerName),
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
 * Resolve a player to a profile + metadata to persist. With PLAYER_POOL gone,
 * the order of preference is:
 *   1. MLB Stats API live search (covers MLB + MiLB rosters).
 *   2. Freeform — derive a name from playerName, raw query, or by un-slugging
 *      the playerId so the user can still add anyone (e.g. retired players).
 */
async function resolveAddablePlayer(args: {
  playerId?: string;
  playerName?: string;
  query?: string;
  league?: League | "All";
}): Promise<{ profile: PlayerProfile; mlbPersonId?: number; resolvedVia: "mlb-api" | "freeform" } | null> {
  const requestedPlayerId = (args.playerId ?? "").trim();
  const requestedName = (args.playerName ?? args.query ?? "").trim();
  const league = args.league ?? "All";

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

  // Freeform fallback. Always use the searchTerm as the display name so
  // callers that supplied only a slug (e.g. "shohei-ohtani") still get a
  // sensible record back.
  const fallbackName = requestedName || searchTerm;
  return {
    profile: {
      playerId: requestedPlayerId || slugifyPlayerId(fallbackName),
      playerName: fallbackName,
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

// CF-PAYMENTS-A: requireUserId retained for backwards compatibility with
// route handlers that haven't yet been updated to read req.user directly.
// When requireSession middleware has run upstream, this returns the
// attached userId without a fresh Cosmos read. Otherwise it falls back to
// the legacy session-header path.
async function requireUserId(req: Request, res: Response): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
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

// ─────────────────────────────────────────────────────────────────────────────
// Watchlist suggestions — curated star list (used by GET /watchlist/suggest).
// Kept small intentionally: anyone outside this list can still be added via
// /watchlist/search which hits the live MLB Stats API.
// ─────────────────────────────────────────────────────────────────────────────

interface WatchlistSuggestion {
  playerId: string;
  playerName: string;
  league: League;
  level: MiLBLevel;
  teamName: string;
  teamAbbreviation: string;
  position: string;
}

const WATCHLIST_SUGGESTIONS: WatchlistSuggestion[] = [
  { playerId: "660271", playerName: "Shohei Ohtani",         league: "MLB", level: null, teamName: "Los Angeles Dodgers",    teamAbbreviation: "LAD", position: "DH" },
  { playerId: "694973", playerName: "Paul Skenes",           league: "MLB", level: null, teamName: "Pittsburgh Pirates",      teamAbbreviation: "PIT", position: "SP" },
  { playerId: "694192", playerName: "Jackson Chourio",       league: "MLB", level: null, teamName: "Milwaukee Brewers",       teamAbbreviation: "MIL", position: "OF" },
  { playerId: "683002", playerName: "Junior Caminero",       league: "MLB", level: null, teamName: "Tampa Bay Rays",          teamAbbreviation: "TB",  position: "3B" },
  { playerId: "683003", playerName: "Gunnar Henderson",      league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "SS" },
  { playerId: "682829", playerName: "Elly De La Cruz",       league: "MLB", level: null, teamName: "Cincinnati Reds",         teamAbbreviation: "CIN", position: "SS" },
  { playerId: "682928", playerName: "Wyatt Langford",        league: "MLB", level: null, teamName: "Texas Rangers",           teamAbbreviation: "TEX", position: "OF" },
  { playerId: "660670", playerName: "Yoshinobu Yamamoto",    league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "SP" },
  { playerId: "683734", playerName: "Jackson Holliday",      league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "2B" },
  { playerId: "676475", playerName: "Cal Raleigh",           league: "MLB", level: null, teamName: "Seattle Mariners",        teamAbbreviation: "SEA", position: "C"  },
  { playerId: "592450", playerName: "Aaron Judge",           league: "MLB", level: null, teamName: "New York Yankees",        teamAbbreviation: "NYY", position: "OF" },
  { playerId: "665742", playerName: "Juan Soto",             league: "MLB", level: null, teamName: "New York Mets",           teamAbbreviation: "NYM", position: "OF" },
  { playerId: "605141", playerName: "Mookie Betts",          league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "OF" },
  { playerId: "518692", playerName: "Freddie Freeman",       league: "MLB", level: null, teamName: "Los Angeles Dodgers",     teamAbbreviation: "LAD", position: "1B" },
  { playerId: "665487", playerName: "Fernando Tatis Jr.",    league: "MLB", level: null, teamName: "San Diego Padres",        teamAbbreviation: "SD",  position: "OF" },
  { playerId: "660670", playerName: "Ronald Acuña Jr.",      league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "OF" },
  { playerId: "547180", playerName: "Bryce Harper",          league: "MLB", level: null, teamName: "Philadelphia Phillies",   teamAbbreviation: "PHI", position: "1B" },
  { playerId: "607208", playerName: "Trea Turner",           league: "MLB", level: null, teamName: "Philadelphia Phillies",   teamAbbreviation: "PHI", position: "SS" },
  { playerId: "596019", playerName: "Francisco Lindor",      league: "MLB", level: null, teamName: "New York Mets",           teamAbbreviation: "NYM", position: "SS" },
  { playerId: "624413", playerName: "Pete Alonso",           league: "MLB", level: null, teamName: "New York Mets",           teamAbbreviation: "NYM", position: "1B" },
  { playerId: "677951", playerName: "Bobby Witt Jr.",        league: "MLB", level: null, teamName: "Kansas City Royals",      teamAbbreviation: "KC",  position: "SS" },
  { playerId: "677594", playerName: "Julio Rodríguez",       league: "MLB", level: null, teamName: "Seattle Mariners",        teamAbbreviation: "SEA", position: "OF" },
  { playerId: "670541", playerName: "Yordan Alvarez",        league: "MLB", level: null, teamName: "Houston Astros",          teamAbbreviation: "HOU", position: "DH" },
  { playerId: "608369", playerName: "Corey Seager",          league: "MLB", level: null, teamName: "Texas Rangers",           teamAbbreviation: "TEX", position: "SS" },
  { playerId: "668939", playerName: "Adley Rutschman",       league: "MLB", level: null, teamName: "Baltimore Orioles",       teamAbbreviation: "BAL", position: "C"  },
  { playerId: "665489", playerName: "Vladimir Guerrero Jr.", league: "MLB", level: null, teamName: "Toronto Blue Jays",       teamAbbreviation: "TOR", position: "1B" },
  { playerId: "666182", playerName: "Bo Bichette",           league: "MLB", level: null, teamName: "Toronto Blue Jays",       teamAbbreviation: "TOR", position: "SS" },
  { playerId: "621566", playerName: "Matt Olson",            league: "MLB", level: null, teamName: "Atlanta Braves",          teamAbbreviation: "ATL", position: "1B" },
  { playerId: "682998", playerName: "Corbin Carroll",        league: "MLB", level: null, teamName: "Arizona Diamondbacks",    teamAbbreviation: "ARI", position: "OF" },
  { playerId: "543037", playerName: "Gerrit Cole",           league: "MLB", level: null, teamName: "New York Yankees",        teamAbbreviation: "NYY", position: "SP" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Background refresh
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "DailyIQ", timestamp: new Date().toISOString() });
});

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

async function respondWithTopPlayers(req: Request, res: Response, league: League): Promise<void> {
  const date = normalizeDate(req.query.date);
  const limit = clampLimit(req.query.limit);
  const level = league === "MiLB" ? getRequestedMiLBLevel(req.query.level) : "All";
  const userId = await getOptionalUserId(req);
  const watchlist = userId ? await getWatchlistSet(userId) : new Set<string>();
  const brief = await ensureBriefForDate(date);
  const lastUpdated = brief.generatedAt;

  let pool = league === "MLB" ? brief.mlb : brief.milb;
  if (league === "MiLB" && level !== "All") {
    pool = pool.filter((p) => p.level === level);
  }
  const ranked = pool.slice(0, limit);
  const players = decorateWithWatchlistStatus(ranked, watchlist);
  const enriched = await enrichWithPlayerIQ(players);
  res.json({
    league,
    level: league === "MiLB" ? level : null,
    date,
    lastUpdated,
    limit,
    count: enriched.length,
    players: enriched,
  });
}

// CF-FINALIZE (2026-06-03): dailyIQBriefs hard-gate (investor+).
// /players/top/* serve slices of the brief — same data, different shape —
// so they get the same gate as /brief. Previously session-optional via
// getOptionalUserId; now session-required + entitlement-required.
router.get(
  "/players/top/mlb",
  requireSession,
  requireEntitlement("dailyIQBriefs"),
  async (req, res) => {
    await respondWithTopPlayers(req, res, "MLB");
  },
);

router.get(
  "/players/top/milb",
  requireSession,
  requireEntitlement("dailyIQBriefs"),
  async (req, res) => {
    await respondWithTopPlayers(req, res, "MiLB");
  },
);

/**
 * Lookup helper for watchlist enrichment: find a player in today's brief
 * by mlbPersonId (stringified) OR by case-insensitive name match. Returns
 * null when the player didn't play today.
 */
function findInBrief(
  brief: BriefCache,
  playerId: string,
  playerName: string,
  mlbPersonId?: number,
): BasePlayerResponse | null {
  const all = [...brief.mlb, ...brief.milb];
  const idStr = mlbPersonId ? String(mlbPersonId) : playerId;
  const byId = all.find((p) => p.playerId === idStr);
  if (byId) return byId;
  const lc = playerName.toLowerCase();
  return all.find((p) => p.playerName.toLowerCase() === lc) ?? null;
}

/** Zero-stats placeholder for watchlist rows whose player didn't play today. */
function buildOffDayResponse(profile: PlayerProfile, date: string, lastUpdated: string): BasePlayerResponse {
  const blank = ".000";
  const dailyStats: PlayerDailyStats = {
    gameDate: date,
    opponent: "",
    atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0,
    walks: 0, strikeouts: 0, stolenBases: 0,
    battingAverage: blank, ops: blank,
    dailyStatsStatus: "no-game",
  };
  const seasonStats: PlayerSeasonStats = {
    gamesPlayed: 0,
    atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0,
    walks: 0, strikeouts: 0, stolenBases: 0,
    battingAverage: blank, onBasePercentage: blank, sluggingPercentage: blank,
    ops: blank, obp: blank, slg: blank,
  };
  return {
    playerId: profile.playerId,
    rank: 0,
    rankingScore: 0,
    fantasyPoints: null,
    dailyScore: 0,
    movement: null,
    league: profile.league,
    level: profile.level,
    playerName: profile.playerName,
    team: profile.teamAbbreviation,
    teamName: profile.teamName,
    teamAbbreviation: profile.teamAbbreviation,
    position: profile.position,
    dailyStats,
    seasonStats,
    lastUpdated,
  };
}

// CF-FINALIZE: dashboard/player-stats returns the brief sliced for the
// dashboard layout — same gate as /brief.
router.get("/dashboard/player-stats", requireSession, requireEntitlement("dailyIQBriefs"), async (req, res) => {
  const date = normalizeDate(req.query.date);
  const userId = await getOptionalUserId(req);
  const watchlistSet = userId ? await getWatchlistSet(userId) : new Set<string>();
  const brief = await ensureBriefForDate(date);
  const lastUpdated = brief.generatedAt;

  const mlbTopPlayers = decorateWithWatchlistStatus(brief.mlb, watchlistSet);
  const milbTopPlayers = decorateWithWatchlistStatus(brief.milb, watchlistSet);

  const watchlistEntries = userId ? await getWatchlistEntries(userId) : [];
  const watchlistPlayers = userId
    ? watchlistEntries
        .map((entry) => {
          const profile = profileFromWatchlistEntry(entry);
          if (!profile) return null;
          const hit = findInBrief(brief, profile.playerId, profile.playerName, entry.mlbPersonId);
          const base = hit ?? buildOffDayResponse(profile, date, entry.createdAt);
          // Preserve the watchlist entry's stored playerId so iOS clients
          // that added players by slug (e.g. "shohei-ohtani") can still
          // dedupe / delete them by that same id.
          return { ...base, playerId: profile.playerId, isOnWatchlist: true };
        })
        .filter((v): v is PlayerResponse => Boolean(v))
    : [];

  res.json({ dashboardDate: date, lastUpdated, mlbTopPlayers, milbTopPlayers, watchlistPlayers });
});

/**
 * Build the watchlist section for the brief response. Uses today's brief as
 * the stats source (per playerId / name lookup); falls back to zero-stats
 * when the player didn't play.
 */
async function buildWatchlistSectionPlayers(
  userId: string,
  brief: BriefCache,
  date: string,
): Promise<BasePlayerResponse[]> {
  const entries = await getWatchlistEntries(userId);
  return entries
    .map((entry) => {
      const profile = profileFromWatchlistEntry(entry);
      if (!profile) return null;
      const hit = findInBrief(brief, profile.playerId, profile.playerName, entry.mlbPersonId);
      const base = hit ?? buildOffDayResponse(profile, date, entry.createdAt);
      return { ...base, playerId: profile.playerId };
    })
    .filter((v): v is BasePlayerResponse => Boolean(v));
}

// CF-DAILYIQ-CARD-MOVERS (2026-06-30): iOS-visible shape for the new
// cardMovers surface. Field names normalized to camelCase JSON-friendly
// (CH's source schema has "7 Day Sales" with a space, which iOS would
// have to decode via custom CodingKeys). Image URL is normalized to
// always include the scheme so iOS doesn't have to do URL fix-up.
export interface DailyIQCardMover {
  cardId: string;
  player: string;
  set: string;
  number: string;
  variant: string;
  imageUrl: string | null;
  rookie: boolean;
  /** Weekly gain % (CH already filters out >500% as data errors). */
  gainPct: number;
  sales7d: number;
  sales30d: number;
  /** Prices at each available grade. */
  prices: Array<{ grade: string; price: number }>;
}

function mapTopMoverCard(c: TopMoverCard): DailyIQCardMover {
  // CH ships images with protocol-relative URLs (//s3.amazonaws.com/...).
  // iOS prefers full https: URLs — normalize at the boundary.
  const rawImage = typeof c.image === "string" ? c.image.trim() : "";
  const imageUrl = !rawImage
    ? null
    : rawImage.startsWith("//")
      ? `https:${rawImage}`
      : rawImage;
  const prices = Array.isArray(c.prices)
    ? c.prices
        .map((p) => ({ grade: String(p.grade ?? "").trim(), price: Number(p.price) }))
        .filter((p) => p.grade.length > 0 && Number.isFinite(p.price))
    : [];
  return {
    cardId: String(c.card_id ?? ""),
    player: String(c.player ?? ""),
    set: String(c.set ?? ""),
    number: String(c.number ?? ""),
    variant: String(c.variant ?? ""),
    imageUrl,
    rookie: Boolean(c.rookie),
    gainPct: Number.isFinite(c.gain) ? Number(c.gain) : 0,
    sales7d: Number(c["7 Day Sales"] ?? 0) || 0,
    sales30d: Number(c["30 Day Sales"] ?? 0) || 0,
    prices,
  };
}

/**
 * Fetch and normalize CH top-movers for the DailyIQ brief surface.
 * Non-fatal: any failure (CH down, rate limit, bad shape) returns []
 * so the rest of the brief still ships. Caching lives in the CH client
 * (6h server-side cache + CH's 1h cache).
 */
export async function buildCardMoversSurface(): Promise<DailyIQCardMover[]> {
  try {
    const cards = await getTopMovers({ count: 25, category: "Baseball" });
    if (!Array.isArray(cards) || cards.length === 0) return [];
    return cards.map(mapTopMoverCard);
  } catch (err) {
    console.warn(`[dailyiq.brief] cardMovers fetch failed (non-fatal): ${(err as Error)?.message ?? err}`);
    return [];
  }
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
      // CF-DAILYIQ-BRIEFS-UNIFY: cosmos sole read; no file fallback.
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
        console.warn("[dailyiq.routes] cosmos brief read failed:", err?.message ?? err);
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

    const watchlistSectionRaw = userId
      ? await buildWatchlistSectionPlayers(userId, payload, date)
      : [];

    const allForBatch = [...payload.mlb, ...payload.milb, ...watchlistSectionRaw];
    const marketMap = await fetchMarketDeltaMap(allForBatch);
    (meta as Record<string, unknown>).marketDeltaBatchCount = 1;
    (meta as Record<string, unknown>).marketDeltaBatchSize = new Set(
      allForBatch.map((p) => p.playerName).filter(Boolean),
    ).size;

    const mlbDecorated = applyMovementWithMap(payload.mlb, marketMap);
    const milbDecorated = applyMovementWithMap(payload.milb, marketMap);
    const watchlistDecorated = applyMovementWithMap(watchlistSectionRaw, marketMap);

    const mlbRanked = rerankByDailyScore(mlbDecorated, watchlist);
    const milbRanked = rerankByDailyScore(milbDecorated, watchlist);

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
    // CF-DAILYIQ-CARD-MOVERS (2026-06-30): fetch CH top-movers in parallel
    // with the existing player-IQ enrichment passes — same Promise.all so
    // the brief is no slower than before. Non-fatal: failure surfaces as [].
    const [mlbEnriched, milbEnriched, watchlistEnriched, risersEnriched, fallersEnriched, breakoutsEnriched, cardMovers] = await Promise.all([
      enrichWithPlayerIQ(decorateWithWatchlistStatus(mlbRanked, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(milbRanked, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(watchlistRanked, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(risers, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(fallers, watchlist)),
      enrichWithPlayerIQ(decorateWithWatchlistStatus(breakouts, watchlist)),
      buildCardMoversSurface(),
    ]);
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
      cardMovers,
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

// CF-FINALIZE: composite brief (the canonical dailyIQBriefs surface).
// "/" is the iOS-visible alias. Both gated.
router.get("/", requireSession, requireEntitlement("dailyIQBriefs"), handleBriefRequest);
router.get("/brief", requireSession, requireEntitlement("dailyIQBriefs"), handleBriefRequest);

// CF-DAILYIQ-MARKET-PLAYERS (2026-07-01): market-facing player signals
// derived from matched-cohort momentum + CH sales-stats-by-player.
// Precomputed nightly by the matched-cohort background job (see
// matchedCohortMomentum.job.ts). Response is cheap — single Redis GET.
// Empty payload when the job hasn't run yet OR when the cache expired.
router.get("/market/players", requireSession, requireEntitlement("dailyIQBriefs"), async (_req, res) => {
  const payload = await readMarketPlayersPayload();
  if (!payload) {
    res.json({
      success: true,
      generatedAt: null,
      trending: [],
      fading: [],
      topVolume30d: [],
      supplyDryLeadingUp: [],
      note: "Market signals not yet precomputed. First cycle populates within 24h of MATCHED_COHORT_JOB_ENABLED=true.",
    });
    return;
  }
  res.json({ success: true, ...payload });
});

router.get("/watchlist", requireSession, requireEntitlement("watchlist"), async (req, res) => {
  const userId = req.user!.userId;
  const date = normalizeDate(req.query.date);
  const watchlistEntries = await getWatchlistEntries(userId);
  const watchlistSet = await getWatchlistSet(userId);

  const entries = watchlistEntries
    .map((entry) => {
      const profile = profileFromWatchlistEntry(entry);
      return profile ? { entry, profile } : null;
    })
    .filter((value): value is { entry: WatchlistEntry; profile: PlayerProfile } => Boolean(value));

  const allProfiles = entries.map(({ profile }) => profile);

  const brief = await ensureBriefForDate(date);

  const tomorrow = getTomorrowDateUTC();
  const [assignmentsByPlayerId, probableByTeam] = await Promise.all([
    allProfiles.length > 0
      ? resolveCurrentPlayerAssignments(allProfiles).catch(() => new Map<string, { mlbPersonId?: number }>())
      : Promise.resolve(new Map<string, { mlbPersonId?: number }>()),
    fetchTomorrowProbablePitchers(tomorrow).catch(() => new Map<string, TomorrowMatchup>()),
  ]);

  const season = new Date().getUTCFullYear();
  const PITCHER_POSITIONS = new Set(["SP", "RP", "CL", "P"]);

  const recentFormByPlayerId = new Map<string, RecentForm | null>();
  await Promise.all(
    entries.map(async ({ entry, profile }) => {
      const assignment = assignmentsByPlayerId.get(profile.playerId) as { mlbPersonId?: number } | undefined;
      const personId = assignment?.mlbPersonId ?? entry.mlbPersonId;
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

  const items = entries.map(({ entry, profile }) => {
    const hit = findInBrief(brief, profile.playerId, profile.playerName, entry.mlbPersonId);
    const baseResponse: BasePlayerResponse = {
      ...(hit ?? buildOffDayResponse(profile, date, entry.createdAt)),
      playerId: profile.playerId,
    };
    const base = decorateWithWatchlistStatus([baseResponse], watchlistSet)[0];

    const recentForm = recentFormByPlayerId.get(profile.playerId) ?? null;
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
  const decorated = await decorateWithMovement(items as unknown as BasePlayerResponse[]);
  const sorted = decorated
    .map((p, i) => ({ ...(items[i] as any), movement: p.movement }))
    .sort((a, b) => Math.abs(b.movement?.performanceDelta ?? 0) - Math.abs(a.movement?.performanceDelta ?? 0));
  res.json({ userId, date, count: sorted.length, watchlist: sorted });
});

router.post("/watchlist", requireSession, requireEntitlement("watchlist"), async (req, res) => {
  const userId = req.user!.userId;
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

  // Honor the caller-supplied playerId when present, so existing iOS clients
  // that store slug-based ids ("shohei-ohtani") keep working alongside the
  // new MLB-personId-based ids that come back from /search.
  const persistedPlayerId = requestedPlayerId || profile.playerId;
  const { entry, created } = await upsertWatchlistEntry(userId, persistedPlayerId, {
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
    playerId: persistedPlayerId,
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
  const userId = await getOptionalUserId(req);
  const date = normalizeDate(req.query.date);

  // Resolve persisted watchlist-count entries via stored WatchlistEntry rows
  // (no PLAYER_POOL anymore). When no counts exist yet, fall back to the
  // top players from the current brief.
  type Row = {
    playerId: string;
    playerName: string;
    teamName: string;
    teamAbbreviation: string;
    team: string;
    league: League;
    watchCount: number;
  };

  let players: Row[] = [];
  if (persistedCounts.size > 0 && userId) {
    const entries = await getWatchlistEntries(userId);
    const entryById = new Map(entries.map((e) => [e.playerId, e]));
    players = [...persistedCounts.entries()]
      .map(([playerId, count]) => {
        const entry = entryById.get(playerId);
        if (!entry) return null;
        return {
          playerId,
          playerName: entry.playerName ?? playerId,
          teamName: entry.teamName ?? "",
          teamAbbreviation: entry.teamAbbreviation ?? "",
          team: entry.teamAbbreviation ?? "",
          league: (entry.league === "MiLB" ? "MiLB" : "MLB") as League,
          watchCount: count,
        } as Row;
      })
      .filter((v): v is Row => Boolean(v))
      .sort((a, b) => b.watchCount - a.watchCount)
      .slice(0, limit);
  }

  if (players.length === 0) {
    const brief = await ensureBriefForDate(date);
    players = [...brief.mlb, ...brief.milb]
      .sort((a, b) => (b.dailyScore ?? 0) - (a.dailyScore ?? 0))
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
  const suggestions = WATCHLIST_SUGGESTIONS
    .filter((player) => (requestedLeague ? player.league === requestedLeague : true))
    .filter((player) => (!query
      ? true
      : [player.playerName, player.teamName, player.teamAbbreviation].some((value) => value.toLowerCase().includes(query))))
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

router.post("/watchlist/search", requireSession, requireEntitlement("watchlist"), async (req, res) => {
  const userId = req.user!.userId;
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
    resolvedFrom: resolved.resolvedVia,
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

router.delete("/watchlist/:playerId", requireSession, requireEntitlement("watchlist"), async (req, res) => {
  const userId = req.user!.userId;
  const playerId = String(req.params.playerId ?? "").trim();
  const removed = await removeWatchlistEntry(userId, playerId);
  if (!removed) {
    return res.status(404).json({ error: "Player not in watchlist" });
  }
  return res.json({ message: "Removed from watchlist", playerId, userId });
});

// GET /search?q=<name>&limit=<n>
// Server-side proxy for the MLB Stats API people search. Mobile clients
// must NEVER hit statsapi.mlb.com directly.
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
