/**
 * 1987 Donruss "The Rookies" (baseballalmanac, cross-checked against
 * BaseballCardPedia + Wax Pack Gods), staged 2026-09-28: one of four
 * checklist acquisitions Drew ordered that day to close the 21,882-row
 * unbacked-sales gap at cell 1987|panini-donruss.
 *
 * This is a 56-card DEALER-ONLY BOXED SET, distinct from the 660-card 1987
 * Donruss base/flagship set (already staged separately in
 * acq-2026-09-13-bcp/1987-donruss-baseball.csv and NOT touched by this
 * package). Card #56 ("Checklist") is the set's own checklist card, not a
 * player, and is held out -- 55 rows staged.
 *
 * Follows the pattern in
 * cbcVintage1982And1985DonrussAnd1989HoopsPlannerVerdict.test.ts: pins the
 * sanctioned ingester's OWN planStagedDirectory verdict for this package,
 * measured with nothing but what THIS branch provides.
 *
 * UNLIKE the 1982/1985 siblings, this package's insert setKey
 * ('donruss-the-rookies') is NOT a productSetKeys.ts registration -- see the
 * manifest's setKeyNeedsRuling/setKeyRulingNote for the two proposed options
 * awaiting Drew's ruling. Measured directly here: planStagedDirectory PASSES
 * this file in isolation (nothing to separate against in an empty cell,
 * every row lands on the bare 'donruss' key) -- the mechanical guard is not
 * a safety net for this shape, which is exactly why the manifest gates
 * ingest on a human ruling rather than on the tool's own verdict.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");
const PACKAGE_DIR = "acq-2026-09-28-baseballalmanac-donruss-the-rookies-1987";
const CSV_NAME = "1987-donruss-the-rookies.csv";

function planPackage() {
  const dir = join(SCRAPED_ROOT, PACKAGE_DIR);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  expect(files.length, `${PACKAGE_DIR} must have exactly one staged CSV`).toBe(1);
  expect(files[0]).toBe(CSV_NAME);
  const plans = INGEST.planStagedDirectory(dir, files);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

function csvRows(): string[] {
  const csv = readFileSync(join(SCRAPED_ROOT, PACKAGE_DIR, CSV_NAME), "utf8");
  return csv.split(/\r?\n/).filter(Boolean).slice(1); // drop header
}

describe("1987 Donruss The Rookies (baseballalmanac) — staged, ruling pending", () => {
  it("has the required CSV columns in the sanctioned header order", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, PACKAGE_DIR, CSV_NAME), "utf8");
    const header = csv.split(/\r?\n/)[0];
    expect(header).toBe("category,cardNumber,parallel,isAuto,printRun,player");
  });

  it("stages exactly 55 rows — #1-55, no duplicates, #56 (the checklist card) held out", () => {
    const rows = csvRows();
    expect(rows.length).toBe(55);
    const nums = rows.map((l) => Number(l.split(",")[1]));
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(55);
    expect(new Set(nums).size).toBe(55);
    expect(nums.includes(56)).toBe(false);
  });

  it("every row is category=insert-the-rookies, isAuto=false, no blank player", () => {
    const rows = csvRows();
    expect(rows.every((l) => l.startsWith("insert-the-rookies,"))).toBe(true);
    for (const l of rows) {
      const [, , , isAuto, , player] = l.split(",");
      expect(isAuto).toBe("false");
      expect(player && player.trim().length > 0).toBe(true);
    }
  });

  it("carries the set's known key cards (Bo Jackson #14, Greg Maddux #52, Mark McGwire #1)", () => {
    const rows = csvRows();
    expect(rows.find((l) => l.startsWith("insert-the-rookies,14,"))).toContain("Bo Jackson");
    expect(rows.find((l) => l.startsWith("insert-the-rookies,52,"))).toContain("Greg Maddux");
    expect(rows.find((l) => l.startsWith("insert-the-rookies,1,"))).toContain("Mark McGwire");
  });

  it("planStagedDirectory PASSES this file in isolation: bare 'donruss' product key, zero collisions, 55 rows/55 ids", () => {
    const { entry } = planPackage();
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(1987);
    expect(entry.product.setKey).toBe("donruss");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(55);
    expect(entry.plan.ids).toBe(55);
    expect(entry.plan.collisions).toEqual([]);
    // In isolation there is no sibling category to separate against, so the
    // planner does NOT derive the insert's own key here -- it lands every
    // row on the bare product key. This is the exact blind spot the
    // manifest's setKeyRulingNote documents: a clean isolated PASS is not
    // proof this file is safe to ingest once the flagship package (which
    // shares numbers, e.g. #14) is in the same run.
    expect(entry.plan.separate.size).toBe(0);
  });
});
