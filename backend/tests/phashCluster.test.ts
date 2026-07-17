// CF-ATTRIBUTION-PHASE-1-DHASH (2026-07-16). Union-find clustering
// pinning tests.

import { describe, it, expect } from "vitest";
import { clusterByHamming, summarizeAttribution, DEFAULT_HAMMING_THRESHOLD } from "../src/services/attribution/phashCluster.service.js";

function row(id: string, hash: string) {
  return { price_history_id: id, hash };
}

describe("clusterByHamming", () => {
  it("empty input → 0 clusters", () => {
    const out = clusterByHamming([]);
    expect(out.clusterCount).toBe(0);
    expect(out.assignments).toEqual([]);
  });

  it("single row → 1 cluster", () => {
    const out = clusterByHamming([row("a", "0000000000000000")]);
    expect(out.clusterCount).toBe(1);
    expect(out.assignments).toEqual([0]);
    expect(out.sizes.get(0)).toBe(1);
  });

  it("two identical hashes → 1 cluster", () => {
    const out = clusterByHamming([
      row("a", "0000000000000000"),
      row("b", "0000000000000000"),
    ]);
    expect(out.clusterCount).toBe(1);
    expect(out.assignments).toEqual([0, 0]);
    expect(out.sizes.get(0)).toBe(2);
  });

  it("two far-apart hashes → 2 clusters", () => {
    const out = clusterByHamming([
      row("a", "0000000000000000"),
      row("b", "ffffffffffffffff"),
    ]);
    expect(out.clusterCount).toBe(2);
    expect(out.assignments[0]).not.toBe(out.assignments[1]);
  });

  it("threshold-just-inside merges", () => {
    // 4 bits difference (one nibble flip)
    const out = clusterByHamming([
      row("a", "0000000000000000"),
      row("b", "f000000000000000"),
    ], 4);
    expect(out.clusterCount).toBe(1);
  });

  it("threshold-just-outside splits", () => {
    // 4 bits difference, but threshold=3
    const out = clusterByHamming([
      row("a", "0000000000000000"),
      row("b", "f000000000000000"),
    ], 3);
    expect(out.clusterCount).toBe(2);
  });

  it("transitive similarity groups all three", () => {
    // A near B, B near C, A far from C → still one cluster (union-find
    // transitivity)
    const out = clusterByHamming([
      row("a", "0000000000000000"),
      row("b", "0f00000000000000"), // 4 bits from A
      row("c", "0ff0000000000000"), // 4 bits from B, 8 bits from A
    ], 4);
    expect(out.clusterCount).toBe(1);
  });

  it("mixed: 5 hashes across 3 clusters (2, 2, 1)", () => {
    const out = clusterByHamming([
      row("a", "0000000000000000"),
      row("b", "0000000000000000"),  // matches a
      row("c", "ffffffffffffffff"),
      row("d", "ffffffffffffffff"),  // matches c
      row("e", "0f0f0f0f0f0f0f0f"),  // in middle, far from both
    ], DEFAULT_HAMMING_THRESHOLD);
    expect(out.clusterCount).toBe(3);
    const counts = [...out.sizes.values()].sort((a, b) => b - a);
    expect(counts).toEqual([2, 2, 1]);
  });
});

describe("summarizeAttribution", () => {
  it("empty input → zeros + not suspect", () => {
    const s = summarizeAttribution({ assignments: [], clusterCount: 0, sizes: new Map() });
    expect(s.total_hashed_sales).toBe(0);
    expect(s.cluster_count).toBe(0);
    expect(s.suspect).toBe(false);
  });

  it("single cluster → not suspect", () => {
    const s = summarizeAttribution({
      assignments: [0, 0, 0],
      clusterCount: 1,
      sizes: new Map([[0, 3]]),
    });
    expect(s.cluster_count).toBe(1);
    expect(s.largest_cluster_size).toBe(3);
    expect(s.smallest_cluster_size).toBe(3);
    expect(s.suspect).toBe(false);
  });

  it("two clusters of unequal size → suspect", () => {
    const s = summarizeAttribution({
      assignments: [0, 0, 1],
      clusterCount: 2,
      sizes: new Map([[0, 2], [1, 1]]),
    });
    expect(s.cluster_count).toBe(2);
    expect(s.largest_cluster_size).toBe(2);
    expect(s.smallest_cluster_size).toBe(1);
    expect(s.suspect).toBe(true);
  });

  it("two clusters of equal size → NOT suspect (largest === smallest)", () => {
    // Design choice — equal-size 2-cluster is ambiguous, don't flag.
    const s = summarizeAttribution({
      assignments: [0, 1],
      clusterCount: 2,
      sizes: new Map([[0, 1], [1, 1]]),
    });
    expect(s.suspect).toBe(false);
  });

  it("three-cluster mix → suspect (something is smaller than largest)", () => {
    const s = summarizeAttribution({
      assignments: [0, 0, 1, 1, 2],
      clusterCount: 3,
      sizes: new Map([[0, 2], [1, 2], [2, 1]]),
    });
    expect(s.suspect).toBe(true);
  });
});
