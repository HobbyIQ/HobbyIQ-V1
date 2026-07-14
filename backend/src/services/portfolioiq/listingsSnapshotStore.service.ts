// CF-SUPPLY-DEMAND-SIGNAL (Drew, 2026-07-13, PR #420): Cosmos-backed
// store for daily eBay listings snapshots. Each snapshot is one
// (player, date) pair with the total listing count and median asking
// price observed that day.
//
// Read pattern: computeListingsTrend(player, days=30) queries N days
// of snapshots and fits a regression to (date, listingCount) — the
// slope is the supply trend.
//
// Container: `listings_snapshots`, partition `/player`.
// TTL: 90 days per doc (older data isn't useful for a 30d trend read).

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const TTL_SEC = 90 * 24 * 3600;

export interface ListingSnapshotDoc {
  id: string;                    // `{playerNormalized}::{YYYY-MM-DD}`
  player: string;                // partition key (normalized)
  playerDisplay: string;         // original spelling for display
  date: string;                  // "YYYY-MM-DD"
  totalListings: number;
  medianAsk: number | null;
  pricedItemCount: number;
  effectiveQuery: string;
  snapshottedAt: string;
  ttl: number;
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
      const containerId =
        process.env.COSMOS_LISTINGS_SNAPSHOTS_CONTAINER ?? "listings_snapshots";
      if (!endpoint && !connStr) {
        console.warn("[listingsSnapshotStore] no cosmos config — no-op mode");
        return null;
      }
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
        partitionKey: { paths: ["/player"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "listings_snapshot_store_init_failed",
        source: "listingsSnapshotStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

function normalizePlayer(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

/** Persist a daily snapshot. Idempotent on (player, date) — same-day
 *  re-snapshots overwrite. */
export async function upsertSnapshot(input: {
  playerDisplay: string;
  totalListings: number;
  medianAsk: number | null;
  pricedItemCount: number;
  effectiveQuery: string;
  snapshottedAt: string;
}): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  const player = normalizePlayer(input.playerDisplay);
  const date = input.snapshottedAt.slice(0, 10);   // YYYY-MM-DD
  const doc: ListingSnapshotDoc = {
    id: `${player}::${date}`,
    player,
    playerDisplay: input.playerDisplay,
    date,
    totalListings: input.totalListings,
    medianAsk: input.medianAsk,
    pricedItemCount: input.pricedItemCount,
    effectiveQuery: input.effectiveQuery,
    snapshottedAt: input.snapshottedAt,
    ttl: TTL_SEC,
  };
  try {
    await c.items.upsert(doc as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "listings_snapshot_upsert_error",
      source: "listingsSnapshotStore.service",
      player,
      date,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/** Fetch the last N days of snapshots for a player, oldest → newest. */
export async function readSnapshots(
  playerDisplay: string,
  days: number = 30,
): Promise<ListingSnapshotDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const player = normalizePlayer(playerDisplay);
  const cutoff = new Date(Date.now() - days * 86_400_000)
    .toISOString().slice(0, 10);
  const q = {
    query: "SELECT * FROM c WHERE c.player = @p AND c.date >= @cutoff ORDER BY c.date",
    parameters: [
      { name: "@p", value: player },
      { name: "@cutoff", value: cutoff },
    ],
  };
  try {
    const { resources } = await c.items.query(q, { partitionKey: player }).fetchAll();
    return resources as ListingSnapshotDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "listings_snapshot_read_error",
      source: "listingsSnapshotStore.service",
      player,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

/** Test hook — override container for unit tests. */
export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
