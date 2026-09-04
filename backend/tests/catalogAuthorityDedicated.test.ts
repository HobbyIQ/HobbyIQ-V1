/**
 * D29/R2 -- isDedicatedChecklist / isBcpFamily.
 *
 * "The checklist that names the product wins; bcp's Bowman page is not that."
 * (Drew, 2026-08-30.) That question is NARROWER than canAdjudicate, which asks
 * only whether a row is evidence at all -- and for THAT question
 * baseballcardpedia's 918,828 rows are emphatically yes.
 *
 * So the second half of this file is the important half: it pins that adding
 * the new predicate did not perturb a single existing answer. Widening the
 * CHECKLIST regex in place would have moved canAdjudicate, isReKeyable and
 * authorityRank with it -- the "right guard, wrong scope" shape that produced
 * #1177-#1180. If a future edit tries it, these tests fail.
 */
import { describe, it, expect } from "vitest";
import {
  catalogAuthorityOf, canAdjudicate, isReKeyable, authorityRank,
  isDedicatedChecklist, isBcpFamily,
} from "../src/services/catalog/catalogAuthority.service.js";

/** Every source string measured in the bowman CPA scope on 2026-08-30. */
const DEDICATED = [
  "checklistinsider-2026-08-27", "checklistcenter-2026-08-29", "checklistinsider-2026-08-29",
  "beckett-checklist-2026-08-27", "beckett-checklist", "beckett-scraped-2026-08-30",
  "beckett-scraped-2026-08-27", "beckett-scraped-2026-08-25", "beckett-scraped-2026-08-26",
  "cardboardchecklist-scraped-2026-08-14", "checklistcenter-2026-08-30", "checklistcenter",
  "beckett-checklist-2026-08-29",
];
const BCP = ["baseballcardpedia", "bccp", "baseballcardpedia-ladders-2026-08-11", "bccp-graded"];
const NEITHER = [
  "checklistcenter-html", "ingest-auto-seed", "catalog-explode-actuals-2026-08-12",
  "sold-comps-stub-2026-08-12", "sales-attested", "subset-unfold", "cardhedge",
  "hobbymonitor-scraped-2026-08-18", "cardsight", "ebay", "", null, undefined,
];

describe("isDedicatedChecklist -- which sources may name a PRODUCT", () => {
  it("is true for every dedicated per-release transcription, dated runs included", () => {
    for (const s of DEDICATED) expect(isDedicatedChecklist(s), s).toBe(true);
  });

  it("is true for a -graded twin, which has its parent's provenance", () => {
    expect(isDedicatedChecklist("checklistcenter-2026-08-29-graded")).toBe(true);
    expect(isDedicatedChecklist("beckett-checklist-graded")).toBe(true);
  });

  it("is FALSE for the bcp family -- a wiki product page does not name the product", () => {
    for (const s of BCP) expect(isDedicatedChecklist(s), s).toBe(false);
  });

  it("is FALSE for checklistcenter-html, exactly as isTranscriptionGrade has it", () => {
    // Same site, different extraction, the dirtiest source measured.
    expect(isDedicatedChecklist("checklistcenter-html")).toBe(false);
    expect(isDedicatedChecklist("checklistcenter")).toBe(true);
  });

  it("is FALSE for derived, vendor and unknown sources", () => {
    for (const s of NEITHER) expect(isDedicatedChecklist(s), String(s)).toBe(false);
  });

  it("never promotes a derived source that embeds a checklist-ish word", () => {
    expect(isDedicatedChecklist("sold-comps-stub-beckett")).toBe(false);
  });
});

describe("isBcpFamily", () => {
  it("names exactly the wiki sources", () => {
    for (const s of BCP) expect(isBcpFamily(s), s).toBe(true);
    for (const s of [...DEDICATED, ...NEITHER]) expect(isBcpFamily(s), String(s)).toBe(false);
  });
});

describe("the new predicate perturbs NOTHING that already existed", () => {
  const ALL = [...DEDICATED, ...BCP, ...NEITHER.filter((s): s is string => typeof s === "string" && s !== "")];

  it("keeps every bcp-family source classified as checklist and able to adjudicate", () => {
    // R2 is about PRODUCT identity only. bcp remains evidence that a card
    // exists, remains rank 3, and remains un-re-keyable.
    for (const s of BCP) {
      expect(catalogAuthorityOf(s), s).toBe("checklist");
      expect(canAdjudicate(s), s).toBe(true);
      expect(isReKeyable(s), s).toBe(false);
      expect(authorityRank(s), s).toBe(3);
    }
  });

  it("pins catalogAuthorityOf for every source in the CPA scope", () => {
    const expected: Record<string, string> = {
      "checklistcenter-2026-08-29": "checklist",
      "checklistinsider-2026-08-27": "checklist",
      "beckett-checklist": "checklist",
      "beckett-scraped-2026-08-30": "checklist",
      "cardboardchecklist-scraped-2026-08-14": "checklist",
      "checklistcenter-html": "checklist",
      baseballcardpedia: "checklist",
      bccp: "checklist",
      "hobbymonitor-scraped-2026-08-18": "checklist",
      "ingest-auto-seed": "derived",
      "sold-comps-stub-2026-08-12": "derived",
      "catalog-explode-actuals-2026-08-12": "derived",
      // CF-A-DERIVED-SOURCE-MAY-NOT-SPELL-CHECKLIST (2026-09-04): this pinned
      // "unknown", which is rank 0 -- BELOW the ingest-auto-seed rows it is a
      // sibling of. It is a row attested by our own sales, so it is derived.
      "sales-attested": "derived",
      "subset-unfold": "unknown",
      cardhedge: "vendor",
      cardsight: "vendor",
      ebay: "vendor",
    };
    for (const [s, want] of Object.entries(expected)) expect(catalogAuthorityOf(s), s).toBe(want);
  });

  it("dedicated is a strict SUBSET of can-adjudicate -- never the other way round", () => {
    for (const s of ALL) {
      if (isDedicatedChecklist(s)) expect(canAdjudicate(s), `${s} is dedicated but cannot adjudicate`).toBe(true);
    }
    // And the subset is proper: something adjudicates without being dedicated.
    expect(ALL.some((s) => canAdjudicate(s) && !isDedicatedChecklist(s))).toBe(true);
  });
});
