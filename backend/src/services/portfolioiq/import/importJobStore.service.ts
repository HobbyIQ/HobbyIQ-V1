// CF-IMPORT-ASYNC (2026-06-21): import-job document store.
//
// Substrate decision (per step 1 storage recon):
//   - writeUserDoc uses blind upsert (no _etag check) — sharing the user
//     doc with a 4-minute import job would race against concurrent
//     holding writes (autoPriceHolding / repriceHoldingsForUser).
//   - Combined doc could approach Cosmos's 2MB per-doc limit at the v1
//     500-1000 row cap (envelopes ~1-1.5 KB each + investor+ multi-MB
//     existing user docs).
//
// Resolution: separate doc in the same `portfolio` container. Partition
// key is /userId (same as user doc), id is "import-job-<jobId>". The two
// doc types coexist with zero contention and each get their own 2MB
// headroom. Status-poll reads the job doc; concurrent commits read the
// user doc; the in-process job Promise writes only the job doc.

import type { Container } from "@azure/cosmos";
import {
  getPortfolioContainer,
  isPortfolioTestMode,
} from "../portfolioStore.service.js";
import type { ImportRowEnvelope } from "./resolveBatch.js";

export type ImportJobStatus = "pending" | "processing" | "ready" | "failed" | "stale";

export interface ImportJobProgress {
  /** Rows resolved so far. */
  rowsProcessed: number;
  /** Total rows the job will process. */
  rowsTotal: number;
  /** ISO timestamp of last progress write. Staleness check reads this. */
  lastProgressAt: string;
}

export interface ImportJobDoc {
  /** Cosmos doc id: "import-job-<jobId>". */
  id: string;
  /** Partition key (matches the user's portfolio doc partition). */
  userId: string;
  /** The job id callers poll on. */
  jobId: string;
  status: ImportJobStatus;
  progress: ImportJobProgress;
  /**
   * CF-IMPORT-ASYNC (2026-06-21): per-doc TTL in seconds. Cosmos auto-
   * deletes the doc when this elapses after `_ts` (last modified).
   *
   * Container must have `defaultTtl: -1` ("enabled, no default") — set on
   * the prod portfolio container 2026-06-21. The container also holds
   * the permanent user holdings docs, which carry NO `ttl` property and
   * are therefore immune to expiration (verified pre-change: 0/4 user
   * docs had a `ttl` field; `-1` means "no default", so only docs that
   * explicitly set `ttl` expire).
   *
   * 24h: longer than the slowest expected job lifetime + a generous
   * client-poll-after-ready buffer, shorter than the days envelope state
   * stays useful. Adjust upward if telemetry shows users polling past
   * 24h to retrieve resolved envelopes.
   */
  ttl: number;
  /** Populated when status === "ready". */
  envelopes?: ImportRowEnvelope[];
  /** Auto-map proposal mirrored from the preview parse step. */
  proposedMapping?: Record<string, string | null>;
  unmappedHeaders?: string[];
  /** Capacity projection mirrored from the preview, computed at kick-off. */
  capacityProjectionAtKickoff?: {
    currentCount: number;
    cap: number | null;
    wouldBeTotal: number;
    wouldExceed: boolean;
  };
  /** Bucket counts + isRoundTrip + totalRows mirror the preview summary. */
  summaryAtReady?: {
    totalRows: number;
    isRoundTrip: boolean;
    bucketCounts: Record<string, number>;
    defaultCommitCount: number;
  };
  /** Failure reason when status === "failed". */
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * CF-IMPORT-ASYNC (2026-06-21): staleness threshold. A job stuck in
 * "processing" with no progress write in this many milliseconds is
 * declared stale on the next status read. Choice: 10 minutes — longer
 * than the slowest expected 1000-row job (~8 min at 4-way × ~2 req/s)
 * but short enough that a stuck/dead job surfaces fast.
 */
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Throttle for progress writes. Avoids hammering Cosmos every row;
 * status poll reads a slightly-stale value but never more than this old.
 */
export const PROGRESS_WRITE_THROTTLE_MS = 5_000;

/**
 * CF-IMPORT-ASYNC (2026-06-21): per-doc TTL applied to every
 * ImportJobDoc — 24h after last modification (Cosmos `_ts`). See the
 * `ttl` field comment in ImportJobDoc for the safety rationale.
 */
export const IMPORT_JOB_TTL_SECONDS = 24 * 60 * 60;

function jobDocId(jobId: string): string {
  return `import-job-${jobId}`;
}

// ─── Test-mode in-memory store ──────────────────────────────────────────

const testMemStore = new Map<string, ImportJobDoc>(); // keyed by docId

function testKey(userId: string, jobId: string): string {
  return `${userId}::${jobDocId(jobId)}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function readImportJob(userId: string, jobId: string): Promise<ImportJobDoc | null> {
  const container: Container | null = await getPortfolioContainer();
  if (!container && isPortfolioTestMode) {
    return testMemStore.get(testKey(userId, jobId)) ?? null;
  }
  if (!container) return null;
  try {
    const { resource } = await container.item(jobDocId(jobId), userId).read<ImportJobDoc>();
    return (resource ?? null) as ImportJobDoc | null;
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 404) return null;
    throw err;
  }
}

export async function writeImportJob(doc: ImportJobDoc): Promise<void> {
  // CF-IMPORT-ASYNC: enforce the TTL invariant at the write boundary.
  // Callers that construct a fresh doc should set `ttl`, but if any
  // path drops it we default here — defense-in-depth against accidental
  // permanent-storage of an envelope payload.
  const docWithTtl: ImportJobDoc = doc.ttl
    ? doc
    : { ...doc, ttl: IMPORT_JOB_TTL_SECONDS };
  const container: Container | null = await getPortfolioContainer();
  if (!container && isPortfolioTestMode) {
    testMemStore.set(testKey(docWithTtl.userId, docWithTtl.jobId), docWithTtl);
    return;
  }
  if (!container) throw new Error("[importJobStore] Cosmos container is not available");
  await container.items.upsert(docWithTtl);
}

/**
 * CF-IMPORT-ASYNC (2026-06-21): mark a job stale on the read side. The
 * importer Promise itself can't mark stale (it's dead, by definition),
 * so the status-poll caller materializes the stale verdict when it sees
 * a "processing" job whose lastProgressAt is older than the threshold.
 * Persisted via upsert so subsequent polls return "stale" cleanly.
 */
export async function markStaleIfNeeded(doc: ImportJobDoc): Promise<ImportJobDoc> {
  if (doc.status !== "processing") return doc;
  const ageMs = Date.now() - Date.parse(doc.progress.lastProgressAt);
  if (!Number.isFinite(ageMs) || ageMs <= STALENESS_THRESHOLD_MS) return doc;
  const updated: ImportJobDoc = {
    ...doc,
    status: "stale",
    errorMessage: `Job had no progress for ${Math.round(ageMs / 1000)}s — instance likely recycled. Please retry.`,
    updatedAt: new Date().toISOString(),
  };
  await writeImportJob(updated);
  return updated;
}

/**
 * Test-only helper: wipe the in-memory store between tests.
 */
export function _testResetImportJobStore(): void {
  testMemStore.clear();
}
