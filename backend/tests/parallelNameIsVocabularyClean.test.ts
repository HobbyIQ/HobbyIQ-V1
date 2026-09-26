/**
 * CF-A-PARALLEL-NAME-IS-A-NAME-THE-CHECKLIST-SPELLS (post-wave audit,
 * 2026-09-15).
 *
 * The 1,300-row post-wave identity audit's third-largest sports CONFLICT
 * pattern -- 66 rows -- is "parallel garbled or truncated by the deriver: the
 * deriver keeps a parallel but mangles the name, sometimes into something that
 * is not a parallel at all". Every title in this file is a REAL pool row taken
 * verbatim from `audit-postwave-sample-2026-09-15.jsonl`, and every "before"
 * value below was reproduced against the live parser on main 2ac329a9 before
 * the fix -- not predicted from the report's prose.
 *
 * THE TWO SHAPES, AND WHERE EACH CAME FROM
 *
 *   LEAK        `bareColourAliasFromChecklist` read the corpus's raw `name`
 *               field, which a checklist prints WITH its pack odds on the same
 *               line. `statedFinishFromChecklist` has always stripped that tail
 *               before indexing (`stripOddsTail`), so it never leaked; the
 *               defect was that the rule lived inside one module while a second
 *               reader of the same file re-read the raw names.
 *
 *   TRUNCATION  A hand regex in `parseTitleIdentity.service.ts` matched
 *               `rose gold` + `mini` and answered "Rose Gold Mini" -- the first
 *               two words of `Rose Gold Mini-Diamond Refractor`, and a card
 *               that does not exist.
 *
 * THE INVARIANT, stated once: every parallel this pipeline writes must be a
 * name the checklist corpus actually spells. Never a fragment of one (that is
 * a new, wrong, confident address that splits a comp pool) and never a name
 * plus the odds at which you pull it (the odds belong to the pack).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  cleanParallelName,
  stripParallelAnnotation,
  isVocabularyParallelName,
  _resetParallelNameVocabulary,
} from "../src/services/portfolioiq/parallelNameVocabulary";
import {
  bareColourAliasFromChecklist,
  _resetBareColourAliasMap,
} from "../src/services/portfolioiq/bareColourAliasFromChecklist";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";
import { _resetStatedFinishCorpus } from "../src/services/portfolioiq/statedFinishFromChecklist";

beforeEach(() => {
  _resetParallelNameVocabulary();
  _resetBareColourAliasMap();
  _resetStatedFinishCorpus();
});

// ---------------------------------------------------------------------------
// THE AUDIT'S OWN ROWS, THROUGH THE WHOLE PARSER
// ---------------------------------------------------------------------------
describe("the audit's garbled parallels, end to end", () => {
  it.each([
    // [title, setKey, year, what the parser answered BEFORE, what it must answer now]
    [
      "2024 Topps Update Baseball #US294 Yellow",
      "topps-update-series", 2024,
      "Yellow - 1:1 Hanger EA;", "Yellow",
    ],
    [
      "2025 Topps Update Baseball #US319 Pink Diamante Foil",
      "topps-update-series", 2025,
      "Pink Diamante Foil - Hanger exclusive", "Pink Diamante Foil",
    ],
    [
      "2023 Topps Chrome Platinum Baseball #250 Rose Gold Mini-Diamond Refractor",
      "topps-chrome-platinum", 2023,
      "Rose Gold Mini", "Rose Gold Mini-Diamond Refractor",
    ],
  ])("%s", (title, setKey, year, before, want) => {
    const got = parseListingIdentity(title, undefined, {
      setKey: setKey as string,
      year: year as number,
    }).parallel;
    expect(got).toBe(want);
    // MUTATION CHECK: the test must fail if the fix is reverted. Asserting the
    // new value alone would also pass against a parser that answered "Base",
    // which is a different defect and not a fix for this one.
    expect(got).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// THE CLEANER ITSELF
// ---------------------------------------------------------------------------
describe("cleanParallelName", () => {
  it("strips a pack-odds tail introduced by a dash and a ratio", () => {
    expect(stripParallelAnnotation("Yellow - 1:1 Hanger EA;")).toBe("Yellow");
    expect(stripParallelAnnotation("Refractor - 1:1 Jumbo;")).toBe("Refractor");
    expect(stripParallelAnnotation("Negative Refractor - 1:89 Hobby; 1:27 Jumbo;"))
      .toBe("Negative Refractor");
  });

  it("strips a dash tail that names a pack even with no ratio in it", () => {
    expect(stripParallelAnnotation("Pink Diamante Foil - Hanger exclusive"))
      .toBe("Pink Diamante Foil");
  });

  it("strips a trailing parenthetical that names a pack", () => {
    expect(cleanParallelName("Yellow (Hanger exclusive)")).toBe("Yellow");
    expect(cleanParallelName("X-Fractor (Hobby exclusive)")).toBe("X-Fractor");
  });

  it("KEEPS a dash tail that is part of the rung's own name", () => {
    // `red` and `ink` are not pack words, so the tail is the CARD. Red Ink is
    // its own card (Drew, 2026-08-30) and must never be trimmed to its prefix.
    expect(stripParallelAnnotation("Black & White - Red Ink"))
      .toBe("Black & White - Red Ink");
  });

  it("REFUSES a fragment rather than answering a different real card", () => {
    // The corpus lists `Rose Gold` and `Rose Gold Mini-Diamond Refractor` but
    // never a bare `Rose Gold Mini`. Answering the listed PREFIX here would be
    // confidently wrong -- a different rung, a different price curve -- so the
    // honest answer is none. Absent beats wrong.
    expect(cleanParallelName("Rose Gold Mini")).toBeNull();
    expect(isVocabularyParallelName("Rose Gold Mini")).toBe(false);
  });

  it("never invents: a name no checklist spells has no answer", () => {
    expect(cleanParallelName("Definitely Not A Parallel Xyzzy")).toBeNull();
  });

  it("has no opinion about empty input", () => {
    expect(cleanParallelName("")).toBeNull();
    expect(cleanParallelName(null)).toBeNull();
    expect(cleanParallelName(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE PROPERTY, OVER THE WHOLE SHIPPED CORPUS
//
// Every parallel row the shipped corpus carries. This is the guard that keeps
// the cleaner from being a hand list: every name the corpus carries must
// resolve, and its cleaned form must be a FIXED POINT -- cleaning twice is
// cleaning once. A rule that mangled any real rung would show up here as a
// null or an unstable round-trip, not as a reviewer noticing.
//
// THE COUNT IS DERIVED, NOT PINNED. It was a literal 37,849, which made every
// checklist acquisition that adds a rung fail this file for arithmetic rather
// than for a defect -- #2200 added three 2025 Allen & Ginter mini rungs and
// tripped it at 37,852 while `unresolved` and `unstable` both stayed empty,
// i.e. the property held and only the bookkeeping number moved.
//
// The count still earns its place: it is checked against the corpus's OWN
// declared parallelNameCount, so a truncated or mis-shaped read (which would
// walk zero names and pass both list assertions vacuously) still fails here.
// ---------------------------------------------------------------------------
describe("every checklist name round-trips to itself", () => {
  it("resolves every corpus name, and each answer is a fixed point", () => {
    const raw = JSON.parse(
      readFileSync("data/checklist-parallel-names.json", "utf8"),
    ) as {
      parallelNameCount?: number;
      products?: Record<string, { parallels?: { name?: string }[] }>;
    };

    let total = 0;
    const unresolved: string[] = [];
    const unstable: string[] = [];

    for (const product of Object.values(raw.products ?? {})) {
      // THE CLEANER OWNS `parallels[]`, AND ONLY THAT.
      //
      // Since the insert-set split (2026-09-15) a product also carries
      // `insertSets[].children`. Those are deliberately NOT walked here.
      // The cleaner normalises against the corpus's own PARALLEL
      // vocabulary, so an insert-set name ("Home Run Hysteria") has nothing
      // to resolve to and would be reported unresolved -- a false alarm
      // about names the cleaner was never responsible for. Measured:
      // widening this walk reported 20 such names, every one an insert root.
      const everyName = (product.parallels ?? []).map((x) => String(x.name ?? "").trim());
      for (const name of everyName) {
        if (!name) continue;
        total++;
        const cleaned = cleanParallelName(name);
        if (cleaned === null) {
          if (unresolved.length < 20) unresolved.push(name);
          continue;
        }
        if (cleanParallelName(cleaned) !== cleaned) {
          if (unstable.length < 20) unstable.push(`${name} -> ${cleaned}`);
        }
      }
    }

    // The corpus states its own size; the walk must agree with it, and must
    // have walked a real corpus rather than an empty one.
    //
    // `parallelNameCount` counts the emitted `parallels[]` rows only, so the
    // walk (which also covers insert children) is >= it. The floor is kept as
    // a "this is a real corpus, not an empty read" guard and is stated against
    // the TOTAL, which the split does not change.
    expect(total).toBe(raw.parallelNameCount);
    // A FLOOR, NOT A PIN: the point is that a real corpus was walked rather
    // than an empty read. It dropped from 37,000 to 15,000 when the
    // insert-set split (2026-09-15) moved 22,804 insert names out of
    // `parallels[]` into `insertSets[]` -- the names still exist and are
    // still asserted, by corpusInsertSetsAreNotParallels; they are simply
    // not the cleaner`s population any more.
    expect(total).toBeGreaterThan(14_000);
    expect(unresolved).toEqual([]);
    expect(unstable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE LEAK SITE
// ---------------------------------------------------------------------------
describe("bareColourAliasFromChecklist answers a clean name", () => {
  it.each([
    ["2024 Topps Update Baseball #US294 Yellow", "topps-update-series", 2024, "Yellow"],
    // "Pink" on 2025 topps-update-series is a GENUINE TIE, not a spelling
    // gap (2026-09-25 corpus rebuild): the checklist attests BOTH "Pink
    // Diamante Foil" (a Hanger exclusive) and "Pink Holo Foil" (a Retail
    // exclusive, limited to 800) -- both real, distinct cards, both exactly
    // three words after cleaning. colourMapForProduct's own tie-detector
    // (bareColourAliasFromChecklist.ts) correctly refuses to pick between
    // them, the same tie-refusal this module documents for every other
    // ambiguous colour. Verified against the raw checklist CSV, not
    // asserted from prose.
    ["2025 Topps Update Baseball #US319 Pink Diamante Foil", "topps-update-series", 2025, null],
  ])("%s", (title, setKey, year, want) => {
    expect(bareColourAliasFromChecklist(title as string, {
      setKey: setKey as string,
      year: year as number,
    })).toBe(want);
  });

  it("never answers a string carrying odds punctuation", () => {
    // The shape of the defect, asserted as a shape rather than a list: no
    // answer this module gives may carry a semicolon, a pack ratio or a
    // dash-introduced annotation.
    for (const [title, setKey, year] of [
      ["2024 Topps Update Baseball #US294 Yellow", "topps-update-series", 2024],
      ["2025 Topps Update Baseball #US319 Pink Diamante Foil", "topps-update-series", 2025],
    ] as [string, string, number][]) {
      const got = bareColourAliasFromChecklist(title, { setKey, year });
      if (got === null) continue;
      expect(got).not.toMatch(/[;]/);
      expect(got).not.toMatch(/\d+\s*:\s*\d+/);
      expect(got).not.toMatch(/\b(hanger|blaster|jumbo|exclusive)\b/i);
    }
  });
});
