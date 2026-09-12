import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * #2041 follow-up -- THE HEAVY METAL ABSORBED-ROWS FOLD LIST (measured by
 * read 2026-09-11/12).
 *
 * 1996 Fleer Metal Universe "Heavy Metal" is a 10-card named insert (#1
 * Albert Belle ... #10 Matt Williams). Until #2041 lands, `normalizeSetKey`
 * collapses `metal-universe-heavy-metal` to `metal-universe`, so nothing
 * ever minted under its own key -- 18 rows across five numbers (#1, #2, #6,
 * #8, #10) instead carry the Heavy Metal player's name at the BASE
 * metal-universe address of a different player. #2041's PR comments hold the
 * 5-number/18-row table this list is built from.
 *
 * THE SHAPE IS 18 ENTRIES, NOT 1. An earlier draft of this file excluded the
 * 17 graded children on the theory that "a graded child follows its parent"
 * when a card moves. That rule applies when the PARENT is the row being
 * moved -- it is not this shape. Point-read 2026-09-12 confirms all five
 * plain (`:base:no-auto`, no grade tier) parent rows ARE the correct
 * checklist-backed base player (Alomar, Anderson, Mussina, Palmeiro,
 * Surhoff) and stay exactly where they are. The 17 graded children
 * themselves are what's mis-parented: each carries the HEAVY METAL player's
 * name while sitting under the correct base parent's id (a Bonds PSA-9 row
 * under Brady Anderson's card, for example) -- and that mis-parenting does
 * real damage, since the graded-to-raw rung prices the base card's raw pool
 * from the wrongly-attached graded sale.
 *
 * Verified against the real moveCatalogRow (dist/services/catalog/
 * catalogRowOps.service.js) with an in-memory fake container, 2026-09-12: a
 * graded child CAN reslug to another graded address across a setKey change
 * -- buildIncoming's guard only refuses when gradeTier PRESENCE disagrees
 * between the old id and the new slug (a graded child aimed at a plain card
 * address, or the reverse). Every entry in this file keeps the same grade
 * tier on both sides, so none hits that guard; the move was confirmed to
 * land cleanly and to derive the correct new parentSlug automatically.
 *
 * So: 1 entry for the ungraded SSP row, 17 entries for the graded children,
 * each reslugging graded-address-to-graded-address under the Heavy Metal
 * key. No entry in this file ever names one of the five plain base-parent
 * ids -- those cards are correct and untouched.
 *
 * These pins hold the LIST SHAPE and run the lane's OWN validators
 * (classifyEntry, keepsSales, idSetKey/crossProductFields) rather than a copy
 * of them, so a list this suite accepts is a list the lane can read.
 */

const FILE = "2026-09-12-metal-universe-heavy-metal-absorbed-rows.json";
const DIR = path.join(process.cwd(), "data", "catalog-relocations");

type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string; keepSales?: boolean };
type List = {
  generatedAt: string;
  forLane: string;
  reportOnlyUntil: string;
  keepSales?: boolean;
  finding: string;
  rulings: string[];
  excluded: unknown[];
  census: Record<string, unknown>;
  entries: Entry[];
};

const doc = JSON.parse(readFileSync(path.join(DIR, FILE), "utf8")) as List;

const { classifyEntry, keepsSales, idSetKey, crossProductFields } = require_(
  "../scripts/relocate-catalog-rows-by-list.cjs",
) as {
  classifyEntry: (e: unknown) => { ok: boolean; action?: string; to?: string; why?: string };
  keepsSales: (entry: unknown, doc: unknown) => boolean;
  idSetKey: (slug: string) => string;
  crossProductFields: (id: string, to: string) => { setKey?: string };
};

const BASE_NAME: Record<number, string> = {
  1: "Roberto Alomar",
  2: "Brady Anderson",
  6: "Mike Mussina",
  8: "Rafael Palmeiro",
  10: "B.J. Surhoff",
};
const HM_NAME: Record<number, string> = {
  1: "Albert Belle",
  2: "Barry Bonds",
  6: "Mike Piazza",
  8: "Frank Thomas",
  10: "Matt Williams",
};

const PLAIN_PARENT_IDS = new Set(
  [1, 2, 6, 8, 10].map((n) => `hiq:baseball:1996:metal-universe:${n}:base:no-auto`),
);

describe("the file is shaped the way relocate-catalog-rows-by-list requires", () => {
  it("names the lane and holds the APPLY-ONLY-AFTER-#2041 gate in reportOnlyUntil", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/APPLY ONLY AFTER #2041/);
    expect(doc.reportOnlyUntil).toMatch(/merged AND deployed AND the Heavy Metal rows are ingested/);
    expect(doc.reportOnlyUntil).toMatch(/metal-universe-heavy-metal:N exists/);
  });

  it("states, in the header, the correction that graded children ARE entries and why", () => {
    const allText = JSON.stringify(doc.rulings);
    expect(allText).toMatch(/CORRECTED/i);
    expect(allText).toMatch(/mis-parented/i);
    expect(allText).toMatch(/graded-to-raw rung/i);
  });

  it("carries keepSales: true at the file level", () => {
    expect(doc.keepSales).toBe(true);
  });

  it("has no `excluded` entries -- nothing is deliberately left out this time", () => {
    expect(Array.isArray(doc.excluded)).toBe(true);
    expect(doc.excluded).toHaveLength(0);
  });
});

describe("count-pinned: 18 entries total -- 1 ungraded + 17 graded-to-graded", () => {
  it("exactly 18 entries", () => {
    expect(doc.entries).toHaveLength(18);
  });

  it("exactly 1 ungraded entry (no grade-tier segment) and 17 graded entries", () => {
    const graded = doc.entries.filter((e) => /:(psa|sgc|cgc|bgs|beckett)-[0-9a-z.-]+$/i.test(e.id));
    const ungraded = doc.entries.filter((e) => !/:(psa|sgc|cgc|bgs|beckett)-[0-9a-z.-]+$/i.test(e.id));
    expect(graded).toHaveLength(17);
    expect(ungraded).toHaveLength(1);
    expect(ungraded[0].id).toBe("hiq:baseball:1996:metal-universe:2:ssp:no-auto");
  });

  it("no entry's id or destination is one of the five plain base-parent addresses", () => {
    for (const e of doc.entries) {
      expect(PLAIN_PARENT_IDS.has(e.id)).toBe(false);
      expect(PLAIN_PARENT_IDS.has(String(e.to))).toBe(false);
    }
  });

  it("no duplicate ids, and every id is unique to one entry", () => {
    const seen = new Set<string>();
    for (const e of doc.entries) {
      expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false);
      seen.add(e.id);
    }
    expect(seen.size).toBe(18);
  });
});

describe("every entry classifies as a reslug the lane accepts", () => {
  it.each(
    // vitest it.each needs a stable array; index each entry for a readable name
    (JSON.parse(readFileSync(path.join(DIR, FILE), "utf8")) as List).entries.map((e, i) => [i, e] as const),
  )("entry %i: %s", (_i, entry) => {
    const v = classifyEntry(entry);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.action).toBe("reslug");
    expect(entry.to).toBeTruthy();
  });
});

describe("every graded entry moves graded-address to graded-address, same tier both sides", () => {
  it("the grade-tier suffix is identical on id and to, for every graded entry", () => {
    for (const e of doc.entries) {
      const idTier = /:([a-z]+-[0-9a-z.-]+)$/i.exec(e.id)?.[1];
      const toTier = /:([a-z]+-[0-9a-z.-]+)$/i.exec(e.to ?? "")?.[1];
      if (e.id === "hiq:baseball:1996:metal-universe:2:ssp:no-auto") continue; // the one ungraded entry
      expect(idTier, `no grade tier parsed from ${e.id}`).toBeTruthy();
      expect(toTier, `no grade tier parsed from ${e.to}`).toBe(idTier);
    }
  });

  it("every graded id's parent (strip the tier) is one of the five plain base-parent ids", () => {
    for (const e of doc.entries) {
      if (e.id === "hiq:baseball:1996:metal-universe:2:ssp:no-auto") continue;
      const parent = e.id.replace(/:[a-z]+-[0-9a-z.-]+$/i, "");
      expect(PLAIN_PARENT_IDS.has(parent), `${e.id} does not parent to a known base row`).toBe(true);
    }
  });
});

describe("the five Heavy Metal numbers are each matched to the right name", () => {
  const numOf = (slug: string) => Number(/^hiq:baseball:1996:metal-universe:(\d+):/.exec(slug)?.[1]);

  it("every entry's number is one of the five Heavy Metal numbers (1, 2, 6, 8, 10)", () => {
    for (const e of doc.entries) {
      const n = numOf(e.id);
      expect(HM_NAME[n], `number ${n} is not one of the five HM numbers`).toBeTruthy();
    }
  });

  it("every entry's reason/evidence names the HM player for its number and the base occupant it displaces from", () => {
    for (const e of doc.entries) {
      const n = numOf(e.id);
      const hm = HM_NAME[n];
      const base = BASE_NAME[n];
      expect(e.reason, `${e.id}: reason should name ${hm}`).toMatch(new RegExp(hm.replace(".", "\\.")));
      expect(e.evidence, `${e.id}: evidence should name ${base}`).toMatch(new RegExp(base.replace(".", "\\.")));
    }
  });

  it("by-number counts match #2041's table: 1->3, 2->6, 6->5, 8->2, 10->2 (18 total)", () => {
    const byNumber = (n: number) => doc.entries.filter((e) => numOf(e.id) === n).length;
    expect(byNumber(1)).toBe(3);
    expect(byNumber(2)).toBe(6); // 5 graded + 1 ungraded ssp
    expect(byNumber(6)).toBe(5);
    expect(byNumber(8)).toBe(2);
    expect(byNumber(10)).toBe(2);
    expect(byNumber(1) + byNumber(2) + byNumber(6) + byNumber(8) + byNumber(10)).toBe(18);
  });
});

describe("the ungraded Barry Bonds SSP entry, reslugged correctly", () => {
  const entry = doc.entries.find((e) => e.id === "hiq:baseball:1996:metal-universe:2:ssp:no-auto")!;

  it("exists and is the ungraded row", () => {
    expect(entry).toBeTruthy();
  });

  it("classifyEntry accepts it as a reslug to the Heavy Metal SSP address", () => {
    const v = classifyEntry(entry);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.to).toBe("hiq:baseball:1996:metal-universe-heavy-metal:2:ssp:no-auto");
  });

  it("evidence states the sale count measured on BOTH cardId and hobbyiqCardId", () => {
    // #2041's own comment: count sales on cardId OR hobbyiqCardId, since a
    // cardId-only query saw 0 of the one real sale here.
    expect(entry.evidence).toMatch(/byCardId=0/);
    expect(entry.evidence).toMatch(/byHobbyiqCardId=1/);
    expect(entry.evidence).toMatch(/byEither=1/);
  });

  it("is the only entry keepSales matters for -- it is the only one with a sale", () => {
    expect(keepsSales(entry, doc)).toBe(true);
  });
});

describe("a sample graded entry (Bonds PSA-9 under Anderson's card) is fully correct", () => {
  const ID = "hiq:baseball:1996:metal-universe:2:base:no-auto:psa-9";
  const TO = "hiq:baseball:1996:metal-universe-heavy-metal:2:base:no-auto:psa-9";
  const entry = doc.entries.find((e) => e.id === ID)!;

  it("exists, reslugs graded-to-graded with the same tier", () => {
    expect(entry).toBeTruthy();
    expect(entry.to).toBe(TO);
  });

  it("classifyEntry accepts it (the lane's own validator, not a re-implementation)", () => {
    const v = classifyEntry(entry);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.action).toBe("reslug");
  });

  it("is a cross-product move: idSetKey differs and crossProductFields supplies the new setKey", () => {
    expect(idSetKey(entry.id)).toBe("metal-universe");
    expect(idSetKey(entry.to!)).toBe("metal-universe-heavy-metal");
    expect(crossProductFields(entry.id, entry.to!)).toEqual({ setKey: "metal-universe-heavy-metal" });
  });

  it("names the wrong parent (Brady Anderson) and the right player (Barry Bonds)", () => {
    expect(entry.evidence).toMatch(/Brady Anderson/);
    expect(entry.reason).toMatch(/Barry Bonds/);
  });

  it("has zero sales, unlike the ungraded SSP row", () => {
    expect(entry.evidence).toMatch(/byCardId=0/);
    expect(entry.evidence).toMatch(/byHobbyiqCardId=0/);
    expect(entry.evidence).toMatch(/byEither=0/);
  });

  it("keepsSales still resolves true (file-level default), even though this entry carries no sale", () => {
    expect(keepsSales(entry, doc)).toBe(true);
  });
});

describe("the header states the apply gate names the exact precondition", () => {
  it("rulings mention both #2041 shipping and the checklist ingest as preconditions", () => {
    const allText = JSON.stringify(doc.rulings) + doc.reportOnlyUntil;
    expect(allText).toMatch(/#2041/);
    expect(allText).toMatch(/ingest/i);
    expect(allText).toMatch(/10 rows|Heavy Metal checklist/);
  });

  it("states the measured correction that a REPORT run today shows a clean move, not a refusal -- and names that as the hazard", () => {
    const allText = JSON.stringify(doc.rulings);
    expect(allText).toMatch(/does NOT show refused\/occupied/i);
    expect(allText).toMatch(/orphaned/i);
    expect(allText).toMatch(/process gate/i);
  });
});

describe("moveCatalogRow itself accepts a graded-to-graded cross-product reslug (not a copy of the guard)", () => {
  // This is the empirical claim the whole file rests on: read the REAL mover
  // from the lane's own require path, against a minimal in-memory container,
  // and prove the graded-to-graded shape lands rather than assert it in prose.
  it("moveCatalogRow lands a graded child on a graded address under a different setKey", async () => {
    const { moveCatalogRow } = await import("../src/services/catalog/catalogRowOps.service.js");

    function notFound(): Error & { code: number } {
      return Object.assign(new Error("not found"), { code: 404 });
    }
    type Doc = Record<string, any>;
    const keyOf = (id: string, pk?: string | null) => (pk == null || pk === id ? id : `${id}@${pk}`);
    class FakeContainer {
      docs = new Map<string, Doc>();
      constructor(seed: Doc[] = []) {
        for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
      }
      get(id: string) {
        return this.docs.get(id) ?? [...this.docs.values()].find((d) => d.id === id);
      }
      item(id: string, pk?: string) {
        const k = keyOf(id, pk);
        return {
          read: async () => {
            const d = this.docs.get(k);
            if (!d) throw notFound();
            return { resource: structuredClone(d), statusCode: 200 };
          },
          patch: async () => { throw new Error("not used"); },
          delete: async () => {
            if (!this.docs.has(k)) throw notFound();
            this.docs.delete(k);
            return {};
          },
        };
      }
      items = {
        upsert: async (doc: Doc) => {
          this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
          return { resource: structuredClone(doc) };
        },
        query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => ({
          fetchNext: async () => ({ resources: this.run(spec), continuationToken: undefined }),
          fetchAll: async () => ({ resources: this.run(spec) }),
        }),
      };
      run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
        const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const all = [...this.docs.values()];
        if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
          return all
            .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
            .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
        }
        return [];
      }
    }

    const OLD = "hiq:baseball:1996:metal-universe:2:base:no-auto:psa-9";
    const NEW = "hiq:baseball:1996:metal-universe-heavy-metal:2:base:no-auto:psa-9";
    const gradedRow: Doc = {
      id: OLD, cardId: OLD, hobbyiqCardId: OLD,
      sport: "baseball", year: 1996, cardYear: 1996,
      setKey: "metal-universe", setName: "Metal Universe",
      cardNumber: "2", playerName: "Barry Bonds",
      parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null,
      source: "baseballcardpedia-graded",
      parentSlug: "hiq:baseball:1996:metal-universe:2:base:no-auto",
      gradeCompany: "PSA", gradeValue: 9, gradeTier: "psa-9",
      vendorIds: {},
    };
    const cat = new FakeContainer([gradedRow]);

    const res = await moveCatalogRow(cat as any, gradedRow, NEW, { setKey: "metal-universe-heavy-metal" }, {
      reason: "test: graded-to-graded reslug across setKey",
      dryRun: false,
      known: null,
    });

    expect(res.action).not.toBe("refused");
    expect(cat.get(NEW)).toBeTruthy();
    expect(cat.get(OLD)).toBeUndefined();
    expect(cat.get(NEW)?.gradeTier).toBe("psa-9");
    expect(cat.get(NEW)?.parentSlug).toBe("hiq:baseball:1996:metal-universe-heavy-metal:2:base:no-auto");
  });

  it("moveCatalogRow REFUSES the mismatched shape -- a graded child aimed at a plain card address", async () => {
    const { moveCatalogRow } = await import("../src/services/catalog/catalogRowOps.service.js");
    const gradedRow = {
      id: "hiq:baseball:1996:metal-universe:2:base:no-auto:psa-9",
      cardId: "hiq:baseball:1996:metal-universe:2:base:no-auto:psa-9",
      sport: "baseball", year: 1996, setKey: "metal-universe", cardNumber: "2",
      playerName: "Barry Bonds", parallel: "Base", parallelSlug: "base", isAuto: false,
      source: "baseballcardpedia-graded",
      parentSlug: "hiq:baseball:1996:metal-universe:2:base:no-auto",
      gradeTier: "psa-9", vendorIds: {},
    };
    const fakeContainerNoRow = {
      item: () => ({ read: async () => { throw Object.assign(new Error("nf"), { code: 404 }); } }),
    };
    await expect(
      moveCatalogRow(fakeContainerNoRow as any, gradedRow as any,
        "hiq:baseball:1996:metal-universe-heavy-metal:2:base:no-auto", // no grade suffix
        { setKey: "metal-universe-heavy-metal" },
        { reason: "test: mismatched shape must refuse", dryRun: true, known: null }),
    ).rejects.toThrow(/a graded child cannot move onto a card address/);
  });
});
