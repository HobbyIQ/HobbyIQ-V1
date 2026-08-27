/**
 * CF-THE-LADDER-IS-A-LADDER-NOT-A-SECTION (Drew, 2026-08-26).
 *
 * Newer Beckett workbooks publish the parallel ladder, and the converter was
 * reading it as section headers. 2023 Bowman Chrome converted to 1,372 rows,
 * every one with a BLANK parallel, and categories like "auto-superfractors-11"
 * and "insert-100-cards". All 97 rungs in the workbook were dropped.
 *
 * Bowman Chrome IS its refractor ladder, so that was the entire checklist
 * missing while the row count still looked plausible — the failure mode that
 * keeps recurring. Fixed, the same workbook yields 7,152 rows, 37 distinct
 * parallels, and 6,367 rows carrying a print run.
 *
 * Print run is the one field that cannot be reconstructed from a sale title,
 * which is why dropping the ladder was expensive rather than cosmetic.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRung, LADDER_HEAD } = require("../scripts/convertBeckettChecklistXlsx.cjs");

describe("a rung carries its print run", () => {
  it("reads a numbered run", () => {
    expect(parseRung("Refractors – /499")).toMatchObject({ name: "Refractors", printRun: 499 });
    expect(parseRung("Gold Refractors – /50")).toMatchObject({ name: "Gold Refractors", printRun: 50 });
    expect(parseRung("Red Refractors – /5")).toMatchObject({ name: "Red Refractors", printRun: 5 });
  });

  it("reads a one-of-one", () => {
    expect(parseRung("Superfractors - 1/1")).toMatchObject({ name: "Superfractors", printRun: 1 });
  });

  it("accepts a rung with no stated run rather than inventing one", () => {
    expect(parseRung("Shimmer Refractors")).toMatchObject({ name: "Shimmer Refractors", printRun: null });
  });

  it("handles both the hyphen and the en dash Beckett mixes within one sheet", () => {
    expect(parseRung("Orange Refractors - /25")?.printRun).toBe(25);
    expect(parseRung("Orange Refractors – /25")?.printRun).toBe(25);
  });
});

describe("a distribution note is not a different parallel", () => {
  it("strips it from the name and keeps it as a note", () => {
    const r = parseRung("Orange Refractors – /25 (hobby only)");
    // "Orange Refractors (hobby only)" would slug as a separate card from
    // "Orange Refractors" and split one parallel's comp pool in two.
    expect(r).toMatchObject({ name: "Orange Refractors", printRun: 25, note: "hobby only" });
  });

  it("treats HTA the same way", () => {
    expect(parseRung("Red Wave Refractors – /5 (HTA only)")).toMatchObject({
      name: "Red Wave Refractors", printRun: 5, note: "HTA only",
    });
  });
});

describe("prose is not a rung", () => {
  it("rejects the marker, the count line, and section titles", () => {
    for (const s of ["Parallels:", "100 cards.", "Base Set", "Chrome Prospects Checklist", ""]) {
      expect(parseRung(s), `${s} must not be a rung`).toBeNull();
    }
  });

  it("rejects a placeholder — Beckett writes TBA when nothing is announced", () => {
    // Left unhandled, "TBA" fell through to the section-header branch and BECAME
    // the section, stealing the name from "It Came for the League Checklist" and
    // filing its 15 cards under a set called TBA.
    expect(parseRung("TBA")).toBeNull();
  });

  it("recognises the ladder marker itself", () => {
    expect(LADDER_HEAD.test("Parallels:")).toBe(true);
    expect(LADDER_HEAD.test("Parallel:")).toBe(true);
    expect(LADDER_HEAD.test("Base Set")).toBe(false);
  });
});
