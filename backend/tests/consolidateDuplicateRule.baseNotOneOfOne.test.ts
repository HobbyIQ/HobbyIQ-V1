/**
 * A BASE CARD IS NOT A 1/1 -- the regression for a defect caught in a LIVE dry
 * run on 2026-08-30, after it had already moved 190 real sales.
 *
 * 2024 Panini Prizm #347 (Jayden Daniels RC) carries two base rows:
 *
 *   ...:347:base:no-auto          beckett-scraped-2026-08-26   un-numbered, 190 sales
 *   ...:347:base:no-auto:num-1    checklistinsider-2026-08-28  /1, 0 sales
 *
 * Rule 2 ("numbered beats un-numbered") folded the genuine base card onto the
 * /1 and carried 190 ordinary base sales ($24-$136) with it. A real 1/1 Daniels
 * rookie is worth thousands; the fold corrupts that identity's FMV in the
 * EXPENSIVE direction -- the same shape as the Finest #197 merge D31 prevents.
 *
 * Panini Prizm's genuine 1/1s are NAMED parallels (black-finite, choice-nebula,
 * gold-vinyl). Those must keep folding normally, so the guard is scoped to a
 * parallel slug that is literally `base` (or empty), never to /1 as such.
 */
import { describe, expect, it } from "vitest";
import {
  decideDuplicateGroup,
  baseCardCannotBeOneOfOne,
  type DupRow,
} from "../src/services/catalog/duplicateWinnerRule.js";

const prizm = (over: Partial<DupRow> & { id: string }): DupRow => ({
  sport: "football",
  year: 2024,
  setKey: "panini-prizm",
  cardNumber: "347",
  isAuto: false,
  playerName: "Jayden Daniels",
  parallelSlug: "base",
  ...over,
});

describe("the live case: 2024 panini-prizm #347", () => {
  const rows = [
    prizm({ id: "hiq:football:2024:panini-prizm:347:base:no-auto", source: "beckett-scraped-2026-08-26", printRun: null, salesCount: 190 }),
    prizm({ id: "hiq:football:2024:panini-prizm:347:base:no-auto:num-1", source: "checklistinsider-2026-08-28", printRun: 1 }),
  ];

  it("is detected as a base card that cannot be a 1/1", () => {
    expect(baseCardCannotBeOneOfOne(rows)).toBe(true);
  });

  it("is AMBIGUOUS, not a fold -- the 190 sales stay put", () => {
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.detail).toMatch(/base card is not a 1\/1/);
  });

  it("MUTATION: without the guard this group folds -- proving the guard is load-bearing", () => {
    // The same two rows with the /1 replaced by a plausible base print run fold
    // normally. Only the "/1 on a base card" fact changes the outcome.
    const plausible = [
      prizm({ id: "a", source: "beckett-scraped-2026-08-26", printRun: null }),
      prizm({ id: "b", source: "checklistinsider-2026-08-28", printRun: 199 }),
    ];
    expect(baseCardCannotBeOneOfOne(plausible)).toBe(false);
    expect(decideDuplicateGroup({ rows: plausible }).kind).toBe("consolidate");
  });
});

describe("the guard is narrow -- real 1/1 parallels still fold", () => {
  it("a NAMED /1 parallel is untouched (black-finite, choice-nebula, gold-vinyl)", () => {
    for (const slug of ["black-finite", "choice-nebula", "gold-vinyl", "stars-black"]) {
      const rows = [
        prizm({ id: `hiq:...:${slug}:no-auto`, source: "ingest-auto-seed", parallelSlug: slug, printRun: null }),
        prizm({ id: `hiq:...:${slug}:no-auto:num-1`, source: "checklistinsider-2026-08-27", parallelSlug: slug, printRun: 1 }),
      ];
      expect(baseCardCannotBeOneOfOne(rows)).toBe(false);
      expect(decideDuplicateGroup({ rows }).kind).toBe("consolidate");
    }
  });

  it("a base row at a PLAUSIBLE print run still folds", () => {
    const rows = [
      prizm({ id: "a", source: "ingest-auto-seed", printRun: null }),
      prizm({ id: "b", source: "checklistinsider-2026-08-27", printRun: 25 }),
    ];
    expect(baseCardCannotBeOneOfOne(rows)).toBe(false);
  });

  it("an EMPTY parallel slug counts as base", () => {
    const rows = [
      prizm({ id: "a", source: "beckett", parallelSlug: "", printRun: null }),
      prizm({ id: "b", source: "checklistinsider", parallelSlug: "", printRun: 1 }),
    ];
    expect(baseCardCannotBeOneOfOne(rows)).toBe(true);
  });

  it("needs BOTH a /1 base row and an un-numbered base row", () => {
    // A lone /1 base row with no un-numbered rival is not this defect.
    const onlyOne = [
      prizm({ id: "a", source: "checklistinsider", printRun: 1 }),
      prizm({ id: "b", source: "beckett", printRun: 1 }),
    ];
    expect(baseCardCannotBeOneOfOne(onlyOne)).toBe(false);
  });
});
