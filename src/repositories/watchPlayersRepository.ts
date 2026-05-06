import fs from "fs";
import path from "path";

export interface WatchlistItem {
  playerId: string;
  playerName: string;
  team?: string;
  league?: string;
  addedAt: string;
}

export interface TopWatchedPlayer {
  playerId: string;
  playerName: string;
  team?: string;
  league?: string;
  watchCount: number;
}

type WatchPlayersStore = Record<string, WatchlistItem[]>;

const storeFilePath = process.env.WATCH_PLAYERS_FILE
  ? path.resolve(process.env.WATCH_PLAYERS_FILE)
  : path.resolve(process.cwd(), "data", "watchPlayers.json");

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });
}

function readStore(): WatchPlayersStore {
  try {
    const raw = fs.readFileSync(storeFilePath, "utf8");
    const parsed = JSON.parse(raw) as WatchPlayersStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: WatchPlayersStore) {
  ensureStoreDir();
  fs.writeFileSync(storeFilePath, JSON.stringify(store, null, 2), "utf8");
}

function normalizePlayerName(playerName: string): string {
  return playerName.trim().replace(/\s+/g, " ");
}

function normalizePlayerId(playerId: string): string {
  return playerId.trim().toLowerCase();
}

function derivePlayerId(playerName: string): string {
  return normalizePlayerName(playerName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeWatchlistItem(item: WatchlistItem): WatchlistItem {
  return {
    ...item,
    playerId: normalizePlayerId(item.playerId),
    playerName: normalizePlayerName(item.playerName),
  };
}

function hasPlayer(list: WatchlistItem[], candidate: { playerId: string; playerName: string }): boolean {
  const normalizedPlayerId = normalizePlayerId(candidate.playerId);
  const normalizedPlayerName = normalizePlayerName(candidate.playerName).toLowerCase();

  return list.some((entry) => {
    const normalizedEntry = normalizeWatchlistItem(entry);
    return (
      normalizedEntry.playerId === normalizedPlayerId
      || normalizePlayerName(normalizedEntry.playerName).toLowerCase() === normalizedPlayerName
    );
  });
}

export const watchPlayersRepository = {
  getList(userId: string): WatchlistItem[] {
    const store = readStore();
    const rawList = Array.isArray(store[userId]) ? [...store[userId]] : [];
    return rawList.map(normalizeWatchlistItem);
  },

  addPlayer(
    userId: string,
    player: { playerId?: string; playerName: string; team?: string; league?: string },
  ): WatchlistItem | null {
    const normalizedPlayerName = normalizePlayerName(player.playerName);
    const normalizedPlayerId = normalizePlayerId(player.playerId ?? derivePlayerId(normalizedPlayerName));
    if (!userId.trim() || !normalizedPlayerName || !normalizedPlayerId) {
      return null;
    }

    const store = readStore();
    const currentList = (Array.isArray(store[userId]) ? [...store[userId]] : []).map(normalizeWatchlistItem);
    const candidate = { playerId: normalizedPlayerId, playerName: normalizedPlayerName };
    if (hasPlayer(currentList, candidate)) {
      return null;
    }

    const newItem: WatchlistItem = {
      playerId: normalizedPlayerId,
      playerName: normalizedPlayerName,
      team: player.team?.trim() || undefined,
      league: player.league?.trim() || undefined,
      addedAt: new Date().toISOString(),
    };

    currentList.push(newItem);
    store[userId] = currentList;
    writeStore(store);
    return newItem;
  },

  removePlayer(userId: string, playerId: string): boolean {
    const normalizedPlayerId = normalizePlayerId(playerId);
    if (!userId.trim() || !normalizedPlayerId) {
      return false;
    }

    const store = readStore();
    const currentList = (Array.isArray(store[userId]) ? [...store[userId]] : []).map(normalizeWatchlistItem);
    const nextList = currentList.filter(
      (entry) => entry.playerId !== normalizedPlayerId,
    );

    if (nextList.length === currentList.length) {
      return false;
    }

    if (nextList.length === 0) {
      delete store[userId];
    } else {
      store[userId] = nextList;
    }

    writeStore(store);
    return true;
  },

  removePlayerByName(userId: string, playerName: string): boolean {
    const normalizedPlayerName = normalizePlayerName(playerName).toLowerCase();
    if (!userId.trim() || !normalizedPlayerName) {
      return false;
    }

    const store = readStore();
    const currentList = (Array.isArray(store[userId]) ? [...store[userId]] : []).map(normalizeWatchlistItem);
    const nextList = currentList.filter(
      (entry) => normalizePlayerName(entry.playerName).toLowerCase() !== normalizedPlayerName,
    );

    if (nextList.length === currentList.length) {
      return false;
    }

    if (nextList.length === 0) {
      delete store[userId];
    } else {
      store[userId] = nextList;
    }

    writeStore(store);
    return true;
  },

  getTopWatched(limit = 10): TopWatchedPlayer[] {
    const safeLimit = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
    const store = readStore();
    const aggregate = new Map<string, TopWatchedPlayer>();

    for (const list of Object.values(store)) {
      const items = (Array.isArray(list) ? list : []).map(normalizeWatchlistItem);
      for (const item of items) {
        const existing = aggregate.get(item.playerId);
        if (existing) {
          existing.watchCount += 1;
          if (!existing.team && item.team) {
            existing.team = item.team;
          }
          if (!existing.league && item.league) {
            existing.league = item.league;
          }
          continue;
        }

        aggregate.set(item.playerId, {
          playerId: item.playerId,
          playerName: item.playerName,
          team: item.team,
          league: item.league,
          watchCount: 1,
        });
      }
    }

    return Array.from(aggregate.values())
      .sort((a, b) => {
        if (b.watchCount !== a.watchCount) {
          return b.watchCount - a.watchCount;
        }
        return a.playerName.localeCompare(b.playerName);
      })
      .slice(0, safeLimit);
  },
};
