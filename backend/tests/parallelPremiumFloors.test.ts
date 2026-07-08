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
