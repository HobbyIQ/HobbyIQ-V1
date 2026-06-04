import { promises as fs } from "fs";
import path from "path";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

// ── Public types ────────────────────────────────────────────────────────────
//
// Storage for per-player-per-season rolling state, written nightly by the
// DailyIQ ingestion job. The container is keyed so that any single-player
// query (card detail view, "season-to-date hot days" surface) resolves
// with one point read — never a cross-partition scan.

export type SeasonPhase = "regular" | "postseason";

/** One entry per game the player appeared in this season. */
export interface PlayerSeasonGameLogEntry {
  /** Game date, YYYY-MM-DD. */
  date: string;
  /** Fantasy points scored that day. */
  fantasyPoints: number;
  /** Daily score (0–100). */
  dailyScore?: number;
  /** "up" | "down" | "flat" */
  movement?: string;
  /** True if the day qualified as "hot" per DAILYIQ_HOT_THRESHOLD. */
  isHot?: boolean;
  /** Stat-line payload (box score line for hitters, IP line for pitchers). */
  raw?: Record<string, unknown>;
}

export interface PlayerSeasonPayload {
  playerId: string;
  playerName?: string;
  seasonYear: number;
  phase: SeasonPhase;
  /** MLB Stats API sportId (1=MLB, 11=AAA, 12=AA, 13=High-A, 14=Single-A, 16=Rookie). */
  sportId?: number;
  teamId?: number;
  position?: string;

  /** Capped at MAX_GAME_LOG_ENTRIES (182) — oldest entries trimmed first. */
  gameLog: PlayerSeasonGameLogEntry[];

  // Rolling aggregates, recomputed on every append.
  fantasyPointsTotal: number;
  gamesPlayed: number;
  hotDays: number;
  seasonHigh: number;
  seasonLow: number;
  last7Avg: number;
  last30Avg: number;

  /** ISO timestamp of last write. */
  updatedAt: string;
}

// ── Internals ───────────────────────────────────────────────────────────────

const DOC_TYPE = "dailyiq_player_season";
const SCHEMA_VERSION = 1;
const MAX_GAME_LOG_ENTRIES = 182; // full MLB season + slack for doubleheaders

interface PlayerSeasonDoc extends PlayerSeasonPayload {
  id: string;
  docType: typeof DOC_TYPE;
  schemaVersion: number;
}

export function playerSeasonDocId(
  playerId: string,
  seasonYear: number,
  phase: SeasonPhase,
): string {
  return `${playerId}-${seasonYear}-${phase}`;
}

// ─── Cosmos client (lazy init, shared across requests) ──────────────────────

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
let _cosmosDisabled = false;

async function getContainer(): Promise<Container | null> {
  if (_cosmosDisabled) return null;
  if (_container) return _container;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName =
        process.env.COSMOS_DAILYIQ_PLAYER_SEASON_CONTAINER ??
        "dailyiq_player_season";

      if (!endpoint && !connStr) {
        console.log(
          "[dailyiq.playerSeason] COSMOS_ENDPOINT/COSMOS_CONNECTION_STRING not set; using file-backed fallback",
        );
        _cosmosDisabled = true;
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/playerId"] },
      });
      _container = container;
      console.log(
        `[dailyiq.playerSeason] Cosmos connected (db=${dbName} container=${containerName})`,
      );
      return container;
    } catch (err: any) {
      console.error(
        "[cosmos][dailyiq.playerSeason] Cosmos init failed; falling back to disk store:",
        err?.message ?? err,
      );
      _cosmosDisabled = true;
      return null;
    }
  })();

  return _initPromise;
}

function stripCosmosMeta(doc: Record<string, unknown>): PlayerSeasonPayload {
  const {
    id: _id,
    docType: _docType,
    schemaVersion: _schemaVersion,
    _rid,
    _self,
    _etag,
    _attachments,
    _ts,
    ...rest
  } = doc;
  return rest as unknown as PlayerSeasonPayload;
}

// ════════════════════════════════════════════════════════════════════════════
// Aggregate recompute
// ════════════════════════════════════════════════════════════════════════════

const HOT_THRESHOLD = Number(process.env.DAILYIQ_HOT_THRESHOLD ?? 30);

function recomputeAggregates(
  gameLog: PlayerSeasonGameLogEntry[],
): Pick<
  PlayerSeasonPayload,
  | "fantasyPointsTotal"
  | "gamesPlayed"
  | "hotDays"
  | "seasonHigh"
  | "seasonLow"
  | "last7Avg"
  | "last30Avg"
> {
  if (gameLog.length === 0) {
    return {
      fantasyPointsTotal: 0,
      gamesPlayed: 0,
      hotDays: 0,
      seasonHigh: 0,
      seasonLow: 0,
      last7Avg: 0,
      last30Avg: 0,
    };
  }
  // Caller should pass gameLog sorted ascending by date; we don't re-sort
  // here because the ingestion path already maintains that ordering and
  // sorts on every append.
  let total = 0;
  let high = -Infinity;
  let low = Infinity;
  let hot = 0;
  for (const g of gameLog) {
    total += g.fantasyPoints;
    if (g.fantasyPoints > high) high = g.fantasyPoints;
    if (g.fantasyPoints < low) low = g.fantasyPoints;
    if (
      g.isHot === true ||
      (g.dailyScore !== undefined && g.dailyScore >= HOT_THRESHOLD)
    ) {
      hot += 1;
    }
  }
  const last7 = gameLog.slice(-7);
  const last30 = gameLog.slice(-30);
  const avg = (arr: PlayerSeasonGameLogEntry[]) =>
    arr.length === 0 ? 0 : arr.reduce((s, g) => s + g.fantasyPoints, 0) / arr.length;
  return {
    fantasyPointsTotal: total,
    gamesPlayed: gameLog.length,
    hotDays: hot,
    seasonHigh: high,
    seasonLow: low,
    last7Avg: avg(last7),
    last30Avg: avg(last30),
  };
}

function trimAndSortGameLog(
  entries: PlayerSeasonGameLogEntry[],
): PlayerSeasonGameLogEntry[] {
  // Dedupe by date (last write wins for the same date — fixes corrections).
  const byDate = new Map<string, PlayerSeasonGameLogEntry>();
  for (const e of entries) byDate.set(e.date, e);
  const sorted = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  // Cap to MAX_GAME_LOG_ENTRIES, drop oldest first.
  return sorted.length > MAX_GAME_LOG_ENTRIES
    ? sorted.slice(sorted.length - MAX_GAME_LOG_ENTRIES)
    : sorted;
}

// ════════════════════════════════════════════════════════════════════════════
// PRIMARY PATH: Cosmos-backed implementation
// ════════════════════════════════════════════════════════════════════════════

async function cosmosGet(
  container: Container,
  playerId: string,
  seasonYear: number,
  phase: SeasonPhase,
): Promise<PlayerSeasonPayload | null> {
  try {
    const { resource } = await container
      .item(playerSeasonDocId(playerId, seasonYear, phase), playerId)
      .read<PlayerSeasonDoc>();
    if (!resource) return null;
    return stripCosmosMeta(resource as unknown as Record<string, unknown>);
  } catch (err: any) {
    if (err?.code === 404) return null;
    throw err;
  }
}

async function cosmosUpsert(
  container: Container,
  payload: PlayerSeasonPayload,
): Promise<void> {
  const doc: PlayerSeasonDoc = {
    id: playerSeasonDocId(payload.playerId, payload.seasonYear, payload.phase),
    docType: DOC_TYPE,
    schemaVersion: SCHEMA_VERSION,
    ...payload,
  };
  await container.items.upsert<PlayerSeasonDoc>(doc);
}

// ════════════════════════════════════════════════════════════════════════════
// FALLBACK PATH: file-backed disk store (local dev + tests only)
// ════════════════════════════════════════════════════════════════════════════

type DiskStore = Record<string, PlayerSeasonPayload>;

function getStorePath(): string {
  return process.env.DAILYIQ_PLAYER_SEASON_STORE_PATH
    ? path.resolve(process.env.DAILYIQ_PLAYER_SEASON_STORE_PATH)
    : path.resolve(process.cwd(), ".data", "dailyiq-player-seasons.json");
}

let _diskCache: DiskStore | null = null;
let _diskOpQueue: Promise<unknown> = Promise.resolve();

async function loadFromDisk(): Promise<DiskStore> {
  const storePath = getStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  let raw: string;
  try {
    raw = await fs.readFile(storePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await fs.writeFile(storePath, "{}", "utf8");
      return {};
    }
    throw err;
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as DiskStore;
    }
    console.warn(
      "[dailyiq.playerSeason] store file is not an object; treating as empty (NOT overwriting)",
    );
    return {};
  } catch (err: any) {
    console.error(
      "[dailyiq.playerSeason] failed to parse store file; keeping file intact for recovery:",
      err?.message ?? err,
    );
    return {};
  }
}

async function persistToDisk(store: DiskStore): Promise<void> {
  const storePath = getStorePath();
  const tmp = `${storePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, storePath);
}

async function withDiskStore<T>(
  fn: (
    store: DiskStore,
  ) => Promise<{ value: T; mutated?: boolean }> | { value: T; mutated?: boolean },
): Promise<T> {
  const next = _diskOpQueue.then(async () => {
    if (!_diskCache) {
      _diskCache = await loadFromDisk();
    }
    const { value, mutated } = await fn(_diskCache);
    if (mutated) {
      await persistToDisk(_diskCache);
    }
    return value;
  });
  _diskOpQueue = next.catch(() => undefined);
  return next;
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

/** Point read by (playerId, seasonYear, phase). Returns null if not found. */
export async function getPlayerSeason(
  playerId: string,
  seasonYear: number,
  phase: SeasonPhase,
): Promise<PlayerSeasonPayload | null> {
  const container = await getContainer();
  if (container) return cosmosGet(container, playerId, seasonYear, phase);
  return withDiskStore<PlayerSeasonPayload | null>((store) => ({
    value: store[playerSeasonDocId(playerId, seasonYear, phase)] ?? null,
  }));
}

/**
 * Upsert the full payload. Recomputes aggregates from gameLog before writing
 * so callers can pass gameLog and trust the aggregates will be correct.
 *
 * Dual-write: when Cosmos is configured, writes to BOTH Cosmos (authoritative)
 * AND .data/dailyiq-player-seasons.json (best-effort) during the warming
 * window. Set DAILYIQ_PLAYER_SEASON_DUAL_WRITE=off to disable disk mirror.
 */
export async function upsertPlayerSeason(
  payload: PlayerSeasonPayload,
): Promise<PlayerSeasonPayload> {
  const cleanLog = trimAndSortGameLog(payload.gameLog ?? []);
  const aggregates = recomputeAggregates(cleanLog);
  const finalized: PlayerSeasonPayload = {
    ...payload,
    gameLog: cleanLog,
    ...aggregates,
    updatedAt: new Date().toISOString(),
  };

  const container = await getContainer();
  if (container) {
    await cosmosUpsert(container, finalized);
    if (process.env.DAILYIQ_PLAYER_SEASON_DUAL_WRITE !== "off") {
      try {
        await withDiskStore<void>((store) => {
          store[
            playerSeasonDocId(finalized.playerId, finalized.seasonYear, finalized.phase)
          ] = finalized;
          return { value: undefined, mutated: true };
        });
      } catch (err: any) {
        console.warn(
          "[dailyiq.playerSeason] dual-write disk mirror failed (Cosmos write already succeeded):",
          err?.message ?? err,
        );
      }
    }
    return finalized;
  }
  await withDiskStore<void>((store) => {
    store[
      playerSeasonDocId(finalized.playerId, finalized.seasonYear, finalized.phase)
    ] = finalized;
    return { value: undefined, mutated: true };
  });
  return finalized;
}

/**
 * Idempotent append of one game-log entry. Reads the current doc, merges the
 * entry by date (overwriting any existing entry for the same date), trims to
 * MAX_GAME_LOG_ENTRIES, recomputes aggregates, and writes back.
 *
 * Concurrent appends for the same (playerId, seasonYear, phase) within the
 * same Node process are serialized via the disk-op queue in fallback mode;
 * in Cosmos mode the upsert is atomic on the doc but two appends racing
 * with the same target doc can produce a last-write-wins outcome. This is
 * acceptable because the nightly ingestion fan-out processes one player at
 * a time per worker.
 */
export async function appendPlayerSeasonGame(
  identity: {
    playerId: string;
    playerName?: string;
    seasonYear: number;
    phase: SeasonPhase;
    sportId?: number;
    teamId?: number;
    position?: string;
  },
  entry: PlayerSeasonGameLogEntry,
): Promise<PlayerSeasonPayload> {
  const existing = await getPlayerSeason(
    identity.playerId,
    identity.seasonYear,
    identity.phase,
  );
  const mergedLog: PlayerSeasonGameLogEntry[] = existing
    ? [...existing.gameLog, entry]
    : [entry];

  const payload: PlayerSeasonPayload = {
    playerId: identity.playerId,
    playerName: identity.playerName ?? existing?.playerName,
    seasonYear: identity.seasonYear,
    phase: identity.phase,
    sportId: identity.sportId ?? existing?.sportId,
    teamId: identity.teamId ?? existing?.teamId,
    position: identity.position ?? existing?.position,
    gameLog: mergedLog,
    // Aggregates and updatedAt are filled by upsertPlayerSeason.
    fantasyPointsTotal: 0,
    gamesPlayed: 0,
    hotDays: 0,
    seasonHigh: 0,
    seasonLow: 0,
    last7Avg: 0,
    last30Avg: 0,
    updatedAt: "",
  };
  return upsertPlayerSeason(payload);
}

/**
 * Test-only helper to reset all in-memory state (Cosmos handle + disk cache).
 * Production code should never call this.
 */
export function __resetPlayerSeasonCacheForTests(): void {
  _container = null;
  _initPromise = null;
  _cosmosDisabled = false;
  _diskCache = null;
  _diskOpQueue = Promise.resolve();
}
