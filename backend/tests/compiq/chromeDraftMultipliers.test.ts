import { describe, it, expect } from "vitest";
import {
  CHROME_DRAFT_MULTIPLIERS,
  CHROME_DRAFT_ENTRY_COUNT,
  BOWMAN_2022_FAMILY_ENTRIES,
  lookupBowmanFamilyEntry,
  lookupBowmanFamilyByProduct,
  lookupMultiplier,
  getColorTier,
} from "../../src/services/compiq/chromeDraftMultipliers.js";

describe("chromeDraftMultipliers — spot-check baseline values", () => {
  it("Base Auto = 1.000 baseMultiplier", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Base Auto"].baseMultiplier).toBe(1.0);
    expect(CHROME_DRAFT_MULTIPLIERS["Base Auto"].refractorMultiplier).toBeCloseTo(0.455, 3);
  });

  it("Refractor = 2.200 / 1.000", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Refractor"].baseMultiplier).toBe(2.2);
    expect(CHROME_DRAFT_MULTIPLIERS["Refractor"].refractorMultiplier).toBe(1.0);
  });

  it("Blue /150 = 3.120 baseMultiplier (CF-WORKSHEET-CALIBRATION 2026-06-29)", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Blue"].baseMultiplier).toBe(3.12);  // CF-WORKSHEET-CALIBRATION 2026-06-29: was 5.7
    expect(CHROME_DRAFT_MULTIPLIERS["Blue"].printRun).toBe("/150");
  });

  it("Gold /50 = 14.500 baseMultiplier", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Gold"].baseMultiplier).toBe(14.5);
  });

  it("Orange /25 = 9.596 baseMultiplier (CF-WORKSHEET-CALIBRATION 2026-06-29)", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Orange"].baseMultiplier).toBe(9.596);  // CF-WORKSHEET-CALIBRATION 2026-06-29: was 21.9
  });

  it("Red /5 = 22.790 baseMultiplier (CF-WORKSHEET-CALIBRATION 2026-06-29)", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Red"].baseMultiplier).toBe(22.79);  // CF-WORKSHEET-CALIBRATION 2026-06-29: was 55.0
  });

  it("Superfractor 1/1 = 125.000 baseMultiplier", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Superfractor"].baseMultiplier).toBe(125.0);
  });

  it("HTA Choice Red = 45.000 baseMultiplier", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["HTA Choice Red"].baseMultiplier).toBe(45.0);
  });

  it("Speckle /299 = 2.700 (Early Color)", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Speckle"].baseMultiplier).toBe(2.7);
    expect(CHROME_DRAFT_MULTIPLIERS["Speckle"].colorTier).toBe("Early Color");
  });

  it("Atomic /100 = 4.200 (Atomic Tier)", () => {
    expect(CHROME_DRAFT_MULTIPLIERS["Atomic"].baseMultiplier).toBe(4.2);
    expect(CHROME_DRAFT_MULTIPLIERS["Atomic"].colorTier).toBe("Atomic Tier");
  });
});

describe("chromeDraftMultipliers — lookupMultiplier edge cases", () => {
  it("unknown parallel name returns null", () => {
    expect(lookupMultiplier("Rainbow Foil")).toBeNull();
    expect(lookupMultiplier("Pink Diamond")).toBeNull();
  });

  it("null / undefined / empty input returns null", () => {
    expect(lookupMultiplier(null)).toBeNull();
    expect(lookupMultiplier(undefined)).toBeNull();
    expect(lookupMultiplier("")).toBeNull();
    expect(lookupMultiplier("   ")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(lookupMultiplier("blue")?.baseMultiplier).toBe(3.12);
    expect(lookupMultiplier("BLUE")?.baseMultiplier).toBe(3.12);
    expect(lookupMultiplier("Gold")?.baseMultiplier).toBe(14.5);
    expect(lookupMultiplier("gold sapphire")?.baseMultiplier).toBe(10.9);
  });

  it("tolerates extra whitespace and mixed casing", () => {
    expect(lookupMultiplier("  Blue  ")?.baseMultiplier).toBe(3.12);
    expect(lookupMultiplier("blue   sapphire")?.baseMultiplier).toBe(5.2);
  });

  it("strips trailing 'Refractor' for color parallels", () => {
    expect(lookupMultiplier("Blue Refractor")?.parallelName).toBe("Blue");
    expect(lookupMultiplier("Gold Refractor")?.parallelName).toBe("Gold");
    expect(lookupMultiplier("Red Refractor")?.parallelName).toBe("Red");
  });

  it("strips Auto / Autograph suffix", () => {
    expect(lookupMultiplier("Blue Auto")?.parallelName).toBe("Blue");
    expect(lookupMultiplier("Gold Autograph")?.parallelName).toBe("Gold");
    expect(lookupMultiplier("Blue Refractor Auto")?.parallelName).toBe("Blue");
  });
});

describe("chromeDraftMultipliers — getColorTier classification", () => {
  it("Base anchors classified as Base", () => {
    expect(getColorTier("Base Auto")).toBe("Base");
    expect(getColorTier("Refractor")).toBe("Base");
  });

  it("Blue family classified as Blue Tier", () => {
    expect(getColorTier("Blue")).toBe("Blue Tier");
    expect(getColorTier("Blue Wave")).toBe("Blue Tier");
    expect(getColorTier("Blue Sapphire")).toBe("Blue Tier");
  });

  it("Superfractor classified as 1/1 Tier", () => {
    expect(getColorTier("Superfractor")).toBe("1/1 Tier");
  });

  it("HTA family classified as HTA", () => {
    expect(getColorTier("HTA Choice Gold")).toBe("HTA");
    expect(getColorTier("HTA Choice Red")).toBe("HTA");
  });
});

describe("chromeDraftMultipliers — table integrity", () => {
  it("has all 54 owner-table entries", () => {
    expect(CHROME_DRAFT_ENTRY_COUNT).toBe(54);
    expect(Object.keys(CHROME_DRAFT_MULTIPLIERS).length).toBe(54);
  });

  it("includes additive 2022 Bowman family entries", () => {
    expect(BOWMAN_2022_FAMILY_ENTRIES.length).toBeGreaterThan(54);
  });
});

describe("chromeDraftMultipliers — 2022 Bowman family lookups", () => {
  it("supports strict subset lookups", () => {
    const e = lookupBowmanFamilyEntry({
      product: "Bowman Draft",
      subset: "Chrome Prospect Autographs",
      parallelName: "Aqua Refractor",
    });
    expect(e).not.toBeNull();
    expect(e?.subset).toBe("Chrome Prospect Autographs");
  });

  it("enforces subset non-existence", () => {
    const e = lookupBowmanFamilyEntry({
      product: "Bowman Chrome",
      subset: "Chrome Base",
      parallelName: "Aqua Refractor",
    });
    expect(e).toBeNull();
  });

  it("supports product-level alias matching used by eligibility", () => {
    const e = lookupBowmanFamilyByProduct("Bowman Chrome", "Wave Orange Refractors");
    expect(e).not.toBeNull();
    expect(e?.parallelName).toBe("Orange Wave Refractor");
  });
});
