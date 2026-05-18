/**
 * Unit tests for the parallel-name normalizer.
 *
 * Exercises all five strategies:
 *   1. exact
 *   2. case-insensitive
 *   3. levenshtein
 *   4. known-typo
 *   5. unmatched
 *
 * Plus the stripped-refractor convenience match and the unmatched-accumulator.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeParallelName,
  UnmatchedParallelsAccumulator,
  getCanonicalNames,
} from "../src/agents/beckett/parallelNameNormalizer.js";

describe("normalizeParallelName", () => {
  it("exact match scores 1.0", () => {
    const r = normalizeParallelName("Blue");
    expect(r.canonical).toBe("Blue");
    expect(r.confidence).toBe(1.0);
    expect(r.strategy).toBe("exact");
  });

  it("case-insensitive match scores 0.95", () => {
    const r = normalizeParallelName("gold");
    expect(r.canonical).toBe("Gold");
    expect(r.confidence).toBe(0.95);
    expect(r.strategy).toBe("case-insensitive");
  });

  it("whitespace-tolerant match", () => {
    const r = normalizeParallelName("  Gold  Sapphire  ");
    expect(r.canonical).toBe("Gold Sapphire");
    expect(r.strategy).toBe("case-insensitive");
  });

  it("strips trailing 'Refractor' suffix from color parallels", () => {
    const r = normalizeParallelName("Blue Refractor");
    expect(r.canonical).toBe("Blue");
    expect(r.strategy).toBe("stripped-refractor");
    expect(r.confidence).toBeCloseTo(0.93);
  });

  it("strips trailing 'Refractors' (plural) suffix", () => {
    const r = normalizeParallelName("Gold Refractors");
    expect(r.canonical).toBe("Gold");
    expect(r.strategy).toBe("stripped-refractor");
  });

  it("preserves bare 'Refractor' canonical entry", () => {
    const r = normalizeParallelName("Refractor");
    expect(r.canonical).toBe("Refractor");
    expect(r.strategy).toBe("exact");
  });

  it("known-typo seed: 'Atomic Refracrtors' → 'Atomic'", () => {
    const r = normalizeParallelName("Atomic Refracrtors");
    expect(r.canonical).toBe("Atomic");
    expect(r.strategy).toBe("known-typo");
    expect(r.confidence).toBeCloseTo(0.95);
  });

  it("known-typo seed: pluralized 'Superfractors' → 'Superfractor'", () => {
    const r = normalizeParallelName("Superfractors");
    expect(r.canonical).toBe("Superfractor");
    expect(r.strategy).toBe("known-typo");
  });

  it("Levenshtein ≤ 2 catches single-char typos not in the seed list", () => {
    // "Sperfractor" — 1 edit from "Superfractor"
    const r = normalizeParallelName("Sperfractor");
    expect(r.canonical).toBe("Superfractor");
    expect(r.strategy).toBe("levenshtein");
    expect(r.confidence).toBeCloseTo(0.85);
    expect(r.editDistance).toBeLessThanOrEqual(2);
  });

  it("Levenshtein rejects distance > 2 as unmatched", () => {
    // 5+ edits from any canonical
    const r = normalizeParallelName("CompletelyDifferent");
    expect(r.canonical).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.strategy).toBe("unmatched");
  });

  it("empty input returns unmatched", () => {
    const r = normalizeParallelName("");
    expect(r.canonical).toBeNull();
    expect(r.strategy).toBe("unmatched");
  });

  it("preserves rawInput verbatim", () => {
    const raw = "  ATOMIC REFRACRTORS  ";
    const r = normalizeParallelName(raw);
    expect(r.rawInput).toBe(raw);
    expect(r.canonical).toBe("Atomic");
  });
});

describe("getCanonicalNames", () => {
  it("exposes exactly 54 canonical names (Phase A.2 contract)", () => {
    expect(getCanonicalNames().length).toBe(54);
  });

  it("includes Base Auto + Refractor anchors", () => {
    const names = getCanonicalNames();
    expect(names).toContain("Base Auto");
    expect(names).toContain("Refractor");
    expect(names).toContain("Superfractor");
  });
});

describe("UnmatchedParallelsAccumulator", () => {
  it("counts frequencies and caps samples at 5", () => {
    const acc = new UnmatchedParallelsAccumulator();
    for (let i = 0; i < 7; i += 1) acc.record("Mystery Color", `set-${i}`);
    const out = acc.toJSON();
    expect(out.length).toBe(1);
    expect(out[0]!.frequency).toBe(7);
    expect(out[0]!.samples.length).toBe(5);
  });

  it("sorts by frequency desc, then alpha", () => {
    const acc = new UnmatchedParallelsAccumulator();
    acc.record("Zebra Stripes");
    acc.record("Apple Red");
    acc.record("Apple Red");
    const out = acc.toJSON();
    expect(out[0]!.rawInput).toBe("Apple Red");
    expect(out[1]!.rawInput).toBe("Zebra Stripes");
  });

  it("ignores blank input", () => {
    const acc = new UnmatchedParallelsAccumulator();
    acc.record("   ");
    acc.record("");
    expect(acc.size()).toBe(0);
  });
});
