// DailyIQRepository — Cosmos-backed store for the daily top-performers brief.
//
// Container: dailyiq_briefs, partition key /date.
// Document id == date (YYYY-MM-DD), so a single Cosmos point-read returns
// today's brief in <10ms.
//
// Falls back to no-op (returns null) when COSMOS is not configured so local
// dev / test still works.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface RankedPlayerLike {
  playerId: string;
  playerName: string;
  rank?: number;
  rankingScore?: number;
  league?: "MLB" | "MiLB";
  team?: string;
  teamName?: string;
  teamAbbreviation?: string;
  position?: string;
  [k: string]: unknown;
}

export interface DailyIQBriefDocument {
  id: string;             // == date
  date: string;           // YYYY-MM-DD
  generatedAt: string;    // ISO
  mlb: RankedPlayerLike[];
  milb: RankedPlayerLike[];
  notifiedAt?: string | null;
  updatedAt: string;
  docType: "dailyiq_brief";
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
      const containerName = process.env.COSMOS_DAILYIQ_CONTAINER ?? "dailyiq_briefs";

      if (!endpoint && !connStr) {
        console.warn("[dailyiq.repository] COSMOS not configured — repository disabled");
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
        partitionKey: { paths: ["/date"] },
      });
      _container = container;
      console.log(`[dailyiq.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[dailyiq.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

export async function saveTopPlayers(
  date: string,
  players: { mlb: RankedPlayerLike[]; milb: RankedPlayerLike[] },
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const now = new Date().toISOString();
  const doc: DailyIQBriefDocument = {
    id: date,
    date,
    generatedAt: now,
    mlb: players.mlb ?? [],
    milb: players.milb ?? [],
    notifiedAt: null,
    updatedAt: now,
    docType: "dailyiq_brief",
  };
  await container.items.upsert(doc, { disableAutomaticIdGeneration: true });
}

export async function markNotified(date: string): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  try {
    const { resource } = await container.item(date, date).read<DailyIQBriefDocument>();
    if (!resource) return;
    resource.notifiedAt = new Date().toISOString();
    resource.updatedAt = resource.notifiedAt;
    await container.item(date, date).replace(resource);
  } catch (err: any) {
    if (err?.code === 404) return;
    throw err;
  }
}

export async function getTopPlayers(
  date: string,
): Promise<{ mlb: RankedPlayerLike[]; milb: RankedPlayerLike[]; generatedAt: string; notifiedAt?: string | null } | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(date, date).read<DailyIQBriefDocument>();
    if (!resource) return null;
    return {
      mlb: resource.mlb ?? [],
      milb: resource.milb ?? [],
      generatedAt: resource.generatedAt,
      notifiedAt: resource.notifiedAt ?? null,
    };
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error("[dailyiq.repository] getTopPlayers failed:", err?.message ?? err);
    return null;
  }
}

export async function getLatestBrief(): Promise<
  | { date: string; generatedAt: string; mlb: RankedPlayerLike[]; milb: RankedPlayerLike[]; notifiedAt?: string | null }
  | null
> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resources } = await container.items
      .query<DailyIQBriefDocument>({
        query: 'SELECT TOP 1 c["date"], c["generatedAt"], c["mlb"], c["milb"], c["notifiedAt"] FROM c WHERE c["docType"] = "dailyiq_brief" ORDER BY c["date"] DESC',
      })
      .fetchAll();
    const row = resources?.[0];
    if (!row) return null;
    return {
      date: row.date,
      generatedAt: row.generatedAt,
      mlb: row.mlb ?? [],
      milb: row.milb ?? [],
      notifiedAt: row.notifiedAt ?? null,
    };
  } catch (err: any) {
    console.error("[dailyiq.repository] getLatestBrief failed:", err?.message ?? err);
    return null;
  }
}
