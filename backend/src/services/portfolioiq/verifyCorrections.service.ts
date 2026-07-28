// CF-VERIFY-CORRECTIONS (Drew, 2026-07-28).
//
// The training set. Every approve/reject/fix action from verify_queue
// lands here as a labeled example so the parser + ingest rules can
// learn what humans corrected. Kept as a separate container from
// verify_queue so the queue can TTL out while corrections stay
// permanent (they ARE the learning signal).
//
// Downstream consumers (not built yet, but the schema is ready for
// them):
//   - A nightly parser-regression job that replays every correction
//     through the current parseListingIdentity and reports how many
//     would now flip WRONG under the current rules (that's a rule
//     regression the rule owner needs to see).
//   - A title→override map so the next identical title auto-applies
//     the human correction instead of routing to verify again.
//   - Fixture generation for parser unit tests.

import { CosmosClient, type Container } from "@azure/cosmos";
import { randomUUID, createHash } from "crypto";
import type { RecordSoldCompInput } from "./soldCompsStore.service.js";
import type { VerifyReason } from "./verifyQueue.service.js";

export interface VerifyCorrectionDoc {
  id: string;
  queueId: string;
  reason: VerifyReason;
  action: "approve" | "reject" | "fix";
  observedAt: string;
  adminUserId: string;
  // Hash of the raw title (case-insensitive, whitespace-normalized) so
  // a future ingest of the SAME title collides on this correction and
  // the parser can auto-apply the human's fix without re-queuing.
  titleHash?: string;
  originalInput: RecordSoldCompInput;
  correction: {
    parallel?: string | null;
    cardNumber?: string | null;
    printRun?: number | null;
    isAuto?: boolean;
    price?: number;
    soldAt?: string;
    reasonNote?: string;
  } | null;
}

let _cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_VERIFY_CORRECTIONS_CONTAINER ?? "verify_corrections");
    return _cached;
  } catch {
    return null;
  }
}

function titleHash(title: string | null | undefined): string | undefined {
  const t = String(title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return undefined;
  return createHash("sha1").update(t).digest("hex").slice(0, 16);
}

export async function recordVerifyCorrection(input: {
  queueId: string;
  reason: VerifyReason;
  action: "approve" | "reject" | "fix";
  originalInput: RecordSoldCompInput;
  correction: VerifyCorrectionDoc["correction"];
  adminUserId: string;
}): Promise<string | null> {
  const c = await getContainer();
  if (!c) return null;
  const doc: VerifyCorrectionDoc = {
    id: randomUUID(),
    queueId: input.queueId,
    reason: input.reason,
    action: input.action,
    observedAt: new Date().toISOString(),
    adminUserId: input.adminUserId,
    titleHash: titleHash(input.originalInput.title),
    originalInput: input.originalInput,
    correction: input.correction,
  };
  try {
    await c.items.upsert(doc as unknown as Record<string, unknown>);
    console.log(JSON.stringify({
      event: "verify_correction_recorded",
      source: "verifyCorrections.service",
      id: doc.id,
      action: input.action,
      reason: input.reason,
      titleHash: doc.titleHash,
    }));
    return doc.id;
  } catch {
    return null;
  }
}

/**
 * Fast lookup for the parser: has this exact title already been
 * corrected? Returns the most-recent correction so the parser can
 * apply it instead of re-parsing wrong. Null when the title has never
 * been seen (the common case — this is a small hot cache in practice).
 */
export async function lookupCorrectionForTitle(title: string): Promise<VerifyCorrectionDoc | null> {
  const c = await getContainer();
  if (!c) return null;
  const h = titleHash(title);
  if (!h) return null;
  try {
    const { resources } = await c.items.query<VerifyCorrectionDoc>({
      query: "SELECT TOP 1 * FROM c WHERE c.titleHash = @h AND c.action IN ('approve', 'fix') ORDER BY c.observedAt DESC",
      parameters: [{ name: "@h", value: h }],
    }).fetchAll();
    return resources[0] ?? null;
  } catch {
    return null;
  }
}
