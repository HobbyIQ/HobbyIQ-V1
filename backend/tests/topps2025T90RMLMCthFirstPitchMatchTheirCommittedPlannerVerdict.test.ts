/**
 * Follow-up acquisition (2026-09-26) chasing the task's named 2025 Topps
 * insert targets (T90/MLM/HA/HL/AA/CTH/FP) against an 11.5% sample of
 * unbacked 2025 `topps` sales. Four of the eight named targets turned out to
 * already be 100% present at checklist authority after point-read
 * verification against card_catalog (T90- base, HA-/LHA-, AA-, HL- --
 * "Heavy Lumber", not "Hall of Legend": that product does not exist on the
 * source page) and are NOT staged anywhere in this PR. The remaining four
 * packages below ARE staged, each after a per-cardNumber sibling-rung-twin
 * check against every other setKey -- for both T90R and MLM, that check
 * found the ENTIRE Series Two roster already checklist-present under
 * `topps-series-2` (source beckett-scraped-2026-08-26), so only the Series
 * One rows are staged in this repo. This test file pins each package's
 * offline planner verdict (row/id counts, zero collisions, zero
 * unregistered keys) the same way topps2025S1S2Inserts[Wave2]... pin their
 * own packages -- it cannot see the live-Cosmos absence/twin result (that
 * needs a container), only that the staged file is internally consistent
 * and would mint the ids this PR's manifests claim.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED = join(__dirname, "..", "data", "checklists", "scraped");

function planDir(dir: string) {
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  return INGEST.planStagedDirectory(dir, files);
}

function csvLines(dir: string, csvName: string): string[] {
  return readFileSync(join(dir, csvName), "utf8").trim().split("\n").slice(1);
}

describe("2025 Topps -- 1990 Topps Baseball Relics, Series One only (T90R-)", () => {
  const DIR = join(SCRAPED, "acq-2026-09-26-2156-insider-bcp-topps-2025-t90-relics");
  const CSV_NAME = "2025-topps-t90-relics.csv";

  it("clean file PASSes offline: 528 rows, 528 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(528);
    expect(entry.plan.ids).toBe(528);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\" (own letter prefix, no clash with base numbering)", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-t90-relics.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("carries ONLY T90R- (Series One) cardNumbers -- 90R2- (Series Two) is excluded in full", () => {
    const lines = csvLines(DIR, CSV_NAME);
    expect(lines.every((l) => l.split(",")[1].startsWith("T90R-"))).toBe(true);
    expect(lines.some((l) => l.split(",")[1].startsWith("90R2-"))).toBe(false);
  });

  it("no row carries the blank base parallel -- the base row is already staged elsewhere", () => {
    const lines = csvLines(DIR, CSV_NAME);
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(false);
  });

  it("every distinct T90R- card carries at most the 6 relic parallel rungs (Blue/Gold/Orange/Black/Red/Platinum)", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const rungs = new Set(lines.map((l) => l.split(",")[2]));
    expect([...rungs].sort()).toEqual(["Black", "Blue", "Gold", "Orange", "Platinum", "Red"].sort());
  });
});

describe("2025 Topps -- Major League Material single-signer relics, Series One only (MLM-)", () => {
  const DIR = join(SCRAPED, "acq-2026-09-26-2156-insider-bcp-topps-2025-mlm");
  const CSV_NAME = "2025-topps-mlm.csv";

  it("clean file PASSes offline: 418 rows, 418 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(418);
    expect(entry.plan.ids).toBe(418);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\"", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-mlm.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("carries ONLY MLM- (Series One) cardNumbers -- MLM2- (Series Two) is excluded in full", () => {
    const lines = csvLines(DIR, CSV_NAME);
    expect(lines.every((l) => l.split(",")[1].startsWith("MLM-"))).toBe(true);
    expect(lines.some((l) => l.split(",")[1].startsWith("MLM2-"))).toBe(false);
  });

  it("is disjoint from the already-staged MLMD2- dual-signer prefix (different product)", () => {
    const lines = csvLines(DIR, CSV_NAME);
    expect(lines.some((l) => l.split(",")[1].startsWith("MLMD2-"))).toBe(false);
  });
});

describe("2025 Topps -- Call to the Hall (CTH-)", () => {
  const DIR = join(SCRAPED, "acq-2026-09-26-2156-insider-bcp-topps-2025-cth");
  const CSV_NAME = "2025-topps-cth.csv";

  it("clean file PASSes offline: 200 rows, 200 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(200);
    expect(entry.plan.ids).toBe(200);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\"", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-cth.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("all 25 cards carry exactly the 8 stated parallel rungs, no blank base row (already staged elsewhere)", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const byCard = new Map<string, string[]>();
    for (const l of lines) {
      const [, cardNumber, parallel] = l.split(",");
      if (!byCard.has(cardNumber)) byCard.set(cardNumber, []);
      byCard.get(cardNumber)!.push(parallel);
    }
    expect(byCard.size).toBe(25);
    for (const rungs of byCard.values()) {
      expect(rungs.sort()).toEqual(["Black", "Blue", "FoilFractor", "Gold", "Green", "Orange", "Pink", "Red"].sort());
    }
  });
});

describe("2025 Topps -- 2024 First Pitch (FP-/FP2-)", () => {
  const DIR = join(SCRAPED, "acq-2026-09-26-2156-insider-bcp-topps-2025-first-pitch");
  const CSV_NAME = "2025-topps-first-pitch.csv";

  it("clean file PASSes offline: 115 rows, 115 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(115);
    expect(entry.plan.ids).toBe(115);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\"", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-first-pitch.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("FP2- cards never carry a FoilFractor row (excluded: already a checklist-grade twin under topps-series-2)", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const fp2Foil = lines.filter((l) => l.split(",")[1].startsWith("FP2-") && l.split(",")[2] === "FoilFractor");
    expect(fp2Foil.length).toBe(0);
  });

  it("FP- (Series One) cards carry the full 8-rung ladder including FoilFractor", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const fp1Foil = lines.filter((l) => l.split(",")[1].startsWith("FP-") && l.split(",")[2] === "FoilFractor");
    expect(fp1Foil.length).toBe(10);
  });
});
