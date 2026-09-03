// CF-MARKET-INDEXES document-size pins (2026-09-03).
//
// THE DEFECT THIS PINS
// --------------------
// Backfill Runner 33813892106 (rebuild-market-indexes, apply=true, the
// first apply after #1686) purged its strays, reconciled 0/0, deleted the
// four pre-span points, walked all 180 baseball days and upserted every
// one of them - then died on Cosmos:
//
//   Message: {"Errors":["Request size is too large"]}
//
// It died at saveCarryForward. #1686 changed the lead-in seed to fill
// carry-forward from EVERY card in the 90-day lead-in rather than only
// the first epoch's basket members - correct for the walk, because a
// later epoch's members need a day-one value too - and saveCarryForward
// then persisted that entire map into ONE document.
//
// Measured against prod on 2026-09-03, the lead-in window
// [2025-12-08, 2026-03-08) holds:
//
//   baseball    49,511 distinct cards   ~4.2 MB of carry   <-- the offender
//   football     3,427                  ~0.26 MB
//   basketball   1,969                  ~0.15 MB
//   pokemon          7                  ~0.001 MB
//   hockey           4                  ~0.001 MB
//
// against a 2 MB Cosmos document ceiling. Baseball is walked first, so
// the run got exactly as far as baseball's save and no further.
//
// THE RULE
// --------
// The seed may be as large as it likes IN MEMORY. What is PERSISTED is
// bounded to basket members - the union of every epoch the walk resolved,
// plus whatever the stored doc already held (so a nightly single-day run
// never prunes an epoch it did not walk). That is at most a handful of
// epochs x MARKET_INDEX_BASKET_SIZE, tens of KB.
//
// The pin below is the general property, not the specific number: EVERY
// document the walk writes stays under 512 KB on a fixture with 5,000
// lead-in cards. Persist the full seed instead and it goes red.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

type Row = { cardId: string; price: number; soldAt: string };

const seriesDocs = new Map<string, Record<string, unknown>>();
/** Every doc handed to upsert, in order, with its serialized size. */
let upserts: { id: string; docType: string; bytes: number }[] = [];
let poolRows: Row[] = [];

function fakeSoldComps() {
  return {
    items: {
      query: (spec: { query: string; parameters?: { name: string; value: unknown }[] }) => {
        const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const from = String(p["@from"]);
        const to = String(p["@to"]);
        const rows = poolRows.filter((r) => r.soldAt >= from && r.soldAt < to);
        let served = false;
        return {
          hasMoreResults: () => !served,
          fetchNext: () => { served = true; return Promise.resolve({ resources: rows }); },
        };
      },
    },
  };
}

function fakeSeries() {
  return {
    items: {
      query: (spec: { query: string; parameters?: { name: string; value: unknown }[] }) => {
        const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        let rows: Record<string, unknown>[] = [];
        if (spec.query.includes("SELECT TOP 1 c.level")) {
          const before = String(p["@before"]);
          rows = [...seriesDocs.values()]
            .filter((d) => d.docType === "market_index_point" && d.cardId === p["@pk"]
              && String(d.date) < before && d.stale !== true && Number.isFinite(d.level))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .slice(0, 1);
        }
        let served = false;
        return {
          hasMoreResults: () => !served,
          fetchNext: () => { served = true; return Promise.resolve({ resources: rows }); },
        };
      },
      upsert: (d: Record<string, unknown>) => {
        seriesDocs.set(String(d.id), { ...d });
        upserts.push({
          id: String(d.id),
          docType: String(d.docType),
          bytes: Buffer.byteLength(JSON.stringify(d), "utf8"),
        });
        return Promise.resolve({ resource: d });
      },
    },
    item: (id: string) => ({
      read: () => Promise.resolve({ resource: seriesDocs.get(id) }),
      delete: () => {
        if (!seriesDocs.has(id)) {
          const e = new Error("NotFound") as Error & { code: number };
          e.code = 404;
          return Promise.reject(e);
        }
        seriesDocs.delete(id);
        return Promise.resolve({});
      },
    }),
  };
}

vi.mock("../src/services/insights/marketIndex.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/insights/marketIndex.service.js")>();
  return {
    ...actual,
    getSoldCompsContainer: async () => fakeSoldComps(),
    getSeriesContainer: async () => fakeSeries(),
  };
});

const { computeSeriesForSport } = await import(
  "../src/services/insights/marketIndexCompute.service.js"
);
const svc = await import("../src/services/insights/marketIndex.service.js");
const {
  addDays,
  LEAD_IN_DAYS,
  MARKET_INDEX_BASKET_SIZE,
  MIN_SALES_FOR_ELIGIBILITY,
  saveCarryForward,
} = svc;

/**
 * The ceiling this pin enforces. Cosmos refuses at 2 MB; 512 KB is the
 * budget an index document has no business exceeding, and leaves room
 * for the ceiling to be approached by something legitimate before it is
 * hit by something that is not.
 */
const MAX_DOC_BYTES = 512 * 1024;

/** What Cosmos itself refuses, and what run 33813892106 hit. */
const COSMOS_DOC_CEILING_BYTES = 2 * 1024 * 1024;

/** Cards that trade only in the lead-in - the seed's whole population. */
const LEAD_IN_CARDS = 5000;

/**
 * A fixture in the shape of the prod failure: a thin liquid roster that
 * can actually form a basket, swimming in a very large lead-in of cards
 * that trade before day one and never again.
 *
 * cardIds are prod-length (~45 chars) so the byte count is realistic
 * rather than flattered by short test ids.
 */
const PAD = "0000-topps-chrome-refractor-psa10-abcdefghij";
const basketCards = Array.from(
  { length: MARKET_INDEX_BASKET_SIZE },
  (_, i) => `basket-${String(i).padStart(5, "0")}-${PAD}`,
);
const leadInCards = Array.from(
  { length: LEAD_IN_CARDS },
  (_, i) => `leadin-${String(i).padStart(5, "0")}-${PAD}`,
);

const from = "2026-08-10";
const to = "2026-08-16";

function buildFixture(): Row[] {
  const out: Row[] = [];
  // Eligibility for the 2026-Q3 basket is read over the 90 days ending
  // at the epoch base date 2026-07-01. Give the basket roster enough
  // sales there to be picked, and keep them trading through the span so
  // the points publish.
  for (let d = "2026-06-01"; d < "2026-08-17"; d = addDays(d, 1)) {
    for (const cardId of basketCards) {
      out.push({ cardId, price: 100, soldAt: `${d}T12:00:00Z` });
    }
  }
  // The lead-in mob: each trades ONCE, inside the lead-in window and
  // before day one, then never again. Too few sales to be eligible for
  // the basket, but every one of them lands in the seeded carry map.
  const leadInDay = addDays(from, -30); // inside [from-90, from)
  expect(leadInDay >= addDays(from, -LEAD_IN_DAYS)).toBe(true);
  expect(leadInDay < from).toBe(true);
  for (const cardId of leadInCards) {
    out.push({ cardId, price: 50, soldAt: `${leadInDay}T12:00:00Z` });
  }
  return out;
}

beforeEach(() => {
  seriesDocs.clear();
  upserts = [];
  poolRows = buildFixture();
});

describe("PIN: every index document the rebuild writes stays under 512 KB", () => {
  it("holds with 5,000 cards in the lead-in", async () => {
    const r = await computeSeriesForSport("baseball", from, to);
    expect(r).not.toBeNull();

    // The fixture's own premise, asserted rather than assumed: the seed
    // really does see thousands of cards the basket does not contain.
    expect(leadInCards.length).toBe(LEAD_IN_CARDS);
    expect(LEAD_IN_CARDS).toBeGreaterThan(MARKET_INDEX_BASKET_SIZE * 10);
    expect(MIN_SALES_FOR_ELIGIBILITY).toBeGreaterThan(1);

    // Something was actually written, or the pin proves nothing.
    expect(upserts.length).toBeGreaterThan(0);
    const members = upserts.filter((u) => u.docType === "market_index_members");
    expect(members.length).toBe(1);

    const oversized = upserts.filter((u) => u.bytes > MAX_DOC_BYTES);
    expect(oversized).toEqual([]);
  });

  it("the persisted carry holds members, not the lead-in mob", async () => {
    await computeSeriesForSport("baseball", from, to);

    const doc = seriesDocs.get("members::baseball") as
      | { carry: Record<string, { value: number; asOf: string }> }
      | undefined;
    expect(doc).toBeDefined();
    const carried = Object.keys(doc!.carry);

    // Bounded by the baskets the walk resolved.
    expect(carried.length).toBeLessThanOrEqual(MARKET_INDEX_BASKET_SIZE);
    // Not one lead-in card survives the save.
    expect(carried.filter((id) => id.startsWith("leadin-"))).toEqual([]);
    // The members' own history DOES - that is the C-1 property this
    // bound must not break.
    expect(carried.filter((id) => id.startsWith("basket-")).length).toBeGreaterThan(0);
  });

  it("a nightly run does not prune members stored by an earlier epoch", async () => {
    // An older epoch's member, stored and no longer in any live basket.
    const legacy = `basket-99999-${PAD}`;
    seriesDocs.set("members::baseball", {
      id: "members::baseball",
      cardId: "index::baseball",
      docType: "market_index_members",
      sport: "baseball",
      epoch: "2026-Q2",
      carry: { [legacy]: { value: 42, asOf: "2026-05-01" } },
      updatedAt: "2026-05-01T00:00:00.000Z",
    });

    await computeSeriesForSport("baseball", from, to);

    const doc = seriesDocs.get("members::baseball") as
      | { carry: Record<string, { value: number; asOf: string }> };
    // Survives: a stored member's value outlives the epoch that picked it.
    expect(doc.carry[legacy]).toEqual({ value: 42, asOf: "2026-05-01" });
    // And the mob still does not get in.
    expect(Object.keys(doc.carry).filter((id) => id.startsWith("leadin-"))).toEqual([]);
  });

  it("MUTATION: persisting the full seed blows the bound", async () => {
    // saveCarryForward's `keep` set IS the bound. Hand it every key -
    // which is what the code did before this fix, when the parameter did
    // not exist - and the same fixture produces an oversized document.
    const carry = new Map<string, { value: number; asOf: string }>();
    for (const id of [...basketCards, ...leadInCards]) {
      carry.set(id, { value: 123.45, asOf: from });
    }

    const series = fakeSeries();

    // The fix's bound: members only.
    upserts = [];
    await saveCarryForward(series as never, "baseball", "2026-Q3", carry, new Set(basketCards));
    const bounded = upserts.at(-1)!;
    expect(bounded.bytes).toBeLessThanOrEqual(MAX_DOC_BYTES);

    // The mutation: keep everything, as the pre-fix code effectively did.
    upserts = [];
    await saveCarryForward(series as never, "baseball", "2026-Q3", carry, new Set(carry.keys()));
    const unbounded = upserts.at(-1)!;

    // It is DOZENS of times the bounded doc - the bound is what makes
    // the size independent of how many cards traded in the lead-in.
    expect(unbounded.bytes).toBeGreaterThan(bounded.bytes * 20);

    // And extrapolated to prod's own cardinality it is past the Cosmos
    // ceiling outright, which is what killed run 33813892106: baseball's
    // lead-in window [2025-12-08, 2026-03-08) holds 49,511 distinct
    // cards against this fixture's 5,000.
    const PROD_BASEBALL_LEAD_IN_CARDS = 49_511;
    const perEntry = unbounded.bytes / carry.size;
    expect(perEntry * PROD_BASEBALL_LEAD_IN_CARDS).toBeGreaterThan(COSMOS_DOC_CEILING_BYTES);
  });
});

describe("PIN: the report lane models the write lane's seed", () => {
  const script = readFileSync(
    resolve(__dirname, "..", "scripts", "rebuild-market-indexes.cjs"),
    "utf8",
  );

  it("the dry run reads the same LEAD_IN_DAYS window the walk does", () => {
    // It read VALUE_WINDOW_DAYS (14) while the walk read 90, so the
    // report predicted withholds the apply lane would not make.
    expect(script).toContain("svc.addDays(fullFrom, -svc.LEAD_IN_DAYS)");
    expect(script).not.toContain("svc.addDays(fullFrom, -svc.VALUE_WINDOW_DAYS)");
  });

  it("the dry run seeds every lead-in card, not just the first epoch's members", () => {
    expect(script).toContain("svc.groupByCard(allRows.filter((r) => r.soldAt < fullFrom))");
    expect(script).not.toContain("r.soldAt < fullFrom && memberSet.has(r.cardId)");
  });
});
