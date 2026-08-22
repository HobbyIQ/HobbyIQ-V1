// CF-CH-HISTORICAL-BACKFILL (Drew, 2026-08-14). Persisted cursor for
// the CH historical day-walk.
//
// Stored in ch_daily_sales alongside the existing per-date ingest
// checkpoints (same `card_id: "_checkpoint"` logical partition), under
// a distinct id namespace so the two never collide:
//
//     checkpoint::{fileDate}      <- per-day daily-ingest checkpoint
//     histbackfill::cursor        <- this, a single moving cursor
//
// ttl: -1 IS LOAD-BEARING. The ch_daily_sales container is created with
// defaultTtl = 365 days. A cursor doc written without an explicit
// override inherits that and silently disappears after a year — which
// would present as the backfill quietly restarting from the retention
// cutoff and re-walking ~600 days. Cosmos treats a per-item ttl of -1
// as "never expire", overriding the container default.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const CURSOR_ID = "histbackfill::cursor";
const CURSOR_PARTITION = "_checkpoint";

export interface BackfillCursor {
  id: string;
  card_id: string;
  /** Last file_date processed end-to-end. Resume at the NEXT day. */
  lastCompletedDate: string;
  updatedAt: string;
  /** Running totals across the whole backfill, for progress reporting. */
  cumulativeRowsWritten: number;
  cumulativeRowsParsed: number;
  cumulativeDays: number;
  /** Never expire — see header. */
  ttl: number;
  /**
   * CF-CH-BACKFILL-POISON-PILL (2026-08-22). The date currently blocking
   * the walk, and how many consecutive runs it has blocked it.
   *
   * Holding the cursor on a failed day is correct for a TRANSIENT failure —
   * skipping it would leave a hole nothing goes back for. It is not correct
   * forever: CardHedge returned HTTP 500 for 2025-10-08, the run died in
   * 0.9s holding the cursor, and it did that on every scheduled run from
   * 2026-08-19 onward. Zero rows ingested for three days because one date
   * upstream is permanently unavailable.
   */
  blockedDate?: string | null;
  blockedAttempts?: number;
  blockedFirstSeenAt?: string | null;
  blockedLastError?: string | null;
  /**
   * Dates given up on after MAX_BLOCKED_ATTEMPTS and stepped over.
   *
   * This list is the thing that "goes back for them" — the concern the
   * original hold-the-cursor comment raised. A quarantined day is a KNOWN,
   * recorded hole, which is the opposite of silently skipping past it.
   */
  quarantinedDates?: string[];
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      // Read-only handle to an existing container — do NOT createIfNotExists
      // here; the daily-ingest store owns the container definition and a
      // second creator racing it can disagree on TTL/partition settings.
      _container = client.database(dbName).container(containerId);
      return _container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ch_histbackfill_cursor_init_failed",
        source: "chHistoricalBackfillStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

export async function readBackfillCursor(): Promise<BackfillCursor | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item(CURSOR_ID, CURSOR_PARTITION).read<BackfillCursor>();
    return resource ?? null;
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) return null;
    console.warn(JSON.stringify({
      event: "ch_histbackfill_cursor_read_error",
      source: "chHistoricalBackfillStore.service",
      error: err?.message ?? String(err),
    }));
    return null;
  }
}

/**
 * Advance the cursor. Called only after a day completes end-to-end.
 *
 * Read-modify-write on the cumulative counters. This is a single-writer
 * cursor by construction (one scheduled job), so no optimistic-
 * concurrency guard is warranted; if that ever changes, add an etag
 * precondition here rather than hoping.
 */
export async function writeBackfillCursor(update: {
  lastCompletedDate: string;
  rowsWritten: number;
  rowsParsed: number;
  // CF-CH-BACKFILL-POISON-PILL (2026-08-22). Optional so every existing
  // call site keeps working unchanged; absent means "leave as-is".
  blockedDate?: string | null;
  blockedAttempts?: number;
  blockedFirstSeenAt?: string | null;
  blockedLastError?: string | null;
  quarantinedDates?: string[];
}): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  const prior = await readBackfillCursor();
  const doc: BackfillCursor = {
    id: CURSOR_ID,
    card_id: CURSOR_PARTITION,
    lastCompletedDate: update.lastCompletedDate,
    updatedAt: new Date().toISOString(),
    cumulativeRowsWritten: (prior?.cumulativeRowsWritten ?? 0) + update.rowsWritten,
    cumulativeRowsParsed: (prior?.cumulativeRowsParsed ?? 0) + update.rowsParsed,
    // Undefined means "unchanged", so a normal successful-day write does not
    // wipe an in-progress block record.
    blockedDate: update.blockedDate !== undefined ? update.blockedDate : (prior?.blockedDate ?? null),
    blockedAttempts: update.blockedAttempts !== undefined ? update.blockedAttempts : (prior?.blockedAttempts ?? 0),
    blockedFirstSeenAt: update.blockedFirstSeenAt !== undefined ? update.blockedFirstSeenAt : (prior?.blockedFirstSeenAt ?? null),
    blockedLastError: update.blockedLastError !== undefined ? update.blockedLastError : (prior?.blockedLastError ?? null),
    quarantinedDates: update.quarantinedDates !== undefined ? update.quarantinedDates : (prior?.quarantinedDates ?? []),
    cumulativeDays: (prior?.cumulativeDays ?? 0) + 1,
    ttl: -1,
  };
  try {
    await c.items.upsert(doc);
  } catch (err: any) {
    // A failed cursor write is serious: the day's rows are already in
    // the pool, so a silent failure means the next run re-walks the day.
    // That is idempotent (contentHash dedup) but wastes a quota day, so
    // it must be loud.
    console.error(JSON.stringify({
      event: "ch_histbackfill_cursor_write_failed",
      source: "chHistoricalBackfillStore.service",
      lastCompletedDate: update.lastCompletedDate,
      error: err?.message ?? String(err),
    }));
    throw err;
  }
}

/** Reset the cursor. Deliberately explicit — used by ops, not by the job. */
export async function clearBackfillCursor(): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  try {
    await c.item(CURSOR_ID, CURSOR_PARTITION).delete();
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) return;
    throw err;
  }
}

/** Test seam. */
export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
