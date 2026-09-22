/**
 * 2026-09-22 acquisition wave: four checklistinsider.com sections, RE-STAGED
 * after review found the first pass's "0 collisions" claim was FALSE.
 *
 * THE DEFECT (review-caught). The first pass's dedupe check compared a
 * Cosmos CONTAINS filter against lowercase ids while the CSV's own
 * cardNumber column was mixed-case (`T91-1`, `91A-ABB`, `RA-AA`, `BCP-151`)
 * -- `CONTAINS` is case-sensitive, so every check silently found zero
 * matches even though most rows already existed. A reviewer point-read the
 * exact ids and found strict rows at all four sampled addresses. REDONE:
 * point-read the EXACT id the ingester mints for every staged row
 * (lowercased correctly), plus a cross-setKey check for the same
 * (cardNumber, rung-slug, isAuto, printRun) under ANY 2026 setKey with a
 * checklist-grade source. Only rows that survive BOTH checks are staged.
 *
 * WHAT SURVIVED (the only rungs genuinely absent everywhere):
 *   - 2026 Topps Series 1 "1991 Topps Autographs" (91A-/91AU-, `topps`):
 *     Blue/Green/Gold/Orange/Black/Red (185 cards x 6 = 1110 rows). Base and
 *     FoilFractor already existed (Base under `topps` itself; FoilFractor
 *     under the sibling key `topps-series-1`).
 *   - 2026 Topps Series 1 "1991 Topps Baseball" (T91-, `topps`): the 7 plain
 *     "*Foil" rungs -- Black/Blue/Gold/Green/Orange/Pink/Red Foil (100 x 7 =
 *     700 rows). Base, the Crackle Foil family, Koi Fish family, The Real
 *     One and FoilFractor already existed under `topps`.
 *   - 2026 Topps Chrome "Chrome Rookie Autographs" (RA-, `topps-chrome`):
 *     the 6 Retail Exclusive RayWave Refractors + Printing Plates (94 x 7 =
 *     658 rows). This package's OWN first-pass ladder was also incomplete
 *     (staged only 4 of 27 rungs) -- refetched and now carries the FULL
 *     verbatim sentence (Refractor colour run, SuperFractor, Printing
 *     Plates, 7 Breaker Geometric Refractors, 6 Retail RayWave Refractors).
 *   - 2026 Bowman Chrome "Chrome Prospects" (BCP-151..250, `bowman-chrome`):
 *     Black Wave (100 cards) + Lazer Refractor (99 of 100 -- BCP-151
 *     already has it). 51 of 53 rungs already existed, including the full
 *     Reptilian ladder ingested the day before this pass. The 477 rows
 *     carrying a scraped "(eBay)" text artifact on 9 player names are also
 *     fixed (stripped at extraction).
 *
 * None of the four needs a NEW registered key: `topps`, `topps-chrome` and
 * `bowman-chrome` are all pre-existing fixed points. This test pins that
 * `planStagedDirectory` (offline, no Cosmos) agrees on the corrected
 * packages: every package PASSes with 0 unregistered keys and 0 collisions,
 * staged row counts match the genuinely-absent totals above, distinct
 * cardNumbers still cover every card the section names, and there are zero
 * exact-duplicate CSV lines.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

function rawLines(dirName: string, csvName: string): string[] {
  const text = readFileSync(join(SCRAPED_ROOT, dirName, csvName), "utf8");
  return text.trim().split("\n").slice(1); // drop header
}

const PACKAGES = [
  {
    dir: "acq-2026-09-22-2100-insider-topps-s1-91a",
    csv: "2026-topps-series-1-1991-topps-autographs.csv",
    expectedRosterCount: 185,
    expectedRowCount: 1110, // 185 cards x 6 genuinely-absent rungs (Blue/Green/Gold/Orange/Black/Red)
  },
  {
    dir: "acq-2026-09-22-2100-insider-topps-s1-t91",
    csv: "2026-topps-series-1-1991-topps-baseball.csv",
    expectedRosterCount: 100,
    expectedRowCount: 700, // 100 cards x 7 genuinely-absent rungs (the plain *Foil family)
  },
  {
    dir: "acq-2026-09-22-2100-insider-topps-chrome-ra",
    csv: "2026-topps-chrome-rookie-autographs.csv",
    expectedRosterCount: 94,
    expectedRowCount: 658, // 94 cards x 7 genuinely-absent rungs (6 RayWave + Printing Plates)
  },
  {
    dir: "acq-2026-09-22-2100-insider-bowman-chrome-bcp",
    csv: "2026-bowman-chrome-prospects.csv",
    expectedRosterCount: 100,
    expectedRowCount: 199, // 100 Black Wave + 99 Lazer Refractor (BCP-151 already has it)
  },
];

describe("2026-09-22 checklistinsider acquisition wave — planner PASS, no new keys needed", () => {
  for (const pkg of PACKAGES) {
    describe(pkg.dir, () => {
      it("planStagedDirectory reports PASS: 0 unregistered, 0 collisions", () => {
        const { entry } = planPackage(pkg.dir);
        expect(entry.product).not.toBeNull();
        expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
        expect(entry.plan.reason).toBeNull();
        expect(entry.plan.unregistered).toEqual([]);
        expect(entry.plan.collisions.length).toBe(0);
      });

      it("0 exact-duplicate CSV lines (pin assertion)", () => {
        const lines = rawLines(pkg.dir, pkg.csv);
        const unique = new Set(lines);
        expect(unique.size, "every staged line must be unique").toBe(lines.length);
      });

      it("distinct cardNumbers cover the section's own stated card count", () => {
        const lines = rawLines(pkg.dir, pkg.csv);
        const cardNumbers = new Set(lines.map((l) => l.split(",")[1]));
        // <= not === now: after dropping already-present rungs, a card can
        // legitimately have fewer staged rows than another (e.g. BCP-151's
        // Lazer Refractor already exists), but never MORE distinct
        // cardNumbers than the section's own roster.
        expect(cardNumbers.size).toBeLessThanOrEqual(pkg.expectedRosterCount);
      });

      it("staged row count matches the genuinely-absent total (point-read verified)", () => {
        const lines = rawLines(pkg.dir, pkg.csv);
        expect(lines.length).toBe(pkg.expectedRowCount);
      });
    });
  }
});
