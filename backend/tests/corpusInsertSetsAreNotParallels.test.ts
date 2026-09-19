/**
 * AN INSERT SET IS NOT A PARALLEL (2026-09-15).
 *
 * `build-parallel-vocabulary.cjs` read column 2 (`parallel`) of every source
 * CSV and never looked at column 0 (`category`) — so a product's INSERT SETS
 * landed in `parallels[]` indistinguishably from its real rungs.
 * `football|2024|donruss-optic` listed "Passing Grade", "My House!" and
 * "Light it Up" as parallels of the base card, and R31's phrase test —
 * correctly, against the data it was given — answered "yes, that is a rung of
 * this product" and filled blanks with them.
 *
 * Corpus-wide fingerprint: 1,350 named roots over 10,719 rungs (28.3%) across
 * 206 of 627 products.
 *
 * THE SIGNAL WAS ALWAYS THERE. Measured across all 1,100 CSVs in all three
 * source dirs (2,197,970 rows): 100% carry `category`, and its prefix
 * vocabulary is exactly `base` / `insert` / `auto`.
 *
 * WHY NOT "DROP EVERY INSERT ROW". Inserts have their own colour ladders, so a
 * colour rung legitimately appears under an insert category — 32 of Optic
 * 2024's 178 names appear under more than one category, "Purple", "Gold",
 * "Ice" and "Gold Vinyl" among them. Dropping insert rows wholesale would
 * delete real rungs: the opposite defect, and worse. The distinguishing fact
 * is whether the NAME carries the insert set's own name.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(backend, "scripts", "build-parallel-vocabulary.cjs");

/** The one source dir that carries Optic 2024 FB and Mosaic 2024 BK. */
const SRC = "C:/tmp/ci/csv2";

interface Corpus {
  products?: Record<string, {
    parallels?: { name?: string }[];
    insertSets?: { root: string; rootKey: string; children: string[]; categories: string[] }[];
  }>;
}

/** Build once, into a temp dir. Skipped when the raw sources are not present
 *  (they are developer-local scrape output, not committed). */
let corpus: Corpus | null = null;
const haveSources = existsSync(SRC);
if (haveSources) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "vocab-")), "c.json");
  execFileSync(process.execPath, [BUILDER, `--dirs=${SRC}`, `--out=${out}`], { stdio: "ignore" });
  corpus = JSON.parse(readFileSync(out, "utf8")) as Corpus;
}
const maybe = haveSources ? describe : describe.skip;

const lower = (s: string) => s.toLowerCase();

maybe("the builder separates insert sets from parallels", () => {
  const optic = () => corpus!.products!["football|2024|donruss-optic"];
  const mosaic = () => corpus!.products!["basketball|2024|panini-mosaic"];

  // R66 PR 1 (2026-09-19) added a CATEGORY-driven pass alongside this
  // name-based split: `insertSetsFromCategories` for a bare category whose
  // rows carry no parallel text at all, `bareSelfNamedInsertRoots` for one
  // whose rows carry only a fold of the set's own name ("Illusionist" on
  // `insert-illusionists`). Both read rows this test's name-based split never
  // sees, so the totals below are LARGER than before that pass existed --
  // see corpusCategoryBareInsertRoots.test.ts for what specifically grew and
  // why growth, not shrinkage, is the correct direction here.
  it("football|2024|donruss-optic: 47 parallels + 49 insert sets (201 names)", () => {
    const p = optic();
    expect(p).toBeTruthy();
    const moved = (p.insertSets ?? []).reduce((a, s) => a + s.children.length, 0);
    expect(p.parallels!.length).toBe(47);
    expect(p.insertSets!.length).toBe(49);
    expect(moved).toBe(201);
  });

  it("basketball|2024|panini-mosaic: 178 parallels + 68 insert sets (284 names)", () => {
    const p = mosaic();
    const moved = (p.insertSets ?? []).reduce((a, s) => a + s.children.length, 0);
    expect(p.parallels!.length).toBe(178);
    expect(p.insertSets!.length).toBe(68);
    expect(moved).toBe(284);
  });

  it("the three R31 offenders leave parallels[] and land in insertSets[]", () => {
    const p = optic();
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    const children = new Set((p.insertSets ?? []).flatMap((s) => s.children.map(lower)));
    for (const n of ["passing grade", "passing grade gold", "my house!", "light it up"]) {
      expect(names.has(n), `${n} must not be a parallel`).toBe(false);
      expect(children.has(n), `${n} must be an insert child`).toBe(true);
    }
  });

  it("COLOUR RUNGS OF AN INSERT STAY PARALLELS — the guard against over-reach", () => {
    // This is the assertion that would fail if the rule were "drop every
    // insert row". `Purple Scope` is categorised
    // `insert-rated-rookies-purple-scope` and IS a real rung.
    const p = optic();
    const names = new Set(p.parallels!.map((x) => lower(String(x.name))));
    for (const n of ["purple scope", "purple", "gold vinyl", "ice"]) {
      expect(names.has(n), `${n} must remain a parallel`).toBe(true);
    }
  });

  it("an insert root is never fragmented into one root per colour", () => {
    // A first draft grouped by the per-colour category slug and produced 127
    // roots for 130 names. Roots that extend a shorter root are merged.
    const p = optic();
    const moved = p.insertSets!.reduce((a, s) => a + s.children.length, 0);
    expect(p.insertSets!.length).toBeLessThan(moved / 2);
    const pg = p.insertSets!.find((s) => s.rootKey === "passing grade");
    expect(pg).toBeTruthy();
    expect(pg!.children.length).toBeGreaterThan(3);
    expect(pg!.children.map(lower)).toContain("passing grade gold");
  });

  it("every insert child really does carry its root's name", () => {
    // The rule, asserted as a property over the whole built corpus rather than
    // on examples: a child that does not start with its root is a rung the
    // splitter took by mistake.
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

  it("KNOWN over-merge: two inserts sharing a first word share a root", () => {
    // Recorded, not fixed. "Downtown Duos" + "Downtown Legends" land under one
    // root, as do the three "Rookie ..." sets. 2 of 26 roots on Optic.
    //
    // Two alternatives were tried and measured: a colour/finish wordlist
    // re-fragmented to 68 roots, the source's own category slug to 127. Both
    // are worse than the over-merge, because the slug appends the colour and
    // no hand list covers every suffix.
    //
    // It costs nothing the consumers read: `children` is exact either way, and
    // every consumer matches on the CHILD name, not the root label.
    const p = optic();
    const downtown = p.insertSets!.find((s) => s.rootKey === "downtown");
    expect(downtown).toBeTruthy();
    const kids = downtown!.children.map(lower);
    expect(kids.some((k) => k.startsWith("downtown duo"))).toBe(true);
    expect(kids.some((k) => k.startsWith("downtown legend"))).toBe(true);
  });

  it("the plural fold recovers a root the singular member truncated", () => {
    // The source spells one set "Best Tuddy" AND "Best Tuddys Gold", so a
    // literal common prefix stopped at "Best". 3 of 5 truncated roots on Optic
    // are recovered by folding a trailing "s" when comparing.
    const p = optic();
    const roots = p.insertSets!.map((s) => s.root);
    expect(roots).toContain("Best Tuddys");
    expect(roots).toContain("Diamond Hands");
    expect(roots).not.toContain("Best");
  });

  it("parallels[] keeps its shape, so existing consumers load unchanged", () => {
    const e = optic().parallels![0] as Record<string, unknown>;
    for (const f of ["name", "printRun", "odds", "seen", "spellings"]) {
      expect(Object.prototype.hasOwnProperty.call(e, f), `parallels[] must keep ${f}`).toBe(true);
    }
  });
});
