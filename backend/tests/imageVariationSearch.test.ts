// CF-IMAGE-VARIATION-SEARCH (Drew, 2026-08-12). Drew: "we need to be able to
// search for those with IV and Image Variation".
//
// Image variations are real, traded cards — 862 sales in 2026 Topps Chrome
// alone, print runs /10 /25 /50 — and the catalog carries them. But
// "Image Variation" lived in the parser's NOISE list and NOT in
// PARALLEL_PATTERNS, so both words were stripped as noise and the parallel
// was LOST. A search for an image variation could never target one.
//
// The sharp edge is "IV": it is the collector abbreviation AND a generational
// name suffix (Jr / Sr / II / III / IV). "Ken Griffey IV" must not become an
// image-variation search, so the pattern refuses IV directly after a
// capitalised name token.

import { describe, it, expect } from "vitest";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser";

const parallelOf = (q: string) => parseCardQuery(q).parallel ?? null;

describe("image variation is recognised as a parallel", () => {
  it("matches the full phrase", () => {
    expect(parallelOf("2026 Topps Chrome Judge Image Variation")).toMatch(/image variation/i);
  });

  it("matches the refractor form specifically", () => {
    expect(parallelOf("2026 Topps Chrome Judge Image Variation Refractor"))
      .toMatch(/image variation refractor/i);
  });

  it("matches the abbreviated 'Image Var'", () => {
    expect(parallelOf("2026 Topps Chrome Judge Image Var")).toMatch(/image variation/i);
  });

  it("matches the SSP form", () => {
    expect(parallelOf("2025 Bowman Chrome Baldwin Image Variation SSP"))
      .toMatch(/image variation ssp/i);
  });

  it("no longer loses the parallel to the NOISE list", () => {
    // The regression: both words stripped as noise, parallel came back null.
    expect(parallelOf("2026 Topps Chrome Judge Image Variation")).not.toBeNull();
  });
});

describe("IV abbreviation vs generational name suffix", () => {
  it("treats standalone IV as image variation", () => {
    expect(parallelOf("2026 Topps Chrome 136 IV")).toMatch(/image variation/i);
  });

  it("does NOT hijack a generational suffix after a player name", () => {
    // The collision this guard exists for. GENERATIONAL_SUFFIX_RE in
    // cardsight.router.ts already treats IV as a name suffix elsewhere.
    const p = parallelOf("Ken Griffey IV 2026 Topps Chrome");
    expect(p == null || !/image variation/i.test(p)).toBe(true);
  });

  it("does not hijack Sr/Jr-style suffixes either", () => {
    for (const q of ["Ronald Acuna Jr 2026 Topps Chrome", "Vladimir Guerrero Jr 2026 Bowman"]) {
      const p = parallelOf(q);
      expect(p == null || !/image variation/i.test(p), q).toBe(true);
    }
  });

  it("lowercase 'iv' inside a word is not matched", () => {
    // Guards against matching inside "Ivan", "drive", "silver".
    for (const q of ["Ivan Rodriguez 2026 Topps", "2026 Topps Chrome Silver"]) {
      const p = parallelOf(q);
      expect(p == null || !/image variation/i.test(p), q).toBe(true);
    }
  });
});
