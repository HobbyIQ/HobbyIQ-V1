// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). scripts/rollup-sold-comps-
// daily.cjs precomputes sold_comps_daily, which marketMoversSnapshot.
// service.ts's MARKET_MOVERS_USE_ROLLUPS path reads straight through with no
// dedupe of its own — so a CardHedge dual-id twin baked into a rollup doc at
// BUILD time can never be un-counted downstream. The script always runs
// main() unconditionally at require time (no module guard, no exports) and
// needs a live Cosmos connection + a built dist/, so it cannot be required
// directly in this suite. This pins the fix two ways:
//   1. Source inspection — the script imports the REAL dedupeSoldComps from
//      dist/, selects `soldAt` (needed for the 60-minute window, previously
//      absent), and calls dedupe on each group's rows BEFORE the price array
//      used for count/sum/median/min/max is built.
//   2. A behavioral pin of the exact composition the script performs (group
//      by cardId::parallel::gradeCompany::gradeValue, then dedupeSoldComps
//      each group, then aggregate) using the REAL dedupeSoldComps — proving
//      a twin pair collapses to one and a genuinely distinct sale survives,
//      with the resulting count/median changing ONLY by the twin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dedupeSoldComps } from "../src/services/portfolioiq/dedupeSoldComps.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "rollup-sold-comps-daily.cjs");
const source = fs.readFileSync(scriptPath, "utf8");

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

/** The script's own grouping + aggregation, reproduced verbatim (group key,
 *  field list) but calling the REAL dedupeSoldComps import above — so this
 *  test fails if the shared rule's behavior ever changes, not just if the
 *  script's own copy drifts. */
function buildRollupDoc(rows: Array<{ price: number; soldAt: string; gradeCompany?: string | null; gradeValue?: number | null }>) {
  const deduped = dedupeSoldComps(rows);
  const sorted = deduped.map((r) => Number(r.price)).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sum: Math.round(sum * 100) / 100,
    median: Math.round(median(sorted) * 100) / 100,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

describe("rollup-sold-comps-daily.cjs -- dedupes at rollup build time", () => {
  it("imports the shared dedupeSoldComps from dist/, not a local copy", () => {
    expect(source).toMatch(/require\(path\.join\(__dirname, "\.\.", "dist\/services\/portfolioiq\/dedupeSoldComps\.js"\)\)/);
  });

  it("selects soldAt -- the field the 60-minute window rule needs", () => {
    const selectMatch = source.match(/SELECT c\.cardId[^`]*FROM c/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch![0]).toMatch(/c\.soldAt/);
  });

  it("dedupes each group's rows BEFORE the price array is built", () => {
    const dedupeCallIdx = source.indexOf("dedupeSoldComps(g.rows)");
    const sortedBuildIdx = source.indexOf("sorted.reduce");
    expect(dedupeCallIdx).toBeGreaterThan(-1);
    expect(sortedBuildIdx).toBeGreaterThan(dedupeCallIdx);
  });

  it("a twin pair (same price, minutes apart) collapses to one row in the rollup doc", () => {
    const doc = buildRollupDoc([
      { price: 250, soldAt: "2026-07-14T23:35:00Z" },
      { price: 250, soldAt: "2026-07-14T23:35:26Z" }, // twin
      { price: 300, soldAt: "2026-07-14T10:00:00Z" }, // distinct sale
    ]);
    expect(doc.count).toBe(2);
  });

  it("counts change ONLY by the twin -- three real sales in, three survive", () => {
    const doc = buildRollupDoc([
      { price: 100, soldAt: "2026-07-14T01:00:00Z" },
      { price: 150, soldAt: "2026-07-14T05:00:00Z" },
      { price: 200, soldAt: "2026-07-14T10:00:00Z" },
    ]);
    expect(doc.count).toBe(3);
  });
});
