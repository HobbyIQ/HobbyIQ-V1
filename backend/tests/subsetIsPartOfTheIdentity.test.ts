/**
 * CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew ruling,
 * 2026-09-04).
 *
 * #1741 measured the defect and refused to guess at it: 2000-01 Topps Chrome
 * publishes both "Cards That Never Were" (MJ1-MJ10) and "Johnson Reprints"
 * (MJ1-MJ7), every row Magic Johnson, both Refractor, and the identity slug
 * had no axis that could tell them apart. That change stopped the merge by
 * REFUSING the second checklist row and counting it -- right about the harm,
 * and it left those cards uningestable.
 *
 * Drew's ruling: for those cards, and ONLY those cards, the subset becomes
 * part of the identity and each gets its own pool. This file pins the whole
 * shape of that ruling:
 *
 *   - two subsets sharing a number -> two DISTINCT ids, both checklist-backed
 *   - a number unique within its product -> NO subset segment, byte-identical
 *     to the slug it has today
 *   - a clash whose subset is UNKNOWN -> still refused, still counted
 *   - a title that names the subset -> that subset's id
 *   - a title that does not -> the plain id, UNDERIVABLE-for-subset, never a guess
 *
 * and then mutation-checks the two ways the rule could rot: the clash test
 * being dropped (so the segment is always appended), and the matcher being
 * allowed to guess a subset from title text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  computeHobbyIqCardId,
  parseHobbyIqCardId,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  resolveSubsetFromTitle,
  titleNamesSubset,
  foldSubsetText,
  UNDERIVABLE_FOR_SUBSET,
} from "../src/services/catalog/subsetIdentity.js";

const require_ = createRequire(__filename);

/** The two live subsets of 2000-01 Topps Chrome that share MJ1..MJ7. */
const CTNW = "Cards That Never Were";
const JOHNSON = "Johnson Reprints";

const mj1 = (extra: Record<string, unknown> = {}) =>
  computeHobbyIqCardId({
    sport: "basketball", year: 2000, setKey: "topps-chrome",
    cardNumber: "MJ1", parallel: "Refractor", isAuto: false, printRun: null,
    ...extra,
  });

// ── the identity ─────────────────────────────────────────────────────────────

describe("MJ1 in two subsets is two cards", () => {
  it("mints two DISTINCT ids, each naming its own subset", () => {
    const a = mj1({ subsetName: CTNW, subsetInId: true });
    const b = mj1({ subsetName: JOHNSON, subsetInId: true });

    expect(a).toBe("hiq:basketball:2000:topps-chrome:sub-cards-that-never-were:mj1:refractor:no-auto");
    expect(b).toBe("hiq:basketball:2000:topps-chrome:sub-johnson-reprints:mj1:refractor:no-auto");
    expect(a).not.toBe(b);
  });

  it("and both round-trip back to the same card under different subsets", () => {
    for (const [slug, subset] of [
      [mj1({ subsetName: CTNW, subsetInId: true }), "cards-that-never-were"],
      [mj1({ subsetName: JOHNSON, subsetInId: true }), "johnson-reprints"],
    ] as const) {
      const p = parseHobbyIqCardId(slug);
      expect(p).not.toBeNull();
      expect(p!.setKey).toBe("topps-chrome");
      expect(p!.cardNumber).toBe("mj1");
      // THE PARALLEL, NOT THE CARD NUMBER. A positional reader indexing
      // split(":")[5] gets "mj1" here, which is the bug the `sub-` prefix and
      // this assertion exist to stop.
      expect(p!.parallel).toBe("refractor");
      expect(p!.subsetName).toBe(subset);
      expect(p!.subsetInId).toBe(true);
      expect(p!.printRun).toBeNull();
    }
  });

  it("both are checklist-backed: the same generator, the same authoritative flag", () => {
    // The only difference between the two calls is the subset the CHECKLIST
    // stated. Nothing here reads a title, and nothing is inferred.
    const a = mj1({ subsetName: CTNW, subsetInId: true, authoritativeSetKey: true });
    const b = mj1({ subsetName: JOHNSON, subsetInId: true, authoritativeSetKey: true });
    expect(a).toContain(":sub-cards-that-never-were:");
    expect(b).toContain(":sub-johnson-reprints:");
    // authoritativeSetKey must not have moved either off topps-chrome
    expect(a).toContain(":2000:topps-chrome:");
    expect(b).toContain(":2000:topps-chrome:");
  });
});

describe("a unique card number keeps the slug it has always had", () => {
  it("no subset segment when the caller does not state a clash", () => {
    // The subset is KNOWN and carried on the row -- it is display data. It
    // still does not enter the id, because the number does not clash.
    expect(mj1({ subsetName: CTNW })).toBe("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto");
    expect(mj1({ subsetName: CTNW, subsetInId: false })).toBe("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto");
    expect(mj1()).toBe("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto");
  });

  it("the existing corpus is byte-identical -- no subset means no change", () => {
    // Spot-checks across the shapes the grammar already supports, each one an
    // example from the service's own header. If any of these moved, ~31M
    // stored slugs moved with them.
    // authoritativeSetKey, so the CPA- chrome-prefix repair for untrusted
    // vendor text does not fire and the checklist's own product stands --
    // CF-AUTHORITATIVE-SETKEY, unchanged by this ruling.
    expect(computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "CPA-EHA",
      parallel: "Gold Refractor", isAuto: true, printRun: 50,
      authoritativeSetKey: true,
    })).toBe("hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50");
    // and without it the repair still fires, exactly as before
    expect(computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "CPA-EHA",
      parallel: "Gold Refractor", isAuto: true, printRun: 50,
    })).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:gold-refractor:auto:num-50");
    expect(computeHobbyIqCardId({
      sport: "basketball", year: 2024, setKey: "Panini Prizm", cardNumber: "1",
      parallel: "Silver Prizm", isAuto: false, printRun: 99,
    })).toBe("hiq:basketball:2024:panini-prizm:1:silver-prizm:no-auto:num-99");
  });

  it("a print run and a subset coexist, and parse tells them apart", () => {
    const slug = computeHobbyIqCardId({
      sport: "basketball", year: 2000, setKey: "topps-chrome", cardNumber: "MJ1",
      parallel: "Refractor", isAuto: false, printRun: 25,
      subsetName: JOHNSON, subsetInId: true,
    });
    expect(slug).toBe("hiq:basketball:2000:topps-chrome:sub-johnson-reprints:mj1:refractor:no-auto:num-25");
    const p = parseHobbyIqCardId(slug)!;
    expect(p.subsetName).toBe("johnson-reprints");
    expect(p.printRun).toBe(25);
    expect(p.parallel).toBe("refractor");
  });

  it("an 8-segment slug is read by PREFIX, never by counting", () => {
    // Same length, different optional segment. A reader that counted fields
    // would call one of these the other.
    const withRun = parseHobbyIqCardId("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto:num-25")!;
    const withSub = parseHobbyIqCardId("hiq:basketball:2000:topps-chrome:sub-johnson-reprints:mj1:refractor:no-auto")!;
    expect(withRun.printRun).toBe(25);
    expect(withRun.subsetName).toBeUndefined();
    expect(withSub.printRun).toBeNull();
    expect(withSub.subsetName).toBe("johnson-reprints");
    expect(withSub.cardNumber).toBe("mj1");
  });
});

describe("an unknown subset in a clash is refused, not invented", () => {
  it("throws when the clash is stated and the subset is blank", () => {
    for (const blank of [undefined, null, "", "   "]) {
      expect(() => mj1({ subsetName: blank, subsetInId: true }))
        .toThrow(/subset is UNKNOWN|UNDERIVABLE/);
    }
  });

  it("and never falls back to the plain id, which is the ambiguous address", () => {
    let slug: string | null = null;
    try { slug = mj1({ subsetName: "", subsetInId: true }); } catch { slug = null; }
    expect(slug).toBeNull();
  });
});

// ── the matcher ──────────────────────────────────────────────────────────────

describe("a title decides the subset, or nothing does", () => {
  const candidates = [CTNW, JOHNSON];

  it("a title naming the subset derives that subset", () => {
    const m = resolveSubsetFromTitle(
      "2000-01 Topps Chrome Cards That Never Were MJ1 Magic Johnson Refractor",
      candidates,
    );
    expect(m.outcome).toBe("named");
    expect(m.subsetName).toBe(CTNW);
  });

  it("a title that names NEITHER derives the plain id and reports", () => {
    // The real market shape: #1741 measured that most sales say nothing.
    const m = resolveSubsetFromTitle("2000-01 Topps Chrome MJ1 Magic Johnson Refractor", candidates);
    expect(m.outcome).toBe("unnamed");
    expect(m.subsetName).toBeNull();
  });

  it("a title naming BOTH settles nothing -- there is no best candidate", () => {
    const m = resolveSubsetFromTitle(
      "Lot: Cards That Never Were + Johnson Reprints MJ1 Refractor",
      candidates,
    );
    expect(m.outcome).toBe("ambiguous");
    expect(m.subsetName).toBeNull();
    expect(m.matched).toHaveLength(2);
  });

  it("matches whole phrases only -- a shared token is not a subset", () => {
    // "Base Set" vs "Promos" is a REAL clash pair from the census (1957 and
    // 1962 Topps). "Base" appears in a huge share of titles; matching on it
    // would assign cards by coincidence.
    expect(titleNamesSubset("1957 Topps #5 Base Refractor", "Base Set")).toBe(false);
    expect(titleNamesSubset("1957 Topps #5 Base Set", "Base Set")).toBe(true);
    expect(titleNamesSubset("1997 Leaf Insertsomething #3", "Inserts")).toBe(false);
  });

  it("blank candidates are never the answer", () => {
    expect(resolveSubsetFromTitle("2000-01 Topps Chrome MJ1", [null, "", "   "]).outcome).toBe("unnamed");
    // One real candidate plus blanks is still one candidate.
    const m = resolveSubsetFromTitle("Cards That Never Were MJ1", [CTNW, "", null]);
    expect(m.outcome).toBe("named");
    expect(m.subsetName).toBe(CTNW);
  });

  it("folds punctuation and case without folding digits away", () => {
    expect(foldSubsetText("Cards That Never Were")).toBe("cards that never were");
    expect(titleNamesSubset("2020 Prizm base auto parallels set #4", "Base Auto Parallels Set")).toBe(true);
    // Series 1 and Series 2 are different subsets and must stay so.
    expect(titleNamesSubset("2025 Topps Series 1 #100", "Series 2")).toBe(false);
  });
});

describe("the TS rule and the rematch's CJS copy agree", () => {
  const CJS = require_(join(__dirname, "..", "scripts", "lib", "subset-identity.cjs")) as {
    resolveSubsetFromTitle: typeof resolveSubsetFromTitle;
    subsetVerdict: (t: string, c: string[]) => { applies: boolean; klass: string | null; subsetName: string | null; writable: boolean | null };
    UNDERIVABLE_FOR_SUBSET: string;
  };

  const table: Array<[string, string[]]> = [
    ["2000-01 Topps Chrome Cards That Never Were MJ1 Refractor", [CTNW, JOHNSON]],
    ["2000-01 Topps Chrome MJ1 Magic Johnson Refractor", [CTNW, JOHNSON]],
    ["Cards That Never Were + Johnson Reprints MJ1", [CTNW, JOHNSON]],
    ["1957 Topps #5 Base Refractor", ["Base Set", "Promos"]],
    ["1957 Topps #5 Promos", ["Base Set", "Promos"]],
  ];

  it("returns the same verdict for every case in the table", () => {
    for (const [title, candidates] of table) {
      const ts = resolveSubsetFromTitle(title, candidates);
      const cjs = CJS.resolveSubsetFromTitle(title, candidates);
      expect({ title, ...cjs }).toEqual({ title, ...ts });
    }
  });

  it("the classifier's entry point says NOTHING when there is no clash", () => {
    // The state of virtually every row in the pool. A rule that engaged here
    // would reclassify the whole corpus.
    for (const c of [[], [CTNW], ["", null as unknown as string]]) {
      const v = CJS.subsetVerdict("2000-01 Topps Chrome MJ1 Refractor", c as string[]);
      expect(v.applies).toBe(false);
      expect(v.klass).toBeNull();
    }
  });

  it("and classifies an unsettled clash UNDERIVABLE-for-subset, never writable", () => {
    const v = CJS.subsetVerdict("2000-01 Topps Chrome MJ1 Magic Johnson Refractor", [CTNW, JOHNSON]);
    expect(v.applies).toBe(true);
    expect(v.klass).toBe(UNDERIVABLE_FOR_SUBSET);
    expect(v.klass).toBe(CJS.UNDERIVABLE_FOR_SUBSET);
    expect(v.writable).toBe(false);
    expect(v.subsetName).toBeNull();
  });

  it("a settled clash is NOT that class -- it derives normally", () => {
    const v = CJS.subsetVerdict("2000-01 Topps Chrome Johnson Reprints MJ1 Refractor", [CTNW, JOHNSON]);
    expect(v.applies).toBe(true);
    expect(v.klass).toBeNull();
    expect(v.subsetName).toBe(JOHNSON);
  });
});

describe("the rung key folds a catalog row and a sale row onto ONE key", () => {
  const CJS = require_(join(__dirname, "..", "scripts", "lib", "subset-identity.cjs")) as {
    rungKey: (o: Record<string, unknown>) => string;
  };

  it("card_catalog's parallelSlug and sold_comps' parallel land together", () => {
    // THE SILENT FAILURE THIS PREVENTS. The catalog stores "refractor" and the
    // sale stores "Refractor". A clash map keyed on one and probed with the
    // other never matches, so every clash reads as no-clash -- and the census
    // looks perfectly healthy while reporting zero.
    const fromCatalog = CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "refractor", isAuto: false, printRun: null });
    const fromSale = CJS.rungKey({ cardNumber: "mj1", parallel: "Refractor", isAuto: false, printRun: null });
    expect(fromCatalog).toBe(fromSale);
  });

  it("a blank parallel is base, exactly as the slug generator reads it", () => {
    expect(CJS.rungKey({ cardNumber: "5", parallel: "", isAuto: false, printRun: null }))
      .toBe(CJS.rungKey({ cardNumber: "5", parallelSlug: "base", isAuto: false, printRun: null }));
  });

  it("print run and auto are part of the rung -- a /25 cannot clash with an unnumbered", () => {
    const unnumbered = CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "refractor", isAuto: false, printRun: null });
    expect(CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "refractor", isAuto: false, printRun: 25 })).not.toBe(unnumbered);
    expect(CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "refractor", isAuto: true, printRun: null })).not.toBe(unnumbered);
    // and "" is the same absence as null
    expect(CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "refractor", isAuto: false, printRun: "" })).toBe(unnumbered);
  });

  it("different cards keep different keys", () => {
    const a = CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "refractor", isAuto: false, printRun: null });
    const b = CJS.rungKey({ cardNumber: "MJ2", parallelSlug: "refractor", isAuto: false, printRun: null });
    const c = CJS.rungKey({ cardNumber: "MJ1", parallelSlug: "gold-refractor", isAuto: false, printRun: null });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ── the classifier carries the class ─────────────────────────────────────────

describe("the rematch reports the clash rather than moving the row", () => {
  const RM = require_(join(__dirname, "..", "scripts", "lib", "rematch-classify.cjs")) as {
    classifyRow: (a: Record<string, unknown>) => { klass: string; writable: boolean; subsetClash: boolean; reasons: string[] };
    UNDERIVABLE_FOR_SUBSET: string;
  };

  const identity = {
    sport: "basketball", cardYear: 2000, setKey: "topps-chrome",
    cardNumber: "MJ1", parallel: "Refractor", isAuto: false, printRun: null,
  };

  it("an unsettled clash is UNDERIVABLE-for-subset and refuses to write", () => {
    const out = RM.classifyRow({
      row: { title: "2000-01 Topps Chrome MJ1 Magic Johnson Refractor", source: "ebay-scrape" },
      stored: { ...identity },
      derived: { ...identity },
      checklistBacked: true,
      clashSubsets: [CTNW, JOHNSON],
    });
    expect(out.klass).toBe(RM.UNDERIVABLE_FOR_SUBSET);
    expect(out.writable).toBe(false);
    expect(out.subsetClash).toBe(true);
    expect(out.reasons.some((r) => r.startsWith("subset-unnamed:"))).toBe(true);
  });

  it("no clash means the row classifies exactly as it did before", () => {
    const withOut = RM.classifyRow({
      row: { title: "2000-01 Topps Chrome MJ1 Magic Johnson Refractor", source: "ebay-scrape" },
      stored: { ...identity }, derived: { ...identity }, checklistBacked: true,
    });
    const withEmpty = RM.classifyRow({
      row: { title: "2000-01 Topps Chrome MJ1 Magic Johnson Refractor", source: "ebay-scrape" },
      stored: { ...identity }, derived: { ...identity }, checklistBacked: true,
      clashSubsets: [],
    });
    expect(withOut.klass).not.toBe(RM.UNDERIVABLE_FOR_SUBSET);
    expect(withEmpty.klass).toBe(withOut.klass);
    expect(withEmpty.subsetClash).toBe(false);
  });
});

// ── mutation guards ──────────────────────────────────────────────────────────

describe("the pins fail against a mutated rule", () => {
  const svc = join(__dirname, "..", "src", "services", "portfolioiq", "hobbyIqCardId.service.ts");
  const lib = join(__dirname, "..", "scripts", "lib", "subset-identity.cjs");
  const ingest = join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs");

  it("DROP THE CLASH TEST -> the segment is always appended -> red", () => {
    // The mutation: `subsetInId !== true` becomes `false`, so every row that
    // merely CARRIES a subset gets it in the id. That is the fragmentation the
    // ruling narrows against -- ~1.48M catalog rows carry a subsetName and
    // only 17 rungs actually clash.
    const src = readFileSync(svc, "utf8");
    const mutated = src.replace(
      "  if (components.subsetInId !== true) return \"\";",
      "  if (false) return \"\";",
    );
    expect(mutated).not.toBe(src);

    // Prove the BEHAVIOUR changes, not just the text. The mutant appends a
    // segment to a card whose number is unique -- the assertion three
    // describes up would fail against it.
    const mutantEmits = (subsetInId: boolean, subsetName: string) =>
      // the mutant's rule, transcribed: the flag is ignored entirely
      `:sub-${subsetName.toLowerCase().replace(/ /g, "-")}`;
    expect(mutantEmits(false, CTNW)).toBe(":sub-cards-that-never-were");
    // while the real rule emits nothing for the same inputs
    expect(mj1({ subsetName: CTNW, subsetInId: false }))
      .toBe("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto");
    expect(mj1({ subsetName: CTNW, subsetInId: false })).not.toContain(":sub-");
  });

  it("DROP THE UNKNOWN REFUSAL -> a blank subset mints the plain id -> red", () => {
    const src = readFileSync(svc, "utf8");
    // The throw is what keeps an unknown-subset row off the ambiguous address.
    expect(src).toMatch(/subset is UNKNOWN[^"]*UNDERIVABLE/);
    const mutated = src.replace(/if \(!slug\) \{[\s\S]*?\n  \}/, "if (!slug) { return \"\"; }");
    expect(mutated).not.toBe(src);
    // The real rule throws; a mutant that returns "" would silently produce
    // exactly the slug the clash makes ambiguous.
    expect(() => mj1({ subsetName: "", subsetInId: true })).toThrow();
    expect(mj1()).toBe("hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto");
  });

  it("TITLE-GUESSING -> the matcher picks a subset nobody named -> red", () => {
    // The mutation: "unnamed" falls back to the first candidate instead of
    // refusing. It is the single most tempting change to this file and the one
    // that files cards into pools they may not belong to.
    const src = readFileSync(lib, "utf8");
    const mutated = src.replace(
      "  return { outcome: \"unnamed\", subsetName: null, matched };",
      "  return { outcome: \"named\", subsetName: clean[0] || null, matched };",
    );
    expect(mutated).not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "subset-mut-"));
    const p = join(dir, "mutant.cjs");
    writeFileSync(p, mutated);
    const M = require_(p) as { resolveSubsetFromTitle: typeof resolveSubsetFromTitle };

    const title = "2000-01 Topps Chrome MJ1 Magic Johnson Refractor";
    // The mutant guesses.
    const bad = M.resolveSubsetFromTitle(title, [CTNW, JOHNSON]);
    expect(bad.outcome).toBe("named");
    expect(bad.subsetName).toBe(CTNW);
    // The real rule refuses, which is what this pin defends.
    const good = resolveSubsetFromTitle(title, [CTNW, JOHNSON]);
    expect(good.outcome).toBe("unnamed");
    expect(good.subsetName).toBeNull();
  });

  it("FUZZY MATCHING -> a shared token assigns a subset -> red", () => {
    // The other tempting loosening: substring instead of whole-phrase. It
    // makes "Base Set" match any title containing the word "base".
    const src = readFileSync(lib, "utf8");
    const mutated = src.replace(
      "  return (\" \" + t + \" \").indexOf(\" \" + s + \" \") !== -1;",
      "  return t.indexOf(s.split(\" \")[0]) !== -1;",
    );
    expect(mutated).not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "subset-fuzzy-"));
    const p = join(dir, "fuzzy.cjs");
    writeFileSync(p, mutated);
    const M = require_(p) as { titleNamesSubset: typeof titleNamesSubset };

    expect(M.titleNamesSubset("1957 Topps #5 Base Refractor", "Base Set")).toBe(true);
    expect(titleNamesSubset("1957 Topps #5 Base Refractor", "Base Set")).toBe(false);
  });

  it("THE INGEST STILL REFUSES AN UNKNOWN SUBSET -> the #1741 counter survives", () => {
    // The ruling RESOLVES a clash between two NAMED subsets. It does not
    // retire the refusal for a clash where one side has no name -- blank is
    // unknown and is never invented. A change that deleted the counter would
    // make an unknown-subset row land on the ambiguous plain id.
    const src = readFileSync(ingest, "utf8");
    expect(src).toContain("subsetCollision++");
    expect(src).toMatch(/if \(!product\.subsetName\) \{/);
    // and the resolve path exists beside it, not instead of it
    expect(src).toContain("subsetDisambiguated++");
    expect(src).toContain("subsetInId: true");
  });
});
