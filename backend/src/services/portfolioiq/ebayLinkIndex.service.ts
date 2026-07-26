// CF-EBAY-LINK-INDEX-P0.5 (Drew, 2026-07-26). Dedicated Cosmos container
// that maps an eBay identifier (offerId or listingId) → the HobbyIQ
// holding it's linked to. Turns the per-webhook cross-partition scan of
// the portfolio container into a single-partition point read.
//
// Container: `ebay_link_index`, partition `/ebayId`. One doc per
// (ebayIdKind, ebayId) tuple — a single link produces two docs (offer
// row + listing row) since callers look up by either identifier.
//
// Doc shape:
//   { id: "offer::<offerId>" | "listing::<listingId>",
//     ebayId: "<offerId>" | "<listingId>",
//     ebayIdKind: "offer" | "listing",
//     userId, holdingId,
//     linkedAt: ISO timestamp,
//     ttl: -1 }
//
// Semantics:
//   - Writes are BEST-EFFORT. `linkEbayListing` in portfolioStore never
//     fails on an index write error — the linked holding is the source of
//     truth. A missed index write becomes a read-time index-miss and
//     falls back to the legacy cross-partition scan.
//   - Reads return null on any container/query error. Callers MUST have
//     a legacy-scan fallback path until backfill catches up on
//     historical holdings.
//   - Container is auto-created on first init (createIfNotExists) — same
//     pattern as sold_comps / portfolio. Container creation itself is
//     idempotent; a fresh App Service instance will create-if-missing
//     within the first eBay-link webhook.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface EbayLinkIndexEntry {
  userId: string;
  holdingId: string;
  ebayId: string;
  ebayIdKind: "offer" | "listing";
  linkedAt: string;
}

interface IndexDoc extends EbayLinkIndexEntry {
  id: string;
  ttl: number;
}

const CONTAINER_ID_DEFAULT = "ebay_link_index";

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
let _testContainer: Container | null = null;

/** For tests: substitute a fake Container. Pass null to reset. */
export function _setContainerForTests(c: Container | null): void {
  _testContainer = c;
  _container = null;
  _initPromise = null;
}

async function getContainer(): Promise<Container | null> {
  if (_testContainer) return _testContainer;
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_EBAY_LINK_INDEX_CONTAINER ?? CONTAINER_ID_DEFAULT;
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
        partitionKey: { paths: ["/ebayId"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ebay_link_index_init_failed",
        source: "ebayLinkIndex.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

function docId(kind: "offer" | "listing", ebayId: string): string {
  return `${kind}::${ebayId}`;
}

/**
 * Best-effort write of the index rows for a newly-linked holding. Writes
 * up to two rows (one per identifier). Failure is logged but never thrown;
 * the linking flow must not fail because a secondary index write failed.
 */
export async function writeLinkIndex(params: {
  userId: string;
  holdingId: string;
  offerId?: string | null;
  listingId?: string | null;
}): Promise<{ offerWritten: boolean; listingWritten: boolean }> {
  const { userId, holdingId, offerId, listingId } = params;
  if (!userId || !holdingId) return { offerWritten: false, listingWritten: false };
  const container = await getContainer();
  if (!container) return { offerWritten: false, listingWritten: false };
  const linkedAt = new Date().toISOString();
  const results = await Promise.all([
    offerId
      ? upsertOne(container, {
          id: docId("offer", offerId),
          ebayId: offerId,
          ebayIdKind: "offer",
          userId,
          holdingId,
          linkedAt,
          ttl: -1,
        })
      : Promise.resolve(false),
    listingId
      ? upsertOne(container, {
          id: docId("listing", listingId),
          ebayId: listingId,
          ebayIdKind: "listing",
          userId,
          holdingId,
          linkedAt,
          ttl: -1,
        })
      : Promise.resolve(false),
  ]);
  return { offerWritten: results[0], listingWritten: results[1] };
}

async function upsertOne(container: Container, doc: IndexDoc): Promise<boolean> {
  try {
    await container.items.upsert(doc);
    return true;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_link_index_upsert_failed",
      source: "ebayLinkIndex.service",
      ebayId: doc.ebayId,
      ebayIdKind: doc.ebayIdKind,
      error: (err as Error)?.message ?? String(err),
    }));
    return false;
  }
}

/**
 * Best-effort delete of the index rows for a holding that has just been
 * unlinked from eBay. Skips ids that are null/empty. Failure is logged but
 * never thrown.
 */
export async function removeLinkIndex(params: {
  offerId?: string | null;
  listingId?: string | null;
}): Promise<{ offerDeleted: boolean; listingDeleted: boolean }> {
  const { offerId, listingId } = params;
  const container = await getContainer();
  if (!container) return { offerDeleted: false, listingDeleted: false };
  const results = await Promise.all([
    offerId ? deleteOne(container, "offer", offerId) : Promise.resolve(false),
    listingId ? deleteOne(container, "listing", listingId) : Promise.resolve(false),
  ]);
  return { offerDeleted: results[0], listingDeleted: results[1] };
}

async function deleteOne(
  container: Container,
  kind: "offer" | "listing",
  ebayId: string,
): Promise<boolean> {
  try {
    await container.item(docId(kind, ebayId), ebayId).delete();
    return true;
  } catch (err: any) {
    // 404 = already gone; treat as success (idempotent).
    if (err?.code === 404 || err?.statusCode === 404) return true;
    console.warn(JSON.stringify({
      event: "ebay_link_index_delete_failed",
      source: "ebayLinkIndex.service",
      ebayId,
      ebayIdKind: kind,
      error: err?.message ?? String(err),
    }));
    return false;
  }
}

/** Point-read lookup by offerId. Returns null on miss OR error — caller
 *  must fall back to a legacy scan until backfill is complete. */
export async function findByOfferId(offerId: string): Promise<EbayLinkIndexEntry | null> {
  return findByEbayId("offer", offerId);
}

/** Point-read lookup by listingId. Same contract as findByOfferId. */
export async function findByListingId(listingId: string): Promise<EbayLinkIndexEntry | null> {
  return findByEbayId("listing", listingId);
}

async function findByEbayId(
  kind: "offer" | "listing",
  ebayId: string,
): Promise<EbayLinkIndexEntry | null> {
  if (!ebayId) return null;
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(docId(kind, ebayId), ebayId).read<IndexDoc>();
    if (!resource) return null;
    return {
      userId: resource.userId,
      holdingId: resource.holdingId,
      ebayId: resource.ebayId,
      ebayIdKind: resource.ebayIdKind,
      linkedAt: resource.linkedAt,
    };
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) return null;
    console.warn(JSON.stringify({
      event: "ebay_link_index_read_failed",
      source: "ebayLinkIndex.service",
      ebayId,
      ebayIdKind: kind,
      error: err?.message ?? String(err),
    }));
    return null;
  }
}
