import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * PR #2393's census (2026-09-21): checklistinsider ingests (tagged
 * checklistinsider-2026-08-27/-08-29/-08-30, plus bccp and
 * catalog-explode-actuals-*) wrote AUTOGRAPH-set cards as isAuto=false for
 * verified always-auto product-years. Scope: baseball 2025
 * topps-chrome-update-series, prefixes AC-/CRDA-/CHRU-/CLA-.
 *
 * Every listed id was verified READ-ONLY, per id, against all four criteria:
 * (1) source is a defective tag; (2) id ends :no-auto...; (3) a TWIN exists
 * at the same address with :no-auto -> :auto, matching player/cardNumber/
 * parallel/print-run, sourced from a non-defective tag; (4) zero resident
 * sold_comps sales (hobbyiqCardId = id OR cardId = id). Rows failing (3) or
 * (4) are excluded and tallied in this list's census, not listed.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "catalog-relocations", "2026-09-21-unsigned-mint-baseball-2025-topps-chrome-update-series.json"),
    "utf8",
  ),
);

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
const entries = list.entries as CatEntry[];

describe("2026-09-21 unsigned-mint retire list: baseball 2025 topps-chrome-update-series", () => {
  it("is addressed to the catalog lane and is report-only", () => {
    expect(list.forLane).toBe("relocate-catalog-rows-by-list");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("every entry passes the LANE'S OWN classifier — not a second copy of it", () => {
    const lane = path.join(process.cwd(), "scripts", "relocate-catalog-rows-by-list.cjs");
    const L = require_(lane) as { classifyEntry: (e: unknown) => { ok: boolean; why?: string } };
    for (const e of entries) {
      const r = L.classifyEntry(e);
      expect(r.ok, `${e.id}: ${r.why ?? ""}`).toBe(true);
    }
  });

  it("has exactly 1,009 entries, all unique ids", () => {
    expect(entries).toHaveLength(1009);
    expect(new Set(entries.map((e) => e.id)).size).toBe(1009);
    expect(list.census.catalogRowsRetired).toBe(1009);
  });

  it("is a retire-only list — nothing is reslugged and nothing is minted", () => {
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
    }
  });

  it("every id is baseball/2025/topps-chrome-update-series, one of the four verified prefixes, and ends :no-auto (optionally with a print-run and/or a graded suffix)", () => {
    const pattern = /^hiq:baseball:2025:topps-chrome-update-series:(ac|crda|chru|cla)-[a-z0-9-]+:[a-z0-9-]+:no-auto(:num-\d+)?(:(psa|sgc|bgs|cgc)-\d+)?$/;
    for (const e of entries) {
      expect(e.id, e.id).toMatch(pattern);
    }
  });

  it("every entry names a checklistinsider-family defective source and a non-defective :auto twin in its reason/evidence", () => {
    for (const e of entries) {
      expect(e.reason ?? "", e.id).toMatch(/PR #2393/);
      expect(e.evidence ?? "", e.id).toMatch(/:auto/);
      expect(e.evidence ?? "", e.id).toMatch(/zero resident sales/);
    }
  });

  it("the resident-sale exclusions are reported, not routed, and are NOT in the entries list", () => {
    expect(list.census.excludedForResidentSales).toBe(232);
    expect(list.census.salesResidentDetail).toHaveLength(232);
    const listedIds = new Set(entries.map((e) => e.id));
    for (const d of list.census.salesResidentDetail as Array<{ id: string; count: number }>) {
      expect(listedIds.has(d.id), `${d.id} has a resident sale and must not be listed`).toBe(false);
      expect(d.count).toBeGreaterThan(0);
    }
  });

  it("the no-good-twin exclusions are tallied by reason, not listed", () => {
    expect(list.census.excludedNoGoodTwin).toBe(8240);
    expect(list.census.excludedNoGoodTwinReasons["no twin row at :auto id"]).toBe(8240);
    expect(list.census.excludedNoGoodTwinExamples.length).toBeGreaterThanOrEqual(3);
    const listedIds = new Set(entries.map((e) => e.id));
    for (const ex of list.census.excludedNoGoodTwinExamples as Array<{ id: string }>) {
      expect(listedIds.has(ex.id)).toBe(false);
    }
  });

  it("listed + noGoodTwin + hasSales accounts for every defective-source candidate verified", () => {
    expect(entries.length + list.census.excludedNoGoodTwin + list.census.excludedForResidentSales)
      .toBe(list.census.defectiveSourceCandidatesVerified);
  });
});
