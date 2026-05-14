// AlertPreferencesRepository — Cosmos store of per-user notification preferences.
// Container: alert_preferences, partition /userId.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

export interface UserAlertPreference {
  userId: string;
  dailyIQAlerts: boolean;
  priceAlerts?: boolean;
  updatedAt: string;
}

interface AlertPreferenceDocument extends UserAlertPreference {
  id: string;          // == userId
  docType: "alert_preference";
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
      const containerName = process.env.COSMOS_ALERT_PREFS_CONTAINER ?? "alert_preferences";

      if (!endpoint && !connStr) {
        console.warn("[alertPreferences.repository] COSMOS not configured — repository disabled");
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
      console.log(`[alertPreferences.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[alertPreferences.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

export async function getUserAlertPreference(userId: string): Promise<UserAlertPreference | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(userId, userId).read<AlertPreferenceDocument>();
    if (!resource) return null;
    return {
      userId: resource.userId,
      dailyIQAlerts: !!resource.dailyIQAlerts,
      priceAlerts: !!resource.priceAlerts,
      updatedAt: resource.updatedAt,
    };
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error("[alertPreferences.repository] getUserAlertPreference failed:", err?.message ?? err);
    return null;
  }
}

export async function setDailyIQAlert(userId: string, enabled: boolean): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const now = new Date().toISOString();
  let existing: AlertPreferenceDocument | null = null;
  try {
    const { resource } = await container.item(userId, userId).read<AlertPreferenceDocument>();
    existing = resource ?? null;
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
  const doc: AlertPreferenceDocument = {
    id: userId,
    userId,
    dailyIQAlerts: enabled,
    priceAlerts: existing?.priceAlerts ?? false,
    updatedAt: now,
    docType: "alert_preference",
  };
  await container.items.upsert(doc, { disableAutomaticIdGeneration: true });
}

export async function setPriceAlert(userId: string, enabled: boolean): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const now = new Date().toISOString();
  let existing: AlertPreferenceDocument | null = null;
  try {
    const { resource } = await container.item(userId, userId).read<AlertPreferenceDocument>();
    existing = resource ?? null;
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
  const doc: AlertPreferenceDocument = {
    id: userId,
    userId,
    dailyIQAlerts: existing?.dailyIQAlerts ?? false,
    priceAlerts: enabled,
    updatedAt: now,
    docType: "alert_preference",
  };
  await container.items.upsert(doc, { disableAutomaticIdGeneration: true });
}

export async function getAllDailyIQAlertPreferences(): Promise<UserAlertPreference[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<AlertPreferenceDocument>({
        query: 'SELECT c["userId"], c["dailyIQAlerts"], c["priceAlerts"], c["updatedAt"] FROM c WHERE c["docType"] = "alert_preference" AND c["dailyIQAlerts"] = true',
      })
      .fetchAll();
    return (resources ?? []).map((r) => ({
      userId: r.userId,
      dailyIQAlerts: !!r.dailyIQAlerts,
      priceAlerts: !!r.priceAlerts,
      updatedAt: r.updatedAt,
    }));
  } catch (err: any) {
    console.error("[alertPreferences.repository] getAllDailyIQAlertPreferences failed:", err?.message ?? err);
    return [];
  }
}
