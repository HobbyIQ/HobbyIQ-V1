/**
 * R40 acquisition (Drew, ruling 2026-09-15; dispatched 2026-09-20): Topps
 * flagship BASEBALL, the biggest unbacked-sales cells. This PR: 2025 and 2023
 * Topps Series 1 Baseball, sourced from Beckett's S3 origin and converted with
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
 * This test also exercises converter fixes made in the same PR (FOOTNOTE_LINE,
 * HEDGE_PRINT_RUN_FOOTNOTE, the new parseRung evidence classes
 * statesTotalCopies/statesDistributionOnly, and -- added in review --
 * masterRosterFor + the widened SELECT_CARDS_ONLY_NOTE, which stop a
 * restricted rung ("Clear - /10 (select cards, see below; hobby only)") from
 * being stamped across the whole 330-card base roster instead of the 100
 * cards this workbook's own Master sheet lists under that name) indirectly:
 * the committed CSVs are the converter's OWN output against the real fetched
 * xlsx files, so a regression in any of those fixes changes the staged rows
 * and this test's row/id counts would drift.
 *
 * setKey is bare "topps" per Drew's 2026-09-20 ruling: Topps flagship is ONE
 * key -- Series 1 and Series 2 base + inserts live under `topps`; Update
 * Series stays `topps-update-series`. `topps-series-1` (D23's own product
 * table) is registered as a distinct sibling key but is NOT what this
 * ruling assigns to these packages.
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

describe("2025 Topps Series 1 Baseball (Beckett S3)", () => {
  const DIR = "acq-2026-09-20-beckett-topps-series1-2025-baseball";

  it("clean file PASSes: 2,353 rows, 2,353 distinct ids, 0 collisions, 0 unregistered", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2025-topps-series1-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(2353);
    expect(entry.plan.ids).toBe(2353);
    expect(entry.plan.collisions.length).toBe(0);
    expect(entry.plan.unregistered).toEqual([]);
  });

  it("held file (Dancing Dodgers page disagreement, 4 rows) is REFUSEd by the planner and gated by heldRows", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2025-topps-series1-baseball-dancing-dodgers-disagreement.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    expect(entry.plan.rows).toBe(4);
    const m = manifestFor(DIR, "2025-topps-series1-baseball-dancing-dodgers-disagreement.csv");
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.rows).toBe(4);
    expect(m.heldRows.reason).toMatch(/Dancing Dodgers/);
    expect(m.heldRows.reason).toMatch(/Mookie Betts/);
  });

  it("both files use bare setKey \"topps\" (not topps-series-1) per Drew's 2026-09-20 ruling: Topps flagship is one key, Series 1 + Series 2 both live under it", () => {
    const m = manifestFor(DIR, "2025-topps-series1-baseball.csv");
    expect(m.setKey).toBe("topps");
  });
});

describe("2023 Topps Series 1 Baseball (Beckett S3)", () => {
  const DIR = "acq-2026-09-20-beckett-topps-series1-2023-baseball";

  it("clean file PASSes: 9,670 rows, 9,670 distinct ids, 0 collisions, 0 unregistered", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2023-topps-series1-baseball.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(9670);
    expect(entry.plan.ids).toBe(9670);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("REVIEW FIX: Clear -/10 (select cards, see below; hobby only) is a restricted rung -- emitted for exactly the 100 cards this workbook's Master sheet lists under 'Clear', never all 330 base cards", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, DIR, "2023-topps-series1-baseball.csv"),
      "utf8",
    );
    const clearRows = csv.split("\n").filter((l) => l.startsWith("base,") && l.includes(",Clear,"));
    expect(clearRows.length).toBe(100);
    // #2 (Zach Thompson) is NOT in the Master-stated Clear roster -- must
    // never get a fabricated Clear row, the exact defect this fix closes.
    expect(csv).not.toMatch(/^base,2,Clear,/m);
    // #1 (Juan Soto) IS in the Master-stated Clear roster.
    expect(csv).toMatch(/^base,1,Clear,false,10,Juan Soto$/m);
  });

  it("held file (PPA- cross-product initials collision, 49 rows) is REFUSEd with the 3 unregistered keys and gated by heldRows", () => {
    const { plans } = planDir(DIR);
    const entry = plans.get("2023-topps-series1-baseball-ppa-collision.csv");
    expect(entry.plan.verdict).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    expect(entry.plan.rows).toBe(49);
    expect(entry.plan.collisions.length).toBe(6);
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual([
      "topps-patchwork-of-the-past-commemorative-patch-cards-autographs",
      "topps-patchwork-of-the-past-commemorative-patch-cards-autographs-2",
      "topps-postseason-performance-autographs",
    ]);
    const m = manifestFor(DIR, "2023-topps-series1-baseball-ppa-collision.csv");
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.rows).toBe(49);
    expect(m.heldRows.reason).toMatch(/PPA-/);
  });
});
