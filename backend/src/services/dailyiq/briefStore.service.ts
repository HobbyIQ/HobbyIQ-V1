import { promises as fs } from "fs";
import path from "path";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

// ── Public types (UNCHANGED — consumers in dailyiq.routes.ts depend on these)
export interface PersistedBriefPayload<TPlayer = unknown> {
  date: string;
  generatedAt: string;
  mlb: TPlayer[];
  milb: TPlayer[];
}

// ── Storage strategy ────────────────────────────────────────────────────────
// PRIMARY: Cosmos DB container `dailyiq_briefs`, partition key `/date`,
//   one document per slate date. Doc id = the date string. Point read on
//   id+partition is O(1) and how the "today's slate" and "hot 4 of last 7
//   days" queries resolve (the latter being 7 parallel point reads).
//
// FALLBACK: file-backed JSON at `.data/dailyiq-briefs.json` for local dev
//   and tests where Cosmos isn't configured. Mirrors the watchlistStore
//   safety pattern: in-memory cache + serial op queue + atomic temp-rename
//   on write, never auto-blank the file on parse failure.
//
// Public API is IDENTICAL to the prior file-only implementation. Consumers
// (only `dailyiq.routes.ts` today) need no changes.

const DOC_TYPE = "dailyiq_brief";
const SCHEMA_VERSION = 1;

interface BriefDoc<TPlayer = unknown> extends PersistedBriefPayload<TPlayer> {
  id: string;
  docType: typeof DOC_TYPE;
  schemaVersion: number;
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
        process.env.COSMOS_DAILYIQ_BRIEFS_CONTAINER ?? "dailyiq_briefs";

      if (!endpoint && !connStr) {
        console.log(
          "[dailyiq.briefs] COSMOS_ENDPOINT/COSMOS_CONNECTION_STRING not set; using file-backed fallback",
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
        partitionKey: { paths: ["/date"] },
      });
      _container = container;
      console.log(
        `[dailyiq.briefs] Cosmos connected (db=${dbName} container=${containerName})`,
      );
      return container;
    } catch (err: any) {
      console.error(
        "[dailyiq.briefs] Cosmos init failed; falling back to disk store:",
        err?.message ?? err,
      );
      _cosmosDisabled = true;
      return null;
    }
  })();

  return _initPromise;
}

function stripCosmosMeta<TPlayer>(
  doc: Record<string, unknown>,
): PersistedBriefPayload<TPlayer> {
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
  return rest as unknown as PersistedBriefPayload<TPlayer>;
}

// ════════════════════════════════════════════════════════════════════════════
// PRIMARY PATH: Cosmos-backed implementation
// ════════════════════════════════════════════════════════════════════════════

async function cosmosGetBrief<TPlayer>(
  container: Container,
  date: string,
): Promise<PersistedBriefPayload<TPlayer> | null> {
  try {
    const { resource } = await container.item(date, date).read<BriefDoc<TPlayer>>();
    if (!resource) return null;
    return stripCosmosMeta<TPlayer>(resource as unknown as Record<string, unknown>);
  } catch (err: any) {
    if (err?.code === 404) return null;
    throw err;
  }
}

async function cosmosUpsertBrief<TPlayer>(
  container: Container,
  payload: PersistedBriefPayload<TPlayer>,
): Promise<void> {
  const doc: BriefDoc<TPlayer> = {
    id: payload.date,
    docType: DOC_TYPE,
    schemaVersion: SCHEMA_VERSION,
    ...payload,
  };
  await container.items.upsert<BriefDoc<TPlayer>>(doc);
}

// ════════════════════════════════════════════════════════════════════════════
// FALLBACK PATH: file-backed disk store (local dev + tests only)
// ════════════════════════════════════════════════════════════════════════════

type DiskStore<TPlayer = unknown> = Record<string, PersistedBriefPayload<TPlayer>>;

const STORE_PATH = process.env.DAILYIQ_BRIEF_STORE_PATH
  ? path.resolve(process.env.DAILYIQ_BRIEF_STORE_PATH)
  : path.resolve(process.cwd(), ".data", "dailyiq-briefs.json");

let _diskCache: DiskStore | null = null;
let _diskOpQueue: Promise<unknown> = Promise.resolve();

async function loadFromDisk<TPlayer = unknown>(): Promise<DiskStore<TPlayer>> {
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
      return parsed as DiskStore<TPlayer>;
    }
    console.warn(
      "[dailyiq.briefs] store file is not an object; treating as empty (NOT overwriting)",
    );
    return {};
  } catch (err: any) {
    console.error(
      "[dailyiq.briefs] failed to parse store file; keeping file intact for recovery:",
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

// ════════════════════════════════════════════════════════════════════════════
// Public API (signatures UNCHANGED from prior file-only version)
// ════════════════════════════════════════════════════════════════════════════

export async function getPersistedBriefByDate<TPlayer = unknown>(
  date: string,
): Promise<PersistedBriefPayload<TPlayer> | null> {
  const container = await getContainer();
  if (container) return cosmosGetBrief<TPlayer>(container, date);
  return withDiskStore<PersistedBriefPayload<TPlayer> | null>((store) => ({
    value: (store as DiskStore<TPlayer>)[date] ?? null,
  }));
}

/**
 * Dual-write during the warming window: when Cosmos is configured, this
 * writes the brief to BOTH Cosmos (authoritative, errors propagate) AND
 * the disk store (best-effort, errors logged). The dual-write lets an
 * operator verify equivalence between Cosmos and the legacy .data file
 * during the 7-day warming period before the file-backed path is removed.
 *
 * Set `DAILYIQ_BRIEFS_DUAL_WRITE=off` to disable disk writes once Cosmos
 * is validated as the source of truth.
 */
export async function upsertPersistedBrief<TPlayer = unknown>(
  payload: PersistedBriefPayload<TPlayer>,
): Promise<void> {
  const container = await getContainer();
  if (container) {
    await cosmosUpsertBrief<TPlayer>(container, payload);
    if (process.env.DAILYIQ_BRIEFS_DUAL_WRITE !== "off") {
      try {
        await withDiskStore<void>((store) => {
          (store as DiskStore<TPlayer>)[payload.date] = payload;
          return { value: undefined, mutated: true };
        });
      } catch (err: any) {
        console.warn(
          "[dailyiq.briefs] dual-write disk mirror failed (Cosmos write already succeeded):",
          err?.message ?? err,
        );
      }
    }
    return;
  }
  await withDiskStore<void>((store) => {
    (store as DiskStore<TPlayer>)[payload.date] = payload;
    return { value: undefined, mutated: true };
  });
}

/**
 * Test-only helper to reset all in-memory state (Cosmos handle + disk cache).
 * Production code should never call this.
 */
export function __resetBriefCacheForTests(): void {
  _container = null;
  _initPromise = null;
  _cosmosDisabled = false;
  _diskCache = null;
  _diskOpQueue = Promise.resolve();
}
