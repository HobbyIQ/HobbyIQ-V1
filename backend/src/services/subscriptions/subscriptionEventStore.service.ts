// CF-PAYMENTS-APPLE-2 (2026-06-03): event log + idempotency for the V2
// notifications webhook.
//
// Storage: new Cosmos container `subscription_events`.
//   Partition key: /originalTransactionId
//   Doc id:        notificationUUID
//
// Why partition by originalTransactionId:
//   - Events for a single subscription cluster on one partition,
//     so audit queries by transaction are local reads (no fan-out).
//   - The webhook's idempotency probe is a point read by (id, partition):
//     `container.item(notificationUUID, originalTransactionId).read()`
//     which is the cheapest Cosmos op possible (~1 RU, ~5ms).
//   - Hot-partition risk would only matter if one subscription
//     processed many events/sec — Apple's notification frequency for a
//     given subscription is bounded (a few/month), so partition skew
//     is not a concern.
//
// Why notificationUUID as doc id:
//   - Apple's documented idempotency key. Same UUID = same notification.
//   - Lets us upsert idempotently — a replay just overwrites the same
//     doc with the same data.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export type EventResult =
  | "applied"        // plan / appleSubscription was mutated
  | "noop_replay"    // notificationUUID seen before; no change
  | "no_user"        // verified payload but no HobbyIQ user owns the txn
  | "no_change"      // type matched but state was already correct
  | "log_only";      // type is informational (PRICE_INCREASE, etc.)

export interface NotificationEvent {
  id: string;                        // notificationUUID
  originalTransactionId: string;     // partition key
  notificationType: string;
  subtype: string | null;
  receivedAt: string;
  productId: string | null;
  expiresDate: number | null;
  userId: string | null;             // null when user lookup failed
  result: EventResult;
  appleEnvironment: string;
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
const isTestMode = process.env.NODE_ENV === "test";
const _testMemStore = new Map<string, NotificationEvent>();
const memKey = (id: string, partition: string) => `${partition}::${id}`;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName =
        process.env.COSMOS_SUBSCRIPTION_EVENTS_CONTAINER ?? "subscription_events";

      if (!endpoint && !connStr) {
        if (isTestMode) {
          console.log("[subscriptionEventStore] TEST MODE: using in-memory store");
          return null;
        }
        console.warn("[subscriptionEventStore] COSMOS not configured");
        return null;
      }
      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/originalTransactionId"] },
      });
      _container = container;
      console.log("[subscriptionEventStore] Cosmos subscription_events ready");
      return container;
    } catch (err: any) {
      console.error(`[cosmos][apple][subscriptionEventStore] Cosmos init failed: ${err.message}`);
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Point-read the event by (notificationUUID, originalTransactionId).
 * Returns null if not previously seen. Hot path — every webhook call
 * does this before any verification work, so a replay returns 200 with
 * minimal cost.
 *
 * Reordered note: actually the webhook verifies FIRST, then checks
 * idempotency, because (a) verification is the security barrier and
 * a forged payload must never get a 200, and (b) we need the verified
 * payload's originalTransactionId to form the partition lookup.
 */
export async function getEvent(
  notificationUUID: string,
  originalTransactionId: string,
): Promise<NotificationEvent | null> {
  const container = await getContainer();
  if (!container) {
    return _testMemStore.get(memKey(notificationUUID, originalTransactionId)) ?? null;
  }
  try {
    const { resource } = await container
      .item(notificationUUID, originalTransactionId)
      .read<NotificationEvent>();
    return resource ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert the event. Idempotent — same doc id + partition is rewritten
 * with the latest fields. Caller (notificationHandler) computes the
 * final result and persists exactly once per webhook call.
 */
export async function saveEvent(event: NotificationEvent): Promise<void> {
  const container = await getContainer();
  if (!container) {
    _testMemStore.set(memKey(event.id, event.originalTransactionId), event);
    return;
  }
  await container.items.upsert(event);
}

/**
 * Test-only reset. Clears the in-memory event store + the container
 * handle so the next call re-initializes.
 */
/**
 * CF-ACCOUNT-DELETION (2026-06-04): anonymize subscription_events rows
 * tied to the user — null `userId` only. Apple's `originalTransactionId`
 * stays (partition key + Apple's own identifier, not ours).
 *
 * Outcome shape after anonymization is identical to the "no_user" branch
 * the handler already writes when Apple delivers a notification before
 * the user has linked via /verify — so downstream readers handle it
 * transparently.
 */
export async function anonymizeSubscriptionEventsForUser(userId: string): Promise<number> {
  if (!userId || !String(userId).trim()) return 0;
  const container = await getContainer();
  if (!container) {
    let mutated = 0;
    for (const e of _testMemStore.values()) {
      if (e.userId === userId) {
        e.userId = null;
        mutated += 1;
      }
    }
    return mutated;
  }
  let updated = 0;
  try {
    const { resources } = await container.items
      .query<{ id: string; originalTransactionId: string }>({
        query: "SELECT c.id, c.originalTransactionId FROM c WHERE c.userId = @uid",
        parameters: [{ name: "@uid", value: userId }],
      })
      .fetchAll();
    for (const row of resources) {
      try {
        await container.item(row.id, row.originalTransactionId).patch([
          { op: "set", path: "/userId", value: null },
        ]);
        updated += 1;
      } catch (err: any) {
        if (err?.code === 404) continue;
        console.error("[apple][subscriptionEventStore] anonymizeSubscriptionEventsForUser item failed:", err?.message ?? err);
      }
    }
  } catch (err: any) {
    console.error("[apple][subscriptionEventStore] anonymizeSubscriptionEventsForUser failed:", err?.message ?? err);
  }
  return updated;
}

export function _resetForTests(): void {
  _testMemStore.clear();
  _container = null;
  _initPromise = null;
}
