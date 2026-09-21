/**
 * Follow-up acquisition (2026-09-21): 2026 Topps Chrome Black Baseball.
 * Diagnosed from a sold_comps sample under baseball/2026/topps-chrome: 9
 * distinct ids named 6 Topps Chrome Black insert prefixes (dam-, sfa-, dod-,
 * noc-, cba-, iva-). Sourced full base+ladder CSVs for all 6 sets from
 * checklistinsider.com, then ran a full point-read verification pass
 * against live card_catalog BEFORE staging anything.
 *
 * That check found 5 of 6 sets (CBA/Autographs, SFA/Super Futures
 * Autographs, DAM/Damascus, DOD/Depth of Darkness, NOC/Nocturnal -- 1,886
 * rows) are ALREADY FULLY STAGED under the correct topps-chrome-black key.
 * Only Ivory Autographs (IVA-) was missing two rungs (Orange Trim Refractor,
 * Red Trim Refractor) across 34 of its 36 cards -- its base row and
 * SuperFractor row already exist. This package stages ONLY those 68 rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const DIR = join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-21-checklistinsider-topps-chrome-black-2026-inserts");
const CSV_NAME = "2026-topps-chrome-black-inserts.csv";

function planDir(dir: string) {
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  return INGEST.planStagedDirectory(dir, files);
}

function csvLines(): string[] {
  return readFileSync(join(DIR, CSV_NAME), "utf8").trim().split("\n").slice(1);
}

describe("2026 Topps Chrome Black Baseball Ivory Autographs missing rungs (checklistinsider)", () => {
  it("clean file PASSes offline: 68 rows, 68 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(68);
    expect(entry.plan.ids).toBe(68);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is topps-chrome-black, already registered as a top-level product -- no new key minted this PR", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2026-topps-chrome-black-inserts.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps-chrome-black");
  });

  it("HARD CHECK: 0 byte-identical duplicate CSV lines", () => {
    const lines = csvLines();
    const seen = new Set(lines);
    expect(seen.size).toBe(lines.length);
  });

  it("HARD CHECK: every row is isAuto=true (Ivory Autographs is an on-card autograph set)", () => {
    const lines = csvLines();
    for (const l of lines) {
      expect(l.split(",")[3], l).toBe("true");
    }
  });

  it("no CBA-/SFA-/DAM-/DOD-/NOC- rows are present -- those 5 sets were confirmed already fully staged and are deliberately NOT re-staged", () => {
    const lines = csvLines();
    for (const prefix of ["CBA-", "SFA-", "DAM-", "DOD-", "NOC-"]) {
      expect(lines.some((l) => l.split(",")[1].startsWith(prefix)), `unexpected ${prefix} row`).toBe(false);
    }
  });

  it("only Orange Trim Refractor and Red Trim Refractor rungs are staged -- no base or SuperFractor rows (already staged elsewhere)", () => {
    const lines = csvLines();
    const parallels = new Set(lines.map((l) => l.split(",")[2]));
    expect(parallels).toEqual(new Set(["Orange Trim Refractor", "Red Trim Refractor"]));
  });
});
