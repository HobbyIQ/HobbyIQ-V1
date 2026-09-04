// CF-THE-CHECKLIST-SPELLS-THE-NUMBER — the rematch classifier's half.
//
// The derivation fix (pokemonChecklistSpellsTheNumber.test.ts) only helps rows
// written from now on. The 60k English Pokemon rows already in the pool carry
// the concatenated number in their stored fields AND in their slug, and the
// Great Rematch is what moves them.
//
// WITHOUT THIS RULE THE FIX MAKES THINGS WORSE. `diffAxes` would read the
// stored `094159` against the newly-correct derived `094` as
// `changed:cardNumber`, the row would classify CONFLICT, and the rematch would
// leave every one of them exactly where it is -- the split pool reported as a
// disagreement rather than closed.
//
// THE STORED VALUE IS NOT A RIVAL READING. `094159` is `094` with the SET
// TOTAL glued on, and `94` is `094` with the checklist's padding dropped.
// Neither is an answer about WHICH CARD this is, so the stored side is BLANK
// on that axis and the derivation FILLS it -- the ordinary IMPROVE path,
// subject to every refusal that path already applies.
//
// THE TEST IS RECONSTRUCTION, NOT PREFIXING. `094159` starts with `094`, but so
// does `0941`. The stored digits must split EXACTLY into the derived position
// and a credible set total, with nothing left over.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");

const BASE = {
  sport: "pokemon", cardYear: 2025, setKey: "sv09", parallel: "Base",
  isAuto: false, printRun: null, gradeCompany: null, gradeValue: null,
};
const ROW = {
  sport: "pokemon", cardYear: 2025,
  title: "2025 Pokemon Journey Together 094/159 Clefairy ex",
};

const classify = (storedNum: string, derivedNum: string, row: unknown = ROW) =>
  K.classifyRow({
    row,
    stored: { ...BASE, cardNumber: storedNum },
    derived: { ...BASE, cardNumber: derivedNum },
    checklistBacked: true,
  });

describe("pokemonNumberIsPositionOverTotal — the stored number is POS+TOTAL glued", () => {
  it("reconstructs the padded form", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "094159" }, { cardNumber: "094" }, "pokemon",
    )).toBe("094159=094/159");
  });

  it("reconstructs the short form — 94/159 and 094/159 are one card", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "94159" }, { cardNumber: "094" }, "pokemon",
    )).toBe("94159=94/159");
  });

  it("reconstructs a secret rare numbered above its set total", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "161131" }, { cardNumber: "161" }, "pokemon",
    )).toBe("161131=161/131");
  });

  it("refuses a suffixed number — TG01 is not a position", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "tg01tg30" }, { cardNumber: "tg01" }, "pokemon",
    )).toBeNull();
  });

  it("refuses on any other vertical — no one else writes POS/TOTAL", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "094159" }, { cardNumber: "094" }, "baseball",
    )).toBeNull();
  });

  it("refuses a bare prefix that does not reconstruct — 0941 is a DIFFERENT card", () => {
    // `0941` starts with `094`, and a prefix test would fold it. The leftover
    // `1` is not a credible set total spelled that way, so this must refuse.
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "0941" }, { cardNumber: "094" }, "pokemon",
    )).toBeNull();
  });

  it("refuses a total with a leading zero — no checklist writes 0159", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "0940159" }, { cardNumber: "094" }, "pokemon",
    )).toBeNull();
  });

  it("refuses an implausibly large total", () => {
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "094999999" }, { cardNumber: "094" }, "pokemon",
    )).toBeNull();
  });
});

describe("pokemonNumberDiffersOnlyByPadding", () => {
  it("folds 94 onto the checklist's 094", () => {
    expect(K.pokemonNumberDiffersOnlyByPadding(
      { cardNumber: "94" }, { cardNumber: "094" }, "pokemon",
    )).toBe(true);
  });

  it("refuses two genuinely different numbers", () => {
    expect(K.pokemonNumberDiffersOnlyByPadding(
      { cardNumber: "95" }, { cardNumber: "094" }, "pokemon",
    )).toBe(false);
  });

  it("refuses a suffixed number", () => {
    expect(K.pokemonNumberDiffersOnlyByPadding(
      { cardNumber: "tg01" }, { cardNumber: "tg1" }, "pokemon",
    )).toBe(false);
  });

  it("refuses on any other vertical", () => {
    expect(K.pokemonNumberDiffersOnlyByPadding(
      { cardNumber: "94" }, { cardNumber: "094" }, "baseball",
    )).toBe(false);
  });
});

describe("classifyRow — the stored rows become writable", () => {
  it("a concatenated stored number classifies IMPROVE, not CONFLICT", () => {
    const r = classify("094159", "094");
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.axes.filled).toContain("cardNumber");
    expect(r.axes.changed).not.toContain("cardNumber");
    expect(r.writable).toBe(true);
  });

  it("the short concatenated form classifies IMPROVE too", () => {
    expect(classify("94159", "094").klass).toBe(K.IMPROVE);
  });

  it("a padding-only difference classifies IMPROVE", () => {
    expect(classify("94", "094").klass).toBe(K.IMPROVE);
  });

  it("a genuinely different number stays a CONFLICT — Drew settles those", () => {
    const r = classify("095", "094");
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("cardNumber");
    expect(r.writable).toBe(false);
  });

  it("a suffixed number stays a CONFLICT", () => {
    expect(classify("tg01tg30", "tg01").klass).toBe(K.CONFLICT);
  });

  it("a baseball row is untouched — the fold is gated on the vertical", () => {
    const row = { sport: "baseball", cardYear: 2025, title: "x" };
    const r = K.classifyRow({
      row,
      stored: { ...BASE, sport: "baseball", cardNumber: "094159" },
      derived: { ...BASE, sport: "baseball", cardNumber: "094" },
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
  });
});

// ── MUTATION PINS ────────────────────────────────────────────────────────────

describe("mutation pins", () => {
  it("MUTATION: marking the fold `same` instead of `filled` is red", () => {
    // `same` would classify AGREE, and AGREE means "nothing to do" -- the row
    // would keep its `:094159:` address and the split pool would never close.
    // The whole unlock is that these rows become WRITABLE.
    const r = classify("094159", "094");
    expect(r.klass).not.toBe(K.AGREE);
    expect(r.writable).toBe(true);
  });

  it("MUTATION: dropping the fold entirely is red — the row falls back to CONFLICT", () => {
    // With the rule reverted, stored `094159` vs derived `094` is
    // `changed:cardNumber`. Assert the fold is what separates the two shapes.
    expect(classify("094159", "094").klass).toBe(K.IMPROVE);
    expect(classify("095", "094").klass).toBe(K.CONFLICT);
    expect(classify("094159", "094").klass).not.toBe(classify("095", "094").klass);
  });

  it("MUTATION: a prefix test instead of reconstruction is red", () => {
    // A prefix test would fold `0941` onto `094`, which is a different card.
    expect(K.pokemonNumberIsPositionOverTotal(
      { cardNumber: "0941" }, { cardNumber: "094" }, "pokemon",
    )).toBeNull();
    expect(classify("0941", "094").klass).toBe(K.CONFLICT);
  });
});
