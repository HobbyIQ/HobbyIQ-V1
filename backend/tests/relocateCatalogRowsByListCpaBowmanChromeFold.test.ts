/**
 * The 2024 Bowman Chrome CPA- duplicate fold (Drew 2026-09-27 ~23:56Z ruling,
 * PR #2467's needsRuling "CPA- 2024 bowman-chrome" group, 760 pairs).
 *
 * Drew's ruling asked to census the hiq:baseball:2024:bowman:cpa-* addresses
 * first (occupied? same player?) before writing a relocation list. The
 * read-only census (backend/scripts/tmp-census/census-cpa-760.cjs, uncommitted;
 * results snapshot referenced in this PR's body) answered the census question
 * differently than a plain RESLUG would expect: every one of the 760 target
 * addresses is ALREADY OCCUPIED, by a checklist-grade row (688 beckett-checklist,
 * 72 beckett-scraped-2026-08-26), and namesAgree confirms the SAME PLAYER on
 * 760/760, zero exceptions -- there is no class C (collision) and no class A
 * (vacant reslug target) in this population at all.
 *
 * So the shape here is a DUPLICATE FOLD, not a reslug, and it is three lists:
 *
 *   1. backend/data/sales-repoints/2026-09-28-cpa-2024-bowman-chrome-auto-to-bowman.json
 *      (repoint-sales-by-list) -- moves the 9,790 sales sitting on the 339
 *      bowman-chrome:*:auto duplicate rows onto their real bowman:cpa- twin,
 *      FIRST, before anything is deleted.
 *   2. backend/data/catalog-relocations/2026-09-28-cpa-2024-bowman-chrome-auto-retire.json
 *      (relocate-catalog-rows-by-list, action "retire") -- deletes all 760
 *      now-duplicate bowman-chrome:*:auto rows, each requireTwinId-gated on
 *      its real bowman:cpa- twin.
 *   3. backend/data/catalog-relocations/2026-09-28-cpa-2024-bowman-chrome-bccp-stubs-retire.json
 *      (relocate-catalog-rows-by-list, action "retire") -- deletes the 753
 *      (of 760) bccp :no-auto stubs (isAuto=false, playerName=null, zero
 *      sales) that share the CPA- number; the 7 bccp stubs that carry sales
 *      are held out to census.needsRuling, per Drew's "the bccp unsigned
 *      twins get a separate isAuto look" -- never auto-resolved here.
 *
 * This suite pins all three list files' shape and cross-list invariants
 * through the real lane loaders (classifyEntry is pure -- no live Cosmos
 * connection needed), the way repointSalesByListBaseballUnsignedTwins.test.ts
 * and relocateCatalogRowsByList.test.ts already pin their own committed
 * lists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const relocLane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const repointLane = join(__dirname, "..", "scripts", "repoint-sales-by-list.cjs");

const salesRepointsList = join(
  __dirname, "..", "data", "sales-repoints",
  "2026-09-28-cpa-2024-bowman-chrome-auto-to-bowman.json",
);
const autoRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-cpa-2024-bowman-chrome-auto-retire.json",
);
const bccpStubsRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-cpa-2024-bowman-chrome-bccp-stubs-retire.json",
);

type RepointEntry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; allowCrossProduct?: boolean; crossProductRuling?: string;
};
type CatalogEntry = { id: string; action: string; to?: string; reason?: string; requireTwinId?: string };
type RepointListDoc = {
  forLane: string;
  entries: RepointEntry[];
  census?: { classificationCounts?: Record<string, number> };
};
type CatalogListDoc = {
  forLane: string;
  entries: CatalogEntry[];
  census?: { needsRuling?: unknown[] } & Record<string, unknown>;
};

const readRepointList = (p: string): RepointListDoc => JSON.parse(readFileSync(p, "utf8")) as RepointListDoc;
const readCatalogList = (p: string): CatalogListDoc => JSON.parse(readFileSync(p, "utf8")) as CatalogListDoc;

const RL = require_(relocLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string };
};
const PL = require_(repointLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string };
};

describe("2026-09-28 CPA- 2024 bowman-chrome sales-repoint list", () => {
  const doc = readRepointList(salesRepointsList);

  it("is shaped the way repoint-sales-by-list requires", () => {
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries).toHaveLength(339);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(salesRepointsList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("every entry passes the lane's own classifyEntry gate", () => {
    for (const e of doc.entries) {
      const c = PL.classifyEntry(e);
      if (!c.ok) throw new Error(`entry failed classifyEntry: ${c.why} -- fromId=${e.fromId}`);
      expect(c.ok).toBe(true);
    }
  });

  it("every entry carries allowCrossProduct + crossProductRuling -- setKey moves on every row", () => {
    for (const e of doc.entries) {
      expect(e.allowCrossProduct).toBe(true);
      expect(typeof e.crossProductRuling).toBe("string");
      expect((e.crossProductRuling ?? "").length).toBeGreaterThan(0);
    }
  });

  it("every fromId is a bowman-chrome :auto row and every toId is its bowman twin", () => {
    for (const e of doc.entries) {
      expect(e.fromId).toMatch(/^hiq:baseball:2024:bowman-chrome:cpa-[a-z0-9]+:.+:auto/);
      expect(e.toId).toMatch(/^hiq:baseball:2024:bowman:cpa-[a-z0-9]+:.+:auto/);
      // Same cardNumber/parallel/auto/printRun segment, only the setKey moved.
      expect(e.toId).toBe(e.fromId.replace(":bowman-chrome:", ":bowman:"));
    }
  });

  it("no duplicate fromId -- each duplicate row's sales are repointed at most once", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.fromId)) dupes.push(e.fromId);
      seen.add(e.fromId);
    }
    expect(dupes).toEqual([]);
  });

  it("fromId and toId always differ, and every entry carries a reason", () => {
    for (const e of doc.entries) {
      expect(e.fromId).not.toBe(e.toId);
      expect(typeof e.reason).toBe("string");
      expect((e.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("the header's own census records zero class-A and zero class-C rows", () => {
    const counts = doc.census?.classificationCounts ?? {};
    expect(counts.A_vacantReslugCandidate).toBe(0);
    expect(counts.C_occupiedDifferentPlayerCollision).toBe(0);
    expect(counts.B_occupiedSamePlayerDuplicate).toBe(760);
  });
});

describe("2026-09-28 CPA- 2024 bowman-chrome auto-row retire list (companion, step 2)", () => {
  const doc = readCatalogList(autoRetireList);

  it("is shaped the way relocate-catalog-rows-by-list requires", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(760);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(autoRetireList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("every entry is a retire naming requireTwinId, and passes classifyEntry", () => {
    for (const e of doc.entries) {
      const c = RL.classifyEntry(e);
      if (!c.ok) throw new Error(`entry failed classifyEntry: ${c.why} -- id=${e.id}`);
      expect(c.ok).toBe(true);
      expect(e.action).toBe("retire");
      expect(e.to).toBeUndefined();
      expect(typeof e.requireTwinId).toBe("string");
      expect((e.requireTwinId ?? "").length).toBeGreaterThan(0);
    }
  });

  it("every requireTwinId is the id's own bowman-chrome->bowman segment swap", () => {
    for (const e of doc.entries) {
      expect(e.requireTwinId).toBe(e.id.replace(":bowman-chrome:", ":bowman:"));
    }
  });

  it("no duplicate id -- each duplicate row is retired at most once", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.id)) dupes.push(e.id);
      seen.add(e.id);
    }
    expect(dupes).toEqual([]);
  });
});

describe("2026-09-28 CPA- 2024 bowman-chrome bccp :no-auto stub retire list (companion, independent)", () => {
  const doc = readCatalogList(bccpStubsRetireList);

  it("is shaped the way relocate-catalog-rows-by-list requires, and holds the 7 sale-bearing stubs out", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(753);
    expect(Array.isArray(doc.census?.needsRuling)).toBe(true);
    expect(doc.census?.needsRuling).toHaveLength(7);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(bccpStubsRetireList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("every retire entry passes classifyEntry and names requireTwinId", () => {
    for (const e of doc.entries) {
      const c = RL.classifyEntry(e);
      if (!c.ok) throw new Error(`entry failed classifyEntry: ${c.why} -- id=${e.id}`);
      expect(c.ok).toBe(true);
      expect(e.action).toBe("retire");
      expect(typeof e.requireTwinId).toBe("string");
    }
  });

  it("every id is a bowman-chrome :no-auto row (the bccp stub family, disjoint from the :auto rows)", () => {
    for (const e of doc.entries) {
      expect(e.id).toMatch(/^hiq:baseball:2024:bowman-chrome:cpa-[a-z0-9]+:.+:no-auto/);
    }
  });

  it("no duplicate id", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.id)) dupes.push(e.id);
      seen.add(e.id);
    }
    expect(dupes).toEqual([]);
  });
});

describe("cross-list invariants across all three 2026-09-28 CPA- fold lists", () => {
  const repointDoc = readRepointList(salesRepointsList);
  const autoRetireDoc = readCatalogList(autoRetireList);
  const bccpDoc = readCatalogList(bccpStubsRetireList);

  it("every sales-repoint fromId also appears in the auto-retire list (sales move BEFORE the row is deleted)", () => {
    const retireIds = new Set(autoRetireDoc.entries.map((e) => e.id));
    for (const e of repointDoc.entries) {
      expect(retireIds.has(e.fromId)).toBe(true);
    }
  });

  it("the auto-retire list and the bccp-stub list never name the same id (disjoint address families)", () => {
    const autoIds = new Set(autoRetireDoc.entries.map((e) => e.id));
    const bccpIds = new Set(bccpDoc.entries.map((e) => e.id));
    const overlap = [...autoIds].filter((id) => bccpIds.has(id));
    expect(overlap).toEqual([]);
  });

  it("the sales-repoint toId and the auto-retire requireTwinId agree for every shared source id", () => {
    const twinById = new Map(autoRetireDoc.entries.map((e) => [e.id, e.requireTwinId]));
    for (const e of repointDoc.entries) {
      expect(twinById.get(e.fromId)).toBe(e.toId);
    }
  });

  it("760 = 339 (repointed+retired) + 421 (retired with zero sales) accounts for every auto-retire entry", () => {
    const withSales = new Set(repointDoc.entries.map((e) => e.fromId));
    const zeroSales = autoRetireDoc.entries.filter((e) => !withSales.has(e.id));
    expect(withSales.size).toBe(339);
    expect(zeroSales).toHaveLength(421);
  });

  it("760 = 753 (retired) + 7 (needsRuling) accounts for every bccp stub in the census", () => {
    expect(bccpDoc.entries.length + (bccpDoc.census?.needsRuling?.length ?? 0)).toBe(760);
  });
});
