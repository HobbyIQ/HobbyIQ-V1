/**
 * THE GREAT REMATCH: `player-<name>` -> a real card number is an IMPROVE.
 *
 * CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). 89,197 pool rows carry the
 * pseudo-number in their cardNumber segment. The census
 * (scripts/census-player-pseudo-number.cjs, run 2026-09-04) sorted them:
 *
 *     23,574  the title states a real card number  -- UNPARSED, not unnumbered
 *      1,445  genuinely unnumbered per the source  -- the pseudo-number is right
 *     64,178  no number and nothing asserting one  -- UNDERIVABLE
 *
 * Only 1.6% of the population is the one CF-PLAYER-IS-THE-NUMBER was written
 * for. The other 98% are a parse failure wearing an identity.
 *
 * WHAT THIS FILE PINS, AND THE ORDER MATTERS
 *
 *   1. a stored `player-<name>` whose TITLE states the number, re-derived onto
 *      that number and checklist-backed, classifies IMPROVE and is writable.
 *      This is the lane the census sized.
 *   2. WITHOUT the title fact it is `changed:cardNumber` -> CONFLICT. A
 *      genuinely unnumbered T206 row must never be re-keyed onto whatever a
 *      noisy title happens to carry -- a cert, a print run, a lot range.
 *   3. WITHOUT checklist backing it is CONFLICT. A match proves nothing unless
 *      checklist-backed; that gate is unchanged and still decides.
 *   4. the reverse direction -- a stored REAL number re-deriving to the
 *      pseudo-number -- is the defect running backwards and is refused by name.
 *   5. PROTECTED rows stay report-only, as they are for every other class.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));

// The real sale. Filed at hiq:baseball:1987:topps:player-todd-worrell:base:no-auto
// while its own title states #70T and names Greg Maddux.
const MADDUX_TITLE = "1987 Topps Traded Tiffany #70T Greg Maddux Rookie RC PSA 10 GEM MINT";

const storedPseudo = {
  sport: "baseball", cardYear: 1987, setKey: "topps-traded-tiffany",
  cardNumber: "player-todd-worrell", parallel: "Base", isAuto: false,
  printRun: null, gradeCompany: "PSA", gradeValue: 10,
};
const derivedNumbered = { ...storedPseudo, cardNumber: "70T" };

const row = (over: Record<string, unknown> = {}) => ({
  id: "sc-maddux", source: "tca-ebay", title: MADDUX_TITLE,
  cardId: "hiq:baseball:1987:topps-traded-tiffany:player-todd-worrell:base:no-auto:psa-10",
  ...over,
});

describe("titleStatesCardNumber -- the ONE fact that unlocks the re-key", () => {
  it("reads the number a seller typed with a #", () => {
    expect(K.titleStatesCardNumber(MADDUX_TITLE)).toBe(true);
    expect(K.titleStatesCardNumber("2011 Topps Update Mike Trout No. US175 PSA 10")).toBe(true);
  });

  it("is FALSE for a title that states no number -- the unnumbered population", () => {
    expect(K.titleStatesCardNumber("1909-11 T206 Honus Wagner PSA 2")).toBe(false);
    expect(K.titleStatesCardNumber("Magic Alpha Black Lotus BGS 8")).toBe(false);
    expect(K.titleStatesCardNumber("1969 Topps Johnny Bench Stamp - Raw")).toBe(false);
  });

  it("refuses a CERT and a SERIAL, which is what those titles actually carry", () => {
    // Measured in CF-PLAYER-IS-THE-NUMBER: only 6.4% of the unnumbered rows have
    // any "#" and most of those are certs or print runs. Reading either as a
    // card number would re-key a correct row onto a number that is not one.
    expect(K.titleStatesCardNumber("T206 Wagner #3538117020 PSA 2")).toBe(false);
    expect(K.titleStatesCardNumber("Leaf Signature Series Auto #788/1000")).toBe(false);
  });
});

describe("isPseudoCardNumber", () => {
  it("names the shape and nothing else", () => {
    expect(K.isPseudoCardNumber("player-todd-worrell")).toBe(true);
    expect(K.isPseudoCardNumber("70T")).toBe(false);
    expect(K.isPseudoCardNumber("pf-greg-maddux")).toBe(false);   // a DIFFERENT fallback
    expect(K.isPseudoCardNumber("P-1")).toBe(false);              // a real promo number
    expect(K.isPseudoCardNumber(null)).toBe(false);
  });
});

describe("THE LANE: pseudo-number -> numbered, title-stated, checklist-backed", () => {
  it("classifies IMPROVE and is writable", () => {
    const r = K.classifyRow({
      row: row(), stored: storedPseudo, derived: derivedNumbered,
      checklistBacked: true, titleStatesNumber: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    // The axis moved as a FILL, not a change -- that is the whole ruling.
    expect(r.axes.filled).toContain("cardNumber");
    expect(r.axes.changed).not.toContain("cardNumber");
    expect(r.writable).toBe(true);
  });
});

describe("THE GUARDS -- each one alone takes the row out of the lane", () => {
  it("WITHOUT the title fact it is a CONFLICT, not an improvement", () => {
    // This is the genuinely-unnumbered row's protection. The derivation may be
    // as confident as it likes; if the title states no number there is nothing
    // to have read, and `changed:cardNumber` is report-only forever.
    const r = K.classifyRow({
      row: row({ title: "1909-11 T206 Honus Wagner PSA 2" }),
      stored: storedPseudo, derived: derivedNumbered,
      checklistBacked: true, titleStatesNumber: false,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("cardNumber");
    expect(r.writable).toBe(false);
  });

  it("WITHOUT checklist backing it is a CONFLICT -- the gate is unchanged", () => {
    const r = K.classifyRow({
      row: row(), stored: storedPseudo, derived: derivedNumbered,
      checklistBacked: false, titleStatesNumber: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.reasons).toContain("not-checklist-backed");
    expect(r.writable).toBe(false);
  });

  it("the REVERSE direction is refused by name -- a real number never demotes to the pseudo one", () => {
    const r = K.classifyRow({
      row: row(), stored: derivedNumbered, derived: storedPseudo,
      checklistBacked: true, titleStatesNumber: true,
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(" ")).toContain("derived-cardnumber-is-pseudo-number");
  });

  it("a PROTECTED row is IMPROVE-shaped and still never writes", () => {
    const r = K.classifyRow({
      row: row({ source: "ebay-user-purchase" }),
      stored: storedPseudo, derived: derivedNumbered,
      checklistBacked: true, titleStatesNumber: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.tier).toBe(K.PROTECTED);
    expect(r.writable).toBe(false);
  });

  it("a re-key that ALSO moves another identity axis is a CONFLICT", () => {
    // Filling the number is an improvement; changing the setKey alongside it is
    // a different reading of the card, and the only-improve rule refuses the
    // whole row rather than writing the half it likes.
    const r = K.classifyRow({
      row: row(), stored: storedPseudo,
      derived: { ...derivedNumbered, setKey: "topps" },
      checklistBacked: true, titleStatesNumber: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
  });
});

describe("MUTATION CHECK: the title-fact gate is load-bearing", () => {
  it("blanking the pseudo-number UNCONDITIONALLY would re-key an unnumbered card", async () => {
    const fs = await import("node:fs");
    const file = path.join(backend, "scripts", "lib", "rematch-classify.cjs");
    const src = fs.readFileSync(file, "utf8");

    // The gate: the stored pseudo-number counts as blank ONLY when the caller
    // supplies a FACT ABOUT THE ROW saying it is not an answer.
    //
    // CF-A-PLAYER-SEGMENT-IS-A-PERSON (2026-09-04) added a second such fact
    // alongside `titleStatesNumber` -- `storedPlayerCorrupted`, for the 25.7%
    // of the population whose pseudo-number names something that is not a
    // person. The guard is now a disjunction of row-facts rather than a single
    // one, and what this mutation check protects is unchanged and is the
    // CONJUNCTION with `isPseudoCardNumber`: at least one fact must hold. The
    // mutant below drops every fact, which is the unconditional blanking the
    // original defect would have been.
    const GUARD_HEAD = "const storedBlankCardNumber = isPseudoCardNumber(stored?.cardNumber)\n    && (opts.titleStatesNumber === true";
    expect(src).toContain(GUARD_HEAD);
    // Replace the whole multi-line guard with the unconditional form.
    const start = src.indexOf(GUARD_HEAD);
    const end = src.indexOf(";", src.indexOf('.replace(/-/g, " ")', start));
    expect(end).toBeGreaterThan(start);
    const mutated = src.slice(0, start)
      + "const storedBlankCardNumber = isPseudoCardNumber(stored?.cardNumber)"
      + src.slice(end);
    expect(mutated).not.toBe(src);

    const tmp = path.join(backend, "scripts", "lib", `.rematch-classify.pseudo-mutant-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      const mutant = require_(tmp);

      // A T206 Wagner: genuinely unnumbered, its title states no number, and a
      // noisy derivation offers one anyway.
      const wagnerRow = row({ title: "1909-11 T206 Honus Wagner PSA 2" });
      const wagnerStored = {
        sport: "baseball", cardYear: 1909, setKey: "t206",
        cardNumber: "player-honus-wagner", parallel: "Base", isAuto: false,
        printRun: null,
      };
      const noisy = { ...wagnerStored, cardNumber: "2" };
      const args = { row: wagnerRow, stored: wagnerStored, derived: noisy, checklistBacked: true, titleStatesNumber: false };

      // REAL: the title says nothing, so the row is left alone.
      const real = K.classifyRow(args);
      expect(real.klass).toBe(K.CONFLICT);
      expect(real.writable).toBe(false);

      // MUTANT: the pseudo-number reads as blank whatever the title says, so
      // the noise becomes a "fill" and the fleet is licensed to re-key a
      // correct row onto a number that does not exist.
      const broken = mutant.classifyRow(args);
      expect(broken.klass).toBe(K.IMPROVE);
      expect(broken.writable).toBe(true);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});
