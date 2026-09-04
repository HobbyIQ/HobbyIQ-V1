/**
 * THE AUDIT-GATE LEAKS -- the eight shapes two Opus census audits found still
 * WRITABLE under the rebuilt trust ladder, 2026-09-03.
 *
 * The first gate read shards 0-15 and cleared two of them (0 and 8). The other
 * fourteen were dirty on three writable leaks, and a fourth defect in the
 * vocabulary. The second gate read shards 16-31 and found BASE-EVICTION CLEAN
 * on all sixteen (0 bad in 1,236 audited lines -- Tiffany, Desert Shield,
 * Rapture, Press Proof, Members Only, Embossed and Mahogany all resolve) while
 * IMPROVE was dirty at 4.9% (298 of 6,106) on three more.
 *
 * EVERY LINE QUOTED IN EITHER GATE IS A FIXTURE HERE, and each must classify
 * NOT WRITABLE with a named reason. Beside each one sits its CONTROL: the
 * genuine version of the same shape, which must stay writable. A guard that
 * stops everything is not a guard, it is an off switch -- the census's own
 * doctrine, and the thing that has to be re-proved every time a guard is added.
 *
 *   1. PARALLEL-FAMILY COLLAPSE   the derived parallel is a SIBLING of the
 *                                 finish the title names (22 IMPROVE lines)
 *   2. LOT / RANGE CARD NUMBERS   a multi-card lot's price onto one card's
 *                                 pool (23 IMPROVE lines)
 *   3. MISSPELLED REFRACTOR       "Refactor" evades the vocabulary and a
 *                                 genuine refractor evicts onto base (7 lines)
 *   4. 'america' IS A REAL PARALLEL on the products whose checklist says so
 *   5. SERIAL TRAILING PUNCTUATION defeats GUARD 2 (168 IMPROVE lines)
 *   6. NO cardNumber GUARD AT ALL  (117 IMPROVE lines; same rule as 2)
 *   7. NUMBERED BASE minted where the checklist defines none (13 lines)
 *   8. APPLY SCOPE                 the apply is scopable to a class
 *
 * MUTATION CHECK: each guard is reverted in turn -- by driving the exported
 * predicate with the pre-fix behaviour -- and its pins must go red. A guard
 * that cannot be broken by removing it was not doing anything.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = {
  sport?: string | null; cardYear?: number | null; setKey?: string | null;
  cardNumber?: string | null; parallel?: string | null; isAuto?: boolean | null;
  printRun?: number | null; gradeCompany?: string | null; gradeValue?: number | null;
};
type Result = {
  klass: string; subclass?: string; tier: string; writable: boolean;
  reasons: string[]; improveRefusals?: string[];
  axes: { same: string[]; filled: string[]; dropped: string[]; changed: string[] };
};
/* eslint-disable @typescript-eslint/no-explicit-any */
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;
const V = K.VOCAB;
const P = require_(path.join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js")) as {
  parseListingIdentity: (t: string) => { parallel: string | null; cardNumber: string | null };
  isMultiCardLot: (t: string) => boolean;
};

/**
 * One IMPROVE-shaped row: stored names nothing on the axis under test, the
 * derivation fills it, the destination is checklist-backed. Exactly the shape
 * that reached `writable: true` in the census.
 */
function improveRow(o: {
  title: string; year: number; setKey: string; sport?: string;
  cardNumber?: string | null; derivedParallel?: string; storedParallel?: string;
  storedNumber?: string | null; printRun?: number | null; parserSaysLot?: boolean;
}): Result {
  const sport = o.sport ?? "football";
  const stored: Identity = {
    sport, cardYear: o.year, setKey: o.setKey, cardNumber: o.storedNumber ?? null,
    parallel: o.storedParallel ?? "", isAuto: false, printRun: null,
  };
  const derived: Identity = {
    sport, cardYear: o.year, setKey: o.setKey, cardNumber: o.cardNumber ?? null,
    parallel: o.derivedParallel ?? "", isAuto: false, printRun: o.printRun ?? null,
  };
  const slug = `hiq:${sport}:${o.year}:${o.setKey}:${String(o.storedNumber ?? o.cardNumber ?? "x").toLowerCase()}:base:no-auto`;
  return K.classifyRow({
    row: { id: "row-1", cardId: slug, source: "cardhedge", title: o.title },
    stored, derived, checklistBacked: true, storedSlug: slug,
    baseDestSlug: slug, baseDestBacked: false,
    parserSaysLot: o.parserSaysLot ?? P.isMultiCardLot(o.title),
  });
}

/** A BASE-EVICTION-shaped row: on a refractor slug, own parallel field blank,
 *  checklist-backed base destination. Writable unless something disqualifies. */
function evictionRow(title: string, year = 1993, setKey = "topps-finest", cardNumber = "150"): Result {
  const slug = `hiq:baseball:${year}:${setKey}:${cardNumber}:refractor:no-auto`;
  const stored: Identity = {
    sport: "baseball", cardYear: year, setKey, cardNumber,
    parallel: "Base", isAuto: false, printRun: null,
  };
  return K.classifyRow({
    row: { id: "row-e", cardId: slug, source: "cardhedge", title },
    stored, derived: { ...stored }, checklistBacked: true, storedSlug: slug,
    baseDestSlug: `hiq:baseball:${year}:${setKey}:${cardNumber}:base:no-auto`,
    baseDestBacked: true,
  });
}

const refusalText = (r: Result) => [...(r.improveRefusals ?? []), ...r.reasons].join(" ");

// ═══ 1. PARALLEL-FAMILY COLLAPSE ═══════════════════════════════════════════

/**
 * Every line the first gate quoted. The derived parallel is a SIBLING of the
 * card the title names -- not a less specific reading of it. 2025 Topps Chrome
 * football lists BOTH "Black Wave Refractor" AND "Black Refractor"; they are
 * two cards, two print runs, two price curves, and one pool between them
 * projects an FMV that neither card ever sold for.
 */
const FAMILY_COLLAPSES: Array<{ what: string; title: string; year: number; setKey: string; derived: string; family: string }> = [
  { what: "BLACK WAVE /10 -> Black Refractor", title: "2025 Topps Chrome Bo Nix BLACK WAVE /10 #150", year: 2025, setKey: "topps-chrome", derived: "Black Refractor", family: "wave" },
  { what: "Pink Wave -> Pink Refractor", title: "2025 Topps Chrome Pink Wave #150 Bo Nix", year: 2025, setKey: "topps-chrome", derived: "Pink Refractor", family: "wave" },
  { what: "Yellow Vapor /75 -> Yellow Refractor (no plain Yellow Refractor exists)", title: "2023 Bowman Chrome Yellow Vapor /75 #BCP-50", year: 2023, setKey: "bowman-chrome", derived: "Yellow Refractor", family: "vapor" },
  { what: "Aqua Equinox -> Aqua Refractor", title: "2024 Topps Chrome Aqua Equinox #99", year: 2024, setKey: "topps-chrome", derived: "Aqua Refractor", family: "equinox" },
  { what: "Black Etch SSP -> Black Refractor", title: "2024 Topps Chrome Black Etch SSP #12", year: 2024, setKey: "topps-chrome", derived: "Black Refractor", family: "etch" },
  { what: "Etched In Glass Variation -> Image Variation (both listed separately)", title: "2023 Topps Etched In Glass Variation #240 Judge", year: 2023, setKey: "topps", derived: "Image Variation", family: "etch" },
  { what: "Shimmer Refractors -> Refractor", title: "2022 Bowman Chrome Shimmer Refractors #BCP-1", year: 2022, setKey: "bowman-chrome", derived: "Refractor", family: "shimmer" },
  { what: "Fuchsia Wave -> Fuchsia Refractor", title: "2025 Topps Chrome Fuchsia Wave #7", year: 2025, setKey: "topps-chrome", derived: "Fuchsia Refractor", family: "wave" },
  { what: "Black Ray Wave -> Black Refractor", title: "2025 Topps Chrome Black Ray Wave #7", year: 2025, setKey: "topps-chrome", derived: "Black Refractor", family: "ray" },
];

describe("1 -- a derived parallel that drops a finish family the title names is REFUSED", () => {
  for (const c of FAMILY_COLLAPSES) {
    it(`refuses: ${c.what}`, () => {
      const res = improveRow({ title: c.title, year: c.year, setKey: c.setKey, cardNumber: "150", derivedParallel: c.derived });
      expect(res.writable).toBe(false);
      expect(refusalText(res)).toMatch(/title-names-a-finish-family-the-derivation-dropped/);
    });

    it(`names the family it dropped: ${c.what}`, () => {
      const dropped = V.familyTokensDroppedByDerivation(c.title, c.derived, c.setKey);
      expect(dropped).toContain(c.family);
    });
  }

  it("the CLASS is still IMPROVE -- a refusal is counted, never hidden", () => {
    // The census must still measure the shape. `writable` is what the apply
    // reads; hiding the row in another class would lose the count.
    const res = improveRow({ title: FAMILY_COLLAPSES[0].title, year: 2025, setKey: "topps-chrome", cardNumber: "150", derivedParallel: "Black Refractor" });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.improveRefusals?.length).toBeGreaterThan(0);
  });

  it("when the checklist lists the title's exact family, the refusal NAMES that row", () => {
    // A census is a diff before a write, and a refusal that says "and here is
    // the right answer" is what a repair list is built from.
    expect(V.checklistParallelForFamily("2025 Topps Chrome BLACK WAVE /10 #150", 2025, "topps-chrome"))
      .toBe("black wave refractor");
    const res = improveRow({ title: "2025 Topps Chrome BLACK WAVE /10 #150", year: 2025, setKey: "topps-chrome", cardNumber: "150", derivedParallel: "Black Refractor" });
    expect(refusalText(res)).toContain("checklist-lists:black wave refractor");
  });

  it("the suggestion is COLOUR-CORRECT -- a Pink Wave title never offers the Black row", () => {
    const listed = V.checklistParallelForFamily("2025 Topps Chrome Pink Wave #7", 2025, "topps-chrome");
    if (listed) expect(listed).not.toContain("black");
  });

  // ── CONTROLS ────────────────────────────────────────────────────────────
  it("CONTROL: a title that names Black Refractor STILL writes Black Refractor", () => {
    const res = improveRow({ title: "2025 Topps Chrome Black Refractor /10 #150", year: 2025, setKey: "topps-chrome", cardNumber: "150", derivedParallel: "Black Refractor" });
    expect(res.writable).toBe(true);
    expect(res.improveRefusals).toEqual([]);
  });

  it("CONTROL: a title that names Black Wave and derives Black Wave writes", () => {
    const res = improveRow({ title: "2025 Topps Chrome Black Wave Refractor /10 #150", year: 2025, setKey: "topps-chrome", cardNumber: "150", derivedParallel: "Black Wave Refractor" });
    expect(res.writable).toBe(true);
  });

  it("CONTROL: the product's OWN setKey word is not a dropped family", () => {
    // "2025 Topps Chrome Sapphire ..." names the SET on a sapphire product.
    // Demanding the parallel carry "sapphire" would refuse every write there.
    expect(V.titleFinishFamilyTokens("2025 Bowman Chrome Sapphire Blue #BCP-1", "bowman-chrome-sapphire")).not.toContain("sapphire");
    expect(V.titleFinishFamilyTokens("2025 Bowman Chrome Sapphire Blue #BCP-1", "topps-chrome")).toContain("sapphire");
  });

  // ── THE SOURCE FIX: the derivation no longer drops the family at all ─────
  it("THE SOURCE: the parser reads every one of these families, not just the colour", () => {
    const expected: Record<string, string> = {
      "2025 Topps Chrome Bo Nix BLACK WAVE /10 #150": "Black Wave Refractor",
      "2025 Topps Chrome Pink Wave #150 Bo Nix": "Pink Wave Refractor",
      "2023 Bowman Chrome Yellow Vapor /75 #BCP-50": "Yellow Vapor Refractor",
      "2024 Topps Chrome Aqua Equinox #99": "Aqua Equinox Refractor",
      "2024 Topps Chrome Black Etch SSP #12": "Black Etch",
      "2023 Topps Etched In Glass Variation #240 Judge": "Etched In Glass Variation",
      "2022 Bowman Chrome Shimmer Refractors #BCP-1": "Shimmer Refractor",
      "2025 Topps Chrome Fuchsia Wave #7": "Fuchsia Wave Refractor",
      "2025 Topps Chrome Black Ray Wave #7": "Black Ray Wave Refractor",
    };
    for (const [title, want] of Object.entries(expected)) {
      expect(P.parseListingIdentity(title)?.parallel, title).toBe(want);
    }
  });

  it("THE SOURCE CONTROL: a plain colour refractor is unchanged", () => {
    expect(P.parseListingIdentity("2025 Topps Chrome Black Refractor /10 #150")?.parallel).toBe("Black Refractor");
    expect(P.parseListingIdentity("2019 Topps Chrome Gold Refractor #150")?.parallel).toBe("Gold Refractor");
    expect(P.parseListingIdentity("2024 Bowman Chrome Refractor #BCP-9")?.parallel).toBe("Refractor");
  });

  it("MUTATION: without the dropped-family test the collapses are writable again", () => {
    // Revert the guard by asking the question it replaced -- "is the derived
    // parallel built entirely of product words?" (GUARD 1). Every collapse
    // answers NO, which is exactly why GUARD 1 let all 22 lines through.
    for (const c of FAMILY_COLLAPSES) {
      const tokens = V.nameTokens(c.derived) as string[];
      const allProductWords = tokens.length > 0 && tokens.every((t: string) => V.isProductWord(t, c.setKey));
      expect(allProductWords, c.what).toBe(false);
    }
  });

  // ── THE BLANK ANSWER IS THE WORSE COLLAPSE (verifier residual, 2026-09-03) ─
  //
  // GUARD 4 shipped gated on `!axisIsBlank("parallel", derivedParallel)`, which
  // excludes exactly "", "Base", "[Base]", "none" and "unknown" -- so a
  // derivation that read a finish family and answered BASE escaped the guard,
  // while the same derivation answering the WRONG SIBLING was caught. The
  // guard's own comment claimed it ran on any derived parallel; it did not.
  //
  // The blank answer drops the family AND the colour, and the row it leaves is
  // a numbered base. It is also the shape that lets a cardNumber fill through:
  // GUARD 2 refuses only the printRun, so the same row's NUMBER still moved.
  describe("...and a derivation that answers Base/blank is the SAME collapse", () => {
    const BLANK_ANSWERS: Array<{ what: string; derived: string }> = [
      { what: "Base", derived: "Base" },
      { what: "blank", derived: "" },
      { what: "[Base]", derived: "[Base]" },
      { what: "unknown", derived: "unknown" },
    ];

    // The row is IMPROVE-shaped on the axis it FILLS (the cardNumber), while
    // the parallel axis AGREES at blank -- stored Base, derived Base. That is
    // the shipped shape: a stored blank against a derived "Base" reads as
    // `changed:parallel` and classifies CONFLICT, which never reaches
    // `improveRefusals` at all. The leak lives where the parallel agrees and
    // the NUMBER moves.
    for (const b of BLANK_ANSWERS) {
      it(`refuses "Purple Laser" answered as ${b.what}`, () => {
        const res = improveRow({
          title: "2023 Topps Chrome Purple Laser Refractor Julio Rodriguez #150",
          year: 2023, setKey: "topps-chrome", sport: "baseball",
          cardNumber: "150", storedParallel: b.derived, derivedParallel: b.derived,
        });
        expect(res.klass, b.what).toBe("IMPROVE");
        expect(res.writable, b.what).toBe(false);
        expect(refusalText(res)).toMatch(/improve-title-names-a-finish-family-the-derivation-dropped:laser/);
      });
    }

    it('THE PIN: title "Purple Laser" + derived Base -> REFUSED', () => {
      const res = improveRow({
        title: "2023 Topps Chrome Purple Laser Refractor Julio Rodriguez #150",
        year: 2023, setKey: "topps-chrome", sport: "baseball",
        cardNumber: "150", storedParallel: "Base", derivedParallel: "Base",
      });
      expect(res.klass).toBe("IMPROVE");
      expect(res.writable).toBe(false);
      expect(refusalText(res)).toMatch(/the-derivation-dropped:laser@Base/);
    });

    it('"Electric Etch" answered as Base is refused on the etch family', () => {
      const res = improveRow({
        title: "2022 Panini Prizm Electric Etch Green #300 Ja Morant",
        year: 2022, setKey: "panini-prizm", sport: "basketball",
        cardNumber: "300", storedParallel: "Base", derivedParallel: "Base",
      });
      expect(res.writable).toBe(false);
      expect(refusalText(res)).toMatch(/the-derivation-dropped:etch/);
    });

    it("AND THE cardNumber CANNOT FILL THROUGH IT -- the whole IMPROVE is refused", () => {
      // The leak this closes: GUARD 2 refuses the printRun fill only, so a
      // title naming a finish the derivation could not read still moved the
      // row's NUMBER onto the base slug. A derivation that could not read the
      // parallel has not earned a write on any axis of this row.
      const res = improveRow({
        title: "2023 Topps Chrome Purple Laser Refractor Julio Rodriguez #150",
        year: 2023, setKey: "topps-chrome", sport: "baseball",
        cardNumber: "150", storedNumber: null,
        storedParallel: "Base", derivedParallel: "Base",
      });
      expect(res.klass).toBe("IMPROVE");
      expect(res.axes.filled).toContain("cardNumber");
      expect(res.writable).toBe(false);
    });

    it("CONTROL: a Base answer over a title naming NO family still writes", () => {
      // The guard must not become "refuse every blank parallel". A plain base
      // card's title names no finish family, nothing is dropped, and the row
      // is as writable as it ever was.
      const res = improveRow({
        title: "2023 Topps Chrome Julio Rodriguez #150",
        year: 2023, setKey: "topps-chrome", sport: "baseball",
        cardNumber: "150", storedParallel: "Base", derivedParallel: "Base",
      });
      expect(res.writable).toBe(true);
      expect(refusalText(res)).not.toMatch(/the-derivation-dropped/);
    });

    it("CONTROL: the product's OWN setKey word is still not a dropped family", () => {
      // "2023 Topps Chrome Sapphire" on a topps-chrome-sapphire card names the
      // SET. Widening the guard to blank parallels must not start demanding
      // that every base row on that product carry "sapphire".
      const res = improveRow({
        title: "2023 Topps Chrome Sapphire Julio Rodriguez #150",
        year: 2023, setKey: "topps-chrome-sapphire", sport: "baseball",
        cardNumber: "150", storedParallel: "Base", derivedParallel: "Base",
      });
      expect(refusalText(res)).not.toMatch(/the-derivation-dropped/);
    });

    it("MUTATION: the OLD blank gate let every one of these through", () => {
      // The shipped guard's own condition, evaluated directly. Each of these
      // derived values is `axisIsBlank`, so the old `!axisIsBlank(...)` gate
      // was false and GUARD 4 never ran -- while the family WAS dropped.
      const dropped = V.familyTokensDroppedByDerivation(
        "2023 Topps Chrome Purple Laser Refractor Julio Rodriguez #150", "", "topps-chrome",
      ) as string[];
      expect(dropped).toContain("laser");
      for (const b of BLANK_ANSWERS) {
        // `axisValue` lowercases the parallel before the blank test, exactly as
        // the classifier does, so this is the shipped gate's own condition.
        expect(K.axisIsBlank("parallel", b.derived.toLowerCase()), b.what).toBe(true);
      }
    });
  });
});

// ═══ 2 + 6. LOT / RANGE CARD NUMBERS ═══════════════════════════════════════

const LOT_LINES: Array<{ what: string; title: string; year: number; setKey: string; number: string }> = [
  // gate 1
  { what: "Complete Set #1-726 -> cardNumber 1", title: "1990 Topps Baseball Complete Set #1-726", year: 1990, setKey: "topps", number: "1" },
  { what: "#1-150 Pick Your Cards -> 1", title: "1989 Topps #1-150 Pick Your Cards", year: 1989, setKey: "topps", number: "1" },
  { what: "Singles #1-251 -> 1", title: "1989 O-Pee-Chee Singles #1-251", year: 1989, setKey: "o-pee-chee", number: "1" },
  { what: "#8-40 Insert -> 8", title: "1991 Donruss #8-40 Insert", year: 1991, setKey: "donruss", number: "8" },
  // gate 2
  { what: "Complete Base Set #1-400 -> 1", title: "1988 Score Complete Base Set #1-400", year: 1988, setKey: "score", number: "1" },
  { what: "Lot 110 different #1-125 -> 1", title: "1990 Fleer Lot 110 different #1-125", year: 1990, setKey: "fleer", number: "1" },
  { what: "Complete Set of 792 Cards with Frank Thomas #414 -> 692", title: "1990 Topps Complete Set of 792 Cards with Frank Thomas #414", year: 1990, setKey: "topps", number: "692" },
  { what: "LOT OF THREE (3)", title: "1991 Topps LOT OF THREE (3) Cards", year: 1991, setKey: "topps", number: "12" },
];

describe("2 + 6 -- a lot or a range listing never mints a cardNumber", () => {
  for (const l of LOT_LINES) {
    it(`refuses: ${l.what}`, () => {
      const res = improveRow({ title: l.title, year: l.year, setKey: l.setKey, sport: "baseball", cardNumber: l.number });
      expect(res.writable).toBe(false);
      expect(refusalText(res)).toMatch(/improve-lot-or-range-listing/);
    });

    it(`the detector says WHY: ${l.what}`, () => {
      const v = V.isLotOrRangeListing(l.title, P.isMultiCardLot(l.title));
      expect(v.lot).toBe(true);
      expect(v.reasons.length).toBeGreaterThan(0);
    });
  }

  it("the report can flag these as excludedFromFmv CANDIDATES -- it never sets the field", () => {
    // A multi-card sale in a single card's pool is wrong wherever it sits, and
    // refusing to MOVE it does not make it right where it is. That is Drew's
    // call: the classifier flags, the census counts, nothing writes.
    const res = improveRow({ title: LOT_LINES[0].title, year: 1990, setKey: "topps", sport: "baseball", cardNumber: "1" });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.writable).toBe(false);
    expect(refusalText(res)).toContain("lot-or-range-listing");
  });

  // ── CONTROLS ────────────────────────────────────────────────────────────
  it("CONTROL: a SET BREAK SINGLE is exactly one card and still writes", () => {
    expect(V.isLotOrRangeListing("2024 Bowman Chrome Refractor Complete Set Break Single #BCP-1", false).lot).toBe(false);
    const res = improveRow({ title: "2024 Bowman Chrome Refractor Set Break Single #BCP-1", year: 2024, setKey: "bowman-chrome", sport: "baseball", cardNumber: "BCP-1", derivedParallel: "Refractor" });
    expect(res.writable).toBe(true);
  });

  it("CONTROL: a hyphenated card number is not a range", () => {
    // CPA-JG, BCP-102 and BDC-1 are real card numbers. A range needs a numeric
    // second half STRICTLY GREATER than the first, which none of these has.
    for (const t of ["2026 Bowman #CPA-JG Justin Gonzalez 1st Auto", "2024 Bowman Chrome #BCP-102 Eric Hartman", "2023 Bowman Draft #BDC-1 Walker Jenkins"]) {
      expect(V.cardNumberRangeFromTitle(t), t).toBeNull();
      expect(V.isLotOrRangeListing(t, false).lot, t).toBe(false);
    }
  });

  it("CONTROL: an ordinary single-card title is untouched", () => {
    const res = improveRow({ title: "2019 Topps Chrome Gold Refractor #150 Aaron Judge", year: 2019, setKey: "topps-chrome", sport: "baseball", cardNumber: "150", derivedParallel: "Gold Refractor" });
    expect(res.writable).toBe(true);
  });

  it("CONTROL: a lot title that does NOT move the cardNumber is not refused by this guard", () => {
    // The guard refuses the axis a lot corrupts. A row whose number the
    // derivation left alone is not made unwritable by the word "lot".
    const res = improveRow({
      title: "2024 Bowman Chrome Lot of 6 Refractors #BCP-1", year: 2024, setKey: "bowman-chrome",
      sport: "baseball", cardNumber: "BCP-1", storedNumber: "BCP-1", derivedParallel: "Refractor",
    });
    expect(refusalText(res)).not.toMatch(/improve-lot-or-range-listing/);
  });

  it("MUTATION: without the guard every one of these lines is writable", () => {
    // The pre-fix classifier had NO cardNumber guard at all, so the only test
    // a lot line had to pass was "did the derivation fill an axis" -- and each
    // of these fills cardNumber. Assert the shape that made them writable.
    for (const l of LOT_LINES) {
      const res = improveRow({ title: l.title, year: l.year, setKey: l.setKey, sport: "baseball", cardNumber: l.number });
      expect(res.axes.filled.concat(res.axes.changed), l.what).toContain("cardNumber");
    }
  });
});

// ═══ 3. MISSPELLED REFRACTOR ═══════════════════════════════════════════════

describe("3 -- a misspelled finish word still DISQUALIFIES an eviction", () => {
  for (const [word, title] of [
    ["Refactor", "1993 Topps Finest Refactor #150 Derek Jeter"],
    ["Refracor", "1993 Topps Finest Refracor #150 Derek Jeter"],
    ["Refractpr", "1993 Topps Finest Refractpr #150 Derek Jeter"],
  ] as const) {
    it(`refuses to evict a genuine refractor spelled "${word}"`, () => {
      const res = evictionRow(title);
      expect(res.writable).toBe(false);
      expect(res.reasons.join(" ")).toMatch(/title-near-misses-a-finish/);
    });

    it(`the predicate reads "${word}" as one edit from refractor`, () => {
      const near = V.titleNearMissesFinish(title, "topps-finest");
      expect(near).not.toBeNull();
      expect(near.matched).toBe("refractor");
    });
  }

  it("it is DISQUALIFYING ONLY -- a near miss never mints a parallel", () => {
    // The near miss says "we cannot read this title". The answer to an
    // unreadable title is to leave the row alone, never to guess a finish.
    // titleNamesFinish -- the POSITIVE reader -- is untouched by it.
    expect(V.titleNamesFinish("1993 Topps Finest Refactor #150", { year: 1993, setKey: "topps-finest" })).toBe(false);
  });

  // ── CONTROLS ────────────────────────────────────────────────────────────
  it("CONTROL: 'Refractor' spelled right still names a finish, through the ordinary vocabulary", () => {
    expect(V.titleNamesFinish("1993 Topps Finest Refractor #150", { year: 1993, setKey: "topps-finest" })).toBe(true);
    // ...and is NOT reported as a typo
    expect(V.titleNearMissesFinish("1993 Topps Finest Refractor #150", "topps-finest")).toBeNull();
  });

  it("CONTROL: a base-titled row on a refractor slug STILL evicts", () => {
    const res = evictionRow("1993 Topps Finest #150 Derek Jeter");
    expect(res.subclass).toBe(K.BASE_EVICTION);
    expect(res.writable).toBe(true);
  });

  it("CONTROL: short words are NOT near-missed -- the 7-char floor is the safety", () => {
    // Every 1-edit neighbourhood of a short word is full of real English.
    // "bold" must not read as "gold", "cave" must not read as "wave".
    expect(V.NEAR_MISS_MIN_LEN).toBeGreaterThanOrEqual(7);
    // The predicate itself is the claim: no short word reaches it at all.
    for (const w of ["bold", "cave", "dave", "wave", "gold", "hold", "lava", "java"]) {
      expect(w.length < V.NEAR_MISS_MIN_LEN || V.CORE_FINISH_TOKENS.includes(w), w).toBe(true);
    }
    // ...and a title of ordinary short words still evicts. ("Bold Print" is
    // NOT used here: `print` reaches the vocabulary's own short-print/printing-
    // plate phrases, which is the ordinary reader doing its job, not a near
    // miss -- and this pin is about the near-miss floor.)
    for (const t of ["1993 Topps Finest #150 Cave Player", "1993 Topps Finest #150 Dave Winfield"]) {
      expect(V.titleNearMissesFinish(t, "topps-finest"), t).toBeNull();
      expect(evictionRow(t).writable, t).toBe(true);
    }
  });

  it("CONTROL: a longer word that merely STARTS with a finish word is not a typo", () => {
    // Found by re-classifying slot 13: "...Auto #CPA-KC Diamondb" is
    // "Diamondbacks", the TEAM, cut off by the census sample's 68-char title
    // truncation -- and "diamondb" is one insertion from "diamond", which IS a
    // finish word. Read as a typo it refused a genuine eviction because the
    // seller named the team. A real typo diverges INSIDE the word; a word that
    // has the vocabulary word as a leading or trailing run is a longer word or
    // a truncation of one, and neither is a misspelling.
    expect(V.titleNearMissesFinish("2025 Bowman Chrome Draft 1st Kayson Cunningham Auto #CPA-KC Diamondb", "bowman-chrome")).toBeNull();
    expect(V.titleNearMissesFinish("2025 Topps Chrome Arizona Diamondbacks #150 Corbin Carroll", "topps-chrome")).toBeNull();
    // ...and the four real misspellings the shards carry all still fire,
    // including one the audit gate did not name ("Refrqctor", slot 5).
    for (const [t, sk] of [
      ["2025 Topps Resurgence Drake Maye Refractpr Patriots", "topps"],
      ["2026 Topps Chrome Wrecking Crew Refracor WC-2", "topps-chrome"],
      ["2026 Topps Chrome #P-4 Perspectives Refactor", "topps-chrome"],
      ["2026 Topps Chrome Jac Caglianone Refrqctor #91CB-20", "topps-chrome"],
    ] as const) {
      expect(V.titleNearMissesFinish(t, sk), t).not.toBeNull();
    }
  });

  it("the distance function counts substitution, deletion, insertion and transposition -- and nothing more", () => {
    expect(V.editDistanceAtMost1("refractor", "refractpr")).toBe(true);   // substitution
    expect(V.editDistanceAtMost1("refractor", "refracor")).toBe(true);    // deletion
    expect(V.editDistanceAtMost1("refractor", "refracttor")).toBe(true);  // insertion
    expect(V.editDistanceAtMost1("refractor", "refratcor")).toBe(true);   // transposition
    expect(V.editDistanceAtMost1("refractor", "refrctpr")).toBe(false);   // two edits
    expect(V.editDistanceAtMost1("refractor", "superfractor")).toBe(false);
  });

  it("MUTATION: without the near-miss test all three typos evict", () => {
    // The pre-fix path is exactly `titleNamesFinish` alone, which reads none
    // of them -- which is how seven genuine refractors landed on base slugs.
    // The colour is dropped from these fixtures deliberately: "Gold" is itself
    // a finish word, so a "Gold Refactor" title is already disqualified by the
    // ordinary vocabulary and proves nothing about the typo. The seven audited
    // lines that WROTE are the ones where the misspelling is the only finish
    // evidence in the title.
    for (const t of ["1993 Topps Finest Refactor #150", "1993 Topps Finest Refracor #150", "1993 Topps Finest Refractpr #150"]) {
      expect(V.titleNamesFinish(t, { year: 1993, setKey: "topps-finest" }), t).toBe(false);
      // ...and the near-miss reader is the only thing that catches them
      expect(V.titleNearMissesFinish(t, "topps-finest"), t).not.toBeNull();
      expect(evictionRow(t).writable, t).toBe(false);
    }
  });
});

// ═══ 4. A STOPWORD THAT IS A CHECKLIST PARALLEL ════════════════════════════

describe("4 -- a stopword the product's checklist names as a parallel is NOT stopped there", () => {
  it("'america' is a parallel on the products whose checklist lists it", () => {
    // Verified in the committed corpus: Panini Stars & Stripes USA 2024 and
    // 2025 list "America" as a parallel NAME.
    expect(V.vocabularyFor(2024, "panini-stars-stripes-usa").isFinishToken("america")).toBe(true);
    expect(V.titleNamesFinish("2024 Panini Stars Stripes USA America #240", { year: 2024, setKey: "panini-stars-stripes-usa" })).toBe(true);
  });

  it("...and STAYS stopped everywhere else -- the exception is per product", () => {
    expect(V.CORPUS_STOPWORDS.has("america")).toBe(true);
    for (const [y, sk] of [[2025, "topps-chrome"], [2024, "panini-prizm"], [1990, "topps"]] as const) {
      expect(V.vocabularyFor(y, sk).isFinishToken("america"), `${y} ${sk}`).toBe(false);
    }
  });

  it("the exception is ELIGIBILITY-GATED -- it cannot re-open the leaks the stopwords closed", () => {
    // The unrestricted rule un-stops 121 products on 22 words -- signature,
    // auto, dual, rookie, patch, gem, cards. Each of those is stopped because
    // it describes the CARD or the SLAB, and a checklist row does not overturn
    // that. Only words whose stop rests on "this names a country / a sport /
    // a checklist" are eligible, because that is the claim a product's own
    // checklist can genuinely rebut.
    for (const w of ["signature", "auto", "dual", "rookie", "patch", "gem", "jersey", "cards", "variation"]) {
      expect(V.STOPWORD_EXCEPTION_ELIGIBLE.has(w), w).toBe(false);
    }
    for (const w of ["america", "usa", "baseball", "football"]) {
      expect(V.STOPWORD_EXCEPTION_ELIGIBLE.has(w), w).toBe(true);
    }
  });

  it("CONTROL: the sport-word and grade-word pins from the first ladder still hold", () => {
    // Un-stopping a sport GLOBALLY was the defect the ladder fixed. Only the
    // handful of products whose checklist literally names one may except it.
    const ex = V.buildVocabulary().stopwordExceptions as Map<string, Set<string>>;
    expect(ex.size).toBeLessThan(20);
    expect(V.vocabularyFor(2025, "topps-chrome").isFinishToken("football")).toBe(false);
    expect(V.vocabularyFor(2025, "topps-chrome").isFinishToken("gem")).toBe(false);
    expect(V.titleNamesFinish("2025 Topps Chrome Football Colston Loveland Rookie Auto PSA 10 GEM MINT", { year: 2025, setKey: "topps-chrome" })).toBe(false);
  });

  // -- THE PRODUCT THE CORPUS-DRIVEN EXCEPTION COULD NOT REACH ---------------
  //
  // "2023 Donruss America #240" is the title leak 4 was WRITTEN FROM, and
  // after leak 4 shipped it STILL evicted. The exception is corpus-driven, and
  // the corpus's donruss slices carry no parallel NAMES at all -- measured on
  // the committed corpus, `baseball|2023|donruss` holds 11 rows and every one
  // is pack-size or odds noise from a scrape that never captured the parallel
  // table ("30 cards.", "10 cards.", "80", "77", "Black 1/1"). So
  // `stopwordExceptions` for that product is empty, `america` keeps its global
  // stop, and a genuine America /50 evicts onto the base slug.
  //
  // HAND_STOPWORD_EXCEPTIONS is the same mechanism's hand list, and it carries
  // the entry. Sources quoted at the table: BaseballCardPedia "2023 Donruss"
  // -- "America (serial-numbered to 50 copies)"; Cardboard Connection "2023
  // Donruss Baseball" -- "America - #/50"; TCDB carries it as its own
  // checklist, "2023 Donruss - America" (sid 367832); and the same ladder in
  // 2022 at #/50.
  describe("...and a product whose CORPUS SLICE is empty gets the entry by hand", () => {
    it("THE LEAK: the corpus cannot rebut the stop, because it lists no donruss parallels", () => {
      const raw = require_(path.join(backend, "data", "checklist-parallel-names.json")) as {
        products: Record<string, { parallels: Array<{ name: string }> }>;
      };
      const names = raw.products["baseball|2023|donruss"].parallels.map((x) => x.name);
      // Noise, not a parallel table. If this ever stops being true the hand
      // entry is redundant and should be deleted -- see the note on the table.
      expect(names.some((n) => /america/i.test(n))).toBe(false);
    });

    it("2023 Donruss America names a finish, and its card no longer evicts", () => {
      expect(V.titleNamesFinish("2023 Donruss America #240 Corbin Carroll", { year: 2023, setKey: "donruss" })).toBe(true);
      expect(V.vocabularyFor(2023, "donruss").isFinishToken("america")).toBe(true);
    });

    it("2022 Donruss carries the same parallel at the same run", () => {
      expect(V.titleNamesFinish("2022 Donruss America #150 Julio Rodriguez", { year: 2022, setKey: "donruss" })).toBe(true);
    });

    it("CONTROL: the entry is SCOPED -- a donruss year the sources do not cover keeps the stop", () => {
      // 2024 and 2021 Donruss are not in the hand list, and neither is a
      // donruss FOOTBALL product: the 2022/2023 Donruss football ladders were
      // checked in the same pass (Beckett, Cardboard Connection) and neither
      // lists an America parallel. A hand entry that guessed football would
      // un-stop a word on a product whose checklist does not name it.
      expect(V.titleNamesFinish("2024 Donruss America #150 X", { year: 2024, setKey: "donruss" })).toBe(false);
      expect(V.titleNamesFinish("2021 Donruss America #150 X", { year: 2021, setKey: "donruss" })).toBe(false);
      expect(V.vocabularyFor(2024, "donruss").isFinishToken("america")).toBe(false);
    });

    it("CONTROL: `america` stays stopped on every OTHER product", () => {
      expect(V.titleNamesFinish("2023 Topps America #150 X", { year: 2023, setKey: "topps" })).toBe(false);
      expect(V.vocabularyFor(2024, "topps-chrome").isFinishToken("america")).toBe(false);
    });

    it("a hand entry cannot reach a word the eligibility gate protects", () => {
      // The gate applies to a hand entry exactly as it does to a corpus one.
      // An entry naming `signature`, `gem` or `patch` is DROPPED at build
      // time, so this list can never become a way around the stopword rules.
      for (const [, words] of V.HAND_STOPWORD_EXCEPTIONS as Map<string, string[]>) {
        for (const w of words) {
          expect(V.CORPUS_STOPWORDS.has(w), w).toBe(true);
          expect(V.STOPWORD_EXCEPTION_ELIGIBLE.has(w), w).toBe(true);
        }
      }
    });

    it("the hand table is a patch, not a second corpus -- it stays under its ceiling", () => {
      let n = 0;
      for (const [, words] of V.HAND_STOPWORD_EXCEPTIONS as Map<string, string[]>) n += words.length;
      expect(n).toBeLessThanOrEqual(V.HAND_STOPWORD_EXCEPTION_CEILING);
    });

    it("MUTATION: without the hand entry the Donruss America card evicts again", () => {
      // Revert the entry by asking what the CORPUS alone proves for this
      // product -- which is what the shipped leak-4 fix had, and all it had.
      // No donruss parallel row names `america`, so the corpus-driven
      // exception is empty and the stop stands: `titleNamesFinish` answers
      // false and a genuine America /50 evicts onto the base slug.
      const raw = require_(path.join(backend, "data", "checklist-parallel-names.json")) as {
        products: Record<string, { parallels: Array<{ name: string }> }>;
      };
      const corpusProves = (pk: string) =>
        (raw.products[pk]?.parallels ?? []).some(
          (x) => String(x.name ?? "").trim().toLowerCase() === "america",
        );
      expect(corpusProves("baseball|2023|donruss")).toBe(false);
      expect(corpusProves("baseball|2022|donruss")).toBe(false);
      // ...while the products the corpus DOES prove need no hand entry at all,
      // which is why the table has two rows and not four.
      expect(corpusProves("baseball|2024|panini-stars-stripes-usa")).toBe(true);
      expect([...(V.HAND_STOPWORD_EXCEPTIONS as Map<string, string[]>).keys()])
        .not.toContain("2024|panini-stars-stripes-usa");
      // And the merged view -- corpus plus hand -- is what the guard reads.
      expect(V.vocabularyFor(2023, "donruss").stopwordExceptions.has("america")).toBe(true);
    });
  });

  it("MUTATION: an unconditional stop reads the real parallel as silence", () => {
    // The pre-fix behaviour, driven directly: the global stopword set alone
    // says 'america' is never a finish, on any product.
    expect(V.CORPUS_STOPWORDS.has("america")).toBe(true);
  });
});

// ═══ 5. THE SERIAL TAIL ════════════════════════════════════════════════════

describe("5 -- the serial tail accepts any non-digit boundary", () => {
  const CASES: Array<[string, number]> = [
    ["2020 Panini Prizm Blue Disco 1/25!", 25],
    ["2024 Bowman Chrome Refractor #/99\u{1F525}\u{1F525}", 99],
    ["2021 Topps Chrome Gold 100/100***BOOK", 100],
    ["2023 Topps Update Elly De La Cruz #/398", 398],
    ["2020 Panini Prizm Tie-Dye Prizm #/25", 25],
  ];

  for (const [title, want] of CASES) {
    it(`reads the serial in ${JSON.stringify(title)}`, () => {
      expect(V.serialFromTitle(title)).toBe(want);
      expect(V.titleStatesSerial(title)).toBe(true);
    });
  }

  it("a title naming a parallel AND a serial no longer mints a numbered BASE", () => {
    for (const [title] of CASES) {
      const res = improveRow({ title, year: 2021, setKey: "panini-prizm", sport: "basketball", cardNumber: "12", printRun: 25 });
      expect(res.writable, title).toBe(false);
      expect(refusalText(res), title).toMatch(/numbered-base-not-checklist-defined|printrun-onto-base/);
    }
  });

  // ── CONTROLS ────────────────────────────────────────────────────────────
  it("CONTROL: a YEAR denominator is still a date, not a print run", () => {
    expect(V.serialFromTitle("sold 8/2026")).toBeNull();
    expect(V.serialFromTitle("2020 Panini 5/2026")).toBeNull();
    expect(V.serialFromTitle("listed 11/1999")).toBeNull();
  });

  it("CONTROL: a longer digit run is still one number, not a truncated one", () => {
    // The boundary is "not another digit", so /2500 is 2500 and never 250.
    expect(V.serialFromTitle("2024 Topps Chrome Gold /2500")).toBe(2500);
  });

  it("MUTATION: the OLD tail rejects every one of the trailing-punctuation cases", () => {
    // The pre-fix tail: end-of-string, whitespace, or one of ) ] , .
    const OLD_TAIL = /(?=$|[\s)\],.])/.source;
    const oldNumbered = new RegExp(String.raw`(?:^|[\s(\[#])(\d{1,5})\s*\/\s*(\d{1,5})` + OLD_TAIL);
    const oldBare = new RegExp(String.raw`(?:^|[\s(\[]|#)\s*\/\s*(\d{1,5})` + OLD_TAIL);
    for (const t of ["2020 panini prizm blue disco 1/25!", "2024 bowman chrome refractor #/99\u{1F525}\u{1F525}", "2021 topps chrome gold 100/100***book"]) {
      expect(oldNumbered.test(t) || oldBare.test(t), t).toBe(false);
      // ...and the new one reads it
      expect(V.serialFromTitle(t), t).not.toBeNull();
    }
  });
});

// ═══ 7. NUMBERED BASE IS CHECKLIST-DEFINED ═════════════════════════════════

describe("7 -- a numbered base is checklist-defined AT ITS PRINT RUN", () => {
  it("refuses a numbered base the product's checklist never lists", () => {
    const res = improveRow({ title: "2019 Topps Aaron Judge #150 /75", year: 2019, setKey: "topps", sport: "baseball", cardNumber: "150", printRun: 75 });
    expect(res.writable).toBe(false);
    expect(refusalText(res)).toMatch(/improve-numbered-base-not-checklist-defined:\/75/);
  });

  it("the predicate asks about a CARD -- a Base row AT that run -- not about a token", () => {
    // Measured on the committed corpus: 36,699 parallel rows, 27,009 carrying
    // a print run, ZERO whose NAME is bare "Base". So no product defines a
    // numbered base today and the guard refuses every one, which IS the ruling.
    expect(V.checklistDefinesNumberedBase(2019, "topps", 75)).toBe(false);
    expect(V.checklistDefinesNumberedBase(2024, "bowman", 499)).toBe(false);
    expect(V.buildVocabulary().baseRunsByProduct.size).toBe(0);
  });

  it("the OLD test could not answer the question at all -- it was VACUOUS, not inverted", () => {
    // THE PR BODY GOT THIS BACKWARDS, AND THE CORRECTION MATTERS.
    //
    // `checklistListsParallel("Base", ...)` is a TOKEN-membership test, and
    // `base` is a CORPUS STOPWORD -- so `nameTokens("base")` is the EMPTY
    // list, the function's own `if (!toks.length) return false` fires, and it
    // returns FALSE for every product. Not true for every product, as the
    // first write-up claimed. Measured on the committed corpus: false on all
    // 576 of them.
    //
    // That is why the swap to `checklistDefinesNumberedBase` is a HARDENING
    // and not the fix. `!false` is true, so the OLD predicate also refused
    // every numbered base -- it just refused for the wrong reason (an empty
    // token list) instead of the ruled one (no checklist defines one). What
    // actually made leak 7 writable was the UNREACHABLE BRANCH pinned below.
    expect(V.nameTokens("base")).toEqual([]);
    for (const [y, sk] of [[2021, "bowman-chrome"], [2024, "topps-chrome"], [2023, "panini-prizm"]] as const) {
      expect(V.checklistListsParallel("Base", y, sk), `${y} ${sk}`).toBe(false);
    }
    // The replacement asks about a CARD and can answer either way -- it reads
    // the corpus's own printRun field rather than a token.
    expect(typeof V.checklistDefinesNumberedBase(2019, "topps", 75)).toBe("boolean");
  });

  // -- THE PIN ONLY checklistDefinesNumberedBase CAN SATISFY -----------------
  //
  // On the committed corpus the two predicates are INDISTINGUISHABLE: both
  // answer false on all 576 products, so reverting the guard to the old one
  // changes no verdict and the mutation survives. They differ only where a
  // checklist DOES list a numbered base -- which is exactly the case the
  // ruling exists to admit ("a future checklist that lists one is admitted
  // with no code change"), and the case the guard had never been tested on.
  //
  // So the pin supplies that checklist. A product whose Base row carries a
  // print run of 25 must let an IMPROVE fill /25 through, and must still
  // refuse /26. Under the OLD predicate the /25 fill is refused -- `base` has
  // no tokens whatever the checklist says -- and this block goes red.
  describe("a checklist that DOES define a numbered base admits it -- and only at that run", () => {
    const FIXTURE = {
      builtAt: "2026-09-03T00:00:00Z",
      sources: ["pin: rematchAuditGateLeaks -- leak 7"],
      productCount: 1,
      parallelNameCount: 3,
      products: {
        "baseball|2031|pin-numbered-base": {
          sport: "baseball", year: 2031, setKey: "pin-numbered-base",
          parallels: [
            // THE NUMBERED BASE: a row whose NAME is bare "Base", with a run.
            { name: "Base", printRun: 25, odds: null, seen: 100, spellings: ["Base"] },
            // A NAMED PARALLEL of the base card, which is NOT a numbered base
            // -- the discrimination BASE_ROW_NAMES exists to make.
            { name: "Base Refractor", printRun: 499, odds: null, seen: 100, spellings: ["Base Refractor"] },
            { name: "Gold Refractor", printRun: 50, odds: null, seen: 100, spellings: ["Gold Refractor"] },
          ],
        },
      },
    };

    let corpusFile = "";
    beforeAll(() => {
      const fs = require_("node:fs") as typeof import("node:fs");
      const os = require_("node:os") as typeof import("node:os");
      corpusFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "hiq-numbered-base-")),
        "checklist-parallel-names.json",
      );
      fs.writeFileSync(corpusFile, JSON.stringify(FIXTURE), "utf8");
      V._reset(corpusFile);
    });
    afterAll(() => { V._reset(); });

    it("the fixture corpus really does define one -- the committed corpus defines none", () => {
      expect(V.buildVocabulary(corpusFile).baseRunsByProduct.get("2031|pin-numbered-base")).toEqual(new Set([25]));
      expect(V.checklistDefinesNumberedBase(2031, "pin-numbered-base", 25)).toBe(true);
    });

    it("IMPROVE fills the numbered base AT the run the checklist lists", () => {
      const res = improveRow({
        title: "2031 Pin Numbered Base Aaron Judge #150 /25",
        year: 2031, setKey: "pin-numbered-base", sport: "baseball",
        cardNumber: "150", storedNumber: "150", printRun: 25,
      });
      expect(refusalText(res)).not.toMatch(/improve-numbered-base-not-checklist-defined/);
    });

    it("...and REFUSES it at a run the checklist does not list", () => {
      const res = improveRow({
        title: "2031 Pin Numbered Base Aaron Judge #150 /26",
        year: 2031, setKey: "pin-numbered-base", sport: "baseball",
        cardNumber: "150", storedNumber: "150", printRun: 26,
      });
      expect(res.writable).toBe(false);
      expect(refusalText(res)).toMatch(/improve-numbered-base-not-checklist-defined:\/26/);
    });

    it('"Base Refractor /499" is a NAMED PARALLEL, never a numbered base', () => {
      // The five corpus rows that BEGIN with the word "Base" are parallels OF
      // the base card. Counting them would admit a numbered base on every
      // product that lists one, which is the opposite of the ruling.
      expect(V.checklistDefinesNumberedBase(2031, "pin-numbered-base", 499)).toBe(false);
      expect(V.checklistDefinesNumberedBase(2031, "pin-numbered-base", 50)).toBe(false);
    });

    it("MUTATION: the OLD predicate refuses the checklist-defined base -- this pin goes RED", () => {
      // THE WHOLE POINT OF THIS BLOCK. `checklistListsParallel("Base", ...)`
      // cannot answer yes for ANY product, this fixture included, because
      // `base` tokenises to nothing. Swap it back into the guard and the /25
      // fill above -- the one the ruling says to ADMIT -- is refused.
      expect(V.checklistListsParallel("Base", 2031, "pin-numbered-base")).toBe(false);
      expect(V.checklistDefinesNumberedBase(2031, "pin-numbered-base", 25)).toBe(true);
      // The two predicates DISAGREE here and NOWHERE in the committed corpus.
      // That disagreement is the mutation the committed corpus cannot detect,
      // which is why this fixture exists at all.
      expect(V.checklistListsParallel("Base", 2031, "pin-numbered-base"))
        .not.toBe(V.checklistDefinesNumberedBase(2031, "pin-numbered-base", 25));
    });
  });

  it("MUTATION: the branch was also UNREACHABLE -- a serial makes titleNamesFinish true by definition", () => {
    // `titleNamesFinish` opens with `if (titleStatesSerial(t)) return true`.
    // So wherever serial !== null, the finish-word branch always won and the
    // numbered-base refusal never ran at all. Two independent defects, stacked.
    const t = "2019 Topps Aaron Judge #150 /75";
    expect(V.serialFromTitle(t)).toBe(75);
    expect(V.titleNamesFinish(t, { year: 2019, setKey: "topps" })).toBe(true);
  });

  it("CONTROL: a print run onto a NAMED parallel is untouched by this guard", () => {
    const res = improveRow({ title: "2019 Topps Chrome Gold Refractor #150 /50", year: 2019, setKey: "topps-chrome", sport: "baseball", cardNumber: "150", derivedParallel: "Gold Refractor", printRun: 50 });
    expect(refusalText(res)).not.toMatch(/numbered-base-not-checklist-defined/);
  });
});

// ═══ 8. THE APPLY CLASS SCOPE ══════════════════════════════════════════════

describe("8 -- the apply is scopable to a class, on the EXISTING scope input", () => {
  it("parses the three scopes the dispatch may use", () => {
    expect([...K.parseApplyScope("base-eviction").classes]).toEqual([K.BASE_EVICTION]);
    expect([...K.parseApplyScope("improve").classes]).toEqual([K.IMPROVE]);
    expect([...K.parseApplyScope("both").classes].sort()).toEqual([K.BASE_EVICTION, K.IMPROVE].sort());
    expect(K.parseApplyScope("improve,base-eviction").ok).toBe(true);
  });

  it("REFUSES the runner's inherited default -- an apply says which class it writes", () => {
    // backfill-runner.yml's `scope` defaults to "refractor" and its own
    // description says the value is INHERITED, not chosen. An inherited
    // default must never arm a write.
    const r = K.parseApplyScope("refractor");
    expect(r.ok).toBe(false);
    expect(r.classes.size).toBe(0);
    expect(K.parseApplyScope("").ok).toBe(false);
  });

  it("half a scope is no scope -- a typo never arms a class silently", () => {
    const r = K.parseApplyScope("base-eviction,bogus");
    expect(r.ok).toBe(false);
    expect(r.classes.size).toBe(0);
    expect(r.reason).toMatch(/unrecognised/);
  });

  it("THE PIN: a base-eviction scope REFUSES to write an IMPROVE row", () => {
    const improve = improveRow({ title: "2019 Topps Chrome Gold Refractor #150 Aaron Judge", year: 2019, setKey: "topps-chrome", sport: "baseball", cardNumber: "150", derivedParallel: "Gold Refractor" });
    expect(improve.writable).toBe(true);                       // writable as a class
    const evictOnly = K.parseApplyScope("base-eviction").classes;
    expect(K.writableUnderScope(improve, evictOnly)).toBe(false);   // and NOT under this scope
    expect(K.applyKindOf(improve)).toBe(K.IMPROVE);
  });

  it("THE PIN: an improve scope REFUSES to write a BASE-EVICTION row", () => {
    const evict = evictionRow("1993 Topps Finest #150 Derek Jeter");
    expect(evict.writable).toBe(true);
    const improveOnly = K.parseApplyScope("improve").classes;
    expect(K.writableUnderScope(evict, improveOnly)).toBe(false);
    expect(K.applyKindOf(evict)).toBe(K.BASE_EVICTION);
  });

  it("and each class IS writable under its own scope, and under both", () => {
    const improve = improveRow({ title: "2019 Topps Chrome Gold Refractor #150 Aaron Judge", year: 2019, setKey: "topps-chrome", sport: "baseball", cardNumber: "150", derivedParallel: "Gold Refractor" });
    const evict = evictionRow("1993 Topps Finest #150 Derek Jeter");
    expect(K.writableUnderScope(improve, K.parseApplyScope("improve").classes)).toBe(true);
    expect(K.writableUnderScope(evict, K.parseApplyScope("base-eviction").classes)).toBe(true);
    const both = K.parseApplyScope("both").classes;
    expect(K.writableUnderScope(improve, both)).toBe(true);
    expect(K.writableUnderScope(evict, both)).toBe(true);
  });

  it("the scope NEVER makes an unwritable row writable -- it can only subtract", () => {
    // Both halves are required, and this is the only place they are combined.
    const refused = improveRow({ title: FAMILY_COLLAPSES[0].title, year: 2025, setKey: "topps-chrome", cardNumber: "150", derivedParallel: "Black Refractor" });
    expect(refused.writable).toBe(false);
    for (const sc of ["improve", "base-eviction", "both"]) {
      expect(K.writableUnderScope(refused, K.parseApplyScope(sc).classes), sc).toBe(false);
    }
  });

  it("MUTATION: without the scope both classes write under one verdict", () => {
    // The pre-fix apply read `res.writable` alone, which is true for both.
    const improve = improveRow({ title: "2019 Topps Chrome Gold Refractor #150 Aaron Judge", year: 2019, setKey: "topps-chrome", sport: "baseball", cardNumber: "150", derivedParallel: "Gold Refractor" });
    const evict = evictionRow("1993 Topps Finest #150 Derek Jeter");
    expect(improve.writable && evict.writable).toBe(true);
  });

  it("the runner refuses an apply whose scope it cannot read, and does it BEFORE reading Cosmos", () => {
    const { spawnSync } = require_("node:child_process") as typeof import("node:child_process");
    const script = path.join(backend, "scripts", "rematch-sold-comps.cjs");
    const r = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, MODE: "apply-improve", SCOPE: "refractor", SLOT: "0", SLOTS: "32", COSMOS_CONNECTION_STRING: "unused" },
    });
    expect(r.status).toBe(2);
    expect(`${r.stderr}`).toMatch(/needs a class scope/);
    // ...and it never got as far as the Cosmos client
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/rematch-sold-comps\s+MODE=/);
    // THE ASSERTION IS THE EXIT CODE, NOT THE CLOCK. This spawns a cold `node`
    // that builds the 16,187-phrase corpus before it reaches the scope gate:
    // ~3s on an idle box, but measured at 70s when the rematch suites run
    // alongside each other and contend for CPU. The suite-wide 30s default
    // then fails a test whose subject passed. Given its own budget instead of
    // loosening the default for every test in the file.
  }, 180_000);

  it("MODE=census ignores the scope entirely -- a census counts every class", () => {
    const { spawnSync } = require_("node:child_process") as typeof import("node:child_process");
    const script = path.join(backend, "scripts", "rematch-sold-comps.cjs");
    const r = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, MODE: "census", SCOPE: "refractor", SLOT: "0", SLOTS: "32", COSMOS_CONNECTION_STRING: "" },
    });
    // It gets PAST the scope gate and stops at the connection check.
    expect(`${r.stderr}`).toMatch(/COSMOS_CONNECTION_STRING not set/);
    expect(`${r.stderr}`).not.toMatch(/needs a class scope/);
    // Same cold-corpus subprocess cost as the pin above.
  }, 180_000);
});
