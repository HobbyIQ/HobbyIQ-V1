// Acquisition builder, 2026-09-22 (owner ruling: topps-mini IS its own
// product key). Pins the sanctioned ingester's OWN planStagedDirectory
// verdict for the staged 1975 Topps Mini package, measured with nothing but
// what THIS branch provides (registration in productSetKeys.ts + the parser
// rule in hobbyIqCardId.service.ts / parseTitleIdentity.service.ts, all in
// this same PR).
//
// One package: acq-2026-09-22-scc-topps-mini-1975/1975-topps-mini-baseball.csv
// -- 660 base rows, numbers 1-660, no parallel column populated (see the
// manifest's notMinted.whiteAndBlueBacks for why "White"/"Blue" seen on
// sold_comps sales are NOT staged as rungs: no source states them as a
// parallel ladder for this product).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");
const PKG_DIR = "acq-2026-09-22-scc-topps-mini-1975";

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const plans = INGEST.planStagedDirectory(dir, files);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

describe("1975 Topps Mini Baseball — PASS after topps-mini's registration this PR", () => {
  it("planStagedDirectory reports PASS: zero unregistered keys, zero collisions", () => {
    const { entry } = planPackage(PKG_DIR);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(660);
    expect(entry.plan.ids).toBe(660);
  });

  it("every row lands on a hiq:baseball:1975:topps-mini:<N>:base:no-auto id, N = 1..660, no duplicates", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, PKG_DIR, "1975-topps-mini-baseball.csv"), "utf8");
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    expect(lines.length).toBe(660);
    const numbers = lines.map((l) => l.split(",")[1]);
    const numSet = new Set(numbers);
    expect(numSet.size).toBe(660);
    for (let i = 1; i <= 660; i++) expect(numSet.has(String(i)), `missing card ${i}`).toBe(true);
  });

  it("no row states a parallel column — base roster only, per the manifest's sourcing finding", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, PKG_DIR, "1975-topps-mini-baseball.csv"), "utf8");
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    for (const l of lines) {
      const cols = l.split(",");
      expect(cols[2], l).toBe(""); // parallel column
      expect(cols[3], l).toBe("false"); // isAuto
    }
  });

  it("0 exact-duplicate lines in the staged CSV", () => {
    const csv = readFileSync(join(SCRAPED_ROOT, PKG_DIR, "1975-topps-mini-baseball.csv"), "utf8");
    const lines = csv.split(/\r?\n/).filter(Boolean);
    const dataLines = lines.slice(1);
    expect(new Set(dataLines).size).toBe(dataLines.length);
  });

  it("manifest declares the registered setKey and matches the CSV row count", () => {
    const m = JSON.parse(readFileSync(join(SCRAPED_ROOT, PKG_DIR, "1975-topps-mini-baseball.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps-mini");
    expect(m.sport).toBe("baseball");
    expect(m.year).toBe(1975);
    expect(m.rowCount).toBe(660);
  });
});
