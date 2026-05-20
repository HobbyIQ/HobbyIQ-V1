/**
 * portfolioService.js
 * Cosmos DB-backed portfolio store.
 * One document per user: { id: userId, userId, holdings: {}, ledger: [] }
 *
 * Falls back to in-memory if Cosmos is not configured (local dev).
 */

const crypto = require('crypto');

// ─── Cosmos client (lazy init) ────────────────────────────────────────────────

let _container = null;
let _cosmosReady = false;

async function getContainer() {
  if (_container) return _container;

  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  const dbName = process.env.COSMOS_DATABASE || 'hobbyiq';

  if (!endpoint && !connStr) {
    _cosmosReady = false;
    return null;
  }

  try {
    const { CosmosClient } = require('@azure/cosmos');
    let client;
    if (connStr) {
      client = new CosmosClient(connStr);
    } else {
      // Prefer managed identity in production; key as fallback
      if (key) {
        client = new CosmosClient({ endpoint, key });
      } else {
        const { DefaultAzureCredential } = require('@azure/identity');
        client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
      }
    }
    const { container } = await client
      .database(dbName)
      .container('portfolio')
      .read();
    _container = container;
    _cosmosReady = true;
    console.log('[portfolio] Cosmos DB connected');
  } catch (err) {
    console.warn('[portfolio] Cosmos init failed, falling back to memory:', err.message);
    _cosmosReady = false;
  }
  return _container;
}

// ─── In-memory fallback (local dev / Cosmos unavailable) ─────────────────────

const memStore = {}; // { [userId]: { holdings: {}, ledger: [] } }

function memUser(userId) {
  if (!memStore[userId]) memStore[userId] = { holdings: {}, ledger: [] };
  return memStore[userId];
}

// ─── Process-local read cache (avoids Cosmos round-trip on every request) ────

const readCache = {}; // { [userId]: { data, expiresAt } }
const CACHE_TTL_MS = 30_000; // 30s

function cacheGet(userId) {
  const entry = readCache[userId];
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

function cacheSet(userId, data) {
  readCache[userId] = { data, expiresAt: Date.now() + CACHE_TTL_MS };
}

function cacheInvalidate(userId) {
  delete readCache[userId];
}

// ─── Cosmos read / write helpers ──────────────────────────────────────────────

async function readUserDoc(userId) {
  const cached = cacheGet(userId);
  if (cached) return cached;

  const container = await getContainer();
  if (!container) {
    const d = memUser(userId);
    cacheSet(userId, d);
    return d;
  }

  try {
    const { resource } = await container.item(userId, userId).read();
    const doc = resource || { holdings: {}, ledger: [] };
    cacheSet(userId, doc);
    return doc;
  } catch (err) {
    if (err.code === 404) {
      const doc = { id: userId, userId, holdings: {}, ledger: [] };
      cacheSet(userId, doc);
      return doc;
    }
    throw err;
  }
}

async function writeUserDoc(userId, doc) {
  cacheSet(userId, doc);

  const container = await getContainer();
  if (!container) {
    // In-memory mode: doc already mutated in place
    return;
  }

  const payload = { ...doc, id: userId, userId };
  await container.items.upsert(payload);
}

// ─── Holdings CRUD ────────────────────────────────────────────────────────────

async function listHoldings(userId) {
  const doc = await readUserDoc(userId);
  return Object.values(doc.holdings || {});
}

async function addHolding(userId, holding) {
  const doc = await readUserDoc(userId);
  const id = holding.id || crypto.randomUUID();
  const stored = { ...holding, id };
  doc.holdings = doc.holdings || {};
  doc.holdings[id] = stored;
  await writeUserDoc(userId, doc);
  cacheInvalidate(userId);
  return stored;
}

async function updateHolding(userId, holdingId, patch) {
  const doc = await readUserDoc(userId);
  if (!doc.holdings || !doc.holdings[holdingId]) return null;
  doc.holdings[holdingId] = { ...doc.holdings[holdingId], ...patch, id: holdingId };
  await writeUserDoc(userId, doc);
  cacheInvalidate(userId);
  return doc.holdings[holdingId];
}

async function removeHolding(userId, holdingId) {
  const doc = await readUserDoc(userId);
  if (!doc.holdings || !doc.holdings[holdingId]) return false;
  delete doc.holdings[holdingId];
  await writeUserDoc(userId, doc);
  cacheInvalidate(userId);
  return true;
}

async function getHolding(userId, holdingId) {
  const doc = await readUserDoc(userId);
  return (doc.holdings || {})[holdingId] || null;
}

// ─── Sell ─────────────────────────────────────────────────────────────────────

async function sellHolding(userId, holdingId, sellRequest) {
  const doc = await readUserDoc(userId);
  const holding = (doc.holdings || {})[holdingId];
  if (!holding) return null;

  const {
    quantity = 1,
    salePrice = 0,
    fees = 0,
    tax = 0,
    shipping = 0,
    soldAt = new Date().toISOString(),
    notes = null,
  } = sellRequest;

  const grossProceeds = salePrice * quantity;
  const totalDeductions = (fees || 0) + (tax || 0) + (shipping || 0);
  const netProceeds = grossProceeds - totalDeductions;
  const unitCostBasis = (holding.costBasis || 0) / Math.max(holding.quantity || 1, 1);
  const costBasisSold = unitCostBasis * quantity;
  const realizedProfitLoss = netProceeds - costBasisSold;
  const realizedProfitLossPct = costBasisSold > 0
    ? (realizedProfitLoss / costBasisSold) * 100
    : 0;

  const entry = {
    id: crypto.randomUUID(),
    userId,
    holdingId,
    playerName: holding.playerName || holding.player || '',
    cardTitle: holding.cardTitle || holding.cardSet || '',
    quantitySold: quantity,
    unitSalePrice: salePrice,
    grossProceeds,
    fees: fees || 0,
    tax: tax || 0,
    shipping: shipping || 0,
    netProceeds,
    costBasisSold,
    realizedProfitLoss,
    realizedProfitLossPct,
    soldAt,
    notes: notes || null,
  };

  doc.ledger = doc.ledger || [];
  doc.ledger.unshift(entry);
  // Cap ledger at 500 entries per user
  if (doc.ledger.length > 500) doc.ledger = doc.ledger.slice(0, 500);

  const remaining = (holding.quantity || 1) - quantity;
  let holdingRemoved = false;
  if (remaining <= 0) {
    delete doc.holdings[holdingId];
    holdingRemoved = true;
  } else {
    doc.holdings[holdingId] = { ...holding, quantity: remaining };
  }

  await writeUserDoc(userId, doc);
  cacheInvalidate(userId);

  return { entry, holdingRemoved, remainingQuantity: Math.max(remaining, 0) };
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

async function getLedger(userId) {
  const doc = await readUserDoc(userId);
  const entries = doc.ledger || [];
  const totals = entries.reduce(
    (acc, e) => {
      acc.realizedProfitLoss += e.realizedProfitLoss;
      acc.grossProceeds += e.grossProceeds;
      acc.netProceeds += e.netProceeds;
      acc.costBasisSold += e.costBasisSold;
      return acc;
    },
    { realizedProfitLoss: 0, grossProceeds: 0, netProceeds: 0, costBasisSold: 0 }
  );
  return { totals, entries };
}

/**
 * Aggregate roll-up consumed by the iOS PortfolioIQ dashboard.
 * Sold/archived holdings are excluded; quantity is respected.
 */
function summarizeHoldings(holdings) {
  let totalValue = 0;
  let totalCost = 0;
  let cardCount = 0;
  for (const h of holdings || []) {
    const status = (h.status || h.cardStatus || 'owned').toLowerCase();
    if (status === 'sold' || status === 'archived') continue;
    const qty = Math.max(1, Number(h.quantity) || 1);
    const value = Number(
      h.currentValue ?? h.predictedPrice ?? h.lastValue ?? 0
    ) || 0;
    const cost = Number(
      h.purchasePrice ?? h.costBasis ?? 0
    ) || 0;
    // costBasis is typically the *total* paid for the row (qty included).
    // currentValue is per-unit, so multiply by qty.
    totalValue += value * qty;
    totalCost  += (h.costBasis != null ? cost : cost * qty);
    cardCount  += qty;
  }
  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPct = totalCost > 0
    ? (totalGainLoss / totalCost) * 100
    : 0;
  return {
    totalValue: round2(totalValue),
    totalCost: round2(totalCost),
    totalGainLoss: round2(totalGainLoss),
    totalGainLossPct: round2(totalGainLossPct),
    cardCount,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  listHoldings,
  addHolding,
  updateHolding,
  removeHolding,
  getHolding,
  sellHolding,
  getLedger,
  summarizeHoldings,
};
