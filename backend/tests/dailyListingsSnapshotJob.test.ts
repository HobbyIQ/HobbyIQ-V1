// CF-DAILY-LISTINGS-CRON (Drew, 2026-07-13, PR #421) — verifies the
// enumeration + ranking + per-player call pattern of the snapshot job.
// Doesn't touch real Cosmos or eBay — fakes both.

import { describe, expect, it, vi, afterEach } from "vitest";
import { runDailyListingsSnapshotJob } from "../src/services/compiq/dailyListingsSnapshotJob.service.js";
import * as portfolio from "../src/services/portfolioiq/portfolioStore.service.js";
import * as ebay from "../src/services/ebay/ebayListingSearch.service.js";
import * as store from "../src/services/portfolioiq/listingsSnapshotStore.service.js";

// Fake Cosmos container that returns pre-canned user docs
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

afterEach(() => vi.restoreAllMocks());

describe("runDailyListingsSnapshotJob", () => {
  it("aggregates player counts across all portfolios, ranks by count, snapshots top-N", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: {
          h1: { playerName: "Eric Hartman" },
          h2: { playerName: "Eric Hartman" },
          h3: { playerName: "Mookie Betts" },
        } },
        { holdings: {
          h4: { playerName: "Eric Hartman" },
          h5: { playerName: "Ohtani" },
        } },
      ]),
    );
    const fetchSpy = vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 42,
      medianAsk: 25,
      pricedItemCount: 12,
      effectiveQuery: "test",
      snapshottedAt: "2026-07-13T12:00:00Z",
    });
    const upsertSpy = vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({
      userId: "test-user",
      topN: 2,
      concurrency: 1,
    });

    expect(summary.playersSeen).toBe(3);
    expect(summary.playersProcessed).toBe(2);
    expect(summary.snapshotsCreated).toBe(2);
    expect(summary.errors).toBe(0);
    // Ranked: Hartman (3), Betts (1) tied with Ohtani (1); top-2 keeps
    // Hartman + one of the ties.
    expect(fetchSpy).toHaveBeenCalledWith("test-user", "Eric Hartman");
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(summary.topPlayersSample[0]).toEqual({
      player: "Eric Hartman", holdingCount: 3,
    });
  });

  it("counts errors when Browse returns null (auth/rate-limit)", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: { h1: { playerName: "Alice" }, h2: { playerName: "Bob" } } },
      ]),
    );
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue(null);
    const upsertSpy = vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob({
      userId: "test-user",
      concurrency: 1,
    });
    expect(summary.errors).toBe(2);
    expect(summary.snapshotsCreated).toBe(0);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("no-ops cleanly when Cosmos is unavailable", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(null);
    const summary = await runDailyListingsSnapshotJob();
    expect(summary.playersSeen).toBe(0);
    expect(summary.playersProcessed).toBe(0);
  });

  it("dedups by player name (case-insensitive) — 'Eric HARTMAN' collides with 'Eric Hartman'", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: {
          h1: { playerName: "Eric Hartman" },
          h2: { playerName: "eric hartman" },
          h3: { playerName: "ERIC HARTMAN" },
        } },
      ]),
    );
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob();
    expect(summary.playersSeen).toBe(1);
    expect(summary.topPlayersSample[0].holdingCount).toBe(3);
  });

  it("skips holdings with missing playerName", async () => {
    vi.spyOn(portfolio, "getPortfolioContainer").mockResolvedValue(
      fakeContainer([
        { holdings: {
          h1: { playerName: "Alice" },
          h2: {},                    // no player
          h3: { playerName: "" },    // empty
          h4: { playerName: "  " },  // whitespace-only
        } },
      ]),
    );
    vi.spyOn(ebay, "fetchPlayerListingsSummary").mockResolvedValue({
      totalListings: 1, medianAsk: null, pricedItemCount: 0,
      effectiveQuery: "x", snapshottedAt: "2026-07-13T12:00:00Z",
    });
    vi.spyOn(store, "upsertSnapshot").mockResolvedValue();

    const summary = await runDailyListingsSnapshotJob();
    expect(summary.playersSeen).toBe(1);
  });
});
