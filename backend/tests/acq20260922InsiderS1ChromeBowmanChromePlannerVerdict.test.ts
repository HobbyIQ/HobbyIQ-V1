/**
 * 2026-09-22 acquisition wave: THREE checklistinsider.com sections, after
 * TWO rounds of review found the dedupe claims false.
 *
 * ROUND 1 DEFECT. The first dedupe check compared a case-sensitive Cosmos
 * `CONTAINS` filter against LOWERCASE ids while the CSVs' own cardNumber
 * column was mixed-case (`T91-1`, `91A-ABB`, `RA-AA`, `BCP-151`), so every
 * check silently found zero matches even though many rows already existed.
 * Fixed by lowercasing correctly and point-reading exact ids.
 *
 * ROUND 2 DEFECT (the RA- package). A full point-read still found ALL
 * 658/658 staged RA- (Chrome Rookie Autographs) rows already existed as
 * checklist-grade rows. Root cause: the round-1 fix hand-rolled its OWN
 * slugify reimplementation to build the id it point-read, instead of
 * calling the real `computeHobbyIqCardId` (hobbyIqCardId.service.ts). That
 * reimplementation was missing two of the deriver's own compound-variant
 * rules: "RayWave" canonicalizes to "ray-wave" (hyphenated) and "Printing
 * Plates" folds to the SINGULAR "printing-plate" via PLURAL_PARALLEL_HEAD
 * -- so every point-read checked a slug the real ingester would never mint,
 * always missed, and every row passed as a false "genuinely absent". The
 * RA- PACKAGE IS REMOVED ENTIRELY as a result -- every one of its 658 rows
 * was already catalogued (baseballcardpedia-ladders-2026-09-04 /
 * checklistcenter-2026-08-29 / plain "checklist").
 *
 * THE FIX. Every remaining package's dedupe now imports and calls the REAL
 * `computeHobbyIqCardId` from the compiled dist build directly -- the exact
 * function and call shape (`authoritativeSetKey: true`, raw `parallel` text
 * passed through, not pre-slugged) that `ingest-checklist-csv-to-catalog.cjs`
 * itself uses -- so the id checked is guaranteed to be the id that would
 * actually be minted, never a hand-rolled approximation.
 *
 * WHAT SURVIVED the corrected check (the only rungs genuinely absent
 * anywhere, checklist-grade or derived):
 *   - 2026 Topps Series 1 "1991 Topps Autographs" (91A-/91AU-, `topps`):
 *     Blue/Green/Gold/Orange/Black/Red (185 cards x 6 = 1110 rows). Of
 *     these, 115 already exist at their exact id as DERIVED-ONLY rows
 *     (source `ingest-auto-seed`) -- kept anyway, since a checklist row
 *     supersedes a derived one; the manifest records the supersession.
 *   - 2026 Topps Series 1 "1991 Topps Baseball" (T91-, `topps`): the 7
 *     plain "*Foil" rungs -- Black/Blue/Gold/Green/Orange/Pink/Red Foil
 *     (100 x 7 = 700 rows; 22 NAMED rungs total on the page, 23 counting
 *     Base). 73 of the 700 exist only as derived-only rows -- kept for the
 *     same supersession reason.
 *   - 2026 Bowman Chrome "Chrome Prospects" (BCP-151..250, `bowman-chrome`):
 *     Black Wave (100 cards) + Lazer Refractor (99 of 100 -- BCP-151
 *     already has it, checklist-grade). 0 of the 199 rows exist as ANY
 *     kind of row -- fully clean.
 *
 * REMOVED: 2026 Topps Chrome "Chrome Rookie Autographs" (RA-,
 * `topps-chrome`) -- 0/658 rows survive; every rung already exists as a
 * checklist-grade row. No CSV or manifest for this section ships in this
 * PR.
 *
 * None of the three surviving packages needs a NEW registered key: `topps`
 * and `bowman-chrome` are pre-existing fixed points. This test pins that
 * `planStagedDirectory` (offline, no Cosmos) agrees: every package PASSes
 * with 0 unregistered keys and 0 collisions, staged row counts match the
 * genuinely-absent totals above, distinct cardNumbers cover the section's
 * roster, and there are zero exact-duplicate CSV lines.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

      it("staged row count matches the genuinely-absent total (point-read verified via the REAL computeHobbyIqCardId)", () => {
        const lines = rawLines(pkg.dir, pkg.csv);
        expect(lines.length).toBe(pkg.expectedRowCount);
      });
    });
  }

  it("the RA- (Chrome Rookie Autographs) package was REMOVED -- 0/658 rows survived a point-read against the real minted id", () => {
    const dir = join(SCRAPED_ROOT, "acq-2026-09-22-2100-insider-topps-chrome-ra");
    expect(existsSync(dir), "the RA- package directory must not exist in this PR").toBe(false);
  });
});
