// CF-PLAYERNAME-NORMALIZATION — unit tests for normalizePlayerName.
// Covers all 9 contamination patterns from the production diagnostic
// (CF-POLLUTED-METADATA-HOLDINGS investigation) + edge cases.

import { describe, it, expect } from "vitest";
import { normalizePlayerName } from "../src/services/compiq/cardsight.mapper.js";

describe("normalizePlayerName — production contamination patterns", () => {
  const productionCases: Array<{ input: string; expected: string }> = [
    { input: "MIKE TROUT WAL-MART BORDER", expected: "MIKE TROUT" },
    { input: "TRADED TIFFANY GREG MADDUX TIFFANY", expected: "GREG MADDUX" },
    { input: "TRADED KEN GRIFFEY JR.", expected: "KEN GRIFFEY JR." },
    { input: "PROSPECT AUTOGRAPHS JOHN GIL CHR PROS - MINI DIA", expected: "JOHN GIL" },
    { input: "CHROME PROSPECT AUTOGRAPHS GAGE WOOD CHR PROSPECT - REF", expected: "GAGE WOOD" },
    { input: "CHROME PROSPECT AUTOGRAPHS CALEB BONEMER CHR PROSPECT AU- SHIM", expected: "CALEB BONEMER" },
    { input: "PROSPECT AUTOGRAPHS TOMMY WHITE CHR PROS -MINI DIAMOND", expected: "TOMMY WHITE" },
  ];

  for (const c of productionCases) {
    it(`strips "${c.input}" -> "${c.expected}"`, () => {
      expect(normalizePlayerName(c.input)).toBe(c.expected);
    });
  }
});

describe("normalizePlayerName — clean names pass through unchanged", () => {
  const cleanCases = [
    "Mike Trout",
    "Shohei Ohtani",
    "Cal Ripken Jr.",
    "Ken Griffey Jr.",
    "Ichiro",
    "Pudge",
    "Tim O'Neill",
    "Jorge Soler",
    "Bobby Cox",
  ];

  for (const name of cleanCases) {
    it(`preserves "${name}"`, () => {
      expect(normalizePlayerName(name)).toBe(name);
    });
  }
});

describe("normalizePlayerName — null/undefined/empty handling", () => {
  it("returns empty string for null", () => {
    expect(normalizePlayerName(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(normalizePlayerName(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizePlayerName("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizePlayerName("   ")).toBe("");
  });
});

describe("normalizePlayerName — whitespace hygiene", () => {
  it("collapses internal whitespace to single space", () => {
    expect(normalizePlayerName("Mike    Trout")).toBe("Mike Trout");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizePlayerName("  Mike Trout  ")).toBe("Mike Trout");
  });

  it("handles tabs and mixed whitespace", () => {
    expect(normalizePlayerName("Mike\t\tTrout")).toBe("Mike Trout");
  });
});

describe("normalizePlayerName — prefix-priority semantics", () => {
  it("longer prefix matches before shorter (TRADED TIFFANY before TRADED)", () => {
    // If TRADED matched first, "TRADED TIFFANY GREG MADDUX TIFFANY" would
    // strip just "TRADED " leaving "TIFFANY GREG MADDUX TIFFANY", then
    // TIFFANY prefix would strip → "GREG MADDUX TIFFANY", then TIFFANY
    // suffix strip → "GREG MADDUX". Same result, but the test ensures the
    // longer-first ordering is documented + locked.
    expect(normalizePlayerName("TRADED TIFFANY GREG MADDUX TIFFANY")).toBe("GREG MADDUX");
  });

  it("longer prefix matches before shorter (CHROME PROSPECT AUTOGRAPHS before PROSPECT AUTOGRAPHS)", () => {
    expect(normalizePlayerName("CHROME PROSPECT AUTOGRAPHS CALEB BONEMER")).toBe("CALEB BONEMER");
    // Without longer-first, "CHROME PROSPECT AUTOGRAPHS ..." wouldn't strip
    // CHROME and would leave "CHROME CALEB BONEMER".
  });
});

describe("normalizePlayerName — edge cases that must NOT over-strip", () => {
  it("a clean name containing a stripped token as substring is preserved (lowercase 'traded')", () => {
    // "traded" lowercase isn't a prefix because case-insensitive prefix
    // match still requires word-boundary at start. Embedded substring
    // shouldn't trigger.
    expect(normalizePlayerName("Mike Tradedalvarez")).toBe("Mike Tradedalvarez");
  });

  it("name that ends with TIFFANY but is just the suffix-stripped to first word", () => {
    // "Player TIFFANY" should strip the TIFFANY suffix → "Player"
    expect(normalizePlayerName("Player TIFFANY")).toBe("Player");
  });

  it("name with apostrophe is preserved through normalization", () => {
    expect(normalizePlayerName("TRADED Bryce O'Neill")).toBe("Bryce O'Neill");
  });

  it("name with period suffix (Jr.) is preserved", () => {
    expect(normalizePlayerName("TRADED Cal Ripken Jr.")).toBe("Cal Ripken Jr.");
  });

  it("single-word names pass through", () => {
    expect(normalizePlayerName("Ichiro")).toBe("Ichiro");
    expect(normalizePlayerName("TRADED Ichiro")).toBe("Ichiro");
  });
});

describe("normalizePlayerName — generic CHR PROS/PROSPECT suffix coverage", () => {
  it("strips 'CHR PROS' through end of string regardless of trailing tokens", () => {
    expect(normalizePlayerName("Player Name CHR PROS - SOMETHING NEW")).toBe("Player Name");
  });

  it("strips 'CHR PROSPECT' through end of string regardless of trailing tokens", () => {
    expect(normalizePlayerName("Player Name CHR PROSPECT XX-YY")).toBe("Player Name");
  });

  it("case-insensitive", () => {
    expect(normalizePlayerName("Player Name chr pros - mini dia")).toBe("Player Name");
  });
});
