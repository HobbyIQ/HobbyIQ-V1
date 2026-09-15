import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const {
  splitSection,
  measureAnchors,
  comparablePlayer,
  normPrintRun,
} = require_("../scripts/convertCardboardConnectionXlsx.cjs");

/**
 * These cases are the three real defects this converter was written against,
 * each measured on a live cardboardconnection sheet before it was fixed. They
 * exist so a future edit cannot quietly reintroduce a well-formed wrong file.
 */
describe("cardboardconnection xlsx converter", () => {
  describe("normPrintRun", () => {
    it("reads a serial column into the repo's /N form", () => {
      expect(normPrintRun("100")).toBe("/100");
      expect(normPrintRun("1,999")).toBe("/1999");
      expect(normPrintRun("25 (Gold)")).toBe("/25");
    });

    it("never invents a print run from an absent value", () => {
      expect(normPrintRun("")).toBe("");
      expect(normPrintRun(undefined)).toBe("");
      expect(normPrintRun(null)).toBe("");
      expect(normPrintRun("Gold")).toBe("");
    });
  });

  describe("comparablePlayer", () => {
    it("drops a cosmetic card-role suffix", () => {
      // 2021-22 UD Series 2: base #449 carries "CL", its Clear Cut rung does
      // not. Same card; a strict compare left 290 base cards colliding.
      expect(comparablePlayer("Nathan MacKinnon/Leon Draisaitl CL"))
        .toBe(comparablePlayer("Nathan MacKinnon/Leon Draisaitl"));
    });

    it("never fuses two different players", () => {
      expect(comparablePlayer("Cale Makar RC")).not.toBe(comparablePlayer("Auston Matthews"));
    });
  });

  describe("measureAnchors", () => {
    const sec = (pairs: [string, string][]) => new Map(pairs);

    it("reads a section that reproduces another's players as its RUNG", () => {
      const rows = new Map([
        ["Base Set", sec([["1", "Nicolas Deslauriers"], ["2", "Cam Fowler"]])],
        ["French Parallel", sec([["1", "Nicolas Deslauriers"], ["2", "Cam Fowler"]])],
      ]);
      const anchors = measureAnchors(rows);
      expect(anchors.get("French Parallel")?.anchorSection).toBe("Base Set");
      // The anchor itself is never recorded as a rung of its own rung.
      expect(anchors.has("Base Set")).toBe(false);
    });

    it("leaves a same-numbered insert as its OWN card set", () => {
      // 1994-95 Rookie Tribute Die-Cuts restarts at 1 with different players.
      const rows = new Map([
        ["Base Set", sec([["1", "Auston Matthews"], ["2", "William Nylander"]])],
        ["1994-95 Rookie Die-Cuts", sec([["1", "Cale Makar RC"], ["2", "Filip Zadina RC"]])],
      ]);
      const anchors = measureAnchors(rows);
      expect(anchors.has("1994-95 Rookie Die-Cuts")).toBe(false);
    });
  });

  describe("splitSection", () => {
    it("does not split a multi-word anchor on a regex guess", () => {
      // The first cut produced anchor "Honor" + rung "Roll Rainbow".
      const anchors = new Map([
        ["Honor Roll Rainbow Parallel", { anchorSection: "Honor Roll" }],
      ]);
      const got = splitSection("Honor Roll Rainbow Parallel", anchors);
      expect(got.anchor).toBe("Honor Roll");
      expect(got.parallel).toBe("Rainbow");
    });

    it("reads a whole-name rung that shares no token with its anchor", () => {
      // "French Parallel" under "Base Set" — the second cut read this as its
      // own card set, colliding 300 base cards per file.
      const anchors = new Map([["French Parallel", { anchorSection: "Base Set" }]]);
      const got = splitSection("French Parallel", anchors);
      expect(got.anchor).toBe("Base Set");
      expect(got.parallel).toBe("French");
    });

    it("carries a '- Subset' tail as a subset, never as a rung", () => {
      const got = splitSection("Base Set - Young Guns", new Map());
      expect(got.subset).toBe("Young Guns");
      expect(got.parallel).toBe("");
    });

    it("leaves the rung BLANK when nothing measures as the anchor", () => {
      // Blank means unknown, never "Base".
      const got = splitSection("UD Canvas", new Map());
      expect(got.parallel).toBe("");
      expect(got.anchor).toBe("UD Canvas");
    });
  });

  describe("R37 shortest-anchor rung rule (Panini layout)", () => {
    // Drew, 2026-09-14, answering Q7: on a sheet with no Parallel marker the
    // parallel is what the section title adds beyond the SHORTEST matching
    // base anchor. These lock the "shortest" half of the ruling, which is the
    // half that decides between "Green" and "Mosaic Green".
    it("resolves against the SHORTEST matching anchor, not the longest", () => {
      const anchors = new Map([["Base Mosaic Green", { anchorSection: "Base" }]]);
      const got = splitSection("Base Mosaic Green", anchors);
      expect(got.anchor).toBe("Base");
      expect(got.parallel).toBe("Mosaic Green");
    });

    it("leaves an anchorless section for the caller to BLOCK, never guessing", () => {
      // No anchor supplied => no rung is invented.
      const got = splitSection("Some Unanchored Insert", new Map());
      expect(got.parallel).toBe("");
    });
  });
});
