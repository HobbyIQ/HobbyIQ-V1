// CF-BUYERIQ-GRADE-AWARE-MATCH (Drew, 2026-09-03). Pins the grade half
// of the deal scanner's identity check.
//
// The defect: the matcher was GRADE-BLIND. It verified parallel and
// player, then measured the ask against the target tier's projection
// without ever checking the listing was IN that tier. A raw card
// "discounted" against the PSA 10 price. 6 of 8 sampled deals were this.
//
// The doctrine these tests encode (D21 — the grade curve IS the graded
// card): FMV is per exact identity INCLUDING grade tier; a deal is a
// listing under the projected next sale of ITS OWN tier; an unreadable
// grade is REFUSED, never defaulted to raw and never to the best tier.

import { describe, expect, it } from "vitest";
import {
  readListingGrade,
  listingMatchesGrade,
  isLotListing,
} from "../src/services/buyeriq/listingGradeMatch.js";

const RAW = { gradeCompany: null, gradeValue: null };
const PSA10 = { gradeCompany: "PSA", gradeValue: 10 };
const PSA9 = { gradeCompany: "PSA", gradeValue: 9 };
const BGS95 = { gradeCompany: "BGS", gradeValue: 9.5 };

describe("readListingGrade — raw, graded and UNKNOWN are three different things", () => {
  it("reads an explicit slab off the title", () => {
    const r = readListingGrade("2021 Bowman Chrome Julio Rodriguez #BCP-50 PSA 10 GEM MINT");
    expect(r.kind).toBe("graded");
    if (r.kind !== "graded") throw new Error("unreachable");
    expect(r.company).toBe("PSA");
    expect(r.value).toBe(10);
  });

  it("reads a half grade and a non-PSA company", () => {
    const r = readListingGrade("2018 Topps Shohei Ohtani #700 RC BGS 9.5");
    expect(r).toMatchObject({ kind: "graded", company: "BGS", value: 9.5 });
  });

  it("reads an AFFIRMATIVE raw assertion as raw", () => {
    expect(readListingGrade("2021 Bowman Chrome Julio Rodriguez #BCP-50 RC Raw").kind).toBe("raw");
    expect(readListingGrade("2017 Topps Aaron Judge #287 RC ungraded nice card").kind).toBe("raw");
    expect(readListingGrade("2020 Prizm Herbert #325 not graded").kind).toBe("raw");
  });

  // THE CORE OF THE FIX. Silence is not evidence of raw. Most raw
  // listings say nothing — and so do plenty of graded ones whose grade
  // sits in item specifics we never fetch (ActiveListing carries no
  // condition/aspects field at all).
  it("PINNED: a title that says NOTHING about grade is unknown, NOT raw", () => {
    expect(readListingGrade("2021 Bowman Chrome Julio Rodriguez #BCP-50 Blue Refractor /150").kind)
      .toBe("unknown");
    expect(readListingGrade("2018 Topps Shohei Ohtani #700 Rookie").kind).toBe("unknown");
  });

  it("PINNED: marketing condition words are NOT a grade", () => {
    // "MINT condition" is a seller adjective on a raw card, not a slab.
    expect(readListingGrade("Mike Trout 2011 Topps Update #US175 RC MINT condition sharp corners").kind)
      .not.toBe("graded");
    expect(readListingGrade("2019 Prizm Zion Williamson #248 Silver NM-MT").kind).not.toBe("graded");
  });

  it("a slab is named but the number is not readable -> unknown, not raw", () => {
    // "PSA graded" with no number: definitely not raw, and not a tier.
    expect(readListingGrade("2022 Topps Chrome Julio Rodriguez PSA graded beauty").kind)
      .toBe("unknown");
  });

  it("a contradictory title (says raw AND names a grader) is unknown, not raw", () => {
    expect(readListingGrade("2021 Bowman Julio Rodriguez PSA 10 comp - raw card here").kind)
      .not.toBe("raw");
  });

  it("a multi-card lot has no single tier", () => {
    expect(isLotListing("2022 Topps Chrome Julio Rodriguez #220 lot of 3 raw cards")).toBe(true);
    expect(readListingGrade("2022 Topps Chrome Julio Rodriguez #220 lot of 3 raw cards").kind)
      .toBe("unknown");
  });

  it("keeps Black Label distinct from an ordinary BGS 10", () => {
    const r = readListingGrade("2021 Bowman Chrome Julio Rodriguez BGS 10 Black Label");
    expect(r).toMatchObject({ kind: "graded", company: "BGS", value: 10, isBlackLabel: true });
  });
});

describe("PINNED: raw vs PSA 10 — the exact false positive the verifier found", () => {
  // The fixture that must refuse. A raw card at $120 against a PSA 10
  // projection of $400 is a 70% "discount" only if you never checked
  // what you were comparing.
  const RAW_TITLE = "2021 Bowman Chrome Julio Rodriguez #BCP-50 RC Raw Ungraded";

  it("a RAW listing does NOT match a PSA 10 target", () => {
    const v = listingMatchesGrade(RAW_TITLE, PSA10);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("listing-raw-target-graded");
  });

  it("a PSA 10 listing does NOT match a RAW target", () => {
    const v = listingMatchesGrade("2021 Bowman Chrome Julio Rodriguez #BCP-50 PSA 10", RAW);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("listing-graded-target-raw");
  });

  it("a RAW listing DOES match a raw target", () => {
    expect(listingMatchesGrade(RAW_TITLE, RAW).ok).toBe(true);
  });
});

describe("PINNED: a PSA 9 listing matches the PSA 9 tier ONLY", () => {
  const PSA9_TITLE = "2020 Panini Prizm Justin Herbert #325 PSA 9 Rookie";

  it("matches its own tier", () => {
    expect(listingMatchesGrade(PSA9_TITLE, PSA9).ok).toBe(true);
  });

  it("does NOT match PSA 10 — a 9 is not a cheap 10", () => {
    const v = listingMatchesGrade(PSA9_TITLE, PSA10);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("grade-value-mismatch");
  });

  it("does NOT match raw", () => {
    expect(listingMatchesGrade(PSA9_TITLE, RAW).ok).toBe(false);
  });

  it("does NOT match the same number from a DIFFERENT company", () => {
    const v = listingMatchesGrade(PSA9_TITLE, { gradeCompany: "BGS", gradeValue: 9 });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("grade-company-mismatch");
  });

  it("BGS 9.5 matches BGS 9.5 and nothing else", () => {
    const t = "2018 Topps Shohei Ohtani #700 RC BGS 9.5";
    expect(listingMatchesGrade(t, BGS95).ok).toBe(true);
    expect(listingMatchesGrade(t, { gradeCompany: "BGS", gradeValue: 9 }).ok).toBe(false);
    expect(listingMatchesGrade(t, PSA10).ok).toBe(false);
  });
});

describe("PINNED: an unreadable grade is NOT SCORED — never defaulted", () => {
  const SILENT = "2021 Bowman Chrome Julio Rodriguez #BCP-50 Blue Refractor /150";

  it("refuses against a graded target rather than assuming the tier", () => {
    const v = listingMatchesGrade(SILENT, PSA10);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("grade-unknown");
  });

  // Both directions matter. Defaulting to raw would make every silent
  // slab listing a "deal" against the raw projection.
  it("refuses against a RAW target rather than assuming raw", () => {
    const v = listingMatchesGrade(SILENT, RAW);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("grade-unknown");
  });

  it("refuses when the target names a company but no number", () => {
    const v = listingMatchesGrade("2021 Bowman Julio Rodriguez PSA 10", {
      gradeCompany: "PSA",
      gradeValue: null,
    });
    expect(v.ok).toBe(false);
  });

  it("an empty or missing title is unknown, not raw", () => {
    expect(listingMatchesGrade("", RAW).ok).toBe(false);
    expect(listingMatchesGrade(null, RAW).ok).toBe(false);
  });

  it("an Authentic slab never satisfies a numeric tier", () => {
    const v = listingMatchesGrade("2019 Bowman Chrome Wander Franco CGC AUTH", {
      gradeCompany: "CGC",
      gradeValue: 10,
    });
    expect(v.ok).toBe(false);
  });
});
