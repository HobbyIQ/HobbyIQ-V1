/**
 * services/alertService.js
 *
 * Cosmos DB-backed price alert store.
 *
 * Document shape (compiq_alerts container, partition key /userId):
 *   {
 *     id, alertId, userId, cardId, playerName,
 *     targetPrice, direction ("above"|"below"),
 *     currentPrice, createdAt, triggeredAt, isActive,
 *   }
 *
 * Device tokens are stored in a sibling document scoped by userId:
 *   { id: `device::${userId}`, userId, tokens: [{ token, bundleId, platform, registeredAt }] }
 *
 * Falls back to an in-process map when Cosmos is not configured (local dev).
 */

const crypto = require('crypto');

const DB_NAME = process.env.COSMOS_DATABASE || 'hobbyiq';
const CONTAINER_NAME = process.env.COSMOS_ALERTS_CONTAINER || 'compiq_alerts';

let _container = null;
let _initOnce = null;

async function getContainer() {
  if (_container) return _container;
  if (_initOnce) return _initOnce;

  _initOnce = (async () => {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    const connStr = process.env.COSMOS_CONNECTION_STRING;
    if (!endpoint && !connStr) return null;

    try {
      const { CosmosClient } = require('@azure/cosmos');
      const client = connStr
        ? new CosmosClient(connStr)
        : new CosmosClient({ endpoint, key });

      const db = (await client.databases.createIfNotExists({ id: DB_NAME })).database;
      const { container } = await db.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ['/userId'] },
      });
      _container = container;
      console.log('[alerts] Cosmos container ready');
      return _container;
    } catch (err) {
      console.warn('[alerts] Cosmos init failed, using memory store:', err.message);
      return null;
    }
  })();

  return _initOnce;
}

// In-memory fallback ─────────────────────────────────────────────────────────
const memAlerts = new Map();   // alertId -> doc
const memTokens = new Map();   // userId  -> { tokens: [...] }

// Helpers ────────────────────────────────────────────────────────────────────
function newAlertId() {
  return 'al_' + crypto.randomBytes(10).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

// Public API ─────────────────────────────────────────────────────────────────

async function listAlerts(userId) {
  const container = await getContainer();
  if (!container) {
    return Array.from(memAlerts.values()).filter((a) => a.userId === userId);
  }
  const query = {
    query: 'SELECT * FROM c WHERE c.userId = @uid AND c.docType = @t ORDER BY c.createdAt DESC',
    parameters: [{ name: '@uid', value: userId }, { name: '@t', value: 'alert' }],
  };
  const { resources } = await container.items.query(query, { partitionKey: userId }).fetchAll();
  return resources;
}

async function createAlert(userId, payload) {
  const alertId = newAlertId();
  const snap = payload.cardSnapshot && typeof payload.cardSnapshot === 'object'
    ? payload.cardSnapshot
    : null;
  const doc = {
    id: alertId,
    alertId,
    userId,
    docType: 'alert',
    cardId: String(payload.cardId || ''),
    playerName: String(payload.playerName || ''),
    targetPrice: Number(payload.targetPrice),
    direction: payload.direction === 'below' ? 'below' : 'above',
    currentPrice: payload.currentPrice == null ? null : Number(payload.currentPrice),
    createdAt: nowIso(),
    triggeredAt: null,
    isActive: true,
    cardSnapshot: snap ? {
      playerName: String(snap.playerName || payload.playerName || ''),
      year: snap.year == null ? null : Number(snap.year),
      setName: snap.setName ? String(snap.setName) : null,
      cardNumber: snap.cardNumber ? String(snap.cardNumber) : null,
      grade: snap.grade ? String(snap.grade) : null,
      variant: snap.variant ? String(snap.variant) : null,
      printRun: snap.printRun == null ? null : Number(snap.printRun),
      isRookie: typeof snap.isRookie === 'boolean' ? snap.isRookie : null,
    } : null,
  };
  const container = await getContainer();
  if (!container) {
    memAlerts.set(alertId, doc);
    return doc;
  }
  const { resource } = await container.items.create(doc);
  return resource || doc;
}

async function deleteAlert(userId, alertId) {
  const container = await getContainer();
  if (!container) {
    const existing = memAlerts.get(alertId);
    if (!existing || existing.userId !== userId) return false;
    memAlerts.delete(alertId);
    return true;
  }
  try {
    await container.item(alertId, userId).delete();
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    throw err;
  }
}

async function markTriggered(userId, alertId) {
  const container = await getContainer();
  if (!container) {
    const existing = memAlerts.get(alertId);
    if (!existing) return null;
    existing.triggeredAt = nowIso();
    existing.isActive = false;
    return existing;
  }
  try {
    const { resource } = await container.item(alertId, userId).read();
    if (!resource) return null;
    resource.triggeredAt = nowIso();
    resource.isActive = false;
    const { resource: updated } = await container.item(alertId, userId).replace(resource);
    return updated;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function listAllActive() {
  const container = await getContainer();
  if (!container) {
    return Array.from(memAlerts.values()).filter((a) => a.isActive);
  }
  const query = {
    query: 'SELECT * FROM c WHERE c.docType = @t AND c.isActive = true',
    parameters: [{ name: '@t', value: 'alert' }],
  };
  const { resources } = await container.items.query(query, { enableCrossPartitionQuery: true }).fetchAll();
  return resources;
}

// Device token management ────────────────────────────────────────────────────

async function registerDeviceToken(userId, { deviceToken, bundleId, platform }) {
  if (!userId || !deviceToken) return null;
  const docId = `device::${userId}`;
  const container = await getContainer();
  const entry = {
    token: String(deviceToken),
    bundleId: String(bundleId || ''),
    platform: String(platform || 'ios'),
    registeredAt: nowIso(),
  };

  if (!container) {
    const cur = memTokens.get(userId) || { id: docId, userId, docType: 'device', tokens: [] };
    cur.tokens = (cur.tokens || []).filter((t) => t.token !== entry.token);
    cur.tokens.push(entry);
    memTokens.set(userId, cur);
    return cur;
  }

  let doc;
  try {
    const { resource } = await container.item(docId, userId).read();
    doc = resource || null;
  } catch (err) {
    if (err.code !== 404) throw err;
    doc = null;
  }
  if (!doc) {
    doc = { id: docId, userId, docType: 'device', tokens: [] };
  }
  doc.tokens = (doc.tokens || []).filter((t) => t.token !== entry.token);
  doc.tokens.push(entry);
  const { resource: upserted } = await container.items.upsert(doc);
  return upserted || doc;
}

async function getDeviceTokens(userId) {
  if (!userId) return [];
  const docId = `device::${userId}`;
  const container = await getContainer();
  if (!container) {
    const cur = memTokens.get(userId);
    return cur ? cur.tokens || [] : [];
  }
  try {
    const { resource } = await container.item(docId, userId).read();
    return resource?.tokens || [];
  } catch (err) {
    if (err.code === 404) return [];
    throw err;
  }
}

async function removeDeviceToken(userId, deviceToken) {
  if (!userId || !deviceToken) return;
  const docId = `device::${userId}`;
  const container = await getContainer();
  if (!container) {
    const cur = memTokens.get(userId);
    if (!cur) return;
    cur.tokens = (cur.tokens || []).filter((t) => t.token !== deviceToken);
    memTokens.set(userId, cur);
    return;
  }
  try {
    const { resource } = await container.item(docId, userId).read();
    if (!resource) return;
    resource.tokens = (resource.tokens || []).filter((t) => t.token !== deviceToken);
    await container.items.upsert(resource);
  } catch (err) {
    if (err.code === 404) return;
    throw err;
  }
}

module.exports = {
  listAlerts,
  createAlert,
  deleteAlert,
  markTriggered,
  listAllActive,
  registerDeviceToken,
  getDeviceTokens,
  removeDeviceToken,
};
