import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export interface WatchlistEntry {
  watchlistItemId: string;
  userId: string;
  playerId: string;
  createdAt: string;
}

type WatchlistStore = Record<string, Record<string, WatchlistEntry>>;

const STORE_PATH = process.env.DAILYIQ_WATCHLIST_STORE_PATH
  ? path.resolve(process.env.DAILYIQ_WATCHLIST_STORE_PATH)
  : path.resolve(process.cwd(), ".data", "dailyiq-watchlists.json");

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<WatchlistStore> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as WatchlistStore;
    }
  } catch {
    // Fall through to initialize an empty store.
  }
  const empty: WatchlistStore = {};
  await fs.writeFile(STORE_PATH, JSON.stringify(empty, null, 2), "utf8");
  return empty;
}

async function persistStore(store: WatchlistStore): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
  }).catch(() => {
    // Keep queue alive for subsequent writes.
  });
  await writeQueue;
}

function getUserStore(store: WatchlistStore, userId: string): Record<string, WatchlistEntry> {
  if (!store[userId]) {
    store[userId] = {};
  }
  return store[userId];
}

export async function getWatchlistEntries(userId: string): Promise<WatchlistEntry[]> {
  const store = await readStore();
  return Object.values(getUserStore(store, userId));
}

export async function getWatchlistSet(userId: string): Promise<Set<string>> {
  const store = await readStore();
  return new Set(Object.keys(getUserStore(store, userId)));
}

export async function getAllWatchCounts(): Promise<Map<string, number>> {
  const store = await readStore();
  const counts = new Map<string, number>();

  for (const userWatchlist of Object.values(store)) {
    for (const entry of Object.values(userWatchlist)) {
      counts.set(entry.playerId, (counts.get(entry.playerId) ?? 0) + 1);
    }
  }

  return counts;
}

export async function upsertWatchlistEntry(userId: string, playerId: string): Promise<{ entry: WatchlistEntry; created: boolean }> {
  const store = await readStore();
  const userWatchlist = getUserStore(store, userId);
  const existing = userWatchlist[playerId];
  if (existing) {
    return { entry: existing, created: false };
  }

  const entry: WatchlistEntry = {
    watchlistItemId: crypto.randomUUID(),
    userId,
    playerId,
    createdAt: new Date().toISOString(),
  };
  userWatchlist[playerId] = entry;
  await persistStore(store);
  return { entry, created: true };
}

export async function removeWatchlistEntry(userId: string, playerId: string): Promise<boolean> {
  const store = await readStore();
  const userWatchlist = getUserStore(store, userId);
  if (!userWatchlist[playerId]) {
    return false;
  }
  delete userWatchlist[playerId];
  await persistStore(store);
  return true;
}
