// CF-IMAGE-VERIFY (Drew, 2026-07-28). Pins the pure hash-math bits.
// computeImageHash needs a live URL + sharp so it's exercised in
// integration tests only.

import { describe, expect, it } from "vitest";
import {
  hammingDistance,
  imageSimilarity,
  classifyImageMatch,
} from "../src/services/portfolioiq/imageVerify.service.js";

describe("hammingDistance", () => {
  it("identical hashes → 0", () => {
    expect(hammingDistance("abcdef0123456789", "abcdef0123456789")).toBe(0);
  });
  it("one bit differs → 1", () => {
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
  });
  it("every bit differs (00 vs FF) → 64", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });
  it("Hartshorn-class typical (10 bits) → 10", () => {
    // 0000 differs from 03ff by 10 bits (0x3ff has 10 bits set)
    expect(hammingDistance("00000000000003ff", "0000000000000000")).toBe(10);
  });
  it("wrong length → null", () => {
    expect(hammingDistance("abc", "abcdef0123456789")).toBeNull();
    expect(hammingDistance("", "abcdef0123456789")).toBeNull();
  });
  it("non-hex char → null", () => {
    expect(hammingDistance("zbcdef0123456789", "abcdef0123456789")).toBeNull();
  });
});

describe("imageSimilarity", () => {
  it("identical → 1", () => {
    expect(imageSimilarity("abcdef0123456789", "abcdef0123456789")).toBe(1);
  });
  it("all bits differ → 0", () => {
    expect(imageSimilarity("0000000000000000", "ffffffffffffffff")).toBe(0);
  });
  it("half the bits differ → 0.5", () => {
    // 0x5 = 0101 (2 bits) × 16 nibbles = 32 bits set = half of 64
    expect(imageSimilarity("0000000000000000", "5555555555555555")).toBe(0.5);
  });
});

describe("classifyImageMatch — default thresholds", () => {
  it("distance 5 (very similar) → match", () => {
    // 0x1f = 5 bits set
    const r = classifyImageMatch("0000000000000000", "000000000000001f");
    expect(r.verdict).toBe("match");
    expect(r.distance).toBe(5);
  });
  it("distance 15 (near) → near-match", () => {
    // 0x7fff = 15 bits set
    const r = classifyImageMatch("0000000000000000", "0000000000007fff");
    expect(r.verdict).toBe("near-match");
    expect(r.distance).toBe(15);
  });
  it("distance 30 (very different) → mismatch", () => {
    // 0x3fffffff = 30 bits
    const r = classifyImageMatch("0000000000000000", "000000003fffffff");
    expect(r.verdict).toBe("mismatch");
    expect(r.distance).toBe(30);
  });
  it("identical → match", () => {
    const r = classifyImageMatch("abcdef0123456789", "abcdef0123456789");
    expect(r.verdict).toBe("match");
    expect(r.similarity).toBe(1);
  });
});

describe("classifyImageMatch — env-tunable thresholds", () => {
  const originalMatch = process.env.IMAGE_MATCH_MAX_DISTANCE;
  const originalMismatch = process.env.IMAGE_MISMATCH_MIN_DISTANCE;

  it("tightens with env override", () => {
    process.env.IMAGE_MATCH_MAX_DISTANCE = "5";
    process.env.IMAGE_MISMATCH_MIN_DISTANCE = "15";
    // Distance 8 was "match" at default, now "near-match" at tightened
    const r = classifyImageMatch("0000000000000000", "00000000000000ff");
    expect(r.distance).toBe(8);
    expect(r.verdict).toBe("near-match");
    process.env.IMAGE_MATCH_MAX_DISTANCE = originalMatch;
    process.env.IMAGE_MISMATCH_MIN_DISTANCE = originalMismatch;
  });
});
