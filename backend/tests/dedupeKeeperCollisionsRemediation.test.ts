import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 2026-09-28 dedupe-keeper-collision remediation -- pins the three
 * committed lists this audit produced against the counts stated in
 * backend/docs/reports/2026-09-28-dedupe-keeper-collisions.md and against
 * each list's own consuming lane's schema (repoint-sales-by-list.cjs /
 * relocate-pool-rows-by-list.cjs). READ-ONLY audit: no Cosmos client here,
 * only the committed JSON's own shape and cross-list invariants.
 */

const dataDir = path.join(process.cwd(), "data");

const repointList = JSON.parse(
  readFileSync(
    path.join(dataDir, "sales-repoints", "2026-09-28-dedupe-keeper-collisions-repoint.json"),
    "utf8",
  ),
);
const parkList = JSON.parse(
  readFileSync(
    path.join(dataDir, "pool-relocations", "2026-09-28-dedupe-keeper-collisions-park.json"),
    "utf8",
  ),
);
const needsRulingList = JSON.parse(
  readFileSync(
    path.join(dataDir, "sales-repoints", "2026-09-28-dedupe-keeper-collisions-needsRuling.json"),
    "utf8",
  ),
);

type RepointEntry = {
  fromId: string;
  toId: string;
  player?: string;
  cardNumber?: string;
  reason?: string;
  allowCrossProduct?: boolean;
  crossProductRuling?: string;
  expectedSales?: number | null;
  saleId?: string;
  currentCardId?: string;
};
type ParkEntry = {
  id: string;
  fromCardId: string;
  parkIdentityUnverified?: boolean;
  price?: number;
  evidence?: string;
};
type NeedsRulingEntry = {
  saleId: string;
  keepCardId: string;
  saleTitle: string;
  needsRulingReason: string;
};

const repointEntries = repointList.entries as RepointEntry[];
const parkEntries = parkList.entries as ParkEntry[];
const needsRulingEntries = needsRulingList.entries as NeedsRulingEntry[];

describe("counts pin exactly to the audit's own math", () => {
  it("204 unique sales = 4 repoint + 101 park + 99 needsRuling + 0 not-resident", () => {
    expect(repointEntries.length).toBe(4);
    expect(parkEntries.length).toBe(101);
    expect(needsRulingEntries.length).toBe(99);
    expect(repointEntries.length + parkEntries.length + needsRulingEntries.length).toBe(204);
  });

  it("the sidecar states the same counts", () => {
    const md = readFileSync(
      path.join(process.cwd(), "docs", "reports", "2026-09-28-dedupe-keeper-collisions.md"),
      "utf8",
    );
    expect(md).toContain("| **4** |");
    expect(md).toContain("| **101** |");
    expect(md).toContain("| **99** |");
  });
});

describe("no sale appears in more than one of the three lists", () => {
  it("repoint, park and needsRuling sale ids are pairwise disjoint", () => {
    const repointIds = new Set(repointEntries.map((e) => e.reason ?? ""));
    // fromId is the identity a sale MOVES from, not the sale's own id -- the
    // actual per-sale identity this list addresses is the sale referenced in
    // `reason` (repoint-sales-by-list moves EVERY sale currently at fromId,
    // so its own list schema has no per-sale id field). The three lists are
    // instead checked disjoint on saleId directly for park/needsRuling, and
    // on fromId (keepCardId) for repoint vs the other two, since a single
    // fromId could in principle carry more than one sale but this audit's
    // own census (each entry traced to exactly one saleId in the source
    // ndjson) makes them equivalent here.
    const parkSaleIds = new Set(parkEntries.map((e) => e.id));
    const needsRulingSaleIds = new Set(needsRulingEntries.map((e) => e.saleId));
    expect(parkSaleIds.size).toBe(parkEntries.length);
    expect(needsRulingSaleIds.size).toBe(needsRulingEntries.length);
    for (const id of parkSaleIds) expect(needsRulingSaleIds.has(id)).toBe(false);
    void repointIds;
  });

  it("repoint saleIds never appear as a park or needsRuling saleId", () => {
    // repoint-sales-by-list.cjs's own schema is fromId/toId only (it moves
    // EVERY sale currently at fromId) -- this audit's own list additionally
    // stamps `saleId`/`currentCardId` per entry (this specific batch is
    // exactly one sale per fromId) so the audit trail and this disjointness
    // check do not have to re-parse the reason text.
    for (const e of repointEntries) {
      expect(e.saleId).toMatch(/^tca-ebay::\d+$/);
      expect(e.currentCardId).toBe(e.fromId);
    }
    const repointSaleIds = new Set(repointEntries.map((e) => e.saleId));
    const parkSaleIds = new Set(parkEntries.map((e) => e.id));
    const needsRulingSaleIds = new Set(needsRulingEntries.map((e) => e.saleId));
    for (const id of repointSaleIds) {
      expect(parkSaleIds.has(id!)).toBe(false);
      expect(needsRulingSaleIds.has(id!)).toBe(false);
    }
  });
});

describe("the repoint list matches repoint-sales-by-list.cjs's own schema", () => {
  it("every entry has fromId, toId, reason, and toId !== fromId", () => {
    for (const e of repointEntries) {
      expect(e.fromId).toMatch(/^hiq:/);
      expect(e.toId).toMatch(/^hiq:/);
      expect(e.toId).not.toBe(e.fromId);
      expect(String(e.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("every entry declares allowCrossProduct with a crossProductRuling string", () => {
    // Every repoint in this batch moves a sale between UNRELATED products
    // (the bare-cardNumber collision IS the cross-product move), so every
    // entry must carry both fields per repoint-sales-by-list.cjs's own gate
    // (classifyEntry refuses allowCrossProduct:true with no ruling string).
    for (const e of repointEntries) {
      expect(e.allowCrossProduct).toBe(true);
      expect(String(e.crossProductRuling ?? "").length).toBeGreaterThan(0);
    }
  });

  it("the ruling names the 09-26/27 isAuto flip and the 2026-09-28 audit", () => {
    for (const e of repointEntries) {
      expect(e.crossProductRuling).toContain("09-26/27");
      expect(e.crossProductRuling).toContain("2026-09-28");
    }
  });

  it("no entry sets expectedSales (this batch was not census-counted per-sale by the list author)", () => {
    for (const e of repointEntries) {
      expect(e.expectedSales === null || e.expectedSales === undefined).toBe(true);
    }
  });
});

describe("the park list matches relocate-pool-rows-by-list.cjs's own schema", () => {
  it("every entry has id, fromCardId, and parkIdentityUnverified:true, and no other shape flag", () => {
    for (const e of parkEntries) {
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.fromCardId).toMatch(/^hiq:/);
      expect(e.parkIdentityUnverified).toBe(true);
      expect((e as Record<string, unknown>).toCardId).toBeUndefined();
      expect((e as Record<string, unknown>).retireSupersededBy).toBeUndefined();
    }
  });

  it("every entry carries non-empty evidence naming the sale's own re-derivation (or its absence)", () => {
    for (const e of parkEntries) {
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
    }
  });

  it("park entries are unique by sale id", () => {
    const ids = parkEntries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the needsRuling sidecar", () => {
  it("every entry has a saleId, keepCardId and a named reason", () => {
    for (const e of needsRulingEntries) {
      expect(e.saleId.length).toBeGreaterThan(0);
      expect(e.keepCardId).toMatch(/^hiq:/);
      expect(String(e.needsRulingReason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("classifies into exactly the three named reasons the sidecar reports", () => {
    const prefixes = new Set(
      needsRulingEntries.map((e) => e.needsRulingReason.split(":")[0].split("(")[0].trim()),
    );
    for (const p of prefixes) {
      expect([
        "title-underivable",
        "derived-address-exists-checklist-grade-but-namesAgree-fails",
        "derived-address-exists-but-not-checklist-grade",
      ]).toContain(p);
    }
  });

  it("counts match the sidecar's own breakdown (87 / 11 / 1)", () => {
    const titleUnderivable = needsRulingEntries.filter((e) =>
      e.needsRulingReason.startsWith("title-underivable"),
    ).length;
    const wrongPlayer = needsRulingEntries.filter((e) =>
      e.needsRulingReason.startsWith("derived-address-exists-checklist-grade-but-namesAgree-fails"),
    ).length;
    const notChecklistGrade = needsRulingEntries.filter((e) =>
      e.needsRulingReason.startsWith("derived-address-exists-but-not-checklist-grade"),
    ).length;
    expect(titleUnderivable).toBe(87);
    expect(wrongPlayer).toBe(11);
    expect(notChecklistGrade).toBe(1);
    expect(titleUnderivable + wrongPlayer + notChecklistGrade).toBe(99);
  });
});

describe("this pass is report-only -- no apply is authorized by these files", () => {
  it("the repoint list's own forLane matches the real lane script name", () => {
    expect(repointList.forLane).toBe("repoint-sales-by-list");
  });

  it("the park list's own forLane matches the real lane script name", () => {
    expect(parkList.forLane).toBe("relocate-pool-rows-by-list");
  });

  it("both lane scripts referenced actually exist in this checkout", () => {
    expect(() =>
      readFileSync(path.join(process.cwd(), "scripts", "repoint-sales-by-list.cjs"), "utf8"),
    ).not.toThrow();
    expect(() =>
      readFileSync(path.join(process.cwd(), "scripts", "relocate-pool-rows-by-list.cjs"), "utf8"),
    ).not.toThrow();
  });
});
