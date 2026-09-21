/**
 * R40 acquisition (Drew, ruling 2026-09-15/20): Topps flagship BASEBALL, still-
 * missing cells named in the 2026-09-20 dispatch after #2373/#2374 landed --
 * 2025 Topps Series 2, 2025 Topps Update Series, 2024 Topps Series 2, and 2024
 * Topps Update Series, sourced from checklistinsider.com (Beckett's S3 origin
 * 403'd on the guessed Series 2/Update month windows, per the dispatch note)
 * via the repo's own scrape-checklistinsider.cjs -- xlsx workbook for the base
 * card roster (US-prefixed for Update Series), the page's own stated parallel
 * ladder (verbatim names + print runs) for the rungs.
 *
 * setKey: Series 2 shares the bare "topps" key with Series 1 (continuous
 * #351-700 numbering, non-overlapping with Series 1's #1-350 -- confirmed by
 * planning both cells' files together, see manifest note). Update Series is
 * its own product `topps-update-series` (US-prefixed numbers), per Drew's
 * 2026-09-20 ruling.
 *
 * ONE PRODUCT PACKAGE PER DIRECTORY (house rule; the ingester's scope is a
 * directory). This branch originally staged all four CSVs in one shared
 * directory -- fixed in review to four sibling directories, matching the
 * convention of every other Topps package (acq-2026-09-20-beckett-topps-
 * series1-2025-baseball etc.).
 *
 * REVIEW FIXES (2026-09-20, second pass):
 *   1. "Clear Variation" on the 2025 Series 2 source page sits in PROSE with
 *      the other named base photo-variations (Golden Mirror, Team Color
 *      Border, True Photo), stated short-printed at 1:826 Hobby -- confirmed
 *      absent from the page's actual "Base Parallels List" <ul> itself, not
 *      just nearby text. It is correctly held out (recorded in notMinted),
 *      unlike the 2025 UPDATE Series page, where the identically-named rung
 *      IS inside that product's own Base Parallels List <ul> and is properly
 *      minted there. This also means both 2025 packages mint 39 rungs, not
 *      38 as originally miscounted in every manifest/PR description.
 *   2. DUPLICATE SPELLING: the live catalog cell baseball/2025/topps already
 *      spells this rung "Topps Pattern Foil" (-> topps-pattern-foil); the
 *      source spells it "Topps Foil Pattern" (-> topps-foil-pattern), a
 *      DIFFERENT slug. Aligned to the catalog's spelling in both 2025
 *      packages; the source's own text is preserved as `sourceSpelling` in
 *      each manifest rung entry.
 *   3. Directory split (this file's own restructuring, described above).
 *
 * Modelled on toppsSeries2BaseballLaddersMatchTheirCommittedPlannerVerdict.
 * test.ts's own "run the sanctioned ingester's planStagedDirectory, offline,
 * no Cosmos, against exactly what this branch ships" pattern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");
const DIR_2025_S2 = join(SCRAPED_ROOT, "acq-2026-09-20-checklistinsider-topps-series2-2025-baseball");
const DIR_2025_UPDATE = join(SCRAPED_ROOT, "acq-2026-09-20-checklistinsider-topps-update-2025-baseball");
const DIR_2024_S2 = join(SCRAPED_ROOT, "acq-2026-09-20-checklistinsider-topps-series2-2024-baseball");
const DIR_2024_UPDATE = join(SCRAPED_ROOT, "acq-2026-09-20-checklistinsider-topps-update-2024-baseball");

function planDir(dir: string) {
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  return INGEST.planStagedDirectory(dir, files);
}

function manifestFor(dir: string, csvName: string) {
  const path = join(dir, csvName.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("2025 Topps Series 2 Baseball (checklistinsider)", () => {
  it("clean file PASSes: 350 base cards x 40 (39 rungs + Base) = 14,000 rows, 14,000 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR_2025_S2);
    const entry = plans.get("2025-topps-series2-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(14000);
    expect(entry.plan.ids).toBe(14000);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\" (continues Series 1's #1-350 number line at #351-700)", () => {
    const m = manifestFor(DIR_2025_S2, "2025-topps-series2-baseball.csv");
    expect(m.setKey).toBe("topps");
  });

  it("card #594 (Team Card - Athletics) is present -- the workbook parser's person-name heuristic drops team-only rows, added back manually and cited in the manifest", () => {
    const csv = readFileSync(join(DIR_2025_S2, "2025-topps-series2-baseball.csv"), "utf8");
    expect(csv).toMatch(/base,594,,false,,Team Card - Athletics/);
  });

  it("base roster is the full 350 cards #351-700 with no gaps", () => {
    const csv = readFileSync(join(DIR_2025_S2, "2025-topps-series2-baseball.csv"), "utf8");
    const nums = new Set(
      csv.split("\n").filter((l) => l.startsWith("base,") && l.split(",")[2] === "")
        .map((l) => Number(l.split(",")[1])),
    );
    expect(nums.size).toBe(350);
    for (let n = 351; n <= 700; n++) expect(nums.has(n), `missing card #${n}`).toBe(true);
  });

  it("REVIEW FIX: rung spelling is aligned to the catalog's existing baseball/2025/topps spelling \"Topps Pattern Foil\" (topps-pattern-foil), not the source's \"Topps Foil Pattern\" (topps-foil-pattern) -- a different slug that would have minted a duplicate rung", () => {
    const csv = readFileSync(join(DIR_2025_S2, "2025-topps-series2-baseball.csv"), "utf8");
    expect(csv).toMatch(/,Topps Pattern Foil,/);
    expect(csv).not.toMatch(/,Topps Foil Pattern,/);
    const m = manifestFor(DIR_2025_S2, "2025-topps-series2-baseball.csv");
    const rung = m.rungsMinted.find((r: { parallel: string }) => r.parallel === "Topps Pattern Foil");
    expect(rung.sourceSpelling).toBe("Topps Foil Pattern");
  });

  it("REVIEW FIX: \"Clear Variation\" is NOT minted -- it sits in prose (short-printed 1:826 Hobby, grouped with the other named base photo-variations), confirmed absent from the page's actual Base Parallels List <ul>, unlike the sibling Update Series package where the same-named rung IS inside that product's own ladder", () => {
    const csv = readFileSync(join(DIR_2025_S2, "2025-topps-series2-baseball.csv"), "utf8");
    expect(csv).not.toMatch(/,Clear Variation,/);
    const m = manifestFor(DIR_2025_S2, "2025-topps-series2-baseball.csv");
    expect(m.notMinted.clearVariation).toBeDefined();
    expect(m.notMinted.clearVariation.printRun).toBe(10);
  });

  it("mints exactly 39 rungs (corrected from an original off-by-one miscount of 38)", () => {
    const m = manifestFor(DIR_2025_S2, "2025-topps-series2-baseball.csv");
    expect(m.rungsMinted.length).toBe(39);
    expect(m.rungsMintedCount).toBe(39);
  });
});

describe("2025 Topps Update Series Baseball (checklistinsider)", () => {
  it("clean file PASSes: 350 base cards x 40 (39 rungs + Base) = 14,000 rows, 14,000 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR_2025_UPDATE);
    const entry = plans.get("2025-topps-update-series-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(14000);
    expect(entry.plan.ids).toBe(14000);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is its own product \"topps-update-series\", not the flagship \"topps\" key", () => {
    const m = manifestFor(DIR_2025_UPDATE, "2025-topps-update-series-baseball.csv");
    expect(m.setKey).toBe("topps-update-series");
  });

  it("REVIEW FIX: rung spelling aligned to \"Topps Pattern Foil\" for consistency with the sibling 2025 Series 2 package, source spelling preserved", () => {
    const csv = readFileSync(join(DIR_2025_UPDATE, "2025-topps-update-series-baseball.csv"), "utf8");
    expect(csv).toMatch(/,Topps Pattern Foil,/);
    expect(csv).not.toMatch(/,Topps Foil Pattern,/);
  });

  it("\"Clear Variation\" IS minted here -- confirmed inside this product's own Base Parallels List <ul>, unlike the Series 2 sibling", () => {
    const csv = readFileSync(join(DIR_2025_UPDATE, "2025-topps-update-series-baseball.csv"), "utf8");
    expect(csv).toMatch(/,Clear Variation,/);
  });

  it("mints exactly 39 rungs (corrected from an original off-by-one miscount of 38)", () => {
    const m = manifestFor(DIR_2025_UPDATE, "2025-topps-update-series-baseball.csv");
    expect(m.rungsMinted.length).toBe(39);
    expect(m.rungsMintedCount).toBe(39);
  });
});

describe("2024 Topps Series 2 Baseball (checklistinsider)", () => {
  it("clean file PASSes: 350 base cards x 26 (25 rungs + Base) = 9,100 rows, 9,100 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR_2024_S2);
    const entry = plans.get("2024-topps-series2-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(9100);
    expect(entry.plan.ids).toBe(9100);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\"", () => {
    const m = manifestFor(DIR_2024_S2, "2024-topps-series2-baseball.csv");
    expect(m.setKey).toBe("topps");
  });

  it("REVIEW NOTE: 'Clear' (select-cards-only, 100-card roster on this source) is deliberately NOT minted -- no card-by-card roster was available, so it is recorded in notMinted rather than guessed as a blanket 350-card rung", () => {
    const csv = readFileSync(join(DIR_2024_S2, "2024-topps-series2-baseball.csv"), "utf8");
    expect(csv).not.toMatch(/,Clear,/);
    const m = manifestFor(DIR_2024_S2, "2024-topps-series2-baseball.csv");
    expect(m.notMinted.namedBaseVariations.names).toContain("Clear (Hobby /10, 100-card select roster)");
  });
});

describe("2024 Topps Update Series Baseball (checklistinsider)", () => {
  it("clean file PASSes: 350 base cards x 25 (24 rungs + Base) = 8,750 rows, 8,750 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR_2024_UPDATE);
    const entry = plans.get("2024-topps-update-series-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(8750);
    expect(entry.plan.ids).toBe(8750);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is its own product \"topps-update-series\"", () => {
    const m = manifestFor(DIR_2024_UPDATE, "2024-topps-update-series-baseball.csv");
    expect(m.setKey).toBe("topps-update-series");
  });

  it("REVIEW NOTE: the source's own nested <ul> ladder undercounts to 8 items under scrape-checklistinsider.cjs's extractLadders() heading-adjacency regex; the full 24-rung ladder (manually verified against the raw HTML, sha256 cited in the manifest) is what got minted", () => {
    const m = manifestFor(DIR_2024_UPDATE, "2024-topps-update-series-baseball.csv");
    expect(m.rungsMinted.length).toBe(24);
  });
});

describe("cross-cell collision check: 2025 Series 2 does not collide with the already-merged 2025 Series 1 package", () => {
  it("planning both directories' files together finds 0 collisions in the baseball/2025/topps cell", () => {
    const s1Dir = join(SCRAPED_ROOT, "acq-2026-09-20-beckett-topps-series1-2025-baseball");
    const s1Files = readdirSync(s1Dir).filter((f: string) => f.endsWith(".csv") && f === "2025-topps-series1-baseball.csv");
    const s2Files = readdirSync(DIR_2025_S2).filter((f: string) => f === "2025-topps-series2-baseball.csv");

    // planStagedDirectory takes one directory; since both files declare the
    // same cell (baseball/2025/topps) but live in different staged
    // directories, plan each separately and cross-check the resulting id sets
    // for overlap directly -- equivalent evidence without relying on a
    // combined-directory fixture that could rot if either package moves.
    const s1Plan = INGEST.planStagedDirectory(s1Dir, s1Files);
    const s2Plan = INGEST.planStagedDirectory(DIR_2025_S2, s2Files);
    expect(s1Plan.get("2025-topps-series1-baseball.csv").plan.verdict).toBe("pass");
    expect(s2Plan.get("2025-topps-series2-baseball.csv").plan.verdict).toBe("pass");

    const s1Csv = readFileSync(join(s1Dir, "2025-topps-series1-baseball.csv"), "utf8");
    const s2Csv = readFileSync(join(DIR_2025_S2, "2025-topps-series2-baseball.csv"), "utf8");
    const s1Nums = new Set(s1Csv.split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[1]));
    const s2Nums = new Set(s2Csv.split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[1]));
    const overlap = [...s1Nums].filter((n) => s2Nums.has(n));
    expect(overlap, `Series 1 and Series 2 card numbers must not overlap: ${overlap.join(",")}`).toEqual([]);
  });
});
