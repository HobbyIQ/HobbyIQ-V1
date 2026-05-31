// CF-PREDICTION-CORPUS STEP 3 — write-completeness health counter.
//
// Per methodology §2.6: Cosmos-native counter (NOT App Insights — the
// platform retention gap per CF-PLATFORM-OBSERVABILITY-RETENTION makes
// any AI-based observability useless for >30min-old data).
//
// Tracks per-replica per-day:
//   attempts        — how many write attempts the corpus writer issued
//                     (post-rate-limit-dedup, pre-async-write)
//   successes       — how many of those resolved successfully
//   failures        — { count, lastError, lastErrorAt } summary
//   joinableCount   — attempts where input had a real cardsightCardId
//   unresolvedCount — attempts where input was null (sentinel partition)
//
// joinableRate (= joinableCount / attempts) is MANDATORY-not-optional
// reporting alongside lossRate per Drew's STEP 3 lock — it bounds the
// accuracy-claimable subset, so we need it observable from day one.
//
// PATTERN: in-process counter buffer + 30s batched Cosmos patch per
// replica. Never a per-write Cosmos roundtrip (keeps it OFF the
// prediction latency path). Lossy-on-crash (<30s of counter increments)
// acceptable per methodology §2.6 "drift alarm, NOT exact audit" framing
// — both this counter and the writer have independent loss modes so
// derived rates are approximate.
//
// FIRE-AND-FORGET / NEVER-THROWS: same discipline as the writer.
// Counter increments cannot throw into the prediction critical path.
//
// POINT-PATCH per methodology §2.6: this whole service exists as
// debt accrued against the platform retention hole. Once
// CF-PLATFORM-OBSERVABILITY-RETENTION lands, App Insights customEvents
// become viable for this kind of telemetry and this service collapses
// to "emit customEvent on attempt/success/failure; KQL the rate."

import os from "os";
import { CosmosClient, type Container, type PatchOperation } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

// ─── Constants ────────────────────────────────────────────────────────────

const DB_NAME = process.env.COSMOS_DB ?? process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_NAME =
  process.env.COSMOS_PREDICTION_CORPUS_HEALTH_CONTAINER ??
  "prediction_corpus_health";

const FLUSH_INTERVAL_MS = 30_000; // 30s batched flush per replica
const ERROR_LOG_THROTTLE_MS = 60_000;
const MAX_ERROR_MSG_LEN = 500; // truncate lastError to bound doc size

/**
 * Replica identifier — used as the per-replica suffix in the doc id so
 * each App Service instance's counters don't clobber each other.
 *
 * Azure App Service sets `WEBSITE_INSTANCE_ID` per replica. Local dev
 * falls back to OS hostname; last-ditch fallback to "unknown".
 */
const REPLICA_ID =
  process.env.WEBSITE_INSTANCE_ID ?? os.hostname() ?? "unknown";

// ─── In-process counter buffer ────────────────────────────────────────────

interface CounterBuffer {
  attempts: number;
  successes: number;
  joinableCount: number;
  unresolvedCount: number;
  failuresCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  firstAttemptAt: string | null;
}

function emptyBuffer(): CounterBuffer {
  return {
    attempts: 0,
    successes: 0,
    joinableCount: 0,
    unresolvedCount: 0,
    failuresCount: 0,
    lastError: null,
    lastErrorAt: null,
    firstAttemptAt: null,
  };
}

let buffer: CounterBuffer = emptyBuffer();

// ─── Cosmos init (lazy, mirrors trendHistory.service.ts pattern) ─────────

let cachedContainer: Container | null = null;
let initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const conn = process.env.COSMOS_CONNECTION_STRING;
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;

      let client: CosmosClient | null = null;
      if (conn) {
        client = new CosmosClient(conn);
      } else if (endpoint && key) {
        client = new CosmosClient({ endpoint, key });
      } else if (endpoint) {
        client = new CosmosClient({
          endpoint,
          aadCredentials: new DefaultAzureCredential(),
        });
      } else {
        return null;
      }

      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ["/date"] },
      });
      cachedContainer = container;
      return container;
    } catch (err) {
      console.warn(
        "[predictionCorpusHealth] init failed:",
        (err as Error).message,
      );
      return null;
    }
  })();

  return initPromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function todayUtcIsoDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

let lastErrorLogMs = 0;
function logErrorThrottled(prefix: string, err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogMs >= ERROR_LOG_THROTTLE_MS) {
    lastErrorLogMs = now;
    console.warn(
      prefix,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── Public counter API (called by predictionCorpus.service.ts) ──────────

/**
 * Record a write-attempt by the corpus writer. Increments attempts +
 * either joinableCount (real Cardsight UUID) or unresolvedCount (sentinel).
 *
 * Fire-and-forget; never throws. Single-threaded Node event loop makes
 * the increments atomic relative to the flush function.
 */
export function recordAttempt(joinable: boolean): void {
  buffer.attempts += 1;
  if (joinable) buffer.joinableCount += 1;
  else buffer.unresolvedCount += 1;
  if (buffer.firstAttemptAt == null) buffer.firstAttemptAt = nowIso();
}

/**
 * Record a successful Cosmos write resolution. Increments successes.
 */
export function recordSuccess(): void {
  buffer.successes += 1;
}

/**
 * Record a failed Cosmos write resolution. Increments failures.count +
 * captures the error message (truncated) + timestamp for diagnostic.
 * Only the LAST error within a flush window is kept (intentional: bounds
 * doc size; lossRate detects scale of problem, lastError detects shape).
 */
export function recordFailure(err: unknown): void {
  buffer.failuresCount += 1;
  buffer.lastError = truncate(
    err instanceof Error ? err.message : String(err),
    MAX_ERROR_MSG_LEN,
  );
  buffer.lastErrorAt = nowIso();
}

// ─── Periodic flush ───────────────────────────────────────────────────────

/**
 * Flush the in-process buffer to Cosmos as ONE batched patch (or create
 * if doc doesn't exist yet). Captures + resets the buffer atomically
 * relative to incoming increments (single-threaded JS).
 *
 * Never throws. Errors swallowed with throttled log. Lossy-on-init-or-
 * write-failure: the captured snapshot is dropped, the buffer keeps
 * accumulating from the new attempts — methodology §2.6 lossy-on-crash
 * <30s acceptable framing applies here too.
 *
 * Exposed (not _private) only so an init/shutdown caller could trigger
 * a final flush. The 30s setInterval is the primary driver.
 */
export async function flushPredictionCorpusHealth(): Promise<void> {
  // Capture + reset atomically (JS event loop guarantees no interleave).
  if (buffer.attempts === 0 && buffer.failuresCount === 0) return;
  const snapshot = buffer;
  buffer = emptyBuffer();

  try {
    const container = await getContainer();
    if (!container) {
      // Cosmos unavailable; drop the snapshot. Next flush window's
      // counters re-accumulate.
      return;
    }

    const date = todayUtcIsoDate();
    const docId = `${date}_${REPLICA_ID}`;

    // Try patch first (doc already exists). Falls back to create on 404.
    const patchOps: PatchOperation[] = [
      { op: "incr", path: "/attempts", value: snapshot.attempts },
      { op: "incr", path: "/successes", value: snapshot.successes },
      { op: "incr", path: "/joinableCount", value: snapshot.joinableCount },
      { op: "incr", path: "/unresolvedCount", value: snapshot.unresolvedCount },
      { op: "incr", path: "/failures/count", value: snapshot.failuresCount },
      { op: "set", path: "/lastUpdatedAt", value: nowIso() },
    ];
    if (snapshot.lastError != null) {
      patchOps.push({ op: "set", path: "/failures/lastError", value: snapshot.lastError });
      patchOps.push({ op: "set", path: "/failures/lastErrorAt", value: snapshot.lastErrorAt });
    }

    try {
      await container.item(docId, date).patch(patchOps);
    } catch (patchErr: unknown) {
      // 404 = doc doesn't exist yet (first flush of the day on this replica).
      // Create with snapshot values as initial state.
      //
      // KNOWN EDGE CASE (accepted): if two flushes overlap on the FIRST flush
      // of the day for the same replica (rare — requires the first flush's
      // Cosmos call to be slow enough that the next 30s setInterval tick
      // fires while it's still in-flight), both flushes get 404 on PATCH and
      // both try CREATE; second hits 409 which falls through to the outer
      // catch + throttled-warn. The lost snapshot is bounded by methodology
      // §2.6 "lossy-on-crash <30s acceptable" envelope. Hardening = wrap
      // the CREATE in another try/catch that falls back to PATCH on 409.
      // Left as-is for v1 per Drew's STEP 3 ship — accepted edge case,
      // not a blocker. Future hardening lives with CF-CORPUS-HEALTH-EXPLICIT-INIT
      // refactor if/when that lands.
      const statusCode =
        (patchErr as { code?: number; statusCode?: number } | null)?.code ??
        (patchErr as { code?: number; statusCode?: number } | null)?.statusCode;
      if (statusCode === 404) {
        await container.items.create({
          id: docId,
          date,
          replicaId: REPLICA_ID,
          attempts: snapshot.attempts,
          successes: snapshot.successes,
          joinableCount: snapshot.joinableCount,
          unresolvedCount: snapshot.unresolvedCount,
          failures: {
            count: snapshot.failuresCount,
            lastError: snapshot.lastError,
            lastErrorAt: snapshot.lastErrorAt,
          },
          firstAttemptAt: snapshot.firstAttemptAt ?? nowIso(),
          lastUpdatedAt: nowIso(),
        });
      } else {
        throw patchErr;
      }
    }
  } catch (err) {
    logErrorThrottled("[predictionCorpusHealth] flush failed:", err);
  }
}

// ─── Auto-start the flush interval (skip in test env) ─────────────────────

/**
 * Skip the auto-start interval when running under Vitest — tests that
 * mock predictionCorpus.service or otherwise never expect background
 * timers shouldn't have to deal with one. Production / dev runtime
 * starts the interval at module load.
 */
const IS_TEST = process.env.VITEST != null || process.env.NODE_ENV === "test";

if (!IS_TEST) {
  // Detached interval. Unref so it doesn't keep the event loop alive
  // beyond the rest of the process (matters for short-lived scripts /
  // graceful shutdown signals).
  const handle = setInterval(() => {
    void flushPredictionCorpusHealth();
  }, FLUSH_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
}
