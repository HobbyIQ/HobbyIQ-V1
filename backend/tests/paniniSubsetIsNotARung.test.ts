// CF-A-SUBSET-IS-NOT-A-RUNG (R37 follow-up, 2026-09-15).
//
// R37 reads a Panini sheet's parallel as what the section title adds beyond the
// SHORTEST matching base anchor. On Mosaic that exploded: the ingest refused
// both files with 175 and 224 distinct parallels inside ONE `base` category,
// against a real Mosaic ladder of about 29 rungs.
//
// THE CAUSE. Panini prints its base SUBSETS as titles that extend the base
// title — "Base Hall of Fame Mosaic Black". The shortest anchor is "Base", so
// everything after it became the parallel and the SUBSET rode into the rung
// name. Six subsets x ~29 real rungs = ~175 phantom rungs, each a cross-join
// of a section name with a colour.
//
// THE TELL IS THE CARD NUMBERS, NOT THE NAME. A rung REPRINTS its anchor's
// numbers; a subset occupies its OWN range. Measured on 2019-20 Mosaic:
// base 1-200, Rookies 201-250, USA 251-260, NBA 261-280, Hall of Fame 281-295,
// MVPs 296-300 — disjoint. So those are six sections of one 300-card base set
// and the colour that follows is the rung they share.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { convert } = require_("../scripts/convertCardboardConnectionXlsx.cjs");

const DIR = path.join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-14-cardboardconnection-2");
const FILES = ["2019-20-panini-mosaic-basketball.csv", "2020-21-panini-mosaic-basketball.csv"];

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

const present = FILES.every((f) => fs.existsSync(path.join(DIR, f)));

describe.runIf(present)("a Panini subset is not a rung", () => {
  // The ingester refuses a category carrying more than EXPLODED_PAR_MAX (150)
  // distinct parallels. That guard is what caught this, so the test asserts
  // against it directly rather than against a number of my choosing.
  const EXPLODED_PAR_MAX = 150;

  for (const file of FILES) {
    it(`${file}: no category carries more than ${EXPLODED_PAR_MAX} distinct parallels`, () => {
      const rows = readRows(file);
      const byCat = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!byCat.has(r.category)) byCat.set(r.category, new Set());
        byCat.get(r.category)!.add(r.parallel);
      }
      const worst = [...byCat.entries()].sort((a, b) => b[1].size - a[1].size)[0];
      expect(worst[1].size).toBeLessThanOrEqual(EXPLODED_PAR_MAX);
    });

    it(`${file}: the base subsets are their own categories, not rung text`, () => {
      const rows = readRows(file);
      const cats = new Set(rows.map((r) => r.category));
      // The subset rode into the parallel before the fix; now it is a category.
      const subsetCats = [...cats].filter((c) => /^base-/.test(c));
      expect(subsetCats.length).toBeGreaterThan(0);
      // And no parallel may still carry a subset name.
      const leaked = rows.filter((r) => /^(Hall of Fame|MVPs|Rookies|USA|NBA)\b/.test(r.parallel));
      expect(leaked.map((r) => r.parallel).slice(0, 5)).toEqual([]);
    });
  }

  it("a rung that REPRINTS its anchor's numbers still folds onto it", () => {
    // The guard must not over-fire: a genuine colour rung shares its anchor's
    // numbers and must keep measuring against that anchor.
    const rows = readRows(FILES[0]);
    const base = rows.filter((r) => r.category === "base");
    const nums = new Set(base.filter((r) => !r.parallel).map((r) => r.cardNumber));
    const rung = base.filter((r) => r.parallel === "Mosaic Gold");
    expect(rung.length).toBeGreaterThan(0);
    // every Mosaic Gold card is a base card number — it reprints the anchor
    expect(rung.every((r) => nums.has(r.cardNumber))).toBe(true);
  });
});
