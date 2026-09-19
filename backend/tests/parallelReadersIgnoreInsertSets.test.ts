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
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(backend, rel), "utf8");

/** Consumers that answer "is this a PARALLEL?" — they must ignore insert sets. */
const PARALLEL_ONLY_READERS = [
  "src/services/portfolioiq/bareColourAliasFromChecklist.ts",
  "src/services/portfolioiq/checklistSpellingAdoption.ts",
  "src/services/portfolioiq/parallelNameVocabulary.ts",
];

/**
 * Files that serve BOTH questions and therefore read both lists. Listing them
 * here is the point, not an exemption: each was checked, and each has a
 * global-vocabulary half that MUST see insert names.
 *
 *   rematch-finish-vocab.cjs        `global` tokens take the union;
 *                                   `namesByProduct` (the ladder) does not.
 *   statedFinishFromChecklist.ts    `finishWords` takes the union --
 *                                   `titleStatesAnUnconfirmedFinish` asks only
 *                                   whether the seller stated finish evidence
 *                                   AT ALL, never which rung. Its `byProduct`
 *                                   ladder still reads parallels alone.
 *
 * MEASURED: building `finishWords` from parallels alone made R55 stop parking
 * 4 of its 49 rows, because the only finish evidence in those titles was a
 * word that had moved into an insert name ("In the Action", "Heroes",
 * "Road To", "Rise"). Every one of those titles does state finish evidence.
 */
const BOTH_QUESTIONS_READERS = [
  "scripts/lib/rematch-finish-vocab.cjs",
  "src/services/portfolioiq/statedFinishFromChecklist.ts",
];

describe("the parallel readers ignore insertSets", () => {
  it.each(PARALLEL_ONLY_READERS)(
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
    // This one file legitimately reads both, because it serves two different
    // questions (see its header, TWO READERS TWO SOURCES):
    //
    //   global tokens   parallels[] UNION insertSets[]  -- is this word a finish?
    //   namesByProduct  parallels[] ONLY                -- is this a rung of
    //                                                      THIS product's base card?
    //
    // The LADDER index is the one that must stay parallels-only. The GLOBAL
    // token stream deliberately takes the union (Drew, 2026-09-18): a title
    // saying "Shadow" names a finish whichever list the corpus files the name
    // under, and building the tokens from parallels alone silently dropped
    // `framed`, `shadow` and `max` from the finish vocabulary entirely --
    // measured, 3 finish-class tokens of 524 that moved.
    //
    // So this pins the ONE thing that must not happen: an insert name
    // entering the per-product ladder. It deliberately does not police the
    // token stream, which is the other reader's job.
    const src = read("scripts/lib/rematch-finish-vocab.cjs");
    expect(src).toMatch(/insertNamesByProduct/);
    // Asserted on BEHAVIOUR, not on source text. A comment that merely NAMES
    // `namesByProduct` (this module's header does, to say it is excluded) is
    // not a write to it, and an earlier draft of this pin failed on exactly
    // that — matching documentation instead of code.
    //
    // The real invariant: for a product with insert sets, no insert name may
    // appear in the per-product LADDER, while its tokens MUST be in the
    // global finish vocabulary.
    const V = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs"));
    const built = V.buildVocabulary();
    const corpus = require_(path.join(backend, "data", "checklist-parallel-names.json"));
    let checked = 0;
    for (const prod of Object.values(corpus.products) as Array<Record<string, unknown>>) {
      const sets = (prod.insertSets ?? []) as Array<{ root?: string; children?: string[] }>;
      if (!sets.length) continue;
      const pk = V.productKey(prod.year, prod.setKey);
      const ladder: Set<string> | undefined = built.namesByProduct.get(pk);
      if (!ladder) continue;
      for (const set of sets) {
        for (const child of set.children ?? []) {
          const norm = String(child).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!norm) continue;
          // The ladder must not carry it...
          expect(ladder.has(norm),
            `insert name ${JSON.stringify(child)} leaked into the LADDER of ${pk}`).toBe(false);
          checked++;
        }
      }
      if (checked > 400) break;   // enough to prove the property, cheap to run
    }
    expect(checked, "the corpus must supply insert names to check").toBeGreaterThan(0);
    // ...and the global token vocabulary MUST carry the finish words that live
    // only inside insert names (Drew's ruling, 2026-09-18).
    for (const t of ["max", "shadow", "framed"]) {
      expect(built.global.has(t),
        `${t} is finish-class and must survive the split`).toBe(true);
    }
    // And the header must state both readers, so they are never re-conflated.
    expect(src).toContain("TWO READERS, TWO SOURCES");
  });

  it.each(BOTH_QUESTIONS_READERS)("%s serves BOTH questions and reads both lists", (file) => {
    // The mirror of the pin above. These files must keep reading insertSets,
    // because their GLOBAL half answers "is this word a finish" and a word
    // does not stop being one because the corpus refiled the name.
    const src = read(file);
    expect(src).toMatch(/\.parallels/);
    expect(src).toMatch(/insertSets/);
  });
  it("playerSegmentIsAPerson is the deliberate exception and reads BOTH", () => {
    // The opposite question: "is this slug segment a person?" Every corpus
    // name is evidence, and reading only parallels[] was #2223's CI red.
    const src = read("src/services/compiq/playerSegmentIsAPerson.ts");
    expect(src).toMatch(/\.parallels/);
    expect(src).toMatch(/insertSets/);
  });
});
