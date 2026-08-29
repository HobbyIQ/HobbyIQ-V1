// CF-ONE-WAY-TO-MOVE-A-CATALOG-ROW (D5 PR 2). Pins the four defects the
// 15-copy census found, on in-memory fakes of card_catalog and sold_comps:
//
//   1. authority never loses to a derived incumbent
//   2. vendorIds union on a fold
//   3. searchTokens / searchText / displayName rebuilt on a setKey change
//   4. graded children retired -- and ONLY the old slug's own children
//   5. sales re-pointed, survivor written, BEFORE the old row is deleted
//   6. dryRun writes nothing
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

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

/** Just enough of @azure/cosmos Container for the two operations: point
 *  read / patch / delete by id, upsert, and the two query shapes the service
 *  issues. Anything else throws so a new query cannot pass by accident. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(d.id, structuredClone(d));
  }
  item(id: string, _pk?: string) {
    return {
      read: async () => {
        this.log.push(`${this.name}.read ${id}`);
        const d = this.docs.get(id);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        const d = this.docs.get(id);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op !== "set") throw new Error(`fake: unsupported patch op ${o.op}`);
          d[o.path.slice(1)] = o.value;
        }
        this.log.push(`${this.name}.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!this.docs.has(id)) throw notFound();
        this.docs.delete(id);
        this.log.push(`${this.name}.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(doc.id, structuredClone(doc));
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
    expect(w.sales.docs.get("s1")!.hobbyiqCardId).toBe(NEW);  // and its sales still follow
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
      const s = w.sales.docs.get(id)!;
      expect(s.hobbyiqCardId).toBe(NEW);
      expect(s.reslugedFrom).toBe(OLD);
      expect(s.reslugedReason).toBe(REASON);
      expect(typeof s.reslugedAt).toBe("string");
      expect(s.normalizedSetKey).toBe("topps-allen-and-ginter");
    }
    expect(w.sales.docs.get("s3")!.hobbyiqCardId).not.toBe(NEW);   // a sale at another card is untouched
  });

  it("normalizedSetKey is stamped only when asked", async () => {
    const w = world();
    await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool });
    expect(w.sales.docs.get("s1")!.normalizedSetKey).toBe("topps-allen-ginter");
    expect(w.sales.docs.get("s1")!.hobbyiqCardId).toBe(NEW);
  });

  it("(6) dryRun writes nothing and still reports what a run would do", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, salesContainer: w.pool, dryRun: true });
    expect(r).toMatchObject({ action: "move", newSlug: NEW, salesRepointed: 2, gradedChildrenRetired: 2, survivor: "incoming" });
    expect(w.catalog.writes()).toEqual([]);
    expect(w.catalog.docs.has(OLD)).toBe(true);
    expect(w.catalog.docs.has(NEW)).toBe(false);
    expect(w.catalog.docs.has(`${OLD}:psa-10`)).toBe(true);
    expect(w.sales.docs.get("s1")!.hobbyiqCardId).toBe(OLD);
  });

  it("`known` skips the incumbent read; omitting salesContainer says so", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: REASON, known: null });
    expect(w.log).not.toContain(`card_catalog.read ${NEW}`);
    expect(r.action).toBe("move");
    expect(r.salesRepointed).toBe(0);
    expect(r.decision).toMatch(/sales not re-pointed \(no salesContainer\)/);
  });

  it("noop when newSlug is the row's own id; throws when the slug and the setKey disagree", async () => {
    const w = world();
    const r = await moveCatalogRow(w.cat, identityRow(), OLD, {}, { reason: REASON, salesContainer: w.pool });
    expect(r.action).toBe("noop");
    await expect(moveCatalogRow(w.cat, identityRow(), NEW, {}, { reason: REASON, salesContainer: w.pool })).rejects.toThrow(/a key needs both halves/);
    await expect(moveCatalogRow(w.cat, identityRow(), NEW, { setKey: "topps-allen-and-ginter" }, { reason: "  ", salesContainer: w.pool })).rejects.toThrow(/reason is required/);
    expect(w.catalog.writes()).toEqual([]);
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
    expect(w.sales.docs.get("s1")).toEqual(sale("s1", OLD));
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
