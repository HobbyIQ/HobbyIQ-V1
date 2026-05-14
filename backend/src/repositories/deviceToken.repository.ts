// DeviceTokenRepository — Cosmos store of APNs device tokens per user.
// Container: device_tokens, partition /userId.
// Per rules: device tokens NEVER live in memory only — they must persist in Cosmos.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface DeviceTokenRecord {
  userId: string;
  token: string;
  platform: "ios" | "android";
  bundleId?: string;
  createdAt: string;
  updatedAt: string;
}

interface DeviceTokenDocument extends DeviceTokenRecord {
  id: string;              // == `${userId}_${token}`
  docType: "device_token";
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

function makeId(userId: string, token: string): string {
  return `${userId}_${token}`;
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
      const containerName = process.env.COSMOS_DEVICE_TOKENS_CONTAINER ?? "device_tokens";

      if (!endpoint && !connStr) {
        console.warn("[deviceToken.repository] COSMOS not configured — repository disabled");
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
        id: containerName,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log(`[deviceToken.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[deviceToken.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

export async function registerToken(
  userId: string,
  token: string,
  platform: "ios" | "android" = "ios",
  bundleId?: string,
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const now = new Date().toISOString();
  const id = makeId(userId, token);

  let createdAt = now;
  try {
    const { resource } = await container.item(id, userId).read<DeviceTokenDocument>();
    if (resource?.createdAt) createdAt = resource.createdAt;
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }

  const doc: DeviceTokenDocument = {
    id,
    userId,
    token,
    platform,
    bundleId,
    createdAt,
    updatedAt: now,
    docType: "device_token",
  };
  await container.items.upsert(doc, { disableAutomaticIdGeneration: true });
}

export async function getTokensForUser(userId: string): Promise<DeviceTokenRecord[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<DeviceTokenDocument>({
        query: 'SELECT c["userId"], c["token"], c["platform"], c["bundleId"], c["createdAt"], c["updatedAt"] FROM c WHERE c["userId"] = @userId AND c["docType"] = "device_token"',
        parameters: [{ name: "@userId", value: userId }],
      }, { partitionKey: userId })
      .fetchAll();
    return resources ?? [];
  } catch (err: any) {
    console.error("[deviceToken.repository] getTokensForUser failed:", err?.message ?? err);
    return [];
  }
}

export async function getTokensForUsers(userIds: string[]): Promise<Map<string, DeviceTokenRecord[]>> {
  const out = new Map<string, DeviceTokenRecord[]>();
  const container = await getContainer();
  if (!container) return out;
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  await Promise.all(
    unique.map(async (uid) => {
      const tokens = await getTokensForUser(uid);
      if (tokens.length) out.set(uid, tokens);
    }),
  );
  return out;
}

export async function removeToken(userId: string, token: string): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const id = makeId(userId, token);
  try {
    await container.item(id, userId).delete();
  } catch (err: any) {
    if (err?.code === 404) return;
    console.error("[deviceToken.repository] removeToken failed:", err?.message ?? err);
  }
}
