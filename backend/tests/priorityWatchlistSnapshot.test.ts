// CF-PRIORITY-WATCHLIST (Drew, 2026-07-13, PR #435) — verifies the
// hand-curated player list gets covered by the daily snapshot cron even
// when no user holdings back it, and cleanly dedupes when a priority
// player already appears in user data.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPriorityPlayers,
  _resetPriorityWatchlistCacheForTests,
} from "../src/services/portfolioiq/priorityWatchlist.service.js";
import { runDailyListingsSnapshotJob } from "../src/services/compiq/dailyListingsSnapshotJob.service.js";
import * as portfolio from "../src/services/portfolioiq/portfolioStore.service.js";
import * as ebay from "../src/services/ebay/ebayListingSearch.service.js";
import * as store from "../src/services/portfolioiq/listingsSnapshotStore.service.js";
import * as priority from "../src/services/portfolioiq/priorityWatchlist.service.js";
import * as topMovers from "../src/services/portfolioiq/chTopMoverPlayers.service.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "prio-watch-"));
  _resetPriorityWatchlistCacheForTests();
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  _resetPriorityWatchlistCacheForTests();
});

async function writeList(players: unknown): Promise<string> {
  const path = join(tmpDir, "priority-watchlist.json");
  await writeFile(path, JSON.stringify({ version: "test", players, cards: [] }), "utf8");
  return path;
}

describe("loadPriorityPlayers", () => {
  it("returns the trimmed, deduped, ordered player list", async () => {
    const path = await writeList([
      "Eric Hartman",
      "  Leo De Vries  ",
      "Eric Hartman",           // dup exact
      "eric hartman",           // dup case-insensitive
      "",
      "Owen Carey",
    ]);
    const players = await loadPriorityPlayers({ path });
    expect(players).toEqual(["Eric Hartman", "Leo De Vries", "Owen Carey"]);
  });

  it("returns empty list when file is missing (never throws)", async () => {
    const players = await loadPriorityPlayers({
      path: join(tmpDir, "does-not-exist.json"),
    });
    expect(players).toEqual([]);
  });

  it("returns empty list when JSON is malformed (never throws)", async () => {
    const path = join(tmpDir, "priority-watchlist.json");
    await writeFile(path, "not-json{{", "utf8");
    const players = await loadPriorityPlayers({ path });
    expect(players).toEqual([]);
  });

  it("returns empty list when players is not an array", async () => {
    const path = join(tmpDir, "priority-watchlist.json");
    await writeFile(
      path,
      JSON.stringify({ version: "test", players: "not-an-array", cards: [] }),
      "utf8",
    );
    const players = await loadPriorityPlayers({ path });
    expect(players).toEqual([]);
  });
});

function fakeContainer(docs: any[]) {
  return {
    items: {
      query: () => ({
        hasMoreResults: (() => {
          let called = false;
          return () => {
            if (called) return false;
            called = true;
            return true;
          };
        })(),
        fetchNext: async () => ({ resources: docs }),
      }),
    },
  } as any;
}

describe("runDailyListingsSnapshotJob — priority-watchlist union", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    // Isolate this suite from the CH-mover universe — that layer has its
    // own test file. Pinning priority-only behavior here.
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue([]);
  });

  it("snapshots priority players even when NO users have holdings", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue([
      "Eric Hartman",
      "Owen Carey",
      "Shohei Ohtani",
    ]);
    const fetchSpy = vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 42, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersFromUsers).toBe(0);
    expect(summary.playersFromPriorityList).toBe(3);
    expect(summary.playersSeen).toBe(3);
    expect(summary.playersProcessed).toBe(3);
    expect(summary.snapshotsCreated).toBe(3);
    // Every priority player got a Browse call, even with 0 user holdings.
    const called = fetchSpy.mock.calls.map((c) => c[1]);
    expect(called).toContain("Eric Hartman");
    expect(called).toContain("Owen Carey");
    expect(called).toContain("Shohei Ohtani");
  });

  it("merges priority + user players (no double-count on overlap)", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: {
          h1: { playerName: "Eric Hartman" },  // OVERLAPS priority
          h2: { playerName: "Mookie Betts" },  // user-only
        } },
      ]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue([
      "Eric Hartman",     // overlaps
      "Owen Carey",       // priority-only
    ]);
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersFromUsers).toBe(2);              // Hartman + Betts
    expect(summary.playersFromPriorityList).toBe(1);       // only Carey was net-new
    expect(summary.playersSeen).toBe(3);                   // Hartman, Betts, Carey
    // Priority-boosted Hartman ranks first (user count 1 + boost).
    expect(summary.topPlayersSample[0].player).toBe("Eric Hartman");
  });

  it("priority list load failure → falls back to user-only (never throws)", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: { h1: { playerName: "Alice" } } },
      ]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue([]);  // simulate load fail
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersFromUsers).toBe(1);
    expect(summary.playersFromPriorityList).toBe(0);
    expect(summary.playersSeen).toBe(1);
    expect(summary.playersProcessed).toBe(1);
  });
});

describe("priority-watchlist.json — actual file shape sanity check", () => {
  it("loads Drew's real priority list and contains expected canonical players", async () => {
    // Read the ACTUAL production file. Guard against accidental empties
    // or version regressions.
    const players = await loadPriorityPlayers();
    expect(players.length).toBeGreaterThanOrEqual(50);
    // Sanity: a few canonical names Drew explicitly named or holds must
    // survive dedup/trim.
    expect(players).toContain("Eric Hartman");
    expect(players).toContain("Leo De Vries");
    expect(players).toContain("Owen Carey");
    expect(players).toContain("Shohei Ohtani");
    // Case-insensitive dedup guarantee: no two entries share a lowered
    // form.
    const lowered = players.map((p) => p.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });
});
