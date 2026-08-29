// Print-run inference by parallel NAME. This file used to pin
// CF-PARALLEL-PREMIUM-FLOOR as well — the hobby-consensus minimum
// multipliers by print-run tier (Orange /25 = 15x, Gold /50 = 8x, ...).
// D4 PR 5 (2026-08-29) deleted that table and every function that read it
// (floorForPrintRun, floorForPrintRunByClass, applyPrintRunFloor): a
// multiplier is a measurement (empiricalParallelPremium.ts) or it does not
// exist. What remains here is a scarcity GUESS by name — never a price.

import { describe, it, expect } from "vitest";
import * as floors from "../src/services/compiq/parallelPremiumFloors.js";
import { inferPrintRun } from "../src/services/compiq/parallelPremiumFloors.js";

describe("D4 PR 5 — the hobby-consensus floor table is gone", () => {
  it("exports no multiplier function, only the print-run guess", () => {
    const exported = Object.keys(floors).sort();
    expect(exported).toEqual(["inferPrintRun"]);
  });
});

describe("inferPrintRun — parallel name to print run", () => {
  it("maps common Bowman/Topps parallel names to their print runs", () => {
    expect(inferPrintRun("Superfractor")).toBe(1);
    expect(inferPrintRun("Red Refractor")).toBe(5);
    expect(inferPrintRun("Orange")).toBe(25);
    expect(inferPrintRun("Orange X-Fractor")).toBe(25);
    expect(inferPrintRun("Gold Refractor")).toBe(50);
    expect(inferPrintRun("Blue X-Fractor")).toBe(150);
  });

  it("returns null for unknown parallel names", () => {
    expect(inferPrintRun("Base")).toBeNull();
    expect(inferPrintRun("")).toBeNull();
    expect(inferPrintRun("Some Custom Parallel")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(inferPrintRun("ORANGE")).toBe(25);
    expect(inferPrintRun("orange")).toBe(25);
    expect(inferPrintRun("Orange")).toBe(25);
  });

  // CF-PADPARADSCHA-SHIMMER-FANIMATION (2026-07-09, Drew): print-run
  // mappings for the exotic parallels.
  it("recognizes Padparadscha as 1/1 (Drew correction 2026-07-09)", () => {
    expect(inferPrintRun("Padparadscha")).toBe(1);
    expect(inferPrintRun("Padparadscha Sapphire")).toBe(1);
  });

  it("recognizes Fanimation as /5 tier", () => {
    expect(inferPrintRun("Fanimation")).toBe(5);
    expect(inferPrintRun("Bowman Fanimation")).toBe(5);
  });

  it("recognizes color-specific Shimmer Refractor tiers", () => {
    expect(inferPrintRun("Red Shimmer Refractor")).toBe(5);
    expect(inferPrintRun("Gold Shimmer Refractor")).toBe(50);
    expect(inferPrintRun("Green Shimmer Refractor")).toBe(99);
    expect(inferPrintRun("Blue Shimmer Refractor")).toBe(75);
    expect(inferPrintRun("Aqua Shimmer Refractor")).toBe(75);
    expect(inferPrintRun("Sky Blue Shimmer Refractor")).toBe(75);
  });

  it("bare 'Shimmer Refractor' falls to the /50 middle-ground tier", () => {
    expect(inferPrintRun("Shimmer Refractor")).toBe(50);
    expect(inferPrintRun("Shimmer")).toBe(50);
  });

  it("Orange Shimmer stays at /10 (non-regression on the pre-existing rule)", () => {
    expect(inferPrintRun("Orange Shimmer")).toBe(10);
  });
});

describe("CF-PANINI-PRIZM-COVERAGE — Panini parallel names map to print runs", () => {
  it("recognizes Panini Prizm's numbered rare parallels", () => {
    expect(inferPrintRun("Nebula Prizm")).toBe(1);
    expect(inferPrintRun("Black Finite")).toBe(1);
    expect(inferPrintRun("Gold Prizm")).toBe(10);
    expect(inferPrintRun("Camo Prizm")).toBe(25);
    expect(inferPrintRun("Mojo Prizm")).toBe(25);
    expect(inferPrintRun("Blue Ice")).toBe(75);
    expect(inferPrintRun("Purple Prizm")).toBe(75);
    expect(inferPrintRun("Red Prizm")).toBe(299);
    expect(inferPrintRun("Silver Prizm")).toBe(500);
    expect(inferPrintRun("Hyper Prizm")).toBe(275);
  });
});

describe("CF-GUM-BALL-BUBBLEGUM — snackpack /5 parallel + hobby aliases", () => {
  it("recognizes all four common spellings and maps them to /5 tier", () => {
    expect(inferPrintRun("Gum Ball")).toBe(5);
    expect(inferPrintRun("Gum Ball Refractor")).toBe(5);
    expect(inferPrintRun("Bubblegum")).toBe(5);
    expect(inferPrintRun("Bubble Gum")).toBe(5);
    expect(inferPrintRun("Snackpack")).toBe(5);
  });
});

describe("CF-RETAIL-SNACKPACK-SIBLINGS — Peanuts / Sunflower Seeds /5", () => {
  it("recognizes Peanuts Refractor as /5 tier", () => {
    expect(inferPrintRun("Peanuts Refractor")).toBe(5);
    expect(inferPrintRun("Peanuts")).toBe(5);
  });

  it("recognizes Sunflower Seeds Refractor as /5 tier", () => {
    expect(inferPrintRun("Sunflower Seeds Refractor")).toBe(5);
    expect(inferPrintRun("Sunflower Seeds")).toBe(5);
  });
});

describe("CF-BOWMAN-LOGOFRACTOR — /35", () => {
  it("recognizes Bowman Logofractor as /35", () => {
    expect(inferPrintRun("Bowman Logofractor")).toBe(35);
    expect(inferPrintRun("Logofractor")).toBe(35);
    expect(inferPrintRun("Logo Fractor")).toBe(35);
  });
});

describe("CF-BOWMAN-COLOR-AUTOS-BATCH-3 — single-color Bowman auto print runs", () => {
  it("Green auto → /99", () => {
    expect(inferPrintRun("Green")).toBe(99);
  });

  it("Purple auto → /250", () => {
    expect(inferPrintRun("Purple")).toBe(250);
  });

  it("Green Prizm still returns Panini /500 (no cross-brand collision)", () => {
    expect(inferPrintRun("Green Prizm")).toBe(500);
  });

  it("Green Refractor still returns Bowman /499 (no self-collision)", () => {
    expect(inferPrintRun("Green Refractor")).toBe(499);
    expect(inferPrintRun("Green X-Fractor")).toBe(499);
  });
});

describe("CF-MINI-DIAMOND — /100", () => {
  it("recognizes Mini Diamond and Mini-Diamond spellings", () => {
    expect(inferPrintRun("Mini Diamond")).toBe(100);
    expect(inferPrintRun("Mini-Diamond")).toBe(100);
    expect(inferPrintRun("Mini Diamond Refractor")).toBe(100);
    expect(inferPrintRun("Mini-Diamond Refractor")).toBe(100);
  });
});

describe("CF-SPARKLE-SPECKLE — /299 retail parallels", () => {
  it("Sparkle → /299", () => {
    expect(inferPrintRun("Sparkle")).toBe(299);
    expect(inferPrintRun("Sparkle Refractor")).toBe(299);
  });

  it("Speckle → /299", () => {
    expect(inferPrintRun("Speckle")).toBe(299);
    expect(inferPrintRun("Speckle Refractor")).toBe(299);
  });
});

describe("CF-BLACK-XFRACTOR — /10", () => {
  it("recognizes Black X-Fractor and Black Refractor as /10", () => {
    expect(inferPrintRun("Black X-Fractor")).toBe(10);
    expect(inferPrintRun("Black XFractor")).toBe(10);
    expect(inferPrintRun("Black Refractor")).toBe(10);
    expect(inferPrintRun("Black")).toBe(10);
  });

  it("does NOT collide with Black Prizm (which is Panini /1)", () => {
    // Black Prizm hits the Panini rule earlier in the list → /1
    expect(inferPrintRun("Black Prizm")).toBe(1);
  });
});
