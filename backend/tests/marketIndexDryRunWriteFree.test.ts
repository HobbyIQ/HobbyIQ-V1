// CF-MARKET-INDEXES: the report lane writes NOTHING, and a withheld day
// carries the last PUBLISHED level (2026-09-03).
//
// Both of these pin defects that reached prod, not properties the code
// happens to have:
//
//   HAZARD-1  backend/scripts/rebuild-market-indexes.cjs announced
//             "REPORT-ONLY (no writes)" and then handed the REAL series
//             container to ensureBasket, which upserts a basket doc for
//             any epoch that has none stored. A report over the 180-day
//             span crosses quarters with no basket yet, so the run minted
//             them from today's eligibility read. On 2026-09-03 nine
//             basket docs landed in prod this way (Q1 for all five
//             sports, Q2 for four), including a pokemon 2026-Q2 basket
//             of FOUR members - a permanent fixture for that quarter,
//             created by a run that claimed to be read-only.
//
//   HAZARD-2  A withheld day carried `priorLevel`, which started null and
//             only ever held levels published WITHIN the same run. The
//             nightly runs from === to: one withheld day found no prior
//             level, wrote nothing, and left the previous day's stored
//             point standing as the newest - with stale:false, so the
//             tile rendered a level from a different computation as if
//             it were live and current.
//
// These drive the real code with a fake container that records calls,
// which is the only way to assert "zero writes" rather than trust it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  ensureBasket,
  lastPublishedLevel,
} from "../src/services/insights/marketIndexCompute.service.js";
import {
  MIN_BASKET_SIZE,
  computeWeights,
  decidePoint,
} from "../src/services/insights/marketIndex.service.js";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

/** Records every call so a test can assert what was read and written. */
function fakeContainer(opts: {
  /** Docs addressable by item(id).read() - the stored baskets. */
  items?: Record<string, unknown>;
  /** Rows any query returns, in order of call. */
  queryResults?: unknown[][];
} = {}) {
  const writes: { method: string; id?: string }[] = [];
  const queries: string[] = [];
  const stored = opts.items ?? {};
  const results = [...(opts.queryResults ?? [])];
  const record = (method: string) => (doc: { id?: string }) => {
    writes.push({ method, id: doc?.id });
    return Promise.resolve({ resource: doc });
  };
  return {
    writes,
    queries,
    items: {
      query: (spec: { query: string }) => {
        queries.push(spec.query);
        const rows = results.shift() ?? [];
        let served = false;
        return {
          hasMoreResults: () => !served,
          fetchNext: () => {
            served = true;
            return Promise.resolve({ resources: rows });
          },
        };
      },
      upsert: record("items.upsert"),
      create: record("items.create"),
    },
    item: (id: string) => ({
      read: () => Promise.resolve({ resource: stored[id] ?? undefined }),
      replace: record("item.replace"),
      delete: record("item.delete"),
      patch: record("item.patch"),
    }),
  };
}

/** A sold_comps stand-in: enough eligible sales to select a basket. */
function fakeSoldComps(cards: number, salesPerCard = 12) {
  const rows: { cardId: string; price: number; soldAt: string }[] = [];
  for (let c = 0; c < cards; c++) {
    for (let s = 0; s < salesPerCard; s++) {
      rows.push({
        cardId: `card-${c}`,
        price: 100 + c,
        soldAt: `2026-05-${String((s % 28) + 1).padStart(2, "0")}`,
      });
    }
  }
  return fakeContainer({ queryResults: [rows] });
}

/** A stored basket doc with `n` members, addressable by item(id).read(). */
function storedBasket(sport: string, epoch: string, n: number) {
  return {
    [`basket::${sport}::${epoch}`]: {
      id: `basket::${sport}::${epoch}`,
      sport,
      epoch,
      baseDate: "2026-04-01",
      members: Array.from({ length: n }, (_, i) => ({
        cardId: `card-${i}`,
        baseValue: 100,
        weight: 1 / n,
        eligibilitySales: 10,
      })),
    },
  };
}

describe("HAZARD-1: a dry run over a span with no stored basket writes nothing", () => {
  it("ensureBasket({persist:false}) computes the basket WITHOUT upserting it", async () => {
    // The exact prod shape: the epoch asked for has NO stored basket, so
    // the old code took the mint-and-upsert path.
    const series = fakeContainer({ items: {} });
    const soldComps = fakeSoldComps(30);

    const out = await ensureBasket(
      soldComps as never,
      series as never,
      "pokemon",
      "2026-04-15", // 2026-Q2 - the epoch that got minted in prod
      { persist: false },
    );

    expect(out).not.toBeNull();
    expect(out!.basket.epoch).toBe("2026-Q2");
    expect(out!.basket.members.length).toBeGreaterThan(0);
    expect(out!.reused).toBe(false);
    expect(out!.persisted).toBe(false);

    // THE ASSERTION: zero writes, of any kind, on the series container.
    expect(series.writes).toEqual([]);
  });

  it("the same call WITHOUT persist:false does upsert - so the flag is what saves us", async () => {
    // Guards against the fix being vacuous: if this stopped writing, the
    // test above would pass for the wrong reason.
    const series = fakeContainer({ items: {} });
    const soldComps = fakeSoldComps(30);

    const out = await ensureBasket(
      soldComps as never,
      series as never,
      "pokemon",
      "2026-04-15",
    );

    expect(out!.persisted).toBe(true);
    expect(series.writes).toEqual([
      { method: "items.upsert", id: "basket::pokemon::2026-Q2" },
    ]);
  });

  it("a stored basket is reused and never rewritten", async () => {
    const series = fakeContainer({ items: storedBasket("hockey", "2026-Q3", 40) });
    const out = await ensureBasket(
      fakeSoldComps(5) as never,
      series as never,
      "hockey",
      "2026-08-15",
      { persist: false },
    );
    expect(out!.reused).toBe(true);
    expect(series.writes).toEqual([]);
  });

  it("the report lane drives the recompute through a write-refusing facade", () => {
    const script = read("backend/scripts/rebuild-market-indexes.cjs");
    // The facade exists, wraps the real container, and the report path
    // uses it rather than `series` directly.
    expect(script).toContain("function readOnlyContainer(real)");
    expect(script).toContain("const guard = readOnlyContainer(series);");
    expect(script).toContain("await dryRun(svc, compute, guard, sport, asOf, from)");
    // Every dry-run ensureBasket asks for persist:false. Counted rather
    // than pattern-matched: the calls span lines, so a loose regex reads
    // past them and pins nothing.
    const calls = script.match(/compute\.ensureBasket\(/g) ?? [];
    const guarded = script.match(/compute\.ensureBasket\([\s\S]*?persist: false,?\s*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(calls.length);
    // And the run asserts the write count is zero rather than assuming it.
    expect(script).toContain("guard.__writes.length > 0");
    expect(script).toContain("market_index_rebuild_write_in_report_mode");
  });

  it("the facade refuses upsert, create, replace, delete and patch", () => {
    const script = read("backend/scripts/rebuild-market-indexes.cjs");
    for (const m of [
      "items.create",
      "items.upsert",
      "item.replace",
      "item.delete",
      "item.patch",
    ]) {
      expect(script).toContain(`refuse("${m}")`);
    }
  });
});

describe("HAZARD-3: a basket too small to be an index is never built", () => {
  // The floor bounds how much of a basket was VALUED. It cannot see a
  // basket that is tiny to begin with: 4 members are fully valued by
  // construction, usedWeight is 1.00, and every day sails through. The
  // pokemon 2026-Q2 basket in prod had exactly 4 members and published
  // 328.69, 257.51 and 181.94 - the last of which is the number that
  // then carried onto the live tile.

  it("refuses a basket below MIN_BASKET_SIZE rather than publishing off it", async () => {
    const series = fakeContainer({ items: {} });
    // Four eligible cards - the prod pokemon Q2 shape.
    const out = await ensureBasket(
      fakeSoldComps(4) as never,
      series as never,
      "pokemon",
      "2026-04-15",
      { persist: false },
    );
    expect(out).toBeNull();
    expect(series.writes).toEqual([]);
  });

  it("a basket at or above the floor is still built", async () => {
    const series = fakeContainer({ items: {} });
    const out = await ensureBasket(
      fakeSoldComps(MIN_BASKET_SIZE) as never,
      series as never,
      "pokemon",
      "2026-04-15",
      { persist: false },
    );
    expect(out).not.toBeNull();
    expect(out!.basket.members.length).toBe(MIN_BASKET_SIZE);
  });

  it("a tiny basket is fully valued - which is exactly why the floor misses it", () => {
    // Four equal members, all valued: usedWeight 1.00, publish true.
    // This is the mechanism, stated as a fact about the old code.
    const base = new Array(4).fill(100);
    const weights = computeWeights(base);
    const members = base.map((b, i) => ({ weight: weights[i], baseValue: b }));
    const decision = decidePoint(members, [200, 300, 150, 400]);
    expect(decision.usedWeight).toBeCloseTo(1, 6);
    expect(decision.publish).toBe(true);   // the floor waves it through
    expect(decision.level).toBeGreaterThan(200);
  });

  it("a STORED basket below the floor is rejected too - this is what retires 181.94", async () => {
    // prod holds basket::pokemon::2026-Q2 with four members. Selection-
    // time checks alone would never see it: loadBasket returns it first.
    // Rejecting it on read is what stops those Q2 days publishing, and
    // 181.94 was the last level they produced.
    const series = fakeContainer({ items: storedBasket("pokemon", "2026-Q2", 4) });
    const out = await ensureBasket(
      fakeSoldComps(4) as never,
      series as never,
      "pokemon",
      "2026-04-15",
      { persist: false },
    );
    expect(out).toBeNull();
    expect(series.writes).toEqual([]);
  });

  it("an epoch with no buildable basket withholds instead of reusing the last one", () => {
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    // The roll must NOT silently keep the previous epoch's membership.
    expect(compute).toContain("if (picked.length < MIN_BASKET_SIZE) return null;");
    expect(compute).toMatch(/} else \{[\s\S]*?pointsWithheld\+\+;[\s\S]*?continue;/);
  });
});

describe("HAZARD-2: a withheld day carries the last PUBLISHED level", () => {
  it("lastPublishedLevel skips withheld points and returns the newest real one", async () => {
    // Newest-first, as the TOP 1 ... ORDER BY date DESC query returns.
    const series = fakeContainer({ queryResults: [[{ level: 73.01 }]] });
    const level = await lastPublishedLevel(series as never, "pokemon", "2026-09-03");
    expect(level).toBe(73.01);

    // The query must exclude stale points: carrying a carried level is
    // how a number no run ever published survives on the tile.
    expect(series.queries[0]).toContain("c.stale = false");
    expect(series.queries[0]).toContain("NOT IS_DEFINED(c.stale)");
    expect(series.queries[0]).toContain("c.date < @before");
  });

  it("returns null when nothing was ever published - the tile goes empty", async () => {
    const series = fakeContainer({ queryResults: [[]] });
    expect(await lastPublishedLevel(series as never, "pokemon", "2026-09-03")).toBeNull();
  });

  it("never carries a zero or negative level", async () => {
    const series = fakeContainer({ queryResults: [[{ level: 0 }]] });
    expect(await lastPublishedLevel(series as never, "hockey", "2026-09-03")).toBeNull();
  });

  it("the compute path SEEDS priorLevel from storage, not null", () => {
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    // The defect was `let priorLevel: number | null = null;` - a nightly
    // single-day run then had nothing to carry and wrote no point at all.
    expect(compute).toContain(
      "let priorLevel: number | null = await lastPublishedLevel(series, sport, fromDate)",
    );
    expect(compute).not.toContain("let priorLevel: number | null = null");
  });

  it("the dry run seeds the same way, so the report matches what would land", () => {
    const script = read("backend/scripts/rebuild-market-indexes.cjs");
    expect(script).toContain("await compute.lastPublishedLevel(series, sport, fullFrom)");
    expect(script).toContain("carriedLevel");
  });

  it("a withheld point is stored stale, with its reason, at the carried level", () => {
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    expect(compute).toContain("level: priorLevel");
    expect(compute).toContain("stale: true");
    expect(compute).toContain("withheldReason: decision.withheldReason");
  });
});
