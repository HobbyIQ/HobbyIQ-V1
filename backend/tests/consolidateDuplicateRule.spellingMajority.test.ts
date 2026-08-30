/**
 * Rule 3 (Drew, 2026-08-30 12:50Z): the majority spelling among the CHECKLIST
 * SOURCES for that product wins; a tie goes to the LONGER form. The majority is
 * over DISTINCT PUBLISHERS -- a site that re-scraped four times is one
 * transcription, and letting scrape runs vote hands the ruling to whichever
 * site was scraped most often.
 *
 * The measurement predicts every outcome on the 89 measured baseball families
 * resolves to the LONG form, which is what the fleet's dry run is checked
 * against.
 */
import { describe, expect, it } from "vitest";
import { canonicalSpellingOf, type DupRow } from "../src/services/catalog/duplicateWinnerRule.js";

const r = (id: string, source: string, parallelSlug: string): DupRow => ({ id, source, parallelSlug });

describe("rule 3 -- majority over distinct publishers", () => {
  it("the majority spelling wins", () => {
    const rows = [
      r("a", "checklistcenter", "gold-refractor"),
      r("b", "checklistinsider", "gold-refractor"),
      r("c", "beckett", "gold"),
    ];
    expect(canonicalSpellingOf(rows)).toBe("gold-refractor");
  });

  it("a tie goes to the LONGER form", () => {
    const rows = [
      r("a", "checklistcenter", "gold"),
      r("b", "beckett", "gold-refractor"),
    ];
    expect(canonicalSpellingOf(rows)).toBe("gold-refractor");
  });

  it("ONE publisher does not get two votes from two scrape runs", () => {
    // checklistcenter says `gold` twice (two runs); beckett and checklistinsider
    // each say `gold-refractor` once. Per-PUBLISHER: 1 vs 2, long form wins.
    // Per-ROW or per-RUN it would be 2 vs 2, and only the tie-break would save
    // it -- so this asserts the vote is genuinely collapsed, using a case where
    // the two countings disagree on the WINNER, not merely on the margin.
    const rows = [
      r("a", "checklistcenter", "gold"),
      r("b", "checklistcenter-2026-08-29", "gold"),
      r("c", "checklistcenter-html", "gold"),
      r("d", "beckett", "gold-refractor"),
      r("e", "checklistinsider", "gold-refractor"),
    ];
    expect(canonicalSpellingOf(rows)).toBe("gold-refractor");
  });

  it("a derived row never votes while a checklist row is present", () => {
    const rows = [
      r("a", "ingest-auto-seed", "gold"),
      r("b", "ingest-auto-seed", "gold"),
      r("c", "sold-comps-stub", "gold"),
      r("d", "checklistcenter", "gold-refractor"),
    ];
    expect(canonicalSpellingOf(rows)).toBe("gold-refractor");
  });

  it("with no checklist row at all it still returns a spelling some row carries", () => {
    const rows = [r("a", "ingest-auto-seed", "gold"), r("b", "sold-comps-stub", "gold-refractor")];
    expect(["gold", "gold-refractor"]).toContain(canonicalSpellingOf(rows));
  });

  it("returns null when no row carries a spelling", () => {
    expect(canonicalSpellingOf([r("a", "checklistcenter", ""), r("b", "beckett", "")])).toBeNull();
  });

  it("is stable: the same rows in any order give the same answer", () => {
    const rows = [
      r("a", "checklistcenter", "orange"),
      r("b", "beckett", "orange-refractor"),
      r("c", "checklistinsider", "orange-refractor"),
      r("d", "tcdb", "orange"),
    ];
    const first = canonicalSpellingOf(rows);
    expect(canonicalSpellingOf([...rows].reverse())).toBe(first);
  });
});
