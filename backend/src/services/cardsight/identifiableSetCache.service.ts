// CF-SCANNING-B5b (2026-06-03): identifiable-set inventory cache.
//
// Storage: a SINGLE Cosmos doc in container `cardsight_inventory`,
// partition /docType, doc id "identifiable-sets-snapshot". Rationale:
//   - ~2998 records × ~150B serialized = ~450KB → well under Cosmos 2MB
//     per-doc limit.
//   - Refresh = single atomic upsert (can't be in inconsistent state).
//   - Read = single read-through that's cached in-process for 5 min, so
//     per-request cost on the hot pre-flight path is ~O(1) Map lookup.
//   - Filter (segment, year) + paginate done in node — cheap given the
//     fixed 450KB payload.
//
// Why store ALL segments (not just baseball): per Drew's B5 scoping ask,
// future-proof for the multi-sport phase. iOS filters on read via
// `?segment=Baseball` at launch; when multi-sport ships, the same cache
// serves the new clients with zero re-architecting.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import {
  listIdentifiableSets,
  checkSetIdentifiable,
  type CardsightIdentifiableSet,
} from "../compiq/cardsight.client.js";

const DOC_ID = "identifiable-sets-snapshot";
const DOC_TYPE = "identifiable_sets";
const PAGE_SIZE = 50;             // Cardsight pagination cap (empirically 50)
const PAGE_DELAY_MS = 1500;       // polite throttle between pages (free tier)
const IN_PROCESS_CACHE_TTL_MS = 5 * 60 * 1000;

export interface IdentifiableSetsSnapshot {
  id: string;
  docType: string;
  refreshedAt: string;
  totalCount: number;
  segmentCounts: Record<string, number>;
  sets: CardsightIdentifiableSet[];
}

interface InProcessCache {
  snapshot: IdentifiableSetsSnapshot;
  // Pre-built index for O(1) pre-flight lookup. set_id -> always identifiable
  // (presence in this Map means yes; absence means "check live or treat as no").
  setIdIndex: Set<string>;
  cachedAtMs: number;
}

// ─── In-process cache + Cosmos lazy init ────────────────────────────────────

let _cache: InProcessCache | null = null;
let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
const isTestMode = process.env.NODE_ENV === "test";
let _testMemStore: IdentifiableSetsSnapshot | null = null;

function nowMs(): number { return Date.now(); }

function buildIndex(snapshot: IdentifiableSetsSnapshot): Set<string> {
  return new Set(snapshot.sets.map((s) => s.set_id));
}

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName =
        process.env.COSMOS_CARDSIGHT_INVENTORY_CONTAINER ?? "cardsight_inventory";

      if (!endpoint && !connStr) {
        if (isTestMode) {
          console.log("[identifiableSetCache] TEST MODE: using in-memory store");
          return null;
        }
        console.warn("[identifiableSetCache] COSMOS not configured");
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
        partitionKey: { paths: ["/docType"] },
      });
      _container = container;
      console.log("[identifiableSetCache] Cosmos cardsight_inventory ready");
      return container;
    } catch (err: any) {
      console.error(`[cosmos][identifiableSetCache] Cosmos init failed: ${err.message}`);
      return null;
    }
  })();
  return _initPromise;
}

async function readSnapshotFromStore(): Promise<IdentifiableSetsSnapshot | null> {
  const container = await getContainer();
  if (!container) return _testMemStore;
  try {
    const { resource } = await container.item(DOC_ID, DOC_TYPE).read<IdentifiableSetsSnapshot>();
    return resource ?? null;
  } catch {
    return null;
  }
}

async function writeSnapshotToStore(snapshot: IdentifiableSetsSnapshot): Promise<void> {
  const container = await getContainer();
  if (!container) { _testMemStore = snapshot; return; }
  await container.items.upsert(snapshot);
}

async function loadCacheIfNeeded(): Promise<InProcessCache | null> {
  if (_cache && nowMs() - _cache.cachedAtMs < IN_PROCESS_CACHE_TTL_MS) {
    return _cache;
  }
  const snapshot = await readSnapshotFromStore();
  if (!snapshot) return null;
  _cache = {
    snapshot,
    setIdIndex: buildIndex(snapshot),
    cachedAtMs: nowMs(),
  };
  return _cache;
}

/**
 * Force-bust the in-process cache. Tests + the refresh job call this so
 * the next read sees fresh data.
 */
export function invalidateInProcessCache(): void {
  _cache = null;
}

// Test-only escape hatch so unit tests can reset the test mem store
// between cases without re-importing the module.
export function _resetForTests(): void {
  _cache = null;
  _testMemStore = null;
}

// ─── Refresh (called by the daily job) ──────────────────────────────────────

export interface RefreshResult {
  totalCount: number;
  segmentCounts: Record<string, number>;
  pagesFetched: number;
  durationMs: number;
  refreshedAt: string;
}

function computeSegmentCounts(
  sets: ReadonlyArray<CardsightIdentifiableSet>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sets) {
    const seg = s.segment_name || "<unknown>";
    counts[seg] = (counts[seg] ?? 0) + 1;
  }
  return counts;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Paginate the full identifiable-set inventory from Cardsight and upsert
 * the single snapshot doc. Logs segment counts on success (doubles as a
 * coverage check — segment drift between refreshes is a useful smell).
 *
 * Polite throttle: PAGE_DELAY_MS between pages to stay under Cardsight's
 * burst rate-limit even at the free tier. The client's fetchWithRetry
 * handles 429 backoff if it slips through anyway.
 */
export async function refreshIdentifiableSetInventory(opts?: {
  refreshedAt?: string;          // injectable for tests (avoid Date.now drift)
  delayMsBetweenPages?: number;  // injectable for tests
}): Promise<RefreshResult> {
  const start = nowMs();
  const refreshedAt = opts?.refreshedAt ?? new Date().toISOString();
  const pageDelayMs = opts?.delayMsBetweenPages ?? PAGE_DELAY_MS;
  const all: CardsightIdentifiableSet[] = [];
  let skip = 0;
  let pagesFetched = 0;
  let totalCount = 0;

  while (true) {
    const page = await listIdentifiableSets({ skip, take: PAGE_SIZE });
    pagesFetched += 1;
    totalCount = page.total_count;
    if (page.sets.length === 0) break;
    all.push(...page.sets);
    if (all.length >= totalCount) break;
    skip += PAGE_SIZE;
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }

  const segmentCounts = computeSegmentCounts(all);
  const snapshot: IdentifiableSetsSnapshot = {
    id: DOC_ID,
    docType: DOC_TYPE,
    refreshedAt,
    totalCount: all.length,
    segmentCounts,
    sets: all,
  };
  await writeSnapshotToStore(snapshot);
  invalidateInProcessCache();

  const durationMs = nowMs() - start;
  // The segment-count log doubles as a coverage snapshot — easy to grep
  // for drift over time (e.g. Baseball share rising, Pokemon dropping).
  console.log(
    `[identifiableSetCache] refresh complete pages=${pagesFetched} total=${all.length} ` +
    `durationMs=${durationMs} segments=${JSON.stringify(segmentCounts)}`,
  );

  return {
    totalCount: all.length,
    segmentCounts,
    pagesFetched,
    durationMs,
    refreshedAt,
  };
}

// ─── Read API used by the routes layer ──────────────────────────────────────

export interface IdentifiableSetsReadResult {
  refreshedAt: string | null;
  totalCount: number;          // total ACROSS all segments in the snapshot
  segmentCount: number;        // count WITHIN the requested segment filter (or total if no filter)
  skip: number;
  take: number;
  sets: CardsightIdentifiableSet[];
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 500;

function applyFiltersAndPagination(
  snapshot: IdentifiableSetsSnapshot,
  opts: { segment?: string; skip?: number; take?: number },
): IdentifiableSetsReadResult {
  const skip = Math.max(0, opts.skip ?? 0);
  const take = Math.min(MAX_TAKE, Math.max(1, opts.take ?? DEFAULT_TAKE));
  const segmentLower = opts.segment?.toLowerCase().trim();
  const filtered = segmentLower
    ? snapshot.sets.filter((s) => s.segment_name.toLowerCase() === segmentLower)
    : snapshot.sets;
  return {
    refreshedAt: snapshot.refreshedAt,
    totalCount: snapshot.totalCount,
    segmentCount: filtered.length,
    skip,
    take,
    sets: filtered.slice(skip, skip + take),
  };
}

/**
 * Read endpoint backing GET /api/portfolio/identifiable-sets. Returns the
 * snapshot's set list, optionally filtered by segment_name. Empty result
 * shape returned when the snapshot doesn't exist yet (pre-first-refresh
 * state on a fresh deploy).
 */
export async function getIdentifiableSets(
  opts: { segment?: string; skip?: number; take?: number } = {},
): Promise<IdentifiableSetsReadResult> {
  const cache = await loadCacheIfNeeded();
  if (!cache) {
    return {
      refreshedAt: null,
      totalCount: 0,
      segmentCount: 0,
      skip: opts.skip ?? 0,
      take: opts.take ?? DEFAULT_TAKE,
      sets: [],
    };
  }
  return applyFiltersAndPagination(cache.snapshot, opts);
}

export type PreflightSource = "cache" | "live" | "unknown";

export interface PreflightResult {
  setId: string;
  supported: boolean;
  source: PreflightSource;
}

/**
 * Pre-flight cache lookup + live fallback. Hot path — iOS hits this
 * before every scan attempt.
 *
 * CF-SCANNING-B5-FIXES (2026-06-03): the indeterminate branch FAILS
 * OPEN. supported=false is now an explicit negative ("Cardsight
 * confirms not identifiable") — only ever from source="cache" or
 * source="live". When we genuinely can't determine support (cache cold
 * AND live check returned null / threw), supported=true with
 * source="unknown" so naive iOS (`if (!supported) warn`) doesn't
 * spuriously block scans during a Cardsight outage. iOS may treat
 * source="unknown" as a footnote ("couldn't pre-verify") if it wants.
 *
 *   cache hit + present:  supported=true,  source="cache"
 *   cache hit + missing:  supported=false, source="cache"  (snapshot is
 *                         authoritative once loaded; the set is genuinely
 *                         not in Cardsight's identifiable inventory)
 *   cache absent:         falls back to live checkSetIdentifiable():
 *     live ok (true):     supported=true,  source="live"
 *     live ok (false):    supported=false, source="live"  (Cardsight
 *                         confirmed: not identifiable)
 *     live null (no-key): supported=true,  source="unknown" (fail open)
 *     live threw:         supported=true,  source="unknown" (fail open)
 */
export async function isSetIdentifiable(setId: string): Promise<PreflightResult> {
  const cache = await loadCacheIfNeeded();
  if (cache) {
    return {
      setId,
      supported: cache.setIdIndex.has(setId),
      source: "cache",
    };
  }
  // No snapshot yet (fresh deploy, pre-first-refresh). Fall back to live.
  try {
    const live = await checkSetIdentifiable(setId);
    if (live === null) {
      // Fail open: we can't determine, so let iOS attempt the scan
      // rather than spuriously rejecting it.
      return { setId, supported: true, source: "unknown" };
    }
    return { setId, supported: live.is_identifiable, source: "live" };
  } catch (err: unknown) {
    console.warn(
      `[identifiableSetCache] live preflight failed for setId=${setId}:`,
      err instanceof Error ? err.message : String(err),
    );
    // Fail open: a Cardsight outage shouldn't take down scanning.
    return { setId, supported: true, source: "unknown" };
  }
}
