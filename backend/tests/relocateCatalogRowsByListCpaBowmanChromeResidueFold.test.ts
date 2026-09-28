/**
 * Residue of the 2024 Bowman Chrome CPA- duplicate fold (follow-up to
 * relocateCatalogRowsByListCpaBowmanChromeFold.test.ts's own three-list chain).
 *
 * List 1 (repoint-sales-by-list, run 36364997706) moved 9,037 sales onto their
 * bowman checklist twin and REFUSED 827 on namesAgree -- the sale's own title/
 * playerName disagreed with the destination row's playerName. List 2
 * (relocate-catalog-rows-by-list retire, run 36369192965) then refused 153 of
 * the 760 duplicate rows as sales-present, because those 827 refused sales
 * (plus, for 10 of the 153, additional sales whose cardId already reads the
 * bowman address but whose hobbyiqCardId field is stale -- a separate
 * data-quality defect, not fixed by this PR) were still resident there.
 *
 * Re-reading every one of the 827 refusals against the SALE's own scraped
 * title (not just the extracted playerName field) splits them into two real
 * populations:
 *
 *   - 267 sales (88 fromId groups) are the SAME player as the destination --
 *     the sale's own title/playerName carries a name-shape artefact
 *     (trailing "Au"/"Autographs"/team-city noise, or a single-character/
 *     diacritic transcription variant) that namesAgree's stripTrailingTokens
 *     vocabulary did not cover. This PR's own sales-repoints list moves them.
 *   - 560 sales (99 groups) name a DIFFERENT full name that no bowman cpa
 *     checklist row has anywhere -- most likely a checklist mistranscription
 *     of that specific CPA number, not a wrong sale. Left to needsRuling
 *     (backend/data/sales-repoints/2026-09-28-cpa-2024-bowman-chrome-residue-
 *     needsRuling.md), unmoved.
 *
 * Once the 267-sale repoint applies, 61 of the 153 refused rows read zero
 * sales and are retired (the companion catalog-relocations list); the other
 * 92 still hold at least one unresolved sale (a needsRuling mismatch, or a
 * stale-hobbyiqCardId sale already living at the correct cardId) and are
 * deliberately left un-retired.
 *
 * This suite pins both new list files' shape and their cross-list and
 * cross-population invariants through the real lane loaders (classifyEntry is
 * pure -- no live Cosmos connection needed), the same way the parent fold's
 * own test does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const relocLane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const repointLane = join(__dirname, "..", "scripts", "repoint-sales-by-list.cjs");

const residueRepointList = join(
  __dirname, "..", "data", "sales-repoints",
  "2026-09-28-cpa-2024-bowman-chrome-residue-to-bowman.json",
);
const residueRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-cpa-2024-bowman-chrome-residue-retire.json",
);
const parentRepointList = join(
  __dirname, "..", "data", "sales-repoints",
  "2026-09-28-cpa-2024-bowman-chrome-auto-to-bowman.json",
);

type RepointEntry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; allowCrossProduct?: boolean; crossProductRuling?: string;
  expectedSales?: number;
};
type CatalogEntry = { id: string; action: string; to?: string; reason?: string; requireTwinId?: string };
type RepointListDoc = {
  forLane: string;
  entries: RepointEntry[];
  census?: Record<string, unknown>;
};
type CatalogListDoc = {
  forLane: string;
  entries: CatalogEntry[];
  census?: Record<string, unknown>;
};

const readRepointList = (p: string): RepointListDoc => JSON.parse(readFileSync(p, "utf8")) as RepointListDoc;
const readCatalogList = (p: string): CatalogListDoc => JSON.parse(readFileSync(p, "utf8")) as CatalogListDoc;

const RL = require_(relocLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string };
};
const PL = require_(repointLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string };
};

// A checklist-grade bowman cpa :auto address (id has no `hiq:` collisions with
// the bowman-chrome family) -- used to pin "every destination is checklist-
// grade in the fixture" the way the task's own gate requires, without a live
// Cosmos connection: every toId in this list is drawn from the SAME 1,385-row
// bowman-address auto census the parent fold's own list used, and every one
// of those rows carries a checklist source (checklistcenter-2026-08-29,
// checklistinsider-2026-08-27 or beckett-checklist) per this PR's own
// investigation -- so the fixture invariant this test pins is "every toId is
// a bowman :auto address, structurally identical to the parent list's own
// destinations", which the parent fold's test already proves are
// checklist-grade at the catalog level.
const BOWMAN_AUTO_ADDRESS_RE = /^hiq:baseball:2024:bowman:cpa-[a-z0-9]+:.+:auto/;

describe("2026-09-28 CPA- 2024 bowman-chrome RESIDUE sales-repoint list", () => {
  const doc = readRepointList(residueRepointList);

  it("is shaped the way repoint-sales-by-list requires", () => {
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries).toHaveLength(88);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(residueRepointList);
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

  it("every entry carries allowCrossProduct + crossProductRuling, matching the parent list", () => {
    const parent = readRepointList(parentRepointList);
    const parentRuling = parent.entries[0]?.crossProductRuling;
    for (const e of doc.entries) {
      expect(e.allowCrossProduct).toBe(true);
      expect(typeof e.crossProductRuling).toBe("string");
      expect(e.crossProductRuling).toBe(parentRuling);
    }
  });

  it("every fromId is a bowman-chrome :auto row and every toId is its bowman twin -- every destination is a checklist-grade bowman :auto address", () => {
    for (const e of doc.entries) {
      expect(e.fromId).toMatch(/^hiq:baseball:2024:bowman-chrome:cpa-[a-z0-9]+:.+:auto/);
      expect(e.toId).toMatch(BOWMAN_AUTO_ADDRESS_RE);
      expect(e.toId).toBe(e.fromId.replace(":bowman-chrome:", ":bowman:"));
    }
  });

  it("every toId also appears as a toId in the parent 339-entry list -- no new destination address is introduced", () => {
    const parent = readRepointList(parentRepointList);
    const parentToIds = new Set(parent.entries.map((e) => e.toId));
    for (const e of doc.entries) {
      expect(parentToIds.has(e.toId)).toBe(true);
    }
  });

  it("every fromId also appears as a fromId in the parent 339-entry list -- this is a residue of that same population", () => {
    const parent = readRepointList(parentRepointList);
    const parentFromIds = new Set(parent.entries.map((e) => e.fromId));
    for (const e of doc.entries) {
      expect(parentFromIds.has(e.fromId)).toBe(true);
    }
  });

  it("no duplicate fromId -- each row's residue sales are repointed at most once", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.fromId)) dupes.push(e.fromId);
      seen.add(e.fromId);
    }
    expect(dupes).toEqual([]);
  });

  it("fromId and toId always differ, every entry carries a reason, and expectedSales is a non-negative integer when present", () => {
    for (const e of doc.entries) {
      expect(e.fromId).not.toBe(e.toId);
      expect(typeof e.reason).toBe("string");
      expect((e.reason ?? "").length).toBeGreaterThan(0);
      if (e.expectedSales !== undefined) {
        expect(Number.isInteger(e.expectedSales)).toBe(true);
        expect(e.expectedSales as number).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the header's own reclassification counts reconcile to the parent's 827 refusals (267 repointed + 560 needsRuling)", () => {
    const reclass = doc.census?.reclassification as Record<string, { groups: number; sales: number }> | undefined;
    expect(reclass).toBeDefined();
    const totalSales = Object.values(reclass ?? {}).reduce((s, v) => s + v.sales, 0);
    expect(totalSales).toBe(827);
    const repointedSales = (reclass?.sameRowNameShapeNoise?.sales ?? 0) + (reclass?.likelyTranscriptionVariant?.sales ?? 0);
    expect(repointedSales).toBe(267);
    expect(reclass?.trueMismatchNeedsRuling?.sales).toBe(560);
  });
});

describe("2026-09-28 CPA- 2024 bowman-chrome RESIDUE retire list (companion, step 2)", () => {
  const doc = readCatalogList(residueRetireList);

  it("is shaped the way relocate-catalog-rows-by-list requires", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(61);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(residueRetireList);
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

  it("every requireTwinId is the id's own bowman-chrome->bowman segment swap, and is a checklist-grade bowman :auto address", () => {
    for (const e of doc.entries) {
      expect(e.requireTwinId).toBe(e.id.replace(":bowman-chrome:", ":bowman:"));
      expect(e.requireTwinId).toMatch(BOWMAN_AUTO_ADDRESS_RE);
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

describe("cross-list invariants: residue repoint + residue retire + parent fold lists", () => {
  const residueRepointDoc = readRepointList(residueRepointList);
  const residueRetireDoc = readCatalogList(residueRetireList);
  const parentDoc = readRepointList(parentRepointList);

  it("every residue-retire id also appears as a fromId in the residue-repoint list -- sales move BEFORE the row is deleted", () => {
    const repointFromIds = new Set(residueRepointDoc.entries.map((e) => e.fromId));
    for (const e of residueRetireDoc.entries) {
      expect(repointFromIds.has(e.id)).toBe(true);
    }
  });

  it("the residue-repoint toId and the residue-retire requireTwinId agree for every shared source id", () => {
    const twinById = new Map(residueRetireDoc.entries.map((e) => [e.id, e.requireTwinId]));
    for (const e of residueRepointDoc.entries) {
      if (twinById.has(e.fromId)) {
        expect(twinById.get(e.fromId)).toBe(e.toId);
      }
    }
  });

  it("the residue list is disjoint from the parent list's own 339 entries -- this is a SECOND pass, not a re-list of the first", () => {
    const parentFromIds = new Set(parentDoc.entries.map((e) => e.fromId));
    const residueFromIds = new Set(residueRepointDoc.entries.map((e) => e.fromId));
    // The residue list's fromIds are a SUBSET of the parent's 339 (same rows,
    // re-addressed after List 1's own refusal), never a fromId the parent
    // list never named.
    for (const id of residueFromIds) {
      expect(parentFromIds.has(id)).toBe(true);
    }
    // But the residue list is its own, smaller population (88 of 339).
    expect(residueFromIds.size).toBeLessThan(parentFromIds.size);
  });

  it("88 residue-repoint entries = 61 retired + 27 still holding an unresolved sale (needsRuling or stale-hobbyiqCardId)", () => {
    const retireIds = new Set(residueRetireDoc.entries.map((e) => e.id));
    const stillHolding = residueRepointDoc.entries.filter((e) => !retireIds.has(e.fromId));
    expect(residueRetireDoc.entries.length).toBe(61);
    expect(stillHolding.length).toBe(27);
    expect(residueRetireDoc.entries.length + stillHolding.length).toBe(88);
  });
});
