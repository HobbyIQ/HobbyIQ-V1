// CF-VARIANT-TIER-CALIBRATION-FROM-SALES (2026-07-04): unit tests locking the
// tier map against the empirical calibration from scratchpad/calibrate_deep.mjs
// (15 auto families with base n≥3, 210 parallel probes via /cards/comps).
//
// Each test asserts the tier returned for a real variant string. When tiers
// drift from the calibrated values, the tests fail loudly.

import { describe, it, expect } from "vitest";
import { autoProjectVariantTier } from "../src/routes/compiq.routes";

describe("autoProjectVariantTier — data-backed tier map", () => {
  it("returns 1 for base / empty / unknown variants (safe fallback)", () => {
    expect(autoProjectVariantTier("Base")).toBe(1);
    expect(autoProjectVariantTier("")).toBe(1);
    expect(autoProjectVariantTier(null)).toBe(1);
    expect(autoProjectVariantTier(undefined)).toBe(1);
    expect(autoProjectVariantTier(12345)).toBe(1);
    expect(autoProjectVariantTier("Some Fictional Parallel")).toBe(1);
  });

  it("keeps Superfractor / 1-of-1 at the top (35×)", () => {
    expect(autoProjectVariantTier("Superfractor")).toBe(35);
    expect(autoProjectVariantTier("Superfractor /1")).toBe(35);
    expect(autoProjectVariantTier("Red 1/1")).toBe(35);
  });

  describe("Black variants — calibrated as top-tier below superfractor", () => {
    it("black refractor → 21 (n=2, p50=21.31)", () => {
      expect(autoProjectVariantTier("Black Refractor")).toBe(21);
      expect(autoProjectVariantTier("Black X-Fractor")).toBe(21);
    });
    it("plain black → 19 (n=2, p50=18.75)", () => {
      expect(autoProjectVariantTier("Black")).toBe(19);
    });
  });

  describe("Orange variants — high tier, finish-dependent", () => {
    it("orange shimmer / refractor / x-fractor → 12 (n=2, p50=12.25)", () => {
      expect(autoProjectVariantTier("Orange Shimmer Refractor")).toBe(12);
      expect(autoProjectVariantTier("Orange Refractor")).toBe(12);
    });
    it("orange wave / lava → 10 (n=2, p50=10.26)", () => {
      expect(autoProjectVariantTier("Orange Wave")).toBe(10);
      expect(autoProjectVariantTier("Orange Lava")).toBe(10);
    });
    it("plain orange → 6 (n=3, p50=5.98)", () => {
      expect(autoProjectVariantTier("Orange")).toBe(6);
    });
  });

  describe("Gold variants — mid-high tier", () => {
    it("gold refractor / x-fractor / shimmer / wave / lava → 9 (n=1 refractor p50=9.9, n=2 shimmer p50=9.4)", () => {
      expect(autoProjectVariantTier("Gold Refractor")).toBe(9);
      expect(autoProjectVariantTier("Gold Shimmer")).toBe(9);
      expect(autoProjectVariantTier("Gold Wave")).toBe(9);
      expect(autoProjectVariantTier("Gold Lava Refractor")).toBe(9);
    });
    it("gold shimmer refractor combo → 6 (n=2, p50=5.84)", () => {
      expect(autoProjectVariantTier("Gold Shimmer Refractor")).toBe(6);
    });
    it("plain gold → 7", () => {
      expect(autoProjectVariantTier("Gold")).toBe(7);
    });
  });

  describe("LogoFractor — held at 8× (single sample p50=7)", () => {
    it("logofractor / logo fractor / bowman logofractor → 8", () => {
      expect(autoProjectVariantTier("Bowman LogoFractor")).toBe(8);
      expect(autoProjectVariantTier("Logo Fractor")).toBe(8);
      expect(autoProjectVariantTier("LogoFractor")).toBe(8);
    });
  });

  describe("Blue variants — calibrated mid-tier", () => {
    it("blue refractor → 5 (n=1, p50=5.21)", () => {
      expect(autoProjectVariantTier("Blue Refractor")).toBe(5);
    });
    it("blue x-fractor / wave / shimmer → 3.5 (n=1 xfrac p50=3.6, n=2 wave p50=3.5)", () => {
      expect(autoProjectVariantTier("Blue X-Fractor")).toBe(3.5);
      expect(autoProjectVariantTier("Blue Wave Refractor")).toBe(3.5);
    });
    it("plain blue → 2.5 (n=4, p50=2.40)", () => {
      expect(autoProjectVariantTier("Blue")).toBe(2.5);
    });
  });

  describe("Green variants — mid-tier", () => {
    it("green refractor / x-fractor / grass → 4 (n=2 refractor p50=3.90, n=1 grass 3.89)", () => {
      expect(autoProjectVariantTier("Green Refractor")).toBe(4);
      expect(autoProjectVariantTier("Green Grass Refractor")).toBe(4);
    });
    it("green lava / wave / shimmer / reptilian → 3 (n=5 lava-refract p50=3.00 — high confidence)", () => {
      expect(autoProjectVariantTier("Green Lava Refractor")).toBe(3);
      expect(autoProjectVariantTier("Green Shimmer Refractor")).toBe(3);
      expect(autoProjectVariantTier("Green Reptilian Refractor")).toBe(3);
    });
    it("plain green → 2.5", () => {
      expect(autoProjectVariantTier("Green")).toBe(2.5);
    });
  });

  describe("Purple — high confidence at 2.3× (n=6)", () => {
    it("purple refractor / x-fractor → 2.3", () => {
      expect(autoProjectVariantTier("Purple Refractor")).toBe(2.3);
      expect(autoProjectVariantTier("Purple X-Fractor")).toBe(2.3);
    });
    it("plain purple → 2", () => {
      expect(autoProjectVariantTier("Purple")).toBe(2);
    });
  });

  describe("Small-color / specialty parallels", () => {
    it("aqua lava refractor → 2.5 (n=4, p50=2.45)", () => {
      expect(autoProjectVariantTier("Aqua Lava Refractor")).toBe(2.5);
    });
    it("hta choice refractor → 2 (n=4, p50=2.12)", () => {
      expect(autoProjectVariantTier("HTA Choice Refractor")).toBe(2);
    });
    it("mini-diamond refractor → 2.5 (n=1 p50=3.25, n=2 base p50=2.13; midpoint)", () => {
      expect(autoProjectVariantTier("Mini-Diamond Refractor")).toBe(2.5);
      expect(autoProjectVariantTier("Mini Diamond")).toBe(2.5);
    });
    it("speckle refractor → 2.3 (n=1, p50=2.32)", () => {
      expect(autoProjectVariantTier("Speckle Refractor")).toBe(2.3);
    });
  });

  describe("Generic refractor / X-fractor / Prizm — bumped from 1.3× to 2× (n=14 p50=1.91)", () => {
    it("plain refractor → 2", () => {
      expect(autoProjectVariantTier("Refractor")).toBe(2);
      expect(autoProjectVariantTier("Chrome Refractor")).toBe(2);
    });
    it("x-fractor / prizm → 2", () => {
      expect(autoProjectVariantTier("X-Fractor")).toBe(2);
      expect(autoProjectVariantTier("Prizm")).toBe(2);
    });
  });

  describe("Yellow variants", () => {
    it("yellow refractor / x-fractor → 4 (n=1 each, p50=3.8-4)", () => {
      expect(autoProjectVariantTier("Yellow Refractor")).toBe(4);
      expect(autoProjectVariantTier("Yellow X-Fractor")).toBe(4);
    });
    it("plain yellow → 3", () => {
      expect(autoProjectVariantTier("Yellow")).toBe(3);
    });
  });

  it("colorless shimmer / lava / geometric → 1.5 (safe fallback)", () => {
    expect(autoProjectVariantTier("Shimmer")).toBe(1.5);
    expect(autoProjectVariantTier("Geometric")).toBe(1.5);
    expect(autoProjectVariantTier("Lava Refractor")).toBe(2); // "refractor" wins first
    // "Wave Refractor" without color grabs the generic refractor rule (n=14
    // p50=1.91 → tier 2). That's the right anchor for an unqualified wave —
    // the wave is a finish, refractor dominates the price signal.
    expect(autoProjectVariantTier("Wave Refractor")).toBe(2);
  });

  it("case-insensitive matching", () => {
    expect(autoProjectVariantTier("BOWMAN LOGOFRACTOR")).toBe(8);
    expect(autoProjectVariantTier("purple refractor")).toBe(2.3);
    expect(autoProjectVariantTier("Black Refractor /5")).toBe(21);
  });
});
