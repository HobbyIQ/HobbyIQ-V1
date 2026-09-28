/**
 * Drew's ruling (2026-09-28): 2023 Topps "Golden Mirror" Image Variation SSP
 * cards are NAMED cards, own rows -- not a parallel to be folded onto the
 * bare base row or dropped as a page-heading artifact. 818 sales carrying
 * "Golden Mirror" in the title sat unbacked under 2023 | topps because no
 * checklist row's parallel column matched the slug live sale titles already
 * normalize to (variationVocabulary.ts: `golden-mirror-variation`).
 *
 * Cardboard Connection's Series 1 and Series 2 Baseball Variations pages and
 * Beckett's dedicated Golden Mirror Image Variations guide agree: Golden
 * Mirror photo-swaps EVERY one of the 330 base numbers in each of Series 1
 * and Series 2 (and, per both sources, Update Series too -- not staged here,
 * see below), same card number and same player as the anchoring base row,
 * gold-foil "SSP" marker, no stated per-card print run. This is the
 * SAME_NUMBER_PARALLEL_SETS shape (Tiffany / Rainbow Foil / Gold, etc.) --
 * one more colour/finish rung on a card that already exists, not a
 * different roster -- which is why it is staged `category: base` beside
 * every other Series 1/2 base parallel, never a `insert-*` category minted
 * for a name a checklist never gave individual photos (contrast the 15-card,
 * individually-photographed 2018 Bowman Chrome "Carrying Bag"-style Rookie
 * Image Variations, which DO get per-card `insert-rookie-image-variations`
 * rows because Beckett named each photo).
 *
 * TWO FILES, ONE RULING:
 *   1. NEW: 330 Series 1 Golden Mirror rows (acq-2026-09-28), staged here for
 *      the first time -- Series 1's own committed base package
 *      (acq-2026-09-20-beckett-topps-series1-2023-baseball) never carried a
 *      Golden Mirror section at all.
 *   2. FIX: Series 2's own committed base package
 *      (acq-2026-09-20-beckett-topps-series2-2023-baseball/2023-topps-
 *      series2-baseball.csv) already carried 330 Golden Mirror rows, but
 *      the parallel column held Beckett's raw scraped section-heading text
 *      verbatim, "Golden Mirror Variations Checklist" -- that workbook's
 *      Variations sheet had no sibling section and no Master-sheet
 *      corroboration for stripChecklistSuffix to safely drop the trailing
 *      "Checklist" word at conversion time (see that file's own manifest
 *      note), so the converter correctly left it un-stripped pending exactly
 *      this kind of externally-verified ruling. Corrected in place to
 *      "Golden Mirror Variation" -- the codebase's own established slug.
 *
 * UPDATE SERIES IS NOT STAGED. Both sources state Update Series carries the
 * same 330-card Golden Mirror twin, but no 2023 Topps Update Series BASE
 * checklist package exists anywhere in this repo to anchor it against --
 * minting 330 rows with no base row to sit beside and no verified card
 * list to check them against would be exactly the guess CF-NO-SYNTHETIC-
 * PARALLELS forbids. Left for a follow-on PR once Update's base package is
 * acquired.
 *
 * Modelled on toppsSeries1BaseballLaddersMatchTheirCommittedPlannerVerdict
 * .test.ts / toppsSeries2BaseballLaddersMatchTheirCommittedPlannerVerdict
 * .test.ts's own "run the sanctioned ingester's planStagedDirectory,
 * offline, no Cosmos, against exactly what this branch ships" pattern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planDir(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  return { dir, files, plans };
}

function manifestFor(dirName: string, csvName: string) {
  const path = join(SCRAPED_ROOT, dirName, csvName.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("2023 Topps Series 1 Baseball — Golden Mirror Image Variation SSP (Cardboard Connection + Beckett, acq-2026-09-28)", () => {
  const DIR = "acq-2026-09-28-cbc-beckett-topps-golden-mirror-image-variation-2023";
  const FILE = "2023-topps-series1-baseball-golden-mirror.csv";

  it("clean file PASSes: 330 rows, 330 distinct ids, 0 collisions, 0 unregistered", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get(FILE);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(330);
    expect(entry.plan.ids).toBe(330);
    expect(entry.plan.collisions.length).toBe(0);
    expect(entry.plan.unregistered).toEqual([]);
  });

  it("every row is category=base with parallel exactly 'Golden Mirror Variation' — the codebase's own canonical slug, never the raw scraped 'Golden Mirror Variations Checklist' section heading", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, DIR, FILE), "utf8");
    const lines = csv.split("\n").filter((l) => l.trim().length > 0).slice(1); // drop header
    expect(lines.length).toBe(330);
    for (const line of lines) {
      expect(line).toMatch(/^base,\d+,Golden Mirror Variation,false,,\S/);
    }
    expect(csv).not.toMatch(/Golden Mirror Variations Checklist/);
  });

  it("covers card numbers #1 through #330 exactly once each, no gaps, no duplicates — full 1:1 coverage of the Series 1 base checklist per Cardboard Connection + Beckett", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, DIR, FILE), "utf8");
    const numbers = csv
      .split("\n")
      .filter((l) => l.startsWith("base,"))
      .map((l) => Number(l.split(",")[1]));
    expect(numbers.length).toBe(330);
    expect(new Set(numbers).size).toBe(330);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(330);
  });

  it("same card number, same player as the anchoring Series 1 base row (#1 Juan Soto, #330 Julio Rodríguez) — a variation shares the base card's identity, it does not restart a roster", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, DIR, FILE), "utf8");
    expect(csv).toMatch(/^base,1,Golden Mirror Variation,false,,Juan Soto$/m);
    expect(csv).toMatch(/^base,330,Golden Mirror Variation,false,,Julio Rodríguez$/m);
  });

  it("no per-card print run is stated — printRun left blank, not a guessed default", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, DIR, FILE), "utf8");
    const lines = csv.split("\n").filter((l) => l.startsWith("base,"));
    for (const line of lines) {
      const cols = line.split(",");
      expect(cols[4]).toBe(""); // printRun column
    }
  });

  it("manifest states the ruling, both sources, and explicitly defers Update Series (needsRuling: no base package to anchor against)", () => {
    const m = manifestFor(DIR, FILE);
    expect(m.setKey).toBe("topps");
    expect(m.year).toBe(2023);
    expect(m.sport).toBe("baseball");
    expect(m.note).toMatch(/named cards \(own rows\), not a parallel/);
    expect(m.countsPerSeries.series1.cards).toBe(330);
    expect(m.countsPerSeries.series2.cards).toBe(330);
    expect(m.countsPerSeries.update.staged).toBe(false);
    expect(m.countsPerSeries.update.needsRuling).toMatch(/no 2023 Topps Update Series base checklist package/);
    expect(Array.isArray(m.sources)).toBe(true);
    expect(m.sources.length).toBeGreaterThanOrEqual(2);
  });
});

describe("2023 Topps Series 2 Baseball — Golden Mirror parallel-name correction (same ruling, existing package)", () => {
  const DIR = "acq-2026-09-20-beckett-topps-series2-2023-baseball";
  const FILE = "2023-topps-series2-baseball.csv";

  it("still PASSes with the same pinned row/id counts after the correction — a find-and-replace on one column's text, no rows added or removed", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get(FILE);
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(11345);
    expect(entry.plan.ids).toBe(11345);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("330 rows now read parallel='Golden Mirror Variation'; the raw scraped 'Golden Mirror Variations Checklist' string is gone", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, DIR, FILE), "utf8");
    const goldenRows = csv.split("\n").filter((l) => l.startsWith("base,") && l.includes(",Golden Mirror Variation,"));
    expect(goldenRows.length).toBe(330);
    expect(csv).not.toMatch(/Golden Mirror Variations Checklist/);
  });

  it("same card number, same player as the anchoring Series 2 base row (#331 Charlie Morton, #660 Austin Riley) — Series 2 continues Series 1's number line", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, DIR, FILE), "utf8");
    expect(csv).toMatch(/^base,331,Golden Mirror Variation,false,,Charlie Morton$/m);
    expect(csv).toMatch(/^base,660,Golden Mirror Variation,false,,Austin Riley$/m);
  });

  it("manifest records the correction with before/after text and an updated sha256", () => {
    const m = manifestFor(DIR, FILE);
    const notes = (m.notes as string[]).join(" ");
    expect(notes).toMatch(/CORRECTED 2026-09-28/);
    expect(notes).toMatch(/Golden Mirror Variations Checklist/);
    expect(notes).toMatch(/Golden Mirror Variation/);
    expect(typeof m.sha256).toBe("string");
    expect(m.sha256).toHaveLength(64);
  });
});
