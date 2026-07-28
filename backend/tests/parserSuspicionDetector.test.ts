// CF-PARSER-SUSPICION (Drew, 2026-07-28). Pins the rule so future
// regex tuning doesn't accidentally re-broaden the false-positive
// window ("Blue Jays" team names, "Gold Rush" event names, etc.).

import { describe, expect, it } from "vitest";
import { isParserProbablyWrong } from "../src/services/portfolioiq/parserSuspicionDetector.js";

describe("isParserProbablyWrong — flags likely parser misses", () => {
  it("Base + 'Blue Refractor' in title → true (Hartshorn-class miss)", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2026 Bowman Blue Refractor Eric Hartman #CPA-EHA True",
    })).toBe(true);
  });

  it("Base + 'Gold /50' in title → true (numbered variant miss)", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2026 Bowman Chrome Josiah Hartshorn Gold /50 Auto",
    })).toBe(true);
  });

  it("Base + 'Red X-Fractor' → true", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2025 Topps Chrome Red X-Fractor Judge",
    })).toBe(true);
  });

  it("Base + 'Green Shimmer' → true", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2026 Bowman Green Shimmer Refractor Auto Owen Carey",
    })).toBe(true);
  });
});

describe("isParserProbablyWrong — does NOT flag false positives", () => {
  it("Base + 'Blue Jays' (team name only, no context word) → false", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2024 Topps Series 1 Vladimir Guerrero Jr. Blue Jays #123",
    })).toBe(false);
  });

  it("Base + 'Red Sox' (team name only, no context word) → false", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2024 Topps Series 2 Rafael Devers Red Sox",
    })).toBe(false);
  });

  it("Base + no color word → false", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2024 Topps Series 1 Bobby Witt Jr.",
    })).toBe(false);
  });

  it("non-Base parallel (parser succeeded) → false", () => {
    expect(isParserProbablyWrong({
      parsedParallel: "Blue Refractor",
      title: "2026 Bowman Blue Refractor Auto",
    })).toBe(false);
  });

  it("null / undefined inputs → false (silent-safe)", () => {
    expect(isParserProbablyWrong({ parsedParallel: null, title: null })).toBe(false);
    expect(isParserProbablyWrong({ parsedParallel: undefined, title: undefined })).toBe(false);
    expect(isParserProbablyWrong({ parsedParallel: "Base", title: "" })).toBe(false);
  });

  it("case-insensitive but avoids matching within larger words", () => {
    // Not a false-positive we need to worry about, but pin the case-fold
    expect(isParserProbablyWrong({
      parsedParallel: "base",
      title: "2026 Bowman BLUE REFRACTOR Auto",
    })).toBe(true);
  });

  it("Base + 'Blue Jays' + AUTO (context) → true (still flags because we can't tell)", () => {
    // Team name PLUS a context word IS ambiguous — better to route to
    // verify than to persist as Base and be wrong. Pin this so the
    // rule stays honest about its limits.
    expect(isParserProbablyWrong({
      parsedParallel: "Base",
      title: "2024 Topps Autograph #1 Vladimir Guerrero Jr. Blue Jays",
    })).toBe(true);
  });
});
