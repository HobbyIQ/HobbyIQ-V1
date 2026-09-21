/**
 * Follow-up acquisition (2026-09-21) to R40/#2373-#2376: those PRs staged the
 * BASE parallel ladder only for 2025 Topps Series 1 + Series 2 Baseball and
 * explicitly flagged named insert/autograph/relic sets as out of scope for a
 * follow-up package (see acq-2026-09-20-checklistinsider-topps-series2-2025-
 * baseball/2025-topps-series2-baseball.manifest.json notMinted.insertSets).
 *
 * Diagnosed by sampling sold_comps (baseball/2025/topps, id-prefix
 * "hiq:baseball:2025:topps:") read-only against card_catalog: of 52 distinct
 * unbacked ids in a 300-sale sample, 50 point-read genuinely absent (2 were a
 * printRun-suffix mismatch, not a checklist gap). The majority named exactly
 * these 8 insert/auto/relic sets by cardNumber prefix.
 *
 * Sourced from checklistinsider.com's own product pages (NOT the xlsx
 * workbook, which returns category:none for every insert row) -- each
 * section's card-by-card roster and its own verbatim "Parallels: ..."
 * sentence, both read directly off the same page, both verified against the
 * page's own stated card count (exact match for all 8 sections).
 *
 * ADDITIVE ONLY: four of the eight sections (Baseball Stars Autographs S1,
 * Stars of MLB, City Connect Swatch Collection, City Connect Swatch
 * Collection Autograph Relics) already have their blank-parallel BASE row
 * staged and merged in acq-2026-09-20-beckett-topps-series1-2025-baseball
 * (verified by exact grep-count match). This package supplies ONLY the
 * missing colour rungs for those four, and base+full-ladder for the other
 * four (Baseball Stars Autographs S2-continuation, City Connect Swatch S2,
 * City Connect Swatch Autograph Relics S2, Postseason Performance
 * Autographs), which have zero rows staged anywhere else in the repo.
 *
 * NAME-COLLISION CAUGHT AND HELD OUT: the Series 1 xlsx workbook also parses
 * 25 numeric "CC-1".."CC-25" rows under the bare "CC" prefix. These are a
 * DIFFERENT, unrelated insert ("Companion Cards", Super Box exclusive,
 * confirmed via the page's own text: CC-1 Shohei Ohtani, CC-2 Mike Trout,
 * CC-3 Ronald Acuna Jr., ...), not City Connect Swatch. Not staged this
 * package.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const DIR = join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-21-checklistinsider-topps-s1s2-2025-inserts");
const CSV_NAME = "2025-topps-s1-s2-inserts.csv";

function planDir(dir: string) {
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  return INGEST.planStagedDirectory(dir, files);
}

function csvLines(): string[] {
  return readFileSync(join(DIR, CSV_NAME), "utf8").trim().split("\n").slice(1);
}

describe("2025 Topps Series 1 + 2 Baseball inserts (checklistinsider)", () => {
  it("clean file PASSes offline: 2,622 rows, 2,622 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(2622);
    expect(entry.plan.ids).toBe(2622);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\" (flagship inserts share the Series 1/2 base key per Drew's 2026-09-20 ruling)", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-s1-s2-inserts.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("Baseball Stars Autographs S1 (BSA-) carries all 6 stated rungs, no blank-parallel base row (already staged elsewhere)", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-baseball-stars-autographs,BSA-AA,"));
    expect(lines.length).toBe(6);
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(false);
    expect(lines.map((l) => l.split(",")[2]).sort()).toEqual(["Black", "Blue", "Gold", "Orange", "Platinum", "Red"].sort());
  });

  it("Baseball Stars Autographs S2-continuation (bare BSA-, e.g. BSA-AM) DOES carry a base row plus all 6 rungs -- genuinely new, not staged anywhere else", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-baseball-stars-autographs,BSA-AM,"));
    expect(lines.length).toBe(7);
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(true);
  });

  it("City Connect Swatch Collection (CC-) does not include the 'Companion Cards' numeric CC-1..CC-25 rows", () => {
    const lines = csvLines().filter((l) => /^insert-city-connect-swatch-collection,CC-\d+,/.test(l));
    expect(lines.length).toBe(0);
  });

  it("Postseason Performance Autographs (PPA-) carries its own 4-rung ladder (Orange/Black/Red/FoilFractor), distinct from the 2023 PPA relic package's ladder", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-postseason-performance-autographs,PPA-AB,"));
    expect(lines.length).toBe(5); // base + 4 rungs
    const rungs = lines.map((l) => l.split(",")[2]).filter(Boolean);
    expect(rungs.sort()).toEqual(["Black", "FoilFractor", "Orange", "Red"].sort());
  });

  it("all 8 sections' distinct card counts match the source page's own stated counts exactly", () => {
    const lines = csvLines();
    const byCategory = new Map<string, Set<string>>();
    for (const l of lines) {
      const [category, cardNumber] = l.split(",");
      if (!byCategory.has(category)) byCategory.set(category, new Set());
      byCategory.get(category)!.add(cardNumber);
    }
    // auto-baseball-stars-autographs spans both S1 (102) and S2 (105, 25 of
    // which reuse bare BSA- codes already counted in S1's 102) -- so the
    // distinct BSA-prefixed card count is 102 + 80 (BSA2-only) = 182.
    const bsaIds = [...byCategory.get("auto-baseball-stars-autographs")!];
    expect(bsaIds.filter((c) => c.startsWith("BSA2-")).length).toBe(80);
    // "BSA-" (bare) codes total 127: the 102 Series-1 cards + 25 Series-2
    // continuation cards that reuse a bare BSA- code for a repeat player
    // (both verified disjoint against each other by the extraction step).
    expect(bsaIds.filter((c) => c.startsWith("BSA-")).length).toBe(127);

    expect(byCategory.get("insert-stars-of-mlb")!.size).toBe(30);

    const ccIds = [...byCategory.get("insert-city-connect-swatch-collection")!];
    expect(ccIds.filter((c) => c.startsWith("CC2-")).length).toBe(47);
    expect(ccIds.filter((c) => c.startsWith("CC-")).length).toBe(36);

    const ccarIds = [...byCategory.get("auto-city-connect-swatch-collection-autograph-relics")!];
    expect(ccarIds.filter((c) => c.startsWith("CCA2-")).length).toBe(32);
    expect(ccarIds.filter((c) => c.startsWith("CCAR-")).length).toBe(27); // 24 S1 + 3 S2-continuation

    expect(byCategory.get("auto-postseason-performance-autographs")!.size).toBe(50);
  });
});
