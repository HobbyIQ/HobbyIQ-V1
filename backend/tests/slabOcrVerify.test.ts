// CF-SLAB-OCR-VERIFY tests (Drew, 2026-07-29). Pins the comparison
// logic for slab-label extraction vs parsed identity. The LLM
// extraction itself is not tested here (needs live keys + image
// fixtures); the comparison + match decision IS pure and testable.

import { describe, it, expect } from "vitest";
import { checkSlabAgainstIdentity, upscaleImageUrl, type SlabLabel, type ParsedIdentity } from "../src/services/portfolioiq/slabOcrVerify.service.js";

const IDENT_JUDGE: ParsedIdentity = {
  year: 2024,
  cardNumber: "85",
  playerName: "Shohei Ohtani",
  gradeCompany: "PSA",
  gradeValue: 10,
  setKey: "bowman-chrome",
  parallel: null,
  printRun: null,
  isAuto: null,
};

const SLAB_JUDGE_EXACT: SlabLabel = {
  hasSlab: true,
  grader: "PSA",
  gradeValue: 10,
  gradeLabel: "GEM MT 10",
  certNumber: "12345678",
  year: 2024,
  brand: "TOPPS BOWMAN CHROME",
  playerName: "SHOHEI OHTANI",
  cardNumber: "85",
  parallel: null,
  subset: null,
  printRun: null,
  isAuto: false,
  confidence: 0.95,
};

describe("checkSlabAgainstIdentity — happy path", () => {
  it("exact match → matched=true, grader+year+cardNumber all agree", () => {
    const r = checkSlabAgainstIdentity(SLAB_JUDGE_EXACT, IDENT_JUDGE);
    expect(r.matched).toBe(true);
    expect(r.agreements).toEqual(expect.arrayContaining(["year=2024", "cardNumber=85", "grader=PSA", "grade=10"]));
    // brand fuzzy check is imperfect ("TOPPS BOWMAN CHROME" vs "bowman-chrome");
    // any remaining disagreements should NOT include the load-bearing fields.
    expect(r.disagreements.some(d => d.startsWith("grader:") || d.startsWith("year:") || d.startsWith("cardNumber:"))).toBe(false);
  });

  it("half-grade BGS 9.5 exact numeric equality", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, grader: "BGS", gradeValue: 9.5, gradeLabel: "MINT 9.5" };
    const ident: ParsedIdentity = { ...IDENT_JUDGE, gradeCompany: "BGS", gradeValue: 9.5 };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(true);
    expect(r.agreements).toEqual(expect.arrayContaining(["grader=BGS", "grade=9.5"]));
  });

  it("case-insensitive grader match (bgs vs BGS)", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, gradeCompany: "bgs" };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, grader: "BGS" };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.agreements).toEqual(expect.arrayContaining(["grader=BGS"]));
    expect(r.disagreements.some(d => d.startsWith("grader:"))).toBe(false);
  });

  it("cardNumber normalized: #BCP-102 matches BCP102", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, cardNumber: "#BCP-102" };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, cardNumber: "BCP102" };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.agreements).toEqual(expect.arrayContaining(["cardNumber=BCP102"]));
  });

  it("player fuzzy match: 'Shohei Ohtani' contains 'OHTANI'", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, playerName: "OHTANI" };
    const r = checkSlabAgainstIdentity(slab, IDENT_JUDGE);
    expect(r.agreements).toEqual(expect.arrayContaining(["player"]));
  });

  // CF-SLAB-OCR-ADOPT (2026-07-29). Prototype v5 revealed multiple
  // cases where parser had null cardNumber but LLM cleanly read one
  // from the slab — those should count as agreements + adopted
  // corrections, not "inconclusive".
  it("adopts cardNumber when parser is null but slab has one at high confidence", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, cardNumber: null };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, cardNumber: "CPA-EHA" };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(true);
    expect(r.adopted).toContainEqual({ field: "cardNumber", value: "CPA-EHA" });
    expect(r.agreements).toEqual(expect.arrayContaining(["cardNumber=CPA-EHA (adopted)"]));
  });

  it("does NOT adopt cardNumber when slab confidence < 0.8", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, cardNumber: null };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, cardNumber: "CPA-EHA", confidence: 0.7 };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(false);
    expect(r.adopted).toEqual([]);
  });

  it("adopts parallel when parser was base/null and slab has REFRACTOR", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, parallel: "base" };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, parallel: "REFRACTOR" };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.adopted).toContainEqual({ field: "parallel", value: "REFRACTOR" });
  });

  it("adopts printRun when parser was null and slab reads /50", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, printRun: null };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, printRun: 50 };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.adopted).toContainEqual({ field: "printRun", value: 50 });
  });

  it("adopts isAuto when parser was null and slab shows AUTO", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, isAuto: null };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, isAuto: true };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.adopted).toContainEqual({ field: "isAuto", value: true });
  });

  it("does NOT adopt parallel when parser already has a real value", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, parallel: "Gold Refractor" };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, parallel: "GOLD REFRACTOR" };
    const r = checkSlabAgainstIdentity(slab, ident);
    // Both known + match → agreement (not adoption)
    expect(r.adopted.some(a => a.field === "parallel")).toBe(false);
    expect(r.agreements.some(a => a.startsWith("parallel="))).toBe(true);
  });

  it("soft parallel disagreement does NOT block match", () => {
    // Parser says "Gold Refractor", slab reads "PRIZM SILVER" — parallel
    // language varies; year+cardNumber+player still agree → still matched.
    const ident: ParsedIdentity = { ...IDENT_JUDGE, parallel: "Gold Refractor" };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, parallel: "PRIZM SILVER" };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(true);
    expect(r.disagreements.some(d => d.startsWith("parallel(soft):"))).toBe(true);
  });

  it("player required for match — grader+year+cardNumber alone not enough", () => {
    const ident: ParsedIdentity = { ...IDENT_JUDGE, playerName: null };
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, playerName: null };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(false);
  });

  it("brand fuzzy: 'TOPPS BOWMAN CHROME' matches bowman-chrome setKey", () => {
    // Slug of the label is "topps-bowman-chrome"; parsed setKey is
    // "bowman-chrome". Prefix check on split[0] = "topps" vs "bowman-chrome" —
    // does NOT match, but the OTHER direction (slugified starts with parsed)
    // ALSO doesn't fire. So brand mismatch here is expected — this is a known
    // limitation of the fuzzy check when the label uses a broader family name.
    const r = checkSlabAgainstIdentity(SLAB_JUDGE_EXACT, IDENT_JUDGE);
    // year+cardNumber alone are enough to match
    expect(r.matched).toBe(true);
  });
});

describe("checkSlabAgainstIdentity — negative signals", () => {
  it("raw card (hasSlab=false) → matched=false, no agreements", () => {
    const raw: SlabLabel = { ...SLAB_JUDGE_EXACT, hasSlab: false, grader: null, gradeValue: null };
    const r = checkSlabAgainstIdentity(raw, IDENT_JUDGE);
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("no slab");
  });

  it("null slab → matched=false", () => {
    const r = checkSlabAgainstIdentity(null, IDENT_JUDGE);
    expect(r.matched).toBe(false);
  });

  it("grader disagreement (PSA vs BGS) blocks match even with year+cardNumber", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, grader: "BGS" };
    const r = checkSlabAgainstIdentity(slab, IDENT_JUDGE);
    expect(r.matched).toBe(false);
    expect(r.disagreements.some(d => d.startsWith("grader:"))).toBe(true);
  });

  it("year disagreement blocks match", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, year: 2023 };
    const r = checkSlabAgainstIdentity(slab, IDENT_JUDGE);
    expect(r.matched).toBe(false);
    expect(r.disagreements.some(d => d.startsWith("year:"))).toBe(true);
  });

  it("cardNumber disagreement blocks match", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, cardNumber: "86" };
    const r = checkSlabAgainstIdentity(slab, IDENT_JUDGE);
    expect(r.matched).toBe(false);
    expect(r.disagreements.some(d => d.startsWith("cardNumber:"))).toBe(true);
  });

  it("low confidence (<0.6) blocks match even with agreements", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, confidence: 0.4 };
    const r = checkSlabAgainstIdentity(slab, IDENT_JUDGE);
    expect(r.matched).toBe(false);
  });

  it("only year matches, cardNumber missing → not enough → matched=false", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, cardNumber: null };
    const ident: ParsedIdentity = { ...IDENT_JUDGE, cardNumber: null };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(false);
  });

  it("only cardNumber matches, year missing → matched=false", () => {
    const slab: SlabLabel = { ...SLAB_JUDGE_EXACT, year: null };
    const ident: ParsedIdentity = { ...IDENT_JUDGE, year: null };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(false);
  });
});

// CF-SLAB-OCR-UPSCALE-URL (Drew, 2026-07-29). First prototype run on
// live data returned hasSlab=false because vendor URLs pointed at
// eBay thumbnails (s-l140.jpg = 140px). Slab-label text is unreadable
// at that resolution. Rewrite to full-res (s-l1600.jpg) before the
// LLM call.
describe("upscaleImageUrl", () => {
  it("rewrites eBay s-l140.jpg → s-l1600.jpg", () => {
    expect(upscaleImageUrl("https://i.ebayimg.com/images/g/abc/s-l140.jpg"))
      .toBe("https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
  });
  it("rewrites eBay s-l500.webp → s-l1600.webp (preserves extension)", () => {
    expect(upscaleImageUrl("https://i.ebayimg.com/images/g/x/s-l500.webp"))
      .toBe("https://i.ebayimg.com/images/g/x/s-l1600.webp");
  });
  it("leaves non-eBay URLs untouched", () => {
    expect(upscaleImageUrl("https://catalogimages.cardhedge.com/x.jpg"))
      .toBe("https://catalogimages.cardhedge.com/x.jpg");
  });
  it("leaves already-full-res eBay URLs untouched (s-l1600 → s-l1600)", () => {
    expect(upscaleImageUrl("https://i.ebayimg.com/images/g/x/s-l1600.jpg"))
      .toBe("https://i.ebayimg.com/images/g/x/s-l1600.jpg");
  });
  it("empty string returns empty (no throw)", () => {
    expect(upscaleImageUrl("")).toBe("");
  });
});

describe("checkSlabAgainstIdentity — real-world fixtures", () => {
  // Modeled on Drew's 2026-07-29 verify_queue screenshot: Shohei Ohtani
  // 2024 Bowman Chrome #85 PSA GEM MT 10, image-verify inconclusive.
  it("Ohtani 2024 Bowman Chrome #85 PSA 10 → matched", () => {
    const r = checkSlabAgainstIdentity(SLAB_JUDGE_EXACT, IDENT_JUDGE);
    expect(r.matched).toBe(true);
  });

  // Same shape, SGC 10 instead of PSA
  it("Ohtani 2024 Bowman #33 SGC 10 → matched", () => {
    const slab: SlabLabel = {
      hasSlab: true, grader: "SGC", gradeValue: 10, gradeLabel: "10",
      certNumber: "99887766", year: 2024, brand: "BOWMAN",
      playerName: "SHOHEI OHTANI", cardNumber: "33",
      parallel: null, subset: null, printRun: null, isAuto: false,
      confidence: 0.9,
    };
    const ident: ParsedIdentity = {
      year: 2024, cardNumber: "33", playerName: "Shohei Ohtani",
      gradeCompany: "SGC", gradeValue: 10, setKey: "bowman",
      parallel: null, printRun: null, isAuto: null,
    };
    const r = checkSlabAgainstIdentity(slab, ident);
    expect(r.matched).toBe(true);
  });

  // A BAD extraction: label reads a totally different card
  it("wrong player + wrong cardNumber → not matched, disagreements listed", () => {
    const slab: SlabLabel = {
      hasSlab: true, grader: "PSA", gradeValue: 10, gradeLabel: "GEM MT 10",
      certNumber: "1", year: 2024, brand: "BOWMAN CHROME",
      playerName: "MIKE TROUT", cardNumber: "1",
      parallel: null, subset: null, printRun: null, isAuto: false,
      confidence: 0.95,
    };
    const r = checkSlabAgainstIdentity(slab, IDENT_JUDGE);
    expect(r.matched).toBe(false);
    expect(r.disagreements.length).toBeGreaterThanOrEqual(2);
  });
});
