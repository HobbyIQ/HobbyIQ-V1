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
 * RULED (Drew, 2026-09-28, on PR #2477): this package's insert setKey
 * ('donruss-the-rookies') is now a productSetKeys.ts registration -- see
 * backend/tests/donrussTheRookiesEraRuling.test.ts for the registration/
 * era-spelling pins. This manifest's own `setKey` field was updated to the
 * registered key itself, so planFile stamps every row onto its own address
 * from the start; the isolated-file assertions below were re-measured
 * against that registered key and against the flagship package staged in
 * the SAME directory (the collision this key exists to resolve).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("planStagedDirectory PASSES this file in isolation: registered 'donruss-the-rookies' product key, zero collisions, 55 rows/55 ids", () => {
    const { entry } = planPackage();
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(1987);
    expect(entry.product.setKey).toBe("donruss-the-rookies");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(55);
    expect(entry.plan.ids).toBe(55);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.unregistered).toEqual([]);
    // Every row already lands on its OWN registered address -- there is no
    // sibling category in this cell to separate against, and none is needed:
    // the key itself, not a same-cell separation step, is what keeps this
    // set off the flagship's bare 'donruss' address.
    expect(entry.plan.separate.size).toBe(0);
  });

  it("planStagedDirectory PASSES BOTH files staged together with the flagship package: zero collisions, zero unregistered keys, 'the-rookies' no longer in either file's separate set", () => {
    // The exact shape the manifest's pre-ruling setKeyRulingNote measured as
    // a blind spot: this set's #14 (Bo Jackson) vs the flagship's own #14
    // (Kevin McReynolds DK) would collide on a shared bare 'donruss' address.
    // Registering 'donruss-the-rookies' resolves it by giving this file its
    // own address from the start, so nothing needs to be separated at
    // ingest time anymore.
    const flagshipDir = join(SCRAPED_ROOT, "acq-2026-09-13-bcp");
    const flagshipCsv = "1987-donruss-baseball.csv";
    const flagshipManifest = "1987-donruss-baseball.manifest.json";

    const combined = mkdtempSync(join(tmpdir(), "donruss-the-rookies-1987-combined-"));
    copyFileSync(join(SCRAPED_ROOT, PACKAGE_DIR, CSV_NAME), join(combined, CSV_NAME));
    copyFileSync(
      join(SCRAPED_ROOT, PACKAGE_DIR, "1987-donruss-the-rookies.manifest.json"),
      join(combined, "1987-donruss-the-rookies.manifest.json"),
    );
    copyFileSync(join(flagshipDir, flagshipCsv), join(combined, flagshipCsv));
    copyFileSync(join(flagshipDir, flagshipManifest), join(combined, flagshipManifest));

    const files = readdirSync(combined).filter((f: string) => f.endsWith(".csv"));
    expect(files.sort()).toEqual([flagshipCsv, CSV_NAME].sort());
    const plans = INGEST.planStagedDirectory(combined, files);

    const rookiesEntry = plans.get(CSV_NAME);
    const flagshipEntry = plans.get(flagshipCsv);
    expect(rookiesEntry.plan.verdict, JSON.stringify(rookiesEntry.plan.unregistered)).toBe("pass");
    expect(flagshipEntry.plan.verdict, JSON.stringify(flagshipEntry.plan.unregistered)).toBe("pass");
    expect(rookiesEntry.plan.collisions).toEqual([]);
    expect(flagshipEntry.plan.collisions).toEqual([]);
    expect(rookiesEntry.plan.unregistered).toEqual([]);
    expect(flagshipEntry.plan.unregistered).toEqual([]);
    // The whole point of the ruling: 'the-rookies' no longer shows up as
    // something that needs separating, on either file, because both already
    // sit on their own registered, distinct addresses.
    expect(rookiesEntry.plan.separate.has("the-rookies")).toBe(false);
    expect(flagshipEntry.plan.separate.has("the-rookies")).toBe(false);
  });
});
