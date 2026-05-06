import { Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getUserBySession } from "../authService.js";
import { PortfolioHolding } from "../../types/portfolioiq.types.js";

type UserHoldingsMap = Record<string, PortfolioHolding[]>;
type UserLedgerMap = Record<string, PortfolioLedgerEntry[]>;

interface PortfolioLedgerEntry {
  id: string;
  userId: string;
  holdingId: string;
  playerName: string;
  cardTitle: string;
  quantitySold: number;
  unitSalePrice: number;
  grossProceeds: number;
  fees: number;
  tax: number;
  shipping: number;
  netProceeds: number;
  costBasisSold: number;
  realizedProfitLoss: number;
  realizedProfitLossPct: number;
  soldAt: string;
  notes?: string;
}

const STORE_PATH = process.env.PORTFOLIO_STORE_PATH
  ? path.resolve(process.env.PORTFOLIO_STORE_PATH)
  : path.resolve(process.cwd(), ".data", "portfolio-holdings.json");
const LEDGER_STORE_PATH = process.env.PORTFOLIO_LEDGER_STORE_PATH
  ? path.resolve(process.env.PORTFOLIO_LEDGER_STORE_PATH)
  : path.resolve(process.cwd(), ".data", "portfolio-ledger.json");

let storeCache: UserHoldingsMap | null = null;
let ledgerCache: UserLedgerMap | null = null;
let loadPromise: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function normalizeId(value: unknown): string {
  const id = String(value ?? "").trim();
  return id.length > 0 ? id : randomUUID();
}

async function ensureStoreLoaded(): Promise<void> {
  if (storeCache && ledgerCache) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.mkdir(path.dirname(LEDGER_STORE_PATH), { recursive: true });
    try {
      const raw = await fs.readFile(STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        storeCache = parsed as UserHoldingsMap;
      } else {
        storeCache = {};
      }
    } catch {
      storeCache = {};
      await fs.writeFile(STORE_PATH, JSON.stringify(storeCache, null, 2), "utf8");
    }

    try {
      const raw = await fs.readFile(LEDGER_STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ledgerCache = parsed as UserLedgerMap;
      } else {
        ledgerCache = {};
      }
    } catch {
      ledgerCache = {};
      await fs.writeFile(LEDGER_STORE_PATH, JSON.stringify(ledgerCache, null, 2), "utf8");
    }
  })();
  await loadPromise;
  loadPromise = null;
}

function getUserHoldings(userId: string): PortfolioHolding[] {
  if (!storeCache) storeCache = {};
  if (!storeCache[userId]) storeCache[userId] = [];
  return storeCache[userId];
}

function getUserLedger(userId: string): PortfolioLedgerEntry[] {
  if (!ledgerCache) ledgerCache = {};
  if (!ledgerCache[userId]) ledgerCache[userId] = [];
  return ledgerCache[userId];
}

async function persistStore(): Promise<void> {
  await ensureStoreLoaded();
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(STORE_PATH, JSON.stringify(storeCache ?? {}, null, 2), "utf8");
    await fs.writeFile(LEDGER_STORE_PATH, JSON.stringify(ledgerCache ?? {}, null, 2), "utf8");
  }).catch(() => {
    // Keep queue alive for subsequent writes.
  });
  await writeQueue;
}

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function requireUser(req: Request, res: Response): Promise<{ userId: string } | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return { userId: user.userId };
}

export async function getHoldings(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;
  const holdings = getUserHoldings(auth.userId);
  res.json({ userId: auth.userId, count: holdings.length, holdings });
}

export async function getLedger(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;
  const entries = getUserLedger(auth.userId).slice().sort((a, b) => b.soldAt.localeCompare(a.soldAt));
  const totals = entries.reduce((acc, entry) => {
    acc.realizedProfitLoss += entry.realizedProfitLoss;
    acc.grossProceeds += entry.grossProceeds;
    acc.netProceeds += entry.netProceeds;
    acc.costBasisSold += entry.costBasisSold;
    return acc;
  }, {
    realizedProfitLoss: 0,
    grossProceeds: 0,
    netProceeds: 0,
    costBasisSold: 0,
  });
  res.json({ userId: auth.userId, count: entries.length, totals, entries });
}

export async function addHolding(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;

  const incoming = (req.body ?? {}) as Record<string, unknown>;
  const { id, ...rest } = incoming;
  const holding: PortfolioHolding = {
    ...(rest as Omit<PortfolioHolding, 'id'>),
    id: normalizeId(id),
  };

  const holdings = getUserHoldings(auth.userId);
  const existingIdx = holdings.findIndex((h) => String(h.id) === String(holding.id));
  if (existingIdx >= 0) {
    holdings[existingIdx] = { ...holdings[existingIdx], ...holding };
  } else {
    holdings.push(holding);
  }

  await persistStore();
  res.status(201).json({ message: "Holding saved", id: holding.id });
}

export async function getHoldingById(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const holdings = getUserHoldings(auth.userId);
  const holding = holdings.find((h) => String(h.id) === id);
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  res.json(holding);
}

export async function updateHolding(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const holdings = getUserHoldings(auth.userId);
  const idx = holdings.findIndex((h) => String(h.id) === id);
  if (idx === -1) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  holdings[idx] = {
    ...holdings[idx],
    ...(req.body as PortfolioHolding),
    id,
  };

  await persistStore();
  res.json({ message: "Holding updated", id });
}

export async function deleteHolding(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const holdings = getUserHoldings(auth.userId);
  const before = holdings.length;
  const filtered = holdings.filter((h) => String(h.id) !== id);
  if (filtered.length === before) {
    return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  }

  storeCache![auth.userId] = filtered;
  await persistStore();
  res.json({ message: "Holding removed", id });
}

export async function sellHolding(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const holdings = getUserHoldings(auth.userId);
  const idx = holdings.findIndex((h) => String(h.id) === id);
  if (idx === -1) {
    return res.status(404).json({ error: { message: "Holding not found", code: "NOT_FOUND" } });
  }

  const holding = holdings[idx];
  const quantityOwned = Math.max(1, toNumber(holding.quantity, 1));
  const quantitySold = Math.floor(toNumber(req.body?.quantity, 0));
  if (quantitySold <= 0 || quantitySold > quantityOwned) {
    return res.status(400).json({ error: { message: "Invalid sell quantity", code: "INVALID_QUANTITY" } });
  }

  const unitSalePrice = toNumber(req.body?.salePrice, toNumber(holding.currentValue, 0));
  if (unitSalePrice <= 0) {
    return res.status(400).json({ error: { message: "Invalid sale price", code: "INVALID_SALE_PRICE" } });
  }

  const fees = toNumber(req.body?.fees, 0);
  const tax = toNumber(req.body?.tax, 0);
  const shipping = toNumber(req.body?.shipping, 0);
  const soldAtRaw = String(req.body?.soldAt ?? "").trim();
  const soldAt = soldAtRaw ? new Date(soldAtRaw).toISOString() : new Date().toISOString();
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;

  const currentCostBasis = toNumber(holding.totalCostBasis, toNumber(holding.purchasePrice, 0) * quantityOwned);
  const avgUnitCost = quantityOwned > 0 ? currentCostBasis / quantityOwned : 0;
  const costBasisSold = avgUnitCost * quantitySold;
  const grossProceeds = unitSalePrice * quantitySold;
  const netProceeds = grossProceeds - fees - tax - shipping;
  const realizedProfitLoss = netProceeds - costBasisSold;
  const realizedProfitLossPct = costBasisSold > 0 ? (realizedProfitLoss / costBasisSold) * 100 : 0;

  const ledgerEntry: PortfolioLedgerEntry = {
    id: randomUUID(),
    userId: auth.userId,
    holdingId: id,
    playerName: String(holding.playerName ?? ""),
    cardTitle: String(holding.cardTitle ?? ""),
    quantitySold,
    unitSalePrice,
    grossProceeds,
    fees,
    tax,
    shipping,
    netProceeds,
    costBasisSold,
    realizedProfitLoss,
    realizedProfitLossPct,
    soldAt,
    notes: notes && notes.length ? notes : undefined,
  };

  const remainingQty = quantityOwned - quantitySold;
  if (remainingQty <= 0) {
    holdings.splice(idx, 1);
  } else {
    const updatedCostBasis = avgUnitCost * remainingQty;
    const currentValuePerUnit = quantityOwned > 0 ? toNumber(holding.currentValue, 0) / quantityOwned : 0;
    const nextCurrentValue = currentValuePerUnit * remainingQty;
    holdings[idx] = {
      ...holding,
      quantity: remainingQty,
      purchasePrice: avgUnitCost,
      totalCostBasis: updatedCostBasis,
      currentValue: nextCurrentValue,
      totalProfitLoss: nextCurrentValue - updatedCostBasis,
      totalProfitLossPct: updatedCostBasis > 0 ? ((nextCurrentValue - updatedCostBasis) / updatedCostBasis) * 100 : 0,
      lastUpdated: new Date().toISOString(),
      freshnessStatus: "Updated Today",
    };
  }

  getUserLedger(auth.userId).push(ledgerEntry);
  await persistStore();

  return res.json({
    message: "Holding sale recorded",
    sold: ledgerEntry,
    holdingRemoved: remainingQty <= 0,
    remainingQuantity: Math.max(0, remainingQty),
  });
}

export async function refreshHolding(req: Request, res: Response) {
  await ensureStoreLoaded();
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  const holdings = getUserHoldings(auth.userId);
  const holding = holdings.find((h) => String(h.id) === id);
  if (!holding) return res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });

  holding.freshnessStatus = "Needs refresh";
  holding.lastUpdated = new Date().toISOString();
  await persistStore();
  res.json({ message: "Holding refreshed", id });
}
