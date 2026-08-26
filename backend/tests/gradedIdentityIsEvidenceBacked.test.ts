/**
 * CF-GRADED-IDENTITY-FROM-EVIDENCE (Drew, 2026-08-26).
 *
 * A graded card is now an identity you can hold in inventory, not just a field
 * on a sale. Two things must stay true about how those identities are minted:
 * a grade nobody issues can never become one, and a grader we do not model
 * cannot invent catalog entities out of two sales.
 *
 * PSA 9.5 is the specific one. It got into a hardcoded tier table once and
 * produced 1,462,513 rows for a grade PSA has never issued, all of which had
 * to be deleted. It must not be able to come back through this door.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tierFor, tierSlug } = require("../scripts/materialize-graded-identities.cjs");

describe("a grade nobody issues never becomes an identity", () => {
  it("refuses PSA 9.5 — the grade that cost 1,462,513 rows", () => {
    expect(tierFor("PSA", 9.5, null)).toBeNull();
  });

  it("allows 9.5 for the graders that do issue it", () => {
    expect(tierFor("BGS", 9.5, null)).not.toBeNull();
    expect(tierFor("CGC", 9.5, null)).not.toBeNull();
    expect(tierFor("SGC", 9.5, null)).not.toBeNull();
  });

  it("allows the PSA grades that are real", () => {
    for (const v of [8, 8.5, 9, 10]) {
      expect(tierFor("PSA", v, null), `PSA ${v} should be issuable`).not.toBeNull();
    }
  });
});

describe("only graders we model get identities", () => {
  it("rejects the long tail rather than inventing entities from a handful of sales", () => {
    // Real values observed in sold_comps, together ~0.15% of graded sales.
    for (const co of ["The Final Authority", "USA Sports Cards", "Rare Edition", "UNKNOWN", "BVG"]) {
      expect(tierFor(co, 10, null), `${co} should not mint an identity`).toBeNull();
    }
  });

  it("KNOWN WART: MNT Grading canonicalises to AGS", () => {
    // gradeLadder folds "MNT GRADING" and "MINT GRADING SERVICE" onto AGS.
    // Folding the two spellings together is right -- they are one company --
    // but that company is not Automated Grading Systems, so ~33 sales will
    // mint identities under the wrong grader name.
    //
    // Deliberately not fixed: AGS's ladder is the full 1..10 half-point scale,
    // so isImpossibleGrade can never condemn an MNT grade and no delete
    // predicate is at risk. It is a labelling wart on 0.0009% of graded sales.
    // Pinned so it is a decision on record rather than a surprise later.
    expect(tierFor("MNT Grading", 10, null)?.gradeCompany).toBe("AGS");
  });

  it("accepts the four that carry 99.85% of graded sales", () => {
    for (const co of ["PSA", "BGS", "SGC", "CGC"]) {
      expect(tierFor(co, 9, null), `${co} should mint`).not.toBeNull();
    }
  });

  it("canonicalises the company onto the tier", () => {
    expect(tierFor("psa", 10, null)?.gradeCompany).toBe("PSA");
  });
});

describe("a qualifier is part of the identity", () => {
  it("keeps PSA 8 OC distinct from PSA 8 — it is a differently priced card", () => {
    const plain = tierFor("PSA", 8, null);
    const oc = tierFor("PSA", 8, "OC");
    expect(plain?.slug).toBe("psa-8");
    expect(oc?.slug).toBe("psa-8-oc");
    expect(oc?.slug).not.toBe(plain?.slug);
    expect(oc?.gradeQualifier).toBe("OC");
  });

  it("renders half grades without a decimal point, so the slug stays a slug", () => {
    expect(tierSlug("BGS", 9.5, null)).toBe("bgs-9-5");
    expect(tierSlug("PSA", 10, null)).toBe("psa-10");
  });

  it("treats a missing qualifier as null, not the string 'null'", () => {
    expect(tierFor("PSA", 10, undefined)?.gradeQualifier).toBeNull();
  });
});
