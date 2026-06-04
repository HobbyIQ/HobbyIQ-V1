import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface WatchlistEntryMetadata {
  /** Display name. When the player isn't in PLAYER_POOL, GET /watchlist
   *  synthesizes a profile from these fields so the row still renders. */
  playerName?: string;
  teamName?: string;
  teamAbbreviation?: string;
  league?: "MLB" | "MiLB";
  /** "Triple-A" | "Double-A" | "High-A" | "Single-A" | "Rookie" | null */
  level?: string | null;
  position?: string;
  /** MLB Stats API numeric person id for recent-form lookups. */
  mlbPersonId?: number;
}

export interface WatchlistEntry extends WatchlistEntryMetadata {
  watchlistItemId: string;
  userId: string;
  playerId: string;
  createdAt: string;
}

// ── Storage strategy ────────────────────────────────────────────────────────
// PRIMARY: Cosmos DB container `dailyiq_watchlist`, partition key `/userId`,
// one document per (userId, playerId). This is the only safe store once the
// backend scales beyond a single App Service instance — every replica reads
// and writes the same authoritative copy, and per-(user, player) point
// upserts mean concurrent adds don't race.
//
// FALLBACK: file-backed JSON at `.data/dailyiq-watchlists.json` for local dev
// and tests where Cosmos isn't configured. The fallback uses an in-memory
// cache + mutex + atomic temp-rename to avoid the three bugs that caused
// "add doesn't stick after refresh" with the old file-only implementation.

interface WatchlistDoc extends WatchlistEntry {
  /** Cosmos doc id — deterministic so upserts are idempotent. */
  id: string;
  docType: "dailyiq_watchlist";
}

const DOC_TYPE = "dailyiq_watchlist";

function docIdFor(userId: string, playerId: string): string {
  // Cosmos doc ids cannot contain /, \, ?, #. Hash to stay safe for any
  // future playerId / userId formats.
  const hash = crypto
    .createHash("sha1")
    .update(`${userId}::${playerId}`)
    .digest("hex");
  return `wl_${hash}`;
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
        process.env.COSMOS_DAILYIQ_WATCHLIST_CONTAINER ?? "dailyiq_watchlist";

      if (!endpoint && !connStr) {
        // No Cosmos configured — fall back to the disk store. This is the
        // expected path for local dev and the jest test suite.
        console.log(
          "[dailyiq.watchlist] COSMOS_ENDPOINT/COSMOS_CONNECTION_STRING not set; using file-backed fallback",
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
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log(
        `[dailyiq.watchlist] Cosmos connected (db=${dbName} container=${containerName})`,
      );
      return container;
    } catch (err: any) {
      console.error(
        "[cosmos][dailyiq.watchlist] Cosmos init failed; falling back to disk store:",
        err?.message ?? err,
      );
      _cosmosDisabled = true;
      return null;
    }
  })();

  return _initPromise;
}

function stripCosmosMeta(doc: WatchlistDoc | Record<string, unknown>): WatchlistEntry {
  const {
    id: _id,
    docType: _docType,
    _rid,
    _self,
    _etag,
    _attachments,
    _ts,
    ...entry
  } = doc as Record<string, unknown>;
  return entry as unknown as WatchlistEntry;
}

function stripUndefined(meta: WatchlistEntryMetadata): WatchlistEntryMetadata {
  const out: WatchlistEntryMetadata = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// PRIMARY PATH: Cosmos-backed implementation
// ════════════════════════════════════════════════════════════════════════════

async function cosmosGetEntries(
  container: Container,
  userId: string,
): Promise<WatchlistEntry[]> {
  const { resources } = await container.items
    .query<WatchlistDoc>(
      {
        query: 'SELECT * FROM c WHERE c["userId"] = @uid AND c["docType"] = @t',
        parameters: [
          { name: "@uid", value: userId },
          { name: "@t", value: DOC_TYPE },
        ],
      },
      { partitionKey: userId },
    )
    .fetchAll();
  return resources.map((d) => stripCosmosMeta(d as unknown as Record<string, unknown>));
}

async function cosmosUpsert(
  container: Container,
  userId: string,
  playerId: string,
  metadata: WatchlistEntryMetadata,
): Promise<{ entry: WatchlistEntry; created: boolean }> {
  const id = docIdFor(userId, playerId);
  // Point read inside the partition is the cheapest existence check.
  let existing: WatchlistDoc | null = null;
  try {
    const { resource } = await container.item(id, userId).read<WatchlistDoc>();
    existing = resource ?? null;
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }

  const cleanMeta = stripUndefined(metadata);

  if (existing) {
    const merged: WatchlistDoc = { ...existing, ...cleanMeta };
    const before = stripCosmosMeta(existing as unknown as Record<string, unknown>);
    const after = stripCosmosMeta(merged as unknown as Record<string, unknown>);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { entry: before, created: false };
    }
    const { resource } = await container.items.upsert<WatchlistDoc>(merged);
    return {
      entry: stripCosmosMeta(resource as unknown as Record<string, unknown>),
      created: false,
    };
  }

  const doc: WatchlistDoc = {
    id,
    docType: DOC_TYPE,
    watchlistItemId: crypto.randomUUID(),
    userId,
    playerId,
    createdAt: new Date().toISOString(),
    ...cleanMeta,
  };
  const { resource } = await container.items.create<WatchlistDoc>(doc);
  return {
    entry: stripCosmosMeta(resource as unknown as Record<string, unknown>),
    created: true,
  };
}

async function cosmosRemove(
  container: Container,
  userId: string,
  playerId: string,
): Promise<boolean> {
  const id = docIdFor(userId, playerId);
  try {
    await container.item(id, userId).delete();
    return true;
  } catch (err: any) {
    if (err?.code === 404) return false;
    throw err;
  }
}

async function cosmosAllWatchCounts(container: Container): Promise<Map<string, number>> {
  // We deliberately avoid `SELECT playerId, COUNT(1) GROUP BY playerId` here.
  // On the Node Cosmos SDK v3, that cross-partition aggregation enters an
  // internal microtask-only retry loop after the gateway returns the
  // "cross partition query can not be directly served by the gateway"
  // 400, which starves Node's timer phase. Any `setTimeout`-based timeout
  // wrapping the call will never fire and the request hangs.
  //
  // Instead, we stream raw playerIds page-by-page, aggregate in JS, and
  // `setImmediate`-yield between pages so timers still get to run. An
  // AbortController gives the SDK a hard 8s upper bound.
  const counts = new Map<string, number>();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 8000);
  try {
    const iter = container.items.query<{ playerId: string }>(
      {
        query: 'SELECT c["playerId"] FROM c WHERE c["docType"] = @t',
        parameters: [{ name: "@t", value: DOC_TYPE }],
      },
      { maxItemCount: 500, abortSignal: controller.signal },
    );
    while (iter.hasMoreResults()) {
      const page = await iter.fetchNext();
      const resources = Array.isArray(page?.resources) ? page.resources : [];
      for (const row of resources) {
        if (row?.playerId) counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
      }
      if (resources.length === 0) break;
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    clearTimeout(abortTimer);
  }
  return counts;
}

// ════════════════════════════════════════════════════════════════════════════
// FALLBACK PATH: file-backed disk store (local dev + tests only)
// ════════════════════════════════════════════════════════════════════════════

type DiskStore = Record<string, Record<string, WatchlistEntry>>;

const STORE_PATH = process.env.DAILYIQ_WATCHLIST_STORE_PATH
  ? path.resolve(process.env.DAILYIQ_WATCHLIST_STORE_PATH)
  : path.resolve(process.cwd(), ".data", "dailyiq-watchlists.json");

let _diskCache: DiskStore | null = null;
let _diskOpQueue: Promise<unknown> = Promise.resolve();

async function loadFromDisk(): Promise<DiskStore> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  let raw: string;
  try {
    raw = await fs.readFile(STORE_PATH, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await fs.writeFile(STORE_PATH, "{}", "utf8");
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
      "[dailyiq.watchlist] store file is not an object; treating as empty (NOT overwriting)",
    );
    return {};
  } catch (err: any) {
    console.error(
      "[dailyiq.watchlist] failed to parse store file; keeping file intact for recovery:",
      err?.message ?? err,
    );
    return {};
  }
}

async function persistToDisk(store: DiskStore): Promise<void> {
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
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

function getUserDisk(store: DiskStore, userId: string): Record<string, WatchlistEntry> {
  if (!store[userId]) store[userId] = {};
  return store[userId];
}

// ════════════════════════════════════════════════════════════════════════════
// Public API (signatures unchanged from the original file-only version)
// ════════════════════════════════════════════════════════════════════════════

export async function getWatchlistEntries(userId: string): Promise<WatchlistEntry[]> {
  const container = await getContainer();
  if (container) return cosmosGetEntries(container, userId);
  return withDiskStore((store) => ({
    value: Object.values(getUserDisk(store, userId)),
  }));
}

export async function getWatchlistSet(userId: string): Promise<Set<string>> {
  const container = await getContainer();
  if (container) {
    const entries = await cosmosGetEntries(container, userId);
    return new Set(entries.map((e) => e.playerId));
  }
  return withDiskStore((store) => ({
    value: new Set(Object.keys(getUserDisk(store, userId))),
  }));
}

export async function getAllWatchCounts(): Promise<Map<string, number>> {
  const container = await getContainer();
  if (container) return cosmosAllWatchCounts(container);
  return withDiskStore((store) => {
    const counts = new Map<string, number>();
    for (const userWatchlist of Object.values(store)) {
      for (const entry of Object.values(userWatchlist)) {
        counts.set(entry.playerId, (counts.get(entry.playerId) ?? 0) + 1);
      }
    }
    return { value: counts };
  });
}

export async function upsertWatchlistEntry(
  userId: string,
  playerId: string,
  metadata: WatchlistEntryMetadata = {},
): Promise<{ entry: WatchlistEntry; created: boolean }> {
  const container = await getContainer();
  if (container) return cosmosUpsert(container, userId, playerId, metadata);

  return withDiskStore<{ entry: WatchlistEntry; created: boolean }>((store) => {
    const userWatchlist = getUserDisk(store, userId);
    const existing = userWatchlist[playerId];
    const cleanMeta = stripUndefined(metadata);
    if (existing) {
      const merged: WatchlistEntry = { ...existing, ...cleanMeta };
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        userWatchlist[playerId] = merged;
        return { value: { entry: merged, created: false }, mutated: true };
      }
      return { value: { entry: existing, created: false } };
    }
    const entry: WatchlistEntry = {
      watchlistItemId: crypto.randomUUID(),
      userId,
      playerId,
      createdAt: new Date().toISOString(),
      ...cleanMeta,
    };
    userWatchlist[playerId] = entry;
    return { value: { entry, created: true }, mutated: true };
  });
}

export async function removeWatchlistEntry(
  userId: string,
  playerId: string,
): Promise<boolean> {
  const container = await getContainer();
  if (container) return cosmosRemove(container, userId, playerId);
  return withDiskStore((store) => {
    const userWatchlist = getUserDisk(store, userId);
    if (!userWatchlist[playerId]) return { value: false };
    delete userWatchlist[playerId];
    return { value: true, mutated: true };
  });
}

/**
 * Test-only helper to reset all in-memory state (Cosmos handle + disk cache).
 * Production code should never call this.
 */
/**
 * CF-ACCOUNT-DELETION (2026-06-04): purge all watchlist entries for a user.
 * Single-partition list+delete loop.
 */
export async function deleteAllWatchlistEntriesForUser(userId: string): Promise<number> {
  const entries = await getWatchlistEntries(userId);
  let deleted = 0;
  for (const e of entries) {
    try {
      const ok = await removeWatchlistEntry(userId, e.playerId);
      if (ok) deleted += 1;
    } catch (err: any) {
      console.error("[watchlistStore] deleteAllWatchlistEntriesForUser item failed:", err?.message ?? err);
    }
  }
  return deleted;
}

export function __resetWatchlistCacheForTests(): void {
  _container = null;
  _initPromise = null;
  _cosmosDisabled = false;
  _diskCache = null;
  _diskOpQueue = Promise.resolve();
}
