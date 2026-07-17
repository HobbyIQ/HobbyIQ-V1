// CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). Pinning tests for the
// pure watchlist-digest math. Covers the v1 mover rule:
//   direction !== "flat" AND |momentum - 1| > 0.10.
//
// No IO involved; every input is constructed inline.

import { describe, it, expect } from "vitest";
import {
  computeWatchlistDigest,
  _MOVER_THRESHOLD,
  type WatchlistDigestInputRow,
} from "../src/services/portfolioiq/watchlistDigestCompute.service.js";

function row(overrides: Partial<WatchlistDigestInputRow> & { name?: string } = {}): WatchlistDigestInputRow {
  const { name, ...rest } = overrides;
  return {
    playerId: rest.playerId ?? `pid-${(name ?? "player").replace(/\s+/g, "_").toLowerCase()}`,
    playerName: rest.playerName ?? name ?? "Test Player",
    trend: rest.trend === undefined
      ? { momentum: 1.30, direction: "up", qualifyingCards: 5 }
      : rest.trend,
  };
}

describe("computeWatchlistDigest — threshold + direction gate", () => {
  it("pins the 10% mover threshold constant", () => {
    expect(_MOVER_THRESHOLD).toBe(0.10);
  });

  it("fires on a clear up-mover above threshold", () => {
    const result = computeWatchlistDigest([
      row({ name: "Eric Hartman", trend: { momentum: 1.48, direction: "up", qualifyingCards: 6 } }),
    ]);
    expect(result.moverCount).toBe(1);
    expect(result.movers[0].playerName).toBe("Eric Hartman");
    expect(result.movers[0].direction).toBe("up");
    expect(result.movers[0].momentumDelta).toBeCloseTo(0.48, 6);
    expect(result.push).not.toBeNull();
    expect(result.push!.topMoverName).toBe("Eric Hartman");
    expect(result.push!.topMoverPercent).toBeCloseTo(48, 6);
    expect(result.push!.topMoverDirection).toBe("up");
  });

  it("fires on a clear down-mover above threshold", () => {
    const result = computeWatchlistDigest([
      row({ name: "Falling Star", trend: { momentum: 0.75, direction: "down", qualifyingCards: 4 } }),
    ]);
    expect(result.moverCount).toBe(1);
    expect(result.movers[0].direction).toBe("down");
    expect(result.movers[0].momentumDelta).toBeCloseTo(-0.25, 6);
    expect(result.push!.topMoverDirection).toBe("down");
    expect(result.push!.topMoverPercent).toBeCloseTo(-25, 6);
  });

  it("does NOT fire when momentum delta is at or below threshold", () => {
    // Uses 1.09 (safely below the 0.10 threshold) rather than 1.10
    // literally — JS float ops on 1.10 - 1 give 0.10000000000000009 which
    // trips a strict `>` boundary check. Below-threshold is the invariant
    // that matters for the product.
    const result = computeWatchlistDigest([
      row({ name: "Edge Case", trend: { momentum: 1.09, direction: "up", qualifyingCards: 6 } }),
    ]);
    expect(result.moverCount).toBe(0);
    expect(result.push).toBeNull();
  });

  it("does NOT fire when direction is flat regardless of momentum", () => {
    // If the engine says "flat" the trend threshold band already ate
    // the momentum, so trust it — no push.
    const result = computeWatchlistDigest([
      row({ name: "Flat Whisperer", trend: { momentum: 1.20, direction: "flat", qualifyingCards: 3 } }),
    ]);
    expect(result.moverCount).toBe(0);
    expect(result.push).toBeNull();
  });

  it("skips rows with null trend (no player_trends row yet)", () => {
    const result = computeWatchlistDigest([
      row({ name: "No Trend Yet", trend: null }),
    ]);
    expect(result.totalWatched).toBe(1);
    expect(result.moverCount).toBe(0);
  });

  it("skips rows with non-finite momentum defensively", () => {
    const result = computeWatchlistDigest([
      row({ name: "NaN Player", trend: { momentum: NaN, direction: "up", qualifyingCards: 5 } }),
    ]);
    expect(result.moverCount).toBe(0);
  });
});

describe("computeWatchlistDigest — top-mover selection", () => {
  it("picks the mover with the largest ABSOLUTE momentum delta as top", () => {
    const result = computeWatchlistDigest([
      row({ name: "Small Up", trend: { momentum: 1.12, direction: "up", qualifyingCards: 4 } }),
      row({ name: "Big Down", trend: { momentum: 0.50, direction: "down", qualifyingCards: 4 } }),
      row({ name: "Medium Up", trend: { momentum: 1.35, direction: "up", qualifyingCards: 4 } }),
    ]);
    expect(result.moverCount).toBe(3);
    // Big Down: |delta| = 0.50; Medium Up: 0.35; Small Up: 0.12.
    expect(result.movers[0].playerName).toBe("Big Down");
    expect(result.push!.topMoverName).toBe("Big Down");
    expect(result.push!.topMoverDirection).toBe("down");
  });

  it("breaks tie by playerName ascending for deterministic top pick", () => {
    // Both +20% — same absolute delta.
    const result = computeWatchlistDigest([
      row({ name: "Zach Player", trend: { momentum: 1.20, direction: "up", qualifyingCards: 4 } }),
      row({ name: "Aaron Player", trend: { momentum: 1.20, direction: "up", qualifyingCards: 4 } }),
    ]);
    expect(result.push!.topMoverName).toBe("Aaron Player");
  });

  it("returns null push when nothing crossed the threshold", () => {
    const result = computeWatchlistDigest([
      row({ name: "Steady", trend: { momentum: 1.05, direction: "up", qualifyingCards: 4 } }),
      row({ name: "Meh", trend: { momentum: 0.98, direction: "flat", qualifyingCards: 4 } }),
    ]);
    expect(result.moverCount).toBe(0);
    expect(result.push).toBeNull();
  });

  it("counts totalWatched from input length regardless of moverCount", () => {
    const result = computeWatchlistDigest([
      row({ name: "A", trend: null }),
      row({ name: "B", trend: { momentum: 1.30, direction: "up", qualifyingCards: 5 } }),
      row({ name: "C", trend: { momentum: 1.05, direction: "up", qualifyingCards: 5 } }),
    ]);
    expect(result.totalWatched).toBe(3);
    expect(result.moverCount).toBe(1);
  });

  it("empty input array returns zero digest with null push", () => {
    const result = computeWatchlistDigest([]);
    expect(result.totalWatched).toBe(0);
    expect(result.moverCount).toBe(0);
    expect(result.movers).toEqual([]);
    expect(result.push).toBeNull();
  });
});
