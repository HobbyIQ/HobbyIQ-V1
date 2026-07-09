// CF-FUZZY-PLAYER-SEARCH (2026-07-08) — Levenshtein-based fuzzy player
// name matching for the /suggest-corrections endpoint.

import { describe, it, expect } from "vitest";
import {
  levenshtein,
  closestMatch,
  proportionalMaxDistance,
} from "../src/services/compiq/fuzzyPlayerSearch.service.js";

describe("CF-FUZZY-PLAYER-SEARCH — levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("Willits", "Willits")).toBe(0);
    expect(levenshtein("willits", "WILLITS")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns edit distance for classic typos", () => {
    expect(levenshtein("Willets", "Willits")).toBe(1);   // e/i swap
    expect(levenshtein("Ohtani", "Ohtony")).toBe(2);     // 2 letter swaps
    expect(levenshtein("Hartshorn", "Hartsorn")).toBe(1); // missing h
    expect(levenshtein("Hartshorn", "Hartschorn")).toBe(1); // extra c
  });

  it("handles empty vs non-empty strings", () => {
    expect(levenshtein("", "Willits")).toBe(7);
    expect(levenshtein("Willits", "")).toBe(7);
  });

  it("is case-insensitive", () => {
    expect(levenshtein("WILLITS", "willits")).toBe(0);
    expect(levenshtein("Willets", "WILLITS")).toBe(1);
  });
});

describe("CF-FUZZY-PLAYER-SEARCH — closestMatch", () => {
  it("finds the closest match within maxDistance", () => {
    const pool = ["Eli Willits", "Ike Irish", "Josh Hammond", "Ethan Conrad"];
    const result = closestMatch("Eli Willets", pool, 2);
    expect(result?.match).toBe("Eli Willits");
    expect(result?.distance).toBe(1);
  });

  it("returns null when no candidate is within maxDistance", () => {
    const pool = ["Mike Trout", "Shohei Ohtani"];
    const result = closestMatch("Wxyz Qqqq", pool, 2);
    expect(result).toBeNull();
  });

  it("prefers exact match over near-match (distance=0 short-circuits)", () => {
    const pool = ["Ohtani", "Ohtony", "Ottani"];
    const result = closestMatch("Ohtani", pool, 3);
    expect(result?.match).toBe("Ohtani");
    expect(result?.distance).toBe(0);
  });

  it("returns null for empty pool or empty candidate", () => {
    expect(closestMatch("Willits", [])).toBeNull();
    expect(closestMatch("", ["Willits"])).toBeNull();
  });
});

describe("CF-FUZZY-PLAYER-SEARCH — proportionalMaxDistance", () => {
  it("allows more edits for longer names", () => {
    expect(proportionalMaxDistance("Kim")).toBe(1);         // 3 chars — <=4 → 1
    expect(proportionalMaxDistance("Ohta")).toBe(1);        // 4 chars — <=4 → 1
    expect(proportionalMaxDistance("Trout")).toBe(2);       // 5 chars — <=8 → 2
    expect(proportionalMaxDistance("Willits")).toBe(2);     // 7 chars — <=8 → 2
    expect(proportionalMaxDistance("Hartshorn")).toBe(3);   // 9 chars — >8 → 3
    expect(proportionalMaxDistance("Misiorowski")).toBe(3); // 11 chars — >8 → 3
  });
});
