import { describe, it, expect } from "vitest";
import {
  computeMissingParallels,
  bucketKeyOf,
  type CorpusParallelRow,
} from "../src/services/portfolioiq/missingParallelsCompute.service.js";

function mkRow(overrides: Partial<CorpusParallelRow> = {}): CorpusParallelRow {
  return {
    cardId: "c1",
    player: "Eric Hartman",
    year: 2026,
    cardSet: "2026 Bowman Baseball",
    variant: "Base",
    number: "CPA-EHA",
    recentSales: 12,
    medianPrice: 110,
    imageUrl: null,
    ...overrides,
  };
}

describe("computeMissingParallels — bucketing", () => {
  it("returns nothing when no owned buckets match corpus rows", () => {
    const rows = [
      mkRow({ cardId: "c1", variant: "Base" }),
      mkRow({ cardId: "c2", variant: "Refractor" }),
    ];
    const r = computeMissingParallels(new Set(), new Set(), rows);
    expect(r).toHaveLength(0);
  });

  it("lists parallels the user does not own for a bucket they DO have", () => {
    const rows = [
      mkRow({ cardId: "own1", variant: "Base" }),
      mkRow({ cardId: "missing1", variant: "Refractor", medianPrice: 380 }),
      mkRow({ cardId: "missing2", variant: "Blue Ice", medianPrice: 220 }),
    ];
    const ownedCardIds = new Set(["own1"]);
    const ownedBuckets = new Set([bucketKeyOf("Eric Hartman", 2026, "2026 Bowman Baseball")]);
    const r = computeMissingParallels(ownedCardIds, ownedBuckets, rows);

    expect(r).toHaveLength(1);
    expect(r[0].player).toBe("Eric Hartman");
    expect(r[0].ownedVariants).toEqual(["Base"]);
    expect(r[0].missingParallels).toHaveLength(2);
    // Sort by medianPrice DESC
    expect(r[0].missingParallels[0].variant).toBe("Refractor");
    expect(r[0].missingParallels[1].variant).toBe("Blue Ice");
  });

  it("skips buckets the user does not own at all", () => {
    const rows = [
      mkRow({ cardId: "c1", variant: "Base", player: "Ohtani", year: 2018 }),
    ];
    const ownedCardIds = new Set(["hartman-base"]);
    const ownedBuckets = new Set([bucketKeyOf("Eric Hartman", 2026, "2026 Bowman Baseball")]);
    const r = computeMissingParallels(ownedCardIds, ownedBuckets, rows);
    expect(r).toHaveLength(0);
  });

  it("groups multiple owned parallels in same bucket", () => {
    const rows = [
      mkRow({ cardId: "own1", variant: "Base" }),
      mkRow({ cardId: "own2", variant: "Refractor" }),
      mkRow({ cardId: "missing1", variant: "Gold", medianPrice: 500 }),
    ];
    const ownedCardIds = new Set(["own1", "own2"]);
    const ownedBuckets = new Set([bucketKeyOf("Eric Hartman", 2026, "2026 Bowman Baseball")]);
    const r = computeMissingParallels(ownedCardIds, ownedBuckets, rows);

    expect(r[0].ownedVariants.sort()).toEqual(["Base", "Refractor"]);
    expect(r[0].missingParallels.map((p) => p.variant)).toEqual(["Gold"]);
  });

  it("handles multiple buckets (different player/year/set)", () => {
    const rows = [
      mkRow({ cardId: "hart-own", variant: "Base", player: "Eric Hartman", year: 2026, cardSet: "2026 Bowman Baseball" }),
      mkRow({ cardId: "hart-missing", variant: "Refractor", player: "Eric Hartman", year: 2026, cardSet: "2026 Bowman Baseball" }),
      mkRow({ cardId: "judge-own", variant: "Base", player: "Aaron Judge", year: 2016, cardSet: "2016 Bowman Chrome" }),
      mkRow({ cardId: "judge-missing", variant: "Gold Refractor", player: "Aaron Judge", year: 2016, cardSet: "2016 Bowman Chrome", medianPrice: 12000 }),
    ];
    const ownedCardIds = new Set(["hart-own", "judge-own"]);
    const ownedBuckets = new Set([
      bucketKeyOf("Eric Hartman", 2026, "2026 Bowman Baseball"),
      bucketKeyOf("Aaron Judge", 2016, "2016 Bowman Chrome"),
    ]);
    const r = computeMissingParallels(ownedCardIds, ownedBuckets, rows);

    expect(r).toHaveLength(2);
    // Player-sorted alphabetically
    expect(r[0].player).toBe("Aaron Judge");
    expect(r[1].player).toBe("Eric Hartman");
  });

  it("does not double-count same variant appearing multiple times", () => {
    const rows = [
      mkRow({ cardId: "own1", variant: "Base" }),
      mkRow({ cardId: "own2", variant: "Base" }),   // same variant different cardId
    ];
    const ownedCardIds = new Set(["own1", "own2"]);
    const ownedBuckets = new Set([bucketKeyOf("Eric Hartman", 2026, "2026 Bowman Baseball")]);
    const r = computeMissingParallels(ownedCardIds, ownedBuckets, rows);
    expect(r[0].ownedVariants).toEqual(["Base"]);
    expect(r[0].missingParallels).toHaveLength(0);
  });

  it("bucketKeyOf produces deterministic key", () => {
    expect(bucketKeyOf("A", 2026, "S"))
      .toBe(bucketKeyOf("A", 2026, "S"));
    expect(bucketKeyOf("A", 2026, "S1"))
      .not.toBe(bucketKeyOf("A", 2026, "S2"));
  });
});
