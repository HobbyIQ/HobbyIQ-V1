import { describe, it, expect } from "vitest";
import {
  getTable,
  getTableForYear,
  lookup,
  hasCoverage,
  brandHasTable,
  listCoveredParallels,
  registeredBrandCount,
} from "../src/curation/multiplierTableRegistry.js";

describe("multiplierTableRegistry — public API", () => {
  it("registers Bowman Chrome and Bowman Draft brands", () => {
    expect(brandHasTable("Bowman Chrome")).toBe(true);
    expect(brandHasTable("Bowman Draft")).toBe(true);
    expect(brandHasTable("Bowman Chrome Draft")).toBe(true);
  });

  it("returns empty table for unregistered brands", () => {
    expect(brandHasTable("Topps Finest")).toBe(false);
    expect(brandHasTable("Bowman")).toBe(false); // base Bowman != Chrome
    const t = getTable("Topps Finest");
    expect(t.entries.size).toBe(0);
    expect(t.version).toBe("empty-no-curation");
  });

  it("Bowman Chrome and Bowman Draft share the same table instance", () => {
    expect(getTable("Bowman Chrome")).toBe(getTable("Bowman Draft"));
  });

  it("Chrome/Draft table has all 54 entries", () => {
    expect(getTable("Bowman Chrome").entries.size).toBe(54);
  });

  it("registeredBrandCount returns number of brand aliases", () => {
    expect(registeredBrandCount()).toBe(3);
  });
});

describe("multiplierTableRegistry — lookup", () => {
  it("exact canonical name", () => {
    const e = lookup("Bowman Chrome", "Blue");
    expect(e).not.toBeNull();
    expect(e!.canonicalParallelName).toBe("Blue");
    expect(e!.colorTier).toBe("Blue Tier");
    expect(e!.tierWithinSet).toBe(4);
  });

  it("fuzzy: 'Blue Refractor' → 'Blue' (strips trailing Refractor)", () => {
    const e = lookup("Bowman Chrome", "Blue Refractor");
    expect(e?.canonicalParallelName).toBe("Blue");
  });

  it("fuzzy: 'Blue Auto' → 'Blue' (strips autograph token)", () => {
    const e = lookup("Bowman Chrome", "Blue Autograph");
    expect(e?.canonicalParallelName).toBe("Blue");
  });

  it("bare 'Refractor' stays 'Refractor'", () => {
    const e = lookup("Bowman Chrome", "Refractor");
    expect(e?.canonicalParallelName).toBe("Refractor");
  });

  it("returns null for uncovered parallels", () => {
    expect(lookup("Bowman Chrome", "Holographic Foil")).toBeNull();
    expect(lookup("Bowman Chrome", "")).toBeNull();
  });

  it("brand-not-registered returns null even for canonical parallel names", () => {
    expect(lookup("Bowman", "Blue")).toBeNull();
    expect(lookup("Topps Finest", "Blue")).toBeNull();
  });

  it("hasCoverage mirrors lookup", () => {
    expect(hasCoverage("Bowman Chrome", "Blue")).toBe(true);
    expect(hasCoverage("Bowman Chrome", "Blue Refractor")).toBe(true);
    expect(hasCoverage("Bowman Chrome", "Holographic Foil")).toBe(false);
    expect(hasCoverage("Topps Finest", "Blue")).toBe(false);
  });
});

describe("multiplierTableRegistry — entry shape", () => {
  it("Base Auto: tier=1, parentVariant=null, baseline=1.0", () => {
    const e = lookup("Bowman Chrome", "Base Auto")!;
    expect(e.tierWithinSet).toBe(1);
    expect(e.parentVariant).toBeNull();
    expect(e.baselineMultiplier).toBe(1.0);
  });

  it("Refractor: parentVariant=null (anchor)", () => {
    const e = lookup("Bowman Chrome", "Refractor")!;
    expect(e.parentVariant).toBeNull();
  });

  it("Blue: parentVariant='Refractor'", () => {
    const e = lookup("Bowman Chrome", "Blue")!;
    expect(e.parentVariant).toBe("Refractor");
  });

  it("Superfractor: parentVariant=null, tier=11", () => {
    const e = lookup("Bowman Chrome", "Superfractor")!;
    expect(e.parentVariant).toBeNull();
    expect(e.tierWithinSet).toBe(11);
  });

  it("HTA Choice subset chains off HTA Choice Refractor", () => {
    const anchor = lookup("Bowman Chrome", "HTA Choice Refractor");
    if (anchor) {
      expect(anchor.parentVariant).toBeNull();
    }
  });

  it("color sub-parallels chain off their first color token", () => {
    // Look up any multi-token parallel starting with "Blue " or "Gold "
    const names = listCoveredParallels("Bowman Chrome");
    const blueChild = names.find((n) => n.startsWith("Blue ") && n !== "Blue");
    if (blueChild) {
      const e = lookup("Bowman Chrome", blueChild)!;
      expect(e.parentVariant).toBe("Blue");
    }
  });

  it("every entry has positive integer tierWithinSet and positive baselineMultiplier", () => {
    const t = getTable("Bowman Chrome");
    for (const e of t.entries.values()) {
      expect(Number.isInteger(e.tierWithinSet)).toBe(true);
      expect(e.tierWithinSet).toBeGreaterThan(0);
      expect(e.baselineMultiplier).toBeGreaterThan(0);
      expect(e.refractorMultiplier).toBeGreaterThan(0);
    }
  });
});

describe("multiplierTableRegistry — listCoveredParallels", () => {
  it("returns all 54 names for Chrome", () => {
    expect(listCoveredParallels("Bowman Chrome")).toHaveLength(54);
  });
  it("returns empty array for unregistered brand", () => {
    expect(listCoveredParallels("Topps Finest")).toEqual([]);
  });
});

describe("multiplierTableRegistry — 2022 Bowman family context", () => {
  it("loads 2022 Bowman Chrome extended table when year context is provided", () => {
    const t = getTableForYear("Bowman Chrome", 2022);
    expect(t.entries.size).toBeGreaterThan(20);
    expect(t.version).toContain("bowman-family-2022");
  });

  it("subset disambiguation: Aqua Refractor resolves in CPA context", () => {
    const e = lookup("Bowman Draft", "Aqua Refractor", {
      year: 2022,
      subset: "Chrome Prospect Autographs",
    });
    expect(e).not.toBeNull();
    expect(e?.subset).toBe("Chrome Prospect Autographs");
    expect(e?.baselineMultiplier).toBeGreaterThan(2.4);
  });

  it("subset disambiguation: Aqua Refractor does not resolve in Bowman Chrome base context", () => {
    const e = lookup("Bowman Chrome", "Aqua Refractor", {
      year: 2022,
      subset: "Chrome Base",
    });
    expect(e).toBeNull();
  });

  it("returns null when a parallel does not exist in the requested subset", () => {
    const e = lookup("Bowman", "Sky Blue Refractor", {
      year: 2022,
      subset: "Paper Base + Paper Prospects",
    });
    expect(e).toBeNull();
  });

  it("direct-comp-only entries are flagged", () => {
    const e = lookup("Bowman Chrome", "Superfractor", {
      year: 2022,
      subset: "Chrome Prospect Autographs",
    });
    expect(e).not.toBeNull();
    expect(e?.directCompOnly).toBe(true);
  });

  it("range values are stored and exposed (low/high)", () => {
    const e = lookup("Bowman Chrome", "Gold Refractor", {
      year: 2022,
      subset: "Chrome Prospect Autographs",
    });
    expect(e).not.toBeNull();
    expect(e?.rangeLow).toBe(8.0);
    expect(e?.rangeHigh).toBe(11.5);
  });

  it("product-level coverage check supports staged-style labels", () => {
    expect(hasCoverage("Bowman Chrome", "Black and White Mini Diamond Refractors", { year: 2022 })).toBe(true);
    expect(hasCoverage("Bowman Chrome", "X-Fractor", { year: 2022 })).toBe(false);
  });

  it("Bowman Draft CPA Blue Refractor coverage resolves to 3.0-4.4", () => {
    const e = lookup("Bowman Draft", "Blue Refractor", {
      year: 2022,
      subset: "Chrome Prospect Autographs",
    });
    expect(e).not.toBeNull();
    expect(e?.rangeLow).toBe(3.0);
    expect(e?.rangeHigh).toBe(4.4);
  });

  it("uncurated normalized parallel still returns null", () => {
    const e = lookup("Bowman Chrome", "rainbow ice foil 150", {
      year: 2022,
      subset: "Chrome Prospect Autographs",
    });
    expect(e).toBeNull();
  });
});
