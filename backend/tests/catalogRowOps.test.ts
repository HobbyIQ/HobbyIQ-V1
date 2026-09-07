// CF-ONE-WAY-TO-MOVE-A-CATALOG-ROW (D5 PR 2). Pins the four defects the
// 15-copy census found, on in-memory fakes of card_catalog and sold_comps:
//
//   1. authority never loses to a derived incumbent
//   2. vendorIds union on a fold
//   3. searchTokens / searchText / displayName rebuilt on a setKey change
//   4. graded children retired -- and ONLY the old slug's own children
//   5. sales re-pointed, survivor written, BEFORE the old row is deleted
//   6. dryRun writes nothing
//   7. a rehome (same slug, foreign partition) re-addresses the row and
//      touches neither its sales nor its own graded ladder (D5 PR 4)
//
// The fakes share one operation log so the ORDER of writes is assertable, not
// just their presence.

import { describe, it, expect } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  moveCatalogRow,
  retireCatalogRow,
  isGradedChildOf,
  rebuildSearchFields,
} from "../src/services/catalog/catalogRowOps.service.js";
import { buildSearchTokens } from "../src/services/portfolioiq/searchIndexing.service.js";
import { deriveBrand, deriveParentSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

/** Both containers partition on /cardId, so one id can exist once per
 *  partition -- which is exactly the rehome case. A doc lives at
 *  (id, cardId): keyed by the bare id in its own partition, `id@pk` in a
 *  foreign one. */
const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

/** Just enough of @azure/cosmos Container for the two operations: point
 *  read / patch / delete by (id, pk), upsert, and the two query shapes the
 *  service issues. Anything else throws so a new query cannot pass by accident. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  /** The doc at (id, pk); with no pk, the one in its own partition, else any with that id. */
  get(id: string, pk?: string): Doc | undefined {
    if (pk !== undefined) return this.docs.get(keyOf(id, pk));
    return this.docs.get(id) ?? [...this.docs.values()].find((d) => d.id === id);
  }
  has(id: string, pk?: string): boolean {
    return this.get(id, pk) !== undefined;
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        this.log.push(`${this.name}.read ${id}`);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op !== "set") throw new Error(`fake: unsupported patch op ${o.op}`);
          d[o.path.slice(1)] = o.value;
        }
        this.log.push(`${this.name}.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!this.docs.has(k)) throw notFound();
        this.docs.delete(k);
        this.log.push(`${this.name}.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`${this.name}.upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => ({
      fetchNext: async () => ({ resources: this.run(spec), continuationToken: undefined }),
      fetchAll: async () => ({ resources: this.run(spec) }),
    }),
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("c.hobbyiqCardId = @s")) {
      return all.filter((d) => d.hobbyiqCardId === p["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
    }
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    throw new Error(`fake container: unsupported query ${spec.query}`);
  }
  writes(): string[] {
    return this.log.filter((l) => /\.(upsert|patch|delete) /.test(l));
  }
}

const OLD = "hiq:baseball:2024:topps-allen-ginter:1:base:no-auto";
const NEW = "hiq:baseball:2024:topps-allen-and-ginter:1:base:no-auto";
const REASON = "ruled: topps-allen-ginter -> topps-allen-and-ginter";

function identityRow(over: Doc = {}): Doc {
  return {
    id: OLD, cardId: OLD, hobbyiqCardId: OLD,
    sport: "baseball", year: 2024, cardYear: 2024,
    setKey: "topps-allen-ginter", setName: "Topps Allen & Ginter",
    cardNumber: "1", parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null,
    playerName: "Aaron Judge", playerSlug: "aaron-judge",
    vendorIds: {}, source: "beckett-scraped-2026-08-19", confidence: 0.95,
    observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-20T00:00:00.000Z",
    // "oldsetonly" is a token no builder would produce for the new row: it
    // proves the tokens were REBUILT, not appended to.
    searchTokens: ["2024", "topps", "allen", "ginter", "1", "aaron", "judge", "oldsetonly"],
    searchText: "aaron judge topps allen ginter 1 2024",
    displayName: "stale",
    checklistBacking: "confirmed", checklistBackingAt: "2026-08-21T00:00:00.000Z",
    _rid: "rid", _self: "self", _etag: "etag", _attachments: "att", _ts: 1,
    ...over,
  };
}

function atNew(over: Doc = {}): Doc {
  return identityRow({ id: NEW, cardId: NEW, hobbyiqCardId: NEW, setKey: "topps-allen-and-ginter", ...over });
}

function gradedChild(parent: string, tier: string, over: Doc = {}): Doc {
  const id = `${parent}:${tier}`;
  return { id, cardId: id, hobbyiqCardId: id, parentSlug: parent, gradeTier: tier, source: "beckett-scraped-2026-08-19-graded", ...over };
}

function sale(id: string, slug: string): Doc {
  return { id, cardId: `pool-${id}`, hobbyiqCardId: slug, normalizedSetKey: "topps-allen-ginter", price: 10 };
}

function world(opts: { old?: Doc; incumbent?: Doc | null; extraCatalog?: Doc[]; sales?: Doc[] } = {}) {
  const log: string[] = [];
  const catalog = new FakeContainer("card_catalog", log, [
    opts.old ?? identityRow(),
    gradedChild(OLD, "psa-10"),
    gradedChild(OLD, "psa-9"),
    ...(opts.incumbent ? [opts.incumbent] : []),
    ...(opts.extraCatalog ?? []),
  ]);
  const sales = new FakeContainer("sold_comps", log, opts.sales ?? [sale("s1", OLD), sale("s2", OLD), sale("s3", "hiq:baseball:2024:topps:1:base:no-auto")]);
  return { log, catalog, sales, cat: catalog as unknown as Container, pool: sales as unknown as Container };
}

describe("moveCatalogRow: authority", () => {
  it("(1) an incoming checklist row never loses to a derived incumbent, whatever the confidence", async () => {
    // The documented failure: ingest-auto-seed at 0.85+ beating a checklist
    // row on confidence. Give the derived incumbent the HIGHER confidence.
    const w = world({
      old: identityRow({ confidence: 0.5 }),
      incumbent: atNew({ source: "ingest-auto-seed", confidence: 0.99, vendorIds: { cardhedge: "ch-1" }, playerName: "Aaron Judge (seed)" }),
    });
    const r = await moveCatalogRow(w.cat, identityRow({ confidence: 0.5 }), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool });
    expect(r.action).toBe("replace");
    expect(r.survivor).toBe("incoming");
    expect(r.decision).toMatch(/authority: incoming beckett-scraped-2026-08-19 \(rank 3\) outranks incumbent ingest-auto-seed \(rank 1\)/);
    const row = w.catalog.docs.get(NEW)!;
    expect(row.source).toBe("beckett-scraped-2026-08-19");
    expect(row.playerName).toBe("Aaron Judge");
    expect(row.replacedSource).toBe("ingest-auto-seed");
    expect(row.vendorIds).toEqual({ cardhedge: "ch-1" });   // the loser's cross-reference is kept
    expect(w.catalog.docs.has(OLD)).toBe(false);
  });

  it("a derived incoming row never beats a checklist incumbent: it folds", async () => {
    const w = world({
      old: identityRow({ source: "ingest-auto-seed", confidence: 0.99 }),
      incumbent: atNew({ source: "checklistcenter", confidence: 0.6, playerName: "Aaron Judge" }),
    });
    const r = await moveCatalogRow(w.cat, identityRow({ source: "ingest-auto-seed", confidence: 0.99 }), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool });
    expect(r.action).toBe("fold");
    expect(r.survivor).toBe("incumbent");
    expect(r.decision).toMatch(/incumbent checklistcenter \(rank 3\) outranks incoming ingest-auto-seed \(rank 1\)/);
    const row = w.catalog.docs.get(NEW)!;
    expect(row.source).toBe("checklistcenter");
    expect(row.confidence).toBe(0.6);
    expect(row.movedFrom).toBeUndefined();          // the incumbent is not the one that moved
    expect(w.catalog.docs.has(OLD)).toBe(false);    // the derived twin is still retired
    expect(w.sales.get("s1")!.hobbyiqCardId).toBe(NEW);  // and its sales still follow
  });

  it("equal authority: more vendorIds wins, then the incumbent keeps its address", async () => {
    const richer = world({ incumbent: atNew({ vendorIds: {} }) });
    const r1 = await moveCatalogRow(richer.cat, identityRow({ vendorIds: { cardhedge: "ch-2" } }), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: richer.pool });
    expect(r1.action).toBe("replace");
    expect(r1.decision).toMatch(/equal authority .*incoming carries 1 vendorIds vs 0/);

    const tied = world({ incumbent: atNew() });
    const r2 = await moveCatalogRow(tied.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: tied.pool });
    expect(r2.action).toBe("fold");
    expect(r2.decision).toMatch(/incumbent keeps its address/);
  });
});

describe("moveCatalogRow: the row that survives", () => {
  it("(2) vendorIds are a union on a fold, the survivor winning a key clash", async () => {
    const w = world({
      old: identityRow({ source: "ingest-auto-seed", vendorIds: { cardsight: "cs-3", cardhedge: "ch-old" }, observedAt: "2026-07-01T00:00:00.000Z" }),
      incumbent: atNew({ source: "checklistcenter", vendorIds: { cardhedge: "ch-9" }, observedAt: "2026-08-10T00:00:00.000Z", lastSeenAt: "2026-08-10T00:00:00.000Z" }),
    });
    const r = await moveCatalogRow(w.cat, identityRow({ source: "ingest-auto-seed", vendorIds: { cardsight: "cs-3", cardhedge: "ch-old" }, observedAt: "2026-07-01T00:00:00.000Z" }), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool });
    expect(r.action).toBe("fold");
    const row = w.catalog.docs.get(NEW)!;
    expect(row.vendorIds).toEqual({ cardhedge: "ch-9", cardsight: "cs-3" });
    expect(row.observedAt).toBe("2026-07-01T00:00:00.000Z");            // first seen by EITHER row
    expect(row.lastSeenAt > "2026-08-10T00:00:00.000Z").toBe(true);     // bumped
    expect(row._etag).toBeUndefined();                                  // system fields never copied
  });

  it("(3) searchTokens / searchText / displayName are rebuilt on a setKey change -- the old set's token is gone, the new one present", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool, repointNormalizedSetKey: true });
    expect(r.action).toBe("move");
    expect(r.decision).toBe(`no row at ${NEW}`);
    const row = w.catalog.docs.get(NEW)!;
    // id fields
    expect([row.id, row.cardId, row.hobbyiqCardId]).toEqual([NEW, NEW, NEW]);
    expect(row.setKey).toBe("topps-allen-and-ginter");
    expect(row.year).toBe(2024);
    expect(row.cardYear).toBe(2024);
    expect(row.parallelSlug).toBe("base");
    expect(row.playerSlug).toBe("aaron-judge");
    // the searchable fields
    expect(row.searchTokens).not.toContain("oldsetonly");
    expect(row.searchTokens).toContain("and");
    expect(row.searchTokens).toEqual(buildSearchTokens(row.searchText));
    expect(row.searchText).toContain("topps allen and ginter");
    expect(row.displayName).toBe("2024 Topps Allen & Ginter Baseball #1 Aaron Judge Base");
    // derived from the new setKey
    expect(row.brand).toBe("topps");
    expect("parentSetKey" in row).toBe(true);
    // provenance + hygiene
    expect(row.movedFrom).toBe(OLD);
    expect(row.movedReason).toBe(REASON);
    expect(typeof row.movedAt).toBe("string");
    expect(row.observedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(row.checklistBacking).toBeUndefined();
    expect(row.checklistBackingAt).toBeUndefined();
    expect(row._rid).toBeUndefined();
    expect(row._ts).toBeUndefined();
    expect(w.catalog.docs.has(OLD)).toBe(false);
  });

  it("rebuildSearchFields is the same spelling the nightly token backfill writes for a canonical row", () => {
    const f = rebuildSearchFields({
      sport: "baseball", year: 2025, setKey: "bowman-chrome", setName: "Bowman Chrome",
      cardNumber: "CPA-EW", playerName: "Eli Willits", parallel: "Gold Refractor", parallelSlug: "gold-refractor", printRun: 50,
    });
    for (const t of ["eli", "willits", "bowman", "chrome", "cpa-ew", "cpa", "ew", "2025", "gold", "refractor"]) expect(f.searchTokens).toContain(t);
    expect(f.displayName).toBe("2025 Bowman Chrome Baseball Chrome Prospect Autographs #CPA-EW Eli Willits Gold Refractor /50");
  });
});

describe("moveCatalogRow: graded children, sales, order", () => {
  it("(4) graded children of the old slug are retired; the numbered sibling's children are not", async () => {
    const numbered = OLD + ":num-50";
    const w = world({
      extraCatalog: [
        gradedChild(OLD, "bgs-9-5", { parentSlug: undefined }),           // legacy child, no parentSlug
        atNew({ id: numbered, cardId: numbered, hobbyiqCardId: numbered, setKey: "topps-allen-ginter", printRun: 50 }),
        gradedChild(numbered, "psa-10"),                                    // sibling's child, has parentSlug
        gradedChild(numbered, "psa-9", { parentSlug: undefined }),          // sibling's child, legacy shape
      ],
    });
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool });
    expect(r.gradedChildrenRetired).toBe(3);
    for (const gone of [`${OLD}:psa-10`, `${OLD}:psa-9`, `${OLD}:bgs-9-5`]) expect(w.catalog.docs.has(gone)).toBe(false);
    for (const kept of [numbered, `${numbered}:psa-10`, `${numbered}:psa-9`]) expect(w.catalog.docs.has(kept)).toBe(true);
  });

  it("(5) the survivor is written and every sale re-pointed BEFORE the old row is deleted", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool, repointNormalizedSetKey: true });
    expect(r.salesRepointed).toBe(2);
    const writes = w.catalog.writes();
    const at = (needle: string) => writes.findIndex((l) => l === needle);
    const upsert = at(`card_catalog.upsert ${NEW}`);
    const oldDelete = at(`card_catalog.delete ${OLD}`);
    expect(upsert).toBeGreaterThanOrEqual(0);
    expect(oldDelete).toBe(writes.length - 1);                // the old row goes LAST
    expect(upsert).toBeLessThan(oldDelete);
    const salePatches = writes.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("sold_comps.patch "));
    expect(salePatches.map(([l]) => l)).toEqual(["sold_comps.patch s1", "sold_comps.patch s2"]);
    for (const [, i] of salePatches) { expect(i).toBeGreaterThan(upsert); expect(i).toBeLessThan(oldDelete); }
    for (const child of [`${OLD}:psa-10`, `${OLD}:psa-9`]) expect(at(`card_catalog.delete ${child}`)).toBeLessThan(oldDelete);
    // and what the sales now say
    for (const id of ["s1", "s2"]) {
      const s = w.sales.get(id)!;
      expect(s.hobbyiqCardId).toBe(NEW);
      expect(s.reslugedFrom).toBe(OLD);
      expect(s.reslugedReason).toBe(REASON);
      expect(typeof s.reslugedAt).toBe("string");
      expect(s.normalizedSetKey).toBe("topps-allen-and-ginter");
    }
    expect(w.sales.get("s3")!.hobbyiqCardId).not.toBe(NEW);   // a sale at another card is untouched
  });

  it("normalizedSetKey is stamped only when asked", async () => {
    const w = world();
    await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool });
    expect(w.sales.get("s1")!.normalizedSetKey).toBe("topps-allen-ginter");
    expect(w.sales.get("s1")!.hobbyiqCardId).toBe(NEW);
  });

  it("(6) dryRun writes nothing and still reports what a run would do", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool, dryRun: true });
    expect(r).toMatchObject({ action: "move", newSlug: NEW, salesRepointed: 2, gradedChildrenRetired: 2, survivor: "incoming" });
    expect(w.catalog.writes()).toEqual([]);
    expect(w.catalog.docs.has(OLD)).toBe(true);
    expect(w.catalog.docs.has(NEW)).toBe(false);
    expect(w.catalog.docs.has(`${OLD}:psa-10`)).toBe(true);
    expect(w.sales.get("s1")!.hobbyiqCardId).toBe(OLD);
  });

  it("`known` skips the incumbent read; omitting salesContainer says so", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, known: null });
    expect(w.log).not.toContain(`card_catalog.read ${NEW}`);
    expect(r.action).toBe("move");
    expect(r.salesRepointed).toBe(0);
    expect(r.decision).toMatch(/sales not re-pointed \(no salesContainer\)/);
  });

  it("noop when newSlug is the row's own id; throws when the slug changes product and nobody asked", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), OLD, {}, { reason: REASON, salesContainer: w.pool });
    expect(r.action).toBe("noop");
    // NEW's stem is a different product from OLD's, and changedFields carries
    // no setKey: nobody asked for a rename, so it refuses.
    await expect(moveCatalogRow(w.cat, identityRow(), NEW, {}, { reason: REASON, salesContainer: w.pool })).rejects.toThrow(/no setKey change was asked for/);
    // and a rename whose slug lands on a THIRD product is refused too
    await expect(
      moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-chrome" }, { reason: REASON, salesContainer: w.pool }),
    ).rejects.toThrow(/the caller asked for "topps-chrome"/);
    await expect(moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: "  ", salesContainer: w.pool })).rejects.toThrow(/reason is required/);
    expect(w.catalog.writes()).toEqual([]);
  });
});

// CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT (D30 R2, 2026-08-31). The guard compares
// the SETKEY SEGMENT of the two ids -- split(":")[3], the rule kindOf uses --
// never the setKey FIELD. Checklist-backed rows carry the field "bowman" while
// their id stem says bowman-chrome / bowman-paper BY DESIGN, and the field
// comparison failed thousands of legitimate same-product folds: one
// fold-unnumbered-twins slice looped at folded=0 / failed=184 every 140-minute
// generation because ONLY these remained.
describe("moveCatalogRow: the product is the id stem, not the setKey field", () => {
  /** The live shape: field "bowman", id stem something else. */
  function driftedRow(id: string, over: Doc = {}): Doc {
    const parts = id.split(":");
    return {
      id, cardId: id, hobbyiqCardId: id,
      sport: parts[1], year: Number(parts[2]), cardYear: Number(parts[2]),
      // The FIELD the checklist ingest left: "bowman", never the id's stem.
      setKey: "bowman", setName: "Bowman",
      cardNumber: parts[4].toUpperCase(), parallel: "Base", parallelSlug: parts[5],
      isAuto: parts[6] === "auto", printRun: null,
      playerName: "Konnor Griffin", playerSlug: "konnor-griffin",
      vendorIds: {}, source: "checklistcenter", confidence: 0.95,
      observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-20T00:00:00.000Z",
      searchTokens: ["oldsetonly"], searchText: "stale", displayName: "stale",
      ...over,
    };
  }

  function driftWorld(oldId: string, opts: { incumbent?: Doc } = {}) {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [
      driftedRow(oldId),
      ...(opts.incumbent ? [opts.incumbent] : []),
    ]);
    const sales = new FakeContainer("sold_comps", log, [{ id: "d1", cardId: "pool-d1", hobbyiqCardId: oldId, price: 10 }]);
    return { log, catalog, sales, cat: catalog as unknown as Container, pool: sales as unknown as Container };
  }

  // (a) Tonight's four live failures. Each is an un-numbered -> numbered fold
  // inside ONE product: the id stems match, only the field says "bowman".
  const LIVE: Array<[string, string]> = [
    ["hiq:baseball:2026:bowman-chrome:bcp-50:yellow-refractor:no-auto", "bowman-chrome"],
    ["hiq:baseball:2026:bowman-chrome:cpa-gl:speckle-refractor:auto", "bowman-chrome"],
    ["hiq:baseball:2026:bowman-paper:bp-149:blue-pattern:no-auto", "bowman-paper"],
    ["hiq:baseball:2024:bowman-paper:bp-67:blue:no-auto", "bowman-paper"],
  ];

  for (const [oldId, product] of LIVE) {
    it(`moves ${oldId} onto its numbered twin (field "bowman", id stem "${product}")`, async () => {
      const newSlug = `${oldId}:num-499`;
      const w = driftWorld(oldId);
      const r = await moveCatalogRow(w.cat, driftedRow(oldId), newSlug, { printRun: 499 }, {
        reason: "D30 R2: fold the un-numbered id onto its one checklist numbered twin",
        salesContainer: w.pool,
      });
      expect(r.action).toBe("move");
      expect(r.survivor).toBe("incoming");
      expect(r.salesRepointed).toBe(1);
      const row = w.catalog.docs.get(newSlug)!;
      // (c) the moved row's field ends CONSISTENT with its new id stem --
      // the convention deriveCatalogEntry uses at mint (setKey: parsedSlug[3]).
      expect(row.setKey).toBe(product);
      expect(String(row.id).split(":")[3]).toBe(product);
      expect(row.printRun).toBe(499);
      expect(w.catalog.docs.has(oldId)).toBe(false);
      // and the search fields were rebuilt off the corrected product
      expect(row.searchTokens).not.toContain("oldsetonly");
      expect(row.searchTokens).toContain(product.split("-")[0]);
    });
  }

  it("a drifted field does not stop a same-product FOLD onto an incumbent either", async () => {
    const oldId = "hiq:baseball:2026:bowman-chrome:bcp-50:yellow-refractor:no-auto";
    const newSlug = `${oldId}:num-499`;
    const incumbent = driftedRow(newSlug, { source: "checklistcenter", vendorIds: { cardhedge: "ch-9" }, compCount: 40 });
    const w = driftWorld(oldId, { incumbent });
    const r = await moveCatalogRow(w.cat, driftedRow(oldId), newSlug, { printRun: 499 }, {
      reason: "D30 R2: fold the un-numbered id onto its one checklist numbered twin",
      salesContainer: w.pool,
    });
    expect(r.action).toBe("fold");
    expect(r.survivor).toBe("incumbent");
    expect(r.salesRepointed).toBe(1);
    expect(w.catalog.docs.has(oldId)).toBe(false);
  });

  // (b) The protective intent, kept whole: a fold can never wander across
  // products, and the drifted field is never what lets it. THE SAPPHIRE CASE:
  // the row's field says "bowman", so a field comparison would have compared
  // "bowman-chrome-sapphire" against "bowman" and refused for the wrong
  // reason -- and a field-equality rule that had been "fixed" by trusting the
  // field would have ALLOWED it. The id stem is what refuses.
  it("refuses a bowman-chrome row folded onto a bowman-chrome-sapphire slug", async () => {
    const oldId = "hiq:baseball:2026:bowman-chrome:bcp-50:yellow-refractor:no-auto";
    const sapphire = "hiq:baseball:2026:bowman-chrome-sapphire:bcp-50:yellow-refractor:no-auto:num-499";
    const w = driftWorld(oldId);
    // the exact shape the fold fleet uses: printRun only, no setKey
    await expect(
      moveCatalogRow(w.cat, driftedRow(oldId), sapphire, { printRun: 499 }, { reason: "should refuse", salesContainer: w.pool }),
    ).rejects.toThrow(/no setKey change was asked for/);
    expect(w.catalog.writes()).toEqual([]);
  });

  it("refuses a bowman row folded onto a topps-chrome slug", async () => {
    const oldId = "hiq:baseball:2026:bowman:bp-149:blue:no-auto";
    const toppsChrome = "hiq:baseball:2026:topps-chrome:bp-149:blue:no-auto:num-25";
    const w = driftWorld(oldId);
    await expect(
      moveCatalogRow(w.cat, driftedRow(oldId), toppsChrome, { printRun: 25 }, { reason: "should refuse", salesContainer: w.pool }),
    ).rejects.toThrow(/no setKey change was asked for/);
    expect(w.catalog.writes()).toEqual([]);
  });

  it("even an explicit rename cannot land on a product it did not ask for", async () => {
    const oldId = "hiq:baseball:2026:bowman-chrome:bcp-50:yellow-refractor:no-auto";
    const sapphire = "hiq:baseball:2026:bowman-chrome-sapphire:bcp-50:yellow-refractor:no-auto";
    const w = driftWorld(oldId);
    await expect(
      moveCatalogRow(w.cat, driftedRow(oldId), sapphire, { setKey: "bowman-chrome" }, { reason: "should refuse", salesContainer: w.pool }),
    ).rejects.toThrow(/the caller asked for "bowman-chrome"/);
    expect(w.catalog.writes()).toEqual([]);
  });

  it("the refusal names both ids, so an operator can see which pair was rejected", async () => {
    const oldId = "hiq:baseball:2026:bowman-chrome:bcp-50:yellow-refractor:no-auto";
    const sapphire = "hiq:baseball:2026:bowman-chrome-sapphire:bcp-50:yellow-refractor:no-auto:num-499";
    const w = driftWorld(oldId);
    await expect(
      moveCatalogRow(w.cat, driftedRow(oldId), sapphire, { printRun: 499 }, { reason: "should refuse" }),
    ).rejects.toThrow(/bowman-chrome-sapphire.*bowman-chrome.*bcp-50/s);
  });

  // (d) ONLY-IMPROVE. The drift measured in prod runs in BOTH directions, and
  // the MAJORITY of it is the field being MORE specific than the stem: of 913
  // drifted rows in a 60,000-row sample (~243k extrapolated over 15,997,198
  // hiq rows), 568 had a field that extends the stem against 167 the other
  // way. Those are checklist-minted identities (checklistcenter 467,
  // checklistinsider 357), and a fold must not demote them to the bare stem.
  describe("the field write only improves", () => {
    /** The live prod row the R1 fix would have demoted. */
    const JAPAN = "hiq:baseball:2023:topps:98:cherry-blossom:no-auto";
    function japanRow(id: string, over: Doc = {}): Doc {
      const parts = id.split(":");
      return {
        id, cardId: id, hobbyiqCardId: id,
        sport: "baseball", year: 2023, cardYear: 2023,
        // field MORE specific than the stem `topps` -- and true of 164 of the
        // 913 drifted rows sampled, the single largest pair.
        setKey: "topps-baseball-japan-edition",
        setName: "2023 Topps Baseball Japan Edition",
        brand: "topps-baseball-japan-edition", parentSetKey: "topps-japan",
        cardNumber: parts[4].toUpperCase(), parallel: "Cherry Blossom", parallelSlug: "cherry-blossom",
        isAuto: false, printRun: null,
        playerName: "Shohei Ohtani", playerSlug: "shohei-ohtani",
        vendorIds: {}, source: "checklistcenter-2026-08-29", confidence: 0.95,
        observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-29T00:00:00.000Z",
        ...over,
      };
    }

    it("the live prod row round-trips: a {printRun} fold does NOT touch a field that extends the stem", async () => {
      const newSlug = `${JAPAN}:num-99`;
      const log: string[] = [];
      const catalog = new FakeContainer("card_catalog", log, [japanRow(JAPAN)]);
      const sales = new FakeContainer("sold_comps", log, [{ id: "d1", cardId: "pool-d1", hobbyiqCardId: JAPAN, price: 10 }]);
      const r = await moveCatalogRow(catalog as unknown as Container, japanRow(JAPAN), newSlug, { printRun: 99 }, {
        reason: "D30 R2: fold onto the numbered twin", salesContainer: sales as unknown as Container,
      });
      expect(r.action).toBe("move");
      const row = catalog.docs.get(newSlug)!;
      // the identity SURVIVES -- this is the whole point. brand and
      // parentSetKey are UNTOUCHED: re-deriving would flatten them onto the
      // bare stem (deriveBrand("topps-baseball-japan-edition") === "topps").
      expect(row.setKey).toBe("topps-baseball-japan-edition");
      expect(row.brand).toBe("topps-baseball-japan-edition");
      expect(row.parentSetKey).toBe("topps-japan");
      expect(row.brand).not.toBe(deriveBrand("topps"));
      expect(row.setName).toBe("2023 Topps Baseball Japan Edition");
      // and the move still did its job
      expect(row.printRun).toBe(99);
      expect(String(row.id).split(":")[3]).toBe("topps");
      expect(catalog.docs.has(JAPAN)).toBe(false);
      // searchText was not rebuilt off a demoted identity: the specific
      // product is still searchable.
      expect(String(row.searchText)).toContain("japan");
    });

    // The other four top pairs, same shape, same rule.
    const EXTENDS: Array<[string, string, string]> = [
      ["hiq:baseball:2024:topps:1:base:no-auto", "topps-flagship", "topps"],
      ["hiq:baseball:2024:topps-chrome:50:refractor:no-auto", "topps-chrome-logofractor-edition", "topps-chrome"],
      ["hiq:baseball:2023:topps-transcendent:5:base:auto", "topps-transcendent-collection", "topps-transcendent"],
      ["hiq:baseball:2023:topps-finest:10:base:no-auto", "topps-finest-flashbacks", "topps-finest"],
      // THE LADDER ARM ALONE. `topps-1st-edition` is a spelling of
      // topps-series-1-1st-edition, whose parent is topps-series-1 -- a real
      // refinement of the stem, but NOT a lexical extension of it, so only
      // productAncestry can see it. Drop that arm and this row gets demoted.
      ["hiq:baseball:2024:topps-series-1:99:base:no-auto", "topps-1st-edition", "topps-series-1"],
    ];
    for (const [oldId, field, stem] of EXTENDS) {
      it(`keeps field "${field}" over stem "${stem}" on a fold`, async () => {
        const newSlug = `${oldId}:num-25`;
        const log: string[] = [];
        const row0 = japanRow(oldId, { setKey: field, brand: field, parentSetKey: null, setName: field });
        const catalog = new FakeContainer("card_catalog", log, [row0]);
        const r = await moveCatalogRow(catalog as unknown as Container, row0, newSlug, { printRun: 25 }, { reason: "fold" });
        expect(r.action).toBe("move");
        expect(catalog.docs.get(newSlug)!.setKey).toBe(field);
        // brand is left as it was found -- not re-derived onto the stem
        expect(catalog.docs.get(newSlug)!.brand).toBe(field);
        expect(String(catalog.docs.get(newSlug)!.id).split(":")[3]).toBe(stem);
      });
    }

    // The other direction is untouched: a field that is stale-GENERIC relative
    // to the stem is still corrected to the stem. `bowman` does not extend
    // `bowman-chrome` on either arm.
    it("a stale-generic field is still corrected to the stem", async () => {
      const oldId = "hiq:baseball:2026:bowman-chrome:bcp-50:yellow-refractor:no-auto";
      const newSlug = `${oldId}:num-499`;
      const w = driftWorld(oldId);
      await moveCatalogRow(w.cat, driftedRow(oldId), newSlug, { printRun: 499 }, { reason: "fold", salesContainer: w.pool });
      expect(w.catalog.docs.get(newSlug)!.setKey).toBe("bowman-chrome");
    });

    // ...and so is an UNRELATED field. donruss-optic is a rival SPELLING of
    // panini-optic, not a release of it (73 of the 913 sampled): neither the
    // ladder nor the lexical arm fires, so the stem wins.
    it("an unrelated field is corrected to the stem, not mistaken for a refinement", async () => {
      const oldId = "hiq:basketball:2023:panini-optic:15:base:no-auto";
      const newSlug = `${oldId}:num-10`;
      const log: string[] = [];
      const row0 = japanRow(oldId, { setKey: "donruss-optic", sport: "basketball", brand: "donruss", parentSetKey: null });
      const catalog = new FakeContainer("card_catalog", log, [row0]);
      await moveCatalogRow(catalog as unknown as Container, row0, newSlug, { printRun: 10 }, { reason: "fold" });
      expect(catalog.docs.get(newSlug)!.setKey).toBe("panini-optic");
      expect(catalog.docs.get(newSlug)!.brand).toBe(deriveBrand("panini-optic"));
    });

    // A RENAME is a ruling: it lands on WHAT IT ASKED FOR, and only-improve
    // does not get a vote. This is the shape that isolates the lane check --
    // the field `topps-flagship` DOES extend the asked-for stem `topps`, so
    // the extends test alone would keep it. Only `askedSetKey === null` stops
    // that: an operator who rules a row onto `topps` gets `topps`.
    it("an explicit rename overrides even a field that extends what was asked for", async () => {
      const oldId = "hiq:baseball:2024:topps-chrome:1:base:no-auto";
      const renamed = "hiq:baseball:2024:topps:1:base:no-auto";
      const log: string[] = [];
      const row0 = japanRow(oldId, { setKey: "topps-flagship", brand: "topps-flagship" });
      const catalog = new FakeContainer("card_catalog", log, [row0]);
      await moveCatalogRow(catalog as unknown as Container, row0, renamed, { setKey: "topps" }, { reason: "ruling" });
      expect(catalog.docs.get(renamed)!.setKey).toBe("topps");
      expect(catalog.docs.get(renamed)!.brand).toBe(deriveBrand("topps"));
    });

    // MUTANT C. `setKeyChanged` is `written !== oldStem || written !== oldField`
    // and BOTH clauses are load-bearing. This is the shape that isolates the
    // FIRST one: the row's field is `bowman-chrome` over an id stem `bowman`,
    // and the caller renames it to `bowman-chrome`. The written setKey then
    // EQUALS the old field -- so the field clause is false -- while the
    // product genuinely moved bowman -> bowman-chrome. Narrowing the test back
    // to the field-only comparison leaves brand / parentSetKey stale here.
    it("re-derives brand when the STEM moved even though the field already matched", async () => {
      const oldId = "hiq:baseball:2026:bowman:bp-149:blue:no-auto";
      const renamed = "hiq:baseball:2026:bowman-chrome:bp-149:blue:no-auto";
      const log: string[] = [];
      const row0 = japanRow(oldId, {
        // field already says bowman-chrome; the ID still says bowman
        setKey: "bowman-chrome",
        // ...and brand / parentSetKey are STALE, computed off the old `bowman`
        brand: "STALE-BRAND", parentSetKey: "STALE-PARENT",
      });
      const catalog = new FakeContainer("card_catalog", log, [row0]);
      await moveCatalogRow(catalog as unknown as Container, row0, renamed, { setKey: "bowman-chrome" }, { reason: "ruling" });
      const row = catalog.docs.get(renamed)!;
      expect(row.setKey).toBe("bowman-chrome");
      expect(row.brand).toBe(deriveBrand("bowman-chrome"));
      expect(row.brand).not.toBe("STALE-BRAND");
      expect(row.parentSetKey).toBe(deriveParentSetKey("bowman-chrome"));
      expect(row.parentSetKey).not.toBe("STALE-PARENT");
    });
  });

  it("an explicit rename off a DRIFTED field still works: the field never decides", async () => {
    // field "bowman", id stem "bowman-paper", ruled onto bowman-chrome. The
    // old field matches neither side; only the asked-for setKey matters.
    const oldId = "hiq:baseball:2026:bowman-paper:bp-149:blue-pattern:no-auto";
    const renamed = "hiq:baseball:2026:bowman-chrome:bp-149:blue-pattern:no-auto";
    const w = driftWorld(oldId);
    const r = await moveCatalogRow(w.cat, driftedRow(oldId), renamed, { setKey: "bowman-chrome" }, {
      reason: "setKey ruling applied", repointNormalizedSetKey: true, salesContainer: w.pool,
    });
    expect(r.action).toBe("move");
    const row = w.catalog.docs.get(renamed)!;
    expect(row.setKey).toBe("bowman-chrome");
    expect(w.sales.get("d1")!.normalizedSetKey).toBe("bowman-chrome");
  });
});

describe("moveCatalogRow: a rehome (same slug, foreign partition)", () => {
  // The 17.7M-row shape rehome-catalog-rows-to-own-partition exists for: a
  // correct slug in `id`, a CardHedge vendor id in `cardId`, invisible to the
  // (slug, slug) point read.
  const VENDOR = "1775832219776x807179689237410600";
  const foreign = (over: Doc = {}) => identityRow({ cardId: VENDOR, source: "cardhedge", vendorIds: {}, ...over });

  it("(7) copies the row to (slug, slug), keeps the vendor partition key as a cross-reference, and re-derives nothing", async () => {
    const w = world({ old: foreign() });
    const r = await moveCatalogRow(w.cat, foreign(), OLD, {}, { reason: "re-homed", salesContainer: w.pool });
    expect(r).toMatchObject({ action: "move", newSlug: OLD, salesRepointed: 0, gradedChildrenRetired: 0, survivor: "incoming" });
    expect(r.decision).toBe(`rehome from partition ${VENDOR}: no row at ${OLD}; sales and graded children stay (the slug did not change)`);
    const home = w.catalog.get(OLD, OLD)!;
    expect(home.cardId).toBe(OLD);
    expect(home.vendorIds).toEqual({ cardhedge: VENDOR });
    expect(home.rehomedFrom).toBe(VENDOR);
    expect(home.rehomedReason).toBe("re-homed");
    expect(home.movedFrom).toBeUndefined();
    expect(home.searchTokens).toContain("oldsetonly");     // the card did not change: nothing rebuilt
    expect(home.checklistBacking).toBe("confirmed");       // still describes this slug
    expect(home._etag).toBeUndefined();
    expect(w.catalog.has(OLD, VENDOR)).toBe(false);        // the foreign copy is gone
    // its own ladder and its sales are untouched
    for (const child of [`${OLD}:psa-10`, `${OLD}:psa-9`]) expect(w.catalog.has(child)).toBe(true);
    expect(w.sales.get("s1")).toEqual(sale("s1", OLD));
    expect(w.catalog.writes()).toEqual([`card_catalog.upsert ${OLD}`, `card_catalog.delete ${OLD}`]);
  });

  it("a copy already at (slug, slug) is the half-finished move: decided by authority, vendorIds unioned, the foreign copy retired", async () => {
    const w = world({ old: identityRow({ vendorIds: { cardhedge: "ch-9" } }), extraCatalog: [foreign({ vendorIds: { cardsight: "cs-1" } })] });
    const r = await moveCatalogRow(w.cat, foreign({ vendorIds: { cardsight: "cs-1" } }), OLD, {}, { reason: "re-homed", salesContainer: w.pool });
    expect(r.action).toBe("fold");
    expect(r.decision).toMatch(/^rehome from partition \d+x\d+: authority: incumbent beckett-scraped-2026-08-19 \(rank 3\) outranks incoming cardhedge \(rank 2\)/);
    const home = w.catalog.get(OLD, OLD)!;
    expect(home.source).toBe("beckett-scraped-2026-08-19");
    expect(home.vendorIds).toEqual({ cardhedge: "ch-9", cardsight: "cs-1" });   // the survivor's ch-9 wins the key clash
    expect(w.catalog.has(OLD, VENDOR)).toBe(false);
    expect(w.catalog.has(`${OLD}:psa-10`)).toBe(true);
    expect(w.catalog.writes()).toEqual([`card_catalog.upsert ${OLD}`, `card_catalog.delete ${OLD}`]);
  });

  it("dryRun rehome writes nothing; a row already in its own partition is still a noop", async () => {
    const w = world({ old: foreign() });
    const dry = await moveCatalogRow(w.cat, foreign(), OLD, {}, { reason: "re-homed", dryRun: true });
    expect(dry).toMatchObject({ action: "move", salesRepointed: 0, gradedChildrenRetired: 0 });
    expect(w.catalog.writes()).toEqual([]);
    expect(w.catalog.has(OLD, VENDOR)).toBe(true);
    const home = await moveCatalogRow(w.cat, identityRow(), OLD, {}, { reason: "re-homed" });
    expect(home.action).toBe("noop");
  });
});

describe("retireCatalogRow", () => {
  it("retires the graded children, then the row; stamps nothing on the sales", async () => {
    const w = world();
    const r = await retireCatalogRow(w.cat, OLD, OLD, "unconfirmed auto-seed window");
    expect(r).toMatchObject({ action: "retire", id: OLD, rowDeleted: true, gradedChildrenRetired: 2, reason: "unconfirmed auto-seed window" });
    expect(w.catalog.docs.has(OLD)).toBe(false);
    expect(w.catalog.docs.has(`${OLD}:psa-10`)).toBe(false);
    const writes = w.catalog.writes();
    expect(writes[writes.length - 1]).toBe(`card_catalog.delete ${OLD}`);
    expect(writes.some((l) => l.startsWith("sold_comps."))).toBe(false);
    expect(w.sales.get("s1")).toEqual(sale("s1", OLD));
  });

  it("dryRun writes nothing; an absent row is a noop", async () => {
    const w = world();
    const dry = await retireCatalogRow(w.cat, OLD, OLD, "dry", { dryRun: true });
    expect(dry).toMatchObject({ action: "retire", rowDeleted: true, gradedChildrenRetired: 2 });
    expect(w.catalog.writes()).toEqual([]);
    const gone = await retireCatalogRow(w.cat, "hiq:baseball:1999:nothing:1:base:no-auto", null, "gone");
    expect(gone).toMatchObject({ action: "noop", rowDeleted: false, gradedChildrenRetired: 0 });
  });
});

describe("moveCatalogRow: a graded child can MOVE, not only be swept up", () => {
  /**
   * THE 2026-09-07 CROWN ZENITH INCIDENT.
   *
   * All 292 rows of the Galarian Gallery list failed their apply with
   *
   *   moveCatalogRow: newSlug is not a hiq slug:
   *   hiq:pokemon:2023:swsh12-5gg:gg01:full-art:no-auto:cgc-10
   *
   * and the list was RIGHT: every one of those 292 is a graded child, whose id
   * is `${parentSlug}:${tier}` by this module's own contract, and every
   * destination differs from its source in the product segment alone.
   * `parseHobbyIqCardId` deserializes a CARD identity and a grade tier is not
   * part of that grammar, so it returned null and buildIncoming threw.
   *
   * moveCatalogRow already RETIRES graded children by
   * `STARTSWITH(c.id, parent + ":") AND IS_DEFINED(c.gradeTier)`. It could
   * sweep one up but never move one -- a position nobody chose.
   *
   * The parser itself is NOT loosened (61 call sites, the matcher's hot path
   * among them); the split lives here, and uses the tier rule already written
   * down for isGradedChildOf: one segment, never `num-`.
   */
  // identityRow() carries a CARD id, and gradedChild spreads its overrides
  // last -- so passing it as an override clobbers the child id. Build the
  // card first, then stamp the graded identity over it.
  const gradedOf = (parent: string, tier: string): Doc => ({
    ...identityRow(),
    ...gradedChild(parent, tier),
  });

  const CHILD_OLD = `${OLD}:cgc-10`;
  const CHILD_NEW = `${NEW}:cgc-10`;

  it("moves a graded child across a product rename", async () => {
    const w = world();
    const r = await moveCatalogRow(
      w.cat, gradedOf(OLD, "cgc-10") as never, CHILD_NEW,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    );
    expect(r.action).toBe("move");
    expect(r.newSlug).toBe(CHILD_NEW);
    const landed = w.catalog.docs.get(CHILD_NEW)!;
    expect(landed).toBeDefined();
    expect(landed.setKey).toBe("topps-allen-and-ginter");
  });

  it("THE GRADED ANNOTATIONS FOLLOW: parentSlug points at the NEW parent", async () => {
    // Leaving parentSlug behind would orphan the child onto the address the
    // move just vacated -- a graded row hanging off a card that no longer
    // exists is exactly the split-pool shape this lane exists to close.
    const w = world();
    await moveCatalogRow(
      w.cat, gradedOf(OLD, "cgc-10") as never, CHILD_NEW,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    );
    const landed = w.catalog.docs.get(CHILD_NEW)!;
    expect(landed.parentSlug).toBe(NEW);
    expect(landed.gradeTier).toBe("cgc-10");
  });

  it("MUTATION: reject the graded tail -> the 292 fail again -> red", async () => {
    // The shipped 2026-09-06 behaviour, asserted as the thing that changed.
    const w = world();
    await expect(moveCatalogRow(
      w.cat, gradedOf(OLD, "cgc-10") as never, CHILD_NEW,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    )).resolves.toMatchObject({ action: "move" });
    // ...and the exact production slug shape parses, rather than throwing.
    const zenithChild = {
      ...identityRow(),
      id: "hiq:pokemon:2023:swsh12-5:gg01:full-art:no-auto:cgc-10",
      cardId: "hiq:pokemon:2023:swsh12-5:gg01:full-art:no-auto:cgc-10",
      parentSlug: "hiq:pokemon:2023:swsh12-5:gg01:full-art:no-auto",
      gradeTier: "cgc-10",
      sport: "pokemon", year: 2023, cardYear: 2023,
      setKey: "panini-zenith", cardNumber: "gg01", parallel: "Full Art", parallelSlug: "full-art",
      playerName: "Rillaboom",
    };
    const w2 = world({ old: zenithChild });
    const r = await moveCatalogRow(
      w2.cat, zenithChild as never,
      "hiq:pokemon:2023:swsh12-5gg:gg01:full-art:no-auto:cgc-10",
      { setKey: "swsh12-5gg" }, { reason: REASON, salesContainer: w2.pool },
    );
    expect(r.action).toBe("move");
    expect(r.newSlug).toBe("hiq:pokemon:2023:swsh12-5gg:gg01:full-art:no-auto:cgc-10");
  });

  it("A PRINT-RUN SEGMENT IS NOT A GRADE — num- is never read as a tier", async () => {
    // `hiq:…:no-auto:num-50` is the NUMBERED SIBLING, a card in its own right,
    // and must keep parsing as a card. Reading `num-50` as a grade tier would
    // make every numbered card a graded child of its unnumbered twin.
    const w = world();
    const numberedOld = `${OLD}:num-50`;
    const numberedNew = `${NEW}:num-50`;
    const row = identityRow({ id: numberedOld, cardId: numberedOld, hobbyiqCardId: numberedOld, printRun: 50 });
    const r = await moveCatalogRow(
      w.cat, row as never, numberedNew,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    );
    expect(r.action).toBe("move");
    const landed = w.catalog.docs.get(numberedNew)!;
    expect(landed.printRun).toBe(50);
    // It is a CARD, so it gains no graded annotations.
    expect(landed.parentSlug).toBeUndefined();
    expect(landed.gradeTier).toBeUndefined();

    // AND THE SPLIT ITSELF MUST REFUSE `num-`, not merely decline to reach it.
    // The case above parses directly as a card, so it never exercises the
    // tail split at all. A slug whose head does NOT parse and whose tail is a
    // print run -- `…:no-auto:num-50:num-25`, a shape no builder mints -- is
    // the one that proves the `num-` exclusion is load-bearing: without it the
    // split would accept `num-25` as a grade tier and mint a graded identity
    // with no grade.
    await expect(moveCatalogRow(
      w.cat, identityRow() as never, `${NEW}:num-50:num-25`,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    )).rejects.toThrow(/is not a hiq slug/);
  });

  it("and a genuinely malformed slug still throws", async () => {
    const w = world();
    for (const bad of [
      "hiq:baseball:2024:topps-allen-and-ginter:1:base",          // no auto flag
      "hiq:baseball:2024:topps-allen-and-ginter:1:base:maybe",    // not an auto flag
      "not-a-slug-at-all",
    ]) {
      await expect(moveCatalogRow(
        w.cat, identityRow() as never, bad,
        { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
      )).rejects.toThrow(/is not a hiq slug|cross-product move/);
    }
  });

  it("A CARD MAY NOT MOVE ONTO A GRADED ADDRESS, nor a child onto a card's", async () => {
    // The two shapes are different kinds of row; silently converting one into
    // the other would mint a graded identity with no grade, or a card whose id
    // carries someone's tier.
    const w = world();
    await expect(moveCatalogRow(
      w.cat, identityRow() as never, CHILD_NEW,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    )).rejects.toThrow(/cannot move onto a graded address/);
    await expect(moveCatalogRow(
      w.cat, gradedOf(OLD, "cgc-10") as never, NEW,
      { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool },
    )).rejects.toThrow(/cannot move onto a card address/);
  });

  it("the cross-product guard still applies to a graded child's PARENT stem", async () => {
    // The setKey assertion reads the head of the slug, so a graded child gets
    // exactly the same protection its parent would: no silent product change.
    const w = world();
    await expect(moveCatalogRow(
      w.cat, gradedOf(OLD, "cgc-10") as never, CHILD_NEW,
      {}, { reason: REASON, salesContainer: w.pool },
    )).rejects.toThrow(/newSlug says setKey .* but the row's id says/);
  });
});

describe("isGradedChildOf", () => {
  const parent = "hiq:baseball:2024:topps:1:gold:no-auto";
  it("accepts the parent's own tiers and rejects the numbered sibling's", () => {
    expect(isGradedChildOf({ id: `${parent}:psa-10`, parentSlug: parent }, parent)).toBe(true);
    expect(isGradedChildOf({ id: `${parent}:psa-10` }, parent)).toBe(true);
    expect(isGradedChildOf({ id: `${parent}:num-50:psa-10`, parentSlug: `${parent}:num-50` }, parent)).toBe(false);
    expect(isGradedChildOf({ id: `${parent}:num-50:psa-10` }, parent)).toBe(false);
    expect(isGradedChildOf({ id: `${parent}:num-50` }, parent)).toBe(false);   // not graded at all
    expect(isGradedChildOf({ id: "hiq:other:psa-10" }, parent)).toBe(false);
  });
});
