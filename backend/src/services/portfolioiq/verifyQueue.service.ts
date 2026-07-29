// CF-VERIFY-QUEUE (Drew, 2026-07-28).
//
// The human-in-the-loop residue. When ingest can't confidently classify
// a comp (price outlier, slug conflict, parser fallback) we route the
// row here INSTEAD of into sold_comps so a downstream reprice / FMV
// compute never sees suspect data. Drew (or a trusted admin) then
// approves / rejects / fixes the row via the /verify surface, and the
// action:
//   - approve    → row promoted into sold_comps with `verifiedByUser=true`
//   - reject     → row discarded; a `verify_corrections` entry logs the
//                  reject reason so the parser can learn to auto-reject
//                  future identical patterns
//   - fix(patch) → row rewritten with the caller's overrides + promoted
//                  as verified; corrections table logs the diff so the
//                  parser can learn the mapping
//
// Container: `verify_queue`, partition /reason so a single reason's
// queue reads cheap and cross-reason listing is a cross-partition scan
// (rarer). Rows carry the ORIGINAL persist input verbatim so promote
// can rehydrate through the standard sold-comps path.

import { CosmosClient, type Container } from "@azure/cosmos";
import { randomUUID } from "crypto";
import type { RecordSoldCompInput } from "./soldCompsStore.service.js";

/**
 * Why an ingest attempt was diverted here. Extend when new detectors
 * ship; the union type keeps the enqueue call site typed.
 */
export type VerifyReason =
  | "price-outlier"
  | "parser-low-confidence"
  | "slug-conflict"
  | "cross-source-mismatch"
  | "sample-audit"        // random sample for statistical accuracy audit
  | "manual"              // admin flagged a persisted row for re-verification
  | "divergence-alert"    // cost-basis vs FMV divergence surfaced here for review
  | "catalog-gap"           // FMV request for a parallel with ZERO direct data at the identity (rare parallel; refuse to fabricate)
  | "parallel-price-mismatch" // ingest price fits another parallel's band better than the classified parallel
  | "image-mismatch";       // ingest image pHash disagrees with catalog reference for the classified slug

export interface VerifyQueueDoc {
  id: string;
  reason: VerifyReason;
  status: "pending" | "approved" | "rejected" | "fixed";
  observedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;   // adminUserId
  // Original persist input as-received (verbatim so promote is a no-op
  // rehydrate). Kept as `RecordSoldCompInput` for enqueue at ingest time.
  input: RecordSoldCompInput;
  // Signal that tripped the detector. Free-form; renderers pretty-print.
  signal?: {
    rollingMedian?: number;
    ratio?: number;
    conflictingSlugs?: string[];
    parserConfidence?: number;
    note?: string;
  };
  // Set on approve/fix; the diff between input and correction.
  correction?: {
    parallel?: string | null;
    cardNumber?: string | null;
    printRun?: number | null;
    isAuto?: boolean;
    gradeCompany?: string | null;
    gradeValue?: number | null;
    price?: number;
    soldAt?: string;
    reasonNote?: string;
  };
  ttl?: number;
}

let _cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_VERIFY_QUEUE_CONTAINER ?? "verify_queue");
    return _cached;
  } catch {
    return null;
  }
}

/**
 * Enqueue an ingest attempt for human review. Never throws — silent
 * no-op on Cosmos absence so a broken Cosmos link doesn't stall ingest.
 * Returns the queue-doc id, or null when the enqueue couldn't land.
 */
export async function enqueueForVerify(input: {
  reason: VerifyReason;
  saleInput: RecordSoldCompInput;
  signal?: VerifyQueueDoc["signal"];
}): Promise<string | null> {
  const c = await getContainer();
  if (!c) return null;
  const doc: VerifyQueueDoc = {
    id: randomUUID(),
    reason: input.reason,
    status: "pending",
    observedAt: new Date().toISOString(),
    input: input.saleInput,
    signal: input.signal,
    // 60d TTL — a stale queue is noise; if it's not triaged in 60 days
    // it wasn't worth reviewing anyway. Ingest continues.
    ttl: 60 * 24 * 3600,
  };
  try {
    await c.items.upsert(doc as unknown as Record<string, unknown>);
    console.log(JSON.stringify({
      event: "verify_queue_enqueued",
      source: "verifyQueue.service",
      id: doc.id,
      reason: input.reason,
      slug: input.saleInput.cardId,
      price: input.saleInput.price,
    }));
    return doc.id;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "verify_queue_enqueue_failed",
      source: "verifyQueue.service",
      reason: input.reason,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

export interface ListPendingOptions {
  reason?: VerifyReason;
  limit?: number;
  continuation?: string;
}

export async function listPending(opts: ListPendingOptions = {}): Promise<{
  items: VerifyQueueDoc[];
  continuation?: string;
}> {
  const c = await getContainer();
  if (!c) return { items: [] };
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const query = opts.reason
    ? { query: "SELECT * FROM c WHERE c.status = 'pending' AND c.reason = @r ORDER BY c.observedAt DESC", parameters: [{ name: "@r", value: opts.reason }] }
    : { query: "SELECT * FROM c WHERE c.status = 'pending' ORDER BY c.observedAt DESC", parameters: [] };
  try {
    const iter = c.items.query<VerifyQueueDoc>(query, {
      maxItemCount: limit,
      continuationToken: opts.continuation,
    });
    const res = await iter.fetchNext();
    return {
      items: res.resources,
      continuation: res.continuationToken,
    };
  } catch {
    return { items: [] };
  }
}

export async function countPending(reason?: VerifyReason): Promise<number> {
  const c = await getContainer();
  if (!c) return 0;
  const query = reason
    ? { query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'pending' AND c.reason = @r", parameters: [{ name: "@r", value: reason }] }
    : { query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'pending'", parameters: [] };
  try {
    const { resources } = await c.items.query<number>(query).fetchAll();
    return resources[0] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Promote a queued row into sold_comps, marking it verifiedByUser=true,
 * and mark the queue doc `approved`. Optional overrides in `correction`
 * apply before the sold_comps write (a "fix" action). Returns whether
 * the action landed.
 */
export interface ResolveQueuedOptions {
  adminUserId: string;
  correction?: VerifyQueueDoc["correction"];
}

export async function resolveQueued(
  id: string,
  reason: VerifyReason,
  action: "approve" | "reject" | "fix",
  opts: ResolveQueuedOptions = { adminUserId: "unknown" },
): Promise<{ ok: boolean; reason?: string }> {
  const c = await getContainer();
  if (!c) return { ok: false, reason: "cosmos-unavailable" };
  let doc: VerifyQueueDoc;
  try {
    const { resource } = await c.item(id, reason).read<VerifyQueueDoc>();
    if (!resource) return { ok: false, reason: "not-found" };
    doc = resource as VerifyQueueDoc;
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (doc.status !== "pending") {
    return { ok: false, reason: `already-resolved:${doc.status}` };
  }

  if (action === "reject") {
    doc.status = "rejected";
    doc.resolvedAt = new Date().toISOString();
    doc.resolvedBy = opts.adminUserId;
    doc.correction = opts.correction;
    await c.item(id, reason).replace(doc as unknown as Record<string, unknown>);
    console.log(JSON.stringify({
      event: "verify_queue_rejected",
      source: "verifyQueue.service",
      id, reason, resolvedBy: opts.adminUserId,
    }));
    return { ok: true };
  }

  // approve OR fix — promote into sold_comps. `fix` applies overrides.
  const patched: RecordSoldCompInput = {
    ...doc.input,
    ...(opts.correction?.parallel !== undefined ? { parallel: opts.correction.parallel } : {}),
    ...(opts.correction?.cardNumber !== undefined ? { cardNumber: opts.correction.cardNumber } : {}),
    ...(opts.correction?.printRun !== undefined ? {} : {}),  // printRun not on RecordSoldCompInput surface; captured in correction log
    ...(opts.correction?.isAuto !== undefined ? { isAuto: opts.correction.isAuto } : {}),
    ...(opts.correction?.gradeCompany !== undefined ? { gradeCompany: opts.correction.gradeCompany } : {}),
    ...(opts.correction?.gradeValue !== undefined ? { gradeValue: opts.correction.gradeValue } : {}),
    ...(opts.correction?.price !== undefined ? { price: opts.correction.price } : {}),
    ...(opts.correction?.soldAt !== undefined ? { soldAt: opts.correction.soldAt } : {}),
    verifiedByUser: true,
    confidence: 1.0,
  };

  const { recordSoldComp } = await import("./soldCompsStore.service.js");
  await recordSoldComp(patched);

  doc.status = action === "fix" ? "fixed" : "approved";
  doc.resolvedAt = new Date().toISOString();
  doc.resolvedBy = opts.adminUserId;
  doc.correction = opts.correction;
  await c.item(id, reason).replace(doc as unknown as Record<string, unknown>);

  // Record a training example in the corrections log for future parser learning.
  try {
    const { recordVerifyCorrection } = await import("./verifyCorrections.service.js");
    await recordVerifyCorrection({
      queueId: id,
      reason,
      action,
      originalInput: doc.input,
      correction: opts.correction ?? null,
      adminUserId: opts.adminUserId,
    });
  } catch {
    // Corrections log is best-effort. Never let it block the resolve.
  }

  console.log(JSON.stringify({
    event: "verify_queue_resolved",
    source: "verifyQueue.service",
    id, reason, action, resolvedBy: opts.adminUserId,
  }));
  return { ok: true };
}
