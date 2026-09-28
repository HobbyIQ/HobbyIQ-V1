/**
 * 2023 Topps Green Foil name-suffix pairs (Drew's ruling, 2026-09-28 16:25Z):
 * of the 68 pairs the Green Foil consolidation held for ruling (sidecar
 * 2026-09-28-topps-2023-green-foil-needs-ruling.md), the 61 name-superset
 * pairs -- where the Beckett mover's playerName and the existing canonical
 * baseballcardpedia-ladders twin's playerName differ only by a name suffix
 * (Jr./Sr. presence-absence, a bare RC/RCup/FS rookie-subset tag, a team/tag
 * token) -- are the SAME card. The duplicate Beckett row retires onto its
 * twin, requireTwinId, exactly like the 589 already-applied same-player
 * duplicates in 2026-09-28-topps-2023-green-foil-duplicate-retire.json. The 7
 * two/three-player combo-card collisions sharing a number with a solo-named
 * Beckett row are DISTINCT per Drew's ruling and are untouched -- they must
 * not appear anywhere in this list.
 *
 * Read-only re-verification (2026-09-28) against the live card_catalog /
 * sold_comps containers, run pair by pair against lib/name-agreement.cjs's
 * own `namesAgree` on the LIVE STORED playerName fields (not the sidecar
 * table's hand-transcribed text), found 9 of the 61 pairs are NOT a pure
 * suffix difference under the repo's own name-fold rules (a UER error-card
 * annotation, a doubled RC/RCup marker, a quoted subset phrase outside the
 * closed vocabulary, or an unspaced multi-player "/" list). Those 9 are
 * reported in this file's own `needsRuling` array, not retired -- only the 52
 * pairs namesAgree confirms as a pure suffix/tag difference are entries here.
 *
 * This suite pins the list's shape and its invariants against the real lane
 * loader, the real namesAgree primitive, and the real catalogAuthorityOf --
 * the same posture relocateCatalogRowsByListGreenFoilConsolidation.test.ts
 * takes for the two already-merged Green Foil lists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

const require_ = createRequire(__filename);
const relocLane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const nameAgreement = join(__dirname, "..", "scripts", "lib", "name-agreement.cjs");

const suffixPairsRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-topps-2023-green-foil-suffix-pairs-retire.json",
);
const duplicateRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-topps-2023-green-foil-duplicate-retire.json",
);
const vacantReslugList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-topps-2023-green-foil-vacant-reslug.json",
);

type CatalogEntry = {
  id: string; action: string; to?: string; parallel?: string; reason?: string; requireTwinId?: string;
};
type NeedsRulingEntry = {
  num: number; moverId: string; twinId: string; moverPlayerName: string; twinPlayerName: string; reason: string;
};
type CatalogListDoc = {
  forLane: string;
  entries: CatalogEntry[];
  needsRuling?: NeedsRulingEntry[];
  census?: Record<string, unknown>;
};

const readCatalogList = (p: string): CatalogListDoc => JSON.parse(readFileSync(p, "utf8")) as CatalogListDoc;

const RL = require_(relocLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string };
};
const NA = require_(nameAgreement) as {
  namesAgree: (a: string, b: string, opts?: unknown) => boolean;
};

// The 7 different-player collisions Drew ruled DISTINCT -- must appear
// nowhere in this list, verbatim from the sidecar.
const COLLISION_NUMS = [210, 245, 334, 405, 457, 464, 574];

describe("2026-09-28 Green Foil name-suffix pairs retire list", () => {
  const doc = readCatalogList(suffixPairsRetireList);

  it("is shaped the way relocate-catalog-rows-by-list requires", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
  });

  it("has 61 or fewer entries, with any exclusions accounted for in needsRuling", () => {
    expect(doc.entries.length).toBeLessThanOrEqual(61);
    expect(Array.isArray(doc.needsRuling)).toBe(true);
    expect(doc.entries.length + (doc.needsRuling?.length ?? 0)).toBe(61);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(suffixPairsRetireList);
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

  it("every source spelling is one of the two Beckett spellings, never the unnumbered 'Rainbow Foil' insert", () => {
    for (const e of doc.entries) {
      expect(e.id).toMatch(/^hiq:baseball:2023:topps:\d+:green-(foil-board|rainbow-foil):no-auto:num-499$/);
      expect(e.id).not.toMatch(/:rainbow-foil:/);
    }
  });

  it("every requireTwinId is the id's own parallel segment swapped to 'green-foil', same cardNumber/isAuto", () => {
    for (const e of doc.entries) {
      const idParts = e.id.split(":");
      const twinParts = (e.requireTwinId as string).split(":");
      expect(twinParts[4]).toBe(idParts[4]); // cardNumber unchanged
      expect(twinParts[6]).toBe(idParts[6]); // isAuto segment unchanged
      expect(twinParts[5]).toBe("green-foil"); // parallel segment is the canonical spelling
      expect(e.requireTwinId).toBe(
        `hiq:baseball:2023:topps:${idParts[4]}:green-foil:${idParts[6]}:num-499`,
      );
    }
  });

  it("every entry's stated twin source (embedded in the reason) is checklist-grade per the real catalogAuthorityOf", () => {
    let checked = 0;
    for (const e of doc.entries) {
      const m = /Twin is checklist-grade \(source ([^)]+)\)/.exec(e.reason ?? "");
      expect(m).not.toBeNull();
      const source = m?.[1] ?? "";
      expect(catalogAuthorityOf(source)).toBe("checklist");
      checked++;
    }
    expect(checked).toBe(doc.entries.length);
  });

  it("every entry's stated twin parallel (embedded in the reason) is 'Green Foil'", () => {
    for (const e of doc.entries) {
      expect(e.reason ?? "").toMatch(/parallel "Green Foil"/);
    }
  });

  it("every entry's mover/twin playerName pair (embedded in the reason) really namesAgree per the real primitive", () => {
    let checked = 0;
    for (const e of doc.entries) {
      const m = /Mover playerName "(.*)" and twin playerName "(.*)" differ only by a generational suffix/.exec(e.reason ?? "");
      expect(m).not.toBeNull();
      const [, moverName, twinName] = m as unknown as [string, string, string];
      expect(NA.namesAgree(moverName, twinName)).toBe(true);
      checked++;
    }
    expect(checked).toBe(doc.entries.length);
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

  it("the 7 different-player collisions Drew ruled DISTINCT appear nowhere in entries", () => {
    for (const e of doc.entries) {
      const numStr = e.id.split(":")[4];
      expect(COLLISION_NUMS).not.toContain(Number(numStr));
    }
  });

  describe("needsRuling entries", () => {
    it("every needsRuling entry genuinely fails namesAgree on its own stated names", () => {
      for (const r of doc.needsRuling ?? []) {
        expect(NA.namesAgree(r.moverPlayerName, r.twinPlayerName)).toBe(false);
      }
    });

    it("the 7 different-player collisions Drew ruled DISTINCT appear nowhere in needsRuling either", () => {
      for (const r of doc.needsRuling ?? []) {
        expect(COLLISION_NUMS).not.toContain(r.num);
      }
    });

    it("no needsRuling id overlaps an entries id", () => {
      const entryIds = new Set(doc.entries.map((e) => e.id));
      for (const r of doc.needsRuling ?? []) {
        expect(entryIds.has(r.moverId)).toBe(false);
      }
    });
  });
});

describe("cross-list invariants against the already-merged Green Foil lists", () => {
  const suffixDoc = readCatalogList(suffixPairsRetireList);
  const duplicateDoc = readCatalogList(duplicateRetireList);
  const vacantDoc = readCatalogList(vacantReslugList);

  it("no id in this list overlaps the already-merged duplicate-retire list", () => {
    const dupIds = new Set(duplicateDoc.entries.map((e) => e.id));
    for (const e of suffixDoc.entries) {
      expect(dupIds.has(e.id)).toBe(false);
    }
  });

  it("no id in this list overlaps the already-merged vacant-reslug list", () => {
    const vacantIds = new Set(vacantDoc.entries.map((e) => e.id));
    for (const e of suffixDoc.entries) {
      expect(vacantIds.has(e.id)).toBe(false);
    }
  });

  it("no card number in this list is double-covered against either already-merged list", () => {
    const numOf = (id: string) => id.split(":")[4];
    const coveredNums = new Set([
      ...duplicateDoc.entries.map((e) => numOf(e.id)),
      ...vacantDoc.entries.map((e) => numOf(e.id)),
    ]);
    for (const e of suffixDoc.entries) {
      expect(coveredNums.has(numOf(e.id))).toBe(false);
    }
  });

  it("this list never touches the unnumbered 'Rainbow Foil' insert", () => {
    for (const e of suffixDoc.entries) {
      expect(e.id).not.toMatch(/:rainbow-foil:/);
      if (e.requireTwinId) expect(e.requireTwinId).not.toMatch(/:rainbow-foil:/);
    }
  });
});
