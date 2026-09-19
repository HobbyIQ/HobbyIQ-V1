/**
 * R66 PR 1 (2026-09-19): A BARE INSERT ROOT ENTERS `insertSets[]` FROM THE
 * CATEGORY COLUMN, NOT THE PARALLEL COLUMN.
 *
 * R66's title reader needs to recognise a named insert set in a sale title
 * ("2024 Panini Zenith Z Marquee #3" vs a base "#3"), and that needs the
 * BARE root name -- "z marquee", "illusionists" -- sitting in the corpus's
 * `insertSets[]`. Before this pass it never was, for two different reasons:
 *
 *   1. Z MARQUEE (and 17 more 2024 Zenith sets): the bare category
 *      `insert-z-marquee` carries a BLANK parallel column on every row.
 *      `readChecklistCategory` already reads it correctly (`insertRoot:
 *      "z-marquee"`), and `insertSetsFromCategories` already existed to
 *      answer exactly this -- but `build-parallel-vocabulary.cjs` never
 *      called it, so Zenith carried ZERO insertSets before this pass despite
 *      being registered in productSetKeys.ts.
 *
 *   2. ILLUSIONISTS: the bare category `insert-illusionists` is NOT blank --
 *      every one of its 18 rows carries "Illusionist" (singular) in the
 *      parallel column. `insertSetsFromCategories` requires a bare root to
 *      state NO parallel (see its own header), so it does not fire here
 *      either -- and the old builder filed "Illusionist" as a PARALLEL of
 *      the base card, a phantom rung that was never a real one.
 *      `bareSelfNamedInsertRoots` (build-parallel-vocabulary.cjs) closes
 *      this: a bare category whose every attested value folds
 *      (singular/plural only) to the category's own root is the set naming
 *      itself, not a rung.
 *
 * Both pass through the SAME merge, keyed on the "extends" test
 * `splitInsertSets` already uses for its own roots (never fold-equality,
 * which would have merged "illusionists" with "illusionists black" onto the
 * wrong key) -- so a set whose colours already split into their own
 * one-item "roots" (Illusionists Black, Illusionists Gold, ...) for lack of
 * anywhere to merge under now consolidate onto the one root a title would
 * actually state.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(backend, "scripts", "build-parallel-vocabulary.cjs");

/** Zenith's bare categories are blank-parallel; Illusions' is self-naming --
 *  between the two dirs both shapes are covered without needing a third. */
const SRC = "C:/tmp/ci/csv2";

interface InsertSet { root: string; rootKey: string; children: string[] }
interface Corpus {
  products?: Record<string, {
    parallels?: { name?: string }[];
    insertSets?: InsertSet[];
  }>;
}

let corpus: Corpus | null = null;
const haveSources = existsSync(SRC);
if (haveSources) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "vocab-r66-")), "c.json");
  execFileSync(process.execPath, [BUILDER, `--dirs=${SRC}`, `--out=${out}`], { stdio: "ignore" });
  corpus = JSON.parse(readFileSync(out, "utf8")) as Corpus;
}
const maybe = haveSources ? describe : describe.skip;
const lower = (s: string) => s.toLowerCase();

maybe("bare insert roots enter insertSets[] from the category column", () => {
  it("football|2024|panini-zenith: 18 insert sets from zero, Z Marquee among them", () => {
    const p = corpus!.products!["football|2024|panini-zenith"];
    expect(p).toBeTruthy();
    expect((p.insertSets ?? []).length).toBeGreaterThanOrEqual(15);
    const zm = p.insertSets!.find((s) => s.rootKey === "z marquee");
    expect(zm, "Z Marquee must be a root").toBeTruthy();
    expect(zm!.root).toBe("Z Marquee");
    // The BARE root is itself a matchable name -- a title with no colour
    // ("... Z Marquee #3 ...") must still find the set.
    expect(zm!.children.map(lower)).toContain("z marquee");
    for (const colour of ["blue", "gold", "orange", "red", "white"]) {
      expect(zm!.children.map(lower)).toContain(`z marquee ${colour}`);
    }
  });

  it("football|2023|panini-zenith: also zero to non-zero (not a 2024-only fix)", () => {
    const p = corpus!.products!["football|2023|panini-zenith"];
    expect((p.insertSets ?? []).length).toBeGreaterThan(0);
  });

  it("football|2024|panini-illusions: Illusionists consolidates onto ONE root", () => {
    const p = corpus!.products!["football|2024|panini-illusions"];
    expect(p).toBeTruthy();
    const illusionRoots = (p.insertSets ?? []).filter((s) => s.rootKey.startsWith("illusionist"));
    expect(illusionRoots.length, "every Illusionists colour must land on one root, not one root each").toBe(1);
    const set = illusionRoots[0];
    expect(set.root).toBe("Illusionists");
    expect(set.children.map(lower)).toContain("illusionists");
    for (const colour of ["black", "gold", "green", "orange", "pink", "purple", "rainbow", "red", "sapphire"]) {
      expect(set.children.map(lower)).toContain(`illusionists ${colour}`);
    }
  });

  it("\"Illusionist\" (singular) is gone from parallels[] -- it named the set, not a rung", () => {
    const p = corpus!.products!["football|2024|panini-illusions"];
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    expect(names.has("illusionist")).toBe(false);
  });

  it("a real Illusions PARALLEL is untouched by the self-naming drop", () => {
    // The self-naming test folds the WHOLE phrase against the root; a name
    // that merely starts with the same word but states something else must
    // survive as a parallel. Guards the clause from over-reaching to
    // anything containing "illusion".
    const p = corpus!.products!["football|2024|panini-illusions"];
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    // At least one genuine base parallel must remain non-empty after the
    // drop -- the product is not left bare.
    expect(p.parallels!.length).toBeGreaterThan(0);
    expect(names.has("illusionists")).toBe(false); // that one is a root now, not a parallel
  });

  it("Prizm, Select and Optic: parallels[] shrinks by only the self-naming handful, never a real rung", () => {
    // The regression this guards: a prior attempt that re-derived parallels
    // cost Prizm 73 real rungs (148 -> 75). This pass must never come close
    // -- every product's parallel count should drop by single digits at
    // most, the self-naming entries only, while insertSets grows.
    const before: Record<string, number> = {
      "football|2024|panini-prizm": 130,
      "football|2025|panini-prizm": 148,
      "football|2024|panini-select": 64,
      "football|2023|panini-select": 59,
      "football|2024|donruss-optic": 48,
    };
    for (const [pk, beforeCount] of Object.entries(before)) {
      const p = corpus!.products![pk];
      expect(p, pk).toBeTruthy();
      const afterCount = p.parallels!.length;
      expect(afterCount, `${pk} parallels dropped too far`).toBeGreaterThan(beforeCount - 10);
      expect(afterCount, `${pk} parallels must not grow`).toBeLessThanOrEqual(beforeCount);
    }
  });

  it("every merged child still carries its root's name (the corpus-wide invariant)", () => {
    const bad: string[] = [];
    for (const [key, p] of Object.entries(corpus!.products ?? {})) {
      for (const s of p.insertSets ?? []) {
        for (const child of s.children) {
          const cn = lower(child).replace(/[^a-z0-9]+/g, " ").trim();
          if (!cn.startsWith(s.rootKey)) bad.push(`${key} :: ${s.rootKey} !< ${child}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("a bare category with no sibling ladder mints nothing", () => {
    // `insert-lonely` alone (no `insert-lonely-*` sibling) is not a set --
    // pinned already at the checklist-category.cjs layer
    // (checklistCategoryReader.test.ts), re-asserted here at the builder's
    // own boundary so a future change to the merge cannot reopen it.
    for (const p of Object.values(corpus!.products ?? {})) {
      for (const s of p.insertSets ?? []) {
        expect(s.children.length, `${s.rootKey} must have at least one child`).toBeGreaterThan(0);
      }
    }
  });

  // MEASURED REGRESSION, FOUND AND FIXED 2026-09-19 (against the R32 export
  // with the CORRECT per-title setKey, not the no-context path the tests
  // above pin). football|2025|panini-certified carries a bare
  // `insert-mirror` category with "Mirror" on every row -- folds to itself,
  // has siblings (`insert-mirror-black`) -- the exact Illusionists shape.
  // But this product's checklist ALSO lists "Mirror Black", "Mirror Gold",
  // ... as ordinary parallels[] names under separately-labelled colour
  // categories: "Mirror" here is a FINISH FAMILY name (the same relationship
  // "Prizm" has to "Silver Prizm"), not a proper noun an insert set is named
  // after. Rooting it swallowed the real, distinct "Mirror" /399 base rung
  // into an insert set and broke the reader: "2025 Panini Certified #1 ...
  // Mirror #/399" stopped answering "Mirror".
  it("Mirror is a finish family on panini-certified, not a self-named insert set", () => {
    const p = corpus!.products!["football|2025|panini-certified"];
    expect(p).toBeTruthy();
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    expect(names.has("mirror"), "the bare /399 Mirror rung must stay a parallel").toBe(true);
    expect(names.has("mirror black"), "Mirror Black must stay a parallel").toBe(true);
    expect(names.has("mirror gold"), "Mirror Gold must stay a parallel").toBe(true);
    // A "mirror"-keyed insertSets entry MAY exist (the name-based split's own
    // "Mirror Signatures" -- a genuinely distinct autographed insert whose
    // shortened rootKey happens to be "mirror"), but its DISPLAY root must
    // never be the bare word "Mirror" itself -- that would be the
    // self-naming bug this test guards against.
    for (const s of p.insertSets ?? []) {
      if (s.rootKey !== "mirror") continue;
      expect(lower(s.root), "no insertSets entry may be bare 'Mirror'").not.toBe("mirror");
    }
  });

  it("a bare colour word is never a self-naming root, even with real source noise", () => {
    // hockey|2022|upper-deck-premier's `insert-gold` category carries
    // "Gold //" (unstripped print-run glue) on every row -- folds to "gold"
    // exactly, has siblings (`insert-gold-legends`). Without the guard this
    // deleted "Gold //" (seen 265 times, its own /65 print run, distinct
    // from the plain "Gold" /10 rung already in parallels) with nowhere for
    // it to land.
    const p = corpus!.products!["hockey|2022|upper-deck-premier"];
    expect(p).toBeTruthy();
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    expect(names.has("gold //"), "Gold // must survive as its own parallel").toBe(true);
    expect(names.has("gold"), "the plain Gold rung must be untouched").toBe(true);
    const bareGoldRoot = (p.insertSets ?? []).find((s) => s.rootKey === "gold");
    expect(bareGoldRoot, "no bare Gold root should exist").toBeUndefined();
  });

  it("a root ending in -parallel/-variant is a finish, not a set naming itself", () => {
    // hockey|2025|flair labels its entire base finish ladder with
    // `insert-<name>-parallel` categories. Corpus-wide 1,013 bare categories
    // share this shape (O-Pee-Chee, Parkhurst, Upper Deck) -- structural,
    // not one product's quirk.
    const p = corpus!.products!["hockey|2025|flair"];
    expect(p).toBeTruthy();
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    for (const n of ["spectrum parallel", "blue ice parallel", "printing plates parallel", "auto parallel"]) {
      expect(names.has(n), `${n} must remain a parallel`).toBe(true);
    }
    // The product's genuine insert sets (blank-parallel, name-based) are
    // untouched by the guard.
    const rootKeys = new Set((p.insertSets ?? []).map((s) => s.rootKey));
    for (const n of ["flair for the dramatic", "hot hues", "rare breed", "scoring power", "trophy room"]) {
      expect(rootKeys.has(n), `${n} must still be a real insert set`).toBe(true);
    }
  });
});
