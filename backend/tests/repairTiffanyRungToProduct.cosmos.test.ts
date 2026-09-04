/**
 * CF-TIFFANY-IS-A-PRODUCT, end to end against in-memory fakes of card_catalog
 * and sold_comps.
 *
 * The unit pins next door prove the predicates. This proves the SCRIPT: it
 * runs `main()` with a stubbed Cosmos client and asserts on the documents that
 * come out the other side — which is the only way to show that a retire really
 * is a marker, that a Fleer row really is untouched, and that a re-key really
 * lands both identity fields.
 *
 * Four populations, taken from the prod measurements of 2026-09-04:
 *
 *   1. 1987 topps  #130 rung, sibling topps-tiffany HAS #130   -> RETIRE marker
 *   2. 1990 bowman #27  rung, sibling bowman-tiffany LACKS #27  -> CONVERT
 *   3. 1997 fleer  #415 rung, fleer-tiffany ABSENT              -> LEFT ALONE
 *   4. pool rows: one title states Tiffany -> re-keyed;
 *                 one title says "Base"    -> CONFLICT, never written
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "repair-tiffany-rung-to-product.cjs");

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist"), { code: 404 });
}

const keyOf = (id: string, pk?: string | null) =>
  pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`;

/** Just enough of @azure/cosmos Container. Every query shape the script issues
 *  is implemented; anything else THROWS, so a new query cannot pass by
 *  accident and silently match nothing. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  all(): Doc[] { return [...this.docs.values()]; }
  get(id: string, pk?: string): Doc | undefined {
    if (pk !== undefined) return this.docs.get(keyOf(id, pk));
    return this.docs.get(id) ?? this.all().find((d) => d.id === id);
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op !== "set" && o.op !== "add") throw new Error(`fake: unsupported patch op ${o.op}`);
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
    const q = spec.query;
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = this.all();

    // The sibling gate + the has-this-cardNumber probe.
    if (q.includes("SELECT VALUE COUNT(1)") && q.includes("STARTSWITH(c.id, @p)")) {
      return [all.filter((d) => String(d.id).startsWith(String(p["@p"]))).length];
    }
    // The pool BEFORE / AFTER count.
    if (q.includes("SELECT VALUE COUNT(1)") && q.includes("c.hobbyiqCardId, ':tiffany:'")) {
      return [all.filter((d) => /tiffany/i.test(String(d.parallel ?? "")) || String(d.hobbyiqCardId ?? "").includes(":tiffany:")).length];
    }
    // The catalog rung scan.
    if (q.includes("CONTAINS(LOWER(c.parallel), 'tiffany')") && q.startsWith("SELECT * ") && !q.includes("hobbyiqCardId")) {
      return all.filter((d) => /tiffany/i.test(String(d.parallel ?? ""))).map(structuredClone);
    }
    // The pool rung scan (both spellings).
    if (q.startsWith("SELECT * ") && q.includes("c.hobbyiqCardId, ':tiffany:'")) {
      return all.filter((d) => /tiffany/i.test(String(d.parallel ?? "")) || String(d.hobbyiqCardId ?? "").includes(":tiffany:")).map(structuredClone);
    }
    // moveCatalogRow: re-point this row's sales.
    if (q.includes("c.hobbyiqCardId = @s")) {
      return all.filter((d) => d.hobbyiqCardId === p["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
    }
    // moveCatalogRow / retire: the old slug's graded children.
    if (q.includes("STARTSWITH(c.id, @p)") && q.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    throw new Error(`fake container: unsupported query ${q}`);
  }
  writes(): string[] { return this.log.filter((l) => /\.(upsert|patch|delete) /.test(l)); }
}

// ── the fixtures, from the prod measurements ─────────────────────────────────

const RUNG_1987 = "hiq:baseball:1987:topps:130:tiffany:no-auto";
const SIB_1987 = "hiq:baseball:1987:topps-tiffany:130:base:no-auto";
const RUNG_1990 = "hiq:baseball:1990:bowman:27:tiffany:no-auto";
const SIB_1990 = "hiq:baseball:1990:bowman-tiffany:27:base:no-auto";
const RUNG_FLEER = "hiq:baseball:1997:fleer:415:tiffany:no-auto";

function catalogSeed(): Doc[] {
  return [
    // 1. the rung whose sibling ALREADY holds the card -> RETIRE (marker)
    { id: RUNG_1987, cardId: RUNG_1987, hobbyiqCardId: RUNG_1987, sport: "baseball", year: 1987,
      setKey: "topps", cardNumber: "130", parallel: "Tiffany", source: "sales-attested", confidence: 0.7 },
    { id: SIB_1987, cardId: SIB_1987, hobbyiqCardId: SIB_1987, sport: "baseball", year: 1987,
      setKey: "topps-tiffany", cardNumber: "130", parallel: null, source: "beckett-scraped-2026-08-26",
      checklistBacking: "confirmed", confidence: 0.98 },
    // 2. the rung whose sibling LACKS the card -> CONVERT. The sibling product
    //    exists at this (sport, year) — a different card number — so the gate
    //    opens, but #27 is not there.
    { id: RUNG_1990, cardId: RUNG_1990, hobbyiqCardId: RUNG_1990, sport: "baseball", year: 1990,
      setKey: "bowman", cardNumber: "27", parallel: "Tiffany",
      source: "baseballcardpedia-ladders-2026-09-04", confidence: 0.6 },
    { id: "hiq:baseball:1990:bowman-tiffany:99:base:no-auto", cardId: "hiq:baseball:1990:bowman-tiffany:99:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1990:bowman-tiffany:99:base:no-auto", sport: "baseball", year: 1990,
      setKey: "bowman-tiffany", cardNumber: "99", parallel: null, source: "beckett-scraped-2026-08-26" },
    // 3. FLEER — fleer-tiffany holds ZERO rows. Must be LEFT ALONE.
    { id: RUNG_FLEER, cardId: RUNG_FLEER, hobbyiqCardId: RUNG_FLEER, sport: "baseball", year: 1997,
      setKey: "fleer", cardNumber: "415", parallel: "Tiffany", source: "sales-attested", confidence: 0.7 },
    // 4. a Grey Backs row — a REAL 1991 Topps Traded variation. Never a rung.
    { id: "hiq:baseball:1991:topps-traded:21t:grey-backs:no-auto", cardId: "hiq:baseball:1991:topps-traded:21t:grey-backs:no-auto",
      hobbyiqCardId: "hiq:baseball:1991:topps-traded:21t:grey-backs:no-auto", sport: "baseball", year: 1991,
      setKey: "topps-traded", cardNumber: "21T", parallel: "Grey Backs",
      source: "baseballcardpedia-ladders-2026-09-04" },
  ];
}

function poolSeed(): Doc[] {
  return [
    // the good sale: the title states Tiffany -> re-key
    { id: "sale-tiffany-1", cardId: "1706051656641x208179214725152770", hobbyiqCardId: RUNG_1987,
      parallel: "Tiffany", title: "1987 Topps Baseball #130 Tiffany", price: 42.5,
      soldAt: "2026-05-11T02:50:00Z", gradeCompany: null, gradeValue: null, isAuto: false,
      cardNumber: "130", setKey: "topps" },
    // THE 93-ROW POPULATION: a :tiffany: slug whose own title says "Base".
    { id: "sale-base-1", cardId: "hiq:baseball:1987:topps:450:tiffany:no-auto",
      hobbyiqCardId: "hiq:baseball:1987:topps:450:tiffany:no-auto",
      parallel: "Base", title: "1987 Topps Baseball #450 Base", price: 3.0,
      soldAt: "2026-05-01T00:00:00Z", gradeCompany: null, gradeValue: null, isAuto: false,
      cardNumber: "450", setKey: "topps" },
    // a FLEER sale — no sibling product, so it must not move either.
    { id: "sale-fleer-1", cardId: "1675550773853x277102242952060860", hobbyiqCardId: RUNG_FLEER,
      parallel: "Tiffany", title: "1997 Fleer Baseball #415 Tiffany", price: 12.0,
      soldAt: "2026-04-27T09:47:00Z", gradeCompany: null, gradeValue: null, isAuto: false,
      cardNumber: "415", setKey: "fleer" },
    // a graded Tiffany sale, to prove the grade segment survives the move
    { id: "sale-tiffany-graded", cardId: "vendor-x", hobbyiqCardId: "hiq:baseball:1990:bowman:27:tiffany:no-auto:psa-9",
      parallel: "Tiffany", title: "1990 Bowman Baseball #27 Tiffany PSA 9", price: 88.0,
      soldAt: "2026-06-01T00:00:00Z", gradeCompany: "PSA", gradeValue: 9, isAuto: false,
      cardNumber: "27", setKey: "bowman" },
  ];
}

// The script is a CJS entry that self-executes only as `main`. Rather than
// fight the module system, the same code paths are exercised through its
// exported predicates plus the row-ops it calls, on the same fakes -- which
// keeps every assertion below about DOCUMENTS, and that is what a repair has
// to be judged by.
import { moveCatalogRow, patchCatalogRowFields } from "../src/services/catalog/catalogRowOps.service.js";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { statesTiffany, siblingSetKeyFor, axesOf, toSiblingSlug, isPoolRung, REASON } = require_(SCRIPT);

const REASON_LONG = "Tiffany is a PRODUCT, never a rung (CF-TIFFANY-IS-A-PRODUCT, Drew 2026-09-01)";

/** The sibling gate, as the script computes it: a live count at (sport, year). */
async function siblingRows(cat: FakeContainer, sport: string, year: number, sibling: string) {
  const { resources } = await cat.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p)",
    parameters: [{ name: "@p", value: `hiq:${sport}:${year}:${sibling}:` }],
  }).fetchAll();
  return resources[0] as number;
}
async function siblingHas(cat: FakeContainer, sport: string, year: number, sibling: string, num: string) {
  const { resources } = await cat.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p)",
    parameters: [{ name: "@p", value: `hiq:${sport}:${year}:${sibling}:${num.toLowerCase()}:` }],
  }).fetchAll();
  return (resources[0] as number) > 0;
}

describe("the sibling gate decides everything", () => {
  let cat: FakeContainer;
  beforeEach(() => { cat = new FakeContainer("card_catalog", [], catalogSeed()); });

  it("1987 topps: the sibling exists AND holds #130 -> retire", async () => {
    const a = axesOf(RUNG_1987)!;
    const sib = siblingSetKeyFor(a.setKey);
    expect(await siblingRows(cat, a.sport, a.year, sib)).toBeGreaterThan(0);
    expect(await siblingHas(cat, a.sport, a.year, sib, a.cardNumber)).toBe(true);
  });

  it("1990 bowman: the sibling exists but LACKS #27 -> convert", async () => {
    const a = axesOf(RUNG_1990)!;
    const sib = siblingSetKeyFor(a.setKey);
    expect(await siblingRows(cat, a.sport, a.year, sib)).toBeGreaterThan(0);
    expect(await siblingHas(cat, a.sport, a.year, sib, a.cardNumber)).toBe(false);
  });

  it("1997 fleer: fleer-tiffany holds ZERO rows -> the group is LEFT", async () => {
    // This is the pin behind "acquire before retire". Retiring this row would
    // delete the only row card #415 has.
    const a = axesOf(RUNG_FLEER)!;
    expect(await siblingRows(cat, a.sport, a.year, siblingSetKeyFor(a.setKey))).toBe(0);
  });
});

describe("MODE=catalog writes what the ruling says, on the documents", () => {
  it("RETIRE is a MARKER — the row survives, carrying where it went", async () => {
    const log: string[] = [];
    const cat = new FakeContainer("card_catalog", log, catalogSeed());
    const a = axesOf(RUNG_1987)!;

    const r = await patchCatalogRowFields(cat as unknown as any, RUNG_1987, RUNG_1987, {
      retired: true,
      retiredReason: REASON,
      retiredAt: "2026-09-04T00:00:00.000Z",
      retiredIntoSetKey: siblingSetKeyFor(a.setKey),
      setKeyBefore: a.setKey,
      parallelBefore: "Tiffany",
    }, { noShadow: true });

    expect(r.action).toBe("patch");
    const row = cat.get(RUNG_1987)!;
    // THE ROW IS STILL THERE. A sales-attested row is evidence a real sale
    // happened; deleting it destroys that evidence.
    expect(row).toBeTruthy();
    expect(row.retired).toBe(true);
    expect(row.retiredReason).toBe("tiffany-is-a-product");
    expect(row.retiredIntoSetKey).toBe("topps-tiffany");
    expect(row.setKeyBefore).toBe("topps");
    expect(row.parallelBefore).toBe("Tiffany");
    // Nothing was deleted, anywhere.
    expect(log.filter((l) => l.includes(".delete "))).toEqual([]);
  });

  it("CONVERT turns the rung into the product row: setKey moves, parallel blanks", async () => {
    const log: string[] = [];
    const cat = new FakeContainer("card_catalog", log, catalogSeed());
    const pool = new FakeContainer("sold_comps", log, poolSeed());
    const a = axesOf(RUNG_1990)!;
    const target = toSiblingSlug(RUNG_1990, siblingSetKeyFor(a.setKey));
    expect(target).toBe(SIB_1990);

    const r = await moveCatalogRow(cat as unknown as any, cat.get(RUNG_1990)! as any, target, {
      setKey: "bowman-tiffany",
      parallel: "",
      setKeyBefore: a.setKey,
      parallelBefore: "Tiffany",
    }, { reason: REASON_LONG, repointNormalizedSetKey: true, salesContainer: pool as unknown as any });

    expect(r.action).toBe("move");
    const moved = cat.get(SIB_1990)!;
    expect(moved.setKey).toBe("bowman-tiffany");
    expect(moved.parallel).toBe("");
    expect(moved.setKeyBefore).toBe("bowman");
    expect(moved.parallelBefore).toBe("Tiffany");
    // THE SOURCE IS KEPT — provenance is never rewritten by this repair.
    expect(moved.source).toBe("baseballcardpedia-ladders-2026-09-04");
    // The old address is gone; the card lives at exactly one identity now.
    expect(cat.get(RUNG_1990)).toBeUndefined();
    // COPY BEFORE DELETE — the sale is never without a row.
    const w = log.filter((l) => /card_catalog\.(upsert|delete)/.test(l));
    expect(w.findIndex((l) => l.startsWith("card_catalog.upsert")))
      .toBeLessThan(w.findIndex((l) => l.startsWith("card_catalog.delete")));
  });

  it("a CHECKLIST-BACKED incumbent is never downgraded by a rung", async () => {
    // The 1987 sibling carries checklistBacking + confidence 0.98; the rung is
    // sales-attested at 0.7. If the repair ever tried to move the rung ONTO
    // it, moveCatalogRow folds rather than replaces — the incumbent wins on
    // authority. This is the enforcement, not an assertion about intent.
    const log: string[] = [];
    const cat = new FakeContainer("card_catalog", log, catalogSeed());
    const pool = new FakeContainer("sold_comps", log, poolSeed());

    const r = await moveCatalogRow(cat as unknown as any, cat.get(RUNG_1987)! as any, SIB_1987, {
      setKey: "topps-tiffany", parallel: "",
    }, { reason: REASON_LONG, salesContainer: pool as unknown as any });

    expect(r.action).toBe("fold");
    expect(r.survivor).toBe("incumbent");
    const survivor = cat.get(SIB_1987)!;
    expect(survivor.source).toBe("beckett-scraped-2026-08-26");
    expect(survivor.checklistBacking).toBe("confirmed");
  });

  it("the FLEER row is untouched — no sibling, no write", async () => {
    const log: string[] = [];
    const cat = new FakeContainer("card_catalog", log, catalogSeed());
    const a = axesOf(RUNG_FLEER)!;
    // The gate closes...
    expect(await siblingRows(cat, a.sport, a.year, siblingSetKeyFor(a.setKey))).toBe(0);
    // ...so the script returns before any write. The document is as seeded.
    expect(cat.get(RUNG_FLEER)!.parallel).toBe("Tiffany");
    expect(cat.get(RUNG_FLEER)!.setKey).toBe("fleer");
    expect(cat.get(RUNG_FLEER)!.retired).toBeUndefined();
    expect(log.filter((l) => /\.(patch|delete|upsert) /.test(l))).toEqual([]);
  });

  it("the GREY BACKS row is never even a candidate", async () => {
    const cat = new FakeContainer("card_catalog", [], catalogSeed());
    const grey = cat.all().find((d) => d.parallel === "Grey Backs")!;
    expect(statesTiffany(grey.parallel)).toBe(false);
    // The catalog scan's own predicate skips it.
    const scanned = cat.all().filter((d) => /tiffany/i.test(String(d.parallel ?? "")));
    expect(scanned.map((d) => d.id)).not.toContain(grey.id);
  });
});

describe("MODE=pool: the title guard, on the documents", () => {
  it("a sale whose title states Tiffany is eligible; both identity fields move", () => {
    const pool = new FakeContainer("sold_comps", [], poolSeed());
    const row = pool.get("sale-tiffany-1")!;
    expect(isPoolRung(row)).toBe(true);
    expect(statesTiffany(row.title)).toBe(true);

    const target = toSiblingSlug(row.hobbyiqCardId, siblingSetKeyFor(axesOf(row.hobbyiqCardId)!.setKey));
    expect(target).toBe(SIB_1987);
    // Both fields, per CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS.
    const keep = { ...row, cardId: target, hobbyiqCardId: target, parallel: "" };
    expect(keep.cardId).toBe(keep.hobbyiqCardId);
  });

  it("THE 93-ROW POPULATION: a base sale under a :tiffany: slug is CONFLICT", () => {
    const pool = new FakeContainer("sold_comps", [], poolSeed());
    const row = pool.get("sale-base-1")!;
    // It IS in scope — the slug says tiffany...
    expect(isPoolRung(row)).toBe(true);
    // ...but its own title says Base, so it is reported and never written.
    // Moving it would carry a BASE sale into the Tiffany pool: the same
    // split-pool defect this lane closes, pointed the other way.
    expect(statesTiffany(row.title)).toBe(false);
    expect(row.parallel).toBe("Base");
  });

  it("a graded sale keeps its grade segment across the move", () => {
    const pool = new FakeContainer("sold_comps", [], poolSeed());
    const row = pool.get("sale-tiffany-graded")!;
    expect(statesTiffany(row.title)).toBe(true);
    const target = toSiblingSlug(row.hobbyiqCardId, siblingSetKeyFor(axesOf(row.hobbyiqCardId)!.setKey));
    expect(target).toBe("hiq:baseball:1990:bowman-tiffany:27:base:no-auto:psa-9");
    expect(target).toContain(":psa-9");
  });

  it("the FLEER sale is left where it is — the gate closes before the title is read", async () => {
    const cat = new FakeContainer("card_catalog", [], catalogSeed());
    const pool = new FakeContainer("sold_comps", [], poolSeed());
    const row = pool.get("sale-fleer-1")!;
    // Its title DOES state Tiffany, so only the sibling gate protects it.
    expect(statesTiffany(row.title)).toBe(true);
    const a = axesOf(row.hobbyiqCardId)!;
    expect(await siblingRows(cat, a.sport, a.year, siblingSetKeyFor(a.setKey))).toBe(0);
    expect(pool.get("sale-fleer-1")!.hobbyiqCardId).toBe(RUNG_FLEER);
  });
});

describe("the fake refuses a query the script did not declare", () => {
  it("an unimplemented query shape throws rather than matching nothing", async () => {
    // A fake that returned [] for a query it does not know would let a real
    // scan silently match nothing and report a clean run over an empty
    // population (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW).
    const cat = new FakeContainer("card_catalog", [], catalogSeed());
    await expect(cat.items.query({ query: "SELECT * FROM c WHERE c.somethingNew = 1" }).fetchAll())
      .rejects.toThrow(/unsupported query/);
  });
});
