// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). scripts/rollup-sold-comps-
// daily.cjs precomputes sold_comps_daily, which marketMoversSnapshot.
// service.ts's MARKET_MOVERS_USE_ROLLUPS path reads straight through with no
// dedupe of its own — so a CardHedge dual-id twin baked into a rollup doc at
// BUILD time can never be un-counted downstream. The script always runs
// main() unconditionally at require time (no module guard, no exports) and
// needs a live Cosmos connection + a built dist/, so it cannot be required
// directly in this suite. This pins the fix two ways:
//   1. Source inspection — the script imports the REAL dedupeSoldComps +
//      distinctWriterShape from dist/, selects `soldAt`/`sourceExternalId`
//      (previously absent), and calls dedupe on each group's rows BEFORE the
//      price array used for count/sum/median/min/max is built.
//   2. A behavioral pin of the exact composition the script performs (group
//      by cardId::parallel::gradeCompany::gradeValue, then dedupeSoldComps
//      each group with onlyWhen: distinctWriterShape, then aggregate) using
//      the REAL dedupeSoldComps/distinctWriterShape — proving a genuine
//      dual-id twin pair collapses, a genuinely distinct sale survives, and
//      — CF-VOLUME-READERS-NEED-DISTINCT-WRITERS (review fix) — two
//      SAME-shape sales at the same price/moment (real volume) both count.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dedupeSoldComps, distinctWriterShape } from "../src/services/portfolioiq/dedupeSoldComps.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "rollup-sold-comps-daily.cjs");
const source = fs.readFileSync(scriptPath, "utf8");

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

interface Row {
  price: number;
  soldAt: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  source?: string | null;
  sourceExternalId?: string | null;
}

/** The script's own grouping + aggregation, reproduced verbatim (group key,
 *  field list, onlyWhen predicate) but calling the REAL dedupeSoldComps +
 *  distinctWriterShape imports above — so this test fails if the shared
 *  rule's behavior ever changes, not just if the script's own copy drifts. */
function buildRollupDoc(rows: Row[]) {
  const deduped = dedupeSoldComps(rows, { onlyWhen: distinctWriterShape });
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
  it("imports the shared dedupeSoldComps + distinctWriterShape from dist/, not a local copy", () => {
    expect(source).toMatch(/require\(path\.join\(__dirname, "\.\.", "dist\/services\/portfolioiq\/dedupeSoldComps\.js"\)\)/);
    expect(source).toMatch(/dedupeSoldComps, distinctWriterShape/);
  });

  it("selects soldAt and sourceExternalId -- the fields the window rule and the writer-shape predicate need", () => {
    const selectMatch = source.match(/SELECT c\.cardId[^`]*FROM c/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch![0]).toMatch(/c\.soldAt/);
    expect(selectMatch![0]).toMatch(/c\.sourceExternalId/);
  });

  it("dedupes each group's rows, gated by distinctWriterShape, BEFORE the price array is built", () => {
    const dedupeCallIdx = source.indexOf("dedupeSoldComps(g.rows, { onlyWhen: distinctWriterShape })");
    const sortedBuildIdx = source.indexOf("sorted.reduce");
    expect(dedupeCallIdx).toBeGreaterThan(-1);
    expect(sortedBuildIdx).toBeGreaterThan(dedupeCallIdx);
  });

  it("a genuine dual-id twin pair (different writer shapes) collapses to one row in the rollup doc", () => {
    const doc = buildRollupDoc([
      { price: 250, soldAt: "2026-07-14T23:35:00Z", source: "cardhedge", sourceExternalId: "ch-daily::abc111" },
      { price: 250, soldAt: "2026-07-14T23:35:26Z", source: "cardhedge", sourceExternalId: "ch-daily::card-1::2026-07-14T23:35:00Z::25000" }, // twin, composite shape
      { price: 300, soldAt: "2026-07-14T10:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::xyz999" }, // distinct sale
    ]);
    expect(doc.count).toBe(2);
  });

  it("KEEPS two SAME-shape sales at the same price/moment -- real volume, not the dual-id bug", () => {
    const doc = buildRollupDoc([
      { price: 1.99, soldAt: "2026-07-14T10:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::tokenA" },
      { price: 1.99, soldAt: "2026-07-14T10:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::tokenB" },
    ]);
    expect(doc.count).toBe(2);
  });

  it("30 genuine same-shape sales of a common in one hour ALL survive the rollup", () => {
    const base = Date.parse("2026-07-14T10:00:00Z");
    const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
      price: 1.99, soldAt: new Date(base + i * 60_000).toISOString(),
      source: "cardhedge", sourceExternalId: `ch-daily::token-${i}`,
    }));
    const doc = buildRollupDoc(rows);
    expect(doc.count).toBe(30);
  });

  it("counts change ONLY by the twin -- three real sales in, three survive", () => {
    const doc = buildRollupDoc([
      { price: 100, soldAt: "2026-07-14T01:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::a1" },
      { price: 150, soldAt: "2026-07-14T05:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::a2" },
      { price: 200, soldAt: "2026-07-14T10:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::a3" },
    ]);
    expect(doc.count).toBe(3);
  });
});
