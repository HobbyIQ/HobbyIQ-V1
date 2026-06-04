/**
 * eBay webhook event capture store (PR D.6).
 *
 * Implements the capture-before-process pattern for eBay marketplace
 * notifications. Every POST that arrives at /api/ebay/webhook is captured
 * to this Cosmos container BEFORE the topic-specific handler runs. This
 * guarantees:
 *
 *   1. Idempotency. eBay retries any non-2xx delivery aggressively, and
 *      occasionally redelivers 2xx-acknowledged events. We dedupe by
 *      eBay's own notificationId — if we've already captured it, we skip
 *      processing and ack 200.
 *
 *   2. Replayability. If a downstream handler (ITEM_SOLD → mark holding
 *      sold) crashes mid-flight, the raw payload survives in this
 *      container for offline replay.
 *
 *   3. Audit trail. Every event eBay ever sent us is durably stored,
 *      with topic + processing status, for >90 day reconciliation.
 *
 * Container shape (Cosmos NoSQL):
 *   id            = notificationId           (unique per event globally)
 *   notificationId= notificationId           (partition key, /notificationId)
 *   topic         = metadata.topic
 *   eventDate     = notification.eventDate
 *   capturedAt    = ISO timestamp of first write
 *   envelope      = full raw POST body as received
 *   status        = "captured" | "processed" | "error"
 *   processedAt?  = ISO timestamp of dispatch completion
 *   handlerResult?= small JSON describing what the handler did
 *   handlerError? = error message if status === "error"
 *
 * Test mode (NODE_ENV=test): uses an in-memory Map, no Cosmos required.
 */

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export type WebhookEventStatus = "captured" | "processed" | "error";

export interface WebhookEventDoc {
  id: string;
  notificationId: string;
  topic: string;
  eventDate?: string;
  capturedAt: string;
  envelope: unknown;
  status: WebhookEventStatus;
  processedAt?: string;
  handlerResult?: Record<string, unknown>;
  handlerError?: string;
}

const isTestMode = process.env.NODE_ENV === "test";
const testMemStore = new Map<string, WebhookEventDoc>();

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (isTestMode) return null;
  if (_container) return _container;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_WEBHOOK_EVENTS_CONTAINER ?? "webhook_events";

      if (!endpoint && !connStr) {
        console.warn("[webhookEvents] No Cosmos config; capture is disabled (events will not be persisted)");
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
        id: containerId,
        partitionKey: { paths: ["/notificationId"] },
      });

      _container = container;
      console.log("[webhookEvents] Cosmos connected, container=", containerId);
      return container;
    } catch (err: any) {
      console.error("[cosmos][ebay][webhookEvents] Cosmos init failed:", err?.message ?? String(err));
      return null;
    }
  })();

  return _initPromise;
}

/**
 * Returns true if a webhook event with this notificationId has already
 * been captured. Used by the dispatcher to short-circuit duplicate
 * deliveries. Never throws — on backing-store failure returns false so
 * the event is re-processed (better to dedupe at the handler layer than
 * to drop a real event because Cosmos blipped).
 */
export async function eventExists(notificationId: string): Promise<boolean> {
  if (!notificationId) return false;

  if (isTestMode) {
    return testMemStore.has(notificationId);
  }

  const container = await getContainer();
  if (!container) return false;

  try {
    const { resource } = await container
      .item(notificationId, notificationId)
      .read<WebhookEventDoc>();
    return Boolean(resource);
  } catch (err: any) {
    if (err?.code === 404) return false;
    console.error(
      "[ebay][webhookEvents] eventExists read failed:",
      err?.message ?? String(err),
    );
    return false;
  }
}

/**
 * Capture a raw eBay notification envelope to durable storage. Idempotent
 * by notificationId — if a doc already exists for this id, we leave it
 * alone and return { duplicate: true, captured: false }. Otherwise we
 * write a fresh "captured" doc and return { duplicate: false, captured: true }.
 *
 * Never throws — on backing-store failure returns { duplicate: false,
 * captured: false } so the dispatcher can still attempt to process.
 */
export async function captureEvent(input: {
  notificationId: string;
  topic: string;
  eventDate?: string;
  envelope: unknown;
}): Promise<{ duplicate: boolean; captured: boolean }> {
  const notificationId = String(input.notificationId ?? "").trim();
  if (!notificationId) {
    return { duplicate: false, captured: false };
  }

  const doc: WebhookEventDoc = {
    id: notificationId,
    notificationId,
    topic: input.topic ?? "UNKNOWN",
    eventDate: input.eventDate,
    capturedAt: new Date().toISOString(),
    envelope: input.envelope,
    status: "captured",
  };

  if (isTestMode) {
    if (testMemStore.has(notificationId)) {
      return { duplicate: true, captured: false };
    }
    testMemStore.set(notificationId, doc);
    return { duplicate: false, captured: true };
  }

  const container = await getContainer();
  if (!container) return { duplicate: false, captured: false };

  try {
    // Use create (not upsert) so a duplicate notificationId returns 409 rather
    // than overwriting the prior capture. We translate 409 → duplicate=true.
    await container.items.create(doc, { disableAutomaticIdGeneration: true });
    return { duplicate: false, captured: true };
  } catch (err: any) {
    if (err?.code === 409) {
      return { duplicate: true, captured: false };
    }
    console.error(
      "[ebay][webhookEvents] captureEvent write failed:",
      err?.message ?? String(err),
    );
    return { duplicate: false, captured: false };
  }
}

/**
 * Mark a previously captured event as processed (success). Best-effort:
 * never throws. If the doc is missing or the write fails we log and move
 * on; the next reconciliation pass can correct the status.
 */
export async function markEventProcessed(
  notificationId: string,
  handlerResult?: Record<string, unknown>,
): Promise<void> {
  if (!notificationId) return;

  if (isTestMode) {
    const existing = testMemStore.get(notificationId);
    if (existing) {
      existing.status = "processed";
      existing.processedAt = new Date().toISOString();
      if (handlerResult) existing.handlerResult = handlerResult;
    }
    return;
  }

  const container = await getContainer();
  if (!container) return;

  try {
    const { resource } = await container
      .item(notificationId, notificationId)
      .read<WebhookEventDoc>();
    if (!resource) return;
    const updated: WebhookEventDoc = {
      ...resource,
      status: "processed",
      processedAt: new Date().toISOString(),
      handlerResult: handlerResult ?? resource.handlerResult,
    };
    await container.items.upsert(updated);
  } catch (err: any) {
    console.error(
      "[ebay][webhookEvents] markEventProcessed failed:",
      err?.message ?? String(err),
    );
  }
}

/**
 * Mark a captured event as having failed processing. Best-effort.
 */
export async function markEventError(
  notificationId: string,
  handlerError: string,
): Promise<void> {
  if (!notificationId) return;

  if (isTestMode) {
    const existing = testMemStore.get(notificationId);
    if (existing) {
      existing.status = "error";
      existing.processedAt = new Date().toISOString();
      existing.handlerError = handlerError;
    }
    return;
  }

  const container = await getContainer();
  if (!container) return;

  try {
    const { resource } = await container
      .item(notificationId, notificationId)
      .read<WebhookEventDoc>();
    if (!resource) return;
    const updated: WebhookEventDoc = {
      ...resource,
      status: "error",
      processedAt: new Date().toISOString(),
      handlerError,
    };
    await container.items.upsert(updated);
  } catch (err: any) {
    console.error(
      "[ebay][webhookEvents] markEventError failed:",
      err?.message ?? String(err),
    );
  }
}

/**
 * Read a single captured event by notificationId. Used by tests +
 * future replay tooling. Returns null on miss or backing-store failure.
 */
export async function readEvent(
  notificationId: string,
): Promise<WebhookEventDoc | null> {
  if (!notificationId) return null;

  if (isTestMode) {
    return testMemStore.get(notificationId) ?? null;
  }

  const container = await getContainer();
  if (!container) return null;

  try {
    const { resource } = await container
      .item(notificationId, notificationId)
      .read<WebhookEventDoc>();
    return resource ?? null;
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error(
      "[ebay][webhookEvents] readEvent failed:",
      err?.message ?? String(err),
    );
    return null;
  }
}

/**
 * Test-only: clear the in-memory store between tests. No-op outside test mode.
 */
export function _resetForTests(): void {
  if (isTestMode) testMemStore.clear();
}
