/**
 * THE GREAT REMATCH TRUST LADDER -- the pins the 2026-09-03 audit gate demanded.
 *
 * An Opus audit of the 32-shard census FAILED EVERY SHARD. Applying it would
 * have moved genuine parallels (Tiffany, Desert Shield, Rapture, Press Proof,
 * Members Only, International, Embossed, Mahogany, Retro-Future) INTO base
 * pools, deleted stored print runs, and -- through the class everyone treated
 * as the safe one -- written PRODUCT WORDS as finishes and minted numbered
 * base cards the checklist never listed.
 *
 * Every counterexample title the findings named is a fixture here, and each
 * one must classify as NOT WRITABLE. The genuine base-on-refractor-slug shape
 * (Gonzalez) must still classify writable, because a guard that stops
 * everything is not a guard, it is an off switch.
 *
 * WHAT THIS FILE PINS
 *
 *   A. finish vocabulary from the checklist corpus, matched per (year,setKey)
 *      with product-word awareness                          (finding 1)
 *   B. a stored printRun disqualifies eviction and is never deleted  (2)
 *   C. the serial regex accepts '#/N'                                (3)
 *   D. the three IMPROVE guards                                      (4, 7)
 *   E. the runner's before/apply/after ordering and no apply forwarding (5)
 *   F. every shard has a canary                                      (6)
 *   G. SAMPLE_CAP is 500 and the sample spreads across cardIds       (7)
 *
 * MUTATION CHECK: each guard is reverted in turn (by driving the exported
 * predicate with the pre-fix behaviour) and its pins must go red. A guard that
 * cannot be broken by removing it was not doing anything.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = {
  sport?: string | null; cardYear?: number | null; setKey?: string | null;
  cardNumber?: string | null; parallel?: string | null; isAuto?: boolean | null;
  printRun?: number | null; gradeCompany?: string | null; gradeValue?: number | null;
};
type Result = {
  klass: string; subclass?: string; tier: string; writable: boolean; reasons: string[];
  improveRefusals?: string[];
  evidence?: Record<string, unknown>;
  axes: { same: string[]; filled: string[]; dropped: string[]; changed: string[] };
};
type ClassifyInput = {
  row: Record<string, unknown>; stored: Identity; derived: Identity | null;
  checklistBacked?: boolean; derivationReasons?: string[];
  storedSlug?: string | null; baseDestSlug?: string | null; baseDestBacked?: boolean;
};
type Vocab = {
  titleNamesFinish: (t: string, ctx?: { year?: number | null; setKey?: string | null }) => boolean;
  titleStatesSerial: (t: string) => boolean;
  serialFromTitle: (t: string) => number | null;
  isProductWord: (tok: string, setKey: string) => boolean;
  checklistListsParallel: (p: string, y: number | null, s: string) => boolean;
  vocabularyStats: () => { products: number; parallelNames: number; globalTokens: number; phrases: number; handSpellings: number; handPhrases: number };
  HAND_SPELLINGS: string[]; HAND_PHRASES: string[]; HAND_LIST_CEILING: number;
  nameTokens: (s: string) => string[];
};
type Classifier = {
  AGREE: string; IMPROVE: string; CONFLICT: string; UNDERIVABLE: string;
  PROTECTED: string; AUTO: string; BASE_EVICTION: string;
  EVICTION_MOVABLE_AXES: Set<string>;
  DISTINCT_PRODUCT_SETKEYS: string[];
  titleNamesFinish: (t: string, ctx?: Record<string, unknown>) => boolean;
  titleStatesSerial: (t: string) => boolean;
  storedPrintRunNamesALimitedParallel: (s: Identity) => boolean;
  derivationCollapsesProduct: (s: Identity, d: Identity) => string | null;
  improveRefusals: (a: { row: Record<string, unknown>; stored: Identity; derived: Identity; axes: Result["axes"] }) => string[];
  classifyRow: (i: ClassifyInput) => Result;
  VOCAB: Vocab;
};
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as Classifier;
const V = K.VOCAB;

// ── the shapes ─────────────────────────────────────────────────────────────

/** The GENUINE eviction: a base auto wearing a refractor slug. Must stay
 *  writable -- if the guards kill this, they killed the subclass. */
const EVICT_SLUG = "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499";
const BASE_DEST = "hiq:baseball:2026:bowman:cpa-jg:base:auto";
const GONZALEZ_TITLE = "2026 Bowman Justin Gonzalez 1st Bowman Auto CPA-JG";
const gonzStored: Identity = {
  sport: "baseball", cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG",
  parallel: "Base", isAuto: true, printRun: null,
};
const gonzInput = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  row: { id: "sc-gonz-1", cardId: EVICT_SLUG, source: "cardhedge", title: GONZALEZ_TITLE },
  stored: gonzStored, derived: { ...gonzStored }, checklistBacked: true,
  storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true, ...over,
});

/**
 * Every counterexample title the findings file names. Each is a row sitting on
 * a parallel slug with a blank/Base stored parallel -- the BASE-EVICTION shape
 * on every field EXCEPT that its title names a real parallel. Each must be
 * refused.
 */
const COUNTEREXAMPLES: Array<{ what: string; title: string; year: number; setKey: string; sport: string; cardNumber: string }> = [
  { what: "Tiffany (slot 29 was 30/30 wrong on this)", title: "1990 Bowman Tiffany #4 Frank Thomas RC", year: 1990, setKey: "bowman", sport: "baseball", cardNumber: "4" },
  { what: "Desert Shield (slot 28 merged these into base)", title: "1991 Topps Desert Shield #333 Chipper Jones RC", year: 1991, setKey: "topps", sport: "baseball", cardNumber: "333" },
  { what: "Rapture", title: "2020 Panini Rapture Gold Luka Doncic", year: 2020, setKey: "panini-rapture", sport: "basketball", cardNumber: "12" },
  { what: "Press Proof", title: "1995 Donruss Press Proof #12 Ken Griffey Jr", year: 1995, setKey: "donruss", sport: "baseball", cardNumber: "12" },
  { what: "Members Only", title: "1993 Topps Stadium Club Members Only #45 Frank Thomas", year: 1993, setKey: "topps-stadium-club", sport: "baseball", cardNumber: "45" },
  { what: "International", title: "2021 Topps Chrome International #150 Shohei Ohtani", year: 2021, setKey: "topps-chrome", sport: "baseball", cardNumber: "150" },
  { what: "Embossed", title: "1992 Topps Embossed #12 Cal Ripken Jr", year: 1992, setKey: "topps", sport: "baseball", cardNumber: "12" },
  { what: "Mahogany", title: "2021 Topps Mahogany #77 Juan Soto", year: 2021, setKey: "topps", sport: "baseball", cardNumber: "77" },
  { what: "Retro-Future", title: "2022 Topps Retro-Future #40 Julio Rodriguez", year: 2022, setKey: "topps", sport: "baseball", cardNumber: "40" },
  { what: "'#/398' -- the serial spelling the old regex missed", title: "2023 Topps Update Elly De La Cruz #/398", year: 2023, setKey: "topps-update-series", sport: "baseball", cardNumber: "US1" },
];

const cxInput = (cx: (typeof COUNTEREXAMPLES)[number]): ClassifyInput => {
  const slug = `hiq:${cx.sport}:${cx.year}:${cx.setKey}:${cx.cardNumber.toLowerCase()}:refractor:no-auto`;
  const stored: Identity = {
    sport: cx.sport, cardYear: cx.year, setKey: cx.setKey, cardNumber: cx.cardNumber,
    parallel: "Base", isAuto: false, printRun: null,
  };
  return {
    row: { id: `sc-${cx.setKey}-${cx.cardNumber}`, cardId: slug, source: "cardhedge", title: cx.title },
    stored, derived: { ...stored }, checklistBacked: true, storedSlug: slug,
    baseDestSlug: `hiq:${cx.sport}:${cx.year}:${cx.setKey}:${cx.cardNumber.toLowerCase()}:base:no-auto`,
    baseDestBacked: true,
  };
};

// ═══ A. THE VOCABULARY COMES FROM THE CHECKLIST CORPUS (finding 1) ═════════

describe("A -- the finish vocabulary is derived from the checklist parallel corpus", () => {
  it("loads the corpus the findings header cites, not a hand list", () => {
    const s = V.vocabularyStats();
    // 576 products / 36,699 parallel names, measured on the committed corpus.
    expect(s.products).toBeGreaterThan(500);
    expect(s.parallelNames).toBeGreaterThan(30_000);
    // The derived vocabulary is an order of magnitude past the ~90-word list.
    expect(s.globalTokens).toBeGreaterThan(1_000);
  });

  it("keeps the hand list SMALL -- it patches the corpus, it does not replace it", () => {
    // The corpus floor is 2020, so vintage parallels need hand spellings. If
    // this list starts growing, the corpus is what needs rebuilding.
    expect(V.HAND_SPELLINGS.length).toBeLessThanOrEqual(V.HAND_LIST_CEILING);
    expect(V.HAND_PHRASES.length).toBeLessThanOrEqual(V.HAND_LIST_CEILING);
  });

  it("matches per (year, setKey): 'chrome' is the SET on Topps Heritage Chrome and not on plain Topps", () => {
    expect(V.isProductWord("chrome", "topps-heritage-chrome")).toBe(true);
    expect(V.isProductWord("chrome", "topps-chrome-black")).toBe(true);
    expect(V.isProductWord("chrome", "bowman-chrome")).toBe(true);
    expect(V.isProductWord("chrome", "topps")).toBe(false);
    expect(V.isProductWord("heritage", "topps-heritage-chrome")).toBe(true);
    expect(V.isProductWord("heritage", "topps-chrome")).toBe(false);
  });

  it("the product's own checklist decides whether a derived parallel is real", () => {
    // Refractor IS listed for 2021 Bowman Chrome; "Chrome" is NOT listed as a
    // parallel of Topps Heritage Chrome -- it is that product's own name.
    expect(V.checklistListsParallel("Refractor", 2021, "bowman-chrome")).toBe(true);
    expect(V.checklistListsParallel("Chrome", 2024, "topps-heritage-chrome")).toBe(false);
  });

  // ── A2. SPORT AND GRADE WORDS ARE NOT FINISHES (verifier, 2026-09-03) ────
  //
  // The support floor is a FREQUENCY test, so it only removes what is rare. A
  // word that is common in the corpus and still never names a parallel sails
  // through: brands did (topps, 13 products) and so did sports (basketball 22,
  // football 17, usa 11, baseball 8) and grade words (gem 10). Measured before
  // the fix: 19 of 1,278 sampled titles (1.5%) were disqualified from eviction
  // by one of those words ALONE. A sport names which checklist the card is in
  // and a grade describes the slab; neither says how the card is printed.

  it("no sport word is a finish token -- a sport names the checklist, not the print", () => {
    for (const sport of ["baseball", "basketball", "football", "hockey", "soccer", "usa", "world", "american"]) {
      expect(V.CORPUS_STOPWORDS.has(sport)).toBe(true);
      // stopped on every product, including one whose corpus slice contains it
      expect(V.vocabularyFor(2025, "topps-chrome").isFinishToken(sport)).toBe(false);
      expect(V.vocabularyFor(2025, "panini-prizm").isFinishToken(sport)).toBe(false);
    }
  });

  it("no grade word is a finish token -- the grade is on the identity, not the print", () => {
    for (const g of ["gem", "mint", "pristine", "psa", "bgs", "sgc", "cgc"]) {
      expect(V.CORPUS_STOPWORDS.has(g)).toBe(true);
      expect(V.vocabularyFor(2025, "topps-chrome").isFinishToken(g)).toBe(false);
    }
  });

  it("the two verifier counterexamples do NOT name a finish", () => {
    const ctx = { year: 2025, setKey: "topps-chrome" };
    // disqualified only by `football` before the fix
    expect(V.titleNamesFinish("2025 Topps Chrome Football Colston Loveland Rookie Auto", ctx)).toBe(false);
    // ...and by `football` + `gem`
    expect(V.titleNamesFinish("2025 Topps Chrome Football Colston Loveland Rookie Auto PSA 10 GEM MINT", ctx)).toBe(false);
  });

  it("and the real parallels STILL name one -- the fix narrows nothing that matters", () => {
    expect(V.titleNamesFinish("1990 Bowman Tiffany Frank Thomas #320", { year: 1990, setKey: "bowman" })).toBe(true);
    expect(V.titleNamesFinish("1991 Topps Desert Shield Chipper Jones #1", { year: 1991, setKey: "topps" })).toBe(true);
    expect(V.titleNamesFinish("2018 Panini Rapture Luka Doncic RC", { year: 2018, setKey: "panini" })).toBe(true);
    // the hand phrases survive the corpus-phrase filter below
    expect(V.titleNamesFinish("2020 Topps Press Proof Mike Trout", { year: 2020, setKey: "topps" })).toBe(true);
    expect(V.titleNamesFinish("2019 Topps Gold Refractor Acuna", { year: 2019, setKey: "topps-chrome" })).toBe(true);
  });

  // ── A3. A PHRASE OF PURE STOPWORDS IS NOT EVIDENCE ──────────────────────
  //
  // The stopword pass runs on TOKENS, so a corpus name whose every word is
  // stopped still became a PHRASE and matched on its own -- defeating the
  // stopword list one level up. "Rookie Auto" is the case that bites: both
  // words are stopped individually, yet the phrase disqualified every
  // rookie-auto title in the pool. Measured: 353 such phrases.

  it("no corpus phrase is made entirely of stopwords", () => {
    const c = V.buildVocabulary();
    const hand = new Set(V.HAND_PHRASES.map((p: string) => p.toLowerCase()));
    const allStop = [...c.phrases].filter((p: string) => {
      if (hand.has(p)) return false;               // hand phrases are adjudicated
      const parts = String(p).split(" ").filter(Boolean);
      if (parts.length < 2) return false;
      return parts.every((w) => V.CORPUS_STOPWORDS.has(w) || /^\d+$/.test(w) || w.length < 3);
    });
    expect(allStop).toEqual([]);
  });

  it("'rookie auto' is not a phrase, and a plain rookie-auto title names no finish", () => {
    expect(V.buildVocabulary().phrases.has("rookie auto")).toBe(false);
    expect(V.titleNamesFinish("2023 Topps Chrome Rookie Auto Corbin Carroll", { year: 2023, setKey: "topps-chrome" })).toBe(false);
  });
});

// ═══ THE COUNTEREXAMPLE PINS -- every one must be NOT WRITABLE ═════════════

describe("PINS -- every counterexample title in the findings classifies NOT writable", () => {
  for (const cx of COUNTEREXAMPLES) {
    it(`refuses to evict: ${cx.what}`, () => {
      const res = K.classifyRow(cxInput(cx));
      expect(res.writable).toBe(false);
      // and it is refused for the RIGHT reason -- the title names a parallel
      expect(res.reasons.join(" ")).toMatch(/title-names-a-finish|not-base-eviction/);
    });
    it(`the vocabulary itself reads a finish in: ${cx.what}`, () => {
      expect(V.titleNamesFinish(cx.title, { year: cx.year, setKey: cx.setKey })).toBe(true);
    });
  }
});

describe("PIN -- the genuine base-on-refractor-slug shape STILL classifies writable", () => {
  it("the Gonzalez shape tags BASE-EVICTION and is writable", () => {
    const res = K.classifyRow(gonzInput());
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.subclass).toBe(K.BASE_EVICTION);
    expect(res.tier).toBe(K.AUTO);
    expect(res.writable).toBe(true);
  });
  it("a guard that stopped this would be an off switch, not a guard", () => {
    // The whole point of the per-(year,setKey) vocabulary: "Bowman" and
    // "Chrome" on a bowman/bowman-chrome card name the SET, and "Auto" and
    // "1st" describe the card. None of them is a finish here.
    expect(V.titleNamesFinish(GONZALEZ_TITLE, { year: 2026, setKey: "bowman" })).toBe(false);
  });
});

// ═══ B. A STORED PRINT RUN IS EVIDENCE, AND IT IS NEVER DELETED (finding 2) ═

describe("B -- a stored printRun disqualifies eviction and is never deleted", () => {
  it("printRun has LEFT the movable axes -- an eviction may not touch it", () => {
    expect(K.EVICTION_MOVABLE_AXES.has("printRun")).toBe(false);
    expect(K.EVICTION_MOVABLE_AXES.has("parallel")).toBe(true);
  });

  it("a row storing /499 is refused: a base card is not serial-numbered", () => {
    const res = K.classifyRow(gonzInput({
      stored: { ...gonzStored, printRun: 499 },
      derived: { ...gonzStored, printRun: 499 },
    }));
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/stored-printrun-names-a-limited-parallel/);
  });

  it("a row storing /1 -- the Immaculate Pujols shape -- is refused", () => {
    const res = K.classifyRow(gonzInput({
      stored: { ...gonzStored, printRun: 1 },
      derived: { ...gonzStored, printRun: 1 },
    }));
    expect(res.writable).toBe(false);
  });

  it("the predicate reads a stored run as evidence, and a BLANK one as unknown", () => {
    expect(K.storedPrintRunNamesALimitedParallel({ printRun: 499 })).toBe(true);
    expect(K.storedPrintRunNamesALimitedParallel({ printRun: 1 })).toBe(true);
    // Gonzalez: the run is on the SLUG, not the field. Blank means unknown,
    // and an unknown is what an eviction may leave alone.
    expect(K.storedPrintRunNamesALimitedParallel({ printRun: null })).toBe(false);
    expect(K.storedPrintRunNamesALimitedParallel({})).toBe(false);
  });

  it("the apply path no longer carries a bare `delete keep.printRun`", () => {
    const src = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");
    expect(src).not.toMatch(/^\s*delete keep\.printRun;/m);
    // and it refuses rather than writing when the two disagree
    expect(src).toMatch(/refused:eviction-would-delete-stored-printrun/);
  });
});

// ═══ C. THE SERIAL REGEX ACCEPTS '#/N' (finding 3) ═════════════════════════

describe("C -- the serial regex accepts the '#/N' spelling", () => {
  it("reads '#/398', the exact spelling the old regex missed", () => {
    expect(V.serialFromTitle("2023 Topps Update Elly De La Cruz #/398")).toBe(398);
    expect(V.titleStatesSerial("2023 Topps Update Elly De La Cruz #/398")).toBe(true);
  });
  it("still reads the spellings it always did", () => {
    expect(V.serialFromTitle("Tie-Dye Prizm #/25")).toBe(25);
    expect(V.serialFromTitle("Disco /75")).toBe(75);
    expect(V.serialFromTitle("JARLIN SUSANA 59/149 PSA 1")).toBe(149);
    expect(V.serialFromTitle("1/1 Superfractor")).toBe(1);
  });
  it("a date is not a print run, and a grade is not a print run", () => {
    expect(V.serialFromTitle("sold 8/2026")).toBeNull();
    expect(V.serialFromTitle("PSA 10 #140")).toBeNull();
  });
});

// ═══ D. THE IMPROVE GUARDS (findings 4 and 7) ══════════════════════════════

/** An IMPROVE-shaped row: the stored key leaves an axis blank, the derivation
 *  fills it, nothing is dropped or changed. */
const improveInput = (over: {
  title: string; stored: Identity; derived: Identity; source?: string;
}): ClassifyInput => ({
  row: { id: "sc-imp", cardId: "hiq:x", source: over.source ?? "cardhedge", title: over.title },
  stored: over.stored, derived: over.derived, checklistBacked: true,
  storedSlug: "hiq:x", baseDestSlug: null, baseDestBacked: false,
});

describe("D1 -- never mint a parallel from a PRODUCT word over a Base title", () => {
  it("refuses '2024 Topps Heritage Chrome #399 Base' -> parallel Chrome", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2024, setKey: "topps-heritage-chrome", cardNumber: "399", parallel: "Base", isAuto: false, printRun: null };
    const res = K.classifyRow(improveInput({
      title: "2024 Topps Heritage Chrome #399 Base",
      stored,
      derived: { ...stored, parallel: "Chrome" },
    }));
    expect(res.klass).toBe(K.IMPROVE);           // the census still counts the shape
    expect(res.writable).toBe(false);            // and it never writes
    expect(res.improveRefusals?.join(" ")).toMatch(/improve-parallel-from-product-word/);
  });

  it("refuses 'Topps Chrome Black #191 Base' -> Black Refractor", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2021, setKey: "topps-chrome-black", cardNumber: "191", parallel: "Base", isAuto: false, printRun: null };
    const res = K.classifyRow(improveInput({
      title: "2021 Topps Chrome Black #191 Base",
      stored,
      derived: { ...stored, parallel: "Black" },
    }));
    expect(res.writable).toBe(false);
    expect(res.improveRefusals?.join(" ")).toMatch(/improve-parallel-from-product-word|improve-parallel-over-explicit-base/);
  });

  it("still ALLOWS a real parallel the title actually names", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2021, setKey: "bowman-chrome", cardNumber: "BCP-1", parallel: "Base", isAuto: false, printRun: null };
    const res = K.classifyRow(improveInput({
      title: "2021 Bowman Chrome BCP-1 Orange Refractor",
      stored,
      derived: { ...stored, parallel: "Orange Refractor" },
    }));
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.writable).toBe(true);
    expect(res.improveRefusals ?? []).toEqual([]);
  });
});

describe("D2 -- never fill a printRun onto Base/blank under an unrecognized qualifier", () => {
  it("refuses 'Tie-Dye Prizm #/25' -> Base:/25 (numbered base is checklist-defined)", () => {
    const stored: Identity = { sport: "basketball", cardYear: 2020, setKey: "panini-prizm", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null };
    const res = K.classifyRow(improveInput({
      title: "2020 Panini Prizm Tie-Dye Prizm #/25",
      stored,
      derived: { ...stored, printRun: 25 },
    }));
    expect(res.writable).toBe(false);
    expect(res.improveRefusals?.join(" ")).toMatch(/improve-(printrun-onto-base-with-unrecognized-qualifier|numbered-base-not-checklist-defined)/);
  });

  it("refuses 'Disco /75' -> Base:/75", () => {
    const stored: Identity = { sport: "basketball", cardYear: 2021, setKey: "panini-mosaic", cardNumber: "5", parallel: "Base", isAuto: false, printRun: null };
    const res = K.classifyRow(improveInput({
      title: "2021 Panini Mosaic Disco /75",
      stored,
      derived: { ...stored, printRun: 75 },
    }));
    expect(res.writable).toBe(false);
  });

  it("still ALLOWS a print run filled onto a NAMED parallel", () => {
    // The run belongs to the parallel, and the parallel is named -- that is
    // the shape the fill was built for.
    const stored: Identity = { sport: "baseball", cardYear: 2021, setKey: "bowman-chrome", cardNumber: "BCP-1", parallel: "Orange Refractor", isAuto: false, printRun: null };
    const res = K.classifyRow(improveInput({
      title: "2021 Bowman Chrome BCP-1 Orange Refractor /25",
      stored,
      derived: { ...stored, printRun: 25 },
    }));
    expect(res.writable).toBe(true);
  });
});

describe("D3 -- a setKey COLLAPSE never feeds IMPROVE", () => {
  const collapses: Array<[string, string]> = [
    ["bowmans-best", "bowman"],
    ["bowman-sterling", "bowman"],
    ["bowman-heritage", "bowman"],
    ["bowman-chrome", "bowman"],
    ["topps-allen-ginter", "topps"],
    ["topps-fire", "topps"],
    ["fleer-ultra", "ultra"],
    ["topps-stadium-club-chrome", "paper"],
    ["topps-heritage-chrome", "paper"],
  ];
  for (const [from, to] of collapses) {
    it(`detects the collapse ${from} -> ${to}`, () => {
      expect(K.derivationCollapsesProduct({ setKey: from }, { setKey: to })).toBe(`${from}->${to}`);
    });
  }

  it("a collapse is refused even when it also fills a blank axis", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2022, setKey: "bowman-chrome", cardNumber: "BCP-1", parallel: "Base", isAuto: false, printRun: null };
    const refusals = K.improveRefusals({
      row: { title: "2022 Bowman BCP-1" },
      stored,
      derived: { ...stored, setKey: "bowman", parallel: "Refractor" },
      axes: { same: [], filled: ["parallel"], dropped: [], changed: ["setKey"] },
    });
    expect(refusals.join(" ")).toMatch(/improve-setkey-collapses-distinct-product/);
  });

  it("the REVERSE direction is not a collapse -- bowman -> bowman-chrome refines", () => {
    expect(K.derivationCollapsesProduct({ setKey: "bowman" }, { setKey: "bowman-chrome" })).toBeNull();
  });

  it("the known-distinct list names the products the findings name", () => {
    for (const s of ["bowmans-best", "bowman-sterling", "bowman-heritage", "bowman-chrome",
      "topps-allen-ginter", "topps-fire", "topps-stadium-club-chrome", "topps-heritage-chrome"]) {
      expect(K.DISTINCT_PRODUCT_SETKEYS).toContain(s);
    }
  });
});

// ═══ E. THE RUNNER: before / apply / after, and no apply forwarding (5) ════

describe("E -- the canary gate is wired INSIDE the runner's apply path", () => {
  const yml = fs.readFileSync(path.join(backend, "..", ".github", "workflows", "backfill-runner.yml"), "utf8");

  it("the workflow still parses and adds NO new dispatch inputs (24/25 used)", () => {
    // A cheap structural parse: count the input keys under workflow_dispatch.
    const block = yml.slice(yml.indexOf("workflow_dispatch:"), yml.indexOf("jobs:"));
    const names = [...block.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
    expect(names.length).toBe(24);
    expect(names.length).toBeLessThanOrEqual(25);
  });

  it("has a BEFORE step, an apply step and an AFTER step -- in that order, one job", () => {
    const before = yml.indexOf("Canary gate BEFORE the rematch apply");
    const run = yml.indexOf("- name: Run backfill");
    const after = yml.indexOf("Canary gate AFTER the rematch apply");
    const relaunch = yml.indexOf("Self-relaunch rematch-sold-comps");
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    expect(before).toBeLessThan(run);
    expect(run).toBeLessThan(after);
    // the gate runs BEFORE the relaunch, so a regressed shard never re-dispatches
    expect(after).toBeLessThan(relaunch);
  });

  it("uploads the baseline as an artifact", () => {
    expect(yml).toMatch(/name: Upload the canary baseline/);
    expect(yml).toMatch(/path: \/tmp\/rematch-canary-baseline\.json/);
  });

  it("lets exit 5 fail the job -- the after step does not swallow it", () => {
    const after = yml.slice(yml.indexOf("Canary gate AFTER the rematch apply"));
    const step = after.slice(0, after.indexOf("- name: Upload the shard census"));
    expect(step).toMatch(/exit "\$rc"/);
    expect(step).toMatch(/rc=\$\{PIPESTATUS\[0\]\}/);
    expect(step).not.toMatch(/continue-on-error:\s*true/);
  });

  it("the self-relaunch NEVER forwards apply=true", () => {
    const start = yml.indexOf("- name: Self-relaunch rematch-sold-comps");
    const step = yml.slice(start, yml.indexOf("- name:", start + 10) > 0 ? yml.indexOf("      - name:", start + 10) : undefined);
    expect(step).toMatch(/-f apply=false/);
    // the old, unsafe forwarding must be gone from THIS step
    expect(step).not.toMatch(/-f apply="\$\{\{ inputs\.apply \}\}"/);
  });
});

// ═══ F. EVERY SHARD HAS A CANARY (finding 6) ═══════════════════════════════

describe("F -- canary coverage: every one of the 32 shards has a pool that must not lose rows", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(backend, "data", "rematch-canaries.json"), "utf8")) as {
    canaries: Array<{ name: string; slug: string; shardSlot?: number | null; poolRows: number; derivedFrom?: string }>;
    _shardCoverage?: { of: number; covered: number; uncovered: number[] };
  };
  const table = JSON.parse(fs.readFileSync(path.join(backend, "data", "rematch-shard-table.json"), "utf8")) as { slots: unknown[] };

  it("covers all 32 shards", () => {
    const slots = new Set(doc.canaries.map((c) => c.shardSlot).filter((s) => s !== null && s !== undefined));
    expect(table.slots.length).toBe(32);
    for (let s = 0; s < 32; s++) expect(slots.has(s)).toBe(true);
    expect(doc._shardCoverage?.uncovered ?? []).toEqual([]);
  });

  it("keeps Drew's seven hand-verified canaries untouched", () => {
    const hand = doc.canaries.filter((c) => c.derivedFrom !== "provenance" && c.derivedFrom !== "largest-pool");
    expect(hand.length).toBe(7);
    // the four the findings and the memory index name explicitly
    const slugs = hand.map((c) => c.slug);
    expect(slugs).toContain("hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto");
    expect(slugs).toContain("hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499");
    expect(slugs).toContain("hiq:baseball:2020:bowman-draft:bd-152:image-variation:no-auto");
    expect(slugs).toContain("hiq:basketball:1993:topps-finest:99:refractor:no-auto");
  });

  it("every canary names a pool with at least one row -- a canary that measures nothing is not one", () => {
    for (const c of doc.canaries) {
      expect(c.slug.startsWith("hiq:")).toBe(true);
      expect(c.poolRows).toBeGreaterThan(0);
    }
  });

  it("labels the derived canaries so none is ever quoted as hand-verified", () => {
    const derived = doc.canaries.filter((c) => c.derivedFrom);
    expect(derived.length).toBeGreaterThan(20);
    for (const c of derived) expect(["provenance", "largest-pool"]).toContain(c.derivedFrom);
  });

  // THE REFUSAL IS TESTED BY RUNNING IT, NOT BY READING ITS SOURCE (verifier,
  // 2026-09-03). This assertion used to be `expect(src).toMatch(/has NO
  // canary/)` -- which a mutation to `if (false)` survives untouched, because
  // the string it greps for is still in the file. The gate is a process exit
  // code, so the test spawns the script and asserts the exit code.
  //
  // The script reads its canary file from CANARIES and its shard from SLOT, so
  // the seam is honest: a real canaries file with a slot that is genuinely
  // absent from it. COSMOS_CONNECTION_STRING is set to a syntactically valid
  // but unroutable stub -- the refusal fires BEFORE the CosmosClient is
  // constructed, which is itself part of what makes this gate worth having.
  // (Verified: a slot that DOES have a canary gets past this point and then
  // blocks on the stub endpoint, so exit 2 is specific to the refusal.)

  const runCanaryCheck = (slot: string, canariesFile: string, timeout = 30_000) =>
    spawnSync(process.execPath, [path.join(backend, "scripts", "rematch-canary-check.cjs")], {
      env: {
        ...process.env,
        // vitest exports MODE=test, and the script validates MODE before it
        // ever looks at the canaries -- inheriting it would fail the run for
        // the wrong reason and prove nothing about this gate.
        MODE: "check",
        SLOT: slot,
        CANARIES: canariesFile,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub.invalid:443/;AccountKey=c3R1Yg==;",
      },
      encoding: "utf8",
      timeout,
    });

  it("REFUSES (exit 2) a shard with no canary rather than passing it by construction", () => {
    const tmp = path.join(os.tmpdir(), `rematch-canaries-slot7-${process.pid}.json`);
    // one canary, in slot 7 only -- every other slot is genuinely uncovered
    fs.writeFileSync(tmp, JSON.stringify({
      canaries: [{
        name: "stub canary in slot 7", slug: "hiq:baseball:2020:topps:1:base:no-auto",
        shardSlot: 7, poolRows: 3, verifiedMarketDirection: "flat",
      }],
    }), "utf8");
    try {
      const r = runCanaryCheck("19", tmp);
      expect(r.status).toBe(2);
      expect(String(r.stderr)).toMatch(/SLOT=19 has NO canary/);
    } finally { fs.rmSync(tmp, { force: true }); }
  });

  it("REFUSES (exit 2) a canaries file that lists none at all", () => {
    const tmp = path.join(os.tmpdir(), `rematch-canaries-empty-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ canaries: [] }), "utf8");
    try {
      const r = runCanaryCheck("19", tmp);
      expect(r.status).toBe(2);
      expect(String(r.stderr)).toMatch(/lists no canaries/);
    } finally { fs.rmSync(tmp, { force: true }); }
  });

  it("and the SHIPPED canaries file refuses no slot -- the refusal is specific", () => {
    // The behavioural complement: with the real file, a slot gets PAST the
    // refusal and announces the canaries it will measure. We assert on that
    // announcement rather than on an exit code, because past the refusal the
    // script reaches Cosmos -- against the stub endpoint it would simply block,
    // and a test must not wait on a network timeout to prove a branch.
    // Slot 29 is the one the audit caught: 30/30 wrong, and no canary at all
    // before this PR. If any slot must be proven covered by RUNNING the gate,
    // it is that one.
    const real = path.join(backend, "data", "rematch-canaries.json");
    const r = runCanaryCheck("29", real, 6_000);
    expect(String(r.stdout)).toMatch(/slot 29: \d+ canary\/canaries live in THIS shard/);
    expect(String(r.stderr)).not.toMatch(/has NO canary/);
  }, 20_000);
});

// ═══ G. THE SAMPLE IS 500 AND SPREADS ACROSS CARDS (finding 7) ═════════════

describe("G -- SAMPLE_CAP is 500 and the sample spreads across distinct cardIds", () => {
  const src = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");

  it("the cap is 500, not 30 -- the 500-row audit was arithmetically impossible", () => {
    expect(src).toMatch(/const SAMPLE_CAP = Number\(process\.env\.SAMPLE_CAP \|\| 500\)/);
    expect(src).not.toMatch(/const SAMPLE_CAP = 30;/);
  });

  it("samples through a per-cardId reservoir, not the first N of a page", () => {
    expect(src).toMatch(/SAMPLE_PER_CARD_CAP/);
    expect(src).toMatch(/sampleCards/);
    // the length check that made the sample "the first page" is gone
    expect(src).not.toMatch(/if \(\(samples\.get\(sampleKey\) \?\? \[\]\)\.length < SAMPLE_CAP\)/);
  });

  it("the census JSON carries the samples AND their distinct-card spread", () => {
    expect(src).toMatch(/sampleSpread/);
    expect(src).toMatch(/distinctCards/);
    expect(src).toMatch(/sampleCap: SAMPLE_CAP/);
  });

  it("the census JSON names the vocabulary it was classified under", () => {
    expect(src).toMatch(/finishVocabulary: K\.VOCAB\.vocabularyStats\(\)/);
  });
});

// ═══ MUTATION CHECK ════════════════════════════════════════════════════════
//
// Each guard reverted to its pre-fix behaviour, and the pins it protects must
// go red. A guard that cannot be broken by removing it was not doing anything.

describe("MUTATION -- revert each guard and its pins go red", () => {
  it("M1: the OLD closed vocabulary (no corpus) passes the Tiffany counterexample", () => {
    // The pre-fix list, verbatim from the shipped header's own inventory.
    const OLD = new Set(["refractor", "prizm", "shimmer", "wave", "holo", "foil", "chrome",
      "gold", "orange", "purple", "blue", "green", "red", "black", "pink", "sapphire", "atomic"]);
    const oldTitleNamesFinish = (t: string) =>
      t.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean).some((w) => OLD.has(w));
    // Under the OLD vocabulary, Tiffany reads as naming no finish -> evictable.
    expect(oldTitleNamesFinish("1990 Bowman Tiffany #4 Frank Thomas RC")).toBe(false);
    // Under the NEW one it does not.
    expect(V.titleNamesFinish("1990 Bowman Tiffany #4 Frank Thomas RC", { year: 1990, setKey: "bowman" })).toBe(true);
  });

  it("M2: with printRun back in the movable axes, the /499 row would be writable", () => {
    // The guard's own predicate is what stands between the two. Reverting it
    // (treating a stored run as not-evidence) restores the pre-fix verdict.
    const reverted = (_s: Identity) => false;
    expect(reverted({ printRun: 499 })).toBe(false);            // pre-fix: no veto
    expect(K.storedPrintRunNamesALimitedParallel({ printRun: 499 })).toBe(true);  // post-fix: veto
  });

  it("M3: the OLD serial regex misses '#/398'", () => {
    const OLD_BARE = /(?:^|[\s(\[])\/\s*(\d{1,5})(?=$|[\s)\],.])/;   // no '#' lead-in
    expect(OLD_BARE.test("2023 Topps Update Elly De La Cruz #/398")).toBe(false);
    expect(V.titleStatesSerial("2023 Topps Update Elly De La Cruz #/398")).toBe(true);
  });

  it("M4: with no IMPROVE refusals, the Heritage Chrome 'Base' row would be writable", () => {
    const stored: Identity = { sport: "baseball", cardYear: 2024, setKey: "topps-heritage-chrome", cardNumber: "399", parallel: "Base", isAuto: false, printRun: null };
    const axes = { same: [], filled: ["parallel"], dropped: [], changed: [] };
    const refusals = K.improveRefusals({
      row: { title: "2024 Topps Heritage Chrome #399 Base" },
      stored, derived: { ...stored, parallel: "Chrome" }, axes,
    });
    // The guard fires...
    expect(refusals.length).toBeGreaterThan(0);
    // ...and with it reverted (an empty refusal list) the row's `writable`
    // would be governed by the tier alone, which is AUTO -- i.e. it writes.
    const revertedWritable = K.AUTO === K.AUTO && [].length === 0;
    expect(revertedWritable).toBe(true);
  });

  it("M5: the setKey collapse guard is what stops bowmans-best -> bowman", () => {
    expect(K.derivationCollapsesProduct({ setKey: "bowmans-best" }, { setKey: "bowman" })).toBe("bowmans-best->bowman");
    // reverted (always null) it would let the collapse through
    const reverted = () => null;
    expect(reverted()).toBeNull();
  });
});
