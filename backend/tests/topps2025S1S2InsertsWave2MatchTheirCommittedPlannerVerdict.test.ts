/**
 * Wave 2 of the follow-up acquisition to R40/#2373-#2376 and PR #2388 (wave
 * 1: BSA/BSA2, CC/CC2, CCAR/CCA2, SMLB, PPA). Stages the remaining 2025 Topps
 * Series 1 + Series 2 Baseball insert/autograph/relic sets confirmed
 * reachable in #2388's manifest notMinted.otherSeries1And2InsertSets:
 * World Champion Dual Autographs (WCDA), Major League Material Dual
 * (MLMD2), First Pitch Autographs (FPA, two waves sharing one category but
 * different ladders), 1990 Topps Baseball All-Star Relics (90ASR), 1990
 * Topps Chrome Baseball All-Star Autographs Mojo (90CAS), and 1990 Topps
 * Autographs (90A-/90AU- mixed code shapes, one 201-card set).
 *
 * ADDITIVE ONLY: fpa_s1 (9 cards) and 90au (201 cards) already have their
 * blank-parallel base row staged in acq-2026-09-20-beckett-topps-series1-
 * 2025-baseball's own CSV, under a DIFFERENT category label
 * (auto-2024-first-pitch-autographs / auto-1990-topps-baseball-autographs)
 * -- discovered because computeHobbyIqCardId never reads the CSV's category
 * column, so a blank-parallel row under either category name computes the
 * SAME id. This package supplies only their missing colour rungs.
 *
 * NOT staged this wave: RRR- (no roster found anywhere on either checklist
 * page; catalog already has RRR- rows under the correct sibling key
 * topps-update-series -- almost certainly a sale-side wrong-key defect, not
 * a checklist gap); the BS-/Bowman's Best crossover and US###-numbered
 * Update Series rows (both explicitly out of this task's scope, belong to
 * other products).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const DIR = join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-21-checklistinsider-topps-s1s2-2025-inserts-wave2");
const CSV_NAME = "2025-topps-s1-s2-inserts-wave2.csv";

function planDir(dir: string) {
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  return INGEST.planStagedDirectory(dir, files);
}

function csvLines(): string[] {
  return readFileSync(join(DIR, CSV_NAME), "utf8").trim().split("\n").slice(1);
}

describe("2025 Topps Series 1 + 2 Baseball inserts wave 2 (checklistinsider)", () => {
  it("clean file PASSes offline: 1,981 rows, 1,981 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(1981);
    expect(entry.plan.ids).toBe(1981);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("HARD CHECK: 0 byte-identical duplicate CSV lines", () => {
    const lines = csvLines();
    const seen = new Set(lines);
    expect(seen.size).toBe(lines.length);
  });

  it("HARD CHECK: every row for a given cardNumber prefix carries ONE consistent isAuto value", () => {
    const lines = csvLines();
    const byPrefix = new Map<string, Set<string>>();
    for (const l of lines) {
      const cols = l.split(",");
      const cardNumber = cols[1];
      const isAuto = cols[3];
      const m = /^[A-Za-z0-9]+-/.exec(cardNumber);
      const prefix = m ? m[0] : cardNumber;
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
      byPrefix.get(prefix)!.add(isAuto);
    }
    for (const [prefix, values] of byPrefix) {
      expect(values.size, `prefix ${prefix} has mixed isAuto values: ${[...values].join(",")}`).toBe(1);
    }
  });

  it("fpa_s1 (FPA-AB) carries no blank-parallel base row (already staged elsewhere under a different category label)", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-first-pitch-autographs,FPA-AB,"));
    expect(lines.length).toBe(5); // 5 rungs, no base row
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(false);
  });

  it("fpa_s2 (FPA-GRA) DOES carry a base row -- genuinely new, and its ladder ends in FoilFractor not Platinum", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-first-pitch-autographs,FPA-GRA,"));
    expect(lines.length).toBe(6); // base + 5 rungs
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(true);
    expect(lines.some((l) => l.split(",")[2] === "FoilFractor")).toBe(true);
    expect(lines.some((l) => l.split(",")[2] === "Platinum")).toBe(false);
  });

  it("90au (90A-AD) carries no blank-parallel base row (already staged elsewhere)", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-1990-topps-autographs,90A-AD,"));
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(false);
  });

  it("WCDA dual-autograph rows record both players joined with '&'", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-world-champion-dual-autographs,WCDA-CY,"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.split(",")[5].includes("&"))).toBe(true);
  });

  it("RRR- is not present anywhere in this package (no roster was found on either source page)", () => {
    const lines = csvLines().filter((l) => /,RRR-/.test(l));
    expect(lines.length).toBe(0);
  });

  it("Stars of MLB Series 2 continuation (SMLB-31..60) is staged VERBATIM with the Series 2 page's own 'Foil' rung names, NOT silently aligned to PR #2388's Series 1 'Foilboard' spelling", () => {
    const lines = csvLines().filter((l) => l.startsWith("insert-stars-of-mlb,SMLB-31,"));
    expect(lines.length).toBe(6); // base + 5 rungs
    const rungs = lines.map((l) => l.split(",")[2]).filter(Boolean);
    expect(rungs.sort()).toEqual(["Black Foil", "FoilFractor", "Gold Foil", "Orange Foil", "Red Foil"].sort());
    // Explicitly NOT "Foilboard" -- confirms no silent alignment happened.
    expect(lines.some((l) => l.includes("Foilboard"))).toBe(false);
  });

  it("Stars of MLB Series 2 continuation covers exactly cards #31-60, zero overlap with Series 1's #1-30 (staged in #2388)", () => {
    const lines = csvLines().filter((l) => l.startsWith("insert-stars-of-mlb,"));
    const cardNumbers = new Set(lines.map((l) => l.split(",")[1]));
    expect(cardNumbers.size).toBe(30);
    for (let n = 31; n <= 60; n++) expect(cardNumbers.has(`SMLB-${n}`), `missing SMLB-${n}`).toBe(true);
    for (let n = 1; n <= 30; n++) expect(cardNumbers.has(`SMLB-${n}`), `unexpected SMLB-${n} (belongs to #2388)`).toBe(false);
  });
});
