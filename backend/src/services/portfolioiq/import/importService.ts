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
 * Preview: read-only orchestration. NO writes.
 */
export async function buildPreview(
  userId: string,
  fileBuffer: Buffer | string,
  format: FileFormat,
  userTier: string,
): Promise<PreviewResult> {
  const parsed: FileParseResult = parseHoldingsFile(fileBuffer, format);

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
    // Default-commit logic: clean rows commit; collision/edited/unresolved/ambiguous default to skip
    if (env.bucket === "resolved-clean") defaultCommitCount += 1;
  }

  // Capacity projection
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

    if (env.lane === "new" && env.cardsightCardId && (action === "commit" || action === "add-as-copy")) {
      const freshCollision = detectCollision(
        {
          cardsightCardId: env.cardsightCardId,
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
    newHolding.cardsightCardId = env.cardsightCardId ?? null;
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
