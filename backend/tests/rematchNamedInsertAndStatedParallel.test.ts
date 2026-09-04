/**
 * GATE 3 SLOT-31: THE NEW FAMILY THE IMPROVE ARM WAS STILL COLLAPSING.
 *
 * THE AUDIT THIS PINS. The GREAT REMATCH IMPROVE census on shard 31 (GitHub
 * run 33915911825) emitted 374 IMPROVE evidence rows, of which 209 were
 * WRITABLE. Judged as a collector, 12 of those 209 were WRONG, and all 12 were
 * product or parallel collapses of one family the guards did not cover:
 *
 *   (a) NAMED INSERTS, FOOD ISSUES AND NON-CARDS folded into the flagship
 *         1995-96 UD Special Edition #31   -> upper-deck:31:base   (4 rows)
 *         1995 UD Milk Caps / Pogs Jordan  -> upper-deck:1/5/9     (3 rows)
 *         1978 Topps Holsum #32            -> topps:32             (2 rows)
 *         UD 1995 Jordan Collection #JC7   -> upper-deck:JC7       (1 row)
 *   (b) A STATED PARALLEL derived as BASE
 *         1995 Bowman *Silver Foil* #238   -> bowman:238:base      (1 row)
 *         1995 CC GOLD Signature #46       -> collectors-choice:46 (1 row)
 *
 * THREE DEFECTS, and the first is the one an eyeball would have missed:
 *
 *   1. GUARD 6 read only `derived.setKey`. NINE of the twelve changed NOTHING
 *      BUT `cardNumber` -- the stored key ALREADY equalled the flagship, so
 *      there was no setKey to examine and the guard never ran. Its rule is
 *      about the TITLE naming a child, not about which axis moves.
 *   2. Nothing declared these products, so even a both-keys GUARD 6 would have
 *      found no child to name. The declarations ship in productSetKeys.ts and
 *      are mirrored into the classifier's ladder.
 *   3. A milk cap is not a card at all, so no card's pool is right for it --
 *      a separate refusal from "wrong product" (Drew: "a Pog is not a card").
 *
 * AND THE CONTROL THAT PROVES THE PARALLEL HALF. One row apart in the same
 * evidence, "1995 BOWMAN GOLD FOIL FOIL #254 JOHNNY DAMON PSA 7" was judged
 * RIGHT and must STAY writable: its stored parallel already says "Gold Foil",
 * so it is not the shape GUARD 9 refuses. A guard that stops everything is an
 * off switch, not a guard.
 *
 * MEASURED AFTER THE FIX, by replaying all 374 evidence rows through the
 * committed classifier with permissive catalog facts (the judge's reading):
 * 197 writable, 197 right, 0 wrong. Exactly the 12 judged-wrong rows lost
 * writability; no other row changed in either direction.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productEntry, productAncestry } from "../src/services/catalog/productSetKeys.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const CLASSIFIER = path.join(backend, "scripts", "lib", "rematch-classify.cjs");
const K = require_(CLASSIFIER) as any;
const VOCAB = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs")) as any;

/**
 * The audit's row shape. `storedSetKey` defaults to the DERIVED key, because
 * that is the fill-arm shape the audit found: the stored key already equals
 * the flagship and only `cardNumber` moves. Pass a different one for the rows
 * whose setKey genuinely moved.
 */
function classify(o: {
  title: string; year: number; derivedSetKey: string; cardNumber: string;
  storedSetKey?: string; sport?: string;
  storedCardNumber?: string | null;
  storedParallel?: string | null; derivedParallel?: string | null;
  klass?: any;
}) {
  const sport = o.sport ?? "baseball";
  const storedSetKey = o.storedSetKey ?? o.derivedSetKey;
  const storedNum = o.storedCardNumber === undefined ? null : o.storedCardNumber;
  const slug = `hiq:${sport}:${o.year}:${storedSetKey}:${(storedNum ?? o.cardNumber).toLowerCase()}:base:no-auto`;
  const mod = o.klass ?? K;
  return mod.classifyRow({
    row: { id: "row-1", cardId: slug, source: "tca-ebay", title: o.title },
    stored: {
      sport, cardYear: o.year, setKey: storedSetKey, cardNumber: storedNum,
      parallel: o.storedParallel === undefined ? "Base" : o.storedParallel,
      isAuto: false, printRun: null,
    },
    derived: {
      sport, cardYear: o.year, setKey: o.derivedSetKey, cardNumber: o.cardNumber,
      parallel: o.derivedParallel === undefined ? "Base" : o.derivedParallel,
      isAuto: false, printRun: null,
    },
    checklistBacked: true, storedSlug: slug, titleStatesNumber: true,
  });
}

const NAMES_PRODUCT = /improve-title-names-a-product-the-derivation-dropped/;
const NON_CARD = /improve-non-card-format/;
const STATED_FINISH = /improve-title-states-a-finish-over-a-base-destination/;

// -- 1. THE DECLARATIONS ----------------------------------------------------
describe("the named inserts and food issues are DECLARED products", () => {
  const DECLARED: Array<[string, string]> = [
    ["upper-deck-special-edition", "upper-deck"],
    ["upper-deck-jordan-collection", "upper-deck"],
    ["upper-deck-milk-caps", "upper-deck"],
    ["topps-holsum", "topps"],
  ];

  it.each(DECLARED)("productSetKeys.ts declares %s under %s", (key, parent) => {
    expect(productEntry(key), key).not.toBeNull();
    expect(productEntry(key)?.parent, key).toBe(parent);
    expect(productAncestry(key), key).toContain(parent);
  });

  it.each(DECLARED)("%s is NOT in the ladder mirror, because it is not a fixed point", (key) => {
    // A RULED KEY MUST BE A normalizeSetKey FIXED POINT, and these are not:
    // `upper-deck-special-edition` normalizes to `upper-deck` today, because
    // they are `P` rows and only a SPELLED product answers productSetKeyForName.
    // `rematchSpecializationStated.test.ts` asserts that invariant over every
    // key in SPECIALIZATION_PARENTS, so putting them there would be declaring a
    // rename that has not happened.
    //
    // They do not need to be there. `SPECIALIZATION_CHILDREN_OF` reads THREE
    // sources, and DISTINCT_PRODUCT_SETKEYS -- where these are declared -- is
    // one of them: any key of the form `<parent>-<...>` is found under its
    // parent by prefix. So GUARD 6 names them without a ladder edge, and
    // SPECIALIZATION-STATED (which walks the ladder in L1) correctly cannot
    // promote a row onto them, which is right: none has a checklist.
    expect(K.SPECIALIZATION_PARENTS[key], key).toBeUndefined();
  });

  it.each(DECLARED)("%s is a declared DISTINCT product, so Guard 3 sees it too", (key) => {
    expect(K.DISTINCT_PRODUCT_SETKEYS, key).toContain(key);
  });

  it("SPECIALIZATION_CHILDREN_OF names each of them under its flagship", () => {
    const ud = K.SPECIALIZATION_CHILDREN_OF("upper-deck");
    expect(ud).toEqual(expect.arrayContaining([
      "upper-deck-special-edition", "upper-deck-jordan-collection", "upper-deck-milk-caps",
    ]));
    expect(K.SPECIALIZATION_CHILDREN_OF("topps")).toContain("topps-holsum");
    // The one product in this family the CATALOG already backs (313
    // baseballcardpedia rows, measured 2026-09-04) reaches the guard too.
    expect(K.SPECIALIZATION_CHILDREN_OF("collectors-choice")).toContain("collectors-choice-special-edition");
  });

  it("declaring them does NOT change what normalizeSetKey emits", async () => {
    // They are `P` rows -- a family/parent registry, not a spelling. The #1748
    // lesson, asserted by RUNNING the function rather than reading the table:
    // promoting them to `S` is a vocabulary decision with its own blast radius
    // and is deliberately NOT made here.
    const { normalizeSetKey } = await import("../src/services/portfolioiq/hobbyIqCardId.service.js");
    expect(normalizeSetKey("Upper Deck Special Edition")).toBe("upper-deck");
    expect(normalizeSetKey("Upper Deck Jordan Collection")).toBe("upper-deck");
    expect(normalizeSetKey("Topps Holsum")).toBe("topps");
    expect(normalizeSetKey("Upper Deck Milk Caps")).toBe("upper-deck");
    // and the products these must not disturb
    expect(normalizeSetKey("Upper Deck")).toBe("upper-deck");
    expect(normalizeSetKey("Upper Deck Series 1")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("Collectors Choice")).toBe("collectors-choice");
    expect(normalizeSetKey("Collectors Choice Special Edition")).toBe("collectors-choice-special-edition");
  });

  it("none of them is a SAME-NUMBER parallel set - a named insert numbers its own cards", () => {
    for (const [key, parent] of DECLARED) {
      expect(K.isSameNumberParallelSet(key, parent), key).toBe(false);
    }
  });
});

// -- 2. GUARD 6 ON THE FILL ARM ---------------------------------------------
describe("GUARD 6 fires on the cardNumber-fill arm, not only when setKey moves", () => {
  /** VERBATIM titles from the run-33915911825 log. The stored key ALREADY
   *  equals the flagship on every one of these: only cardNumber moves. */
  const FILL_ARM: Array<{ what: string; title: string; year: number; key: string; num: string; sport: string; names: string }> = [
    {
      what: "UD Special Edition #31 is Olajuwon; base 1995-96 UD #31 is another card",
      title: "1995-96 Upper Deck Special Edition #31 Hakeem Olajuwon Rockets - Raw 10",
      year: 1995, key: "upper-deck", num: "31", sport: "basketball", names: "upper-deck-special-edition",
    },
    {
      what: "the same card listed with the GOLD parallel called out",
      title: "*Rare* 1995-96 Upper Deck Special Edition GOLD Parallels #31 Hakeem Olajuwon - Raw 10",
      year: 1995, key: "upper-deck", num: "31", sport: "basketball", names: "upper-deck-special-edition",
    },
    {
      what: "Holsum is a 33-card FOOD ISSUE; 1978 Topps runs 1-528",
      title: "1978 Topps Holsum #32 Ken Houston  VGEX X3297381 - Raw 10",
      year: 1978, key: "topps", num: "32", sport: "football", names: "topps-holsum",
    },
  ];

  it.each(FILL_ARM)("$what", ({ title, year, key, num, sport, names }) => {
    const res = classify({ title, year, derivedSetKey: key, cardNumber: num, sport, storedCardNumber: null });
    expect(res.writable, title).toBe(false);
    expect(res.reasons.join(" "), title).toMatch(NAMES_PRODUCT);
    expect(res.reasons.join(" "), title).toContain(`title-names:${names}`);
  });

  it("the setKey-MOVES arm still fires (the shape that already worked)", () => {
    const res = classify({
      title: "Upper Deck 1995 Jordan Collection Michael Jordan Rising to the Occasion #JC7 PSA 9",
      year: 1995, derivedSetKey: "upper-deck", storedSetKey: "unknown",
      cardNumber: "JC7", sport: "basketball",
    });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("title-names:upper-deck-jordan-collection");
  });

  it("CONTROL: a genuine base card of the same product and year stays writable", () => {
    // The rows the IMPROVE arm exists to fix. Both arms, so neither can be an
    // off switch: a stored key that already equals the flagship, and a blank one.
    const fill = classify({
      title: "1995-96 Upper Deck #31 Charles Barkley Phoenix Suns - Raw 10",
      year: 1995, derivedSetKey: "upper-deck", cardNumber: "31", sport: "basketball", storedCardNumber: null,
    });
    expect(fill.writable).toBe(true);
    const moves = classify({
      title: "1978 Topps #400 Nolan Ryan - Raw",
      year: 1978, derivedSetKey: "topps", storedSetKey: "unknown", cardNumber: "400",
    });
    expect(moves.writable).toBe(true);
  });
});

// -- 3. NON-CARD FORMATS ----------------------------------------------------
describe("GUARD 8: a Pog is not a card", () => {
  const POGS: Array<{ title: string; num: string }> = [
    { title: "1995 UD Upper Deck Michael Jordan PSA 9 #1 Milk Cap New Case Bulls MJ LOW POP", num: "1" },
    { title: "Michael Jordan PSA 8 1995 UD Upper Deck #9 Milk Caps Pog Bulls MJ Caps Pogs Rare", num: "9" },
    { title: "1995 UD Upper Deck Michael Jordan PSA 8 #5 Milk Cap New Case Bulls MJ LOW POP", num: "5" },
  ];

  it.each(POGS)("a milk cap never lands on a card pool: $title", ({ title, num }) => {
    const res = classify({
      title, year: 1995, derivedSetKey: "upper-deck", cardNumber: num,
      sport: "basketball", storedCardNumber: null,
    });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toMatch(NON_CARD);
  });

  it("the refusal is on EVERY axis, not only the number", () => {
    // The setKey-moves shape of the same defect must refuse identically.
    const res = classify({
      title: "1995 Upper Deck Michael Jordan Milk Caps #28 HOF - Raw",
      year: 1995, derivedSetKey: "upper-deck", storedSetKey: "unknown",
      cardNumber: "28", sport: "basketball",
    });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toMatch(NON_CARD);
  });

  it("CONTROL: a row already filed on the FORMAT OWN product is left alone", () => {
    // `topps-coins` (49 catalog rows) and `king-b-discs` (301) are real
    // products, measured 2026-09-04. A row correctly sitting on one of them is
    // right where it is, and refusing it would be the mirror of the defect
    // this guard fixes.
    for (const [title, key, num] of [
      ["1971 Topps Coins #23 Willie Mays - Raw", "topps-coins", "23"],
      ["1989 King B Discs #12 Nolan Ryan - Raw", "king-b-discs", "12"],
    ] as Array<[string, string, string]>) {
      const res = classify({ title, year: 1989, derivedSetKey: key, cardNumber: num, storedCardNumber: null });
      expect(res.reasons.join(" "), title).not.toMatch(NON_CARD);
      expect(res.writable, title).toBe(true);
    }
  });

  it("CONTROL: a player whose NAME contains the format word is not a format", () => {
    // Word boundaries, asserted on the two names that actually collide.
    expect(K.NON_CARD_FORMAT_RE.test("2022 Panini Prizm World Cup #103 Paul Pogba White Sparkle")).toBe(false);
    expect(K.NON_CARD_FORMAT_RE.test("2026 Panini Instant Tour de France #31 Tadej Pogacar")).toBe(false);
    expect(K.NON_CARD_FORMAT_RE.test("2024 Panini Pinnacle #12 Base")).toBe(false);
    // and the formats it MUST catch
    for (const t of ["Milk Cap", "Milk Caps", "a Pog", "Pogs", "Discs", "Topps Coins", "Sticker"]) {
      expect(K.NON_CARD_FORMAT_RE.test(t), t).toBe(true);
    }
  });
});

// -- 4. A STATED PARALLEL NEVER LANDS ON BASE -------------------------------
describe("GUARD 9: a title that states a finish never lands on the base pool", () => {
  it("1995 Bowman Silver Foil #238 does not become bowman:238:base", () => {
    const res = classify({
      title: "1995 Bowman *Silver Foil* HIDEO NOMO #238 RC Rookie Los Angeles Dodgers",
      year: 1995, derivedSetKey: "bowman", storedSetKey: "base-set", cardNumber: "238",
    });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toMatch(STATED_FINISH);
    expect(res.reasons.join(" ")).toContain("silver foil");
  });

  it("1995 Collectors Choice GOLD Signature #46 does not become collectors-choice:46:base", () => {
    const res = classify({
      title: "1995 Collectors Choice - NOLAN RYAN - GOLD Signature #46 PSA 9 Mint Pop 6",
      year: 1995, derivedSetKey: "collectors-choice", storedSetKey: "unknown", cardNumber: "46",
    });
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toMatch(STATED_FINISH);
    expect(res.reasons.join(" ")).toContain("gold signature");
  });

  it("THE CONTROL, one row apart in the same evidence: Gold Foil stays writable", () => {
    // Its STORED parallel already says "Gold Foil", so the derivation is not
    // dropping anything and this is not the GUARD 9 shape at all.
    const res = classify({
      title: "1995 BOWMAN GOLD FOIL FOIL #254 JOHNNY DAMON PSA 7",
      year: 1995, derivedSetKey: "bowman", storedSetKey: "base-set", cardNumber: "254",
      storedParallel: "Gold Foil", derivedParallel: "Gold Foil",
    });
    expect(res.writable).toBe(true);
    expect(res.reasons.join(" ")).not.toMatch(STATED_FINISH);
  });

  it("CONTROL: a bare COLOUR standing for a person or a team is not a finish", () => {
    // Measured on the 374 evidence rows: refusing on any adjudicated witness
    // costs eight genuine Pete Rose improvements plus a Red Sox and a Blue
    // Jays. A false refusal is a repair nobody can find.
    const FALSE_POSITIVES: Array<[string, number, string, string]> = [
      ["1978 Topps #20 Pete Rose - Raw", 1978, "topps", "20"],
      ["1975 Topps Baseball Card #320 Pete Rose Cincinnati VG - Raw", 1975, "topps", "320"],
      ["1995 Bowman Nomar Garciaparra #249 Red Sox", 1995, "bowman", "249"],
      ["Roberto Alomar 1995 Bowman #368 Blue Jays MLB READ FREE SHIPPING", 1995, "bowman", "368"],
    ];
    for (const [title, year, key, num] of FALSE_POSITIVES) {
      const res = classify({ title, year, derivedSetKey: key, storedSetKey: "unknown", cardNumber: num });
      expect(res.reasons.join(" "), title).not.toMatch(STATED_FINISH);
      expect(res.writable, title).toBe(true);
    }
  });

  it("CONTROL: a serial alone is not a finish name - GUARD 2 owns that question", () => {
    // `titleNamesFinish` answers TRUE on a bare "#/999" because it opens with
    // `if (titleStatesSerial(t)) return true`. `titleFinishWitness` is that
    // walk MINUS the serial line, so it answers null and GUARD 9 stands down.
    expect(VOCAB.titleNamesFinish("2024 Topps #50 Base /999", { year: 2024, setKey: "topps" })).toBe(true);
    expect(VOCAB.titleFinishWitness("2024 Topps #50 Base /999", { year: 2024, setKey: "topps" })).toBeNull();
  });

  it("the witness NAMES its evidence, and the two vocab functions cannot disagree", () => {
    // `phraseIndexMatches` is the boolean face of `phraseIndexMatch`, by
    // construction -- one implementation, so they cannot drift.
    for (const [t, sk, y] of [
      ["1995 Bowman *Silver Foil* #238", "bowman", 1995],
      ["1995 BOWMAN GOLD FOIL FOIL #254", "bowman", 1995],
      ["1989 BOWMAN - BO JACKSON - ROOKIE CARD R.C. - #126", "bowman", 1989],
    ] as Array<[string, string, number]>) {
      const w = VOCAB.titleFinishWitness(t, { year: y, setKey: sk });
      if (w !== null) expect(VOCAB.titleNamesFinish(t, { year: y, setKey: sk }), t).toBe(true);
    }
    expect(VOCAB.titleFinishWitness("1995 Bowman *Silver Foil* #238", { year: 1995, setKey: "bowman" })).toBe("silver foil");
    expect(VOCAB.titleFinishWitness("1989 BOWMAN - BO JACKSON - #126", { year: 1989, setKey: "bowman" })).toBeNull();
  });

  it("CONTROL: the PRODUCT'S OWN NAME is not a finish, phrase path included", () => {
    // The token walk gets the product-word suppression from `isFinishToken`;
    // the phrase index is a separate structure and never consulted it. Both
    // defects below were measured, and both refused a control another suite
    // pins as writable:
    //
    //   "Black Diamond" on `upper-deck-black-diamond` -- the product's whole
    //       name matched as a phrase (rematchCollapseAndCoverage's control).
    //   "choice gold" on `collectors-choice` -- a real parallel phrase (from
    //       "Choice Gold Optic") that won on the SET word `choice`, hiding
    //       the phrase that actually names this card's finish.
    expect(VOCAB.titleFinishWitness("2000 Upper Deck Black Diamond #22 Base",
      { year: 2000, setKey: "upper-deck-black-diamond" })).toBeNull();
    expect(VOCAB.titleFinishWitness("1987 Topps Traded Tiffany Greg Maddux #70T",
      { year: 1987, setKey: "topps-traded-tiffany" })).toBeNull();
    // and the phrase that DOES say something beyond the set name still wins
    expect(VOCAB.titleFinishWitness("1995 Collectors Choice - NOLAN RYAN - GOLD Signature #46 PSA 9",
      { year: 1995, setKey: "collectors-choice" })).toBe("gold signature");
  });

  it("the three phrase-index faces are one implementation", () => {
    // `phraseIndexMatch` is the first hit of `phraseIndexMatchAll`, and
    // `phraseIndexMatches` is that as a boolean. Asserted so a future edit
    // cannot make the ranked reader and the boolean reader disagree.
    const vocab = VOCAB.vocabularyFor(1995, "bowman");
    const t = "1995 bowman *silver foil* hideo nomo #238";
    const words = t.split(/[^a-z0-9-]+/).filter(Boolean);
    const all = VOCAB.phraseIndexMatchAll(vocab.phraseIndex, t, words);
    expect(all.length).toBeGreaterThan(0);
    expect(VOCAB.phraseIndexMatch(vocab.phraseIndex, t, words)).toBe(all[0]);
    expect(VOCAB.phraseIndexMatches(vocab.phraseIndex, t, words)).toBe(true);
    const none = "1989 bowman bo jackson rookie";
    const noneWords = none.split(/[^a-z0-9-]+/).filter(Boolean);
    expect(VOCAB.phraseIndexMatchAll(vocab.phraseIndex, none, noneWords)).toEqual([]);
    expect(VOCAB.phraseIndexMatch(vocab.phraseIndex, none, noneWords)).toBeNull();
    expect(VOCAB.phraseIndexMatches(vocab.phraseIndex, none, noneWords)).toBe(false);
  });

  it("the hand list stays a patch, not a second vocabulary", () => {
    expect(VOCAB.HAND_PHRASES).toContain("gold signature");
    expect(VOCAB.HAND_PHRASES).toContain("silver signature");
    expect(VOCAB.HAND_PHRASES.length).toBeLessThanOrEqual(VOCAB.HAND_LIST_CEILING);
    // `signature` stays a CORPUS STOPWORD: its stop rests on "this describes
    // the CARD, not how it is printed", which the stopword-exception rule
    // states outright is not eligible to be lifted. The phrase is how a real
    // parallel enters the vocabulary without lifting that stop.
    expect(VOCAB.CORPUS_STOPWORDS.has("signature")).toBe(true);
    expect(VOCAB.STOPWORD_EXCEPTION_ELIGIBLE.has("signature")).toBe(false);
  });
});

// -- MUTATION CHECKS --------------------------------------------------------
//
// A guard nothing can break is a guard nothing is testing. Each mutation below
// reverts ONE clause in the shipped source and asserts the specific defect
// returns -- so a future edit that deletes the clause fails here rather than
// in the pool.
describe("MUTATION CHECK: each new rule is load-bearing", () => {
  const src = fs.readFileSync(CLASSIFIER, "utf8");

  const withMutant = (find: string, replace: string, label: string, fn: (m: any) => void) => {
    expect(src.split(find), label).toHaveLength(2);   // exactly one site
    const mutated = src.replace(find, replace);
    expect(mutated).not.toBe(src);
    const tmp = path.join(backend, "scripts", "lib", `.rematch-classify.${label}-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      fn(require_(tmp));
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  };

  // THE FILL ARM AND THE MOVE ARM ARE PINNED SEPARATELY, AND THAT IS THE ONLY
  // HONEST WAY TO PIN THEM.
  //
  // The fill-arm shape is one where the derivation AGREES with the stored key
  // -- that is what makes it a fill and not a move -- so on those rows the two
  // halves of the union READ THE SAME STRING and a mutation dropping either
  // half changes nothing observable. A single mutation cannot distinguish
  // them, and a test that pretended otherwise would be asserting a coincidence.
  //
  // So each half is reverted against the row that ONLY it can see: the stored
  // half against a derivation that answered a key with no such child, and the
  // derived half against the blank-stored shape GUARD 6 originally shipped for.
  it("G6-STORED: dropping the STORED key blinds the guard to the fill arm", () => {
    withMutant(
      "    const keys = [...new Set([lower(derived?.setKey), lower(stored?.setKey)].filter(Boolean))];",
      "    const keys = [...new Set([lower(derived?.setKey)].filter(Boolean))];",
      "g6stored",
      (m) => {
        // The guard is reverted at the level it is WRITTEN at, so it is pinned
        // at that level too: `improveRefusals` is exported precisely so one
        // leg can be driven alone.
        //
        // The row the two halves genuinely disagree on is one where the STORED
        // key names the flagship and the DERIVED key names nothing -- so only
        // the stored half of the union can find `topps-holsum` at all. On the
        // audit's own fill-arm rows the two keys are the SAME STRING (that is
        // what makes them a fill rather than a move), so no mutation could
        // separate the halves there and a test that claimed to would be
        // asserting a coincidence.
        const args = {
          row: { title: "1978 Topps Holsum #32 Ken Houston  VGEX X3297381 - Raw 10" },
          stored: { setKey: "topps", cardYear: 1978, cardNumber: null, parallel: "Base" },
          derived: { setKey: "unknown", cardYear: 1978, cardNumber: "32", parallel: "Base" },
          axes: { filled: ["cardNumber"], changed: [], dropped: [] },
        };
        expect(K.improveRefusals(args).join(" ")).toMatch(NAMES_PRODUCT);
        expect(m.improveRefusals(args).join(" ")).not.toMatch(NAMES_PRODUCT);
      },
    );
  });

  it("G6-DERIVED: dropping the DERIVED key blinds the guard to the blank-stored arm", () => {
    withMutant(
      "    const keys = [...new Set([lower(derived?.setKey), lower(stored?.setKey)].filter(Boolean))];",
      "    const keys = [...new Set([lower(stored?.setKey)].filter(Boolean))];",
      "g6derived",
      (m) => {
        // The shape GUARD 6 originally shipped for: a blank stored key
        // ("unknown" has no declared children) and a derivation that filled it
        // with the flagship. Only the DERIVED half can see this one.
        const args = {
          title: "Upper Deck 1995 Jordan Collection Michael Jordan Rising to the Occasion #JC7 PSA 9",
          year: 1995, storedSetKey: "unknown", derivedSetKey: "upper-deck",
          cardNumber: "JC7", sport: "basketball",
        };
        expect(classify(args).reasons.join(" ")).toMatch(NAMES_PRODUCT);
        expect(classify({ ...args, klass: m }).reasons.join(" ")).not.toMatch(NAMES_PRODUCT);
      },
    );
  });

  it("G8: without the non-card refusal, a milk cap lands on a card again", () => {
    withMutant(
      "        refusals.push(`improve-non-card-format:${format}@${dest[0] || \"(none)\"}`);",
      "        void 0;",
      "g8",
      (m) => {
        const args = {
          title: "1995 UD Upper Deck Michael Jordan PSA 9 #1 Milk Cap New Case Bulls MJ LOW POP",
          year: 1995, derivedSetKey: "upper-deck", cardNumber: "1",
          sport: "basketball", storedCardNumber: null,
        };
        expect(classify(args).reasons.join(" ")).toMatch(NON_CARD);
        expect(classify({ ...args, klass: m }).reasons.join(" ")).not.toMatch(NON_CARD);
      },
    );
  });

  it("G8-DEST: without the destination test, a row on its OWN format product is refused too", () => {
    // The mirror defect. A guard that cannot tell "this disc belongs on the
    // disc product" from "this disc belongs on the card" drives both to the
    // same place, and `king-b-discs` has 301 real catalog rows.
    withMutant(
      "      const landsOnTheFormat = dest.some((k) => setKeyNamesFormat(k, format));",
      "      const landsOnTheFormat = false;",
      "g8dest",
      (m) => {
        const args = {
          title: "1989 King B Discs #12 Nolan Ryan - Raw", year: 1989,
          derivedSetKey: "king-b-discs", cardNumber: "12", storedCardNumber: null,
        };
        expect(classify(args).writable).toBe(true);
        expect(classify({ ...args, klass: m }).reasons.join(" ")).toMatch(NON_CARD);
      },
    );
  });

  it("G9: without the stated-finish refusal, Silver Foil lands on Base again", () => {
    withMutant(
      "        refusals.push(`improve-title-states-a-finish-over-a-base-destination:${witness}@${setKey}`);",
      "        void 0;",
      "g9",
      (m) => {
        const args = {
          title: "1995 Bowman *Silver Foil* HIDEO NOMO #238 RC Rookie Los Angeles Dodgers",
          year: 1995, derivedSetKey: "bowman", storedSetKey: "base-set", cardNumber: "238",
        };
        expect(classify(args).reasons.join(" ")).toMatch(STATED_FINISH);
        expect(classify({ ...args, klass: m }).reasons.join(" ")).not.toMatch(STATED_FINISH);
      },
    );
  });

  it("G9-NOUN: without the finish-noun test, Pete Rose reads as a Rose parallel", () => {
    // The measured false positive. `rose` is a FINISH_COLOR_TOKEN and the
    // per-card vocabulary answers TRUE for it; the noun requirement is the
    // only thing standing between this guard and eight lost improvements on
    // one of the most traded vintage cards there is.
    withMutant(
      "      if (witness && finishWitnessIsNamed(witness)) {",
      "      if (witness) {",
      "g9noun",
      (m) => {
        const args = {
          title: "1978 Topps #20 Pete Rose - Raw", year: 1978,
          derivedSetKey: "topps", storedSetKey: "unknown", cardNumber: "20",
        };
        expect(classify(args).writable).toBe(true);
        expect(classify({ ...args, klass: m }).reasons.join(" ")).toMatch(STATED_FINISH);
      },
    );
  });
});
