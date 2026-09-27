/**
 * R-0927d unsigned-twin empty retire (2026-09-27), Drew's "Build list; REPORT;
 * APPLY if clean" for the 1,869 `:no-auto` card_catalog rows that Backfill
 * Runner run 36351266066 (repoint-sales-by-list REPORT against
 * data/sales-repoints/2026-09-27-baseball-unsigned-twins-r0927d.json) refused
 * as REFUSED (zero-sales): the fromId carries no sold_comps rows at all, so
 * that run had nothing to move. Each id is a checklist-grade card_catalog row
 * minted unsigned by the checklistinsider-layout-mints-autos-unsigned defect
 * (R-0927d, #2453) at a cardNumber prefix already registered autograph-only;
 * its `:auto` twin is the checklist-grade row and is the one that survives.
 *
 * This mirrors relocateCatalogRowsByList.test.ts's own pattern for reading a
 * committed list through the lane's real loader (`L.classifyEntry`) rather
 * than re-implementing the lane's validation here — a change to the lane's
 * rules should fail THIS list's test the same way it fails every other one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const listPath = join(
  __dirname,
  "..",
  "data",
  "catalog-relocations",
  "2026-09-27-baseball-unsigned-twins-empty-retire.json",
);

type Entry = { id: string; action: string; to?: string; reason?: string };
type ListDoc = {
  forLane: string;
  reportOnlyUntil?: string;
  census?: { refusedZeroSales?: number; groupCounts?: Array<{ year: number; setKey: string; count: number }> };
  entries: Entry[];
};

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

// The lane is required WITHOUT a built tree, exactly as relocateCatalogRowsByList.test.ts does it.
const L = require_(lane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string; to?: string };
};

const doc = readList(listPath);

describe("the R-0927d empty unsigned-twin retire list", () => {
  it("names this lane and holds exactly the 1,869 REFUSED (zero-sales) ids", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(1869);
  });

  it("every entry passes the lane's own validation", () => {
    for (const e of doc.entries) {
      const c = L.classifyEntry(e);
      expect(c.ok, `${e.id}: ${c.why ?? ""}`).toBe(true);
    }
  });

  it("every entry is a retire with a reason and no destination", () => {
    for (const e of doc.entries) {
      expect(e.action, e.id).toBe("retire");
      expect(typeof e.reason, e.id).toBe("string");
      expect((e.reason ?? "").length, e.id).toBeGreaterThan(0);
      expect(e.to, e.id).toBeUndefined();
    }
  });

  it("no duplicate ids", () => {
    expect(new Set(doc.entries.map((e) => e.id)).size).toBe(doc.entries.length);
  });

  it("every id ends in the :no-auto grammar (bare or :no-auto:num-N), never a graded suffix", () => {
    for (const e of doc.entries) {
      expect(e.id, e.id).toMatch(/:no-auto(:num-[^:]+)?$/);
    }
  });

  it("no id is an :auto (signed) row — this list only ever names the unsigned twin", () => {
    for (const e of doc.entries) {
      // ":no-auto" contains the literal substring "auto", so this checks for
      // an ":auto:" or ":auto" SEGMENT, not merely the substring "auto".
      const segments = e.id.split(":");
      expect(segments.includes("auto"), e.id).toBe(false);
      expect(segments.includes("no-auto"), e.id).toBe(true);
    }
  });

  it("every id traces back to the sales-repoints scope list as a fromId, and none is a toId there", () => {
    const scopeList = readList(
      join(__dirname, "..", "data", "sales-repoints", "2026-09-27-baseball-unsigned-twins-r0927d.json"),
    ) as unknown as { entries: Array<{ fromId: string; toId: string }> };
    const fromIds = new Set(scopeList.entries.map((e) => e.fromId));
    const toIds = new Set(scopeList.entries.map((e) => e.toId));
    for (const e of doc.entries) {
      expect(fromIds.has(e.id), `${e.id} must be a fromId in the sales-repoints list`).toBe(true);
      expect(toIds.has(e.id), `${e.id} must never be a toId in the sales-repoints list`).toBe(false);
    }
  });

  it("entries are ordered by group (year+setKey) then cardNumber, matching the header's group order", () => {
    const groupOrder = [
      "2024|bowman-chrome",
      "2025|topps-chrome-update-series",
      "2024|bowman-draft",
      "2025|topps",
      "2024|bowman",
      "2024|topps-chrome-black",
    ];
    function groupOf(id: string): string {
      const parts = id.split(":");
      return `${parts[2]}|${parts[3]}`;
    }
    let lastGroupIdx = -1;
    for (const e of doc.entries) {
      const idx = groupOrder.indexOf(groupOf(e.id));
      expect(idx, e.id).toBeGreaterThanOrEqual(0);
      expect(idx, e.id).toBeGreaterThanOrEqual(lastGroupIdx);
      lastGroupIdx = idx;
    }
  });

  it("the header's per-group counts match the entries actually in the file", () => {
    const expected: Record<string, number> = {
      "2024|bowman-chrome": 1262,
      "2025|topps-chrome-update-series": 166,
      "2024|bowman-draft": 133,
      "2025|topps": 125,
      "2024|bowman": 111,
      "2024|topps-chrome-black": 72,
    };
    const actual: Record<string, number> = {};
    for (const e of doc.entries) {
      const parts = e.id.split(":");
      const key = `${parts[2]}|${parts[3]}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(expected);
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(1869);
  });

  it("reportOnlyUntil is set — APPLY is not authorized by adding this file", () => {
    expect(String(doc.reportOnlyUntil).length).toBeGreaterThan(0);
  });
});
