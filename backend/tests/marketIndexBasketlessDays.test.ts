// CF-MARKET-INDEXES basketless-day pins (2026-09-04).
//
// THE DEFECT THIS PINS
// --------------------
// Backfill Runner 33819336946 (rebuild-market-indexes, apply=true, on
// #1687) walked all five sports, printed market_index_rebuild_done - and
// failed its own verifyByRead with publishedPointsBelowFloorCount:181.
//
// The 181 are NOT points this run published below the floor. Read back
// out of prod, every one has NO usedWeight, stale unset, a fabricated
// level, and computedAt 2026-09-02: they are pre-C-1 documents that the
// rebuild never overwrote.
//
//   hockey  2026-04-02..2026-06-30   90 docs, level 553.89
//   pokemon 2026-04-01..2026-06-30   91 docs, level 14.46..17.80
//                                   181 total
//
// Both stretches are one epoch: 2026-Q2. Neither pool is thick enough
// for a 2026-Q2 basket (MIN_BASKET_SIZE 25), so ensureBasket returns
// null for those days - and the walk did this:
//
//     if (!basket) { pointsWithheld++; continue; }
//
// The counter moved; the document did not. Every one of those ids kept
// whatever the 2026-09-02 run had left there, still rendering as live.
//
// The reported numbers say the same thing, and they reconcile exactly:
//   hockey  pointsWithheld 115 = 25 days with no doc written at all
//           (2026-03-08..04-01, Q1, also basketless) + 90 left standing.
//   pokemon pointsWithheld 180 = 91 left standing + 89 genuinely written
//           levelless. latestUsedWeight null because the newest day
//           published nothing.
//
// This is the SAME defect #1686 fixed for the below-floor branch, in the
// one path that fix did not reach. The VERIFY is right: an unmeasured,
// non-stale point IS a published point below the floor. The WRITE is
// wrong.
//
// THE FIX
// -------
// The basketless branch writes its point - levelless, stale, reason
// "no_basket" - exactly as the series_start branch does. A recompute
// OWNS every id in its span. The read side already drops levelless
// points, so the tile shows nothing for those days.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

type Row = { cardId: string; price: number; soldAt: string };

const seriesDocs = new Map<string, Record<string, unknown>>();
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
const { MIN_USED_WEIGHT, MIN_BASKET_SIZE, addDays } = await import(
  "../src/services/insights/marketIndex.service.js"
);

const CARDS = Array.from({ length: MIN_BASKET_SIZE + 15 }, (_, i) => `card-${i}`);

function salesEveryDay(from: string, to: string, price = 100): Row[] {
  const out: Row[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    for (const cardId of CARDS) out.push({ cardId, price, soldAt: `${d}T12:00:00Z` });
  }
  return out;
}

/** The exact prod shape of a survivor: no usedWeight, not stale, level. */
function preC1Doc(sport: string, date: string, level: number) {
  return {
    id: `point::${sport}::${date}`,
    cardId: `index::${sport}`,
    docType: "market_index_point",
    sport,
    date,
    level,
    epoch: "2026-Q3",
    freshMembers: 1,
    basketSize: 43,
    computedAt: "2026-09-02T18:41:15.990Z",
  };
}

/**
 * The verify predicate, transcribed from the rebuild SQL. A point is
 * flagged when it is non-stale AND (has no usedWeight OR is below floor).
 */
function verifyFlags(d: { usedWeight?: unknown; stale?: unknown }): boolean {
  const uw = d.usedWeight;
  return (uw === undefined || (uw as number) < MIN_USED_WEIGHT) && d.stale !== true;
}

beforeEach(() => {
  seriesDocs.clear();
  poolRows = [];
});

describe("PIN: run 33819336946 post-state, reproduced and healed", () => {
  // A span that crosses an epoch boundary into a quarter whose pool
  // cannot form a basket - the shape of hockey/pokemon 2026-Q2 in prod.
  //
  // Q2 is eligible (basket forms from the 90d ending 2026-04-01) and Q3
  // is NOT: no sales in the 90 days ending 2026-07-01 means no 2026-Q3
  // basket, so every Q3 day in the span is basketless.
  const from = "2026-06-25";
  const to = "2026-07-08";

  /** Seed prod survivors onto the Q3 days this walk will withhold. */
  function seedSurvivors() {
    for (let d = "2026-07-01"; d <= to; d = addDays(d, 1)) {
      seriesDocs.set(`point::hockey::${d}`, preC1Doc("hockey", d, 553.89));
    }
  }

  function fixture() {
    // Eligibility for 2026-Q2 (the 90d ending at its base date), and the
    // span Q2 days publish off it. Nothing at all after 2026-04-01, so
    // the 2026-Q3 eligibility window is empty and its basket never forms.
    poolRows = salesEveryDay("2026-01-01", "2026-04-01");
    poolRows.push(...salesEveryDay(from, "2026-07-01", 120));
  }

  it("the fixture really does produce basketless days", async () => {
    fixture();
    seedSurvivors();
    const r = await computeSeriesForSport("hockey", from, to);
    expect(r).not.toBeNull();
    expect(r!.pointsWithheld).toBeGreaterThan(0);
  });

  it("every basketless day is WRITTEN, levelless, reason no_basket", async () => {
    fixture();
    seedSurvivors();

    await computeSeriesForSport("hockey", from, to);

    // Every day in the span has a document - the property run
    // 33819336946 violated.
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    for (const d of days) {
      expect(seriesDocs.has(`point::hockey::${d}`), `missing ${d}`).toBe(true);
    }

    // The Q3 stretch: the fabrication is gone, same ids, rewritten.
    for (let d = "2026-07-01"; d <= to; d = addDays(d, 1)) {
      const p = seriesDocs.get(`point::hockey::${d}`)!;
      expect(p.level, `level survived on ${d}`).toBeUndefined();
      expect(p.stale).toBe(true);
      expect(p.withheldReason).toBe("no_basket");
      expect(p.usedWeight).toBeDefined();
      // Not the 2026-09-02 fabrication any more.
      expect(p.computedAt).not.toBe("2026-09-02T18:41:15.990Z");
    }
  });

  it("the verifyByRead predicate now flags NOTHING in the walked span", async () => {
    fixture();
    seedSurvivors();

    await computeSeriesForSport("hockey", from, to);

    const points = [...seriesDocs.values()].filter((d) => d.docType === "market_index_point");
    expect(points.length).toBeGreaterThan(0);
    const flagged = points.filter(verifyFlags);
    // This is verifyOk: true. Before the fix the survivors were flagged.
    expect(flagged.map((p) => p.id)).toEqual([]);
  });

  it("withheld count equals the docs actually written stale - no phantom credit", async () => {
    fixture();
    seedSurvivors();

    const r = await computeSeriesForSport("hockey", from, to);
    const staleDocs = [...seriesDocs.values()]
      .filter((d) => d.docType === "market_index_point" && d.stale === true);

    // The bug signature was a counter that outran the writes: hockey
    // claimed 115 withheld having written 0 of them. The counter must
    // now be backed one-for-one by a document.
    expect(r!.pointsWithheld).toBe(staleDocs.length);
  });
});

describe("PIN: a genuine below-floor publish still fails verify", () => {
  it("MUTATION: an unmeasured non-stale point is red; a stale one is not", () => {
    // The verify rule applied to documents. If this ever goes green the
    // 181 would have sailed through.
    expect(verifyFlags({ usedWeight: 0.84 })).toBe(false);
    expect(verifyFlags({ usedWeight: 0.51 })).toBe(false);
    // Withheld below the floor: fine, it is not published.
    expect(verifyFlags({ usedWeight: 0.22, stale: true })).toBe(false);
    expect(verifyFlags({ usedWeight: 0, stale: true })).toBe(false);
    // PUBLISHED below the floor: red.
    expect(verifyFlags({ usedWeight: 0.22 })).toBe(true);
    // The exact prod survivor shape - no usedWeight, not stale: red.
    expect(verifyFlags(preC1Doc("hockey", "2026-04-02", 553.89))).toBe(true);
  });

  it("a survivor left un-overwritten is still caught", async () => {
    // Same fixture, but the survivor sits on a day OUTSIDE the walk. The
    // recompute cannot own it, so verify must still go red - which is
    // what the rebuild pre-span purge exists to clean up.
    poolRows = salesEveryDay("2026-01-01", "2026-04-01");
    poolRows.push(...salesEveryDay("2026-06-25", "2026-07-01", 120));
    seriesDocs.set("point::hockey::2026-01-15", preC1Doc("hockey", "2026-01-15", 553.89));

    await computeSeriesForSport("hockey", "2026-06-25", "2026-07-08");

    const flagged = [...seriesDocs.values()]
      .filter((d) => d.docType === "market_index_point")
      .filter(verifyFlags);
    expect(flagged.map((p) => p.id)).toEqual(["point::hockey::2026-01-15"]);
  });
});

describe("PIN: the basketless branch never returns without writing", () => {
  const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");

  it("MUTATION: restoring the bare skip is the defect", () => {
    // The literal line from run 33819336946. Its return is exactly how
    // 181 pre-C-1 docs survived a rebuild that claimed to own them.
    expect(compute).not.toMatch(/if \(!basket\) \{\s*pointsWithheld\+\+;\s*continue;\s*\}/);
  });

  it("the branch upserts a levelless no_basket point", () => {
    expect(compute).toContain('withheldReason: "no_basket"');
    // Both withhold branches write. Neither may go back to skipping.
    expect(compute).not.toContain("if (priorLevel == null) continue;");
    expect(compute).toContain('withheldReason: "series_start"');
  });

  it("no_basket is a declared WithheldReason, not a loose string", () => {
    const svc = read("backend/src/services/insights/marketIndex.service.ts");
    expect(svc).toContain('| "no_basket"');
  });
});
