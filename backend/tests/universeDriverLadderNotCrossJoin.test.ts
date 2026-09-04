/**
 * CF-A-PER-SUBSET-LADDER-IS-SUPPOSED-TO-MULTIPLY (2026-09-03).
 *
 * The driver's cleanliness gate refused a file whenever a category's rows
 * approached cards x rungs, reading that arithmetic as the 11.49M-row exploded
 * spine. But since CF-HM-LADDER-INTO-ROWS the fetchers emit exactly that shape
 * ON PURPOSE: one row per (card, rung of that card's OWN subset). 2012/13
 * Panini Prizm's base is 300 cards x {blank, Prizms, Prizms Green, Prizms Gold}
 * = 1,200 rows, and that IS the checklist.
 *
 * The old rule refused all 15 modern-Panini files this lane produces, which is
 * why 2022 Donruss Optic Basketball sat at 7,603 pool rows against 0 catalog
 * rows.
 *
 * WHAT ACTUALLY SEPARATES THE TWO. The graveyard was cards x PLAYERS, and the
 * players-as-parallels / card-line-as-rung guards decide that per row from the
 * file's own roster. What is left for arithmetic is a ladder too WIDE to be one
 * subset's rung list AND perfectly dense -- a real ladder is ragged, because
 * short prints and rookie-only rungs leave holes.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { gateStagedCsv } = require_("../scripts/ingest-universe-driver.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-gate-"));
/**
 * Stage a CSV as a FETCHER would: with the sidecar manifest every converter
 * writes beside its output. `parallelColumnAuthoritative: true` is the flag
 * ingest-scraped-checklist.cjs already reads to take the rung from the column
 * instead of re-deriving one from the category slug -- the converter attesting
 * that this column is the checklist's own ladder.
 *
 * That attestation is what lets a COMPLETE ladder be perfectly dense without
 * reading as a cartesian product (CF-DENSITY-IS-THE-SIGNAL-NOT-SIZE): a full
 * ladder has no holes by definition. Pass `attested: false` for a file nothing
 * vouches for, which gets the strict rule.
 */
const stage = (name: string, rows: string[], attested = true) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "category,cardNumber,parallel,isAuto,printRun,player\n" + rows.join("\n"));
  if (attested) {
    fs.writeFileSync(p.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify({ sourceUrl: `https://example.invalid/${name}`, parallelColumnAuthoritative: true }));
  }
  return p;
};

describe("a per-subset ladder is not a cross-join", () => {
  it("ACCEPTS 2012/13 Prizm's real shape: 300 cards x 4 rungs", () => {
    const rows: string[] = [];
    for (let n = 1; n <= 300; n++)
      for (const g of ["", "Prizms", "Prizms Green", "Prizms Gold"])
        rows.push(`base,${n},${g},false,,Player ${n}`);
    const r = gateStagedCsv(stage("prizm2012.csv", rows));
    expect(r.ok).toBe(true);
    expect(r.stats.ladder).toBe(900);
  });

  it("ACCEPTS a wide but RAGGED ladder — the 2023/24 Optic shape", () => {
    // 253 rungs is the widest legitimate per-subset ladder measured on the
    // lane. Real ladders have holes; this one does.
    const rows: string[] = [];
    for (let n = 1; n <= 250; n++) {
      rows.push(`base,${n},,false,,Player ${n}`);
      for (let i = 0; i < 70; i++) if ((n + i) % 3) rows.push(`base,${n},Rung ${i},false,,Player ${n}`);
    }
    expect(gateStagedCsv(stage("ragged.csv", rows)).ok).toBe(true);
  });

  it("REFUSES the exploded spine — cards x PLAYERS", () => {
    // The 11.49M-row graveyard. Caught by the players-as-parallels guard, on
    // the file's own roster, not by arithmetic.
    const players = ["Mike Trout", "Aaron Judge", "Shohei Ohtani", "Juan Soto", "Ronald Acuna"];
    const rows: string[] = [];
    for (let n = 1; n <= 300; n++) {
      rows.push(`base,${n},,false,,Mike Trout`);
      for (const pl of players) rows.push(`base,${n},${pl},false,,Mike Trout`);
    }
    const r = gateStagedCsv(stage("spine.csv", rows));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/player name from this same file/);
  });

  it("REFUSES a wide, perfectly dense cartesian product", () => {
    // Every card paired with every one of 80 rungs, no gaps. Not a ladder.
    const rows: string[] = [];
    for (let n = 1; n <= 300; n++)
      for (let i = 0; i < 80; i++) rows.push(`base,${n},Refractor Variant ${i},false,,Player ${n}`);
    rows.push("base,1,,false,,Player 1");
    // Unattested: no converter vouches for this parallel column, so a gapless
    // product is the graveyard shape and is refused on that shape alone.
    const r = gateStagedCsv(stage("cartesian.csv", rows, false));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cartesian product, not a ladder/);
  });

  it("measures density against NON-BLANK rungs", () => {
    // A blank parallel is a base row, one per card. Counting it as a rung turns
    // a true 300x80 product into 300x81 and slips it under the threshold — the
    // exact off-by-one that let the cartesian above pass while it was counted.
    const rows: string[] = [];
    for (let n = 1; n <= 300; n++) {
      rows.push(`base,${n},,false,,Player ${n}`);
      for (let i = 0; i < 80; i++) rows.push(`base,${n},Rung ${i},false,,Player ${n}`);
    }
    expect(gateStagedCsv(stage("blankcount.csv", rows, false)).ok).toBe(false);
  });
});
