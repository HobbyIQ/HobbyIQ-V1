// CF-A-DISENTANGLEMENT-DOES-NOT-CARRY-THE-OTHER-CARD'S-SALES (#1925 repair).
//
// `moveCatalogRow` re-points a row's own sales to the new slug whenever the
// caller hands it `salesContainer`, and the relocate-catalog-rows-by-list lane
// always did. That default is right for a MOVE -- a renumber, a parallel
// spelling, a key rename -- because the card's own sales belong at its new
// address.
//
// It is wrong for a DISENTANGLEMENT, and #1925 measured why. 141,304
// hobbymonitor rows are the year-N product carrying `year` = N+1, so they sit
// inside the year-N+1 product's numbering, and the 7,905 sales resting on
// their slugs have titles that are 7,901-to-0 year N+1. Those sales belong to
// the card that STAYS, not the one that moves. Carrying them to year N would
// take 7,905 genuine 2025 sales off the identity that actually sold -- the very
// mispricing the repair exists to end, inflicted a second time by the repair.
//
// So the list may say `keepSales: true` (or `repointSales: false`), per file or
// per entry, and this file pins what that means BEHAVIOURALLY rather than as a
// source string:
//
//   - the resolution rules, including that ABSENT IS FALSE so the eight lists
//     already committed keep the behaviour they were reviewed with;
//   - an APPLY over an in-memory prod double, with a real sale on the row:
//     the row moves, and the sale's `hobbyiqCardId` and `cardId` are byte-for-
//     byte what they were;
//   - the same fixture WITHOUT the flag, proving the default still carries the
//     sale -- otherwise this test would pass against a lane that had simply
//     lost the ability to re-point at all;
//   - a MUTATION: hand the flagged path a salesContainer anyway and the sale
//     moves -> red.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Container } from "@azure/cosmos";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service.js";

const require_ = createRequire(__filename);
const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");

const L = require_(lane) as {
  keepsSales: (entry: unknown, doc: unknown) => boolean;
};

// ── the resolution rules ─────────────────────────────────────────────────────

describe("keepSales / repointSales resolution", () => {
  it("ABSENT IS FALSE — every list committed before this flag keeps its behaviour", () => {
    // The load-bearing default. A new option that quietly changed the meaning
    // of the lists already on disk would be a worse defect than the one it
    // fixes, so silence at both levels means "sales follow the row", exactly
    // as before.
    expect(L.keepsSales({}, {})).toBe(false);
    expect(L.keepsSales(null, null)).toBe(false);
    expect(L.keepsSales({ id: "hiq:a:1:b:1:base:no-auto", action: "reslug" }, { entries: [] })).toBe(false);
  });

  it("reads BOTH spellings, at BOTH levels", () => {
    expect(L.keepsSales({ keepSales: true }, {})).toBe(true);
    expect(L.keepsSales({ repointSales: false }, {})).toBe(true);
    expect(L.keepsSales({}, { keepSales: true })).toBe(true);
    expect(L.keepsSales({}, { repointSales: false })).toBe(true);
  });

  it("the ENTRY's own statement wins over the FILE's, in both directions", () => {
    // A list sets the shape once at the top and dissents on the rows that
    // differ; the dissent must actually win or the per-entry half is a lie.
    expect(L.keepsSales({ keepSales: false }, { keepSales: true })).toBe(false);
    expect(L.keepsSales({ keepSales: true }, { keepSales: false })).toBe(true);
    expect(L.keepsSales({ repointSales: true }, { keepSales: true })).toBe(false);
    expect(L.keepsSales({ repointSales: false }, { repointSales: true })).toBe(true);
  });

  it("only a BOOLEAN speaks — a string is not a statement", () => {
    // "true" from a hand-edited JSON file must not silently arm a flag that
    // changes where 7,905 sales live.
    expect(L.keepsSales({ keepSales: "true" }, {})).toBe(false);
    expect(L.keepsSales({ keepSales: 1 }, {})).toBe(false);
    expect(L.keepsSales({ repointSales: "false" }, {})).toBe(false);
  });
});

// ── the lane wires it to the one thing that does the re-pointing ─────────────

describe("the flag reaches moveCatalogRow the documented way", () => {
  const src = readFileSync(lane, "utf8");

  it("omits salesContainer under the flag, rather than suppressing a patch", () => {
    // moveCatalogRow's own contract: "Omit only when the caller KNOWS no sale
    // points at the old slug; the decision string says so when it was
    // omitted." Not handing it the container is the SUPPORTED way to say the
    // caller owns the sales -- editing the patch ops would be a fork of the
    // one shared mover.
    expect(src).toContain("...(keepSales ? {} : { salesContainer: pool })");
    expect(src).toContain("const keepSales = keepsSales(e, doc);");
  });

  it("counts what it left behind, in BOTH modes, like the retire does", () => {
    expect(src).toContain("salesLeftBehind");
    expect(src).toContain("sales LEFT BEHIND");
    // Printed on the entry BEFORE the apply gate, so a report sizes the
    // hand-off exactly as `sales pointing here` does for a retire.
    expect(src).toContain("sales staying at this slug:");
  });

  it("and STATES what retire does to sales, which is not nothing", () => {
    // The lane's banner is where a reviewer learns that a retire leaves its
    // sales pointing at an address that no longer resolves.
    expect(src).toContain("sales made UNPLACED");
    expect(src).toContain("the rematch owns");
  });
});

// ── the apply, over an in-memory double, with a real sale on the row ─────────

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}
const keyOf = (id: string, pk?: string | null) =>
  pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`;

/** Just enough of @azure/cosmos Container for what moveCatalogRow issues. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  get(id: string): Doc | undefined {
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
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) d[o.path.slice(1)] = o.value;
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
}

// The real shape, from #1925 section 4: card number 88 of football/topps-chrome
// holds a mislabelled 2024 row (Dallas Clark) at a 2025 address, and the sale
// resting on that slug is a 2025 Bo Nix sale.
const MISLABELLED = "hiq:football:2025:topps-chrome:88:x-fractor:no-auto";
const TRUE_YEAR = "hiq:football:2024:topps-chrome:88:x-fractor:no-auto";

const mislabelledRow = (): Doc => ({
  id: MISLABELLED, cardId: MISLABELLED,
  sport: "football", year: 2025, cardYear: 2025,
  setKey: "topps-chrome", setName: "2024 Topps Chrome Football",
  cardNumber: "88", parallel: "X-Fractor", parallelSlug: "x-fractor", isAuto: false, printRun: null,
  playerName: "Dallas Clark", playerSlug: "dallas-clark",
  vendorIds: {}, source: "hobbymonitor-2026-09-04", confidence: 0.8,
});

/** A 2025 Bo Nix sale, resting on the mislabelled row's slug. */
const nixSale = (): Doc => ({
  id: "sale-bo-nix-88",
  cardId: MISLABELLED,
  hobbyiqCardId: MISLABELLED,
  title: "Topps Chrome 2025 Bo Nix Denver Broncos X-Fractor Parallel #88 NFL Card",
  price: 42,
});

function world() {
  const log: string[] = [];
  const cat = new FakeContainer("cat", log, [mislabelledRow()]);
  const pool = new FakeContainer("pool", log, [nixSale()]);
  return { log, cat: cat as unknown as Container, pool: pool as unknown as Container, catF: cat, poolF: pool };
}

const REASON = "#1925 H1: the setName's year is the product year; the row is the 2024 card";

describe("APPLY with a sale on the row", () => {
  it("UNDER THE FLAG: the row moves and the sale does NOT", async () => {
    const w = world();
    const before = structuredClone(w.poolF.get("sale-bo-nix-88"));

    // Exactly what the lane does for a keepSales entry: no salesContainer.
    const res = await moveCatalogRow(w.cat, mislabelledRow(), TRUE_YEAR, {}, {
      reason: REASON, dryRun: false, known: null,
    });

    // The card really did move -- otherwise "the sale did not move" is vacuous.
    expect(w.catF.get(TRUE_YEAR)).toBeTruthy();
    expect(w.catF.get(MISLABELLED)).toBeUndefined();
    expect(String(w.catF.get(TRUE_YEAR)?.playerName)).toBe("Dallas Clark");

    // THE ASSERTION. The sale is untouched: same address, same partition key,
    // and none of the re-point stamps landed on it.
    const after = w.poolF.get("sale-bo-nix-88");
    expect(after?.hobbyiqCardId).toBe(MISLABELLED);
    expect(after?.cardId).toBe(MISLABELLED);
    expect(after?.reslugedFrom).toBeUndefined();
    expect(after?.reslugedReason).toBeUndefined();
    expect(after?.reslugedAt).toBeUndefined();
    expect(after).toEqual(before);

    // And not one write touched the pool at all.
    expect(w.log.filter((l) => l.startsWith("pool."))).toHaveLength(0);
    expect(res.salesRepointed).toBe(0);
    expect(res.decision).toMatch(/sales not re-pointed \(no salesContainer\)/);
  });

  it("MUTATION — hand the flagged path a salesContainer anyway and the sale MOVES", async () => {
    // This is the mutant the flag exists to prevent: it is the lane's own
    // pre-#1925 call, and it carries a genuine 2025 sale back to 2024. If the
    // shipped path ever regains a salesContainer under keepSales, the test
    // above goes red and this one explains what it would have cost.
    const w = world();
    const res = await moveCatalogRow(w.cat, mislabelledRow(), TRUE_YEAR, {}, {
      reason: REASON, dryRun: false, known: null, salesContainer: w.pool,
    });

    const after = w.poolF.get("sale-bo-nix-88");
    expect(after?.hobbyiqCardId).toBe(TRUE_YEAR);
    expect(after?.reslugedFrom).toBe(MISLABELLED);
    expect(res.salesRepointed).toBe(1);

    // Stated as the harm, not just the diff: a 2025 Bo Nix sale now prices a
    // 2024 Dallas Clark card.
    expect(String(after?.title)).toMatch(/2025 Bo Nix/);
    expect(String(after?.hobbyiqCardId)).toContain(":2024:");
  });

  it("WITHOUT the flag the default still carries the sale — the mover is not broken", async () => {
    // The guard against a false pass: if moveCatalogRow had simply lost the
    // ability to re-point, the keepSales test would pass for the wrong reason.
    const w = world();
    const res = await moveCatalogRow(w.cat, mislabelledRow(), TRUE_YEAR, {}, {
      reason: "an ordinary move: the card's own sales follow it",
      dryRun: false, known: null, salesContainer: w.pool,
    });
    expect(res.salesRepointed).toBe(1);
    expect(w.poolF.get("sale-bo-nix-88")?.hobbyiqCardId).toBe(TRUE_YEAR);
  });

  it("a RETIRE leaves its sale pointing at an address that no longer resolves", async () => {
    // The other half of "state exactly what happens to sales". retireCatalogRow
    // re-points nothing and stamps nothing: the sale keeps its hobbyiqCardId
    // and the row behind it is gone. That is UNPLACED, and the rematch owns it.
    const { retireCatalogRow } = await import("../src/services/catalog/catalogRowOps.service.js");
    const w = world();
    const r = await retireCatalogRow(w.cat, MISLABELLED, MISLABELLED, REASON);
    expect(r.rowDeleted).toBe(true);
    expect(w.catF.get(MISLABELLED)).toBeUndefined();

    const after = w.poolF.get("sale-bo-nix-88");
    expect(after?.hobbyiqCardId).toBe(MISLABELLED);
    expect(after?.flaggedWrong).toBeUndefined();
    expect(w.log.filter((l) => l.startsWith("pool."))).toHaveLength(0);
  });
});
