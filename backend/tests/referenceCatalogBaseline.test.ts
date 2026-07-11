// CF-NO-NULL-PRICING (2026-07-11, Drew — Tier 6 referenceCatalogBaseline).
// Locks the era-baseline lookup + floor math. Tier 6 fires when the
// ladder has a ParallelDoc but no comps exist at any level.

import { describe, it, expect, vi, beforeEach } from "vitest";

const inferPrintRunFromReferenceCatalogMock = vi.fn();
const getEraBaselineMock = vi.fn();

vi.mock("../src/services/compiq/referenceCatalogLookup.js", () => ({
  inferPrintRunFromReferenceCatalog: (...args: unknown[]) =>
    inferPrintRunFromReferenceCatalogMock(...args),
}));

vi.mock("../src/repositories/eraBaselines.repository.js", () => ({
  getEraBaseline: (...args: unknown[]) => getEraBaselineMock(...args),
}));

async function load() {
  return await import("../src/services/compiq/referenceCatalogBaseline");
}

describe("lookupEraBaselineStatic", () => {
  it("returns baseline for known productKey + year (base card)", async () => {
    const { lookupEraBaselineStatic } = await load();
    // 2020 Bowman Chrome falls in 2016-2026 bucket at 12
    expect(lookupEraBaselineStatic("bowman-chrome", 2020, "base")).toBe(12);
  });

  it("applies auto multiplier (4x)", async () => {
    const { lookupEraBaselineStatic } = await load();
    expect(lookupEraBaselineStatic("bowman-chrome", 2020, "auto")).toBe(48);
  });

  it("longest-prefix match wins", async () => {
    const { lookupEraBaselineStatic } = await load();
    // "bowman-chrome-mega-box" should match "bowman-chrome" prefix
    expect(lookupEraBaselineStatic("bowman-chrome-mega-box", 2020, "base")).toBe(12);
  });

  it("returns null for unknown productKey", async () => {
    const { lookupEraBaselineStatic } = await load();
    expect(lookupEraBaselineStatic("random-unknown-product", 2020, "base")).toBeNull();
  });

  it("falls through to parent productKey prefix when specific bucket has no year match", async () => {
    const { lookupEraBaselineStatic } = await load();
    // Bowman Chrome didn't exist in 1990 (product launched 1997), but the
    // 'bowman' prefix DOES match 1990 → treat as Bowman flagship baseline.
    // This is INTENTIONAL fallback behavior — better than returning null
    // for an input the caller could have anyway (fuzzy match, typo, etc.).
    expect(lookupEraBaselineStatic("bowman-chrome", 1990, "base")).toBe(2);
  });
});

describe("computeReferenceCatalogBaseline", () => {
  beforeEach(() => {
    inferPrintRunFromReferenceCatalogMock.mockReset();
    getEraBaselineMock.mockReset();
    // Default: Cosmos era-baselines returns null (empty container) so
    // static fallback is used unless a specific test overrides.
    getEraBaselineMock.mockResolvedValue(null);
    delete process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED;
  });

  it("returns null when env flag is off (default)", async () => {
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 150,
      parallel: "Blue Refractor",
      cardSet: "Chrome Prospects",
    });
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "base",
    });
    expect(r).toBeNull();
    expect(inferPrintRunFromReferenceCatalogMock).not.toHaveBeenCalled();
  });

  it("returns null when ladder has no matching ParallelDoc", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue(null);
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Unknown Parallel",
      cardClass: "base",
    });
    expect(r).toBeNull();
  });

  it("computes floor for known Bowman Chrome /150 base parallel", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 150,
      parallel: "Blue Refractor",
      cardSet: "Chrome Prospects",
    });
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "base",
    });
    expect(r).not.toBeNull();
    // eraBaseline for bowman-chrome 2020 base = 12
    expect(r!.eraBaseline).toBe(12);
    // tierMultiplier for /150 base — from parallelPremiumFloors (whatever
    // it returns; test just locks the shape).
    expect(r!.printRun).toBe(150);
    expect(r!.tierMultiplier).toBeGreaterThan(0);
    expect(r!.floor).toBe(
      Math.round(r!.eraBaseline * r!.tierMultiplier * 100) / 100,
    );
    expect(r!.range.low).toBe(Math.round(r!.floor * 0.5 * 100) / 100);
    expect(r!.range.high).toBe(Math.round(r!.floor * 2.0 * 100) / 100);
    expect(r!.baselineSource).toBe("static-table");
  });

  it("applies auto multiplier to Chrome Prospect Auto", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 150,
      parallel: "Blue Refractor",
      cardSet: "Chrome Prospect Autographs",
    });
    const { computeReferenceCatalogBaseline } = await load();
    const rAuto = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "auto",
    });
    // auto baseline is 12 × 4 = 48
    expect(rAuto!.eraBaseline).toBe(48);
    expect(rAuto!.floor).toBe(
      Math.round(48 * rAuto!.tierMultiplier * 100) / 100,
    );
  });

  it("returns null on ladder-lookup error (never blocks the caller)", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockRejectedValue(new Error("Cosmos boom"));
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "base",
    });
    expect(r).toBeNull();
  });

  it("uses Cosmos era-baseline as PRIMARY when populated", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 150,
      parallel: "Blue Refractor",
      cardSet: "Chrome Prospects",
    });
    getEraBaselineMock.mockResolvedValue({
      id: "abc",
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      currentValue: 20,
      predictedValue: 22,
      trendPct: 0.1,
      trendDirection: "up",
      sampleSize: 87,
      currentRange: { low: 10, high: 40 },
      computedAt: "2026-07-11T00:00:00Z",
      schemaVersion: 2,
    });
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "base",
    });
    expect(r).not.toBeNull();
    expect(r!.eraBaseline).toBe(20); // Cosmos currentValue, not static 12
    expect(r!.baselineSource).toBe("era-baselines-cosmos");
    expect(r!.sampleSize).toBe(87);
    // Forward-looking fields propagated from the era-baseline doc.
    expect(r!.predictedFloor).toBe(Math.round(22 * r!.tierMultiplier * 100) / 100);
    expect(r!.trendPct).toBe(0.1);
    expect(r!.trendDirection).toBe("up");
  });

  it("falls back to static table when Cosmos returns null", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 150,
      parallel: "Blue Refractor",
      cardSet: "Chrome Prospects",
    });
    getEraBaselineMock.mockResolvedValue(null);
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "base",
    });
    expect(r!.baselineSource).toBe("static-table");
    expect(r!.eraBaseline).toBe(12); // static for bowman-chrome 2020 base
    expect(r!.sampleSize).toBeUndefined();
  });

  it("falls back to static when Cosmos throws (never blocks caller)", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 150,
      parallel: "Blue Refractor",
      cardSet: "Chrome Prospects",
    });
    getEraBaselineMock.mockRejectedValue(new Error("cosmos down"));
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Bowman Chrome",
      year: 2020,
      parallel: "Blue Refractor",
      cardClass: "base",
    });
    expect(r!.baselineSource).toBe("static-table");
    expect(r!.eraBaseline).toBe(12);
  });

  it("returns null for productKey/year outside static-table coverage", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED = "true";
    inferPrintRunFromReferenceCatalogMock.mockResolvedValue({
      printRun: 25,
      parallel: "Rare",
      cardSet: "Base",
    });
    const { computeReferenceCatalogBaseline } = await load();
    const r = await computeReferenceCatalogBaseline({
      product: "Some Made Up Product",
      year: 2020,
      parallel: "Rare",
      cardClass: "base",
    });
    // Ladder returned a hit (mocked), but era-baseline table has no
    // entry for "some-made-up-product" → null result.
    expect(r).toBeNull();
  });
});
