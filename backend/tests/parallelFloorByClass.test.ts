// CF-PARALLEL-FLOOR-NON-AUTO-MULTIPLIER (2026-07-09, Drew — Owen Carey
// Black BCP-69) unit tests for the class-aware floor helper.

import { describe, it, expect } from "vitest";
import {
  floorForPrintRun,
  floorForPrintRunByClass,
} from "../src/services/compiq/parallelPremiumFloors";

describe("floorForPrintRunByClass — class-aware print-run floor", () => {
  it("auto class returns the same floor as floorForPrintRun (backward compat)", () => {
    for (const pr of [1, 5, 10, 25, 50, 99, 150, 250, 299]) {
      expect(floorForPrintRunByClass(pr, "auto")).toBe(floorForPrintRun(pr));
    }
  });

  it("base class bumps the /10 floor to non-auto hobby-consensus (~54× vs 30× auto)", () => {
    // Auto /10: 30× — calibrated for auto SKUs ($50-100 base auto × 30 = $1500-3000)
    // Base /10: 1.8× the auto floor = 54× — Drew's calibration for non-auto Black /10:
    //   Owen Carey base BCP-69 median $1.85 × 54 = $99.90 (~ hobby-consensus $100+)
    expect(floorForPrintRunByClass(10, "auto")).toBe(30);
    expect(floorForPrintRunByClass(10, "base")).toBe(54);
  });

  it("base class bumps /5 to non-auto tier (40× → 72×)", () => {
    expect(floorForPrintRunByClass(5, "auto")).toBe(40);
    expect(floorForPrintRunByClass(5, "base")).toBe(72);
  });

  it("base class bumps /1 to non-auto tier (100× → 180×)", () => {
    expect(floorForPrintRunByClass(1, "auto")).toBe(100);
    expect(floorForPrintRunByClass(1, "base")).toBe(180);
  });

  it("base class bumps /25 to non-auto tier (15× → 27×)", () => {
    expect(floorForPrintRunByClass(25, "auto")).toBe(15);
    expect(floorForPrintRunByClass(25, "base")).toBe(27);
  });

  it("returns null for unmapped print runs (both classes)", () => {
    // > 500 is off the tier ladder
    expect(floorForPrintRunByClass(9999, "auto")).toBeNull();
    expect(floorForPrintRunByClass(9999, "base")).toBeNull();
  });

  it("returns null for invalid inputs (both classes)", () => {
    expect(floorForPrintRunByClass(0, "base")).toBeNull();
    expect(floorForPrintRunByClass(-1, "auto")).toBeNull();
    expect(floorForPrintRunByClass(NaN, "base")).toBeNull();
  });
});
