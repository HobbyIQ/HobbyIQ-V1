// CF-WEEKLY-DIGEST (Drew, 2026-09-02). Cosmos R/W for rendered weekly
// digests, mirroring actionPlanSnapshotStore's shape.
//
// Container `weekly_digests`, partition /userId, doc id
// `{userId}::{weekId}`. That id IS the idempotency guarantee: re-running
// Sunday's job for the same ISO week upserts the same document. There is
// no path that mints a second digest for a week — not a retry, not a
// manual dispatch, not a backfill.
//
// TTL 400 days: thirteen months keeps a full year of Sundays plus the
// wrap-around, which is as far back as anyone reads a weekly digest.
//
// Delivery state lives on the SAME document (deliveredAt / deliveryReason)
// rather than a sibling container, so "was this week's digest sent?" is a
// point read on the doc the digest already is — and a re-run that finds
// deliveredAt set does not re-send.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { WeeklyDigest } from "./weeklyDigestBuild.service.js";

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const DIGEST_CONTAINER = process.env.COSMOS_WEEKLY_DIGESTS_CONTAINER ?? "weekly_digests";
const TTL_SEC = 400 * 24 * 3600;

export type DigestDeliveryChannel = "email" | "in-app";

export interface WeeklyDigestDoc {
  id: string;
  userId: string;
  weekId: string;
  docType: "weekly_digest";
  digest: WeeklyDigest;
  computedAt: string;
  /** ISO timestamp of a SUCCESSFUL delivery. Absent/null = never sent;
   *  the job skips re-sending when this is set. */
  deliveredAt?: string | null;
  deliveryChannel?: DigestDeliveryChannel | null;
  /** Why delivery did not happen, when it did not. Never the address. */
  deliveryReason?: string | null;
  ttl: number;
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function init(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: DIGEST_CONTAINER,
        partitionKey: { paths: ["/userId"] },
        defaultTtl: -1,
      });
      _container = container;
      return _container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "weekly_digest_store_init_error",
        source: "weeklyDigestStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

/** Test seam — mirrors actionPlanSnapshotStore._setContainersForTesting. */
export function _setContainerForTesting(c: Container | null): void {
  _container = c;
  _initPromise = null;
}

export function weeklyDigestDocId(userId: string, weekId: string): string {
  return `${userId}::${weekId}`;
}

/**
 * Persist a digest. Idempotent per (userId, weekId) by construction — the
 * doc id is derived from both, so a second run for the same week REPLACES
 * rather than appends.
 *
 * Delivery state on an existing doc is preserved: a re-run that recomputes
 * the same week must not forget that the mail already went out, or the
 * next run would send it twice.
 */
export async function upsertWeeklyDigest(digest: WeeklyDigest): Promise<WeeklyDigestDoc | null> {
  const container = await init();
  if (!container) return null;
  const id = weeklyDigestDocId(digest.userId, digest.weekId);

  let existing: WeeklyDigestDoc | null = null;
  try {
    const { resource } = await container.item(id, digest.userId).read<WeeklyDigestDoc>();
    existing = resource ?? null;
  } catch {
    existing = null;
  }

  const doc: WeeklyDigestDoc = {
    id,
    userId: digest.userId,
    weekId: digest.weekId,
    docType: "weekly_digest",
    digest,
    computedAt: new Date().toISOString(),
    deliveredAt: existing?.deliveredAt ?? null,
    deliveryChannel: existing?.deliveryChannel ?? null,
    deliveryReason: existing?.deliveryReason ?? null,
    ttl: TTL_SEC,
  };

  try {
    await container.items.upsert(doc);
    return doc;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "weekly_digest_upsert_error",
      weekId: digest.weekId,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

/** Point read of one week's digest. */
export async function readWeeklyDigest(userId: string, weekId: string): Promise<WeeklyDigestDoc | null> {
  const container = await init();
  if (!container) return null;
  try {
    const { resource } = await container
      .item(weeklyDigestDocId(userId, weekId), userId)
      .read<WeeklyDigestDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

/** Newest-first list of a user's digests. Single-partition query. */
export async function listWeeklyDigests(userId: string, limit = 12): Promise<WeeklyDigestDoc[]> {
  const container = await init();
  if (!container) return [];
  try {
    const iter = container.items.query<WeeklyDigestDoc>({
      query:
        "SELECT TOP @limit * FROM c WHERE c.userId = @u AND c.docType = 'weekly_digest' ORDER BY c.weekId DESC",
      parameters: [
        { name: "@u", value: userId },
        { name: "@limit", value: Math.max(1, Math.min(52, limit)) },
      ],
    }, { partitionKey: userId });
    const out: WeeklyDigestDoc[] = [];
    while (iter.hasMoreResults()) {
      const page = await iter.fetchNext();
      if (page.resources) out.push(...page.resources);
    }
    return out;
  } catch {
    return [];
  }
}

/** Record the outcome of a delivery attempt on the existing digest doc. */
export async function markWeeklyDigestDelivery(
  userId: string,
  weekId: string,
  outcome: { delivered: boolean; channel?: DigestDeliveryChannel; reason?: string | null },
): Promise<void> {
  const container = await init();
  if (!container) return;
  const id = weeklyDigestDocId(userId, weekId);
  try {
    const { resource } = await container.item(id, userId).read<WeeklyDigestDoc>();
    if (!resource) return;
    resource.deliveredAt = outcome.delivered ? new Date().toISOString() : resource.deliveredAt ?? null;
    resource.deliveryChannel = outcome.delivered ? outcome.channel ?? "email" : resource.deliveryChannel ?? null;
    resource.deliveryReason = outcome.delivered ? null : outcome.reason ?? "unknown";
    await container.items.upsert(resource);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "weekly_digest_delivery_mark_error",
      weekId,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}
