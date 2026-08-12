// CF-CATALOG-SEED-QUEUE (Drew, 2026-08-12). A catalog verify miss is a
// work order, not an error.
//
// When verifyCardIdentity() can't answer from our own catalog, the honest
// reading is "our checklist for that release is incomplete" — so we record
// the gap here instead of falling back to a vendor. A drainer builds the
// missing checklist into card_catalog, and every later verify of that set
// answers locally, forever. Misses compound into coverage.
//
// Container: `catalog_seed_queue`, partition /sport (same small cardinality
// as card_catalog). Doc id is deterministic — `seed:{sport}:{year}:{setKey}`
// — so a thousand users missing the same release collapse into ONE queue row
// with a requestCount, not a thousand duplicate jobs. That count is also the
// priority signal: the sets users actually hold get built first.
//
// Every failure path is silent and returns false. This runs on user-facing
// request paths (holding confirm) and must never surface an error or add
// latency the user can feel — enqueue failures cost us a seed, not a confirm.

import { CosmosClient, type Container } from "@azure/cosmos";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SEED_QUEUE_CONTAINER =
  process.env.COSMOS_CATALOG_SEED_QUEUE_CONTAINER ?? "catalog_seed_queue";

/** Examples of what was missing, kept for the drainer + admin review.
 *  Capped so a heavily-hit gap can't grow the doc without bound. */
const MAX_SAMPLES = 20;

/** In-process suppression. A single request can miss the same set many
 *  times (a 40-card eBay import of one release); we only need Cosmos to
 *  hear about it once per window. */
const SUPPRESS_TTL_MS = 5 * 60 * 1000;
const SUPPRESS_MAX = 5000;
const recentlyEnqueued = new Map<string, number>();

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(COSMOS_DATABASE)
      .container(SEED_QUEUE_CONTAINER);
    return _container;
  } catch {
    return null;
  }
}

export type SeedStatus = "pending" | "in-progress" | "done" | "failed";

export interface ChecklistSeedRequest {
  sport: string;
  year: number;
  /** Raw set name as the user/vendor spelled it — the drainer searches on this. */
  setName: string;
  /** Normalized key — the dedup axis. */
  setKey: string;
  reason: string;
  missingPlayer?: string;
  missingCardNumber?: string;
}

export interface SeedQueueDoc {
  id: string;
  sport: string;
  year: number;
  setKey: string;
  setName: string;
  status: SeedStatus;
  /** How many distinct verify misses have hit this set — the priority signal. */
  requestCount: number;
  reasons: string[];
  samples: Array<{ player?: string; cardNumber?: string; at: string }>;
  firstRequestedAt: string;
  lastRequestedAt: string;
  /** Set when a completed seed gets missed again — the checklist was partial. */
  reopenedAt?: string;
  completedAt?: string;
  lastError?: string;
}

function seedId(sport: string, year: number, setKey: string): string {
  return `seed:${sport}:${year}:${setKey}`;
}

function suppressed(key: string): boolean {
  const now = Date.now();
  const hit = recentlyEnqueued.get(key);
  if (hit != null && now - hit < SUPPRESS_TTL_MS) return true;
  if (recentlyEnqueued.size >= SUPPRESS_MAX) {
    const oldest = recentlyEnqueued.keys().next().value;
    if (oldest !== undefined) recentlyEnqueued.delete(oldest);
  }
  recentlyEnqueued.set(key, now);
  return false;
}

/**
 * Record (or bump) a request to build a release's checklist.
 *
 * Returns true when the queue row was written. False means the gap went
 * unrecorded — suppressed in-process, disabled, or Cosmos unavailable —
 * and is never an error the caller should react to.
 */
export async function requestChecklistSeed(
  req: ChecklistSeedRequest,
): Promise<boolean> {
  if (process.env.CATALOG_SEED_QUEUE_ENABLED === "false") return false;

  const sport = String(req.sport ?? "").toLowerCase().trim();
  const year = Number(req.year);
  const setKey = String(req.setKey ?? "").trim();
  if (!sport || !year || !setKey) return false;

  const id = seedId(sport, year, setKey);
  if (suppressed(id)) return false;

  const container = await getContainer();
  if (!container) return false;

  const now = new Date().toISOString();
  const sample = {
    player: req.missingPlayer,
    cardNumber: req.missingCardNumber,
    at: now,
  };

  try {
    let existing: SeedQueueDoc | undefined;
    try {
      const read = await container.item(id, sport).read<SeedQueueDoc>();
      existing = read.resource;
    } catch {
      // Not found (or container missing) — fall through to a fresh insert.
    }

    if (existing) {
      const reasons = Array.from(new Set([...(existing.reasons ?? []), req.reason])).slice(0, 10);
      const samples = [...(existing.samples ?? []), sample].slice(-MAX_SAMPLES);
      // A miss against an already-"done" set means the checklist we built
      // was partial — reopen it rather than leaving the gap closed.
      const reopening = existing.status === "done";
      await container.items.upsert<SeedQueueDoc>({
        ...existing,
        setName: existing.setName || req.setName,
        status: reopening ? "pending" : existing.status,
        requestCount: (existing.requestCount ?? 0) + 1,
        reasons,
        samples,
        lastRequestedAt: now,
        ...(reopening ? { reopenedAt: now } : {}),
      });
      return true;
    }

    await container.items.upsert<SeedQueueDoc>({
      id,
      sport,
      year,
      setKey,
      setName: String(req.setName ?? "").trim(),
      status: "pending",
      requestCount: 1,
      reasons: [req.reason],
      samples: [sample],
      firstRequestedAt: now,
      lastRequestedAt: now,
    });
    return true;
  } catch {
    return false;
  }
}

/** Highest-demand pending seeds first. Used by the drainer. */
export async function listPendingSeeds(limit = 50): Promise<SeedQueueDoc[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items.query<SeedQueueDoc>({
      query:
        "SELECT TOP @lim * FROM c WHERE c.status = 'pending' ORDER BY c.requestCount DESC",
      parameters: [{ name: "@lim", value: limit }],
    }).fetchAll();
    return resources ?? [];
  } catch {
    return [];
  }
}

/** Move a queue row through the drain lifecycle. Silent on failure. */
export async function markSeedStatus(
  id: string,
  sport: string,
  status: SeedStatus,
  lastError?: string,
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  try {
    const { resource } = await container.item(id, sport).read<SeedQueueDoc>();
    if (!resource) return;
    await container.items.upsert<SeedQueueDoc>({
      ...resource,
      status,
      ...(status === "done" ? { completedAt: new Date().toISOString() } : {}),
      ...(lastError ? { lastError } : {}),
    });
  } catch {
    /* silent — queue bookkeeping never blocks a drain */
  }
}

/** Test seam — clears the memoized container and suppression window. */
export function __resetSeedQueueForTests(): void {
  _container = null;
  recentlyEnqueued.clear();
}
