/**
 * GUARD 7 -- THE IMPROVE-GATE AUDIT OF THE 2026-09-04 CENSUS RUNS.
 *
 * THE AUDIT THIS PINS. Two GREAT REMATCH census runs were judged row by row
 * against their committed evidence sets:
 *
 *   run 33907540797  slot 19 (units y=2022/h=0of2, 1987, 1977, 1980)  491/500
 *   run 33907555485  slot 31                                          285/300
 *
 * Verdict: NO-GO. Five defects account for the wrong rows, and each has its
 * own describe() below. Every fixture title is VERBATIM from the committed
 * census artifact (census-slot-19.json / census-slot-31.json) or, where a
 * stored slug decides the case, read live from `sold_comps` on 2026-09-04.
 *
 * THE RULE EVERY BLOCK SHARES. Beside each leak sits its CONTROL -- the
 * genuine single card of the same shape, which must KEEP classifying as it
 * does today. A guard that stops everything is an off switch, not a guard,
 * and the audit that opened this file was itself caused by a guard standing
 * down on a spelling.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;
const V = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs")) as any;

/** A row whose derivation FILLED a blank axis -- the IMPROVE shape. */
function improveRow(o: {
  title: string; year: number; setKey: string; cardNumber: string;
  storedCardNumber?: string; storedSetKey?: string; sport?: string; grade?: string | null;
}) {
  const sport = o.sport ?? "baseball";
  const storedSetKey = o.storedSetKey ?? o.setKey;
  const slug = `hiq:${sport}:${o.year}:${storedSetKey || "unknown"}:base:no-auto`;
  const common = {
    sport, cardYear: o.year, parallel: "Base", isAuto: false,
    printRun: null, grade: o.grade ?? null,
  };
  return K.classifyRow({
    row: { id: "row-1", cardId: slug, source: "tca-ebay", title: o.title },
    stored: { ...common, setKey: storedSetKey, cardNumber: o.storedCardNumber ?? "" },
    derived: { ...common, setKey: o.setKey, cardNumber: o.cardNumber },
    checklistBacked: true, derivedBackedStrict: true,
    storedFlagshipListsCardNumber: true, storedSlug: slug,
  });
}

/** A row stored on a slug whose PARALLEL segment carries a product name. */
function specializationRow(o: {
  title: string; year: number; storedSetKey: string; derivedSetKey: string;
  cardNumber: string; slugParallel: string; grade?: string | null;
  flagshipListsCardNumber?: boolean;
}) {
  const slug = `hiq:baseball:${o.year}:${o.storedSetKey}:${o.cardNumber.toLowerCase()}:${o.slugParallel}:no-auto`;
  const common = {
    sport: "baseball", cardYear: o.year, cardNumber: o.cardNumber,
    parallel: "Base", isAuto: false, printRun: null, grade: o.grade ?? null,
  };
  return K.classifyRow({
    row: { id: "row-1", cardId: slug, source: "cardsight", title: o.title },
    stored: { ...common, setKey: o.storedSetKey },
    derived: { ...common, setKey: o.derivedSetKey },
    storedSlug: slug,
    baseDestSlug: `hiq:baseball:${o.year}:${o.storedSetKey}:${o.cardNumber.toLowerCase()}:base:no-auto`,
    baseDestBacked: true, checklistBacked: true, derivedBackedStrict: true,
    storedFlagshipListsCardNumber: o.flagshipListsCardNumber ?? true,
  });
}

// ── (1) GUARD 7: a lot, a break and a grade phrase never name a card ───────
describe("GUARD 7 -- a lot / break / range listing never mints a cardNumber", () => {
  // A BOX BREAK IS SOLD BY SLOT. The "#2" is the slot, the team or the spot in
  // the break, never this card's number. Measured on slot 19 this was the ONE
  // lot-shaped row that reached the IMPROVE gate ARMED.
  it("refuses a box-break listing whose '#N' is a break slot, not a card", () => {
    const r = improveRow({
      title: "Ja'Marr Chase 2022 Panini Prizm Prizm Break #2 Raw 10",
      year: 2022, setKey: "panini-prizm", cardNumber: "2", sport: "football",
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(";")).toMatch(/improve-lot-or-range-listing/);
  });

  it.each([
    ["Prizm Break #2", "Ja'Marr Chase 2022 Panini Prizm Prizm Break #2 Raw 10"],
    ["Box Break", "2022 Panini Prizm Box Break #4 Chiefs Slot"],
    ["Case Break", "2023 Bowman Case Break #12 Dodgers"],
    ["Live Break", "Live Break #3 Yankees 2022 Topps Series One"],
  ])("reads %s as a lot", (_what, title) => {
    expect(V.isLotOrRangeListing(title, false).lot).toBe(true);
  });

  // A SET BREAK IS THE OPPOSITE SHAPE -- a seller breaking a set to sell its
  // cards ONE AT A TIME. These state a real single card and its real number,
  // and ~50 of them classify correctly on slot 19 today. A bare `\bbreak\b`
  // would have disarmed every one, which is why the idiom is named by its
  // product ("Prizm Break", "Box Break") and never on the word alone.
  it.each([
    "1987 Topps Tiffany Set-Break #749 Ozzie Smith NM-MT OR BETTER *GMCARDS*",
    "1987 Topps Traded Set-Break # 74T Fred Mcgriff NM-MT OR BETTER *GMCARDS*",
    "1987 Topps Tiffany Set-Break #648 Barry Larkin RC NM-MT OR BETTER *GMCARDS*",
  ])("CONTROL: a set-break single is NOT a lot -- %s", (title) => {
    expect(V.isLotOrRangeListing(title, false).lot).toBe(false);
  });

  it("refuses the 'You Choose' menu on its vocabulary, not only on its range", () => {
    // The range and the idiom are independent: the same listing without the
    // "#1-220" must still read as a lot.
    expect(V.isLotOrRangeListing("2022 Topps Heritage Minor League - You Choose", false).lot).toBe(true);
    const r = improveRow({
      title: "2022 Topps Heritage Minor League - #1-220 - You Choose - 2 CARD MINIMUM",
      year: 2022, setKey: "topps-heritage", cardNumber: "1",
    });
    expect(r.writable).toBe(false);
  });

  // A GRADE PHRASE IS NOT A CARD NUMBER. "Lot (122) w/ 2 SGC MINT 9" sells 122
  // cards; the "2" counts the slabs in the lot.
  it("never harvests a card number out of a grade phrase in a lot title", () => {
    const r = improveRow({
      title: "1975 Topps HIGH GRADE Lot (122 ) w/ 2 SGC MINT 9 - VENDING - VSCARDS",
      year: 1975, setKey: "topps", cardNumber: "2", grade: "SGC 9",
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(";")).toMatch(/improve-lot-or-range-listing/);
  });

  it.each([
    ["1975 Topps Baseball Complete Set #1-660 VG to EXMT condition", 1975, "topps"],
    ["1995 Upper Deck MICHAEL JORDAN One On One Complete 10 Card Set #1-10", 1995, "upper-deck"],
    ["1989 Topps Teenage Mutant Ninja Turtles Cards # 1-88 + 11 Stickers", 1989, "topps"],
    ["1975 Topps Set w/ 9 Graded cards Bench, Jackson, Schmidt, Carl Yas.", 1975, "topps"],
  ])("refuses %s", (title, year, setKey) => {
    expect(improveRow({ title, year, setKey, cardNumber: "1" }).writable).toBe(false);
  });

  // A GRADER TOKEN IS NOT THE FAR HALF OF A RANGE. `#1-PSA 9` is the landmark
  // #1 Griffey rookie with its grade written up against the number -- ONE
  // card. Reading it as a 1..9 span made GUARD 5 refuse a genuine,
  // checklist-backed improvement on the most-traded card of its era.
  it.each([
    "1989 Upper Deck Ken Griffey Jr #1-PSA 9 (RC)",
    "1989 Upper Deck #1-Ken Griffey JR NM-MT+ BGS 8.5 Rookie Star",
  ])("CONTROL: a grade written against the number is not a range -- %s", (title) => {
    expect(V.isLotOrRangeListing(title, false).lot).toBe(false);
  });

  it("CONTROL: a grader token does not switch off a real lot verdict", () => {
    // The refusal is only to READ A RANGE. Every other idiom still fires.
    expect(V.isLotOrRangeListing("1975 Topps Complete Set #1-PSA 9 lot", false).lot).toBe(true);
  });

  it("CONTROL: an ordinary single card still improves", () => {
    expect(improveRow({
      title: "2022 Topps Chrome Julio Rodriguez #150 Base",
      year: 2022, setKey: "topps-chrome", cardNumber: "150",
    }).writable).toBe(true);
  });

  // ── GATE 4 slot-31 (2026-09-04): the range parse's two remaining false
  //    positives. Both cost GOOD rows a conservative refusal -- the gate's
  //    secondary finding, report-only and no write risk, but a real loss.
  //
  //    A CONDITION WORD IS NOT THE FAR HALF OF A RANGE. The grader rule
  //    already covered "#1-PSA 9", but the corpus's commonest grade suffix
  //    names no company: "Raw 10" says UNGRADED, and the number after it is
  //    the seller's own condition call. "- Raw" and "- Raw 10" appear on the
  //    fixtures of four existing suites, so this was the single most common
  //    suffix our own evidence carries.
  it.each([
    "2021 Topps Chrome Update #AS1 - Raw 10 Shohei Ohtani",
    "1989 Upper Deck Ken Griffey Jr #6 - Raw 10",
    "1995 Pinnacle UC3 - Ken Griffey Jr - #73 - Raw 10",
    "2020 Topps Mike Trout #1 - Mint 9",
  ])("CONTROL: a trailing condition grade is not a range -- %s", (title) => {
    expect(V.cardNumberRangeFromTitle(title)).toBeNull();
    expect(V.isLotOrRangeListing(title, false).lot).toBe(false);
  });

  //    A HYPHENATED CARD NUMBER IS NOT A RANGE. `#F15-35` is ONE card's
  //    number in the `<letters><digits>-<digits>` shape Panini, Bowman and
  //    Topps insert sets all use. The `b > a` test cannot separate it from a
  //    span -- 35 really is greater than 15 -- so the tell is PREFIX
  //    ASYMMETRY: a real range repeats its prefix ("US1-US50") or omits it on
  //    both halves ("1-660"); a card number carries one on the NEAR half only.
  it.each([
    "2022 Panini Prizm #F15-35 Justin Jefferson Bengals",
    "2021 Bowman Chrome #BCP-102 Prospect Auto",
    "2023 Topps Update #ASG-12 All Star Game",
  ])("CONTROL: a hyphenated card number is not a range -- %s", (title) => {
    expect(V.cardNumberRangeFromTitle(title)).toBeNull();
  });

  //    ...and the genuine spans it must NOT disarm. A repeated prefix is a
  //    real range, and so is a bare numeric one.
  it.each([
    ["1975 Topps Complete Set #1-660 VG to EXMT", "1", 660],
    ["2022 Topps Update Complete Set #US1-US50", "US1", 50],
    ["1989 Topps Teenage Mutant Ninja Turtles Cards # 1-88 + 11 Stickers", "1", 88],
  ])("still reads the genuine span in %s", (title, from, to) => {
    const r = V.cardNumberRangeFromTitle(title as string);
    expect(r).not.toBeNull();
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
  });

  /**
   * MUTATION CHECK -- RESTORING THE OLD RANGE PARSE MUST GO RED.
   *
   * The fix is two refusals to READ a range, and each is reverted here on its
   * own by driving the shipped predicates the way the code behaved before:
   * the grader rule alone (no condition word), and no prefix-asymmetry test at
   * all. Delete either clause from `cardNumberRangeFromTitle` and the matching
   * assertion below fails.
   */
  it("MUTATION: the pre-fix parse reads a trailing 'Raw 10' as a 1..10 span", () => {
    const title = "2021 Topps Chrome Update #AS1 - Raw 10 Shohei Ohtani";
    const m = title.match(V.CARD_NUMBER_RANGE_RE);
    expect(m, "the range regex must still match the raw text").not.toBeNull();
    const tail = title.slice((m!.index ?? 0) + m![0].indexOf(m![2]) + m![2].length);
    // The pre-fix reading: only a GRADER token stopped the range.
    expect(V.RANGE_FAR_HALF_IS_GRADER_RE.test(tail)).toBe(false);
    // The shipped reading: a condition word stops it too.
    expect(V.RANGE_FAR_HALF_IS_CONDITION_RE.test(tail)).toBe(true);
    // And end to end, the row is no longer a lot.
    expect(V.cardNumberRangeFromTitle(title)).toBeNull();
  });

  it("MUTATION: without the prefix-asymmetry test, #F15-35 is read as 15..35", () => {
    const title = "2022 Panini Prizm #F15-35 Justin Jefferson Bengals";
    const m = title.match(V.CARD_NUMBER_RANGE_RE);
    expect(m).not.toBeNull();
    // The pre-fix parse got as far as two ascending numbers and stopped there.
    expect(Number(m![3]) > Number(m![2])).toBe(true);
    // The shipped test reads the asymmetry and refuses.
    expect(V.rangePrefixIsAsymmetric(m)).toBe(true);
    expect(V.cardNumberRangeFromTitle(title)).toBeNull();
    // ...and it stays FALSE for a genuine repeated-prefix span.
    const span = "2022 Topps Update Complete Set #US1-US50".match(V.CARD_NUMBER_RANGE_RE);
    expect(V.rangePrefixIsAsymmetric(span)).toBe(false);
  });
});

// ── (2) An apostrophe is spelling, not identity ────────────────────────────
describe("GUARD 6 -- a flagship key is never a licence when the title names a child", () => {
  // A setKey segment cannot carry punctuation, so the catalog spells the
  // product `bowmans-best` and every seller writes "Bowman's Best".
  // `\bbowmans\b` never matches "Bowman's" -- the apostrophe IS a word
  // boundary -- so GUARD 6 required a word no title could ever state and
  // stood down on the whole family (est. 200,863 rows).
  it.each([
    ["straight apostrophe", "2022 Bowman's Best Baseball #20 Base"],
    ["curly apostrophe", "2022 Bowman’s Best Baseball #20 Base"],
    ["no apostrophe", "2022 Bowmans Best Baseball #20 Base"],
  ])("titleStatesWord reads 'bowmans' through the %s", (_what, title) => {
    expect(K.titleStatesWord(title, "bowmans")).toBe(true);
  });

  it("CONTROL: the apostrophe strip never invents a word that is not there", () => {
    expect(K.titleStatesWord("2022 Bowman Best Baseball #20", "bowmans")).toBe(false);
    expect(K.titleStatesWord("2022 Bowman Chrome #20", "bowmans")).toBe(false);
    // Only an apostrophe BETWEEN letters is spelling; a quote around a word
    // leaves its boundary intact.
    expect(K.titleStatesWord("2022 Topps 'Best' #20", "bests")).toBe(false);
  });

  it.each([
    ["Bowman's Best -> bowman", "2022 Bowman's Best Baseball #20 Base", "bowman", "20"],
    ["Bowman's Best -> bowman-chrome", "2022 Bowman's Best Baseball #B22-SK Blue Refractor", "bowman-chrome", "B22-SK"],
    ["Tiffany -> topps", "1987 Topps - Barry Bonds #320 Tiffany (RC)", "topps", "320"],
    ["Traded -> topps", "1987 Topps Traded Greg Maddux #70T Chicago Cubs", "topps", "70T"],
    ["Score Traded -> score", "1989 Score Traded #100T Ken Griffey Jr", "score", "100T"],
    ["Sapphire -> bowman", "2022 Bowman Sapphire Colson Montgomery Chrome 1st Prospect #BCP-71", "bowman", "BCP-71"],
  ])("refuses %s", (_what, title, setKey, num) => {
    const r = improveRow({
      title, year: title.startsWith("19") ? Number(title.slice(0, 4)) : 2022,
      setKey, cardNumber: num, storedSetKey: "",
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(";")).toMatch(/improve-title-names-a-product-the-derivation-dropped|improve-title-names-a-finish-family/);
  });

  it("CONTROL: the flagship's own base card still improves", () => {
    expect(improveRow({
      title: "2022 Bowman Baseball #20 Base", year: 2022,
      setKey: "bowman", cardNumber: "20", storedSetKey: "",
    }).writable).toBe(true);
  });
});

// ── (3) Score Traded: the catalog's spelling, not the seller's ─────────────
describe("Score Rookie & Traded is declared under the key the catalog holds", () => {
  // Measured on the live catalog 2026-09-04: `score-rookie-and-traded` holds
  // 766 rows and `score-traded` holds ZERO. productSetKeys.ts declares
  // S("score-rookie-and-traded", { names: [..., "score-traded"] }), so the
  // canonical key is the long one and `score-traded` is an ALIAS.
  it("names the canonical key as a distinct product", () => {
    expect(K.DISTINCT_PRODUCT_SETKEYS).toContain("score-rookie-and-traded");
  });

  it("keeps the alias so a row written under the old spelling is still recognised", () => {
    expect(K.DISTINCT_PRODUCT_SETKEYS).toContain("score-traded");
  });

  it("mirrors the ladder edge to the flagship", () => {
    expect(K.SPECIALIZATION_PARENTS["score-rookie-and-traded"]).toBe("score");
  });

  it("holds the row rather than emitting bare `score`", () => {
    const r = improveRow({
      title: "1989 Score Rookie & Traded #100T Ken Griffey Jr",
      year: 1989, setKey: "score", cardNumber: "100T", storedSetKey: "",
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(";")).toMatch(/improve-title-names-a-product-the-derivation-dropped/);
  });
});

// ── (4) THE ROUTING DEFECT ─────────────────────────────────────────────────
describe("a title-stated, checklist-backed specialization routes to IMPROVE, not BASE-EVICTION", () => {
  /**
   * THE DEFECT. ~24 correct `topps -> topps-tiffany` derivations landed in
   * CONFLICT/BASE-EVICTION instead of IMPROVE/SPECIALIZATION-STATED.
   *
   * THE CAUSE IS ORDER, NOT ANY OF THE LEGS. Every one of these rows is
   * stored on a slug whose PARALLEL segment carries the product name -- read
   * live from `sold_comps` 2026-09-04:
   *
   *   hiq:baseball:1987:topps:320:tiffany:no-auto   parallel field "Base"
   *   hiq:baseball:1987:topps:562:tiffany:no-auto   parallel field "Base"
   *
   * `classifyRow` evaluates base-eviction BEFORE the axis diff decides (so
   * the commonest eviction shape is seen at all), which puts it ahead of the
   * SPECIALIZATION-STATED door. These rows qualified on every eviction leg --
   * the slug names a "parallel", the stored parallel field says Base, and
   * guard 3 suppresses the title's "Tiffany" as the DERIVED product's own
   * setKey word -- so the eviction claimed the row and returned CONFLICT.
   *
   * They were never WRITABLE (`base-eviction-contradicted:setKey` held), so
   * nothing landed on the wrong card. But a correct improvement counted as a
   * conflict is a repair nobody can find, against 6,339 rows measured
   * eligible lane-wide.
   */
  it.each([
    ["Bonds #320 Tiffany PSA 9", "1987 TOPPS TIFFANY #320 BARRY BONDS RC PIRATES PSA 9", "320", "PSA 9"],
    ["Bonds #320 Tiffany PSA 8", "1987 TOPPS TIFFANY #320 BARRY BONDS RC PIRATES PSA 8", "320", "PSA 8"],
    ["Clutterbuck #562", "1987 TOPPS TIFFANY #562 BRYAN CLUTTERBUCK BREWERS PSA 10", "562", "PSA 10"],
    ["Larkin #648", "1987 Topps Tiffany - Barry Larkin #648 PSA 10 GEM MT", "648", "PSA 10"],
    ["Mattingly #500", "1987 Topps Tiffany Don Mattingly #500 PSA 10 GEM MINT", "500", "PSA 10"],
    ["Henderson #735", "1987 TOPPS TIFFANY #735 - RICKEY HENDERSON", "735", null],
  ])("%s classifies IMPROVE/SPECIALIZATION-STATED", (_what, title, num, grade) => {
    const r = specializationRow({
      title, year: 1987, storedSetKey: "topps", derivedSetKey: "topps-tiffany",
      cardNumber: num, slugParallel: "tiffany", grade,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.subclass).toBe(K.SPECIALIZATION_STATED);
    expect(r.writable).toBe(true);
  });

  it("a Maddux Tiffany-titled Traded row reaches the grandchild", () => {
    const r = specializationRow({
      title: "1987 Topps Traded - Greg Maddux #70T Tiffany (RC)",
      year: 1987, storedSetKey: "topps-traded", derivedSetKey: "topps-traded-tiffany",
      cardNumber: "70T", slugParallel: "tiffany",
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.subclass).toBe(K.SPECIALIZATION_STATED);
  });

  // THE OTHER MADDUX. No Tiffany token in the title, so the row must keep
  // targeting `topps-traded` and must NOT be dragged onto the Tiffany.
  it("a Maddux row with no Tiffany token still targets topps-traded", () => {
    const r = specializationRow({
      title: "1987 Topps Traded #70T Greg Maddux - Raw",
      year: 1987, storedSetKey: "topps", derivedSetKey: "topps-traded",
      cardNumber: "70T", slugParallel: "base",
      // The flagship's own checklist does NOT list #70T, so L5 is satisfied.
      flagshipListsCardNumber: false,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.subclass).toBe(K.SPECIALIZATION_STATED);
    expect(r.reasons.join(";")).toMatch(/specialization:topps->topps-traded/);
    expect(r.reasons.join(";")).not.toMatch(/tiffany/i);
  });

  // THE GUARD IS DISQUALIFYING ONLY. A slug segment that names a REAL finish
  // the title does not support is still an eviction -- the lane the audit
  // gate cleared must not be narrowed by this fix.
  it("CONTROL: a real parallel slug the title never states still evicts", () => {
    const r = specializationRow({
      title: "1987 Topps #320 Barry Bonds RC Pirates",
      year: 1987, storedSetKey: "topps", derivedSetKey: "topps",
      cardNumber: "320", slugParallel: "gold",
    });
    expect(r.subclass).toBe(K.BASE_EVICTION);
  });

  it("CONTROL: a product-named slug the title does NOT state still evicts", () => {
    const r = specializationRow({
      title: "1987 Topps #320 Barry Bonds RC Pirates",
      year: 1987, storedSetKey: "topps", derivedSetKey: "topps",
      cardNumber: "320", slugParallel: "tiffany",
    });
    expect(r.subclass).toBe(K.BASE_EVICTION);
  });
});

// ── (6) CONFLICT is report-only, forever ───────────────────────────────────
describe("no scope value can ever arm CONFLICT", () => {
  // BASE-EVICTION may write because its destination is derived from ABSENCE.
  // CONFLICT is a contradiction about WHICH CARD a sale is, and a fleet never
  // settles that -- Drew does. This is structural: CONFLICT is not a member of
  // APPLY_CLASSES, so no alias can name it.
  it("APPLY_CLASSES holds only the two writing classes", () => {
    expect(Object.values(K.APPLY_CLASSES).sort()).toEqual([K.BASE_EVICTION, K.IMPROVE].sort());
    expect(Object.values(K.APPLY_CLASSES)).not.toContain(K.CONFLICT);
  });

  it.each([
    "conflict", "CONFLICT", "conflicts", "conflict-only",
    "improve,conflict", "conflict,improve", "all,conflict",
  ])("scope %j never arms CONFLICT", (scope) => {
    const parsed = K.parseApplyScope(scope);
    expect([...parsed.classes]).not.toContain(K.CONFLICT);
  });

  it.each(["all", "both", "all-classes", "improve", "base-eviction", "revert"])(
    "the accepted scope %j arms no CONFLICT either", (scope) => {
      const parsed = K.parseApplyScope(scope);
      expect(parsed.ok).toBe(true);
      expect([...parsed.classes]).not.toContain(K.CONFLICT);
    },
  );

  it("a CONFLICT row is never writable under any parsed scope", () => {
    // The Maddux row that fails L5 -- a genuine CONFLICT.
    const r = specializationRow({
      title: "1987 Topps Traded #70T Greg Maddux - Raw",
      year: 1987, storedSetKey: "topps", derivedSetKey: "topps-traded",
      cardNumber: "70T", slugParallel: "base", flagshipListsCardNumber: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    for (const scope of ["improve", "base-eviction", "both", "all", "all-classes"]) {
      const parsed = K.parseApplyScope(scope);
      expect(K.writableUnderScope(r, parsed)).toBeFalsy();
    }
  });
});
