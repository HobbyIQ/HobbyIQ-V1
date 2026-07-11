// CF-PHASE5-LADDER-TO-COSMOS (2026-07-10, Drew). Covers the ops-critical
// invariants for the reference-catalog lookup: env-flag gate, cache-hit
// behavior (one Cosmos call per bucket), graceful null returns, and
// selection preference (confidence rank + auto flag).

import { describe, it, expect, vi, beforeEach } from "vitest";

const listParallelsByProductYearMock = vi.fn();

vi.mock("../src/repositories/referenceCatalog.repository.js", () => ({
  listParallelsByProductYear: (...args: unknown[]) =>
    listParallelsByProductYearMock(...args),
}));

// Re-import fresh so the module-level cache resets are honored. Vitest
// mocks require import AFTER vi.mock.
async function load() {
  const mod = await import("../src/services/compiq/referenceCatalogLookup");
  mod._resetReferenceCatalogCacheForTest();
  return mod;
}

const doc = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "abc",
  docType: "parallel" as const,
  productKey: "bowman",
  product: "Bowman",
  year: 2026,
  cardSetKey: "chrome",
  cardSet: "Chrome",
  parallelKey: "gold-refractor",
  parallel: "Gold Refractor",
  printRun: 50,
  numbered: true,
  runVaries: false,
  perCardRun: false,
  auto: false,
  licensed: true,
  confidence: "Verified" as const,
  notes: "",
  sourceUrl: null,
  schemaVersion: 1 as const,
  updatedAt: "2026-07-10T00:00:00.000Z",
  ...overrides,
});

describe("inferPrintRunFromReferenceCatalog", () => {
  beforeEach(() => {
    listParallelsByProductYearMock.mockReset();
    delete process.env.COMPIQ_REFERENCE_CATALOG_ENABLED;
  });

  it("returns null when env flag is off (no Cosmos call at all)", async () => {
    const { inferPrintRunFromReferenceCatalog } = await load();
    listParallelsByProductYearMock.mockResolvedValue([doc()]);
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman",
      2026,
      "Gold Refractor",
    );
    expect(res).toBeNull();
    expect(listParallelsByProductYearMock).not.toHaveBeenCalled();
  });

  it("returns null on incomplete inputs", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    const { inferPrintRunFromReferenceCatalog } = await load();
    expect(
      await inferPrintRunFromReferenceCatalog(null, 2026, "Gold Refractor"),
    ).toBeNull();
    expect(
      await inferPrintRunFromReferenceCatalog("Bowman", null, "Gold Refractor"),
    ).toBeNull();
    expect(await inferPrintRunFromReferenceCatalog("Bowman", 2026, "")).toBeNull();
    expect(listParallelsByProductYearMock).not.toHaveBeenCalled();
  });

  it("returns a hit when the productKey/year/parallelKey match", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([doc()]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman",
      2026,
      "Gold Refractor",
    );
    expect(res).not.toBeNull();
    expect(res!.printRun).toBe(50);
    expect(res!.source).toBe("reference-catalog");
    expect(listParallelsByProductYearMock).toHaveBeenCalledWith("bowman", 2026);
  });

  it("caches per (productKey, year) — a second call is free", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([
      doc({ parallel: "Gold Refractor", parallelKey: "gold-refractor" }),
      doc({ parallel: "Red Refractor", parallelKey: "red-refractor", printRun: 5 }),
    ]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    await inferPrintRunFromReferenceCatalog("Bowman", 2026, "Gold Refractor");
    await inferPrintRunFromReferenceCatalog("Bowman", 2026, "Red Refractor");
    // Same (productKey, year) — one call, not two.
    expect(listParallelsByProductYearMock).toHaveBeenCalledTimes(1);
  });

  it("prefers higher-confidence rows on a parallelKey collision", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([
      doc({ id: "med", confidence: "Medium", printRun: 999 }),
      doc({ id: "ver", confidence: "Verified", printRun: 50 }),
      doc({ id: "hi", confidence: "High", printRun: 100 }),
    ]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman",
      2026,
      "Gold Refractor",
    );
    expect(res!.printRun).toBe(50); // Verified wins
  });

  it("prefers auto-matching rows when isAuto is specified", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([
      doc({ id: "base", auto: false, printRun: 150 }),
      doc({ id: "auto", auto: true, printRun: 25 }),
    ]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman",
      2026,
      "Gold Refractor",
      { isAuto: true },
    );
    expect(res!.printRun).toBe(25);
    expect(res!.auto).toBe(true);
  });

  it("returns null on a miss (empty bucket) without crashing", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman",
      2026,
      "Gold Refractor",
    );
    expect(res).toBeNull();
  });

  it("returns null on Cosmos error without throwing (never blocks projection)", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockRejectedValue(new Error("Cosmos boom"));
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman",
      2026,
      "Gold Refractor",
    );
    expect(res).toBeNull();
  });

  it("suffix-fuzz: 'Blue' matches 'Blue Refractor' when exact key misses", async () => {
    // CF-STRESS-TEST-SUFFIX-FUZZ (2026-07-10): stress-test surfaced
    // that user queries often say "Blue" for what the catalog stores
    // as "Blue Refractor" in Chrome-family sets.
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([
      doc({
        parallel: "Blue Refractor",
        parallelKey: "blue-refractor",
        printRun: 150,
      }),
    ]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog(
      "Bowman Chrome",
      2022,
      "Blue",
    );
    expect(res).not.toBeNull();
    expect(res!.printRun).toBe(150);
    expect(res!.parallel).toBe("Blue Refractor");
  });

  it("suffix-fuzz: exact match beats suffix-augmented match", async () => {
    // In Bowman flagship, plain "Blue" is a legitimate /150 parallel
    // separate from "Blue Refractor". Exact hit MUST win.
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([
      doc({ parallel: "Blue", parallelKey: "blue", printRun: 150, confidence: "High" }),
      doc({ parallel: "Blue Refractor", parallelKey: "blue-refractor", printRun: 150, confidence: "High" }),
    ]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const res = await inferPrintRunFromReferenceCatalog("Bowman", 2022, "Blue");
    expect(res!.parallel).toBe("Blue"); // exact hit wins over fuzz
  });

  it("canonicalizes product + parallel via slug() before matching", async () => {
    process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
    listParallelsByProductYearMock.mockResolvedValue([
      doc({
        productKey: "bowman-chrome",
        product: "Bowman Chrome",
        parallelKey: "gold-refractor",
        parallel: "Gold Refractor",
      }),
    ]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    // Mixed case + extra whitespace on both sides.
    const res = await inferPrintRunFromReferenceCatalog(
      "  Bowman Chrome  ",
      2026,
      "GOLD refractor",
    );
    expect(res!.printRun).toBe(50);
    expect(listParallelsByProductYearMock).toHaveBeenCalledWith(
      "bowman-chrome",
      2026,
    );
  });
});
