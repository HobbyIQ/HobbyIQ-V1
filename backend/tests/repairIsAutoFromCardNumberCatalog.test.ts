/**
 * CF-ISAUTO-IS-THE-CARD-NUMBER-PREFIX (D15, 2026-08-29).
 *
 * checklistinsider-2026-08-27 wrote 98,382 rows with isAuto=false on an
 * auto-prefixed card number. Doctrine: the card-number prefix IS the auto
 * boundary, never text on the parallel. Which prefixes are signed in a
 * product is decided by the product's OTHER checklist sources -- the source
 * under repair is the defendant and never votes.
 *
 * Pinned here: the ruling (the fixture the plan names: checklistcenter says
 * CPA- is auto x400, checklistinsider says no x400 -> auto), who may vote
 * (checklist families only; vendor and derived never; a scrape run twice is
 * one voter), what a row then needs (heal the field to its own id, or move
 * the id), and the refusal when the evidence contradicts the slug generator.
 */
import { describe, expect, it } from "vitest";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rulePrefixes, decideRow, familyOf, prefixOf, idSaysAuto, withAutoSegment } = require("../scripts/repair-isauto-from-cardnumber-catalog.cjs");

const isChecklist = (s: string) => catalogAuthorityOf(s) === "checklist";
const opts = { repairFamilies: new Set(["checklistinsider"]), isChecklist };
const g = (source: string, isAuto: boolean | undefined, prefix: string, n: number) => ({ source, isAuto, prefix, n });

describe("familyOf -- a scrape run twice is one voter", () => {
  it.each([
    ["checklistinsider-2026-08-27", "checklistinsider"],
    ["beckett-scraped-2026-08-25", "beckett"],
    ["beckett-scraped-2026-08-26", "beckett"],
    ["beckett-checklist", "beckett-checklist"],
    ["beckett-checklist-2026-08-30", "beckett-checklist"],
    ["checklistcenter-2026-08-29", "checklistcenter"],
    ["checklistcenter", "checklistcenter"],
    ["checklistcenter-graded", "checklistcenter"],
    ["baseballcardpedia-ladders-2026-08-30", "baseballcardpedia"],
    ["cardboardchecklist-scraped-2026-08-14", "cardboardchecklist"],
    ["bcp", "bcp"],
  ])("%s -> %s", (source, family) => {
    expect(familyOf(source)).toBe(family);
  });
});

describe("prefixOf / the slug's auto segment", () => {
  it("takes the letters before the hyphen, upper-cased; a plain number has no prefix", () => {
    expect(prefixOf("CPA-MWI")).toBe("CPA");
    expect(prefixOf("cpa-mwi")).toBe("CPA");
    expect(prefixOf("BDC-1")).toBe("BDC");
    expect(prefixOf("150")).toBeNull();
    expect(prefixOf("-1")).toBeNull();
    expect(prefixOf(null)).toBeNull();
  });
  it("reads and rewrites segment 6, keeping the print-run segment", () => {
    expect(idSaysAuto("hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50")).toBe(true);
    expect(idSaysAuto("hiq:basketball:2025:bowman:ra-1:base:no-auto")).toBe(false);
    expect(withAutoSegment("hiq:basketball:2025:bowman:ra-1:base:no-auto", true)).toBe("hiq:basketball:2025:bowman:ra-1:base:auto");
    expect(withAutoSegment("hiq:baseball:2025:bowman-draft:bdc-1:gold-refractor:auto:num-50", false)).toBe("hiq:baseball:2025:bowman-draft:bdc-1:gold-refractor:no-auto:num-50");
  });
});

describe("rulePrefixes -- the product's other checklists decide", () => {
  it("checklistcenter says CPA- is auto x400, checklistinsider says no x400 -> auto", () => {
    const r = rulePrefixes([
      g("checklistcenter-2026-08-29", true, "CPA", 400),
      g("checklistinsider-2026-08-27", false, "CPA", 400),
    ], opts);
    const cpa = r.get("CPA");
    expect(cpa.ruling).toBe(true);
    expect(cpa.voters).toEqual([{ family: "checklistcenter", auto: 400, noAuto: 0, verdict: true }]);
    expect(cpa.target).toEqual({ auto: 0, noAuto: 400, unset: 0 });
  });

  it("the source under repair never votes, however many rows it has", () => {
    const r = rulePrefixes([
      g("checklistinsider-2026-08-27", false, "CPA", 40000),
      g("checklistinsider-2026-08-20", false, "CPA", 40000),
      g("beckett-checklist", true, "CPA", 12),
    ], opts);
    expect(r.get("CPA").ruling).toBe(true);
    expect(r.get("CPA").voters.map((v: { family: string }) => v.family)).toEqual(["beckett-checklist"]);
  });

  it("vendor and derived rows never vote; with nobody else the ruling is none", () => {
    const r = rulePrefixes([
      g("cardhedge", false, "CPA", 5000),
      g("ingest-auto-seed", false, "CPA", 900),
      g("sold-comps-stub-2026-08-12", false, "CPA", 300),
      g("catalog-explode-actuals-2026-08-12", false, "CPA", 300),
      g("checklistinsider-2026-08-27", false, "CPA", 100),
    ], opts);
    expect(r.get("CPA").ruling).toBeNull();
    expect(r.get("CPA").voters).toEqual([]);
    expect(r.get("CPA").reason).toMatch(/no other checklist family/);
  });

  it("a family votes with its row majority; two dated runs of one scrape are ONE voter", () => {
    // beckett twice (auto), one bcp (no) -> counted by family it is 1-1, a tie.
    const r = rulePrefixes([
      g("beckett-scraped-2026-08-25", true, "RA", 20),
      g("beckett-scraped-2026-08-26", true, "RA", 20),
      g("baseballcardpedia", false, "RA", 800),
      g("checklistinsider-2026-08-27", false, "RA", 100),
    ], opts);
    expect(r.get("RA").ruling).toBeNull();
    expect(r.get("RA").reason).toMatch(/tie 1-1/);
    expect(r.get("RA").voters.map((v: { family: string; verdict: boolean | null }) => [v.family, v.verdict]))
      .toEqual([["baseballcardpedia", false], ["beckett", true]]);
  });

  it("a family split down the middle abstains; the majority of the rest rules", () => {
    const r = rulePrefixes([
      g("beckett-scraped-2026-08-25", true, "PA", 5),
      g("beckett-scraped-2026-08-25", false, "PA", 5),
      g("checklistcenter-2026-08-29", false, "PA", 300),
      g("baseballcardpedia", false, "PA", 60),
      g("checklistinsider-2026-08-27", true, "PA", 100),
    ], opts);
    expect(r.get("PA").ruling).toBe(false);
    expect(r.get("PA").reason).toMatch(/no-auto by 2-0 of 3/);
  });

  it("a numeric prefix is not a boundary and a group without isAuto does not vote", () => {
    const r = rulePrefixes([
      g("checklistcenter", true, "1", 50),
      g("checklistcenter", undefined, "CPA", 50),
      g("checklistinsider-2026-08-27", undefined, "CPA", 7),
    ], opts);
    expect(r.has("1")).toBe(false);
    expect(r.get("CPA").ruling).toBeNull();
    expect(r.get("CPA").target.unset).toBe(7);
  });
});

describe("decideRow -- heal the field to its id, or move the id", () => {
  const atAuto = { id: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50", isAuto: false };
  const atNoAuto = { id: "hiq:basketball:2025:bowman:ra-1:base:no-auto", isAuto: false };

  it("ruling auto, id already :auto, field false -> heal (a patch, nothing moves)", () => {
    expect(decideRow(atAuto, true, true)).toEqual({ action: "heal", target: true });
  });
  it("ruling auto, id :no-auto -> move to :auto", () => {
    expect(decideRow(atNoAuto, true, false)).toEqual({ action: "move", target: true, newSlug: "hiq:basketball:2025:bowman:ra-1:base:auto" });
  });
  it("ruling no-auto, id :auto, field true -> move to :no-auto (the generator does not force this prefix)", () => {
    expect(decideRow({ id: "hiq:basketball:2025:bowman:ra-1:base:auto", isAuto: true }, false, false))
      .toEqual({ action: "move", target: false, newSlug: "hiq:basketball:2025:bowman:ra-1:base:no-auto" });
  });
  it("field and id both agree with the ruling -> agree", () => {
    expect(decideRow({ ...atAuto, isAuto: true }, true, true)).toEqual({ action: "agree" });
    expect(decideRow(atNoAuto, false, false)).toEqual({ action: "agree" });
  });
  it("no ruling: a field that disagrees with its own id is healed to the id; one that agrees is skipped", () => {
    expect(decideRow(atAuto, null, true)).toEqual({ action: "heal", target: true });
    expect(decideRow(atNoAuto, null, false)).toEqual({ action: "skip-no-ruling" });
  });
  it("the evidence says no-auto for a prefix the generator forces to :auto -> refuse", () => {
    expect(decideRow(atAuto, false, true)).toEqual({ action: "refuse-generator" });
  });
  it("an undefined field reads as false", () => {
    expect(decideRow({ id: atAuto.id }, true, true)).toEqual({ action: "heal", target: true });
  });
});
