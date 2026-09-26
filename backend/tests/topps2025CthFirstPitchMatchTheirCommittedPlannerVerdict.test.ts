/**
 * Follow-up acquisition (2026-09-26) chasing the task's named 2025 Topps
 * insert targets (T90/MLM/HA/HL/AA/CTH/FP) against an 11.5% sample of
 * unbacked 2025 `topps` sales. Six of the eight named targets turned out to
 * already be 100% present at checklist authority (T90- base, T90R-/90R2-
 * relics, MLM-/MLM2- single-signer relics, HA-/LHA-, AA-, HL- -- "Heavy
 * Lumber", not "Hall of Legend": that product does not exist on the source
 * page) and are NOT staged anywhere in this PR.
 *
 * CORRECTION (PR #2433 review, 2026-09-26): the first pass staged T90R- and
 * MLM- packages (528 and 418 rows) believing them genuinely absent. Both
 * were WRONG -- independent point-read found the full 6-rung ladder for
 * both prefixes already checklist-present under `topps`,
 * source=checklistcenter-2026-08-29. Root cause: the absence check hardcoded
 * `printRun: null` for every row instead of reading it off the CSV, so every
 * numbered parallel rung was checked at the wrong id (missing the `:num-N`
 * segment `computeHobbyIqCardId` appends whenever printRun is a number) and
 * 404'd unconditionally. Both packages are deleted in full; see this repo's
 * `backend/scripts/verify-absent.cjs` for the corrected, printRun-aware
 * verifier and each remaining package's manifest for its own verifier
 * output.
 *
 * The two packages below (CTH-, FP-/FP2-) survive, but SMALLER than first
 * staged: the same printRun bug meant their FoilFractor rungs (which also
 * carry a real printRun) were wrongly staged as absent too. Corrected row
 * counts: CTH- 175 (was 200), FP-/FP2- 105 (was 115).
 *
 * This test file pins each package's offline planner verdict (row/id
 * counts, zero collisions, zero unregistered keys) the same way
 * topps2025S1S2Inserts[Wave2]... pin their own packages -- it cannot see the
 * live-Cosmos absence/twin result (that needs a container, see
 * verify-absent.cjs), only that the staged file is internally consistent
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

describe("2025 Topps -- Call to the Hall (CTH-)", () => {
  const DIR = join(SCRAPED, "acq-2026-09-26-2156-insider-bcp-topps-2025-cth");
  const CSV_NAME = "2025-topps-cth.csv";

  it("clean file PASSes offline: 175 rows, 175 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(175);
    expect(entry.plan.ids).toBe(175);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\"", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-cth.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("all 25 cards carry exactly the 7 stated parallel rungs -- no blank base, no FoilFractor (both already checklist-present)", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const byCard = new Map<string, string[]>();
    for (const l of lines) {
      const [, cardNumber, parallel] = l.split(",");
      if (!byCard.has(cardNumber)) byCard.set(cardNumber, []);
      byCard.get(cardNumber)!.push(parallel);
    }
    expect(byCard.size).toBe(25);
    for (const rungs of byCard.values()) {
      expect(rungs.sort()).toEqual(["Black", "Blue", "Gold", "Green", "Orange", "Pink", "Red"].sort());
    }
    expect(lines.some((l) => l.split(",")[2] === "FoilFractor")).toBe(false);
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(false);
  });
});

describe("2025 Topps -- 2024 First Pitch (FP-/FP2-)", () => {
  const DIR = join(SCRAPED, "acq-2026-09-26-2156-insider-bcp-topps-2025-first-pitch");
  const CSV_NAME = "2025-topps-first-pitch.csv";

  it("clean file PASSes offline: 105 rows, 105 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(105);
    expect(entry.plan.ids).toBe(105);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is bare \"topps\"", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-first-pitch.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps");
  });

  it("no FP- (Series One) row carries FoilFractor -- already checklist-present under topps itself", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const fp1Foil = lines.filter((l) => l.split(",")[1].startsWith("FP-") && !l.split(",")[1].startsWith("FP2-") && l.split(",")[2] === "FoilFractor");
    expect(fp1Foil.length).toBe(0);
  });

  it("no FP2- (Series Two) row carries FoilFractor -- already a checklist-grade twin under topps-series-2", () => {
    const lines = csvLines(DIR, CSV_NAME);
    const fp2Foil = lines.filter((l) => l.split(",")[1].startsWith("FP2-") && l.split(",")[2] === "FoilFractor");
    expect(fp2Foil.length).toBe(0);
  });

  it("no row carries the blank base parallel -- already checklist-present under topps", () => {
    const lines = csvLines(DIR, CSV_NAME);
    expect(lines.some((l) => l.split(",")[2] === "")).toBe(false);
  });
});

describe("2025 Topps -- T90R-/MLM- packages are gone (deleted after review found them fully present)", () => {
  it("no acq-2026-09-26 T90R or MLM package directory exists in this repo", () => {
    const entries = readdirSync(SCRAPED);
    expect(entries.some((e) => /2025-t90-relics/.test(e))).toBe(false);
    expect(entries.some((e) => /2025-mlm/.test(e))).toBe(false);
  });
});
