import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CosmosClient, Container } from "@azure/cosmos";

type PortfolioHoldingRecord = Record<string, unknown> & { id: string };
type PortfolioStore = Record<string, PortfolioHoldingRecord[]>;

type CosmosPortfolioDoc = {
  id: string;
  userId: string;
  holdingId: string;
  updatedAt: string;
  payload: PortfolioHoldingRecord;
};

const storeFilePath = process.env.PORTFOLIO_HOLDINGS_FILE
  ? path.resolve(process.env.PORTFOLIO_HOLDINGS_FILE)
  : path.resolve(process.cwd(), "data", "portfolioHoldings.json");

const cosmosConnectionString = process.env.COSMOS_CONNECTION_STRING?.trim();
const cosmosDatabaseId = process.env.PORTFOLIO_COSMOS_DB || "hobbyiq";
const cosmosContainerId = process.env.PORTFOLIO_COSMOS_CONTAINER || "portfolio_holdings";

let cosmosContainerPromise: Promise<Container | null> | null = null;

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });
}

function readStore(): PortfolioStore {
  try {
    const raw = fs.readFileSync(storeFilePath, "utf8");
    const parsed = JSON.parse(raw) as PortfolioStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: PortfolioStore) {
  ensureStoreDir();
  fs.writeFileSync(storeFilePath, JSON.stringify(store, null, 2), "utf8");
}

function normalizeUserId(userId: string): string {
  return userId.trim();
}

function normalizeHolding(input: Record<string, unknown>): PortfolioHoldingRecord {
  const id = typeof input.id === "string" && input.id.trim()
    ? input.id.trim()
    : crypto.randomUUID();

  return {
    ...input,
    id,
  };
}

function toCosmosDocId(userId: string, holdingId: string): string {
  return `${userId}:${holdingId}`;
}

async function getCosmosContainer(): Promise<Container | null> {
  if (!cosmosConnectionString) return null;
  if (cosmosContainerPromise) return cosmosContainerPromise;

  cosmosContainerPromise = (async () => {
    try {
      const client = new CosmosClient(cosmosConnectionString);
      const { database } = await client.databases.createIfNotExists({ id: cosmosDatabaseId });
      const { container } = await database.containers.createIfNotExists({
        id: cosmosContainerId,
        partitionKey: { paths: ["/userId"] },
      });
      return container;
    } catch (err) {
      console.error("[portfolio] Cosmos init failed, falling back to file store:", err);
      return null;
    }
  })();

  return cosmosContainerPromise;
}

async function getListFromFile(userId: string): Promise<PortfolioHoldingRecord[]> {
  const safeUserId = normalizeUserId(userId);
  if (!safeUserId) return [];
  const store = readStore();
  const list = store[safeUserId];
  return Array.isArray(list) ? [...list] : [];
}

async function getListFromCosmos(userId: string, container: Container): Promise<PortfolioHoldingRecord[]> {
  const query = {
    query: "SELECT c.payload FROM c WHERE c.userId = @userId",
    parameters: [{ name: "@userId", value: userId }],
  };
  const { resources } = await container.items.query<{ payload: PortfolioHoldingRecord }>(query, {
    partitionKey: userId,
  }).fetchAll();
  return resources.map((r) => r.payload);
}

async function writeListToFile(userId: string, list: PortfolioHoldingRecord[]): Promise<void> {
  const store = readStore();
  if (list.length === 0) {
    delete store[userId];
  } else {
    store[userId] = list;
  }
  writeStore(store);
}

async function migrateUserFileDataToCosmos(userId: string, container: Container): Promise<number> {
  const fileList = await getListFromFile(userId);
  let migrated = 0;
  for (const item of fileList) {
    const holding = normalizeHolding(item as Record<string, unknown>);
    const doc: CosmosPortfolioDoc = {
      id: toCosmosDocId(userId, holding.id),
      userId,
      holdingId: holding.id,
      updatedAt: new Date().toISOString(),
      payload: holding,
    };
    await container.items.upsert(doc);
    migrated++;
  }
  return migrated;
}

async function addToFile(userId: string, holding: Record<string, unknown>): Promise<PortfolioHoldingRecord | null> {
  const current = await getListFromFile(userId);
  const normalized = normalizeHolding(holding);
  if (current.some((item) => item.id === normalized.id)) return null;
  current.push(normalized);
  await writeListToFile(userId, current);
  return normalized;
}

async function addToCosmos(userId: string, holding: Record<string, unknown>, container: Container): Promise<PortfolioHoldingRecord | null> {
  const normalized = normalizeHolding(holding);
  const docId = toCosmosDocId(userId, normalized.id);

  try {
    await container.item(docId, userId).read<CosmosPortfolioDoc>();
    return null;
  } catch {
    // expected for non-existing document
  }

  const doc: CosmosPortfolioDoc = {
    id: docId,
    userId,
    holdingId: normalized.id,
    updatedAt: new Date().toISOString(),
    payload: normalized,
  };

  await container.items.upsert(doc);
  return normalized;
}

async function updateInFile(userId: string, id: string, patch: Record<string, unknown>): Promise<PortfolioHoldingRecord | null> {
  const current = await getListFromFile(userId);
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const updated: PortfolioHoldingRecord = { ...current[index], ...patch, id } as PortfolioHoldingRecord;
  current[index] = updated;
  await writeListToFile(userId, current);
  return updated;
}

async function updateInCosmos(userId: string, id: string, patch: Record<string, unknown>, container: Container): Promise<PortfolioHoldingRecord | null> {
  const docId = toCosmosDocId(userId, id);
  try {
    const { resource } = await container.item(docId, userId).read<CosmosPortfolioDoc>();
    if (!resource) return null;
    const updatedPayload = { ...resource.payload, ...patch, id } as PortfolioHoldingRecord;
    const updatedDoc: CosmosPortfolioDoc = { ...resource, updatedAt: new Date().toISOString(), payload: updatedPayload };
    await container.item(docId, userId).replace(updatedDoc);
    return updatedPayload;
  } catch {
    return null;
  }
}

async function removeFromFile(userId: string, id: string): Promise<boolean> {
  const current = await getListFromFile(userId);
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) return false;
  await writeListToFile(userId, next);
  return true;
}

async function removeFromCosmos(userId: string, id: string, container: Container): Promise<boolean> {
  const docId = toCosmosDocId(userId, id);
  try {
    await container.item(docId, userId).delete();
    return true;
  } catch {
    return false;
  }
}

export const portfolioHoldingsRepository = {
  async storageMode(): Promise<"cosmos" | "file"> {
    const container = await getCosmosContainer();
    return container ? "cosmos" : "file";
  },

  async getList(userId: string): Promise<PortfolioHoldingRecord[]> {
    const safeUserId = normalizeUserId(userId);
    if (!safeUserId) return [];

    const container = await getCosmosContainer();
    if (!container) return getListFromFile(safeUserId);

    try {
      return await getListFromCosmos(safeUserId, container);
    } catch (err) {
      console.error("[portfolio] Cosmos getList failed, using file fallback:", err);
      return getListFromFile(safeUserId);
    }
  },

  async add(userId: string, holding: Record<string, unknown>): Promise<PortfolioHoldingRecord | null> {
    const safeUserId = normalizeUserId(userId);
    if (!safeUserId || !holding || typeof holding !== "object") return null;

    const container = await getCosmosContainer();
    if (!container) return addToFile(safeUserId, holding);

    try {
      return await addToCosmos(safeUserId, holding, container);
    } catch (err) {
      console.error("[portfolio] Cosmos add failed, using file fallback:", err);
      return addToFile(safeUserId, holding);
    }
  },

  async update(userId: string, id: string, patch: Record<string, unknown>): Promise<PortfolioHoldingRecord | null> {
    const safeUserId = normalizeUserId(userId);
    const safeId = id.trim();
    if (!safeUserId || !safeId || !patch || typeof patch !== "object") return null;

    const container = await getCosmosContainer();
    if (!container) return updateInFile(safeUserId, safeId, patch);

    try {
      return await updateInCosmos(safeUserId, safeId, patch, container);
    } catch (err) {
      console.error("[portfolio] Cosmos update failed, using file fallback:", err);
      return updateInFile(safeUserId, safeId, patch);
    }
  },

  async remove(userId: string, id: string): Promise<boolean> {
    const safeUserId = normalizeUserId(userId);
    const safeId = id.trim();
    if (!safeUserId || !safeId) return false;

    const container = await getCosmosContainer();
    if (!container) return removeFromFile(safeUserId, safeId);

    try {
      return await removeFromCosmos(safeUserId, safeId, container);
    } catch (err) {
      console.error("[portfolio] Cosmos remove failed, using file fallback:", err);
      return removeFromFile(safeUserId, safeId);
    }
  },

  async migrateUserFromFile(userId: string): Promise<{ mode: "cosmos" | "file"; migrated: number }> {
    const safeUserId = normalizeUserId(userId);
    if (!safeUserId) return { mode: "file", migrated: 0 };

    const container = await getCosmosContainer();
    if (!container) return { mode: "file", migrated: 0 };

    const migrated = await migrateUserFileDataToCosmos(safeUserId, container);
    return { mode: "cosmos", migrated };
  },
};
