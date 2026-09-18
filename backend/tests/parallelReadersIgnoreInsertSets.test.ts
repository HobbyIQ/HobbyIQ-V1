/**
 * §3c — A PARALLEL READER READS `parallels[]`, NEVER `insertSets[]`.
 *
 * The corpus gives each product two lists, and they mean different things:
 *
 *   parallels[]   the FINISHES of a card that already exists. "Silver Prizm"
 *                 is a printing of card #6, not a different card.
 *   insertSets[]  named runs of CARDS with their own numbering. "Rookie Phenom
 *                 Jerseys #6" is a different card from the flagship's #6.
 *
 * Every consumer that answers "is this string a parallel of this product?"
 * must therefore read `parallels[]` ALONE. Folding insert names in would let a
 * title naming an insert set look like a stated finish, and the row would be
 * written to the flagship card with the insert's name as its parallel — one
 * card's sale filed against another card's pool.
 *
 * The one deliberate exception is `playerSegmentIsAPerson`, which asks the
 * opposite question — "is this string ANY corpus name?" — to decide whether a
 * slug segment is a person. Every corpus name is evidence there, insert names
 * included, and reading only `parallels[]` was a real defect (#2223's CI red).
 *
 * This pins the split by SOURCE TEXT rather than behaviour, because the defect
 * is one of omission: a reader that starts consuming `insertSets` does not
 * fail any existing assertion, it just quietly starts answering a different
 * question.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(backend, rel), "utf8");

/** Consumers that answer "is this a PARALLEL?" — they must ignore insert sets. */
const PARALLEL_ONLY_READERS = [
  "scripts/lib/rematch-finish-vocab.cjs",
  "src/services/portfolioiq/statedFinishFromChecklist.ts",
  "src/services/portfolioiq/bareColourAliasFromChecklist.ts",
  "src/services/portfolioiq/checklistSpellingAdoption.ts",
  "src/services/portfolioiq/parallelNameVocabulary.ts",
];

describe("the parallel readers ignore insertSets", () => {
  it.each(PARALLEL_ONLY_READERS.filter((f) => !f.endsWith("rematch-finish-vocab.cjs")))(
    "%s reads parallels[] and never insertSets[]",
    (file) => {
      const src = read(file);
      expect(src, `${file} must read the corpus's parallels`).toMatch(/\.parallels/);
      expect(src.match(/insertSets/g) ?? [],
        `${file} answers "is this a PARALLEL?" — an insert set is a different `
        + `KIND of thing (its own run of cards), and folding it in would let an `
        + `insert name read as a stated finish`).toEqual([]);
    },
  );

  it("rematch-finish-vocab reads insertSets ONLY for the insert-set lookup", () => {
    // This one file legitimately reads both, because it serves both questions.
    // What must stay true is that the insert names land in their OWN index and
    // never in the parallel-name or token indexes.
    const src = read("scripts/lib/rematch-finish-vocab.cjs");
    expect(src).toMatch(/insertNamesByProduct/);
    // The insert loop must not feed the parallel structures.
    const loop = src.slice(src.indexOf("THE NAMED INSERT SETS OF THIS PRODUCT"));
    const body = loop.slice(0, loop.indexOf("\n    }") + 6);
    for (const forbidden of ["namesByProduct", "bucket.add", "phrases.add", "seenHere"]) {
      expect(body,
        `the insert-set loop must not write to ${forbidden} — insert names are `
        + `not parallel names and must never enter the finish vocabulary`)
        .not.toContain(forbidden);
    }
  });

  it("playerSegmentIsAPerson is the deliberate exception and reads BOTH", () => {
    // The opposite question: "is this slug segment a person?" Every corpus
    // name is evidence, and reading only parallels[] was #2223's CI red.
    const src = read("src/services/compiq/playerSegmentIsAPerson.ts");
    expect(src).toMatch(/\.parallels/);
    expect(src).toMatch(/insertSets/);
  });
});
