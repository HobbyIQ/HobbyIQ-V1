/**
 * Bowman-family baseball checklist-gap acquisition (2026-09-21). Follows the
 * pattern in upperDeckHockeySeries2ExtendedPlannerVerdict.test.ts and
 * toppsSeries1BaseballLaddersMatchTheirCommittedPlannerVerdict.test.ts: pins
 * the sanctioned ingester's OWN planStagedDirectory verdict for each package
 * this PR ships, measured with nothing but what THIS branch provides.
 *
 * Diagnosis (bounded, read-only: single small TOP queries by sport/cardYear/
 * setName against sold_comps, point-reads against card_catalog by
 * hobbyiqCardId, NEVER cross-partition COUNT/GROUP BY) of ~300-sale samples
 * per cell found the unbacked sales dominated by ladder-completeness gaps in
 * four cells, closed by these three packages:
 *
 *   - 2026 Bowman Mega Box Baseball: full 17-rung Mojo Refractor colour
 *     ladder applied across the mega box's own 268-card base roster; catalog
 *     had a partial, mismatched assignment (e.g. BCP-116 only under Yellow
 *     Mojo Refractor while sales for BCP-116 were Green Mojo Refractor).
 *   - 2025 Bowman Draft Sapphire Baseball: CPA-/SS-/SSA-/BDC- rosters
 *     expanded against their own four stated ladders (Sapphire colour +
 *     Padparadscha + SuperFractor rungs).
 *   - 2026 Bowman Baseball ladders (two files, one dir): BCP- Reptilian
 *     Refractor 6-colour ladder filled for the 57 (of 133) card numbers that
 *     had zero Reptilian rung despite the ladder being well-established for
 *     the other 76; BP- Border/Pattern 20-rung ladder filled for the 125 (of
 *     150) card numbers missing it entirely.
 *
 * All four setKeys (bowman-mega, bowman-draft, bowman, bowman-chrome) were
 * already registered in productSetKeys.ts before this PR -- no registrations
 * made here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  return { dir, files, plans };
}

describe("2026 Bowman Mega Box Baseball Mojo ladder — PASS", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { files, plans } = planPackage("acq-2026-09-21-checklistinsider-bowman-mega-box-mojo-ladder-2026");
    expect(files.length).toBe(1);
    const entry = plans.get(files[0]);
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2026);
    expect(entry.product.setKey).toBe("bowman-mega");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(3852);
  });
});

describe("2025 Bowman Draft Sapphire Baseball ladder — PASS", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { files, plans } = planPackage("acq-2026-09-21-checklistinsider-bowman-draft-sapphire-ladder-2025");
    expect(files.length).toBe(1);
    const entry = plans.get(files[0]);
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2025);
    expect(entry.product.setKey).toBe("bowman-draft");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(1445);
  });
});

describe("2026 Bowman Baseball ladders (Border + Reptilian) — PASS", () => {
  it("planStagedDirectory reports zero collisions across both sibling files in the shared cell", () => {
    const { files, plans } = planPackage("acq-2026-09-21-checklistinsider-bowman-2026-ladders");
    expect(files.sort()).toEqual([
      "2026-bowman-baseball-border-ladder.csv",
      "2026-bowman-chrome-baseball-reptilian-ladder.csv",
    ]);

    const borderEntry = plans.get("2026-bowman-baseball-border-ladder.csv");
    expect(borderEntry.product.setKey).toBe("bowman");
    expect(borderEntry.product.year).toBe(2026);
    expect(borderEntry.plan.unregistered).toEqual([]);
    expect(borderEntry.plan.collisions).toEqual([]);
    expect(borderEntry.plan.rows).toBe(2161);

    const reptilianEntry = plans.get("2026-bowman-chrome-baseball-reptilian-ladder.csv");
    expect(reptilianEntry.product.setKey).toBe("bowman-chrome");
    expect(reptilianEntry.product.year).toBe(2026);
    expect(reptilianEntry.plan.unregistered).toEqual([]);
    expect(reptilianEntry.plan.collisions).toEqual([]);
    expect(reptilianEntry.plan.rows).toBe(342);
  });
});
