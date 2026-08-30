import fs from "fs";
import path from "path";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface EbayTokenRecord {
  userId: string;
  ebayUserId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  scopes: string[];
  connectedAt: string;
  /**
   * EBAY-POLL-INGESTION-C1 (2026-06-01): cursor for `pollEbayOrdersForUser`.
   * MONOTONIC — never written back below its prior value, so an empty poll
   * (or a fetch failure mid-pagination) leaves the cursor unchanged and the
   * next poll re-walks the same window. First poll uses `connectedAt` as
   * the implicit starting point when this field is null/absent.
   */
  lastPolledAt?: string | null;
  /**
   * D26 (CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE, Drew 2026-08-30). The
   * connection's health as the POLL sees it, so an unusable connection is a
   * state the user can act on rather than a counter nobody reads.
   *
   * Measured 2026-08-30: `fetchFail=2` every cycle for weeks. Both users
   * (`admin-testing-hobbyiq`, `user-8aa46493`) had a live refresh token by
   * date and an expired access token, so `getAccessToken` took the refresh
   * branch and eBay rejected the grant — and NOTHING logged it, because
   * `pollEbayOrdersForUser` returns "fetch-failed" from the token step before
   * it reaches `ebay_poll_fetch_failed`. Zero occurrences of that event in
   * three days of traces while the counter read 2 every hour.
   *
   * "reconnect-required" means: no automated retry will fix this, the user
   * must re-authorise. The poll SKIPS such a user instead of burning a failed
   * eBay call on them every hour, and /api/ebay/status surfaces it so the
   * account page can say "Reconnect eBay". Absent means healthy — the OAuth
   * callback writes a fresh record, so a reconnect clears it by construction.
   */
  connectionStatus?: "ok" | "reconnect-required";
  /** Why. Short, human-readable, never a token or a secret. */
  connectionStatusReason?: string | null;
  /** When the status was last set. */
  connectionStatusAt?: string | null;
}

/** The connection health a caller may act on. Absent status reads "ok" so
 *  every record written before D26 is healthy until the poll says otherwise. */
export function connectionStatusOf(
  record: Pick<EbayTokenRecord, "connectionStatus"> | null | undefined,
): "ok" | "reconnect-required" {
  return record?.connectionStatus === "reconnect-required" ? "reconnect-required" : "ok";
}

interface EbayTokenDoc {
  id: string;
  userId: string;
  record: EbayTokenRecord;
  updatedAt: string;
}

const STORE_PATH = path.join(process.cwd(), ".data", "ebay-tokens.json");
const FILE_STORE: Record<string, EbayTokenRecord> = {};

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

function loadFileStore(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<string, EbayTokenRecord>;
    for (const [userId, record] of Object.entries(parsed)) {
      FILE_STORE[userId] = record;
    }
  } catch {
    // Keep empty fallback store if local file cannot be read.
  }
}

function saveFileStore(): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(FILE_STORE, null, 2), "utf8");
  } catch (err) {
    console.error("[ebay][ebayTokenStore] Failed to persist file store:", err);
  }
}

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_EBAY_TOKENS_CONTAINER ?? "ebay_connections";

      if (!endpoint && !connStr) {
        console.warn("[ebay][ebayTokenStore] No Cosmos config, using file fallback");
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/userId"] },
      });

      _container = container;
      console.log("[ebayTokenStore] Cosmos connected");
      return container;
    } catch (err: any) {
      console.error("[cosmos][ebay][ebayTokenStore] Cosmos init failed:", err?.message ?? String(err));
      return null;
    }
  })();

  return _initPromise;
}

loadFileStore();

export async function readTokenRecord(userId: string): Promise<EbayTokenRecord | null> {
  const local = FILE_STORE[userId];
  if (local) return local;

  const container = await getContainer();
  if (!container) return null;

  try {
    const { resource } = await container.item(userId, userId).read<EbayTokenDoc>();
    if (!resource?.record) return null;
    FILE_STORE[userId] = resource.record;
    saveFileStore();
    return resource.record;
  } catch (err: any) {
    if (err?.code === 404) return null;
    throw err;
  }
}

export async function writeTokenRecord(record: EbayTokenRecord): Promise<void> {
  FILE_STORE[record.userId] = record;
  saveFileStore();

  const container = await getContainer();
  if (!container) return;

  const doc: EbayTokenDoc = {
    id: record.userId,
    userId: record.userId,
    record,
    updatedAt: new Date().toISOString(),
  };
  await container.items.upsert(doc);
}

/**
 * D26. Mark a connection unusable until the user re-authorises, WITHOUT
 * deleting it.
 *
 * `getAccessToken` used to `deleteTokenRecord` on a dead refresh token. That
 * is why `refreshExpired=0` on every cycle while two users failed forever: the
 * first expiry removed the evidence, and a user who has silently vanished from
 * `listConnectedUserIds` cannot be shown a "Reconnect eBay" button. An expired
 * refresh token is inert — keeping the record costs nothing and is the only
 * way the account page can explain itself.
 *
 * Idempotent: re-marking an already-marked connection with the same reason
 * does not write, so an hourly poll cannot rewrite eight docs an hour.
 */
export async function markReconnectRequired(userId: string, reason: string): Promise<boolean> {
  const record = await readTokenRecord(userId);
  if (!record) return false;
  const trimmed = String(reason ?? "").slice(0, 300);
  if (record.connectionStatus === "reconnect-required" && record.connectionStatusReason === trimmed) {
    return false;
  }
  await writeTokenRecord({
    ...record,
    connectionStatus: "reconnect-required",
    connectionStatusReason: trimmed,
    connectionStatusAt: new Date().toISOString(),
  });
  console.warn(JSON.stringify({
    event: "ebay_connection_reconnect_required",
    source: "ebayTokenStore.service",
    userId,
    reason: trimmed,
  }));
  return true;
}

/** Clear the flag — a successful token acquisition proves the connection
 *  works again. Writes only when there is something to clear. */
export async function clearReconnectRequired(userId: string): Promise<boolean> {
  const record = await readTokenRecord(userId);
  if (!record || connectionStatusOf(record) === "ok") return false;
  await writeTokenRecord({
    ...record,
    connectionStatus: "ok",
    connectionStatusReason: null,
    connectionStatusAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    event: "ebay_connection_recovered",
    source: "ebayTokenStore.service",
    userId,
  }));
  return true;
}

/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01): list every userId with an eBay
 * connection. Used by the scheduled order-poll job to iterate connected
 * users. Returns the union of FILE_STORE keys + Cosmos doc userIds
 * (dedup'd). Cheap at current scale (one doc per connected user); revisit
 * if the connected-user count grows past ~10k.
 */
export async function listConnectedUserIds(): Promise<string[]> {
  const ids = new Set<string>(Object.keys(FILE_STORE));
  const container = await getContainer();
  if (container) {
    try {
      const { resources } = await container.items
        .query<{ userId: string }>({ query: "SELECT c.userId FROM c" })
        .fetchAll();
      for (const row of resources ?? []) {
        if (row?.userId) ids.add(row.userId);
      }
    } catch (err: any) {
      console.error(
        "[cosmos][ebay][ebayTokenStore] listConnectedUserIds Cosmos query failed:",
        err?.message ?? String(err),
      );
    }
  }
  return Array.from(ids);
}

export async function deleteTokenRecord(userId: string): Promise<void> {
  delete FILE_STORE[userId];
  saveFileStore();

  const container = await getContainer();
  if (!container) return;

  try {
    await container.item(userId, userId).delete();
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
}

/**
 * Reverse-lookup: given an eBay-side identifier (`username` or encrypted
 * `userId` from a marketplace-account-deletion notification), find the
 * matching HobbyIQ userId so we can delete that user's token record.
 *
 * Matches against the `ebayUserId` field on stored token records — which
 * was populated from eBay's commerce-identity endpoint at OAuth-callback
 * time and stores whichever identifier eBay returned (`username` first,
 * then encrypted `userId`).
 *
 * Returns null if no match is found. Webhooks must still respond 200 in
 * that case (eBay treats anything else as a delivery failure and retries).
 *
 * Implementation: scans the in-memory FILE_STORE first (covers all users
 * the App Service has seen since boot). On a miss, queries Cosmos via a
 * cross-partition equality filter. The token container is small (one doc
 * per connected user) so the cross-partition scan is cheap.
 */
export async function findUserIdByEbayUserId(
  ebayUserIdOrUsername: string,
): Promise<string | null> {
  if (!ebayUserIdOrUsername) return null;

  for (const [userId, record] of Object.entries(FILE_STORE)) {
    if (record.ebayUserId === ebayUserIdOrUsername) return userId;
  }

  const container = await getContainer();
  if (!container) return null;

  try {
    const { resources } = await container.items
      .query<{ userId: string }>({
        query: "SELECT TOP 1 c.userId FROM c WHERE c.record.ebayUserId = @id",
        parameters: [{ name: "@id", value: ebayUserIdOrUsername }],
      })
      .fetchAll();
    return resources[0]?.userId ?? null;
  } catch (err: any) {
    console.error(
      "[cosmos][ebay][ebayTokenStore] findUserIdByEbayUserId query failed:",
      err?.message ?? String(err),
    );
    return null;
  }
}
