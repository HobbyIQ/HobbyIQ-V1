import { describe, it, expect } from "vitest";
import { generateWorksheet } from "../src/curation/worksheetGenerator.js";
import {
  analyzeEligibility,
  type StagedFileLike,
} from "../src/curation/eligibilityAnalyzer.js";

function makeStaged(parallels: StagedFileLike["parallels"]): StagedFileLike {
  return {
    schemaVersion: 1,
    year: 2024,
    brand: "Bowman Chrome",
    setLabel: "2024 Bowman Chrome Baseball",
    sourceUrl: "https://example.invalid/sheet.xlsx",
    parallels,
  };
}

describe("generateWorksheet — pre-fill behavior", () => {
  it("produces worksheet with status pending", () => {
    const report = analyzeEligibility(
      makeStaged([{ rawName: "Blue", printRun: 150, isOneOfOne: false, note: null }]),
    );
    const ws = generateWorksheet(report, { generatedAt: "2026-05-17T12:00:00Z" });
    expect(ws.status).toBe("pending");
    expect(ws.worksheetType).toBe("phase-b-curation");
    expect(ws.schemaVersion).toBe(1);
    expect(ws.reviewedAt).toBeNull();
    expect(ws.generatedAt).toBe("2026-05-17T12:00:00Z");
  });

  it("pre-fills tier/printRun/multipliers from registry, color stays blank", () => {
    const report = analyzeEligibility(
      makeStaged([{ rawName: "Blue", printRun: 150, isOneOfOne: false, note: null }]),
    );
    const ws = generateWorksheet(report);
    const row = ws.parallels[0]!;
    expect(row.canonicalParallelName).toBe("Blue");
    expect(row.tierWithinSet.value).toBe(4);
    expect(row.tierWithinSet.provenance).toBe("from-registry");
    expect(row.baselineMultiplier.provenance).toBe("from-registry");
    expect(row.refractorMultiplier.provenance).toBe("from-registry");
    expect(row.colorTier.value).toBe("Blue Tier");
    expect(row.color.value).toBeNull();
    expect(row.color.provenance).toBe("blank");
    expect(row.note.provenance).toBe("blank");
    expect(row.skip).toBe(false);
  });

  it("pre-fills parentVariant from registry when available", () => {
    const report = analyzeEligibility(
      makeStaged([{ rawName: "Blue", printRun: 150, isOneOfOne: false, note: null }]),
    );
    const ws = generateWorksheet(report);
    expect(ws.parallels[0]!.parentVariant.value).toBe("Refractor");
    expect(ws.parallels[0]!.parentVariant.provenance).toBe("from-registry");
  });

  it("marks parentVariant blank when registry returns null", () => {
    // Refractor itself has parentVariant=null per registry rules
    const report = analyzeEligibility(
      makeStaged([{ rawName: "Refractor", printRun: null, isOneOfOne: false, note: null }]),
    );
    const ws = generateWorksheet(report);
    expect(ws.parallels[0]!.parentVariant.value).toBeNull();
    expect(ws.parallels[0]!.parentVariant.provenance).toBe("blank");
  });

  it("counts pre-filled vs blank-required fields", () => {
    const report = analyzeEligibility(
      makeStaged([
        { rawName: "Blue", printRun: 150, isOneOfOne: false, note: null },
        { rawName: "Gold", printRun: 50, isOneOfOne: false, note: null },
      ]),
    );
    const ws = generateWorksheet(report);
    // Each row contributes 6 from-registry fields (tier, parent, printRun,
    // baseline, refractor, colorTier) when parent isn't null.
    expect(ws.preFilledCount).toBeGreaterThanOrEqual(6 * 2 - 2);
    // Each row contributes exactly 1 blank-required field (color).
    expect(ws.blankRequiredCount).toBe(2);
  });

  it("carries beckettSourceUrl and registry version", () => {
    const report = analyzeEligibility(
      makeStaged([{ rawName: "Blue", printRun: 150, isOneOfOne: false, note: null }]),
    );
    const ws = generateWorksheet(report);
    expect(ws.beckettSourceUrl).toBe("https://example.invalid/sheet.xlsx");
    expect(ws.registryVersion).toMatch(/chrome-draft/);
  });
});

describe("generateWorksheet — guard rails", () => {
  it("throws when report is ineligible", () => {
    const report = analyzeEligibility(
      makeStaged([{ rawName: "Holographic Foil", printRun: null, isOneOfOne: false, note: null }]),
    );
    expect(() => generateWorksheet(report)).toThrow(/ineligible/i);
  });
});
