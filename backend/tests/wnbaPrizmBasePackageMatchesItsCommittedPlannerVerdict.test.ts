/**
 * CF-THE-PR-BODY-MUST-BE-TRUE-OF-THE-BRANCH-ALONE, applied to this PR's own
 * package (pattern: beckettPackagesMatchTheirCommittedPlannerVerdict.test.ts,
 * wave1AcquisitionPackagesMatchTheirCommittedPlannerVerdict.test.ts).
 *
 * 2024 Panini Prizm WNBA Basketball (checklistinsider) — the owner's named
 * highest-value single acquisition in this scope: basketball/2024/panini-
 * prizm-wnba had NO base checklist with card numbers in card_catalog at all
 * before this package (55,163 unbacked sales). `panini-prizm-wnba` is
 * already registered under `family: panini-prizm, parent: panini-prizm` in
 * productSetKeys.ts as its OWN product-year address (not an alias of NBA
 * Prizm — owner ruling 2026-09-05: WNBA Prizm never borrows NBA Prizm's
 * ladder), so this package needs no new key registration to PASS.
 *
 * Runs the sanctioned ingester's own `planStagedDirectory` (offline, no
 * Cosmos) against the package directory committed in this PR, using nothing
 * but what this branch itself ships.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");
const PKG_DIR = "acq-2026-09-20-checklistinsider-panini-prizm-wnba-basketball";
const CSV_NAME = "2024-panini-prizm-wnba-basketball.csv";

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

function manifestFor(dirName: string, csvName: string) {
  const path = join(SCRAPED_ROOT, dirName, csvName.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("2024 Panini Prizm WNBA Basketball (checklistinsider) — base + full colour ladder", () => {
  it("planStagedDirectory reports PASS: 4,950 rows, 4,950 ids, 0 unregistered, 0 collisions, 0 duplicatesFolded", () => {
    const { entry } = planPackage(PKG_DIR);
    expect(entry.product).not.toBeNull();
    expect(entry.product.setKey).toBe("panini-prizm-wnba");
    expect(entry.product.sport).toBe("basketball");
    expect(entry.product.year).toBe(2024);
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.reason).toBeNull();
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions.length).toBe(0);
    expect(entry.plan.duplicatesFolded).toBe(0);
    expect(entry.plan.ids).toBe(4950);
    expect(entry.plan.rows).toBe(4950);
  });

  it("carries no heldRows gate — every staged row genuinely belongs to this product's own registered key", () => {
    const m = manifestFor(PKG_DIR, CSV_NAME);
    expect(m.heldRows).toBeUndefined();
  });

  it("manifest declares the 9 insert sets it deliberately withholds, and why", () => {
    const m = manifestFor(PKG_DIR, CSV_NAME);
    expect(m.heldSections.sections.length).toBe(10); // 9 named inserts/autos + Signatures pair counted together is 10 entries as written
    const names = m.heldSections.sections.map((s: { name: string }) => s.name);
    expect(names).toContain("Fireworks");
    expect(names).toContain("Kaleidoscopic");
    for (const s of m.heldSections.sections) {
      expect(s.rosterOverlapVsBase).toMatch(/^0%/);
    }
  });

  it("stages exactly the base category rows, all print runs matching the source's stated ladder", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, PKG_DIR, CSV_NAME), "utf8").trim().split("\n");
    expect(csv[0]).toBe("category,cardNumber,parallel,isAuto,printRun,player");
    expect(csv.length - 1).toBe(4950);
    for (const line of csv.slice(1)) {
      expect(line.startsWith("base,")).toBe(true);
    }
    // Spot-check the extreme ends of the print-run ladder for card #1.
    expect(csv).toContain("base,1,Pulsar Prizms,,499,Jackie Young");
    expect(csv).toContain("base,1,Black Finite Prizms,,1,Jackie Young");
    expect(csv).toContain("base,1,Gold Vinyl Prizms,,1,Jackie Young");
    expect(csv).toContain("base,1,,,,Jackie Young");
  });
});
