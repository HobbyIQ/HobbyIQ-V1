/**
 * 2023 Topps Green Foil consolidation (Drew's ruling, 2026-09-28 12:10Z):
 * the canonical rung name for the 2023 Topps baseball /499 green parallel is
 * plain "Green Foil" -- Topps' own printed name, both Series 1 and Series 2.
 *
 * The original findings (C:/tmp/alias0928_0145/green-foil-findings.md) named
 * two non-canonical Beckett spellings -- "Green Foil Board" (#1-330) and
 * "Green Rainbow Foil" (#331-660), both source beckett-s3-2026-09-20 -- and
 * assumed a plain reslug onto "Green Foil" would recover all 660 rows and the
 * 962 unbacked sale titles that already say "Green Foil". A read-only
 * occupancy census (2026-09-28) found that premise incomplete: card_catalog
 * ALREADY holds a checklist-grade "Green Foil" row (source
 * baseballcardpedia-ladders-2026-08-28/29) at 657 of the 660 card numbers --
 * a third spelling the original findings never checked for. So this is three
 * shapes, not one:
 *
 *   1. 2026-09-28-topps-2023-green-foil-vacant-reslug.json (3 rows) -- the
 *      only card numbers with NO existing "Green Foil" twin; an ordinary fold
 *      reslug, changing the rung with the required `parallel` field
 *      (CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-THE-RUNG'S-TEXT, #2431).
 *   2. 2026-09-28-topps-2023-green-foil-duplicate-retire.json (589 rows) --
 *      the same-player duplicates of the already-canonical twin, retired with
 *      requireTwinId (CF-A-RETIRE-REQUIRES-ITS-TWIN, #2468).
 *   3. 2026-09-28-topps-2023-green-foil-needs-ruling.md (68 pairs, sidecar,
 *      not a list file: 61 name-superset + 7 different-player collisions) --
 *      occupancyRefusal shapes this lane will not auto-resolve.
 *
 * This suite pins both list files' shape and cross-list invariants through
 * the real lane loaders and the real id/authority computations, the way
 * relocateCatalogRowsByListCpaBowmanChromeFold.test.ts pins its own three
 * 2026-09-28 CPA- fold lists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

const require_ = createRequire(__filename);
const relocLane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");

const vacantReslugList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-topps-2023-green-foil-vacant-reslug.json",
);
const duplicateRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-topps-2023-green-foil-duplicate-retire.json",
);

type CatalogEntry = {
  id: string; action: string; to?: string; parallel?: string; reason?: string; requireTwinId?: string;
};
type CatalogListDoc = {
  forLane: string;
  entries: CatalogEntry[];
  census?: Record<string, unknown>;
};

const readCatalogList = (p: string): CatalogListDoc => JSON.parse(readFileSync(p, "utf8")) as CatalogListDoc;

const RL = require_(relocLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string };
};

describe("2026-09-28 Green Foil vacant-reslug list (3 rows)", () => {
  const doc = readCatalogList(vacantReslugList);

  it("is shaped the way relocate-catalog-rows-by-list requires", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(3);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(vacantReslugList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("every entry is a reslug carrying the required parallel text, and passes classifyEntry", () => {
    for (const e of doc.entries) {
      const c = RL.classifyEntry(e);
      if (!c.ok) throw new Error(`entry failed classifyEntry: ${c.why} -- id=${e.id}`);
      expect(c.ok).toBe(true);
      expect(e.action).toBe("reslug");
      expect(e.parallel).toBe("Green Foil");
      expect(typeof e.to).toBe("string");
    }
  });

  it("every source spelling is one of the two Beckett spellings, never the unnumbered 'Rainbow Foil' insert", () => {
    for (const e of doc.entries) {
      expect(e.id).toMatch(/^hiq:baseball:2023:topps:\d+:green-(foil-board|rainbow-foil):no-auto:num-499$/);
      expect(e.id).not.toMatch(/:rainbow-foil:/); // the real unnumbered insert's own slug segment
    }
  });

  it("every destination reproduces exactly what the real computeHobbyIqCardId would compute for parallel 'Green Foil'", () => {
    for (const e of doc.entries) {
      const parts = e.id.split(":");
      const cardNumber = parts[4];
      const isAuto = parts[6] === "auto";
      const recomputed = computeHobbyIqCardId({
        sport: "baseball",
        year: 2023,
        setKey: "topps",
        cardNumber,
        parallel: "Green Foil",
        isAuto,
        printRun: 499,
      });
      expect(e.to).toBe(recomputed);
    }
  });

  it("no duplicate id and no duplicate destination", () => {
    const ids = new Set<string>();
    const tos = new Set<string>();
    for (const e of doc.entries) {
      expect(ids.has(e.id)).toBe(false);
      expect(tos.has(e.to as string)).toBe(false);
      ids.add(e.id);
      tos.add(e.to as string);
    }
  });
});

describe("2026-09-28 Green Foil duplicate-retire list (589 rows)", () => {
  const doc = readCatalogList(duplicateRetireList);

  it("is shaped the way relocate-catalog-rows-by-list requires", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(589);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(duplicateRetireList);
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

  it("every requireTwinId's stated occupant source (embedded in the reason) is checklist-grade per the real catalogAuthorityOf", () => {
    let checked = 0;
    for (const e of doc.entries) {
      const m = /already-canonical checklist-grade "Green Foil" row at requireTwinId \(source ([^)]+)\)/.exec(e.reason ?? "");
      expect(m).not.toBeNull();
      const source = m?.[1] ?? "";
      expect(catalogAuthorityOf(source)).toBe("checklist");
      checked++;
    }
    expect(checked).toBe(589);
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

describe("cross-list invariants across both 2026-09-28 Green Foil lists", () => {
  const vacantDoc = readCatalogList(vacantReslugList);
  const retireDoc = readCatalogList(duplicateRetireList);

  it("counts sum to 592 of the 660 candidates; the remaining 68 (61 superset + 7 collision) appear in neither list", () => {
    expect(vacantDoc.entries.length + retireDoc.entries.length).toBe(592);
  });

  it("no id appears in both lists", () => {
    const vacantIds = new Set(vacantDoc.entries.map((e) => e.id));
    const retireIds = new Set(retireDoc.entries.map((e) => e.id));
    const overlap = [...vacantIds].filter((id) => retireIds.has(id));
    expect(overlap).toEqual([]);
  });

  it("no card number is double-covered across both lists", () => {
    const numOf = (id: string) => id.split(":")[4];
    const vacantNums = new Set(vacantDoc.entries.map((e) => numOf(e.id)));
    const retireNums = retireDoc.entries.map((e) => numOf(e.id));
    for (const n of retireNums) {
      expect(vacantNums.has(n)).toBe(false);
    }
  });

  it("neither list contains a row named against the unnumbered 'Rainbow Foil' insert", () => {
    const all = [...vacantDoc.entries, ...retireDoc.entries];
    for (const e of all) {
      expect(e.id).not.toMatch(/:rainbow-foil:/);
      if (e.to) expect(e.to).not.toMatch(/:rainbow-foil:/);
      if (e.requireTwinId) expect(e.requireTwinId).not.toMatch(/:rainbow-foil:/);
    }
  });
});
