/**
 * services/watchlistService.js
 *
 * Cosmos DB-backed per-user player watchlist.
 *
 * Document shape (container `watchlist`, partition key /userId):
 *   {
 *     id,                  // same as watchlistItemId
 *     watchlistItemId,
 *     userId,
 *     playerId,
 *     playerName,
 *     sport,               // "MLB" by default
 *     alertEnabled,        // boolean — toggles signal-based alerts
 *     createdAt,
 *   }
 *
 * Uniqueness is per (userId, playerId): adding an existing player updates
 * the existing row in place rather than creating a duplicate.
 *
 * Falls back to an in-process Map when Cosmos is not configured (dev).
 */

const crypto = require('crypto');

const DB_NAME = process.env.COSMOS_DATABASE || 'hobbyiq';
const CONTAINER_NAME = process.env.COSMOS_WATCHLIST_CONTAINER || 'watchlist';

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
      console.log('[watchlist] Cosmos container ready');
      return _container;
    } catch (err) {
      console.warn('[watchlist] Cosmos init failed, using memory store:', err.message);
      return null;
    }
  })();

  return _initOnce;
}

// In-memory fallback
const memItems = new Map(); // watchlistItemId -> doc

function newItemId() {
  return 'wl_' + crypto.randomBytes(10).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function buildDoc(userId, payload, existing) {
  const id = existing?.watchlistItemId || newItemId();
  return {
    id,
    watchlistItemId: id,
    userId,
    docType: 'watchlist',
    playerId: String(payload.playerId || ''),
    playerName: String(payload.playerName || ''),
    sport: String(payload.sport || existing?.sport || 'MLB'),
    alertEnabled: typeof payload.alertEnabled === 'boolean'
      ? payload.alertEnabled
      : (typeof existing?.alertEnabled === 'boolean' ? existing.alertEnabled : true),
    createdAt: existing?.createdAt || nowIso(),
  };
}

async function listItems(userId) {
  const container = await getContainer();
  if (!container) {
    return Array.from(memItems.values()).filter((i) => i.userId === userId);
  }
  const query = {
    query: 'SELECT * FROM c WHERE c.userId = @u AND c.docType = "watchlist"',
    parameters: [{ name: '@u', value: userId }],
  };
  const { resources } = await container.items
    .query(query, { partitionKey: userId })
    .fetchAll();
  return resources;
}

async function findByPlayer(userId, playerId) {
  const container = await getContainer();
  if (!container) {
    for (const item of memItems.values()) {
      if (item.userId === userId && item.playerId === playerId) return item;
    }
    return null;
  }
  const query = {
    query: 'SELECT * FROM c WHERE c.userId = @u AND c.playerId = @p AND c.docType = "watchlist"',
    parameters: [
      { name: '@u', value: userId },
      { name: '@p', value: playerId },
    ],
  };
  const { resources } = await container.items
    .query(query, { partitionKey: userId })
    .fetchAll();
  return resources[0] || null;
}

async function addItem(userId, payload) {
  if (!payload || !payload.playerId) {
    throw new Error('playerId required');
  }
  const existing = await findByPlayer(userId, String(payload.playerId));
  const doc = buildDoc(userId, payload, existing);

  const container = await getContainer();
  if (!container) {
    memItems.set(doc.watchlistItemId, doc);
    return doc;
  }
  const { resource } = await container.items.upsert(doc);
  return resource || doc;
}

async function removeItem(userId, itemId) {
  const container = await getContainer();
  if (!container) {
    const doc = memItems.get(itemId);
    if (!doc || doc.userId !== userId) return false;
    memItems.delete(itemId);
    return true;
  }
  try {
    await container.item(itemId, userId).delete();
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    throw err;
  }
}

async function setAlertEnabled(userId, itemId, enabled) {
  const container = await getContainer();
  if (!container) {
    const doc = memItems.get(itemId);
    if (!doc || doc.userId !== userId) return null;
    doc.alertEnabled = !!enabled;
    return doc;
  }
  try {
    const { resource } = await container.item(itemId, userId).read();
    if (!resource) return null;
    resource.alertEnabled = !!enabled;
    const { resource: updated } = await container
      .item(itemId, userId)
      .replace(resource);
    return updated || resource;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

module.exports = {
  listItems,
  addItem,
  removeItem,
  setAlertEnabled,
};
