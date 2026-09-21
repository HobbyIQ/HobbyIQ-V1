import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * Owner ruling (Drew, 2026-09-21): the 2026 Bowman Chrome "Reptilian Black
 * Refractor /10" parallel is retired from the catalog. It is attested by one
 * website only, is absent from checklistinsider, and 0 of 500 sampled real
 * sale titles for the product ever name it -- the genuine sixth 2026 Bowman
 * Chrome rung at this tier is Fuchsia Refractor /199.
 *
 * Scope measured READ-ONLY 2026-09-21: card_catalog WHERE sport="baseball"
 * AND year=2026 AND LOWER(REPLACE(c.parallel, " ", "-")) = "reptilian-black-
 * refractor" (c.parallel is stored human-form mixed case, never a lowercase
 * slug). 1,090 candidate rows found, all setKey=bowman-chrome. Each id was
 * checked against sold_comps by both hobbyiqCardId = id and cardId = id:
 * 1,087 carry zero resident sales and are listed here; 3 carry exactly one
 * resident sale each and are excluded, reported in census.salesResidentDetail.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "catalog-relocations", "2026-09-21-bcp-reptilian-black-refractor-retire.json"),
    "utf8",
  ),
);

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
const entries = list.entries as CatEntry[];

describe("2026-09-21 BCP Reptilian Black Refractor owner-ruled retire list", () => {
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

  it("has exactly 1,087 entries, all unique ids", () => {
    expect(entries).toHaveLength(1087);
    expect(new Set(entries.map((e) => e.id)).size).toBe(1087);
    expect(list.census.catalogRowsRetired).toBe(1087);
  });

  it("is a retire-only list — nothing is reslugged and nothing is minted", () => {
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
    }
  });

  it("every id matches the exact scope pattern: baseball/2026/bowman-chrome/reptilian-black-refractor, auto or no-auto, optional num-N", () => {
    const pattern = /^hiq:baseball:2026:bowman-chrome:[a-z0-9-]+:reptilian-black-refractor:(auto|no-auto)(:num-\d+)?$/;
    for (const e of entries) {
      expect(e.id, e.id).toMatch(pattern);
    }
  });

  it("byAutoToken census matches the entries (auto vs no-auto split)", () => {
    const auto = entries.filter((e) => /:auto(:num-\d+)?$/.test(e.id)).length;
    const noAuto = entries.filter((e) => /:no-auto(:num-\d+)?$/.test(e.id)).length;
    expect(auto + noAuto).toBe(entries.length);
    expect(list.census.byAutoToken.auto).toBe(auto);
    expect(list.census.byAutoToken["no-auto"]).toBe(noAuto);
  });

  it("every entry cites the owner ruling and the real sixth rung in its reason", () => {
    for (const e of entries) {
      expect(e.reason ?? "", e.id).toMatch(/Owner ruling 2026-09-21/);
      expect(e.reason ?? "", e.id).toMatch(/Fuchsia Refractor.*199/);
    }
  });

  it("every entry's evidence records a per-id sold_comps check with zero resident sales", () => {
    for (const e of entries) {
      expect(e.evidence ?? "", e.id).toMatch(/hobbyiqCardId = id AND cardId = id/);
      expect(e.evidence ?? "", e.id).toMatch(/zero resident sales/);
    }
  });

  it("the 3 resident sold_comps rows found at candidate addresses are reported, not routed, and are NOT in the entries list", () => {
    expect(list.census.salesResidentAtRetiredAddresses).toBe(3);
    expect(list.census.salesResidentDetail).toHaveLength(3);
    const listedIds = new Set(entries.map((e) => e.id));
    for (const d of list.census.salesResidentDetail as Array<{ id: string; count: number }>) {
      expect(listedIds.has(d.id), `${d.id} has a resident sale and must not be listed`).toBe(false);
      expect(d.count).toBeGreaterThan(0);
    }
  });

  it("scope was measured as 1,090 candidates (1,087 listed + 3 excluded for sales)", () => {
    expect(list.census.scopeMeasured).toBe(1090);
    expect(list.census.excludedForResidentSales).toBe(3);
    expect(entries.length + list.census.excludedForResidentSales).toBe(list.census.scopeMeasured);
  });
});
