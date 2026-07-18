// CF-POST-SALE-ATTRIBUTION (Drew, 2026-07-17). Cosmos R/W on
// `action_plan_snapshots` and `action_plan_outcomes`. Records the
// verdict shown to a user for each holding at a point in time so
// when the user later sells the card we can attribute the outcome
// back to the verdict.
//
// Two containers on the same store:
//   • action_plan_snapshots — partition /holdingId, doc id
//     `{holdingId}::{YYYY-MM-DD}`. One per user-visit-day. Idempotent.
//   • action_plan_outcomes — partition /holdingId, doc id
//     `{holdingId}::{soldAtIso}`. One per confirmed sale.
//
// Both containers carry a 180-day TTL — attribution needs 30-60d
// windows to be useful and older data is noise.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { ActionVerdict } from "./dailyIqActionPlanCompute.service.js";

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SNAPSHOT_CONTAINER = process.env.COSMOS_ACTION_PLAN_SNAPSHOTS_CONTAINER ?? "action_plan_snapshots";
const OUTCOME_CONTAINER = process.env.COSMOS_ACTION_PLAN_OUTCOMES_CONTAINER ?? "action_plan_outcomes";
const TTL_SEC = 180 * 24 * 3600;

export interface ActionPlanSnapshotDoc {
  id: string;
  holdingId: string;
  userId: string;
  cardId: string | null;
  date: string;                    // YYYY-MM-DD (server day-of-observation)
  verdict: ActionVerdict;
  urgency: number;
  priceTarget: number | null;
  marketValueAtSnapshot: number | null;
  predictedPriceAtSnapshot: number | null;
  computedAt: string;
  ttl: number;
}

export type SaleOutcomeClass =
  | "verdict_hit"          // verdict was SELL_NOW/LIST_HIGHER and sale ≥ (target × 0.95)
  | "verdict_miss"         // above verdicts but sale < target × 0.95
  | "hold_sold"            // sold despite HOLD verdict (probable engine miss)
  | "no_verdict";           // no snapshot within the lookback window

export interface ActionPlanOutcomeDoc {
  id: string;
  holdingId: string;
  userId: string;
  cardId: string | null;
  soldAt: string;
  salePrice: number;
  verdictAtSaleTime: ActionVerdict | null;
  verdictSnapshotDate: string | null;
  priceTargetAtSnapshot: number | null;
  daysSinceVerdict: number | null;
  outcomeClass: SaleOutcomeClass;
  ttl: number;
}

let _snapshotContainer: Container | null = null;
let _outcomeContainer: Container | null = null;
let _initPromise: Promise<{ snapshots: Container | null; outcomes: Container | null }> | null = null;

async function init(): Promise<{ snapshots: Container | null; outcomes: Container | null }> {
  if (_snapshotContainer && _outcomeContainer) return { snapshots: _snapshotContainer, outcomes: _outcomeContainer };
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      if (!endpoint && !connStr) return { snapshots: null, outcomes: null };
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const [snap, out] = await Promise.all([
        database.containers.createIfNotExists({
          id: SNAPSHOT_CONTAINER,
          partitionKey: { paths: ["/holdingId"] },
          defaultTtl: -1,
        }),
        database.containers.createIfNotExists({
          id: OUTCOME_CONTAINER,
          partitionKey: { paths: ["/holdingId"] },
          defaultTtl: -1,
        }),
      ]);
      _snapshotContainer = snap.container;
      _outcomeContainer = out.container;
      return { snapshots: _snapshotContainer, outcomes: _outcomeContainer };
    } catch (err) {
      console.warn(JSON.stringify({
        event: "action_plan_store_init_error",
        source: "actionPlanSnapshotStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return { snapshots: null, outcomes: null };
    }
  })();
  return _initPromise;
}

/** Test seam. */
export function _setContainersForTesting(snap: Container | null, out: Container | null): void {
  _snapshotContainer = snap;
  _outcomeContainer = out;
  _initPromise = null;
}

function snapshotId(holdingId: string, date: string): string {
  return `${holdingId}::${date}`;
}

function outcomeId(holdingId: string, soldAt: string): string {
  return `${holdingId}::${soldAt}`;
}

/** Persist a per-holding verdict snapshot. Idempotent per (holdingId, date). */
export async function upsertSnapshot(input: Omit<ActionPlanSnapshotDoc, "id" | "ttl" | "computedAt">): Promise<void> {
  const { snapshots } = await init();
  if (!snapshots) return;
  const doc: ActionPlanSnapshotDoc = {
    id: snapshotId(input.holdingId, input.date),
    ttl: TTL_SEC,
    computedAt: new Date().toISOString(),
    ...input,
  };
  try {
    await snapshots.items.upsert(doc);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "action_plan_snapshot_upsert_error",
      holdingId: input.holdingId,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/** Read snapshots for a holding within the last N days. Sorted newest first. */
export async function readRecentSnapshots(holdingId: string, sinceDays = 60): Promise<ActionPlanSnapshotDoc[]> {
  const { snapshots } = await init();
  if (!snapshots) return [];
  const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const iter = snapshots.items.query<ActionPlanSnapshotDoc>({
      query: "SELECT * FROM c WHERE c.holdingId = @h AND c.date >= @cutoff ORDER BY c.date DESC",
      parameters: [
        { name: "@h", value: holdingId },
        { name: "@cutoff", value: cutoff },
      ],
    }, { partitionKey: holdingId });
    const out: ActionPlanSnapshotDoc[] = [];
    while (iter.hasMoreResults()) {
      const page = await iter.fetchNext();
      if (page.resources) out.push(...page.resources);
    }
    return out;
  } catch {
    return [];
  }
}

/** Write the outcome record. */
export async function upsertOutcome(input: Omit<ActionPlanOutcomeDoc, "id" | "ttl">): Promise<void> {
  const { outcomes } = await init();
  if (!outcomes) return;
  const doc: ActionPlanOutcomeDoc = {
    id: outcomeId(input.holdingId, input.soldAt),
    ttl: TTL_SEC,
    ...input,
  };
  try {
    await outcomes.items.upsert(doc);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "action_plan_outcome_upsert_error",
      holdingId: input.holdingId,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}
