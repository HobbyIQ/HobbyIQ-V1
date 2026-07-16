// CF-SUGGESTER-FEEDBACK (Drew, 2026-07-15): proprietary training corpus
// of every user confirm/reject on holding suggestions. This is the
// learning loop no vendor can replicate — turning our users' cleaning
// work into a signal that improves the suggester over time.
//
// Container: `suggester_feedback`, partition `/userId`, 365d TTL.
//
// What we capture:
//   - The auto-parsed identity fields the suggester saw
//   - The user's action (confirmed / rejected / manual-override)
//   - The cardId the user picked (or null on reject)
//   - Field corrections (parser said X, user overwrote with Y)
//   - Timestamps
//
// What we DELIBERATELY skip for MVP:
//   - candidatesShown (would require passing the full suggestion list
//     from iOS on confirm — couples wire shape). Later enhancement.
//
// How this feeds learning:
//   - `corrections[]` isolates parser failure modes: if 40 users say
//     parser: parallel="Refractor" → corrected: parallel="Reptilian
//     Refractor", that's direct evidence to fix the parser rule.
//   - `pickedCardId` per query builds a "what users actually pick"
//     signal for future ranking.
//   - `rejected` events with high-tier suggestions being rejected
//     are the highest-priority parser bugs.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const TTL_SEC = 365 * 24 * 3600;

export interface FieldCorrection {
  field: string;
  before: unknown;
  after: unknown;
}

/** What the auto-parser produced BEFORE user edits. Snapshotted at emit
 *  time so we can compare against `corrections` even if the holding gets
 *  mutated later. */
export interface AutoParsedSnapshot {
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  /** parser's own confidence on this parse (0-1). Correlates with
   *  correction rate. */
  parseConfidence?: number | null;
}

export type SuggesterUserAction = "confirmed" | "rejected" | "manual-override";

export interface SuggesterFeedbackDoc {
  /** Composite id: `${holdingId}::${observedAtEpochMs}` — safe for
   *  multiple confirm/reject events on the same holding (e.g. user
   *  confirms, then flags-wrong, then re-confirms). */
  id: string;
  /** Partition — feedback is scoped to the contributing user. */
  userId: string;
  holdingId: string;

  /** The holding source that generated this feedback (ebay import,
   *  manual entry, etc.). Correlates parser bugs by ingest path. */
  holdingSource: string | null;

  /** What our parser produced pre-attestation. */
  autoParsed: AutoParsedSnapshot;

  /** The user's action on the suggestion. */
  userAction: SuggesterUserAction;

  /** cardId the user picked. Null on `rejected`. On `confirmed` with no
   *  cardId picked (user just cleaned fields but didn't pick a
   *  canonical id), also null. */
  pickedCardId: string | null;

  /** Fields the user CHANGED during confirmation. Empty array on
   *  no-op confirms. This is the gold data — direct parser corrections. */
  corrections: FieldCorrection[];

  /** ISO timestamp — when we wrote this record. */
  observedAt: string;

  ttl: number;
}

export interface RecordFeedbackInput {
  userId: string;
  holdingId: string;
  holdingSource?: string | null;
  autoParsed: AutoParsedSnapshot;
  userAction: SuggesterUserAction;
  pickedCardId?: string | null;
  corrections?: FieldCorrection[];
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
      const containerId = process.env.COSMOS_SUGGESTER_FEEDBACK_CONTAINER ?? "suggester_feedback";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/userId"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "suggester_feedback_init_failed",
        source: "suggesterFeedback.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Fire-and-forget feedback capture. Silent no-op on missing userId or
 * Cosmos absence — never blocks or fails the parent confirm/reject flow.
 */
export async function recordSuggesterFeedback(input: RecordFeedbackInput): Promise<void> {
  if (!input.userId?.trim() || !input.holdingId?.trim()) return;
  const c = await getContainer();
  if (!c) return;

  const observedAt = new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const doc: SuggesterFeedbackDoc = {
    id: `${input.holdingId.trim()}::${observedMs}`,
    userId: input.userId.trim(),
    holdingId: input.holdingId.trim(),
    holdingSource: input.holdingSource ?? null,
    autoParsed: input.autoParsed,
    userAction: input.userAction,
    pickedCardId: input.pickedCardId ?? null,
    corrections: input.corrections ?? [],
    observedAt,
    ttl: TTL_SEC,
  };

  try {
    await c.items.upsert(doc as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "suggester_feedback_upsert_error",
      source: "suggesterFeedback.service",
      userId: input.userId,
      holdingId: input.holdingId,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/**
 * Query feedback for a single user (partition-hit). Ordered newest first.
 * Used by the future feedback dashboard + retraining pipeline.
 */
export async function readFeedbackByUser(input: {
  userId: string;
  action?: SuggesterUserAction;
  limit?: number;
}): Promise<SuggesterFeedbackDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const q = input.action
    ? {
        query:
          "SELECT TOP @lim * FROM c WHERE c.userId = @uid AND c.userAction = @act ORDER BY c.observedAt DESC",
        parameters: [
          { name: "@lim", value: limit },
          { name: "@uid", value: input.userId },
          { name: "@act", value: input.action },
        ],
      }
    : {
        query:
          "SELECT TOP @lim * FROM c WHERE c.userId = @uid ORDER BY c.observedAt DESC",
        parameters: [
          { name: "@lim", value: limit },
          { name: "@uid", value: input.userId },
        ],
      };
  try {
    const { resources } = await c.items.query(q, { partitionKey: input.userId }).fetchAll();
    return resources as SuggesterFeedbackDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "suggester_feedback_read_error",
      source: "suggesterFeedback.service",
      userId: input.userId,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

/**
 * Cross-user query for feedback on a specific cardId. Used to detect
 * "one user attested wrong, correct against consensus." Cross-partition,
 * expensive at scale — use sparingly.
 */
export async function readFeedbackByCardId(input: {
  cardId: string;
  limit?: number;
}): Promise<SuggesterFeedbackDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const q = {
    query:
      "SELECT TOP @lim * FROM c WHERE c.pickedCardId = @cid AND c.userAction = 'confirmed' ORDER BY c.observedAt DESC",
    parameters: [
      { name: "@lim", value: limit },
      { name: "@cid", value: input.cardId },
    ],
  };
  try {
    const { resources } = await c.items.query(q).fetchAll();
    return resources as SuggesterFeedbackDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "suggester_feedback_read_by_card_error",
      source: "suggesterFeedback.service",
      cardId: input.cardId,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
