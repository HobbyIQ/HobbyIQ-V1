// CF-A-COLOUR-SIBLING-SET-NAMES-ITSELF-BY-ITS-PREFIX (2026-09-15).
//
// A product can publish an insert with NO uncoloured tier. 2021 Donruss FB
// prints "Optic Rated Rookie Preview Blue/Gold/Green/Holo/Pink/Purple/Red" and
// no plain "Optic Rated Rookie Preview", so every colour extended nothing and
// each became an anchor in its own right.
//
// THE CATEGORY IS THE SETKEY SEGMENT, so that produced
// `optic-rated-rookie-preview-gold` — a key that MINTS A PARALLEL AS A CARD SET
// and gives 100 rows a wrong identity. Not cosmetic.
//
// The siblings themselves name the set: they share a prefix, they REPRINT ONE
// ROSTER (same number -> same player), and what they differ by is the rung.
// Reading that shared prefix is the same evidence the module's existing
// derived-root rule takes for Spectra's fourteen "Dual Patch Autographs
// <colour>" files.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { convert } = require_("../scripts/convertCardboardConnectionXlsx.cjs");

const DIR = path.join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-14-cardboardconnection-2");
const FILE = "2021-panini-donruss-football.csv";

type Row = Record<string, string>;
function readRows(file: string): Row[] {
  const lines = fs.readFileSync(path.join(DIR, file), "utf8").trim().split("\n");
  const head = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((ln) => {
    const m = ln.match(/^([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/);
    if (!m) return null;
    const o: Row = {};
    head.forEach((h, i) => { o[h] = m[i + 1]; });
    return o;
  }).filter(Boolean) as Row[];
}

const present = fs.existsSync(path.join(DIR, FILE));

describe.runIf(present)("colour siblings name their set by their shared prefix", () => {
  const rows = present ? readRows(FILE) : [];

  it("no category is a colour of another category", () => {
    // The defect's signature: `optic-rated-rookie-preview-gold` existing
    // alongside `optic-rated-rookie-preview`. A category must never be another
    // category plus a colour word.
    const cats = [...new Set(rows.map((r) => r.category))];
    const COLOURS = ["blue", "gold", "green", "holo", "pink", "purple", "red", "black", "orange", "silver"];
    const offenders = cats.filter((c) =>
      cats.some((other) => other !== c && COLOURS.some((col) => c === `${other}-${col}`))
    );
    expect(offenders).toEqual([]);
  });

  it("the seven single-word ORRP colours share one category and differ by rung", () => {
    const orrp = rows.filter((r) => r.category === "optic-rated-rookie-preview");
    expect(orrp.length).toBeGreaterThan(0);
    const rungs = new Set(orrp.map((r) => r.parallel));
    for (const c of ["Blue", "Gold", "Green", "Holo", "Pink", "Purple", "Red"]) {
      expect(rungs.has(c)).toBe(true);
    }
  });

  it("every ORRP colour reprints one roster — which is why they are one set", () => {
    const orrp = rows.filter((r) => r.category === "optic-rated-rookie-preview" && r.parallel);
    const byRung = new Map<string, Map<string, string>>();
    for (const r of orrp) {
      if (!byRung.has(r.parallel)) byRung.set(r.parallel, new Map());
      byRung.get(r.parallel)!.set(r.cardNumber, r.player);
    }
    const [first, ...rest] = [...byRung.values()];
    let differ = 0;
    for (const other of rest) {
      for (const [num, player] of other) {
        const held = first.get(num);
        if (held !== undefined && held !== player) differ++;
      }
    }
    expect(differ).toBe(0);
  });

  it("the two-word colour tail resolves too — it is NOT held", () => {
    // "Optic Rated Rookie Preview Red and Green" reprints the Red roster and
    // extends its name, so measureAnchors filed it as a rung OF RED. Red is
    // then folded onto the ORRP root by the colour-sibling rule, which left a
    // stale pointer minting `optic-rated-rookie-preview-red` as a card set
    // carrying the nonsense rung "and Green".
    //
    // Walking each anchor chain up to the section that is nobody's rung fixes
    // it, so these 100 rows now carry the rung the source actually prints and
    // are WRITTEN, not held. 2021 FB therefore holds nothing.
    const m = JSON.parse(fs.readFileSync(path.join(DIR, FILE.replace(/\.csv$/, ".manifest.json")), "utf8"));
    expect(m.ingestBlocked).toBeNull();
    const rg = rows.filter((r) => r.parallel === "Red and Green");
    expect(rg.length).toBe(100);
    expect([...new Set(rg.map((r) => r.category))]).toEqual(["optic-rated-rookie-preview"]);
  });

  it("no ORRP section is left rooted on a rung", () => {
    // The regression guard for the stale-pointer defect: every ORRP row must
    // sit on the root category, never on a colour of it.
    const bad = rows.filter((r) => /^optic-rated-rookie-preview-/.test(r.category));
    expect(bad.map((r) => `${r.category} || ${r.parallel}`)).toEqual([]);
  });

  it("the plural twin IS still held — it mints a parallel as a card set", () => {
    // "Jerseys Kings Prime" differs from "Jersey Kings" in the STEM, so no
    // rule relates them: the plural title becomes its own anchor and the rows
    // address a card set the source never prints. Same defect class as
    // `optic-rated-rookie-preview-gold`, still unresolved, so they are held
    // rather than written wrong.
    const bk = "2020-21-panini-donruss-basketball";
    const m = JSON.parse(fs.readFileSync(path.join(DIR, `${bk}.manifest.json`), "utf8"));
    expect(m.ingestBlocked).toBeTruthy();
    expect(m.ingestBlocked.totalHeldRows).toBe(40);
    expect(m.ingestBlocked.heldSections.map((h: { section: string }) => h.section))
      .toContain("Jerseys Kings Prime");
  });
});
