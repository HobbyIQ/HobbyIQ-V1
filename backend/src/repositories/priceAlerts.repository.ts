// PriceAlertsRepository — Cosmos store of per-card price alerts.
// Container: compiq_alerts, partition /userId.
//
// Wire format matches the iOS `PriceAlert.swift` model exactly. Records are
// read here for CRUD and consumed by the in-process priceAlertEvaluator
// job (backend/src/jobs/priceAlertEvaluator.job.ts) which re-prices each
// active alert via computeEstimate and fires APNs on threshold cross.
//
// CF-FN-PRICE-ALERT-CHECKER-DELETE (2026-06-10): the prior path through
// the Azure Function fn-price-alert-checker was vestigial — it GETed a
// nonexistent /api/alerts/internal/all backend route, silently returned
// zero alerts on the 404, and ran every 6h emitting "Succeeded in 38ms"
// without doing anything. The function and its references are gone; the
// in-process evaluator has been the real path the whole time.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "crypto";

export type PriceAlertDirection = "above" | "below";

export interface PriceAlertCardSnapshot {
  playerName: string;
  year?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  grade?: string | null;
  variant?: string | null;
  printRun?: number | null;
  isRookie?: boolean | null;
}

export interface PriceAlert {
  alertId: string;
  userId: string;
  cardId: string;
  playerName: string;
  targetPrice: number;
  direction: PriceAlertDirection;
  currentPrice: number | null;
  createdAt: string;
  triggeredAt: string | null;
  isActive: boolean;
  cardSnapshot: PriceAlertCardSnapshot | null;
}

interface PriceAlertDocument extends PriceAlert {
  id: string;          // == alertId
  docType: "price_alert";
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
      const containerName = process.env.COSMOS_PRICE_ALERTS_CONTAINER ?? "compiq_alerts";

      if (!endpoint && !connStr) {
        console.warn("[priceAlerts.repository] COSMOS not configured — repository disabled");
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
      console.log(`[priceAlerts.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[priceAlerts.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

function toAlert(doc: PriceAlertDocument): PriceAlert {
  return {
    alertId: doc.alertId,
    userId: doc.userId,
    cardId: doc.cardId,
    playerName: doc.playerName,
    targetPrice: doc.targetPrice,
    direction: doc.direction,
    currentPrice: doc.currentPrice ?? null,
    createdAt: doc.createdAt,
    triggeredAt: doc.triggeredAt ?? null,
    isActive: doc.isActive !== false,
    cardSnapshot: doc.cardSnapshot ?? null,
  };
}

export async function listAlertsForUser(userId: string): Promise<PriceAlert[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<PriceAlertDocument>({
        query: "SELECT * FROM c WHERE c.userId = @uid ORDER BY c.createdAt DESC",
        parameters: [{ name: "@uid", value: userId }],
      }, { partitionKey: userId })
      .fetchAll();
    return resources.map(toAlert);
  } catch (err: any) {
    console.error("[priceAlerts.repository] listAlertsForUser failed:", err?.message ?? err);
    return [];
  }
}

export interface CreatePriceAlertInput {
  userId: string;
  cardId: string;
  playerName: string;
  targetPrice: number;
  direction: PriceAlertDirection;
  currentPrice?: number | null;
  cardSnapshot?: PriceAlertCardSnapshot | null;
}

export async function createAlert(input: CreatePriceAlertInput): Promise<PriceAlert | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = new Date().toISOString();
  const alertId = randomUUID();
  const doc: PriceAlertDocument = {
    id: alertId,
    docType: "price_alert",
    alertId,
    userId: input.userId,
    cardId: input.cardId,
    playerName: input.playerName,
    targetPrice: input.targetPrice,
    direction: input.direction,
    currentPrice: input.currentPrice ?? null,
    createdAt: now,
    triggeredAt: null,
    isActive: true,
    cardSnapshot: input.cardSnapshot ?? null,
  };
  try {
    const { resource } = await container.items.create<PriceAlertDocument>(doc);
    return resource ? toAlert(resource) : toAlert(doc);
  } catch (err: any) {
    console.error("[priceAlerts.repository] createAlert failed:", err?.message ?? err);
    return null;
  }
}

export async function deleteAlert(userId: string, alertId: string): Promise<boolean> {
  const container = await getContainer();
  if (!container) return false;
  try {
    await container.item(alertId, userId).delete();
    return true;
  } catch (err: any) {
    if (err?.code === 404) return false;
    console.error("[priceAlerts.repository] deleteAlert failed:", err?.message ?? err);
    return false;
  }
}

/**
 * CF-ACCOUNT-DELETION (2026-06-04): purge all alerts for a single user.
 * Single-partition list+delete loop. Returns the deleted count for the
 * /api/account purge summary.
 */
export async function deleteAllAlertsForUser(userId: string): Promise<number> {
  const container = await getContainer();
  if (!container) return 0;
  let deleted = 0;
  try {
    const alerts = await listAlertsForUser(userId);
    for (const a of alerts) {
      try {
        await container.item(a.alertId, userId).delete();
        deleted += 1;
      } catch (err: any) {
        if (err?.code === 404) continue;
        console.error("[priceAlerts.repository] deleteAllAlertsForUser item failed:", err?.message ?? err);
      }
    }
  } catch (err: any) {
    console.error("[priceAlerts.repository] deleteAllAlertsForUser failed:", err?.message ?? err);
  }
  return deleted;
}

/**
 * Cross-partition scan for every active, not-yet-triggered alert across all
 * users. Used by the priceAlertEvaluator scheduled job.
 */
export async function listAllActiveAlerts(): Promise<PriceAlert[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<PriceAlertDocument>({
        query:
          "SELECT * FROM c WHERE c.docType = 'price_alert' AND c.isActive = true AND (NOT IS_DEFINED(c.triggeredAt) OR c.triggeredAt = null)",
      })
      .fetchAll();
    return resources.map(toAlert);
  } catch (err: any) {
    console.error("[priceAlerts.repository] listAllActiveAlerts failed:", err?.message ?? err);
    return [];
  }
}

export interface AlertEvaluationPatch {
  currentPrice: number | null;
  triggered: boolean;
  triggeredAt?: string | null;
}

/**
 * Update an alert after the evaluator re-priced it. Persists the latest
 * observed `currentPrice` and, on threshold cross, sets `triggeredAt` and
 * flips `isActive` to false so the same alert doesn't fire repeatedly.
 */
export async function recordAlertEvaluation(
  userId: string,
  alertId: string,
  patch: AlertEvaluationPatch,
): Promise<PriceAlert | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource: existing } = await container
      .item(alertId, userId)
      .read<PriceAlertDocument>();
    if (!existing) return null;
    const next: PriceAlertDocument = {
      ...existing,
      currentPrice: patch.currentPrice,
      triggeredAt: patch.triggered
        ? patch.triggeredAt ?? new Date().toISOString()
        : existing.triggeredAt ?? null,
      isActive: patch.triggered ? false : existing.isActive,
    };
    const { resource } = await container
      .item(alertId, userId)
      .replace<PriceAlertDocument>(next);
    return resource ? toAlert(resource) : toAlert(next);
  } catch (err: any) {
    console.error("[priceAlerts.repository] recordAlertEvaluation failed:", err?.message ?? err);
    return null;
  }
}
