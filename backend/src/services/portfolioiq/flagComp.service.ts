// CF-USER-COMP-FLAG (Drew, 2026-07-26). User-driven comp verification.
//
// When a user sees a sale on /card-detail (or anywhere iOS renders
// recent comps) that looks wrong — wrong card, wrong grade, wrong
// price, off-market source — they can tap "flag this comp". Backend
// receives a report, appends the flagger + reason to the row, and
// (at threshold) adds "user-flagged" to qualityFlags so the FMV
// pipeline drops it from future computes.
//
// Design:
// - Idempotent per (userId, compId): same user can't multi-flag one comp
// - Threshold N distinct users before we add "user-flagged" (env-tunable;
//   default 1 = first flag drops immediately — Drew can raise to 2+ if
//   we see abuse)
// - Full audit trail: flagHistory[] carries {userId, reason, note, at}
// - Reversible via admin: unflag path removes user from flaggedBy +
//   recomputes qualityFlags (not shipped in v1 — deferred until observed)

import { CosmosClient, type Container } from "@azure/cosmos";

export type FlagCompReason =
  | "wrong-price"
  | "wrong-card"
  | "wrong-grade"
  | "off-market"
  | "duplicate"
  | "other";

export interface FlagCompInput {
  compId: string;       // sold_comps document id
  cardId: string;       // partition key
  userId: string;       // requesting user
  reason: FlagCompReason;
  note?: string;        // free-form context; capped at 500 chars
}

export interface FlagCompResult {
  success: true;
  compId: string;
  alreadyFlaggedByYou: boolean;
  totalUserFlags: number;
  qualityFlagsApplied: boolean;   // true when this flag pushed the row into "user-flagged"
}

let cachedContainer: Container | null = null;
async function getSoldContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    cachedContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

/** Number of distinct users required before we add "user-flagged" to
 *  qualityFlags (and thereby drop the comp from FMV).
 *
 *  CF-COMP-FLAG-THRESHOLD-P0.2 (Drew, 2026-07-26). Default raised
 *  1 → 3 per prod-readiness audit. Previously a single user flag
 *  could drop any comp instantly from FMV → any bad-faith account
 *  could poison the pool. Threshold 3 requires triangulation. Rate
 *  limit (20/day per user, enforceUserFlagRateLimit middleware) is
 *  belt-and-suspenders. */
function autoFilterThreshold(): number {
  const raw = process.env.USER_FLAG_AUTO_FILTER_THRESHOLD;
  const n = raw ? parseInt(raw, 10) : 3;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

const MAX_NOTE_LEN = 500;

export async function flagComp(input: FlagCompInput): Promise<FlagCompResult> {
  if (!input.compId || !input.cardId || !input.userId) {
    throw new Error("compId, cardId, userId all required");
  }
  const container = await getSoldContainer();
  if (!container) {
    throw new Error("sold_comps container unavailable");
  }

  // Read current state to compute idempotency + threshold check.
  const { resource: row } = await container.item(input.compId, input.cardId).read<{
    qualityFlags?: string[];
    flaggedBy?: string[];
    flagHistory?: Array<{ userId: string; reason: string; note?: string; at: string }>;
  }>();
  if (!row) {
    throw new Error(`comp not found: id=${input.compId} partitionKey=${input.cardId}`);
  }

  const flaggedBy = Array.isArray(row.flaggedBy) ? [...row.flaggedBy] : [];
  const flagHistory = Array.isArray(row.flagHistory) ? [...row.flagHistory] : [];
  const currentFlags = new Set(Array.isArray(row.qualityFlags) ? row.qualityFlags : []);

  const alreadyFlaggedByYou = flaggedBy.includes(input.userId);
  if (alreadyFlaggedByYou) {
    return {
      success: true,
      compId: input.compId,
      alreadyFlaggedByYou: true,
      totalUserFlags: flaggedBy.length,
      qualityFlagsApplied: currentFlags.has("user-flagged"),
    };
  }

  // Append this user + history entry.
  flaggedBy.push(input.userId);
  flagHistory.push({
    userId: input.userId,
    reason: input.reason,
    note: input.note ? String(input.note).slice(0, MAX_NOTE_LEN) : undefined,
    at: new Date().toISOString(),
  });

  // Apply "user-flagged" once the distinct-user count meets the threshold.
  const threshold = autoFilterThreshold();
  const shouldAutoFilter = flaggedBy.length >= threshold;
  if (shouldAutoFilter) currentFlags.add("user-flagged");

  // Cosmos patch — atomic on the row.
  const ops: Array<{ op: "set"; path: string; value: unknown }> = [
    { op: "set", path: "/flaggedBy", value: flaggedBy },
    { op: "set", path: "/flagHistory", value: flagHistory },
  ];
  if (shouldAutoFilter) ops.push({ op: "set", path: "/qualityFlags", value: [...currentFlags] });
  await container.item(input.compId, input.cardId).patch(ops);

  return {
    success: true,
    compId: input.compId,
    alreadyFlaggedByYou: false,
    totalUserFlags: flaggedBy.length,
    qualityFlagsApplied: shouldAutoFilter,
  };
}
