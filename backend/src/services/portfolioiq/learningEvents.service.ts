// CF-LEARNING-EVENTS (Drew, 2026-08-01). Every human decision on the
// pool becomes a training event. The system captures:
//   - Labeler saves (variant → canonical label)
//   - Quarantine clears (row was flagged but human confirmed clean)
//   - Quarantine forces (row wasn't flagged but human quarantined it)
//   - User flags (users tap "looks wrong")
//   - Verify-queue resolutions (approve/reject/fix)
//   - Bad-actor confirmations
//
// These events feed two loops:
//   1. Confidence scorer (immediate): weights signals that historically
//      correlate with confirmed-clean vs confirmed-contaminated rows.
//   2. Model training (future): supervised learning corpus for an
//      offline classifier that predicts contamination risk at ingest.
//
// Container: learning_events, partitioned by /eventDate for time-series
// queries. TTL 730 days (2 years of training history retained).

import { CosmosClient, type Container } from "@azure/cosmos";

export type LearningEventType =
  | "labeler-save"          // variant labeled with canonical parallel + printRun
  | "quarantine-clear"      // admin cleared a flagged row (false positive)
  | "quarantine-force"      // admin force-quarantined an unflagged row
  | "user-flag"             // end-user flagged a row
  | "user-flag-undo"        // end-user removed their flag
  | "verify-approve"        // admin approved a verify-queue item
  | "verify-reject"         // admin rejected a verify-queue item
  | "verify-fix"            // admin edited a verify-queue item
  | "bad-actor-confirm"     // admin confirmed a seller is a bad actor
  | "auto-quarantine"       // system auto-quarantined at threshold (3+ user flags)
  | "safe-write-holding"    // Drew edited a holding via safeWriteHolding
  | "holding-rollback"      // Drew rolled back a holding change
  // CF-INGEST-LEARNING (Drew, 2026-08-01). Every ingest decision is
  // now a training event too. As we scrub, the system learns.
  | "ingest-accept"         // recordSoldComp wrote the row (confidence band auto-trust or flag-review)
  | "ingest-quarantine"     // recordSoldComp wrote with auto-quarantine flag (confidence < 0.6)
  | "ingest-reject"         // recordSoldComp refused to persist (confidence < 0.4)
  | "ingest-fuzzy-reject"   // pre-clean rejected as fuzzy-match error
  | "ingest-price-outlier"  // price sanity gate flagged
  | "backfill-decision";    // any backfill script decided to rewrite/tag a row

export interface LearningEvent {
  id: string;
  eventDate: string;   // YYYY-MM-DD (partition key)
  eventType: LearningEventType;
  actor: string;       // userId or "admin-web" or "auto-system"
  subjectType: "sold_comp" | "card_catalog" | "portfolio_holding" | "seller_handle" | "verify_item";
  subjectId: string;
  /** Snapshot of relevant fields BEFORE the decision. */
  before?: Record<string, unknown>;
  /** Snapshot of relevant fields AFTER the decision. */
  after?: Record<string, unknown>;
  /** The specific decision. */
  decision: {
    label?: string;                  // e.g. canonical parallel
    action?: string;                 // "clear" | "quarantine" | "flag" etc.
    reason?: string;
    confidence?: number;             // if available (auto-decision)
  };
  /** Additional features useful for future ML training. */
  features?: Record<string, unknown>;
  createdAt: string;
}

const CONTAINER_ID = process.env.COSMOS_LEARNING_EVENTS_CONTAINER ?? "learning_events";
const TTL_SEC = 730 * 24 * 60 * 60;

let cachedContainer: Container | null = null;

async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({
      id: process.env.COSMOS_DATABASE ?? "hobbyiq",
    });
    const { container } = await database.containers.createIfNotExists({
      id: CONTAINER_ID,
      partitionKey: { paths: ["/eventDate"] },
      defaultTtl: TTL_SEC,
    });
    cachedContainer = container;
    return container;
  } catch (err) {
    console.warn("learningEvents.getContainer init failed:", (err as Error)?.message);
    return null;
  }
}

/** Fire-and-forget event write. Never throws; failure is a warning only. */
export function logLearningEvent(input: {
  eventType: LearningEventType;
  actor: string;
  subjectType: LearningEvent["subjectType"];
  subjectId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  decision: LearningEvent["decision"];
  features?: Record<string, unknown>;
}): void {
  void (async () => {
    try {
      const container = await getContainer();
      if (!container) return;
      const now = new Date();
      const doc: LearningEvent = {
        id: `${input.eventType}::${input.subjectId}::${now.toISOString()}`,
        eventDate: now.toISOString().slice(0, 10),
        eventType: input.eventType,
        actor: input.actor,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        before: input.before,
        after: input.after,
        decision: input.decision,
        features: input.features,
        createdAt: now.toISOString(),
      };
      await container.items.upsert(doc);
    } catch (err) {
      if (Math.random() < 0.01) {
        console.warn("learningEvents write failed:", (err as Error)?.message);
      }
    }
  })();
}

/** Read events for training analysis. Filter by type + date range. */
export async function readLearningEvents(opts: {
  eventTypes?: LearningEventType[];
  fromDate?: string;
  toDate?: string;
  limit?: number;
}): Promise<LearningEvent[]> {
  const container = await getContainer();
  if (!container) return [];
  const from = opts.fromDate ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(10_000, Math.max(1, opts.limit ?? 1000));
  const params: Array<{ name: string; value: string | number }> = [
    { name: "@lim", value: limit },
    { name: "@from", value: from },
    { name: "@to", value: to },
  ];
  let where = "c.eventDate >= @from AND c.eventDate <= @to";
  if (opts.eventTypes?.length) {
    const inList = opts.eventTypes.map((_, i) => `@t${i}`).join(",");
    opts.eventTypes.forEach((t, i) => params.push({ name: `@t${i}`, value: t }));
    where += ` AND c.eventType IN (${inList})`;
  }
  const query = `SELECT TOP @lim * FROM c WHERE ${where} ORDER BY c.createdAt DESC`;
  const { resources } = await container.items.query({ query, parameters: params }).fetchAll();
  return resources as LearningEvent[];
}

export interface LearningSummary {
  totalEvents: number;
  byType: Record<string, number>;
  byActor: Record<string, number>;
  last7Days: number;
  last30Days: number;
}

export async function summarizeLearning(): Promise<LearningSummary | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = new Date();
  const t7 = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const t30 = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

  const totalQ = container.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }).fetchAll();
  const byTypeQ = container.items.query({ query: "SELECT c.eventType, COUNT(1) AS n FROM c GROUP BY c.eventType" }).fetchAll();
  const byActorQ = container.items.query({ query: "SELECT c.actor, COUNT(1) AS n FROM c GROUP BY c.actor" }).fetchAll();
  const l7Q = container.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.eventDate >= @t", parameters: [{ name: "@t", value: t7 }] }).fetchAll();
  const l30Q = container.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.eventDate >= @t", parameters: [{ name: "@t", value: t30 }] }).fetchAll();

  const [total, byType, byActor, l7, l30] = await Promise.all([totalQ, byTypeQ, byActorQ, l7Q, l30Q]);

  const byTypeMap: Record<string, number> = {};
  for (const r of byType.resources as Array<{ eventType: string; n: number }>) byTypeMap[r.eventType] = Number(r.n) || 0;
  const byActorMap: Record<string, number> = {};
  for (const r of byActor.resources as Array<{ actor: string; n: number }>) byActorMap[r.actor] = Number(r.n) || 0;

  return {
    totalEvents: Number(total.resources[0]) || 0,
    byType: byTypeMap,
    byActor: byActorMap,
    last7Days: Number(l7.resources[0]) || 0,
    last30Days: Number(l30.resources[0]) || 0,
  };
}
