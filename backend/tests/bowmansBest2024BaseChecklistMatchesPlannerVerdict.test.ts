/**
 * Pins the committed acq-2026-09-28-beckett-bowmans-best-2024 package to the
 * sanctioned ingester's own offline planner verdict, the same pattern
 * beckettPackagesMatchTheirCommittedPlannerVerdict.test.ts already uses for
 * the sibling 2026-09-19 Beckett packages: run planStagedDirectory (no
 * Cosmos) against exactly what this PR ships, and fail immediately if a
 * future edit to the CSV or the manifest changes what the branch alone can
 * prove.
 *
 * This is the first-ever numbered BASE checklist acquisition for Bowman's
 * Best baseball (any year) -- see the manifest's own gapThisFills note. The
 * setKey `bowmans-best` is already registered in productSetKeys.ts
 * (parent: "bowman"), so this package registers nothing new; the test below
 * pins that registration is real (normalizeSetKey resolves it to itself)
 * rather than merely asserted in prose.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));
const { normalizeSetKey } = require_(join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");
const DIR_NAME = "acq-2026-09-28-beckett-bowmans-best-2024";
const CSV_NAME = "2024-bowmans-best-baseball.csv";

function planPackage() {
  const dir = join(SCRAPED_ROOT, DIR_NAME);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  return { dir, files, entry: plans.get(CSV_NAME) };
}

function manifest() {
  const path = join(SCRAPED_ROOT, DIR_NAME, CSV_NAME.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("2024 Bowman's Best Baseball base checklist (Beckett S3)", () => {
  it("ships exactly one staged CSV", () => {
    const { files } = planPackage();
    expect(files).toEqual([CSV_NAME]);
  });

  it("setKey bowmans-best is already a normalizeSetKey fixed point (no new registration needed)", () => {
    expect(normalizeSetKey("bowmans-best")).toBe("bowmans-best");
  });

  it("planStagedDirectory reports PASS: 100 rows, 100 distinct ids, 0 collisions, 0 unregistered", () => {
    const { entry } = planPackage();
    expect(entry.product).not.toBeNull();
    expect(entry.product.setKey).toBe("bowmans-best");
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2024);
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.reason).toBeNull();
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions.length).toBe(0);
    expect(entry.plan.rows).toBe(100);
    expect(entry.plan.ids).toBe(100);
    expect(entry.plan.duplicatesFolded).toBe(0);
  });

  it("carries no heldRows gate — the whole staged file is this product's own base checklist", () => {
    const m = manifest();
    expect(m.heldRows).toBeUndefined();
  });

  it("CSV has the required header and no duplicate card numbers", () => {
    const { dir } = planPackage();
    const raw = readFileSync(join(dir, CSV_NAME), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[0]).toBe("category,cardNumber,parallel,isAuto,printRun,player");
    const rows = lines.slice(1).map((l) => l.split(","));
    expect(rows.length).toBe(100);
    const numbers = rows.map((r) => r[1]);
    expect(new Set(numbers).size).toBe(100);
    // 70 plain-numbered base veterans/rookies (#1-70) + 30 TP-prefixed Top
    // Prospects (TP-1..TP-30), matching the source's own stated split.
    expect(numbers.filter((n) => /^\d+$/.test(n)).length).toBe(70);
    expect(numbers.filter((n) => /^TP-\d+$/.test(n)).length).toBe(30);
    // Base-only package: no autos, no print runs, no named parallel in this file.
    for (const r of rows) {
      expect(r[3]).toBe("false");
      expect(r[4]).toBe("");
      expect(r[2]).toBe("");
    }
  });

  it("manifest states the setKey is already registered and cites the gap this backs", () => {
    const m = manifest();
    expect(m.setKey).toBe("bowmans-best");
    expect(m.setKeyConfirmed).toMatch(/already registered/i);
    expect(m.gapThisFills).toMatch(/24,422/);
    expect(m.readyToIngest).toBe(true);
    expect(Array.isArray(m.heldOut)).toBe(true);
    expect(m.heldOut.length).toBeGreaterThan(0);
  });
});
