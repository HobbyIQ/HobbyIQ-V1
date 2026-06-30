// CF-IMPORT-BE (2026-06-21) — preview + commit service.
//
// Preview is read-only: parse → resolve → bucket per-row → return envelopes.
// Commit consumes confirmed envelopes + user actions, writes via the
// existing addHolding/updateHolding paths. Idempotency token prevents
// double-ingest on retried commits (the bulk-import scenario where a
// double-tap could create a mass-dupe event).

import {
  parseHoldingsFile,
  type FileFormat,
  type FileParseResult,
} from "./fileParser.js";
import {
  resolveBatch,
  type ImportRowEnvelope,
  type NormalizedHoldingPayload,
  type ImportBucket,
} from "./resolveBatch.js";
import {
  readImportJob,
  writeImportJob,
  markStaleIfNeeded,
  PROGRESS_WRITE_THROTTLE_MS,
  IMPORT_JOB_TTL_SECONDS,
  type ImportJobDoc,
} from "./importJobStore.service.js";
import type { PortfolioHolding } from "../../../types/portfolioiq.types.js";
import {
  readUserDoc,
  writeUserDoc,
  countHoldingsForUser,
} from "../portfolioStore.service.js";
import { cacheGet, cacheSet } from "../../shared/cache.service.js";
import {
  effectivePlanFor,
  getCap,
  type Plan,
} from "../../../config/entitlements.js";
import { detectCollision } from "./collisionDetector.js";

/** Minimal UserDoc shape we touch (the real type lives inside portfolioStore as an internal interface). */
interface UserDocShape {
  holdings: Record<string, PortfolioHolding>;
}

/**
 * CF-IMPORT-VOLUME (2026-06-21): Redis-backed idempotency cache key.
 * 24h TTL — covers retry windows; per-user scoped so token namespaces
 * don't collide across users.
 */
function idempotencyKey(userId: string, token: string): string {
  return `import-commit:${userId}:${token}`;
}
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * CF-IMPORT-ASYNC (2026-06-21): sync vs async threshold.
 *
 * Sized off p95 latency, not p50. Step-0 probe: sequential p95 ~2300ms,
 * 4-way concurrent ~2 req/s effective. 50 rows / 4-way → ~12.5 serialized
 * units × 2300ms ≈ 29s — on the 30s Express timeout edge. 40 rows clears
 * with margin (~23s p95 worst-case at 4-way × 2300ms).
 *
 * Above this, preview returns a jobId immediately and kicks an in-process
 * Promise. Below or equal, preview resolves inline as the original sync
 * path.
 */
export const SYNC_PREVIEW_ROW_THRESHOLD = 40;

function generateJobId(): string {
  // 16 hex chars; collision-resistant per-user and short enough for UI display.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(2, "0");
  const part = (n: number) => Array.from({ length: n }, () => hex(256)).join("");
  return part(8);
}

// CF-IMPORT-BE inlined helpers (mirrors portfolioStore conventions —
// not exported from there, but duplication is cheaper than refactoring
// the store for one consumer).
function holdingsCapFor(tier: string): number | null {
  // Free=25, collector=250, investor+=unlimited (null).
  // Matches src/config/entitlements.ts:81 / :90 + the comment at
  // src/routes/portfolioiq.routes.ts:148.
  const t = tier.toLowerCase();
  if (t === "free") return 25;
  if (t === "collector") return 250;
  return null; // investor / pro / etc. — unlimited
}

function normalizeId(id: string | undefined | null): string {
  // CF-D1 contract: stored holding keys are lowercase.
  return String(id ?? "").trim().toLowerCase();
}

export interface PreviewSummary {
  totalRows: number;
  isRoundTrip: boolean;
  bucketCounts: Record<ImportBucket, number>;
  /** Suggested commit count assuming default actions on each envelope. */
  defaultCommitCount: number;
  /** Whether projected post-import count would exceed the user's holdingsCap. */
  capacityProjection: {
    currentCount: number;
    incomingDeltaWithDefaults: number;
    projectedTotal: number;
    cap: number | null; // null for unlimited (investor+)
    wouldExceed: boolean;
  };
}

export interface PreviewResult {
  summary: PreviewSummary;
  envelopes: ImportRowEnvelope[];
  unmappedHeaders: string[];
  /** Auto-map proposal — user can override before commit. */
  proposedMapping: Record<string, string | null>;
}

/**
 * CF-IMPORT-ASYNC (2026-06-21): kick-off result returned when a preview
 * exceeds SYNC_PREVIEW_ROW_THRESHOLD. The client polls the status endpoint
 * with the jobId until status === "ready" then reads envelopes off the
 * polled doc; from there the commit flow is unchanged.
 */
export interface PreviewKickoffResult {
  async: true;
  jobId: string;
  totalRows: number;
  isRoundTrip: boolean;
  unmappedHeaders: string[];
  proposedMapping: Record<string, string | null>;
}

export type CommitAction = "commit" | "skip" | "add-as-copy" | "update-cost";

export interface CommitRequest {
  idempotencyToken: string;
  envelopes: ReadonlyArray<ImportRowEnvelope>;
  /** Action per rowNumber. Missing rowNumbers default to "skip". */
  actions?: Record<number, CommitAction>;
}

export interface CommitOutcome {
  rowNumber: number;
  action: CommitAction;
  outcome: "added" | "updated" | "skipped" | "failed";
  holdingId?: string;
  reason?: string;
}

export interface CommitResult {
  idempotencyToken: string;
  cached: boolean;
  outcomes: CommitOutcome[];
  totals: {
    added: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  /**
   * CF-IMPORT-VOLUME (2026-06-21): set when commit-side capacity check
   * rejected the commit before any writes. Distinct from the per-row
   * "failed" outcome — this is a batch-level rejection.
   */
  capacityExceeded?: {
    currentCount: number;
    cap: number;
    wouldBeTotal: number;
  };
  /**
   * CF-IMPORT-VOLUME (2026-06-21): count of envelopes whose action was
   * downgraded to "skip" by the fresh collision re-check (envelope was
   * generated before a prior commit's writes and would now create a
   * dupe). Surfaces in the response so the caller's UI can render
   * "N rows skipped because they were just added in a prior commit."
   */
  freshCollisionsBlocked?: number;
}

/**
 * Preview: read-only orchestration. NO writes to user doc.
 *
 * CF-IMPORT-ASYNC (2026-06-21): forks on row count.
 *   - ≤ SYNC_PREVIEW_ROW_THRESHOLD → resolve inline, return PreviewResult (sync path; unchanged).
 *   - >  SYNC_PREVIEW_ROW_THRESHOLD → create job doc + kick in-process resolve,
 *     return PreviewKickoffResult with jobId for status-polling.
 *
 * The async path writes ONLY to the separate import-job doc — never the
 * user doc — per the substrate decision. The commit flow is unchanged.
 */
export async function buildPreview(
  userId: string,
  fileBuffer: Buffer | string,
  format: FileFormat,
  userTier: string,
): Promise<PreviewResult | PreviewKickoffResult> {
  const parsed: FileParseResult = parseHoldingsFile(fileBuffer, format);

  // Async fork: above threshold, return jobId + kick detached job
  if (parsed.totalRows > SYNC_PREVIEW_ROW_THRESHOLD) {
    return await kickAsyncPreview(userId, fileBuffer, format, userTier, parsed);
  }

  // Sync path (unchanged): resolve inline
  const doc = await readUserDoc(userId);
  const envelopes = await resolveBatch(parsed.rows, {
    isRoundTrip: parsed.isRoundTrip,
    existingHoldings: doc.holdings ?? {},
  });

  // Bucket counts
  const bucketCounts: Record<ImportBucket, number> = {
    "resolved-clean": 0,
    "resolved-collision": 0,
    "ambiguous": 0,
    "unresolved": 0,
    "identity-edited": 0,
  };
  let defaultCommitCount = 0;
  for (const env of envelopes) {
    bucketCounts[env.bucket] = (bucketCounts[env.bucket] ?? 0) + 1;
    if (env.bucket === "resolved-clean") defaultCommitCount += 1;
  }

  const currentCount = Object.keys(doc.holdings ?? {}).length;
  const cap = holdingsCapFor(userTier);
  const incomingDelta = defaultCommitCount;
  const projectedTotal = currentCount + incomingDelta;
  const wouldExceed = cap !== null && projectedTotal > cap;

  return {
    summary: {
      totalRows: parsed.totalRows,
      isRoundTrip: parsed.isRoundTrip,
      bucketCounts,
      defaultCommitCount,
      capacityProjection: {
        currentCount,
        incomingDeltaWithDefaults: incomingDelta,
        projectedTotal,
        cap,
        wouldExceed,
      },
    },
    envelopes,
    unmappedHeaders: parsed.autoMap.unmapped,
    proposedMapping: parsed.autoMap.mapping,
  };
}

/**
 * CF-IMPORT-ASYNC (2026-06-21): create the job doc, kick the in-process
 * Promise, return the kickoff result. The Promise itself runs detached
 * from the response — Always-On + autoHeal=false on HobbyIQ3 keep it
 * alive across the typical ~4-min lifetime.
 */
async function kickAsyncPreview(
  userId: string,
  fileBuffer: Buffer | string,
  format: FileFormat,
  userTier: string,
  parsed: FileParseResult,
): Promise<PreviewKickoffResult> {
  const jobId = generateJobId();
  const now = new Date().toISOString();

  // Initial job doc — pending, no envelopes yet. TTL set at construction
  // so even if writeImportJob's defensive default ever drops, this doc
  // expires cleanly 24h after last modification.
  const initialDoc: ImportJobDoc = {
    id: `import-job-${jobId}`,
    userId,
    jobId,
    status: "pending",
    progress: { rowsProcessed: 0, rowsTotal: parsed.totalRows, lastProgressAt: now },
    ttl: IMPORT_JOB_TTL_SECONDS,
    proposedMapping: parsed.autoMap.mapping,
    unmappedHeaders: parsed.autoMap.unmapped,
    createdAt: now,
    updatedAt: now,
  };
  await writeImportJob(initialDoc);

  // Capture for the resolver's existingHoldings argument; computed once
  // at kick time so the job's collision view is consistent for its run.
  // Subsequent commit-time fresh-collision re-check handles new dupes
  // that landed AFTER kickoff.
  const doc = await readUserDoc(userId);
  const existingHoldings = doc.holdings ?? {};
  const currentCount = Object.keys(existingHoldings).length;
  const cap = holdingsCapFor(userTier);

  // Detached: do NOT await. The HTTP response returns to the client
  // immediately after this function returns the kickoff result.
  void runAsyncResolve({
    userId,
    jobId,
    parsed,
    existingHoldings,
    currentCount,
    cap,
  });

  return {
    async: true,
    jobId,
    totalRows: parsed.totalRows,
    isRoundTrip: parsed.isRoundTrip,
    unmappedHeaders: parsed.autoMap.unmapped,
    proposedMapping: parsed.autoMap.mapping,
  };
}

/**
 * CF-IMPORT-ASYNC (2026-06-21): the detached resolver. Runs resolveBatch
 * with a throttled progress callback that updates the job doc every
 * PROGRESS_WRITE_THROTTLE_MS. On completion, writes status:"ready" with
 * the envelopes; on error, status:"failed" with the message.
 */
async function runAsyncResolve(args: {
  userId: string;
  jobId: string;
  parsed: FileParseResult;
  existingHoldings: Record<string, PortfolioHolding>;
  currentCount: number;
  cap: number | null;
}): Promise<void> {
  const { userId, jobId, parsed, existingHoldings, currentCount, cap } = args;
  const startedAt = new Date().toISOString();
  const totalRows = parsed.totalRows;

  // Mark processing
  await safeWriteJob(userId, jobId, (doc) => ({
    ...doc,
    status: "processing",
    progress: { rowsProcessed: 0, rowsTotal: totalRows, lastProgressAt: startedAt },
    updatedAt: startedAt,
  }));

  try {
    let processed = 0;
    let lastWriteAt = Date.now();

    const envelopes = await resolveBatch(parsed.rows, {
      isRoundTrip: parsed.isRoundTrip,
      existingHoldings,
      onRowComplete: async () => {
        processed += 1;
        const now = Date.now();
        if (now - lastWriteAt < PROGRESS_WRITE_THROTTLE_MS) return;
        lastWriteAt = now;
        await safeWriteJob(userId, jobId, (doc) => ({
          ...doc,
          progress: {
            rowsProcessed: processed,
            rowsTotal: totalRows,
            lastProgressAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        }));
      },
    });

    // Compute summary + capacity projection mirror
    const bucketCounts: Record<string, number> = {
      "resolved-clean": 0,
      "resolved-collision": 0,
      "ambiguous": 0,
      "unresolved": 0,
      "identity-edited": 0,
    };
    let defaultCommitCount = 0;
    for (const env of envelopes) {
      bucketCounts[env.bucket] = (bucketCounts[env.bucket] ?? 0) + 1;
      if (env.bucket === "resolved-clean") defaultCommitCount += 1;
    }
    const projectedTotal = currentCount + defaultCommitCount;
    const wouldExceed = cap !== null && projectedTotal > cap;

    await safeWriteJob(userId, jobId, (doc) => ({
      ...doc,
      status: "ready",
      progress: {
        rowsProcessed: totalRows,
        rowsTotal: totalRows,
        lastProgressAt: new Date().toISOString(),
      },
      envelopes,
      summaryAtReady: {
        totalRows,
        isRoundTrip: parsed.isRoundTrip,
        bucketCounts,
        defaultCommitCount,
      },
      capacityProjectionAtKickoff: {
        currentCount,
        cap,
        wouldBeTotal: projectedTotal,
        wouldExceed,
      },
      updatedAt: new Date().toISOString(),
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await safeWriteJob(userId, jobId, (doc) => ({
      ...doc,
      status: "failed",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    }));
  }
}

/**
 * Safe job-doc updater: read, mutate, write. Single-writer per job by
 * design (only the runAsyncResolve owner writes progress), so blind
 * upsert is safe — concurrent commit flows write the user doc, never the
 * job doc. The mutation closure receives the latest read.
 */
async function safeWriteJob(
  userId: string,
  jobId: string,
  mutate: (doc: ImportJobDoc) => ImportJobDoc,
): Promise<void> {
  const existing = await readImportJob(userId, jobId);
  if (!existing) return; // job vanished; nothing to update
  const next = mutate(existing);
  await writeImportJob(next);
}

/**
 * Read job status. Materializes a stale verdict on-the-fly if the job
 * stalled (the importer Promise can't mark itself stale; the read side
 * decides).
 */
export async function readImportJobStatus(
  userId: string,
  jobId: string,
): Promise<ImportJobDoc | null> {
  const doc = await readImportJob(userId, jobId);
  if (!doc) return null;
  return await markStaleIfNeeded(doc);
}

/**
 * Commit: writes confirmed envelopes. Three CF-IMPORT-VOLUME hardenings:
 *   1. Redis-backed idempotency (replaces the prior in-doc last-50 cache
 *      that evicted on instance recycle / scale-out).
 *   2. Fresh collision re-check against LIVE holdings — defeats the
 *      stale-envelope-from-pre-commit race that the token alone can't.
 *   3. Commit-side capacity re-enforcement — don't trust the client to
 *      honor the preview's wouldExceed.
 *
 * The `userPlan` argument is the caller's effectivePlan (route handler
 * passes it from req.user); commit reads the holdings cap from it.
 */
export async function commitImport(
  userId: string,
  request: CommitRequest,
  userPlan: Plan,
): Promise<CommitResult> {
  // ─── §1.b Redis-backed idempotency: check first, before any reads ──
  const cacheKey = idempotencyKey(userId, request.idempotencyToken);
  const cachedJson = await cacheGet(cacheKey);
  if (cachedJson) {
    try {
      const prior = JSON.parse(cachedJson) as CommitResult;
      return { ...prior, cached: true };
    } catch {
      // Corrupt cache entry — fall through and reprocess. Worst case is
      // a re-write that the fresh-collision check + Redis-set-after-write
      // pattern will still keep idempotent.
    }
  }

  const doc = await readUserDoc(userId);
  const liveHoldings = doc.holdings ?? {};

  // ─── §1.c Commit-side capacity re-enforcement ─────────────────────
  // Project the impact assuming the request's actions (or the envelope
  // default when actions omit a rowNumber). Reject UP FRONT — never
  // mid-stream — so the user sees a clean 402 before any writes happen.
  const actions = request.actions ?? {};
  const projectedAdds = request.envelopes.filter((env) => {
    const action = actions[env.rowNumber] ?? defaultActionFor(env);
    // "commit" on a "new" lane creates a new holding; "add-as-copy" also
    // creates new. "update-cost" and "skip" don't grow the count.
    if (action === "skip" || action === "update-cost") return false;
    if (env.lane === "update" && action === "commit") return false;
    return true;
  }).length;

  const currentCount = await countHoldingsForUser(userId);
  const cap = getCap(userPlan, "holdingsCap");
  if (cap !== "unlimited") {
    const wouldBeTotal = currentCount + projectedAdds;
    if (wouldBeTotal > cap) {
      const rejection: CommitResult = {
        idempotencyToken: request.idempotencyToken,
        cached: false,
        outcomes: request.envelopes.map((env) => ({
          rowNumber: env.rowNumber,
          action: "skip" as CommitAction,
          outcome: "skipped" as const,
          reason: "capacity_exceeded — batch rejected before any writes",
        })),
        totals: { added: 0, updated: 0, skipped: request.envelopes.length, failed: 0 },
        capacityExceeded: { currentCount, cap, wouldBeTotal },
      };
      // DO cache the rejection too — a retry of an over-capacity import
      // is also over-capacity; deterministic.
      await cacheSet(cacheKey, JSON.stringify(rejection), IDEMPOTENCY_TTL_SECONDS);
      return rejection;
    }
  }

  // ─── §1.a Fresh collision re-check + apply ────────────────────────
  // For each NEW-lane envelope that wasn't already marked collision,
  // re-run the detector against live holdings (which may include rows
  // added by a prior commit since the envelope was generated). Fresh
  // collisions downgrade to "skip" silently — preserves the "default
  // skip on collision" safety from the preview phase + structurally
  // blocks mass-dupe on a re-commit with stale envelopes.
  const outcomes: CommitOutcome[] = [];
  let freshCollisionsBlocked = 0;
  for (const env of request.envelopes) {
    let action = actions[env.rowNumber] ?? defaultActionFor(env);

    if (env.lane === "new" && env.cardId && (action === "commit" || action === "add-as-copy")) {
      const freshCollision = detectCollision(
        {
          cardId: env.cardId,
          holdingId: env.payload.id ?? null,
          parallel: env.payload.parallel ?? null,
          gradeCompany: env.payload.gradeCompany ?? null,
          gradeValue: env.payload.gradeValue ?? null,
          serialNumber: env.payload.serialNumber ?? null,
        },
        doc.holdings,
      );
      // Only "fresh" if the envelope didn't already carry a collision.
      // Envelopes that arrived with bucket "resolved-collision" already
      // had their action explicitly chosen by the user — respect it.
      if (freshCollision.collides && env.bucket !== "resolved-collision") {
        action = "skip";
        freshCollisionsBlocked += 1;
      }
    }

    const result = await applyAction(doc, env, action);
    outcomes.push(result);
  }

  const totals = {
    added: outcomes.filter((o) => o.outcome === "added").length,
    updated: outcomes.filter((o) => o.outcome === "updated").length,
    skipped: outcomes.filter((o) => o.outcome === "skipped").length,
    failed: outcomes.filter((o) => o.outcome === "failed").length,
  };
  const result: CommitResult = {
    idempotencyToken: request.idempotencyToken,
    cached: false,
    outcomes,
    totals,
    ...(freshCollisionsBlocked > 0 ? { freshCollisionsBlocked } : {}),
  };

  await writeUserDoc(userId, doc);
  // §1.b Redis token AFTER successful write — the retry-replay invariant.
  // If the write fails above, we never set the token; a retry then runs
  // the commit afresh against live state (and fresh-collision blocks the
  // dupes that earlier partial writes may have created).
  await cacheSet(cacheKey, JSON.stringify(result), IDEMPOTENCY_TTL_SECONDS);

  // The liveHoldings reference is kept for diagnostics — surfaced via
  // process logs if useful. (Intentional pin against lint dead-code rule.)
  void liveHoldings;

  return result;
}

function defaultActionFor(env: ImportRowEnvelope): CommitAction {
  switch (env.bucket) {
    case "resolved-clean":
      return "commit";
    case "resolved-collision":
      return env.collision?.defaultAction ?? "skip";
    case "ambiguous":
    case "unresolved":
    case "identity-edited":
      return "skip";
  }
}

async function applyAction(
  doc: UserDocShape,
  env: ImportRowEnvelope,
  action: CommitAction,
): Promise<CommitOutcome> {
  try {
    if (action === "skip") {
      return { rowNumber: env.rowNumber, action, outcome: "skipped" };
    }
    if (env.lane === "update" && action === "commit") {
      // Metadata-only update on existing holdingId
      const hid = env.existingHoldingId!;
      const existing = doc.holdings[hid];
      if (!existing) {
        return { rowNumber: env.rowNumber, action, outcome: "failed", reason: "existing holding not found" };
      }
      doc.holdings[hid] = mergePayload(existing, env.payload);
      return { rowNumber: env.rowNumber, action, outcome: "updated", holdingId: hid };
    }
    if (action === "update-cost") {
      // Update only acquisition columns on the colliding existing holding(s)
      const targetHid = env.collision?.existingHoldingIds[0] ?? env.existingHoldingId;
      if (!targetHid) {
        return { rowNumber: env.rowNumber, action, outcome: "failed", reason: "no target holding for update-cost" };
      }
      const existing = doc.holdings[targetHid];
      if (!existing) {
        return { rowNumber: env.rowNumber, action, outcome: "failed", reason: "target holding missing" };
      }
      doc.holdings[targetHid] = {
        ...existing,
        purchasePrice: env.payload.purchasePrice ?? existing.purchasePrice,
        totalCostBasis: env.payload.totalCostBasis ?? existing.totalCostBasis,
        purchaseDate: env.payload.purchaseDate ?? existing.purchaseDate,
        purchaseSource: env.payload.purchaseSource ?? existing.purchaseSource,
        notes: env.payload.notes ?? existing.notes,
      };
      return { rowNumber: env.rowNumber, action, outcome: "updated", holdingId: targetHid };
    }
    // commit (NEW lane) or add-as-copy
    const newId = env.payload.id ? normalizeId(env.payload.id) : normalizeId(generateId());
    const newHolding = mergePayload({ id: newId } as PortfolioHolding, env.payload);
    newHolding.id = newId;
    newHolding.cardId = env.cardId ?? null;
    doc.holdings[newId] = newHolding;
    return { rowNumber: env.rowNumber, action, outcome: "added", holdingId: newId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rowNumber: env.rowNumber, action, outcome: "failed", reason: msg };
  }
}

function mergePayload(existing: PortfolioHolding, payload: NormalizedHoldingPayload): PortfolioHolding {
  const out: PortfolioHolding = { ...existing };
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

function generateId(): string {
  // Simple UUID-v4-ish; lowercase for the CF-D1 case-fold contract.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(2, "0");
  const part = (n: number) => Array.from({ length: n }, () => hex(256)).join("");
  return `${part(4)}-${part(2)}-${part(2)}-${part(2)}-${part(6)}`;
}

// Re-export type used elsewhere
export type { ImportRowEnvelope } from "./resolveBatch.js";
