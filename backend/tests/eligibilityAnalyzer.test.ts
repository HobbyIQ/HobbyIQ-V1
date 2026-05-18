import { describe, it, expect } from "vitest";
import {
  analyzeEligibility,
  analyzeEligibilityAcrossSources,
  type StagedFileLike,
} from "../src/curation/eligibilityAnalyzer.js";

function staged(parallels: StagedFileLike["parallels"], brand = "Bowman Chrome"): StagedFileLike {
  return {
    schemaVersion: 1,
    year: 2024,
    brand,
    setLabel: `2024 ${brand} Baseball`,
    sourceUrl: "https://example.invalid/checklist.xlsx",
    parallels,
  };
}

describe("analyzeEligibility — happy path", () => {
  it("marks set eligible when all parallels covered", () => {
    const report = analyzeEligibility(
      staged([
        { rawName: "Refractor", printRun: null, isOneOfOne: false, note: null },
        { rawName: "Blue", printRun: 150, isOneOfOne: false, note: null },
        { rawName: "Gold", printRun: 50, isOneOfOne: false, note: null },
      ]),
    );
    expect(report.eligible).toBe(true);
    expect(report.eligibilityReason).toBe("fully-covered");
    expect(report.coveredCount).toBe(3);
    expect(report.uncoveredCount).toBe(0);
    expect(report.coveredParallels.map((p) => p.canonicalParallelName).sort()).toEqual([
      "Blue",
      "Gold",
      "Refractor",
    ]);
  });

  it("uses fuzzy lookup via normalizer (Blue Refractor → Blue)", () => {
    const report = analyzeEligibility(
      staged([{ rawName: "Blue Refractor", printRun: 150, isOneOfOne: false, note: null }]),
    );
    expect(report.eligible).toBe(true);
    expect(report.coveredParallels[0]!.canonicalParallelName).toBe("Blue");
  });

  it("prefers normalized canonicalName over rawName when present", () => {
    const report = analyzeEligibility(
      staged([
        {
          rawName: "Bleu Refractor",
          printRun: 150,
          isOneOfOne: false,
          note: null,
          normalization: { strategy: "alias", canonicalName: "Blue" },
        },
      ]),
    );
    expect(report.eligible).toBe(true);
  });
});

describe("analyzeEligibility — ineligibility reasons", () => {
  it("brand-not-registered short-circuits", () => {
    const report = analyzeEligibility(
      staged(
        [{ rawName: "Refractor", printRun: null, isOneOfOne: false, note: null }],
        "Topps Finest",
      ),
    );
    expect(report.eligible).toBe(false);
    expect(report.eligibilityReason).toBe("brand-not-registered");
    expect(report.coveredCount).toBe(0);
    expect(report.uncoveredCount).toBe(1);
  });

  it("partial-coverage when any parallel uncovered", () => {
    const report = analyzeEligibility(
      staged([
        { rawName: "Refractor", printRun: null, isOneOfOne: false, note: null },
        { rawName: "Holographic Foil", printRun: null, isOneOfOne: false, note: null },
      ]),
    );
    expect(report.eligible).toBe(false);
    expect(report.eligibilityReason).toBe("partial-coverage");
    expect(report.coveredCount).toBe(1);
    expect(report.uncoveredCount).toBe(1);
    expect(report.uncoveredParallels[0]!.rawName).toBe("Holographic Foil");
  });

  it("no-parallels-found when staged file has zero parallels", () => {
    const report = analyzeEligibility(staged([]));
    expect(report.eligible).toBe(false);
    expect(report.eligibilityReason).toBe("no-parallels-found");
  });
});

describe("analyzeEligibility — summary string", () => {
  it("includes set label and counts", () => {
    const report = analyzeEligibility(
      staged([{ rawName: "Blue", printRun: 150, isOneOfOne: false, note: null }]),
    );
    expect(report.summary).toMatch(/ELIGIBLE/);
    expect(report.summary).toMatch(/2024 Bowman Chrome Baseball/);
    expect(report.summary).toMatch(/1\/1/);
  });

  it("ineligible summary tells owner what to do", () => {
    const report = analyzeEligibility(
      staged([{ rawName: "Refractor", printRun: null, isOneOfOne: false, note: null }], "Bowman"),
    );
    expect(report.summary).toMatch(/INELIGIBLE/);
    expect(report.summary).toMatch(/no owner-curated multiplier table/);
  });
});

describe("analyzeEligibilityAcrossSources", () => {
  it("prefers Beckett when both sources are fully covered", () => {
    const beckett = staged([
      { rawName: "Refractor", printRun: null, isOneOfOne: false, note: null },
      { rawName: "Blue", printRun: 150, isOneOfOne: false, note: null },
    ]);
    const cc = staged([
      { rawName: "Refractor", printRun: null, isOneOfOne: false, note: null },
      { rawName: "Blue", printRun: 150, isOneOfOne: false, note: null },
    ]);

    const report = analyzeEligibilityAcrossSources([
      { source: "cardboard-connection", staged: cc },
      { source: "beckett", staged: beckett },
    ]);

    expect(report.eligible).toBe(true);
    expect(report.preferredSource).toBe("beckett");
    expect(report.sources.sort()).toEqual(["beckett", "cardboard-connection"]);
    expect(report.duplicateAcrossSources).toBe(true);
  });

  it("selects cardboard connection when Beckett is not fully covered", () => {
    const beckett = staged([
      { rawName: "Holographic Foil", printRun: null, isOneOfOne: false, note: null },
    ]);
    const cc = staged([
      { rawName: "Refractor", printRun: null, isOneOfOne: false, note: null },
      { rawName: "Blue", printRun: 150, isOneOfOne: false, note: null },
    ]);

    const report = analyzeEligibilityAcrossSources([
      { source: "beckett", staged: beckett },
      { source: "cardboard-connection", staged: cc },
    ]);

    expect(report.eligible).toBe(true);
    expect(report.preferredSource).toBe("cardboard-connection");
  });
});
