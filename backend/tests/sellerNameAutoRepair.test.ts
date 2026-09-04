/**
 * CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE.
 * The pool-side autograph detector, and the SELLER-NAME-AUTO repair subclass.
 *
 * THE DEFECT. `AUTO_RE` bounded `auto` on both sides and `autograph` on
 * NEITHER:
 *
 *     /\bauto\b|autograph|hard[-\s]signed/i
 *
 * so the letters a-u-t-o-g-r-a-p-h anywhere inside a longer word read as an
 * autograph. eBay sellers append their shop name to the listing title, and one
 * shop is enormous: 102,621 of 271,664 scanned sold_comps rows carry
 * isAuto=true on this defect, 102,482 from the single phrase "autographden",
 * across ~40 years — 1991 panini-donruss 1,869; 1983 fleer 1,804; 2024
 * panini-donruss 1,645; 2019 bowman 1,644; 1982 fleer 1,499. Base cards priced
 * as autographs, and every real autograph pool diluted with base sales.
 *
 * The titles below are the REAL ones from sold_comps, not invented fixtures.
 *
 * THE MUTATION PINS ARE THE LOAD-BEARING TESTS. Everything else asserts the
 * fix does what it says; these assert it stops doing it when a piece is
 * removed, and they are red in BOTH directions:
 *
 *   1. UNBOUND `autograph` AGAIN — the base cards go back to isAuto=true.
 *      That is the shipped defect, restored.
 *   2. DROP `autographics` FROM THE WITNESS — real Skybox autographs flip to
 *      isAuto=false. Measured on the shipped parser BEFORE this change, all
 *      three of those titles read true; a boundary applied without naming the
 *      set would have silently caused the same damage in the opposite
 *      direction. The seller-name fix must cost nothing on cards that really
 *      are signed.
 *   3. DROP THE CHECKLIST LEG (S3) — a row with no checklist, or one whose
 *      checklist says the card IS an auto, must never be repaired. Without S3
 *      the subclass is not evidence, it is a title-word reader running
 *      backwards, and it would strip the flag off real autographs the shop
 *      happened to sell.
 *   4. DROP THE CARD-NUMBER LEG (S4) — CF-ISAUTO-BOUNDARY-IS-CARDNUMBER is the
 *      ruling this area runs on: the checklist's auto-subset prefix is
 *      SUFFICIENT evidence and outranks any title reading, in both directions.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  AUTO_RE,
  LEGACY_AUTO_RE,
  autographWitnessIsSellerNameOnly,
  parseListingIdentity,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");

/** REAL titles, from sold_comps. The shop-name rows are plain base cards. */
const SELLER_BASE = [
  "Vladimir Guerrero Jr. 2025 Bowman #27 Blue Jays MLB READ FREE SHIP AutographDen",
  "Bryce Harper 2025 Bowman #3 Phillies MLB READ FREE SHIPPING AutographDen",
  "Mookie Betts 2025 Bowman #16 Dodgers MLB READ FREE SHIPPING AutographDen",
  "Christian Yelich 2025 Bowman #67 Brewers MLB READ FREE SHIPPING AutographDen",
  "Alex Bregman 2025 Bowman Chrome #15 Red Sox MLB READ FREE SHIPPING AutographDen",
];

/** REAL titles that ARE autographs and must stay that way. */
const REAL_AUTOS = [
  "1990 Topps Frank Thomas Autographed",
  "2019 Topps AUTO RC Mike Trout",
  "2026 Bowman - Chrome Prospect Autographs Eric Hartman #CPA-EHA (AU, RC) - Raw",
  "2024 Bowman Chrome - Prospect Autographs Leo De Vries #CPA-LD (AU, RC)",
  "Wander Franco Signed Autographed 2022 Bowman #12 Baseball Card Beckett",
];

/** `Autographics` is a REAL Skybox insert set, not a shop. These are autographs. */
const AUTOGRAPHICS = [
  "2004-05 Skybox Autographics Reggie Miller #47 HOF 9hx",
  "1996-97 Skybox Premium - Autographics Lee Mayberry Black Ink (AU) - Raw",
  "2006 Flair Showcase - Autographics Joel Pineiro #SC-JP (AU)",
];

describe("the detector: a shop name is not a signature", () => {
  it("reads a base card sold by AutographDen as NOT an autograph", () => {
    for (const t of SELLER_BASE) {
      expect(parseListingIdentity(t).isAuto, t).not.toBe(true);
    }
  });

  it("still reads a real autograph as one", () => {
    for (const t of REAL_AUTOS) {
      expect(parseListingIdentity(t).isAuto, t).toBe(true);
    }
  });

  it("keeps the flag on Skybox Autographics — a set, not a store", () => {
    for (const t of AUTOGRAPHICS) {
      expect(parseListingIdentity(t).isAuto, t).toBe(true);
    }
  });

  it("bounds autograph to its real inflections", () => {
    expect(AUTO_RE.test("Autographed")).toBe(true);
    expect(AUTO_RE.test("Autographs")).toBe(true);
    expect(AUTO_RE.test("Autograph")).toBe(true);
    // The shop name is not an inflection.
    expect(AUTO_RE.test("AutographDen")).toBe(false);
    // ...and the bare word still needs its own boundary.
    expect(AUTO_RE.test("Automobile")).toBe(false);
  });

  it("names the shop only when the shop is the WHOLE case", () => {
    // Nothing else states an autograph -> the shop name was the whole case.
    for (const t of SELLER_BASE) {
      expect(autographWitnessIsSellerNameOnly(t), t).toBe(true);
    }
    // A real auto that the shop happened to sell -> NOT seller-only.
    expect(
      autographWitnessIsSellerNameOnly("2025 Bowman Chrome Prospect Autographs #CPA-JD AutographDen"),
    ).toBe(false);
    expect(autographWitnessIsSellerNameOnly("Some Card Auto AutographDen")).toBe(false);
    // No shop token at all.
    expect(autographWitnessIsSellerNameOnly("1990 Topps Frank Thomas Autographed")).toBe(false);
  });

  it("asks the seller question against the LEGACY shape, which is why it can answer", () => {
    // The predicate must reason about what the reader THAT WROTE THE FLAG saw.
    // Under the FIXED witness `AutographDen` is already not a witness, so
    // "strip the shop and the witness disappears" would be false for every row
    // and the subclass would fire on nothing.
    expect(LEGACY_AUTO_RE.test("AutographDen")).toBe(true);
    expect(AUTO_RE.test("AutographDen")).toBe(false);
  });
});

describe("MUTATION — the detector", () => {
  it("RED: unbinding `autograph` restores the defect", () => {
    const mutated = /\bauto\b|autograph|hard[-\s]signed/i; // the shipped bug
    const stillWrong = SELLER_BASE.filter((t) => mutated.test(t));
    expect(stillWrong.length).toBe(SELLER_BASE.length);
    // ...and the fixed one calls none of them an autograph.
    expect(SELLER_BASE.filter((t) => AUTO_RE.test(t)).length).toBe(0);
  });

  it("RED: dropping `autographics` flips real autographs to false", () => {
    const mutated = /\bauto\b|\bautograph(?:ed|s)?\b|hard[-\s]signed/i; // no set name
    for (const t of AUTOGRAPHICS) {
      // The set-name row has no other witness, so without the alternation the
      // boundary silently strips a REAL autograph.
      expect(mutated.test(t), t).toBe(false);
      expect(AUTO_RE.test(t), t).toBe(true);
    }
  });
});

describe("the mirror is a cache, not a second source", () => {
  it("pins the CJS witness against the compiled authority, character for character", () => {
    expect(K.AUTO_WITNESS_RE.source).toBe(AUTO_RE.source);
    expect(K.AUTO_WITNESS_RE.flags).toBe(AUTO_RE.flags);
    expect(K.LEGACY_AUTO_WITNESS_RE.source).toBe(LEGACY_AUTO_RE.source);
    expect(K.LEGACY_AUTO_WITNESS_RE.flags).toBe(LEGACY_AUTO_RE.flags);
  });

  it("the two predicates agree on every fixture", () => {
    for (const t of [...SELLER_BASE, ...REAL_AUTOS, ...AUTOGRAPHICS]) {
      expect(K.autographWitnessIsSellerNameOnly(t), t).toBe(autographWitnessIsSellerNameOnly(t));
    }
  });
});

/** A stored row as the classifier sees it: base card, wrongly flagged auto. */
const storedAuto = {
  sport: "baseball", cardYear: 2025, setKey: "bowman", cardNumber: "27",
  parallel: "Base", isAuto: true, printRun: null, gradeCompany: null, gradeValue: null,
};
const derivedSame = { ...storedAuto };
const noMove = { same: ["sport", "cardYear", "setKey", "cardNumber", "parallel", "printRun", "grade"], filled: [], dropped: [], changed: [] };
const row = { title: SELLER_BASE[0], source: "tca-ebay" };

describe("SELLER-NAME-AUTO — the five legs", () => {
  it("qualifies when the shop is the only witness and the checklist says base", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: true, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(true);
    expect(e.failed).toEqual([]);
  });

  it("S1: a real auto the shop happened to sell STAYS", () => {
    const e = K.sellerNameAutoEvidence({
      row: { title: "2025 Bowman Chrome Prospect Autographs #CPA-JD AutographDen" },
      stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: true, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(false);
    expect(e.failed).toContain("autograph-witness-is-not-seller-only");
  });

  it("S2: it repairs a wrong flag and never sets one", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: { ...storedAuto, isAuto: false }, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: true, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(false);
    expect(e.failed).toContain("stored-is-not-auto");
  });

  it("S3: NO checklist stays CONFLICT — absent beats wrong", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: null, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(false);
    expect(e.failed).toContain("checklist-unknown");
  });

  it("S3: a checklist that says AUTO stays auto", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: false, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(false);
    expect(e.failed).toContain("checklist-says-auto");
  });

  it("S4: an auto-subset cardNumber outranks every title reading", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: true, autoByCardNumber: true,
    });
    expect(e.qualifies).toBe(false);
    expect(e.failed).toContain("cardnumber-is-auto-subset");
  });

  it("S5: nothing but isAuto may move", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: { ...derivedSame, grade: "PSA 10" },
      axes: { ...noMove, changed: ["grade"] },
      checklistSaysNotAuto: true, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(false);
    expect(e.failed.some((f: string) => f.startsWith("identity-axis-moved:"))).toBe(true);
  });
});

describe("MUTATION — the subclass", () => {
  it("RED: without S3 a real autograph would be stripped", () => {
    // The shop sold a genuine auto; the checklist says so. Every OTHER leg
    // holds, so S3 is the only thing standing between this row and a write
    // that takes the flag off a real autograph.
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: false, autoByCardNumber: false,
    });
    expect(e.qualifies).toBe(false);
    const withoutS3 = e.failed.filter((f: string) => f !== "checklist-says-auto");
    expect(withoutS3).toEqual([]); // S3 alone was holding it
  });

  it("RED: without S4 a CPA- card would be stripped", () => {
    const e = K.sellerNameAutoEvidence({
      row, stored: storedAuto, derived: derivedSame, axes: noMove,
      checklistSaysNotAuto: true, autoByCardNumber: true,
    });
    expect(e.qualifies).toBe(false);
    const withoutS4 = e.failed.filter((f: string) => f !== "cardnumber-is-auto-subset");
    expect(withoutS4).toEqual([]); // S4 alone was holding it
  });
});

describe("classifyRow: the row that agrees with its own defect", () => {
  const base = {
    row, stored: storedAuto, derived: derivedSame,
    storedSlug: "hiq:baseball:2025:bowman:27:base:auto",
  };

  it("IMPROVEs the row onto its base identity", () => {
    const v = K.classifyRow({ ...base, checklistSaysNotAuto: true });
    expect(v.klass).toBe(K.IMPROVE);
    expect(v.subclass).toBe(K.SELLER_NAME_AUTO);
    expect(v.derived.isAuto).toBe(false);
    expect(v.axes.changed).toEqual(["isAuto"]);
  });

  it("without the checklist fact it stays AGREE — today's behaviour", () => {
    // A caller that cannot answer gets no subclass at all.
    const v = K.classifyRow({ ...base });
    expect(v.klass).toBe(K.AGREE);
    expect(v.subclass).toBeUndefined();
  });

  it("names the near miss so the census can count the failing leg", () => {
    const v = K.classifyRow({ ...base, checklistSaysNotAuto: false });
    expect(v.klass).toBe(K.AGREE);
    expect(v.reasons.some((r: string) => r.startsWith("not-seller-name-auto:"))).toBe(true);
  });

  it("stays silent on the millions of rows that were never candidates", () => {
    const v = K.classifyRow({
      row: { title: "1990 Topps Frank Thomas #414" },
      stored: { ...storedAuto, isAuto: false },
      derived: { ...storedAuto, isAuto: false },
      checklistSaysNotAuto: true,
    });
    expect(v.reasons.some((r: string) => r.startsWith("not-seller-name-auto:"))).toBe(false);
  });
});
