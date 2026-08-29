import { describe, expect, it } from "vitest";
import { decideTwinFold, parallelSlugOf, ALWAYS_ONE_OF_ONE } from "../src/services/catalog/foldTwinRule.js";

const BASE = "hiq:baseball:2025:bowman-draft:cpa-mwi:superfractor:auto";
const REF = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const n = (id: string, printRun: number, source: string) => ({ id, printRun, source });

describe("foldTwinRule -- CF-A-SUPERFRACTOR-IS-ONE-OF-ONE", () => {
  it("Drew's picker: bcp's un-numbered SuperFractor folds into beckett's /1 in every mode", () => {
    for (const mode of ["vendor", "cross-source"] as const) {
      const d = decideTwinFold({ baseId: BASE, twinSource: "baseballcardpedia", twinIsChecklist: true, numbered: [n(BASE + ":num-1", 1, "beckett-checklist")], mode });
      expect(d.fold).toBe(true);
      if (d.fold) { expect(d.kind).toBe("one-of-one"); expect(d.target.id).toBe(BASE + ":num-1"); }
    }
  });
  it("a printing plate is 1/1 too; a colour before superfractor is still a SuperFractor", () => {
    expect(ALWAYS_ONE_OF_ONE.test("printing-plates-black")).toBe(true);
    expect(ALWAYS_ONE_OF_ONE.test("gold-superfractor")).toBe(true);
    expect(ALWAYS_ONE_OF_ONE.test("refractor")).toBe(false);
    expect(parallelSlugOf(BASE)).toBe("superfractor");
  });
  it("mis-parsed print runs beside the /1 do not make a SuperFractor ambiguous -- the /1 is the card", () => {
    const d = decideTwinFold({ baseId: BASE, twinSource: "baseballcardpedia", twinIsChecklist: true, numbered: [n(BASE + ":num-1", 1, "beckett-checklist"), n(BASE + ":num-50", 50, "checklistinsider-2026-08-27")], mode: "vendor" });
    expect(d.fold && d.target.printRun).toBe(1);
  });
});

describe("foldTwinRule -- CF-A-KEY-NEEDS-BOTH-HALVES (vendor twins)", () => {
  it("a user-seeded un-numbered row folds into the one numbered checklist row", () => {
    const d = decideTwinFold({ baseId: REF, twinSource: "user-verified", twinIsChecklist: false, numbered: [n(REF + ":num-499", 499, "beckett-checklist")], mode: "vendor" });
    expect(d.fold && d.kind).toBe("vendor");
  });
  it("two numbered variants with different print runs are ambiguous -- left alone", () => {
    const S = "hiq:baseball:2025:bowman-draft:cpa-mwi:sparkle-refractor:auto";
    const d = decideTwinFold({ baseId: S, twinSource: "checklistinsider-2026-08-27", twinIsChecklist: true, numbered: [n(S + ":num-200", 200, "baseballcardpedia"), n(S + ":num-71", 71, "checklistcenter-2026-08-29")], mode: "cross-source" });
    expect(d).toEqual({ fold: false, skip: "ambiguous" });
  });
});

describe("foldTwinRule -- CF-ONE-SOURCE-OMITTED-THE-PRINT-RUN (mode cross-source)", () => {
  it("bcp's un-numbered Refractor folds into beckett's /499 when bcp lists no numbered variant", () => {
    const d = decideTwinFold({ baseId: REF, twinSource: "baseballcardpedia", twinIsChecklist: true, numbered: [n(REF + ":num-499", 499, "beckett-checklist")], mode: "cross-source" });
    expect(d.fold && d.kind).toBe("cross-source");
  });
  it("the same rule in mode vendor leaves checklist twins alone (the running APPLY's contract)", () => {
    const d = decideTwinFold({ baseId: REF, twinSource: "baseballcardpedia", twinIsChecklist: true, numbered: [n(REF + ":num-499", 499, "beckett-checklist")], mode: "vendor" });
    expect(d).toEqual({ fold: false, skip: "twin-is-checklist" });
  });
  it("a source that lists BOTH the un-numbered and the numbered row is describing two cards", () => {
    const d = decideTwinFold({ baseId: REF, twinSource: "baseballcardpedia", twinIsChecklist: true, numbered: [n(REF + ":num-499", 499, "baseballcardpedia")], mode: "cross-source" });
    expect(d).toEqual({ fold: false, skip: "same-source-lists-both" });
  });
});
