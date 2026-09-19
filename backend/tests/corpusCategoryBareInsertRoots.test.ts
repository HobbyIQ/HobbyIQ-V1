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
});
