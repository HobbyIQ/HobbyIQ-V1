/**
 * backend/data/sales-repoints/2026-09-27-baseball-unsigned-twins-r0927d.json
 * -- the 22-group / 3,265-pair baseball unsigned-twin repoint list built
 * from draft PR #2453's read-only census, in the repoint-sales-by-list
 * schema shipped by PR #2461 (lane: backend/scripts/repoint-sales-by-list.cjs).
 *
 * R-0927d (Drew, 2026-09-27 ~02:50Z): "unsigned twins repoint then retire" --
 * this list is step 1 only (move the sale off the checklist-grade :no-auto
 * row onto its checklist-grade :auto twin). It does not retire anything.
 *
 * Modeled on "the first committed list (USC143)" in repointSalesByList.
 * test.ts: the list is loaded and run through the lane's own exported
 * `classifyEntry` so every entry is pinned to pass the loader's own schema
 * gates, without needing a live Cosmos connection (classifyEntry is pure).
 * This suite additionally pins the list-level invariants this PR's own
 * build step is responsible for (no duplicate fromId, no fromId that is
 * also a toId elsewhere in the list, every id under hiq:baseball:, and the
 * entry count matching the header's own count) -- properties classifyEntry
 * alone cannot check, because it only ever sees one entry at a time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const lane = join(__dirname, "..", "scripts", "repoint-sales-by-list.cjs");
const listPath = join(
  __dirname, "..", "data", "sales-repoints",
  "2026-09-27-baseball-unsigned-twins-r0927d.json",
);

type Entry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; allowCrossProduct?: boolean; crossProductRuling?: string;
  expectedSales?: number;
};
type ListDoc = {
  forLane: string;
  entries: Entry[];
  finding?: string;
  census?: { entriesIncluded?: number; groups?: number; parked?: unknown[]; needsRuling?: unknown[] };
};

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

const L = require_(lane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string };
};

describe("the baseball unsigned-twins repoint list (R-0927d, from #2453)", () => {
  const doc = readList(listPath);

  it("is shaped the way this lane requires", () => {
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(listPath);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("entry count equals the number stated in the header's own census", () => {
    expect(doc.census?.entriesIncluded).toBe(doc.entries.length);
    // The header states 22 source groups from #2453; every included entry
    // traces back to one of them (parked/needsRuling groups are excluded
    // from `entries` entirely, per the task's own instruction).
    expect(doc.census?.groups).toBe(22);
  });

  it("every entry passes the lane's own classifyEntry gate -- no malformed entries", () => {
    for (const e of doc.entries) {
      const c = L.classifyEntry(e);
      if (!c.ok) {
        throw new Error(`entry failed classifyEntry: ${c.why} -- fromId=${(e as Entry).fromId}`);
      }
      expect(c.ok).toBe(true);
    }
  });

  it("every id starts with hiq:baseball: -- this list is baseball-only", () => {
    for (const e of doc.entries) {
      expect(e.fromId.startsWith("hiq:baseball:")).toBe(true);
      expect(e.toId.startsWith("hiq:baseball:")).toBe(true);
    }
  });

  it("no duplicate fromId -- each source row is repointed at most once", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.fromId)) dupes.push(e.fromId);
      seen.add(e.fromId);
    }
    expect(dupes).toEqual([]);
  });

  it("no fromId that is also a toId elsewhere in the list -- no repoint chains", () => {
    const fromIds = new Set(doc.entries.map((e) => e.fromId));
    const toIds = new Set(doc.entries.map((e) => e.toId));
    const overlap = [...fromIds].filter((id) => toIds.has(id));
    expect(overlap).toEqual([]);
  });

  it("no entry sets expectedSales -- #2453's own sampled counts are stale by construction", () => {
    for (const e of doc.entries) {
      expect(e.expectedSales).toBeUndefined();
    }
  });

  it("no entry carries allowCrossProduct -- every pair is within the same product address", () => {
    for (const e of doc.entries) {
      expect(e.allowCrossProduct).toBeUndefined();
    }
  });

  it("fromId and toId always differ, and every entry carries a reason", () => {
    for (const e of doc.entries) {
      expect(e.fromId).not.toBe(e.toId);
      expect(typeof e.reason).toBe("string");
      expect((e.reason ?? "").length).toBeGreaterThan(0);
    }
  });
});
