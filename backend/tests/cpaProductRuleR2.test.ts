/**
 * D29/R2 -- the normalised identity key, and the two attributes it does NOT fold.
 *
 * R1 was refuted for REACH, not wrongness: it keyed on an EXACT parallelSlug
 * string, so the 2021 CPA-AM /499 rung arrived as three groups
 * (base-refractor / refractors-refractor / refractor) and every one of them
 * abstained "single-setkey". Measured over the declared scope, that key found
 * 1,506 fold groups and left 100,418 single-setkey abstains.
 *
 * Every slug and player below was read from card_catalog on 2026-08-30
 * (read-only). None is invented.
 *
 * The rulings in data/holding-identity-rulings.json stay pinned in
 * cpaProductRule.test.ts; R2 must not flip them.
 */
import { describe, expect, it } from "vitest";
import {
  decideCpaProduct,
  groupKey,
  printRunsAgree,
  sameCardNumber,
  type CpaRow,
} from "../src/services/catalog/cpaProductRule";
import { foldSpelling, chooseSpelling } from "../src/services/catalog/parallelSpellingFold";

const row = (o: Partial<CpaRow> & { setKey: string; source: string }): CpaRow => ({
  id: o.id ?? `hiq:baseball:2021:${o.setKey}:cpa-am:${o.parallelSlug ?? "refractor"}:auto`,
  playerName: o.playerName ?? null,
  printRun: o.printRun ?? null,
  parallelSlug: o.parallelSlug ?? null,
  ...o,
});

describe("groupKey -- one card, however the scrapers spelled it", () => {
  // THE PIN, read live from card_catalog 2026-08-30.
  it("puts the three 2021 CPA-AM /499 spellings in ONE group", () => {
    const rows = [
      { year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "base-refractor" },
      { year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractors-refractor" },
      { year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractor" },
    ];
    expect(new Set(rows.map(groupKey)).size).toBe(1);
  });

  it("is hyphen-insensitive on the card number (D23), reusing sameCardNumber's fold", () => {
    const a = groupKey({ year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractor" });
    const b = groupKey({ year: 2021, cardNumber: "cpaam", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractor" });
    expect(a).toBe(b);
    expect(sameCardNumber("CPA-AM", "cpaam")).toBe(true);
  });

  // The initials collision, still separated -- by the PLAYER half of the key.
  // CPA-AM really is both Alexander Mojica and Austin Martin (live, 2021).
  it("keeps two players who share an initials number in DIFFERENT groups", () => {
    const mojica = groupKey({ year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractor" });
    const martin = groupKey({ year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Austin Martin", parallelSlug: "refractor" });
    expect(mojica).not.toBe(martin);
  });

  it("never folds a bare colour into its refractor (D31)", () => {
    const gold = groupKey({ year: 2020, cardNumber: "CPA-RG", isAuto: true, playerName: "Riley Greene", parallelSlug: "gold" });
    const goldR = groupKey({ year: 2020, cardNumber: "CPA-RG", isAuto: true, playerName: "Riley Greene", parallelSlug: "gold-refractor" });
    expect(gold).not.toBe(goldR);
  });

  it("separates auto from no-auto and year from year", () => {
    const base = { cardNumber: "CPA-RG", playerName: "Riley Greene", parallelSlug: "refractor" };
    expect(groupKey({ ...base, year: 2020, isAuto: true })).not.toBe(groupKey({ ...base, year: 2021, isAuto: true }));
    expect(groupKey({ ...base, year: 2020, isAuto: true })).not.toBe(groupKey({ ...base, year: 2020, isAuto: false }));
  });
});

describe("decideCpaProduct -- the print run must AGREE (D31)", () => {
  // Riley Greene 2020 CPA-RG, read live: checklistcenter spells the /499 rung
  // `base-refractor` at bowman-chrome; a wiki row spells it `refractor`. Same
  // print run, one card -- this is the R2 population R1 could not reach.
  it("folds when the print runs agree", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Riley Greene", printRun: 499, parallelSlug: "base-refractor" }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Riley Greene", printRun: 499, parallelSlug: "refractor" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe("bowman-chrome");
  });

  // "one side un-numbered where the checklist numbers it" (D31) IS agreement.
  it("folds when one side is un-numbered and the checklist numbers it", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Riley Greene", printRun: 499, parallelSlug: "base-refractor" }),
      row({ setKey: "bowman", source: "bccp", playerName: "Riley Greene", printRun: null, parallelSlug: "refractor" }),
    ]);
    expect(d.kind).toBe("fold");
  });

  // THE REFUSAL. Two different /N are two cards; merging them would pool a
  // /50 Gold with a /499 Gold Refractor.
  it("abstains rather than merge two different print runs", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Riley Greene", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Riley Greene", printRun: 50, parallelSlug: "refractor" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("print-run-disagree");
  });

  it("treats /0 and NaN as no print run, not as a rival /N", () => {
    expect(printRunsAgree([row({ setKey: "a", source: "bccp", printRun: 0 }), row({ setKey: "b", source: "bccp", printRun: 499 })]).agree).toBe(true);
    expect(printRunsAgree([row({ setKey: "a", source: "bccp", printRun: Number.NaN }), row({ setKey: "b", source: "bccp", printRun: 499 })]).agree).toBe(true);
    expect(printRunsAgree([row({ setKey: "a", source: "bccp", printRun: 50 }), row({ setKey: "b", source: "bccp", printRun: 499 })]).agree).toBe(false);
  });

  // The gate guards a MERGE, so it sits after keep-both and after the
  // unspelled-key deferral -- neither of which merges anything.
  it("does not turn a genuine two-product conflict into a print-run abstain", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Pedro Gomez", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman-chrome-mega-box", source: "checklistinsider-2026-08-27", playerName: "Pedro Gomez", printRun: 250, parallelSlug: "refractor" }),
    ]);
    expect(d.kind).toBe("keep-both");
  });
});

describe("decideCpaProduct -- the surviving spelling (D31 majority-of-sources)", () => {
  it("the winner's row keeps the majority spelling among its checklist sources", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman-chrome", source: "checklistinsider-2026-08-27", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman-chrome", source: "beckett-checklist-2026-08-27", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractors-refractor" }),
      row({ setKey: "bowman", source: "bccp", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractor" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.spelling).toBe("refractor");
  });

  it("a tie among the checklist sources takes the LONGER form", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman-chrome", source: "beckett-checklist-2026-08-27", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "base-refractor" }),
      row({ setKey: "bowman", source: "bccp", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractor" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.spelling).toBe("base-refractor");
  });

  // The LOSING product's spelling never renames the winner's row. Two wiki
  // rows at `bowman` both say `base-cards-refractor` and are outnumbered on
  // raw strings, but they sit at the product that loses and they are not
  // checklist transcriptions -- neither fact gives them a vote.
  it("only rows AT the target vote on the spelling", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "base-cards-refractor" }),
      row({ setKey: "bowman", source: "bccp", playerName: "Alexander Mojica", printRun: 499, parallelSlug: "base-cards-refractor" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe("bowman-chrome");
    expect(d.spelling).toBe("refractor");
  });
});

describe("R2 mutation checks -- each new gate is load-bearing", () => {
  it("(d) a key that keeps the EXACT spelling cannot reach the CPA-AM population", () => {
    // MUTANT: R1's key -- the exact parallelSlug string.
    const r1Key = (r: { year: number; cardNumber: string; isAuto: boolean; parallelSlug: string }) =>
      [r.year, r.cardNumber, r.parallelSlug, r.isAuto ? "auto" : "no-auto"].join("|");
    const rows = [
      { year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "base-refractor" },
      { year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractors-refractor" },
      { year: 2021, cardNumber: "CPA-AM", isAuto: true, playerName: "Alexander Mojica", parallelSlug: "refractor" },
    ];
    expect(new Set(rows.map(r1Key)).size, "R1's key splits the one card three ways").toBe(3);
    expect(new Set(rows.map(groupKey)).size, "R2's key finds the one card").toBe(1);
  });

  it("(e) dropping the print-run gate merges a /50 with a /499", () => {
    const twoRuns = [
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Riley Greene", printRun: 499, parallelSlug: "refractor" }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Riley Greene", printRun: 50, parallelSlug: "refractor" }),
    ];
    // MUTANT: no print-run check -- one dedicated setKey, so it folds.
    const mutantIgnoresPrintRun = (rows: CpaRow[]) => {
      const ded = rows.filter((r) => /^(checklistcenter|checklistinsider|beckett)/.test(r.source));
      return new Set(ded.map((r) => r.setKey)).size === 1 && rows.some((r) => r.setKey !== ded[0]!.setKey) ? "fold" : "abstain";
    };
    expect(mutantIgnoresPrintRun(twoRuns)).toBe("fold");
    const real = decideCpaProduct(twoRuns);
    expect(real.kind).toBe("abstain");
    if (real.kind !== "abstain") throw new Error("unreachable");
    expect(real.why).toBe("print-run-disagree");
  });

  it("(f) a spelling fold that swallowed the colour would merge Gold with Gold Refractor", () => {
    // MUTANT: strip every trailing -refractor -- the Panini-Prizm-destroying rule.
    const mutantStripsRefractor = (s: string) => s.replace(/-?refractors?$/, "") || s;
    expect(mutantStripsRefractor("gold-refractor")).toBe(mutantStripsRefractor("gold"));
    expect(foldSpelling("gold-refractor")).not.toBe(foldSpelling("gold"));
  });

  it("(g) letting ROWS vote hands the spelling to the longest scrape", () => {
    const candidates = [
      ...Array.from({ length: 40 }, () => ({ parallelSlug: "refractors-refractor", source: "beckett-checklist-2026-08-27", isChecklist: true })),
      { parallelSlug: "refractor", source: "checklistcenter-2026-08-29", isChecklist: true },
      { parallelSlug: "refractor", source: "checklistinsider-2026-08-27", isChecklist: true },
    ];
    // MUTANT: count rows, not sources.
    const byRows = new Map<string, number>();
    for (const c of candidates) byRows.set(c.parallelSlug, (byRows.get(c.parallelSlug) ?? 0) + 1);
    const mutantWinner = [...byRows.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(mutantWinner).toBe("refractors-refractor");
    expect(chooseSpelling(candidates)).toBe("refractor");
  });
});
