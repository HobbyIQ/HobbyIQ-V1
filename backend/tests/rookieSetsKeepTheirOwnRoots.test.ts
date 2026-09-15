// CF-A-A-SHARED-ROSTER-IS-NOT-A-SHARED-SET (2026-09-15).
//
// 2019-20 Donruss BK prints three different autograph/relic sets that all sign
// the same rookie class — #1 Zion Williamson, #2 Ja Morant, #3 RJ Barrett:
//
//   "Next Day Autographs"          42 cards
//   "Rookie Dominator Signatures"  40 cards
//   "Rookie Jersey Kings"          40 cards
//
// measureAnchors folds a section onto another whose roster it reproduces. On
// roster evidence alone all three match, and the largest won: both Rookie sets
// were filed as rungs of "Next Day Autographs" — a set whose name they do not
// share a single word with — so 80 signed cards were addressed to the wrong
// card set entirely.
//
// A rung is spelled as its root plus a finish, so a fold now also requires the
// rung's TITLE to extend its root's title. These three keep their own roots,
// and the colour/prime rungs that genuinely belong to them still fold in.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = path.join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-14-cardboardconnection-2");
const FILE = "2019-20-panini-donruss-basketball.csv";

type Row = { category: string; cardNumber: string; parallel: string; player: string };
function readRows(file: string): Row[] {
  const lines = fs.readFileSync(path.join(DIR, file), "utf8").trim().split("\n");
  const head = lines[0].split(",").map((h) => h.trim());
  const out: Row[] = [];
  for (const ln of lines.slice(1)) {
    const m = ln.match(/^([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/);
    if (!m) continue;
    const o: Record<string, string> = {};
    head.forEach((h, i) => { o[h] = m[i + 1]; });
    out.push(o as unknown as Row);
  }
  return out;
}

const present = fs.existsSync(path.join(DIR, FILE));

describe.runIf(present)("three sets that share a rookie roster keep their own roots", () => {
  const rows = present ? readRows(FILE) : [];

  it("each of the three sets is its own category", () => {
    const cats = new Set(rows.map((r) => r.category));
    for (const c of ["next-day-autographs", "rookie-dominator-signatures", "rookie-jersey-kings"]) {
      expect(cats.has(c)).toBe(true);
    }
  });

  it("neither Rookie set is filed as a rung of Next Day Autographs", () => {
    // The defect's signature: a "Rookie Dominator Signatures" row carrying
    // category `next-day-autographs` with the whole set name as its parallel.
    const nda = rows.filter((r) => r.category === "next-day-autographs");
    const leaked = nda.filter((r) => /rookie (dominator|jersey)/i.test(r.parallel));
    expect(leaked.map((r) => r.parallel)).toEqual([]);
    expect(nda.length).toBe(42);
  });

  it("their own rungs still fold onto them", () => {
    // Requiring the name relationship must not cost the genuine rungs:
    // "Rookie Dominator Signatures Black"/"Gold" and "Rookie Jersey Kings
    // Prime" all extend their root's title, so they still resolve.
    const dom = rows.filter((r) => r.category === "rookie-dominator-signatures");
    expect(new Set(dom.map((r) => r.parallel))).toEqual(new Set(["", "Black", "Gold"]));

    const rjk = rows.filter((r) => r.category === "rookie-jersey-kings");
    expect(new Set(rjk.map((r) => r.parallel))).toEqual(new Set(["", "Prime"]));
  });

  it("the shared roster really is shared — which is why the guard is needed", () => {
    // If the rosters ever stop matching, this test stops proving anything.
    const rosterOf = (cat: string) => {
      const m = new Map<string, string>();
      for (const r of rows.filter((x) => x.category === cat && !x.parallel)) m.set(r.cardNumber, r.player);
      return m;
    };
    const nda = rosterOf("next-day-autographs");
    const dom = rosterOf("rookie-dominator-signatures");
    let shared = 0;
    for (const [num, player] of dom) if (nda.get(num) === player) shared++;
    expect(shared).toBeGreaterThan(30);
  });
});
