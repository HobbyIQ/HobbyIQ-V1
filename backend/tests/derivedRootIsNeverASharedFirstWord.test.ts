// CF-A-DERIVED-ROOT-IS-NEVER-A-SHARED-FIRST-WORD (R44 follow-up, Drew 2026-09-15).
//
// `rungFoldingFor` may DERIVE a root that no file states, so that fourteen
// "Dual Patch Autographs <colour>" files land on one card set instead of
// fourteen. That derivation is gated on the siblings' rosters agreeing — and
// agreement turned out to be too weak a test.
//
// MEASURED on acq-2026-09-14-cardboardconnection-2, 2019-20 Donruss Basketball:
//
//   "Rookie Dominator Signatures"  40 cards, EVERY row signed,  /25 /99 /1 /10
//   "Rookie Jersey Kings"          40 cards, NONE signed,       /99 /75 /25
//
// They share the first word "Rookie" and their rosters agree 40 of 40 — they
// are the same rookie class — so the agreement gate passed and the tails
// differed, so the tail gate passed too. The fold derived
// `panini-donruss-rookie`, a card set the source never prints, and the guard
// then REFUSED the whole 7,367-row file for an unregistered key.
//
// THE TELL: a rung reprints its root, so every sibling of a real root shares
// the root's SIGNING STATUS. Siblings that disagree on `isAuto` are different
// card sets whose names merely start alike, and no colour rung can explain the
// difference, because autograph status is not a parallel.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INSERT_SET = require_("../scripts/lib/insert-set-key.cjs");

const DIR = path.join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-14-cardboardconnection-2");
const FILE = "2019-20-panini-donruss-basketball.csv";

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

describe.runIf(present)("a derived root is never a shared first word", () => {
  const rows = present ? readRows(FILE) : [];

  it("the two Rookie sections really do disagree on signing (the premise)", () => {
    const signingOf = (cat: string) => {
      const s = new Set<string>();
      for (const r of rows) if (r.category === cat) s.add(r.isAuto);
      return [...s].sort();
    };
    expect(signingOf("rookie-dominator-signatures")).toEqual(["true"]);
    expect(signingOf("rookie-jersey-kings")).toEqual(["false"]);
  });

  it("their rosters DO agree, so the old gate could not tell them apart", () => {
    const rosterOf = (cat: string) => {
      const m = new Map<string, string>();
      for (const r of rows) if (r.category === cat) m.set(r.cardNumber, r.player);
      return m;
    };
    const a = rosterOf("rookie-dominator-signatures");
    const b = rosterOf("rookie-jersey-kings");
    let differ = 0;
    for (const [n, p] of a) { const q = b.get(n); if (q !== undefined && q !== p) differ++; }
    expect(a.size).toBe(40);
    expect(b.size).toBe(40);
    expect(differ).toBe(0);
  });

  it("derives NO root from the shared first word", () => {
    const fold = INSERT_SET.rungFoldingFor(rows);
    const derived = [...fold.keys()].map((k) => String(fold.get(k).root));
    expect(derived).not.toContain("rookie");
    // Nothing else in this file needs a derived root either.
    expect(fold.size).toBe(0);
  });

  it("leaves both sections on their own full-name keys", () => {
    // The id must IGNORE the category, exactly as the pre-separation address
    // does — that is what makes the two sections collide and so be separated.
    const idOf = (r: Row) => `hiq:basketball:2019:panini-donruss:${r.cardNumber}:${r.parallel || "base"}:${r.isAuto}:${r.printRun}`;
    const keys = INSERT_SET.insertSetKeysOf(
      rows, "panini-donruss",
      INSERT_SET.subsetsToSeparate(rows, "panini-donruss", idOf, new Map()),
      new Map()
    ).map((k: { setKey: string }) => k.setKey);
    expect(keys).toContain("panini-donruss-rookie-dominator-signatures");
    expect(keys).toContain("panini-donruss-rookie-jersey-kings");
    expect(keys).not.toContain("panini-donruss-rookie");
  });

  it("still derives a root where the siblings agree on signing", () => {
    // The Spectra case the derivation exists for: same signing status, rosters
    // agree, tails are colours. Synthetic, so the test states the contract
    // rather than depending on a staged file.
    const spectra: Row[] = [];
    for (const colour of ["gold", "meta"]) {
      for (let n = 1; n <= 5; n++) {
        spectra.push({ category: `dual-patch-autographs-${colour}`, cardNumber: String(n),
          parallel: "", isAuto: "true", printRun: "", player: `Player ${n}` });
      }
    }
    const fold = INSERT_SET.rungFoldingFor(spectra);
    const roots = new Set([...fold.values()].map((v: { root: string }) => v.root));
    expect(roots).toContain("dual-patch-autographs");
  });
});
