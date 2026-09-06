/**
 * THE FIVE DERIVATION DEFECTS -- a parser bug is not a ruling.
 *
 * The 32-shard Great Rematch census (2026-09-03) returned 4,453,642 CONFLICT
 * rows. CONFLICT means "two rival readings of a card, and a fleet never
 * settles that -- Drew does", so every row in it is work queued for a human.
 * An aggregation over the shards found that the largest populations in that
 * queue are not rival readings at all. They are OUR OWN DERIVATION failing to
 * read what is plainly written in the title, and the census dutifully
 * reporting the failure as a disagreement:
 *
 *   D1  1,374,029  dropped:parallel   the stored row names a real finish, the
 *                                     derivation says Base, and in 98.5% of
 *                                     sampled cases THE TITLE STILL CONTAINS
 *                                     THE STORED COLOUR WORD.
 *   D6    171,125  changed:cardNumber 43% case-only (same card, split pool),
 *                                     18% prefix truncation (DIFFERENT cards
 *                                     merged: 1975-6 -> 1975).
 *   D7     33,283  changed:isAuto     100% no-auto -> auto, all from title
 *                                     words, against the pinned rule that
 *                                     isAuto's boundary is cardNumber.
 *   D8     58,241  changed:grade      raw condition adjectives read as numeric
 *                                     grades (VG-VGEX -> PSA 10).
 *   V3    ~285,000 changed:parallel   the derived parallel is a strict subset
 *                                     of the stored named one -- a LOSS
 *                                     (Prism Refractor -> Refractor), not a
 *                                     normalization.
 *
 * WHAT THESE PINS ARE FOR
 *
 * Each guard is DISQUALIFYING: it takes a derived reading out of contention
 * and names why. It never invents an identity -- absent beats wrong. So the
 * assertions below are about REFUSALS, and every one of them quotes a real
 * shape from the census artifacts:
 *
 *   - the class stays what the census measured (hiding the shape loses the
 *     count the fix is judged by),
 *   - `writable` goes false (that is what the apply pass reads),
 *   - and a NAMED reason appears (that is what lets this population be
 *     subtracted from Drew's queue and counted as a parser bug).
 *
 * The MUTATION CHECKS at the bottom prove each guard is load-bearing: revert
 * one clause and a specific defect comes back.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const CLASSIFIER = path.join(backend, "scripts", "lib", "rematch-classify.cjs");

type Identity = {
  sport?: string | null; cardYear?: number | null; setKey?: string | null;
  cardNumber?: string | null; parallel?: string | null; isAuto?: boolean | null;
  printRun?: number | null; gradeCompany?: string | null; gradeValue?: number | null;
};
type Result = {
  klass: string; tier: string; writable: boolean; reasons: string[];
  derivationRefusals: string[]; improveRefusals?: string[];
  axes: { same: string[]; filled: string[]; dropped: string[]; changed: string[] };
};
type ClassifyInput = {
  row: Record<string, unknown>; stored: Identity; derived: Identity | null;
  checklistBacked?: boolean; autoByCardNumber?: boolean;
  storedSlug?: string | null; baseDestSlug?: string | null; baseDestBacked?: boolean;
};
type Classifier = {
  AGREE: string; IMPROVE: string; CONFLICT: string; UNDERIVABLE: string;
  classifyRow: (i: ClassifyInput) => Result;
  derivationRefusals: (i: { row: Record<string, unknown>; stored: Identity; derived: Identity | null; autoByCardNumber?: boolean }) => string[];
  titleNamesStoredFinish: (title: string, parallel: string | null) => boolean;
  gradeFromTitleStrict: (title: string) => { gradeCompany: string; gradeValue: number } | null;
  cardNumberIsTruncation: (s: Identity, d: Identity) => string | null;
  cardNumberDiffersOnlyByCase: (s: Identity, d: Identity) => boolean;
  parallelIsGenericization: (s: Identity, d: Identity) => string | null;
};
const K = require_(CLASSIFIER) as Classifier;

const vendorRow = (over: Record<string, unknown> = {}) => ({ id: "r1", cardId: "hiq:x", source: "cardhedge", ...over });

/** The refusals for one (title, stored, derived) triple. */
const refuse = (title: string, stored: Identity, derived: Identity, autoByCardNumber = false) =>
  K.derivationRefusals({ row: vendorRow({ title }), stored, derived, autoByCardNumber });

// ── D1 ─────────────────────────────────────────────────────────────────────
describe("D1: a derived Base never displaces a stored finish the title names", () => {
  // Every title here is a real census line. The derived side says Base because
  // extractParallel is a closed ladder of enumerated colour+pattern pairs and
  // a bare colour matches no rule -- it falls through to `return "Base"`.
  const shapes: Array<[string, string]> = [
    // the terse CardHedge shape -- 94.5% of D1, finish is all that follows the number
    ["2025 Panini Prizm Football #99 Red Wave", "Red Wave"],
    ["2025 Topps Finest Baseball #FMA-BW Gold /5", "Gold"],
    ["2024 Topps Baseball #58 Team Color", "Team Color"],
    ["1956 Topps Baseball #130 Gray Back", "Gray Back"],
    ["2025 Panini Mosaic Football #195 Purple Scope", "Purple Scope"],
    ["2025 Donruss Optic Football #7 Purple Stars", "Purple Stars"],
    ["2024 Topps Pristine Baseball #178 Pristine Purple", "Pristine Purple"],
    ["2025 Panini Score Football #159 Dots Gold", "Dots Gold"],
    ["2025 Panini Prizm Black Football #101 Red Power", "Red Power"],
    ["2025 Topps Chrome Baseball #12 Coral Foil", "Coral Foil"],
  ];

  it.each(shapes)("%s refuses the flattening of %s", (title, parallel) => {
    expect(K.titleNamesStoredFinish(title, parallel)).toBe(true);
    const reasons = refuse(title, { parallel }, { parallel: "Base" });
    expect(reasons).toContain(`title-names-stored-finish:${parallel}`);
  });

  it("the refusal reaches the class: CONFLICT stays, writable is false, reason is named", () => {
    const stored: Identity = {
      sport: "football", cardYear: 2025, setKey: "panini-prizm", cardNumber: "99",
      parallel: "Red Wave", isAuto: false,
    };
    const r = K.classifyRow({
      row: vendorRow({ title: "2025 Panini Prizm Football #99 Red Wave" }),
      stored, derived: { ...stored, parallel: "Base" }, checklistBacked: true,
    });
    // The census must keep counting the shape -- the class is what it measured.
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.dropped).toContain("parallel");
    expect(r.writable).toBe(false);
    expect(r.derivationRefusals).toContain("title-names-stored-finish:Red Wave");
    expect(r.reasons.join(" ")).toMatch(/derivation-refused:title-names-stored-finish/);
  });

  it("a title naming a DIFFERENT finish is a real conflict and still reaches Drew", () => {
    // This is the line the guard must NOT swallow: the stored row says Red
    // Wave, the title says Blue Refractor. Two readings of the card, and a
    // fleet never settles that.
    expect(K.titleNamesStoredFinish("2025 Panini Prizm #99 Blue Refractor", "Red Wave")).toBe(false);
    expect(refuse("2025 Panini Prizm #99 Blue Refractor", { parallel: "Red Wave" }, { parallel: "Base" }))
      .not.toContain("title-names-stored-finish:Red Wave");
  });

  it("a stored Base is not a finish, so the guard never fires on the eviction shape", () => {
    // BASE-EVICTION depends on a stored parallel that names NOTHING. If this
    // guard fired there it would switch the subclass off entirely.
    expect(K.titleNamesStoredFinish("2024 Topps #58 Base", "Base")).toBe(false);
    expect(refuse("2024 Topps #58 Base", { parallel: "Base" }, { parallel: "Base" })).toHaveLength(0);
  });

  it("case, punctuation and plurals do not hide the stored name", () => {
    expect(K.titleNamesStoredFinish("2025 topps chrome #5 GOLD REFRACTORS", "Gold Refractor")).toBe(true);
    expect(K.titleNamesStoredFinish("2025 Bowman #1 Sky-Blue Border", "Sky Blue Border")).toBe(true);
  });
});

// ── D7 ─────────────────────────────────────────────────────────────────────
describe("D7: isAuto's boundary is cardNumber, never a title word", () => {
  const stored: Identity = {
    sport: "baseball", cardYear: 1953, setKey: "bowman", cardNumber: "10",
    parallel: "Base", isAuto: false,
  };

  it("a cut signature on a base card does not become an auto", () => {
    // "PSA AUTHENTIC AUTO" on a 1953 Bowman is a cut signature mounted with a
    // base card. No 1953 Bowman autograph subset exists to file it against.
    const title = "1953 Bowman Color #10 PSA AUTHENTIC AUTO";
    const r = K.classifyRow({
      row: vendorRow({ title }), stored, derived: { ...stored, isAuto: true },
      checklistBacked: true, autoByCardNumber: false,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("isAuto");
    expect(r.writable).toBe(false);
    expect(r.derivationRefusals).toContain("isauto-flip-from-title-only");
  });

  it.each([
    "1953 Bowman #10 Autograph",
    "1955 Topps #22 Signatures",
    "1952 Topps #1 AUTO signed",
  ])("%s is refused as a title-only flip", (title) => {
    expect(refuse(title, stored, { ...stored, isAuto: true })).toContain("isauto-flip-from-title-only");
  });

  it("a cardNumber-backed auto is NOT refused -- that is the real boundary", () => {
    // CPA- is an autograph-subset prefix. The card number says auto, so the
    // flag is the checklist's answer and the guard stands aside.
    const s: Identity = { sport: "baseball", cardYear: 2024, setKey: "bowman-chrome", cardNumber: "CPA-LD", parallel: "Base", isAuto: false };
    expect(refuse("2024 Bowman Chrome 1st Leo De Vries Auto CPA-LD PSA 10", s, { ...s, isAuto: true }, true))
      .not.toContain("isauto-flip-from-title-only");
  });

  it("the guard is one-directional: auto -> no-auto is a different shape", () => {
    // Dropping a stored auto flag is a demotion the axis diff already calls a
    // CONFLICT. This guard is about MINTING autos out of words.
    expect(refuse("2024 Bowman Chrome #CPA-LD", { ...stored, isAuto: true }, { ...stored, isAuto: false }))
      .not.toContain("isauto-flip-from-title-only");
  });
});

// ── D8 ─────────────────────────────────────────────────────────────────────
describe("D8: a grade is a grader token plus a numeral, nothing else", () => {
  it.each([
    ["1953 Bowman Mickey Mantle VG-VGEX", null],
    ["1955 Topps Roberto Clemente #164 VG-EX", null],
    ["1952 Topps #311 NM-MT", null],
    ["1956 Topps #135 GEM MINT", null],
    ["1957 Topps #95 EX-MT", null],
  ] as Array<[string, null]>)("%s states no grade", (title) => {
    expect(K.gradeFromTitleStrict(title)).toBe(null);
  });

  it("the numeral belongs to the grade phrase, not to the first digit in the title", () => {
    // "PSA GRADED EX-MT 6" derived PSA 9 -- the reader took a digit that was
    // not the grade. 6 is the grade; EX-MT is the adjective before it.
    expect(K.gradeFromTitleStrict("1953 Topps #82 PSA GRADED EX-MT 6")).toEqual({ gradeCompany: "PSA", gradeValue: 6 });
  });

  it.each([
    ["2024 Topps Chrome #1 PSA 10", "PSA", 10],
    ["2024 Bowman #5 BGS 9.5", "BGS", 9.5],
    ["1998 Topps #7 SGC 8", "SGC", 8],
  ] as Array<[string, string, number]>)("%s reads %s %d", (title, company, value) => {
    expect(K.gradeFromTitleStrict(title)).toEqual({ gradeCompany: company, gradeValue: value });
  });

  it("a raw row is not made PSA 10 by the word VG", () => {
    const stored: Identity = { sport: "baseball", cardYear: 1953, setKey: "bowman", cardNumber: "59", parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null };
    const r = K.classifyRow({
      row: vendorRow({ title: "1953 Bowman Mickey Mantle VG-VGEX" }),
      stored, derived: { ...stored, gradeCompany: "PSA", gradeValue: 10 }, checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.derivationRefusals.join(" ")).toMatch(/grade-from-title-without-grader:PSA 10/);
  });

  it("the wrong numeral is refused and both readings are quoted", () => {
    const stored: Identity = { sport: "baseball", cardYear: 1953, setKey: "topps", cardNumber: "82", parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null };
    const reasons = refuse("1953 Topps #82 PSA GRADED EX-MT 6", stored, { ...stored, gradeCompany: "PSA", gradeValue: 9 });
    expect(reasons.join(" ")).toMatch(/grade-numeral-not-adjacent-to-grader:derived=PSA 9,title=PSA 6/);
  });

  it("a grade the strict reader agrees with is never refused", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2024, setKey: "topps-chrome", cardNumber: "1", parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null };
    expect(refuse("2024 Topps Chrome #1 PSA 10", stored, { ...stored, gradeCompany: "PSA", gradeValue: 10 })).toHaveLength(0);
  });
});

// ── D6 ─────────────────────────────────────────────────────────────────────
describe("D6: case is not a difference; a prefix is a different card", () => {
  it.each([
    ["1975-6", "1975"],
    ["T91-74", "T91"],
    ["92-36", "92"],
  ])("a derived %s -> %s is refused as a truncation", (stored, derived) => {
    expect(K.cardNumberIsTruncation({ cardNumber: stored }, { cardNumber: derived })).not.toBe(null);
    expect(refuse("x", { cardNumber: stored }, { cardNumber: derived }).join(" "))
      .toMatch(/cardnumber-truncation/);
  });

  it("a truncation merges two cards, so it never writes", () => {
    const stored: Identity = { sport: "baseball", cardYear: 1975, setKey: "topps", cardNumber: "1975-6", parallel: "Base", isAuto: false };
    const r = K.classifyRow({
      row: vendorRow({ title: "1975 Topps #1975-6" }),
      stored, derived: { ...stored, cardNumber: "1975" }, checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.derivationRefusals.join(" ")).toMatch(/cardnumber-truncation:1975-6<-1975/);
  });

  it("a shortened number with no separator boundary is a different shape, not a truncation", () => {
    // `12` vs `123` is a differently-READ number, not a dropped suffix, and it
    // stays a conflict for Drew rather than being filtered away as a bug.
    expect(K.cardNumberIsTruncation({ cardNumber: "123" }, { cardNumber: "12" })).toBe(null);
  });

  it("case-only differences are the SAME card and diff as AGREE", () => {
    // axisValue lowercases, so these never reach the diff at all -- which is
    // the behaviour the ruling asks for: bb-ve and BB-VE are one pool.
    expect(K.cardNumberDiffersOnlyByCase({ cardNumber: "BB-VE" }, { cardNumber: "bb-ve" })).toBe(true);
    const stored: Identity = { sport: "baseball", cardYear: 2024, setKey: "topps", cardNumber: "BB-VE", parallel: "Base", isAuto: false };
    const r = K.classifyRow({
      row: vendorRow({ title: "2024 Topps #BB-VE" }),
      stored, derived: { ...stored, cardNumber: "bb-ve" }, checklistBacked: true,
    });
    expect(r.klass).toBe(K.AGREE);
    expect(r.axes.changed).toHaveLength(0);
    expect(r.writable).toBe(false);
  });
});

// ── V3 ─────────────────────────────────────────────────────────────────────
describe("V3: genericization is a loss; casing and plurals are a normalization", () => {
  it.each([
    ["Prism Refractor", "Refractor"],
    ["Atomic Refractor", "Refractor"],
    ["Silver Sparkle Refractor", "Refractor"],
    ["Mini-Diamond Refractor", "Refractor"],
    ["Green Wave Refractor", "Refractor"],
  ])("%s -> %s is refused: a named parallel is a distinct card", (stored, derived) => {
    expect(K.parallelIsGenericization({ parallel: stored }, { parallel: derived })).not.toBe(null);
    expect(refuse("t", { parallel: stored }, { parallel: derived }).join(" "))
      .toMatch(/parallel-genericization/);
  });

  it.each([
    ["Superfractor", "SuperFractor"],
    ["SuperFractor", "Superfractor"],
    ["Refractors", "Refractor"],
    ["Refractor", "Refractors"],
    ["Gold Refractors", "Gold Refractor"],
  ])("%s <-> %s is one name in two hands and normalizes", (stored, derived) => {
    expect(K.parallelIsGenericization({ parallel: stored }, { parallel: derived })).toBe(null);
    expect(refuse("t", { parallel: stored }, { parallel: derived })).toHaveLength(0);
  });

  it("a genericization never writes even when it also fills a blank axis", () => {
    // THIS is the shape that made the guard necessary. The derivation drops
    // "Prism" AND fills the print run, so the axis test sees filled-only --
    // strictly more specific -- and IMPROVE would have written it, pooling a
    // distinct card into its family.
    const stored: Identity = {
      sport: "baseball", cardYear: 2024, setKey: "topps-chrome", cardNumber: "50",
      parallel: "Prism Refractor", isAuto: false, printRun: null,
    };
    const r = K.classifyRow({
      row: vendorRow({ title: "2024 Topps Chrome #50 Prism Refractor /99" }),
      stored, derived: { ...stored, parallel: "Refractor", printRun: 99 }, checklistBacked: true,
    });
    expect(r.writable).toBe(false);
    expect((r.improveRefusals ?? []).concat(r.derivationRefusals).join(" "))
      .toMatch(/parallel-genericization:Refractor<-Prism Refractor/);
  });

  it("an unrelated parallel is a real conflict, not a genericization", () => {
    expect(K.parallelIsGenericization({ parallel: "Gold Refractor" }, { parallel: "Blue Refractor" })).toBe(null);
  });
});

// ── MUTATION CHECKS ────────────────────────────────────────────────────────
//
// A guard nothing can break is a guard nothing is testing. Each mutation below
// reverts ONE clause in the shipped source and asserts the specific defect
// returns -- so a future edit that deletes the clause fails here rather than
// in the pool.
describe("MUTATION CHECK: each derivation guard is load-bearing", () => {
  const src = fs.readFileSync(CLASSIFIER, "utf8");

  /** Load a mutated copy of the classifier and run `fn` against it. */
  const withMutant = (find: string, replace: string, label: string, fn: (m: Classifier) => void) => {
    expect(src.split(find), label).toHaveLength(2);   // exactly one site
    const mutated = src.replace(find, replace);
    expect(mutated).not.toBe(src);
    const tmp = path.join(backend, "scripts", "lib", `.rematch-classify.${label}-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      fn(require_(tmp) as Classifier);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  };

  it("D1: without the title-names-stored-finish test, Red Wave flattens to Base again", () => {
    withMutant(
      "      && titleNamesStoredFinish(title, stored?.parallel)) {",
      "      && false) {",
      "d1",
      (m) => {
        const args = { row: vendorRow({ title: "2025 Panini Prizm Football #99 Red Wave" }), stored: { parallel: "Red Wave" }, derived: { parallel: "Base" } };
        expect(K.derivationRefusals(args).join(" ")).toMatch(/title-names-stored-finish/);
        expect(m.derivationRefusals(args)).toHaveLength(0);
      },
    );
  });

  it("D7: without the cardNumber check, a title word mints an auto again", () => {
    withMutant(
      "  return !autoByCardNumber;                       // the cardNumber does not back it",
      "  return false;",
      "d7",
      (m) => {
        const args = { row: vendorRow({ title: "1953 Bowman Color #10 PSA AUTHENTIC AUTO" }), stored: { isAuto: false }, derived: { isAuto: true } };
        expect(K.derivationRefusals(args)).toContain("isauto-flip-from-title-only");
        expect(m.derivationRefusals(args)).toHaveLength(0);
      },
    );
  });

  it("D8: without the strict reader, VG-VGEX is a grade again", () => {
    withMutant(
      "  const gradeArtifact = derivedGradeIsAdjectiveArtifact({ row, stored, derived });",
      "  const gradeArtifact = null;",
      "d8",
      (m) => {
        const args = { row: vendorRow({ title: "1953 Bowman Mickey Mantle VG-VGEX" }), stored: { gradeCompany: null, gradeValue: null }, derived: { gradeCompany: "PSA", gradeValue: 10 } };
        expect(K.derivationRefusals(args).join(" ")).toMatch(/grade-from-title-without-grader/);
        expect(m.derivationRefusals(args)).toHaveLength(0);
      },
    );
  });

  it("D6: without the boundary test, 1975-6 merges into 1975 again", () => {
    withMutant(
      "  const trunc = cardNumberIsTruncation(stored, derived);",
      "  const trunc = null;",
      "d6",
      (m) => {
        const args = { row: vendorRow({ title: "1975 Topps" }), stored: { cardNumber: "1975-6" }, derived: { cardNumber: "1975" } };
        expect(K.derivationRefusals(args).join(" ")).toMatch(/cardnumber-truncation/);
        expect(m.derivationRefusals(args)).toHaveLength(0);
      },
    );
  });

  it("V3: without the subset test, Prism Refractor genericizes to Refractor again", () => {
    withMutant(
      "  const generic = parallelIsGenericization(stored, derived);",
      "  const generic = null;",
      "v3",
      (m) => {
        const args = { row: vendorRow({ title: "2024 Topps Chrome #50 Prism Refractor" }), stored: { parallel: "Prism Refractor" }, derived: { parallel: "Refractor" } };
        expect(K.derivationRefusals(args).join(" ")).toMatch(/parallel-genericization/);
        expect(m.derivationRefusals(args)).toHaveLength(0);
      },
    );
  });

  it("the IMPROVE gate reads the refusals: removing them makes a title-only auto writable", () => {
    // THE ONE SHAPE THAT ACTUALLY REACHES IMPROVE.
    //
    // Every other refusal here implies a dropped or changed axis, so the
    // CONFLICT branch returns before IMPROVE is reached and the push below is
    // defence in depth. This one is different and it is the dangerous one: a
    // stored `isAuto` of null is BLANK, not false, so a title word filling it
    // reads as strictly-more-specific -- IMPROVE, checklist-backed, AUTO tier,
    // and writable. That is a cut signature being minted into an auto pool by
    // the word "AUTO", through the class that writes.
    withMutant(
      "  refusals.push(...derivationRefused);",
      "  ;",
      "improve",
      (m) => {
        const stored: Identity = {
          sport: "baseball", cardYear: 1953, setKey: "bowman", cardNumber: "10",
          parallel: "Base", isAuto: null,
        };
        const input: ClassifyInput = {
          row: vendorRow({ title: "1953 Bowman Color #10 PSA AUTHENTIC AUTO" }),
          stored, derived: { ...stored, isAuto: true },
          checklistBacked: true, autoByCardNumber: false,
        };
        const real = K.classifyRow(input);
        // Both SEE it as IMPROVE -- the class is what the census measured.
        expect(real.klass).toBe(K.IMPROVE);
        expect(m.classifyRow(input).klass).toBe(K.IMPROVE);
        // Only the guarded one refuses to write it.
        expect(real.writable).toBe(false);
        expect(real.improveRefusals ?? []).toContain("isauto-flip-from-title-only");
        expect(m.classifyRow(input).writable).toBe(true);
      },
    );
  });

  it("a refusal always implies a dropped or changed axis, so CONFLICT contains the rest", () => {
    // Stated as a pin because it is the reason the IMPROVE push above is
    // defence in depth rather than the primary containment: D1 drops the
    // parallel axis, D6/D7/V3 change theirs, and a changed axis is a CONFLICT
    // before any refusal is consulted. If a future axis change made one of
    // these read as `filled`, this test fails and the IMPROVE gate becomes
    // load-bearing for it -- which is exactly when someone should look.
    const shapes: Array<[string, Identity, Identity]> = [
      ["D1", { parallel: "Red Wave" }, { parallel: "Base" }],
      ["D6", { cardNumber: "1975-6" }, { cardNumber: "1975" }],
      ["D7", { isAuto: false }, { isAuto: true }],
      ["V3", { parallel: "Prism Refractor" }, { parallel: "Refractor" }],
    ];
    for (const [label, stored, derived] of shapes) {
      const axes = (K as unknown as { diffAxes: (a: Identity, b: Identity) => Result["axes"] }).diffAxes(stored, derived);
      expect(axes.dropped.length + axes.changed.length, label).toBeGreaterThan(0);
    }
  });
});

/**
 * CF-AN-ABSENT-YEAR-IS-NOT-A-RIVAL-YEAR (2026-09-06, I9 run 34029662735).
 *
 * I9 reported ~345 rows carrying `changed:cardYear` and they read like a data
 * defect. They are not. On the tca-ebay/cardsight population the `year` FIELD
 * is ABSENT -- measured 1,576/1,576 rows over two pools -- while `cardYear`
 * already equals the year segment of the slug the row is filed under
 * (1,576/1,576). The deriver mirrors a year onto a row that never carried one,
 * and comparing a mirrored value against a field the row never had must not
 * report a disagreement about WHICH CARD this is.
 *
 * THE RULE IS EQUALITY-GATED, AND THAT IS THE WHOLE SAFETY ARGUMENT. Absence
 * alone is what makes the stored side not-an-answer; EQUALITY is what makes the
 * derivation agreement rather than a rival. A 1955 Koufax filed on a `:2023:`
 * slug still reports `changed:cardYear`, because there the two sides genuinely
 * name different cards -- 60 of 90 rows in that pool, and every one of them
 * must stay a finding.
 *
 * MEASURED IMPACT, STATED HONESTLY: over 1,576 re-derived rows, 1,523 already
 * classified `same` before this change and 53 genuinely disagree. The rule
 * reclassified ZERO rows in the pools measured. It is a GUARD that pins the
 * intended reading against a future deriver that starts mirroring years onto
 * absent-year rows, not a repair that moves a population today.
 */
describe("an absent year is not a rival year", () => {
  const SLUG = "hiq:baseball:2023:topps:123:base:no-auto";
  const base = (o: Record<string, unknown>) => ({
    sport: "baseball", setKey: "topps", cardNumber: "123", parallel: "Base",
    isAuto: false, printRun: null, gradeCompany: "PSA", gradeValue: 4, ...o,
  });
  const classify = (row: Record<string, unknown>, storedYear: unknown, derivedYear: unknown) =>
    K.classifyRow({
      row, stored: base({ cardYear: storedYear }) as Identity,
      derived: base({ cardYear: derivedYear }) as Identity,
      storedSlug: SLUG, checklistBacked: true,
    });

  it("absent year + cardYear equal to the slug year + derived agrees -> AGREE", () => {
    const v = classify({ title: "2023 Topps #123", cardId: SLUG, hobbyiqCardId: SLUG }, 2023, 2023);
    expect(v.axes.same).toContain("cardYear");
    expect(v.axes.changed).not.toContain("cardYear");
    expect(v.klass).toBe("AGREE");
  });

  it("MUTATION -- a derived year that DISAGREES is still changed", () => {
    // The 1955 Koufax on a :2023: slug. Dropping the equality gate and folding
    // on absence alone would hide 60 of 90 rows in that pool.
    const v = classify({ title: "1955 Topps #123 Koufax", cardId: SLUG, hobbyiqCardId: SLUG }, 2023, 1955);
    expect(v.axes.changed).toContain("cardYear");
    expect(v.axes.same).not.toContain("cardYear");
    expect(v.klass).toBe("CONFLICT");
  });

  it("MUTATION -- a PRESENT year field is a real answer and still changes", () => {
    // The fold is gated on the row's own `year` being absent. A row that
    // STATES a year has given a rival reading, and it must keep reporting one.
    const v = classify({ title: "1955 Topps #123", year: 2023, cardId: SLUG, hobbyiqCardId: SLUG }, 2023, 1955);
    expect(v.axes.changed).toContain("cardYear");
    expect(v.klass).toBe("CONFLICT");
  });

  it("no year anywhere and the derivation states one -> filled, not changed", () => {
    const v = classify({ title: "2023 Topps #123", cardId: SLUG, hobbyiqCardId: SLUG }, null, 2023);
    expect(v.axes.filled).toContain("cardYear");
    expect(v.axes.changed).not.toContain("cardYear");
  });

  it("MUTATION -- the slug echo is required, not just the absence", () => {
    // cardYear 1999 on a :2023: slug is NOT the address echoed into the field,
    // so it is a real stored answer. A mutant that folded on absence alone
    // would call this AGREE.
    const v = classify({ title: "1999 Topps #123", cardId: SLUG, hobbyiqCardId: SLUG }, 1999, 1999);
    expect(v.axes.same).toContain("cardYear");
    // ...and when it disagrees it must still change.
    const w = classify({ title: "1955 Topps #123", cardId: SLUG, hobbyiqCardId: SLUG }, 1999, 1955);
    expect(w.axes.changed).toContain("cardYear");
  });
});
