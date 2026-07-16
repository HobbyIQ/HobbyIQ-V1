// CF-CH-TOP-MOVERS-UNIVERSE (Drew, 2026-07-13, PR #433) — verifies the
// third universe layer: CH's top-movers extracted-players list is
// unioned into the daily snapshot job so ambient market activity gets
// covered without user holdings or hand-curation.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  loadTopMoverPlayers,
  _resetTopMoverPlayersCacheForTests,
} from "../src/services/portfolioiq/chTopMoverPlayers.service.js";
import * as ch from "../src/services/compiq/cardhedge.client.js";
import * as portfolio from "../src/services/portfolioiq/portfolioStore.service.js";
import * as ebay from "../src/services/ebay/ebayListingSearch.service.js";
import * as store from "../src/services/portfolioiq/listingsSnapshotStore.service.js";
import * as priority from "../src/services/portfolioiq/priorityWatchlist.service.js";
import * as topMovers from "../src/services/portfolioiq/chTopMoverPlayers.service.js";
import { runDailyListingsSnapshotJob } from "../src/services/compiq/dailyListingsSnapshotJob.service.js";

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

beforeEach(() => _resetTopMoverPlayersCacheForTests());
afterEach(() => vi.restoreAllMocks());

describe("loadTopMoverPlayers", () => {
  it("extracts unique player names from CH top-movers, case-insensitively deduped", async () => {
    vi.spyOn(ch, "getTopMovers").mockResolvedValue([
      { player: "Eric Hartman", card_id: "c1", description: "", set: "", number: "", variant: "", category: "Baseball", rookie: true, gain: 12 },
      { player: "eric hartman", card_id: "c2", description: "", set: "", number: "", variant: "", category: "Baseball", rookie: true, gain: 8 },  // dup
      { player: "Owen Carey",   card_id: "c3", description: "", set: "", number: "", variant: "", category: "Baseball", rookie: true, gain: 5 },
      { player: "  Ohtani  ",   card_id: "c4", description: "", set: "", number: "", variant: "", category: "Baseball", rookie: false, gain: 3 },
      { player: "",             card_id: "c5", description: "", set: "", number: "", variant: "", category: "Baseball", rookie: true, gain: 2 },  // skip empty
    ] as any);
    const out = await loadTopMoverPlayers({ forceRefresh: true });
    expect(out).toEqual(["Eric Hartman", "Owen Carey", "Ohtani"]);
  });

  it("returns [] when CH returns null (missing API key / rate limit)", async () => {
    vi.spyOn(ch, "getTopMovers").mockResolvedValue(null);
    const out = await loadTopMoverPlayers({ forceRefresh: true });
    expect(out).toEqual([]);
  });

  it("returns [] when CH throws (never propagates)", async () => {
    vi.spyOn(ch, "getTopMovers").mockRejectedValue(new Error("CH down"));
    const out = await loadTopMoverPlayers({ forceRefresh: true });
    expect(out).toEqual([]);
  });
});

describe("runDailyListingsSnapshotJob — three-layer union (users + priority + CH movers)", () => {
  it("snapshots CH-top-movers even when no users hold them and they're not on the priority list", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue([]);
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue([
      "Junior Caminero", "Zach Neto", "Ethan Salas",
    ]);
    const fetchSpy = vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersFromUsers).toBe(0);
    expect(summary.playersFromPriorityList).toBe(0);
    expect(summary.playersFromChTopMovers).toBe(3);
    expect(summary.snapshotsCreated).toBe(3);
    const called = fetchSpy.mock.calls.map((c) => c[1]);
    expect(called).toContain("Junior Caminero");
    expect(called).toContain("Zach Neto");
    expect(called).toContain("Ethan Salas");
  });

  it("priority list ranks above CH-movers ranks above user holdings", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: {
          h1: { playerName: "UserOnly Player" },
          h2: { playerName: "UserOnly Player" },  // count = 2
        } },
      ]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue([
      "Priority Player",       // priority-only
    ]);
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue([
      "Mover Player",          // ch-mover-only
    ]);
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1, topN: 3 });
    const order = summary.topPlayersSample.map((p) => p.player);
    // Priority > CH-mover > user-only (by holdingCount boost tiers).
    expect(order[0]).toBe("Priority Player");
    expect(order[1]).toBe("Mover Player");
    expect(order[2]).toBe("UserOnly Player");
  });

  it("does NOT double-count when a player is on all three universe layers", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: { h1: { playerName: "Eric Hartman" } } },
      ]),
    );
    vi.spyOn(priority, "loadPriorityPlayers").mockResolvedValue(["Eric Hartman"]);
    vi.spyOn(topMovers, "loadTopMoverPlayers").mockResolvedValue(["Eric Hartman"]);
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({ concurrency: 1 });
    expect(summary.playersSeen).toBe(1);            // deduped
    expect(summary.playersProcessed).toBe(1);
    expect(summary.snapshotsCreated).toBe(1);       // only fetched once
    expect(summary.playersFromUsers).toBe(1);
    // Priority + CH-mover both matched an existing entry so "new" counts stay 0.
    expect(summary.playersFromPriorityList).toBe(0);
    expect(summary.playersFromChTopMovers).toBe(0);
  });
});
