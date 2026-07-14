// CF-MLB-TOP-PLAYERS (Drew, 2026-07-13, PR #434) — verifies the fourth
// universe layer: the stable MLB stars + top prospects list gets unioned
// into the daily snapshot cron below priority/movers but above pure
// user-only holdings, so baseline coverage of the market's steady
// attention is guaranteed even when no user holds those players.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadMlbTopPlayers,
  _resetMlbTopPlayersCacheForTests,
} from "../src/services/portfolioiq/mlbTopPlayers.service.js";
import { runDailyListingsSnapshotJob } from "../src/services/compiq/dailyListingsSnapshotJob.service.js";
import * as portfolio from "../src/services/portfolioiq/portfolioStore.service.js";
import * as ebay from "../src/services/ebay/ebayListingSearch.service.js";
import * as store from "../src/services/portfolioiq/listingsSnapshotStore.service.js";
import * as priority from "../src/services/portfolioiq/priorityWatchlist.service.js";
import * as topMovers from "../src/services/portfolioiq/chTopMoverPlayers.service.js";
import * as mlbTop from "../src/services/portfolioiq/mlbTopPlayers.service.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "mlb-top-"));
  _resetMlbTopPlayersCacheForTests();
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  _resetMlbTopPlayersCacheForTests();
});

async function writeList(stars: unknown, prospects: unknown): Promise<string> {
  const path = join(tmpDir, "mlb-top-players.json");
  await writeFile(path, JSON.stringify({ version: "test", stars, prospects }), "utf8");
  return path;
}

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

describe("loadMlbTopPlayers", () => {
  it("merges stars + prospects, dedupes case-insensitively", async () => {
    const path = await writeList(
      ["Aaron Judge", "Shohei Ohtani", "Aaron Judge"],  // dup
      ["Roman Anthony", "aaron judge"],                 // dup case
    );
    const out = await loadMlbTopPlayers({ path });
    expect(out).toEqual(["Aaron Judge", "Shohei Ohtani", "Roman Anthony"]);
  });

  it("returns [] when file missing (never throws)", async () => {
    const out = await loadMlbTopPlayers({ path: join(tmpDir, "nope.json") });
    expect(out).toEqual([]);
  });

  it("returns [] when JSON is malformed", async () => {
    const path = join(tmpDir, "mlb-top-players.json");
    await writeFile(path, "not-json!!", "utf8");
    const out = await loadMlbTopPlayers({ path });
    expect(out).toEqual([]);
  });

  it("returns [] when stars/prospects are not arrays", async () => {
    const path = join(tmpDir, "mlb-top-players.json");
    await writeFile(path, JSON.stringify({ stars: "nope", prospects: [] }), "utf8");
    const out = await loadMlbTopPlayers({ path });
    expect(out).toEqual([]);
  });
});

describe("mlb-top-players.json — actual file shape sanity check", () => {
  it("loads the shipped file, contains expected canonical players", async () => {
    const out = await loadMlbTopPlayers();
    expect(out.length).toBeGreaterThanOrEqual(100);
    // Sanity: canonical stars and prospects must survive dedup/trim
    expect(out).toContain("Aaron Judge");
    expect(out).toContain("Shohei Ohtani");
    expect(out).toContain("Roman Anthony");
    // Case-insensitive dedup: unique lowered form count == list length
    const lowered = out.map((p) => p.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });
});

describe("runDailyListingsSnapshotJob — MLB-top-players union", () => {
  beforeEach(() => {
    // Isolate MLB layer test from priority + CH movers.
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue([]);
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue([]);
  });

  it("snapshots MLB-top players even when no users hold them and other layers are empty", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([]),
    );
    vi.spyOn(mlbTop, "loadMlbTopPlayers").mockResolvedValue([
      "Aaron Judge", "Shohei Ohtani", "Roman Anthony",
    ]);
    const fetchSpy = vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersFromUsers).toBe(0);
    expect(summary.playersFromPriorityList).toBe(0);
    expect(summary.playersFromChTopMovers).toBe(0);
    expect(summary.playersFromMlbTopPlayers).toBe(3);
    expect(summary.snapshotsCreated).toBe(3);
    const called = fetchSpy.mock.calls.map((c) => c[1]);
    expect(called).toContain("Aaron Judge");
    expect(called).toContain("Shohei Ohtani");
    expect(called).toContain("Roman Anthony");
  });

  it("ranks priority > CH-movers > MLB-stable > user-only", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([{ holdings: { h1: { playerName: "UserOnly Player" } } }]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue(["Priority Player"]);
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue(["Mover Player"]);
    vi.spyOn(mlbTop, "loadMlbTopPlayers").mockResolvedValue(["MLB Stable Player"]);
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1, topN: 4 });
    const order = summary.topPlayersSample.map((p) => p.player);
    expect(order[0]).toBe("Priority Player");
    expect(order[1]).toBe("Mover Player");
    expect(order[2]).toBe("MLB Stable Player");
    expect(order[3]).toBe("UserOnly Player");
  });

  it("all four layers hitting the same player still dedupes to a single snapshot", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([{ holdings: { h1: { playerName: "Aaron Judge" } } }]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue(["Aaron Judge"]);
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue(["Aaron Judge"]);
    vi.spyOn(mlbTop, "loadMlbTopPlayers").mockResolvedValue(["Aaron Judge"]);
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersSeen).toBe(1);
    expect(summary.snapshotsCreated).toBe(1);
    // All curated layers matched an existing entry so "new" counts stay 0.
    expect(summary.playersFromPriorityList).toBe(0);
    expect(summary.playersFromChTopMovers).toBe(0);
    expect(summary.playersFromMlbTopPlayers).toBe(0);
  });
});
