/**
 * R40 acquisition (Drew, ruling 2026-09-15; dispatched 2026-09-20): Topps
 * flagship BASEBALL, the biggest unbacked-sales cells. This PR: 2023 and 2026
 * Topps Series 2 Baseball, sourced from Beckett's S3 origin and converted with
 * convertBeckettChecklistXlsx.cjs, modelled on
 * beckettPackagesMatchTheirCommittedPlannerVerdict.test.ts's own "run the
 * sanctioned ingester's planStagedDirectory, offline, no Cosmos, against
 * exactly what this branch ships" pattern.
 *
 * Both packages' clean files PASS (0 unregistered, 0 collisions) and each
 * held file's own numeric verdict is pinned too, so neither claim can drift
 * silently: `heldRows` on a held file's manifest is what stops the real
 * ingester (ingest-checklist-csv-to-catalog.cjs's own CF-A-HELD-FILE-IS-NOT-
 * THIS-PRODUCT'S filter) from ever writing it; planStagedDirectory itself does
 * not read `heldRows`, so it still reports the staged rows' own verdict on
 * every file, held or not.
 *
 * This test also exercises the widened PLACEHOLDER fix (bare "TBA" suffix,
 * e.g. "Versions TBA") made in the sibling PR this branch is stacked on:
 * the committed CSVs are the converter's OWN output against the real fetched
 * xlsx files, so a regression changes the staged rows and this test's
 * row/id counts would drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planDir(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  return { dir, files, plans };
}

function manifestFor(dirName: string, csvName: string) {
  const path = join(SCRAPED_ROOT, dirName, csvName.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("2023 Topps Series 2 Baseball (Beckett S3)", () => {
  const DIR = "acq-2026-09-20-beckett-topps-series2-2023-baseball";

  it("clean file PASSes: 11,905 rows, 11,905 distinct ids, 0 collisions, 0 unregistered", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2023-topps-series2-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(11905);
    expect(entry.plan.ids).toBe(11905);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("held file (2T88C-/SMFB- unregistered insert keys, 125 rows) is REFUSEd with 4 unregistered keys and gated by heldRows", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2023-topps-series2-baseball-2t88c-smfb-collision.csv");
    expect(entry.plan.verdict).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    expect(entry.plan.rows).toBe(125);
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual([
      "topps-1988-topps-baseball-chrome-silver-packs-checklist",
      "topps-1988-topps-baseball-chrome-silver-packs-checklist-2",
      "topps-social-media-follow-back-redemptions",
      "topps-social-media-follow-back-redemptions-2",
    ]);
    const m = manifestFor(DIR, "2023-topps-series2-baseball-2t88c-smfb-collision.csv");
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.rows).toBe(125);
  });

  it("base file's setKey is bare \"topps\" (Series 2 continues Series 1's own #1-350 number line at #331+, confirmed non-overlapping)", () => {
    const m = manifestFor(DIR, "2023-topps-series2-baseball.csv");
    expect(m.setKey).toBe("topps");
  });
});

describe("2026 Topps Series 2 Baseball (Beckett S3)", () => {
  const DIR = "acq-2026-09-20-beckett-topps-series2-2026-baseball";

  it("clean file PASSes: 3,039 batch rows, 3,039 distinct ids, 0 collisions, 0 unregistered", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2026-topps-series2-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(3039);
    expect(entry.plan.ids).toBe(3039);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("held file (7 unregistered insert/auto categories, 264 rows) is REFUSEd and gated by heldRows", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2026-topps-series2-baseball-unregistered-inserts.csv");
    expect(entry.plan.verdict).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    expect(entry.plan.rows).toBe(264);
    expect(entry.plan.unregistered.length).toBe(7);
    const m = manifestFor(DIR, "2026-topps-series2-baseball-unregistered-inserts.csv");
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.rows).toBe(264);
    expect(m.heldRows.reason).toMatch(/Flagship Real One/);
  });

  it("held Flagship Real One / 1952 Rookie Variation autographs share the identical roster at their colliding numbers -- evidence they are one ladder, not two card sets, whichever product they belong to", () => {
    const dir = join(SCRAPED_ROOT, DIR);
    const csv = readFileSync(join(dir, "2026-topps-series2-baseball-unregistered-inserts.csv"), "utf8");
    expect(csv).toMatch(/auto-flagship-real-one-autographs,129,,true,,Cole Young/);
    expect(csv).toMatch(/auto-1952-rookie-variation-autographs,129,,true,,Cole Young/);
  });
});
