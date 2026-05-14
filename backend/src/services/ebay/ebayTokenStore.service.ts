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
    console.error("[ebayTokenStore] Failed to persist file store:", err);
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
        console.warn("[ebayTokenStore] No Cosmos config, using file fallback");
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
      console.error("[ebayTokenStore] Cosmos init failed:", err?.message ?? String(err));
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
