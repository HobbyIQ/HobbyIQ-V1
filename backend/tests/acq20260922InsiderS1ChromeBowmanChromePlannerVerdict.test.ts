/**
 * 2026-09-22 acquisition wave: four checklistinsider.com sections that were
 * TRULY ABSENT from card_catalog under every registered sibling key
 * (verified read-only against prod Cosmos before staging -- no strict row,
 * no derived/-graded row, nothing under any sibling setKey either):
 *
 *   - 2026 Topps Series 1 "1991 Topps Autographs" insert (91A-/91AU-, 185
 *     cards, isAuto=true) -- registers under `topps` (S1/S2 insert doctrine).
 *   - 2026 Topps Series 1 "1991 Topps Baseball" insert (T91-, 100 cards) --
 *     also `topps`. Its own Parallels sentence is where "Pink Foil",
 *     "Gold Foil" and the "Koi Fish" family actually live; those exact
 *     spellings were already present in card_catalog under `topps` before
 *     this PR, confirming they were sourced from THIS insert's own
 *     numbering on an earlier pass, not the 350-card base set (whose own
 *     Parallels sentence does not contain them).
 *   - 2026 Topps Chrome "Chrome Rookie Autographs" insert (RA-, 94 cards,
 *     isAuto=true) -- `topps-chrome`.
 *   - 2026 Bowman Chrome "Chrome Prospects" (BCP-151..250, 100 cards) --
 *     `bowman-chrome`, matching the 2025 precedent package
 *     (acq-2026-09-19-beckett-bowman-chrome-2025-bcp-base) which staged the
 *     equivalent BCP-153..252 range under the SAME setKey with no qualified
 *     sub-key. Includes "Lazer Refractor" (verbatim spelling, confirmed on
 *     the source page's own "Mega Exclusive Parallels" line and confirmed
 *     absent from card_catalog under either lazer-/laser- slug spelling
 *     before this PR) and the Reptilian sub-rungs already ingested the day
 *     before this pass, included here only because BCP-151..250 itself had
 *     zero rows and this range's own Parallels sentence names them.
 *
 * None of the four needs a NEW registered key: `topps`, `topps-chrome` and
 * `bowman-chrome` are all pre-existing fixed points, and a direct Cosmos
 * CONTAINS check (year+cardNumber, unscoped by setKey) found zero existing
 * rows anywhere for all 479 staged cardNumbers across the four sections --
 * so this is pure insertion into already-registered products, not a
 * collision the ingester's guard needs to arbitrate. This test pins that
 * `planStagedDirectory` (offline, no Cosmos) agrees: every package PASSes
 * with 0 unregistered keys and 0 collisions, and staged row counts match
 * each section's own stated card count with zero exact-duplicate CSV lines.
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
  },
  {
    dir: "acq-2026-09-22-2100-insider-topps-s1-t91",
    csv: "2026-topps-series-1-1991-topps-baseball.csv",
    expectedRosterCount: 100,
  },
  {
    dir: "acq-2026-09-22-2100-insider-topps-chrome-ra",
    csv: "2026-topps-chrome-rookie-autographs.csv",
    expectedRosterCount: 94,
  },
  {
    dir: "acq-2026-09-22-2100-insider-bowman-chrome-bcp",
    csv: "2026-bowman-chrome-prospects.csv",
    expectedRosterCount: 100,
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

      it("distinct cardNumbers match the section's own stated card count", () => {
        const lines = rawLines(pkg.dir, pkg.csv);
        const cardNumbers = new Set(lines.map((l) => l.split(",")[1]));
        expect(cardNumbers.size).toBe(pkg.expectedRosterCount);
      });
    });
  }
});
