/**
 * RULE 3 AT THE DECISION LEVEL -- the rule the first build described but never
 * applied.
 *
 * Drew, 12:50Z: "the majority spelling among the checklist sources for that
 * product wins, tie -> the longer form." `canonicalSpellingOf` implemented the
 * majority correctly, was imported by the fleet, and was NEVER CALLED in any
 * decision path. The winner came from `rankRows`, whose last tie-break is
 * `String(b.id).length - String(a.id).length` -- Drew's TIE-BREAK promoted to
 * the whole rule.
 *
 * WHY THE OLD TESTS MISSED IT: all seven majority tests called
 * `canonicalSpellingOf` DIRECTLY; none called `decideDuplicateGroup`. And in
 * the measured population majority and longest COINCIDE (all 89 measured
 * baseball families resolve to the long form), so the dry-run counters could
 * not show it either -- the "verify output, not process" shape of #1177-#1180.
 *
 * So every test here goes through `decideDuplicateGroup` and asserts WHICH ROW
 * WON, not what a helper returned.
 */
import { describe, expect, it } from "vitest";
import {
  decideDuplicateGroup,
  canonicalSpellingOf,
  pickSpellingWinner,
  rankRows,
} from "../src/services/catalog/duplicateWinnerRule.js";

type Row = Parameters<typeof canonicalSpellingOf>[0][number];

const row = (o: Record<string, unknown>): Row => ({
  sport: "baseball",
  year: 2024,
  setKey: "bowman",
  cardNumber: "BCP-1",
  isAuto: false,
  printRun: null,
  playerName: "Test Player",
  ...o,
}) as Row;

const winnerSlug = (rows: Row[]): string | null => {
  const d = decideDuplicateGroup({ rows });
  return d.kind === "consolidate" ? String(d.winner.parallelSlug) : null;
};

describe("the MAJORITY spelling wins, whatever the id lengths are", () => {
  it("LIVE 4-to-1: four publishers spell `refractor`, beckett alone spells `refractors-refractor`", () => {
    // The refutation's live probe. The minority row's id is the LONGEST, which
    // is precisely what used to decide.
    const rows = [
      row({ id: "hiq:a:refractor", source: "checklistcenter-2026-08-29", parallelSlug: "refractor" }),
      row({ id: "hiq:b:refractor", source: "baseballcardpedia", parallelSlug: "refractor" }),
      row({ id: "hiq:c:refractor", source: "tcdb", parallelSlug: "refractor" }),
      row({ id: "hiq:d:refractor", source: "hobbymonitor", parallelSlug: "refractor" }),
      row({ id: "hiq:eeeeeeeeeeeeeeeeeeeeeeeeeeeeee:refractors-refractor", source: "beckett-checklist", parallelSlug: "refractors-refractor" }),
    ];
    expect(canonicalSpellingOf(rows)).toBe("refractor");
    expect(winnerSlug(rows)).toBe("refractor");
    // the mutation: the OLD selector picks the other row
    expect(String(rankRows(rows)[0].parallelSlug)).toBe("refractors-refractor");
  });

  it("THE CONTROLLED PAIR: same publisher vote, minority id padded longest -> majority still wins", () => {
    // Case B from the refutation. Two checklist publishers spell the long
    // form; the single dissenter's id is padded to be the longest in the
    // group. The old code returned the dissenter; the rule says the majority.
    const rows = [
      row({ id: "hiq:a", source: "checklistcenter", parallelSlug: "refractors-refractor" }),
      row({ id: "hiq:b", source: "checklistinsider", parallelSlug: "refractors-refractor" }),
      row({ id: "hiq:PADDEDPADDEDPADDEDPADDEDPADDEDPADDED", source: "beckett-checklist", parallelSlug: "refractor" }),
    ];
    expect(canonicalSpellingOf(rows)).toBe("refractors-refractor");
    expect(winnerSlug(rows)).toBe("refractors-refractor");
    expect(String(rankRows(rows)[0].parallelSlug)).toBe("refractor"); // the old answer
  });

  it("A MAJORITY ON THE SHORTER FORM STILL WINS (the case the measured population never contained)", () => {
    const rows = [
      row({ id: "hiq:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: "beckett-checklist", parallelSlug: "gold-refractors-refractor" }),
      row({ id: "hiq:b", source: "checklistcenter", parallelSlug: "gold-refractor" }),
      row({ id: "hiq:c", source: "checklistinsider", parallelSlug: "gold-refractor" }),
    ];
    expect(winnerSlug(rows)).toBe("gold-refractor");
  });

  it("A TIE GOES TO THE LONGER FORM (Drew's tie-break, now only a tie-break)", () => {
    const rows = [
      row({ id: "hiq:aaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: "checklistcenter", parallelSlug: "gold-refractor" }),
      row({ id: "hiq:b", source: "checklistinsider", parallelSlug: "gold-refractors-refractor" }),
    ];
    expect(canonicalSpellingOf(rows)).toBe("gold-refractors-refractor");
    expect(winnerSlug(rows)).toBe("gold-refractors-refractor");
  });

  it("TWO SCRAPE RUNS OF ONE SITE VOTE ONCE (a re-scrape must not out-vote another publisher)", () => {
    const rows = [
      row({ id: "hiq:a", source: "checklistcenter-2026-08-27", parallelSlug: "refractor" }),
      row({ id: "hiq:b", source: "checklistcenter-2026-08-29", parallelSlug: "refractor" }),
      row({ id: "hiq:c", source: "checklistcenter-2026-08-30", parallelSlug: "refractor" }),
      row({ id: "hiq:dddddddddddddddddddddddddd", source: "beckett-checklist", parallelSlug: "refractors-refractor" }),
    ];
    // one publisher each way -> a TIE -> the longer form, NOT the 3-row side
    expect(canonicalSpellingOf(rows)).toBe("refractors-refractor");
    expect(winnerSlug(rows)).toBe("refractors-refractor");
  });

  it("A DERIVED ROW DOES NOT VOTE, and does not win on a longer id", () => {
    const rows = [
      row({ id: "hiq:a", source: "checklistcenter", parallelSlug: "refractor" }),
      row({ id: "hiq:b", source: "checklistinsider", parallelSlug: "refractor" }),
      row({ id: "hiq:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", source: "ingest-auto-seed", parallelSlug: "refractors-refractor" }),
    ];
    expect(winnerSlug(rows)).toBe("refractor");
  });
});

describe("rule 3 does not overrule the rules above it", () => {
  it("r2 WINS: when the rows disagree about the print run, numbered decides, not spelling", () => {
    const rows = [
      row({ id: "hiq:a", source: "checklistcenter", parallelSlug: "refractor", printRun: 499 }),
      row({ id: "hiq:b", source: "ingest-auto-seed", parallelSlug: "refractors-refractor", printRun: null }),
    ];
    expect(pickSpellingWinner(rows)).toBeNull();
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
    expect(d.kind === "consolidate" && d.winnerBy).toBe("numbered");
    expect(d.kind === "consolidate" && String(d.winner.id)).toBe("hiq:a");
  });

  it("r6 STANDS DOWN RULE 3: an auto/no-auto disagreement is not a spelling question", () => {
    // The rows disagree about `isAuto`, so this group belongs to r6 (or to
    // rank order among equally-authoritative rows) -- never to the spelling
    // majority. `pickSpellingWinner` must refuse it outright, whichever row
    // ends up surviving.
    const rows = [
      row({ id: "hiq:auto", source: "checklistcenter", cardNumber: "CPA-MH", isAuto: true, parallelSlug: "refractor" }),
      row({ id: "hiq:ghostghostghostghostghost", source: "bccp", cardNumber: "CPA-MH", isAuto: false, parallelSlug: "base-refractor" }),
    ];
    expect(pickSpellingWinner(rows)).toBeNull();
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
    expect(d.kind === "consolidate" && d.winnerBy).not.toBe("spelling-majority");
    expect(d.kind === "consolidate" && d.winnerBy).not.toBe("canonical-spelling");
  });

  it("r6 WINS on its own shape: a DERIVED no-auto ghost folds onto the checklist auto row", () => {
    const rows = [
      row({ id: "hiq:auto", source: "checklistcenter", cardNumber: "CPA-MH", isAuto: true, parallelSlug: "refractor" }),
      row({ id: "hiq:ghostghostghostghostghost", source: "ingest-auto-seed", cardNumber: "CPA-MH", isAuto: false, parallelSlug: "refractor" }),
    ];
    expect(pickSpellingWinner(rows)).toBeNull();
    const d = decideDuplicateGroup({ rows });
    expect(d.kind === "consolidate" && d.winnerBy).toBe("no-auto-ghost");
    expect(d.kind === "consolidate" && String(d.winner.id)).toBe("hiq:auto");
  });

  it("r1 HOLDS: a checklist row still beats a derived row spelling it the same way", () => {
    const rows = [
      row({ id: "hiq:ck", source: "checklistcenter", parallelSlug: "refractor" }),
      row({ id: "hiq:derived-with-a-much-longer-id", source: "ingest-auto-seed", parallelSlug: "refractor" }),
      row({ id: "hiq:other", source: "checklistinsider", parallelSlug: "refractors-refractor" }),
    ];
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
    // whichever spelling wins, the survivor is a CHECKLIST row, never the seed
    expect(d.kind === "consolidate" && String(d.winner.source)).not.toBe("ingest-auto-seed");
  });

  it("a group where every row already spells the parallel the same way is not rule 3's", () => {
    const rows = [
      row({ id: "hiq:a", source: "checklistcenter", parallelSlug: "refractor" }),
      row({ id: "hiq:b", source: "ingest-auto-seed", parallelSlug: "refractor" }),
    ];
    expect(pickSpellingWinner(rows)).toBeNull();
  });
});

describe("the rule is LOAD-BEARING (mutation check)", () => {
  it("replacing the majority with rankRows flips the controlled pair", () => {
    const rows = [
      row({ id: "hiq:a", source: "checklistcenter", parallelSlug: "refractors-refractor" }),
      row({ id: "hiq:b", source: "checklistinsider", parallelSlug: "refractors-refractor" }),
      row({ id: "hiq:PADDEDPADDEDPADDEDPADDEDPADDEDPADDED", source: "beckett-checklist", parallelSlug: "refractor" }),
    ];
    const byMajority = pickSpellingWinner(rows);
    const byRank = rankRows(rows)[0];
    expect(byMajority).not.toBeNull();
    // The two selectors DISAGREE on this group -- which is what makes the
    // fix observable rather than a restatement.
    expect(String(byMajority?.id)).not.toBe(String(byRank.id));
    expect(String(byMajority?.parallelSlug)).toBe("refractors-refractor");
  });
});
