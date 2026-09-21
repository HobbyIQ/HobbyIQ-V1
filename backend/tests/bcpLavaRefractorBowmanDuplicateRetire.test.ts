import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * PR #2392 (merged 2026-09-21) ingested 150 checklist rows
 * hiq:baseball:2025:bowman:bcp-<N>:lava-refractor:no-auto:num-399 (source
 * checklistinsider-2026-09-21, package backend/data/checklists/scraped/
 * acq-2026-09-21-checklistinsider-bowman-chrome-prospects-lava-2025). They
 * are DUPLICATES: the same rung already existed for the same cards at
 * hiq:baseball:2025:bowman-chrome:bcp-<N>:lava-refractor:no-auto:num-399
 * (source checklistinsider-2026-08-27). 2025 BCP- rows live under the
 * bowman-chrome: id prefix (6,000+ rows) -- that is the canonical home; one
 * card, one row.
 *
 * This package is removed (this PR) so it can never be re-ingested, and this
 * list retires the 150 bowman: duplicate rows it minted. Every entry was
 * verified READ-ONLY, per id, before being listed: the bowman: row exists
 * with source exactly "checklistinsider-2026-09-21", and its bowman-chrome:
 * twin exists with matching cardNumber, printRun and player.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "catalog-relocations", "2026-09-21-bcp-lava-refractor-bowman-duplicate.json"),
    "utf8",
  ),
);

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
const entries = list.entries as CatEntry[];

describe("2026-09-21 BCP Lava Refractor bowman: duplicate retire list", () => {
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

  it("has exactly 150 entries, all unique ids", () => {
    expect(entries).toHaveLength(150);
    expect(new Set(entries.map((e) => e.id)).size).toBe(150);
    expect(list.census.catalogRowsRetired).toBe(150);
  });

  it("is a retire-only list — nothing is reslugged and nothing is minted", () => {
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
    }
  });

  it("every id matches the exact PR #2392 bowman: pattern, no bowman-chrome: id in the list", () => {
    const pattern = /^hiq:baseball:2025:bowman:bcp-\d+:lava-refractor:no-auto:num-399$/;
    for (const e of entries) {
      expect(e.id, e.id).toMatch(pattern);
      expect(e.id.startsWith("hiq:baseball:2025:bowman-chrome:")).toBe(false);
    }
  });

  it("covers BCP-1..BCP-150 exactly once each, no gaps and no repeats", () => {
    const numbers = entries
      .map((e) => Number(/bcp-(\d+):/.exec(e.id)?.[1]))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
  });

  it("every entry is source-tagged to the #2392 ingest in its reason", () => {
    for (const e of entries) {
      expect(e.reason ?? "", e.id).toMatch(/checklistinsider-2026-09-21/);
      expect(e.reason ?? "", e.id).toMatch(/checklistinsider-2026-08-27/);
      expect(e.reason ?? "", e.id).toMatch(/#2392/);
    }
  });

  it("every entry's evidence names its verified bowman-chrome: canonical twin", () => {
    for (const e of entries) {
      expect(e.evidence ?? "", e.id).toMatch(/hiq:baseball:2025:bowman-chrome:bcp-\d+:lava-refractor:no-auto:num-399/);
      const num = /bcp-(\d+):/.exec(e.id)?.[1];
      expect(e.evidence, e.id).toMatch(new RegExp(`bowman-chrome:bcp-${num}:`));
    }
  });

  it("the one resident sold_comps row found at a retired address is reported, not routed", () => {
    // READ-ONLY cross-check (STARTSWITH hiq:baseball:2025:bowman:bcp- +
    // CONTAINS lava-refractor) found exactly one resident sale, at BCP-69.
    // This PR does not move it -- the retire hands it to the rematch.
    expect(list.census.salesResidentAtRetiredAddresses).toBe(1);
    expect(list.census.salesResidentDetail).toHaveLength(1);
    expect(list.census.salesResidentDetail[0].id).toBe("tca-ebay::358876121523");
    expect(list.census.salesResidentDetail[0].cardId).toBe(
      "hiq:baseball:2025:bowman:bcp-69:lava-refractor:no-auto:num-399",
    );
  });
});
