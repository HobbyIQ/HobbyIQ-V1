import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "crypto";

export interface WatchlistItem {
  id: string;
  userId: string;
  playerId: string;
  playerName: string;
  sport: string;
  alertEnabled: boolean;
  createdAt: string;
}

export interface AddWatchlistInput {
  playerId: string;
  playerName: string;
  sport?: string;
  alertEnabled?: boolean;
}

interface WatchlistDoc extends WatchlistItem {
  docType: "watchlist";
}

// ─── Cosmos client (lazy init) ───────────────────────────────────────────────
let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

const isTestMode = process.env.NODE_ENV === "test";
const memStore = new Map<string, WatchlistDoc[]>(); // userId -> docs

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName = process.env.COSMOS_WATCHLIST_CONTAINER ?? "watchlist";

      if (!endpoint && !connStr) {
        if (isTestMode) {
          console.log("[watchlist] TEST MODE: using in-memory store");
          return null;
        }
        throw new Error("[watchlist] COSMOS_ENDPOINT or COSMOS_CONNECTION_STRING must be set");
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
        id: containerName,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log("[watchlist] Cosmos DB connected");
      return container;
    } catch (err: any) {
      throw new Error(`[watchlist] Cosmos initialization failed: ${err.message}`);
    }
  })();
  return _initPromise;
}

function toItem(doc: WatchlistDoc): WatchlistItem {
  return {
    id: doc.id,
    userId: doc.userId,
    playerId: doc.playerId,
    playerName: doc.playerName,
    sport: doc.sport,
    alertEnabled: doc.alertEnabled,
    createdAt: doc.createdAt,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getWatchlist(userId: string): Promise<WatchlistItem[]> {
  const container = await getContainer();
  if (!container && isTestMode) {
    return (memStore.get(userId) ?? []).map(toItem);
  }
  const { resources } = await container!.items
    .query<WatchlistDoc>({
      query: 'SELECT * FROM c WHERE c["userId"] = @uid AND c["docType"] = @t',
      parameters: [
        { name: "@uid", value: userId },
        { name: "@t", value: "watchlist" },
      ],
    }, { partitionKey: userId })
    .fetchAll();

  return resources
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toItem);
}

export async function addToWatchlist(
  userId: string,
  input: AddWatchlistInput,
): Promise<WatchlistItem> {
  const playerId = String(input.playerId ?? "").trim();
  const playerName = String(input.playerName ?? "").trim();
  if (!playerId || !playerName) {
    throw new Error("playerId and playerName are required");
  }

  // Idempotent: if a row already exists for (userId, playerId), update it.
  const existing = await getWatchlist(userId);
  const dupe = existing.find((it) => it.playerId === playerId);

  const now = new Date().toISOString();
  const doc: WatchlistDoc = dupe
    ? {
        id: dupe.id,
        userId,
        playerId,
        playerName,
        sport: String(input.sport ?? dupe.sport ?? "baseball"),
        alertEnabled: input.alertEnabled ?? dupe.alertEnabled ?? false,
        createdAt: dupe.createdAt,
        docType: "watchlist",
      }
    : {
        id: randomUUID(),
        userId,
        playerId,
        playerName,
        sport: String(input.sport ?? "baseball"),
        alertEnabled: input.alertEnabled ?? false,
        createdAt: now,
        docType: "watchlist",
      };

  const container = await getContainer();
  if (!container && isTestMode) {
    const list = memStore.get(userId) ?? [];
    const idx = list.findIndex((d) => d.id === doc.id);
    if (idx >= 0) list[idx] = doc;
    else list.push(doc);
    memStore.set(userId, list);
    return toItem(doc);
  }

  const { resource } = await container!.items.upsert<WatchlistDoc>(doc);
  return toItem(resource as WatchlistDoc);
}

export async function removeFromWatchlist(
  userId: string,
  itemId: string,
): Promise<boolean> {
  const id = String(itemId ?? "").trim();
  if (!id) return false;

  const container = await getContainer();
  if (!container && isTestMode) {
    const list = memStore.get(userId) ?? [];
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    memStore.set(userId, next);
    return true;
  }

  try {
    await container!.item(id, userId).delete();
    return true;
  } catch (err: any) {
    if (err?.code === 404) return false;
    throw err;
  }
}

export async function toggleAlert(
  userId: string,
  itemId: string,
  alertEnabled: boolean,
): Promise<WatchlistItem | null> {
  const id = String(itemId ?? "").trim();
  if (!id) return null;

  const container = await getContainer();
  if (!container && isTestMode) {
    const list = memStore.get(userId) ?? [];
    const idx = list.findIndex((d) => d.id === id);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], alertEnabled: !!alertEnabled };
    memStore.set(userId, list);
    return toItem(list[idx]);
  }

  try {
    const { resource } = await container!.item(id, userId).patch<WatchlistDoc>({
      operations: [
        { op: "set", path: "/alertEnabled", value: !!alertEnabled },
      ],
    });
    return resource ? toItem(resource as WatchlistDoc) : null;
  } catch (err: any) {
    if (err?.code === 404) return null;
    throw err;
  }
}
