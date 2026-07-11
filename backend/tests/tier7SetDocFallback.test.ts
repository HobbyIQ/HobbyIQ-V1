// CF-NO-NULL-PRICING PR 3 (2026-07-11, Drew — Tier 7 helper tests).

import { describe, it, expect, vi, beforeEach } from "vitest";

const getSetDocForProductYearMock = vi.fn();

vi.mock("../src/repositories/setDocLookup.repository.js", () => ({
  getSetDocForProductYear: (...args: unknown[]) =>
    getSetDocForProductYearMock(...args),
}));

async function load() {
  return await import("../src/services/compiq/tier7SetDocFallback");
}

describe("maybeTier7Fallback", () => {
  beforeEach(() => {
    getSetDocForProductYearMock.mockReset();
    delete process.env.COMPIQ_SETDOC_BASELINE_ENABLED;
  });

  it("returns null when env flag is off (default)", async () => {
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "1989 Topps",
      year: 1989,
      gradeMultiplier: 1,
    });
    expect(r).toBeNull();
    expect(getSetDocForProductYearMock).not.toHaveBeenCalled();
  });

  it("returns null on incomplete inputs", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    const { maybeTier7Fallback } = await load();
    expect(await maybeTier7Fallback({ product: null, year: 1989 })).toBeNull();
    expect(await maybeTier7Fallback({ product: "Topps", year: null })).toBeNull();
    expect(await maybeTier7Fallback({ product: "", year: 1989 })).toBeNull();
    expect(getSetDocForProductYearMock).not.toHaveBeenCalled();
  });

  it("returns null when SetDoc lookup misses", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    getSetDocForProductYearMock.mockResolvedValue(null);
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "Unknown Set",
      year: 1989,
      gradeMultiplier: 1,
    });
    expect(r).toBeNull();
  });

  it("produces Tier 7 estimate for known SetDoc (base junk-wax)", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    getSetDocForProductYearMock.mockResolvedValue({
      productKey: "topps",
      setName: "Topps",
      manufacturer: "Topps",
      setType: "Base",
      setSize: 792,
      yearText: "1989",
      sortYear: 1989,
      confidence: "High",
    });
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "Topps",
      year: 1989,
      gradeMultiplier: 1,
    });
    expect(r).not.toBeNull();
    // 1988-1994 Base baseline = 2. Grade mult 1 → floor 2.
    expect(r!.baseline).toBe(2);
    expect(r!.floor).toBe(2);
    expect(r!.era).toBe("1988-1994");
    expect(r!.setTypeKey).toBe("base");
    expect(r!.setName).toBe("Topps");
    expect(r!.verdict).toContain("Topps");
    expect(r!.verdict).toContain("1988-1994");
  });

  it("applies grade multiplier to the era baseline", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    getSetDocForProductYearMock.mockResolvedValue({
      productKey: "topps-chrome",
      setName: "Topps Chrome",
      manufacturer: "Topps",
      setType: "Chromium",
      setSize: 200,
      yearText: "2020",
      sortYear: 2020,
      confidence: "High",
    });
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "Topps Chrome",
      year: 2020,
      gradeMultiplier: 6, // PSA 10-ish
    });
    // 2016-2026 Chromium baseline = 45. × 6 = 270.
    expect(r!.baseline).toBe(45);
    expect(r!.floor).toBe(270);
  });

  it("returns null when era baseline lookup fails (pre-1988)", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    getSetDocForProductYearMock.mockResolvedValue({
      productKey: "topps",
      setName: "Topps",
      manufacturer: "Topps",
      setType: "Base",
      setSize: 792,
      yearText: "1970",
      sortYear: 1970,
      confidence: "High",
    });
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "Topps",
      year: 1970,
      gradeMultiplier: 1,
    });
    // Pre-1988 → applyGradeToSetDocBaseline returns null → Tier 7 returns null.
    expect(r).toBeNull();
  });

  it("returns null on SetDoc-lookup error (never blocks caller)", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    getSetDocForProductYearMock.mockRejectedValue(new Error("cosmos down"));
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "Topps",
      year: 1989,
      gradeMultiplier: 1,
    });
    expect(r).toBeNull();
  });

  it("defaults grade multiplier to 1 when not provided", async () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    getSetDocForProductYearMock.mockResolvedValue({
      productKey: "topps",
      setName: "Topps",
      manufacturer: "Topps",
      setType: "Base",
      setSize: 792,
      yearText: "2020",
      sortYear: 2020,
      confidence: "High",
    });
    const { maybeTier7Fallback } = await load();
    const r = await maybeTier7Fallback({
      product: "Topps",
      year: 2020,
      // gradeMultiplier omitted
    });
    // 2016-2026 Base baseline = 8. × 1 = 8.
    expect(r!.floor).toBe(8);
  });
});
