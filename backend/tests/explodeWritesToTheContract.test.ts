/**
 * CF-EXPLODE-WRITES-TO-THE-CONTRACT (Drew, 2026-08-26).
 *
 * The nightly grade explosion wrote 19,043,573 rows in 16 hours, 11,441,770 of
 * them into a foreign partition, including 1,462,513 PSA 9.5 rows for a grade
 * PSA does not issue. It re-created the exact damage the re-home was repairing,
 * about ten times faster than the repair could undo it.
 *
 * These tests pin the three properties that were wrong, against a parent row
 * built to be broken in the way real parents are broken.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildGradedRow, GRADE_TIERS, ISSUED_TIERS } = require("../scripts/explodeCatalogGrades.cjs");

/** A parent stranded under a vendor Bubble id, carrying full checklist detail. */
const BROKEN_PARENT = {
  id: "hiq:baseball:2026:bowman:cpa-ksn:base:auto",
  cardId: "1659659350320x270619081084220830",
  hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-ksn:base:auto",
  sport: "baseball", year: 2026, cardYear: 2026,
  setKey: "bowman", setName: "2026 Bowman Baseball",
  cardNumber: "CPA-KSN", playerName: "Kade Snell", playerSlug: "kade-snell",
  team: "Marlins", subsetName: "Chrome Prospect Autographs",
  displayName: "2026 Bowman Baseball Chrome Prospect Autographs #CPA-KSN Kade Snell Base",
  parallel: "Base", parallelSlug: "base", isAuto: true, printRun: null,
  imageUrl: "https://img/x.jpg", vendorIds: { cardhedge: "abc" },
  source: "baseballcardpedia", searchTokens: ["2026", "bowman", "kade", "snell"],
  _rid: "zzz", _self: "s", _etag: "e", _ts: 1,
};

const tier = (name: string) => ISSUED_TIERS.find((t: { tier: string }) => t.tier === name);

describe("every graded row owns its own partition", () => {
  it("sets cardId to its own slug, not the parent's", () => {
    const row = buildGradedRow(BROKEN_PARENT, tier("psa-10"));
    expect(row.id).toBe("hiq:baseball:2026:bowman:cpa-ksn:base:auto:psa-10");
    expect(row.cardId).toBe(row.id);
  });

  it("does NOT inherit a broken parent partition key", () => {
    // This is how 16.4M rows became invisible to the matcher: a parent stranded
    // under a vendor id handed that address to every one of its graded children.
    const row = buildGradedRow(BROKEN_PARENT, tier("psa-10"));
    expect(row.cardId).not.toBe(BROKEN_PARENT.cardId);
  });

  it("keeps hobbyiqCardId and parentSlug distinct", () => {
    const row = buildGradedRow(BROKEN_PARENT, tier("bgs-9-5"));
    expect(row.hobbyiqCardId).toBe(row.id);
    expect(row.parentSlug).toBe(BROKEN_PARENT.hobbyiqCardId);
  });
});

describe("only grades the company actually issues", () => {
  it("drops PSA 9.5 — the tier that made 1,462,513 ungradeable rows", () => {
    expect(GRADE_TIERS.some((t: { tier: string }) => t.tier === "psa-9-5")).toBe(true);
    expect(ISSUED_TIERS.some((t: { tier: string }) => t.tier === "psa-9-5")).toBe(false);
  });

  it("keeps 9.5 for the graders that do issue it", () => {
    expect(ISSUED_TIERS.some((t: { tier: string }) => t.tier === "bgs-9-5")).toBe(true);
    expect(ISSUED_TIERS.some((t: { tier: string }) => t.tier === "cgc-9-5")).toBe(true);
  });

  it("keeps raw, which is not a grade at all", () => {
    expect(ISSUED_TIERS.some((t: { tier: string }) => t.tier === "raw")).toBe(true);
  });

  it("keeps BGS 10 Black Label distinct from BGS 10", () => {
    // Same number, two very differently priced cards. Collapsing them is what
    // produced a BGS 10 population at exactly 2.00x every other rung.
    const black = ISSUED_TIERS.find((t: { tier: string }) => t.tier === "bgs-10-black");
    const plain = ISSUED_TIERS.find((t: { tier: string }) => t.tier === "bgs-10");
    expect(black).toBeTruthy();
    expect(plain).toBeTruthy();
    expect(black.slug).not.toBe(plain.slug);
    expect(black.gradeQualifier).toBe("Black Label");
  });
});

describe("a graded card is its parent card plus a grade", () => {
  it("carries every checklist field the parent had", () => {
    // The old builder hand-listed fields, so anything the checklist knew and
    // that list did not was dropped from all ~16M graded rows -- and these are
    // exactly the fields a matcher discriminates on.
    const row = buildGradedRow(BROKEN_PARENT, tier("psa-9"));
    for (const f of ["team", "subsetName", "displayName", "playerSlug", "imageUrl",
                     "cardYear", "vendorIds", "setName", "parallelSlug", "isAuto"]) {
      expect(row[f], `${f} was dropped`).toBeDefined();
    }
    expect(row.team).toBe("Marlins");
    expect(row.subsetName).toBe("Chrome Prospect Autographs");
  });

  it("strips Cosmos internals so the copy is writable", () => {
    const row = buildGradedRow(BROKEN_PARENT, tier("psa-9"));
    for (const f of ["_rid", "_self", "_etag", "_attachments", "_ts"]) {
      expect(row[f], `${f} leaked`).toBeUndefined();
    }
  });

  it("stamps the grade over any grade the parent carried", () => {
    const parentWithGrade = { ...BROKEN_PARENT, gradeCompany: "SGC", gradeValue: 8 };
    const row = buildGradedRow(parentWithGrade, tier("psa-10"));
    expect(row.gradeCompany).toBe("PSA");
    expect(row.gradeValue).toBe(10);
  });

  it("adds grade tokens to the parent's search tokens", () => {
    const row = buildGradedRow(BROKEN_PARENT, tier("psa-10"));
    expect(row.searchTokens).toEqual(expect.arrayContaining(["kade", "snell", "psa-10", "psa", "10"]));
  });

  it("refuses a parent with no slug rather than inventing one", () => {
    expect(buildGradedRow({ ...BROKEN_PARENT, hobbyiqCardId: null }, tier("psa-10"))).toBeNull();
  });
});
