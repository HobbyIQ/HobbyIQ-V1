// CF-PARALLEL-PREMIUM-FLOOR (2026-07-06) — pins print-run-informed
// minimum multipliers for known-rare parallels. Overrides the
// empirical calibration median when it under-represents hot-prospect
// market (concrete case: Orange Auto /25 median 4.4× → floor 15×).

import { describe, it, expect } from "vitest";
import {
  inferPrintRun,
  floorForPrintRun,
  applyPrintRunFloor,
} from "../src/services/compiq/parallelPremiumFloors.js";

describe("CF-PARALLEL-PREMIUM-FLOOR — inferPrintRun", () => {
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

  // CF-PADPARADSCHA-SHIMMER-FANIMATION (2026-07-09, Drew): add print-run
  // mappings for the exotic parallels that previously fell through with
  // no floor (parallelMultiplier=1 in production traces).
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

describe("CF-PARALLEL-PREMIUM-FLOOR — floorForPrintRun", () => {
  it("returns bigger floors for rarer parallels", () => {
    // 1/1 → 100×, /5 → 40×, /25 → 15×, /50 → 8×, /150 → 3×
    expect(floorForPrintRun(1)).toBe(100);
    expect(floorForPrintRun(5)).toBe(40);
    expect(floorForPrintRun(25)).toBe(15);
    expect(floorForPrintRun(50)).toBe(8);
    expect(floorForPrintRun(150)).toBe(3);
  });

  it("returns null for prints beyond the tiered range", () => {
    expect(floorForPrintRun(1000)).toBeNull();
    expect(floorForPrintRun(0)).toBeNull();
    expect(floorForPrintRun(-5)).toBeNull();
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

  it("Gold Prizm /10 gets the /10 floor (30×)", () => {
    const result = applyPrintRunFloor(3, "Gold Prizm");
    expect(result.effective).toBe(30);
    expect(result.inferredPrintRun).toBe(10);
  });

  it("Silver Prizm gets the /500 floor (1.5×) — modest but non-zero", () => {
    const result = applyPrintRunFloor(1, "Silver Prizm");
    expect(result.effective).toBe(1.5);
    expect(result.inferredPrintRun).toBe(500);
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

  it("applies the /5 tier floor of 40× regardless of spelling", () => {
    for (const spelling of ["Gum Ball Refractor", "Bubblegum", "Bubble Gum", "Snackpack"]) {
      const result = applyPrintRunFloor(1, spelling);
      expect(result.effective).toBe(40);
      expect(result.inferredPrintRun).toBe(5);
    }
  });
});

describe("CF-RETAIL-SNACKPACK-SIBLINGS — Peanuts / Sunflower Seeds /5", () => {
  it("recognizes Peanuts Refractor as /5 tier", () => {
    expect(inferPrintRun("Peanuts Refractor")).toBe(5);
    expect(inferPrintRun("Peanuts")).toBe(5);
    const r = applyPrintRunFloor(1, "Peanuts Refractor");
    expect(r.effective).toBe(40);
    expect(r.inferredPrintRun).toBe(5);
  });

  it("recognizes Sunflower Seeds Refractor as /5 tier", () => {
    expect(inferPrintRun("Sunflower Seeds Refractor")).toBe(5);
    expect(inferPrintRun("Sunflower Seeds")).toBe(5);
    const r = applyPrintRunFloor(1, "Sunflower Seeds Refractor");
    expect(r.effective).toBe(40);
  });
});

describe("CF-BOWMAN-LOGOFRACTOR — /35 new tier", () => {
  it("recognizes Bowman Logofractor as /35", () => {
    expect(inferPrintRun("Bowman Logofractor")).toBe(35);
    expect(inferPrintRun("Logofractor")).toBe(35);
    expect(inferPrintRun("Logo Fractor")).toBe(35);
  });

  it("applies 12× floor for /35 tier", () => {
    const r = applyPrintRunFloor(1, "Bowman Logofractor");
    expect(r.effective).toBe(12);
    expect(r.inferredPrintRun).toBe(35);
  });
});

describe("CF-BOWMAN-COLOR-AUTOS-BATCH-3 — single-color Bowman auto print runs", () => {
  it("Green auto → /99 tier → 4× floor", () => {
    expect(inferPrintRun("Green")).toBe(99);
    const r = applyPrintRunFloor(1, "Green");
    expect(r.effective).toBe(4);
    expect(r.inferredPrintRun).toBe(99);
  });

  it("Purple auto → /250 tier → 2× floor", () => {
    expect(inferPrintRun("Purple")).toBe(250);
    const r = applyPrintRunFloor(1, "Purple");
    expect(r.effective).toBe(2);
    expect(r.inferredPrintRun).toBe(250);
  });

  it("Green Prizm still returns Panini /500 (no cross-brand collision)", () => {
    expect(inferPrintRun("Green Prizm")).toBe(500);
  });

  it("Green Refractor still returns Bowman /499 (no self-collision)", () => {
    expect(inferPrintRun("Green Refractor")).toBe(499);
    expect(inferPrintRun("Green X-Fractor")).toBe(499);
  });
});

describe("CF-MINI-DIAMOND — /100 tier", () => {
  it("recognizes Mini Diamond and Mini-Diamond spellings", () => {
    expect(inferPrintRun("Mini Diamond")).toBe(100);
    expect(inferPrintRun("Mini-Diamond")).toBe(100);
    expect(inferPrintRun("Mini Diamond Refractor")).toBe(100);
    expect(inferPrintRun("Mini-Diamond Refractor")).toBe(100);
  });

  it("applies 4× floor for /100 tier", () => {
    const r = applyPrintRunFloor(1, "Mini-Diamond Refractor");
    expect(r.effective).toBe(4);
    expect(r.inferredPrintRun).toBe(100);
  });
});

describe("CF-SPARKLE-SPECKLE — /299 tier retail parallels", () => {
  it("Sparkle → /299 tier → 1.8× floor", () => {
    expect(inferPrintRun("Sparkle")).toBe(299);
    expect(inferPrintRun("Sparkle Refractor")).toBe(299);
    const r = applyPrintRunFloor(1, "Sparkle Refractor");
    expect(r.effective).toBe(1.8);
    expect(r.inferredPrintRun).toBe(299);
  });

  it("Speckle → /299 tier → 1.8× floor", () => {
    expect(inferPrintRun("Speckle")).toBe(299);
    expect(inferPrintRun("Speckle Refractor")).toBe(299);
    const r = applyPrintRunFloor(1, "Speckle Refractor");
    expect(r.effective).toBe(1.8);
    expect(r.inferredPrintRun).toBe(299);
  });
});

describe("CF-BLACK-XFRACTOR — /10 tier via 30× floor", () => {
  it("recognizes Black X-Fractor and Black Refractor as /10", () => {
    expect(inferPrintRun("Black X-Fractor")).toBe(10);
    expect(inferPrintRun("Black XFractor")).toBe(10);
    expect(inferPrintRun("Black Refractor")).toBe(10);
    expect(inferPrintRun("Black")).toBe(10);
  });

  it("applies 30× floor for /10 tier (Black X-Fractor)", () => {
    const r = applyPrintRunFloor(1, "Black X-Fractor");
    expect(r.effective).toBe(30);
    expect(r.inferredPrintRun).toBe(10);
  });

  it("does NOT collide with Black Prizm (which is Panini /1)", () => {
    // Black Prizm hits the Panini rule earlier in the list → /1
    expect(inferPrintRun("Black Prizm")).toBe(1);
  });
});

describe("CF-PARALLEL-PREMIUM-FLOOR — applyPrintRunFloor", () => {
  it("lifts to floor when empirical is below (Willits Orange Auto case)", () => {
    // Empirical median 4.364 (from 2025 Bowman Chrome Prospects Orange
    // Auto calibration) is well below the /25 tier floor of 15.
    const result = applyPrintRunFloor(4.364, "Orange");
    expect(result.effective).toBe(15);
    expect(result.flooredFrom).toBeCloseTo(4.364, 2);
    expect(result.inferredPrintRun).toBe(25);
  });

  it("passes empirical through when it exceeds the floor (hot calibration)", () => {
    // If Orange Auto calibration came in at 25× (higher than 15× floor),
    // trust the empirical — cool players' market is closer to the floor,
    // hot markets deserve the real observed premium.
    const result = applyPrintRunFloor(25, "Orange");
    expect(result.effective).toBe(25);
    expect(result.flooredFrom).toBeNull();
    expect(result.inferredPrintRun).toBe(25);
  });

  it("passes through unchanged when parallel is unknown (no tiered floor)", () => {
    const result = applyPrintRunFloor(3.5, "Base");
    expect(result.effective).toBe(3.5);
    expect(result.flooredFrom).toBeNull();
    expect(result.inferredPrintRun).toBeNull();
  });

  it("Superfractor gets the 1/1 floor of 100×", () => {
    const result = applyPrintRunFloor(50, "Superfractor");
    expect(result.effective).toBe(100);
    expect(result.flooredFrom).toBe(50);
    expect(result.inferredPrintRun).toBe(1);
  });

  it("Blue /150 with an underweight calibration (say 1.2×) lifts to 3×", () => {
    const result = applyPrintRunFloor(1.2, "Blue Refractor");
    expect(result.effective).toBe(3);
    expect(result.flooredFrom).toBeCloseTo(1.2, 2);
    expect(result.inferredPrintRun).toBe(150);
  });
});
