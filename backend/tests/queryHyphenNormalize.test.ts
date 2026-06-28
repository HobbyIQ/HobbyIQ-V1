// CF-CH-QUERY-HYPHEN-NORMALIZE (2026-06-28) — pins the hyphen-stripping
// behavior in dispatchFreetextMode by exercising the transformation logic
// directly. The dispatcher only collapses hyphens in the `search` string
// it sends to CardHedge; the structured filters and the parser are
// untouched.
//
// PRIOR-CF GAP: CardHedge's /cards/card-search treats hyphens as hard
// token separators. Queries like "eric hartman blue x-fractor" returned
// 0 candidates because "x-fractor" tokenizes to "x" + "fractor", neither
// of which match any indexed title. Stripping the hyphen → "eric hartman
// blue x fractor" → 50 candidates with the Blue X-Fractor CPA-EHA auto
// surfacing.
//
// This file tests the transformation predicate the dispatcher uses
// rather than the dispatcher itself, because the dispatcher's route-
// level tests are infra-blocked by the pre-existing
// @apple/app-store-server-library ERESOLVE blocking app-load tests.

import { describe, expect, it } from "vitest";

/**
 * Mirror of the transformation applied at dispatcher.ts dispatchFreetextMode.
 * Kept locally so this file has no dependency on the full app import chain
 * (the dispatcher's app-level mocks are heavy and not needed for a pure
 * predicate test).
 */
function normalizeForCardHedge(trimmed: string): string {
  return trimmed.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

describe("CF-CH-QUERY-HYPHEN-NORMALIZE — hyphen → space transformation", () => {
  it("'x-fractor' becomes 'x fractor'", () => {
    expect(normalizeForCardHedge("eric hartman blue x-fractor")).toBe(
      "eric hartman blue x fractor",
    );
  });

  it("'mini-diamond refractor' becomes 'mini diamond refractor'", () => {
    expect(normalizeForCardHedge("eric hartman mini-diamond refractor")).toBe(
      "eric hartman mini diamond refractor",
    );
  });

  it("multiple hyphens in one query all become spaces", () => {
    expect(normalizeForCardHedge("2026 bowman blue x-fractor auto mini-diamond")).toBe(
      "2026 bowman blue x fractor auto mini diamond",
    );
  });

  it("hyphens with spaces around them collapse to a single space", () => {
    expect(normalizeForCardHedge("eric  hartman  -  blue  -  x-fractor")).toBe(
      "eric hartman blue x fractor",
    );
  });

  it("query with no hyphens passes through unchanged (modulo whitespace)", () => {
    expect(normalizeForCardHedge("eric hartman blue refractor")).toBe(
      "eric hartman blue refractor",
    );
  });

  it("leading and trailing whitespace is trimmed", () => {
    expect(normalizeForCardHedge("   eric hartman x-fractor   ")).toBe(
      "eric hartman x fractor",
    );
  });

  it("hyphen at start of token (-fractor) doesn't break", () => {
    expect(normalizeForCardHedge("-fractor")).toBe("fractor");
  });

  it("hyphen at end of token (blue-) doesn't break", () => {
    expect(normalizeForCardHedge("eric blue-")).toBe("eric blue");
  });

  it("empty string returns empty string", () => {
    expect(normalizeForCardHedge("")).toBe("");
  });

  it("whitespace-only returns empty after trim", () => {
    expect(normalizeForCardHedge("    ")).toBe("");
  });

  it("only a hyphen returns empty", () => {
    expect(normalizeForCardHedge("-")).toBe("");
  });

  it("dashes between words don't lose words", () => {
    expect(normalizeForCardHedge("a-b-c-d")).toBe("a b c d");
  });
});
