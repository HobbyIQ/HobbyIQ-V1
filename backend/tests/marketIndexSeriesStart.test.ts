// CF-MARKET-INDEXES series-start pins (2026-09-03).
//
// THE DEFECT THIS PINS
// --------------------
// Backfill Runner 33805915987 (rebuild-market-indexes, apply=true) purged
// the nine strays, recreated every basket, recomputed all five series -
// and then failed its own verify with publishedPointsBelowFloorCount:207.
//
// The 207 were NOT points the walk published below the floor. Read back
// out of Cosmos, every one of them has NO usedWeight field at all and a
// computedAt of 2026-09-02: they are pre-C-1 documents the rebuild never
// overwrote. Two ways an id escapes a recompute that claims to own it:
//
//   1. WITHHELD WITH NO PRIOR LEVEL. `if (priorLevel == null) continue;`
//      skipped the upsert entirely. Every day from the series start up
//      to a sport's first publishable day therefore kept whatever doc
//      already sat at that id - hockey 2026-04-02..07-22 (112 docs,
//      level 553.89 off ONE fresh member) and pokemon 2026-04-01..06-30
//      (91 docs, level 15.72). The run reported pointsWithheld and
//      believed it had withheld them; the tile kept rendering them.
//   2. THE SPAN'S OWN TAIL. The walk covers [asOf-179 .. asOf], which
//      slides forward a day at a time. The 2026-09-02 run wrote
//      point::<sport>::2026-03-07; the 2026-09-03 run starts at
//      2026-03-08 and can never reach it. Four such docs (baseball,
//      basketball, football, pokemon).
//
// 112 + 91 + 4 = 207. Both are the same failure stated twice: a
// recompute that does not OWN every id inside - and at the edge of - its
// span leaves the old method's output standing as if it were live.
//
// THE FIX, in three parts
// -----------------------
//   A. Seed the walk's carry-forward from a LEAD_IN_DAYS window before
//      day one, for every card in the lead-in rather than only the first
//      epoch's members, so early days have real used weight and publish
//      real history instead of collapsing below the floor.
//   B. A day still below the floor with no prior level to carry is
//      WRITTEN, levelless, with reason "series_start" - so the id is
//      owned. The read side drops levelless points and the tile shows
//      nothing for those days.
//   C. The rebuild deletes points dated before its own span.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

type Row = { cardId: string; price: number; soldAt: string };

/** Docs the fake series container holds, keyed by id. */
const seriesDocs = new Map<string, Record<string, unknown>>();
/** Sales the fake sold_comps container serves. */
let poolRows: Row[] = [];

/**
 * Minimal Cosmos doubles. The query surface is narrow enough to answer
 * by inspecting the SQL text: the walk asks for sales, for the stored
 * carry doc, and for the last published level.
 */
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
          // lastPublishedLevel
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
const { MIN_USED_WEIGHT, MIN_BASKET_SIZE, LEAD_IN_DAYS, addDays } = await import(
  "../src/services/insights/marketIndex.service.js"
);

/** A basket-sized roster of liquid cards, one sale per card per day. */
const CARDS = Array.from({ length: MIN_BASKET_SIZE + 15 }, (_, i) => `card-${i}`);

/** Enough sales per card in a window to clear MIN_SALES_FOR_ELIGIBILITY. */
function salesEveryDay(from: string, to: string, price = 100): Row[] {
  const out: Row[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    for (const cardId of CARDS) out.push({ cardId, price, soldAt: `${d}T12:00:00Z` });
  }
  return out;
}

beforeEach(() => {
  seriesDocs.clear();
  poolRows = [];
});

describe("PIN: a walk whose members only trade after day 3", () => {
  // Span is short and inside ONE epoch, so the basket is selected from
  // that epoch's own eligibility window and membership never rolls.
  const from = "2026-08-10";
  const to = "2026-08-16";

  it("withholds days 1-2 as series-start, then publishes at or above the floor", async () => {
    // Eligibility (the 90d ending at the epoch base date, 2026-07-01) is
    // fed so a basket forms at all - but ENTIRELY before the lead-in
    // window opens on 2026-05-12, so the seed finds nothing to carry.
    poolRows = salesEveryDay("2026-04-02", "2026-05-12");
    // ...and then NOTHING until day 3 of the span.
    poolRows.push(...salesEveryDay("2026-08-12", "2026-08-17", 150));

    // The fixture's own premise, asserted rather than assumed: the last
    // pre-span sale is older than the lead-in this walk reads.
    expect(addDays(from, -LEAD_IN_DAYS)).toBe("2026-05-12");

    const r = await computeSeriesForSport("baseball", from, to);
    expect(r).not.toBeNull();

    const points = [...seriesDocs.values()]
      .filter((d) => d.docType === "market_index_point")
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // EVERY day in the span has a document. This is the property the
    // 2026-09-03 run violated: it wrote nothing for these days.
    expect(points.map((p) => p.date)).toEqual([
      "2026-08-10", "2026-08-11", "2026-08-12",
      "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16",
    ]);

    // Days 1-2 are withheld at the series start: levelless, so the tile
    // shows nothing rather than a fabricated number.
    for (const d of ["2026-08-10", "2026-08-11"]) {
      const p = seriesDocs.get(`point::baseball::${d}`)!;
      expect(p.stale).toBe(true);
      expect(p.withheldReason).toBe("series_start");
      expect(p.level).toBeUndefined();
    }

    // Day 3 onward publishes, and every published point clears the floor.
    for (const d of ["2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]) {
      const p = seriesDocs.get(`point::baseball::${d}`)!;
      expect(p.stale).toBeUndefined();
      expect(p.usedWeight as number).toBeGreaterThanOrEqual(MIN_USED_WEIGHT);
      expect(p.level as number).toBeGreaterThan(0);
    }
  });
});

describe("PIN: a walk WITH a lead-in publishes day one", () => {
  const from = "2026-08-10";
  const to = "2026-08-14";

  it("seeds carry-forward from the lead-in, so day one clears the floor", async () => {
    // Eligibility, then a lead-in that ends the day BEFORE the span, then
    // nothing during the span at all. Day one has no sales of its own -
    // it publishes purely on the seeded carry.
    poolRows = salesEveryDay("2026-05-01", "2026-07-01");
    poolRows.push(...salesEveryDay("2026-08-01", "2026-08-10", 120));

    const r = await computeSeriesForSport("baseball", from, to);
    expect(r).not.toBeNull();

    const dayOne = seriesDocs.get("point::baseball::2026-08-10")!;
    expect(dayOne.stale).toBeUndefined();
    expect(dayOne.withheldReason).toBeUndefined();
    expect(dayOne.usedWeight as number).toBeGreaterThanOrEqual(MIN_USED_WEIGHT);
    expect(dayOne.level as number).toBeGreaterThan(0);
    // The whole span publishes off the carry, never dropping below floor.
    expect(r!.pointsWithheld).toBe(0);
    expect(r!.pointsWritten).toBe(5);
  });

  it("a lead-in OLDER than 14 days still seeds it - the 14d window was the bug", async () => {
    // The seed used to read only VALUE_WINDOW_DAYS (14) back. A sport
    // whose last trades were 60 days before the span found nothing and
    // collapsed. LEAD_IN_DAYS is the eligibility window, so a member
    // liquid enough to be picked is liquid enough to be seeded.
    poolRows = salesEveryDay("2026-04-02", "2026-05-12");
    poolRows.push(...salesEveryDay("2026-06-20", "2026-06-30", 120));

    const leadInStart = addDays(from, -LEAD_IN_DAYS);
    expect(leadInStart < "2026-06-20").toBe(true);   // inside the window
    expect(addDays(from, -14) > "2026-06-30").toBe(true); // outside the OLD one

    const r = await computeSeriesForSport("baseball", from, to);
    expect(r).not.toBeNull();
    const dayOne = seriesDocs.get("point::baseball::2026-08-10")!;
    expect(dayOne.stale).toBeUndefined();
    expect(dayOne.usedWeight as number).toBeGreaterThanOrEqual(MIN_USED_WEIGHT);
  });
});

describe("PIN: a recompute OWNS every id in its span", () => {
  it("overwrites a pre-C-1 doc sitting on a day it withholds", async () => {
    // The exact prod shape: a doc with no usedWeight, not stale, carrying
    // a fabricated level, on a day the new walk withholds.
    seriesDocs.set("point::hockey::2026-08-10", {
      id: "point::hockey::2026-08-10",
      cardId: "index::hockey",
      docType: "market_index_point",
      sport: "hockey",
      date: "2026-08-10",
      level: 553.89,
      epoch: "2026-Q3",
      freshMembers: 1,
      basketSize: 43,
      computedAt: "2026-09-02T18:41:15.990Z",
    });

    // Eligibility only, all of it older than the lead-in window, so the
    // walk has a basket but no seeded carry and 2026-08-10 is withheld.
    poolRows = salesEveryDay("2026-04-02", "2026-05-12");
    poolRows.push(...salesEveryDay("2026-08-12", "2026-08-15", 150));

    await computeSeriesForSport("hockey", "2026-08-10", "2026-08-14");

    const p = seriesDocs.get("point::hockey::2026-08-10")!;
    // The fabrication is gone: same id, rewritten by this run.
    expect(p.level).toBeUndefined();
    expect(p.stale).toBe(true);
    expect(p.withheldReason).toBe("series_start");
    expect(p.usedWeight).toBeDefined();
  });

  it("the withheld branch never returns without writing", () => {
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    // The mutation: restoring the skip. `continue` before the upsert is
    // exactly how 203 pre-C-1 docs survived the rebuild.
    expect(compute).not.toContain("if (priorLevel == null) continue;");
    expect(compute).toContain('withheldReason: "series_start"');
  });
});

describe("PIN: the read side shows nothing for a series-start day", () => {
  it("drops levelless points rather than plotting them as zero", () => {
    const readSvc = read("backend/src/services/insights/marketIndexRead.service.ts");
    expect(readSvc).toContain("Number.isFinite(r.level)");
    // A zero-level point would print a -100% changePct on the first
    // point of the window, which is worse than showing nothing.
    expect(readSvc).toContain("const rows = all.filter(");
  });
});

describe("PIN: verify reds on any published point below the floor", () => {
  const script = read("backend/scripts/rebuild-market-indexes.cjs");

  it("the verify query catches a missing usedWeight as well as a low one", () => {
    // An unmeasured point is not a passing point: this is the clause that
    // caught all 207 prod docs, and it must stay.
    expect(script).toContain("NOT IS_DEFINED(c.usedWeight) OR c.usedWeight < @floor");
    expect(script).toContain("NOT IS_DEFINED(c.stale) OR c.stale = false");
    expect(script).toContain("publishedPointsBelowFloor");
  });

  it("a failed verify fails an apply run", () => {
    expect(script).toContain("if (apply && !verify.ok)");
    expect(script).toContain("market_index_rebuild_verify_failed");
  });

  it("MUTATION: publishing one below-floor point makes the predicate red", () => {
    // The verify rule, applied to documents rather than to source text.
    const floor = MIN_USED_WEIGHT;
    const flags = (d: { usedWeight?: number; stale?: boolean }) =>
      (d.usedWeight === undefined || d.usedWeight < floor) && d.stale !== true;

    // A clean series: everything published clears the floor, everything
    // below it is stale.
    const clean = [
      { usedWeight: 0.84 },
      { usedWeight: 0.51 },
      { usedWeight: 0.22, stale: true },
      { usedWeight: 0.0, stale: true },            // series_start, levelless
    ];
    expect(clean.filter(flags)).toHaveLength(0);

    // Mutate ONE: publish the below-floor point. Verify must go red.
    const mutated = [...clean];
    mutated[2] = { usedWeight: 0.22 };
    expect(mutated.filter(flags)).toHaveLength(1);

    // And the prod shape - no usedWeight at all, not stale - is red too.
    expect([{ stale: false } as { usedWeight?: number; stale?: boolean }].filter(flags))
      .toHaveLength(1);
  });

  it("the rebuild purges points dated before its own span", () => {
    // The four 2026-03-07 docs the walk can never reach.
    expect(script).toContain("market_index_pre_span_points");
    expect(script).toContain("async function readPointsBefore(");
    expect(script).toContain("c.date < @boundary");
    expect(script).toContain("market_index_pre_span_purge_did_not_reconcile");
  });
});
