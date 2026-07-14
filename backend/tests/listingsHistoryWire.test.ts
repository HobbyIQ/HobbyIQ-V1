// CF-LISTINGS-HISTORY-WIRE (Drew, 2026-07-13, PR #425) — verifies the
// listingsHistory[] shape emitted on Card Detail responses so iOS'
// supply-side trend chart has time-series data to plot.

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchListingsHistoryForWire } from "../src/services/compiq/supplyDemandSignal.service.js";
import * as store from "../src/services/portfolioiq/listingsSnapshotStore.service.js";

const BASE_DAY = Date.parse("2026-08-01T00:00:00Z");
const day = (offsetDays: number, count: number, medianAsk: number | null = null) => {
  const ms = BASE_DAY - offsetDays * 86_400_000;
  const iso = new Date(ms).toISOString();
  const dateOnly = iso.slice(0, 10);
  return {
    id: `test::${dateOnly}`,
    player: "test-player",
    playerDisplay: "Test Player",
    date: dateOnly,
    totalListings: count,
    medianAsk,
    pricedItemCount: medianAsk != null ? 5 : 0,
    effectiveQuery: "Test Player",
    snapshottedAt: iso,
    ttl: 0,
  };
};

afterEach(() => vi.restoreAllMocks());

describe("fetchListingsHistoryForWire", () => {
  it("returns empty array on null playerName (graceful degrade for iOS)", async () => {
    const r = await fetchListingsHistoryForWire(null, 30);
    expect(r).toEqual([]);
  });

  it("returns empty array when snapshots container is unavailable", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([]);
    const r = await fetchListingsHistoryForWire("Test Player", 30);
    expect(r).toEqual([]);
  });

  it("emits { date, totalListings, medianAsk } for each snapshot", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(10, 42, 25.5),
      day(5, 45, 26.0),
      day(0, 40, 24.8),
    ]);
    const r = await fetchListingsHistoryForWire("Test Player", 30);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({
      date: "2026-07-22",
      totalListings: 42,
      medianAsk: 25.5,
    });
  });

  it("returns points chronologically (oldest first) so iOS can plot without re-sorting", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(0, 100),   // newest
      day(20, 60),   // oldest
      day(10, 80),   // middle
    ]);
    const r = await fetchListingsHistoryForWire("Test Player", 30);
    expect(r.map((p) => p.totalListings)).toEqual([60, 80, 100]);
    // Confirm dates are also monotonically increasing
    for (let i = 1; i < r.length; i++) {
      expect(r[i].date >= r[i - 1].date).toBe(true);
    }
  });

  it("preserves null medianAsk when the snapshot had no priced items that day", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(1, 30, null),
      day(0, 32, 22.5),
    ]);
    const r = await fetchListingsHistoryForWire("Test Player", 30);
    expect(r[0].medianAsk).toBeNull();
    expect(r[1].medianAsk).toBe(22.5);
  });

  it("passes the days parameter through to the store", async () => {
    const spy = vi.spyOn(store, "readSnapshots").mockResolvedValue([]);
    await fetchListingsHistoryForWire("Test Player", 7);
    expect(spy).toHaveBeenCalledWith("Test Player", 7);
  });
});
