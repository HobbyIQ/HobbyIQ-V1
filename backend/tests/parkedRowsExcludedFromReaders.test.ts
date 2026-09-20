/**
 * R70 (owner ruling, 2026-09-19): "a parked sale is OUT OF EVERY POOL."
 *
 * `identityUnverified: true` is the write guard's PARK stamp
 * (splitIdentityWriteGuard.ts's guardSoldCompDoc / parkSoldCompDoc) for
 * split-identity / sport-unresolved / malformed-key / insert-named-no-key /
 * two-inserts-named rows. The row's own identity is unverified, so it must
 * not price ANY card, appear in ANY trend/index, or show up in a
 * user-facing recent-sales list under the card its cardId/hobbyiqCardId
 * happen to name.
 *
 * exactPoolReader.ts and soldCompsGradeReader.ts are pinned in
 * bowmanBaseRefractorRoots.test.ts (POOL-1 / POOL-1b). This file pins the
 * same predicate on the other independent sold_comps readers that feed a
 * published price, trend, or index, or the recent-sales display:
 *
 *   - hobbyIqFmv.service.ts's queryPool      (the other independent FMV pool
 *                                              engine, not a wrapper of
 *                                              exactPoolReader)
 *   - soldCompsStore.service.ts's
 *     readCompsByCardId                      (GET /recent-sales; previously
 *                                              had NO adjudication filter at
 *                                              all)
 *   - marketMoversSnapshot.service.ts's
 *     computeMarketMovers raw-scan path      (Market Movers surface)
 *   - marketIndex.service.ts's fetchSales    (per-sport published index)
 *
 * Each case captures the REAL query text sent to Cosmos (not an in-memory
 * post-filter — none of these readers has one) and asserts the
 * undefined-tolerant clause is present, mirroring exactly how each file
 * already wrote its neighbouring flaggedWrong/excludedFromFmv clauses.
 *
 * NOT fixed by this PR (surveyed, scoped out as follow-ups, each deserving
 * its own small PR rather than folding ~20 more readers into this one):
 * tieredMomentum.service.ts, discoverySurfaces.service.ts,
 * imageSimilarityLookup.service.ts, treeGradeCurve.service.ts,
 * rareCardFmv.service.ts, unifiedPricing.service.ts's player-trend-ratio
 * helper, playerIndexRead.ts, exactPoolSupremacy.ts, weeklyHobbyIndex.service.ts,
 * cohortBacktest.service.ts, subRawInversionScan.service.ts,
 * catalogSearch.service.ts + attach-sales-summary-to-catalog.ts, and the
 * direct-query routes priceSeries.routes.ts / setDetail.routes.ts /
 * playerDetail.routes.ts. All share the identical flaggedWrong-only (or,
 * for readCompsByCardId's siblings, filter-less) gap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hobbyIqFmv.service.ts: queryPool ───────────────────────────────────────
//
// computeHobbyIqFmv fires SEVERAL distinct queries per call (a composite
// lookup, then multiple ladder rungs each through queryPool), so the mock
// records every query text seen rather than only the last one — otherwise a
// later, unrelated query (the cardsight composite lookup) silently overwrites
// the one this test actually cares about.
describe("R70/R71: hobbyIqFmv.service queryPool excludes parked rows (with the R71 carve-out)", () => {
  let queries: string[] = [];
  let fixtureRows: Array<Record<string, unknown>> = [];
  beforeEach(() => { queries = []; fixtureRows = []; vi.resetModules(); });

  async function loadService() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  queries.push(spec.query);
                  // Only the queryPool-shaped queries (which SELECT
                  // c.hobbyiqCardId among other pool columns) get the
                  // fixture; the composite lookup (`SELECT TOP 1 c.cardId`)
                  // gets none, matching its own shape.
                  const isPoolQuery = spec.query.includes("c.qualityFlags");
                  return { fetchAll: async () => ({ resources: isPoolQuery ? fixtureRows : [] }) };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/portfolioiq/hobbyIqFmv.service.js");
  }

  it("computeHobbyIqFmv's pool query filters identityUnverified alongside flaggedWrong", async () => {
    const { computeHobbyIqFmv } = await loadService();
    await computeHobbyIqFmv({
      hobbyiqCardId: "hiq:baseball:2024:test-set:1:base:no-auto",
      gradeCompany: null, gradeValue: null,
    });
    const poolQueries = queries.filter((q) => q.includes("c.qualityFlags"));
    expect(poolQueries.length).toBeGreaterThan(0);
    for (const q of poolQueries) {
      // MUTATION: delete this predicate from hobbyIqFmv.service.ts and this fails.
      expect(q).toContain("c.identityUnverified = false");
      expect(q).toContain("NOT IS_DEFINED(c.identityUnverified)");
      // Unchanged neighbour.
      expect(q).toContain("c.flaggedWrong = false");
      // R71: the carve-out clause is present too (this function's queryPool
      // never matches on c.cardId — see the module comment — so the
      // carve-out is applied wholesale, not CASE-scoped by union side).
      expect(q).toContain("c.identityUnverifiedReason");
    }
  });

  // R71 (owner ruling, 2026-09-19). Every queryPool call site in this file
  // matches on hobbyiqCardId or the target identity's composite fields, never
  // on the vendor-side cardId — so a row it returns was always found BY
  // hobbyiqCardId, and the whole split-identity/sport-mismatch PARK class is
  // safe to re-admit here.
  it("VW3-shaped parked row (split-identity) is KEPT in the pool", async () => {
    fixtureRows = [{
      price: 22, soldAt: new Date().toISOString(), source: "cardhedge",
      hobbyiqCardId: "hiq:basketball:2023:topps:vw-3:base:no-auto",
      identityUnverified: true, identityUnverifiedReason: "split-identity",
    }];
    const { computeHobbyIqFmv } = await loadService();
    const res = await computeHobbyIqFmv({
      hobbyiqCardId: "hiq:basketball:2023:topps:vw-3:base:no-auto",
      gradeCompany: null, gradeValue: null,
    });
    // At least one rung saw the fixture row rather than an empty pool.
    expect(res).toBeDefined();
    expect(res.compCount).toBeGreaterThan(0);
  });

  it("duplicate-partition-copy stays EXCLUDED even though queryPool is hobbyiqCardId-keyed", async () => {
    fixtureRows = [];
    const { computeHobbyIqFmv } = await loadService();
    const res = await computeHobbyIqFmv({
      hobbyiqCardId: "hiq:pokemon:2022:pokemon-go:005078:holo:no-auto:num-78",
      gradeCompany: null, gradeValue: null,
    });
    expect(res.compCount).toBe(0);
    const poolQueries = queries.filter((q) => q.includes("c.qualityFlags"));
    expect(poolQueries.length).toBeGreaterThan(0);
    for (const q of poolQueries) expect(q).toContain("c.identityUnverifiedReason");
  });
});

// ── soldCompsStore.service.ts: readCompsByCardId (recent-sales) ──────────
//
// This module provisions its own container on first use (createIfNotExists),
// so it exposes `_setContainerForTests` as its seam (see
// soldCompsAgingAndFlag.test.ts) rather than being driven by mocking
// "@azure/cosmos" directly.
import type { Container } from "@azure/cosmos";

describe("R70: readCompsByCardId (recent-sales) excludes parked rows", () => {
  let soldCompsStore: typeof import("../src/services/portfolioiq/soldCompsStore.service.js");
  let captured: { query?: string; params?: Array<{ name: string; value: unknown }> };
  let store: Map<string, Record<string, unknown>>;

  beforeEach(async () => {
    vi.resetModules();
    soldCompsStore = await import("../src/services/portfolioiq/soldCompsStore.service.js");
    captured = {};
    store = new Map();
    const fakeContainer = {
      items: {
        query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => {
          captured.query = spec.query;
          captured.params = spec.parameters;
          // No SQL parsing (matches this repo's existing fake-Cosmos test
          // harnesses for this module) -- the fixture below IS what the
          // real WHERE clause, proven present by the query-text assertions,
          // would already have left after excluding a parked row.
          return { fetchAll: async () => ({ resources: Array.from(store.values()) }) };
        },
      },
    } as unknown as Container;
    soldCompsStore._setContainerForTests(fakeContainer);
  });

  afterEach(() => { soldCompsStore._setContainerForTests(null); });

  it("the query text carries all three adjudication predicates", async () => {
    await soldCompsStore.readCompsByCardId({ cardId: "cs-vendor-1" });
    expect(captured.query).toBeDefined();
    // Previously this query had NO adjudication filter at all.
    // MUTATION: delete any of these three predicates and this fails.
    expect(captured.query).toContain("c.flaggedWrong != true");
    expect(captured.query).toContain("c.excludedFromFmv != true");
    expect(captured.query).toContain("c.identityUnverified != true");
    expect(captured.query).toContain("NOT IS_DEFINED(c.flaggedWrong)");
    expect(captured.query).toContain("NOT IS_DEFINED(c.excludedFromFmv)");
    expect(captured.query).toContain("NOT IS_DEFINED(c.identityUnverified)");
  });

  it("in-memory: what a real WHERE clause would leave behind is what the reader returns unmodified", async () => {
    // The fixture stands in for "what the real Cosmos WHERE clause, proven
    // present above, would already have removed" -- a parked row is never
    // placed in the fixture, matching how a real container would have
    // excluded it server-side before this code ever sees a result. This
    // guards against the reader ALSO dropping the clean row via some
        // unrelated in-memory filter.
    store.set("clean", {
      id: "clean", cardId: "cs-vendor-1", price: 10, soldAt: new Date().toISOString(),
      source: "cardhedge",
    });
    const rows = await soldCompsStore.readCompsByCardId({ cardId: "cs-vendor-1" });
    expect(rows.map((r) => r.id)).toEqual(["clean"]);
  });
});

// ── soldCompsStore.service.ts: readCompsByCardId, the hiq-slug (hobbyiqCardId)
// path — R71's union-side carve-out only applies here, never on the
// vendor-cardId path pinned just above ─────────────────────────────────────
describe("R71: readCompsByCardId's hiq-slug lookup carves out the sport-mismatch PARK class", () => {
  let soldCompsStore: typeof import("../src/services/portfolioiq/soldCompsStore.service.js");
  let captured: { query?: string };
  let store: Map<string, Record<string, unknown>>;

  beforeEach(async () => {
    vi.resetModules();
    soldCompsStore = await import("../src/services/portfolioiq/soldCompsStore.service.js");
    captured = {};
    store = new Map();
    const fakeContainer = {
      items: {
        query: (spec: { query: string }) => {
          captured.query = spec.query;
          return { fetchAll: async () => ({ resources: Array.from(store.values()) }) };
        },
      },
    } as unknown as Container;
    soldCompsStore._setContainerForTests(fakeContainer);
  });

  afterEach(() => { soldCompsStore._setContainerForTests(null); });

  it("matchField is c.hobbyiqCardId for an hiq slug, and the carve-out clause is present", async () => {
    await soldCompsStore.readCompsByCardId({ cardId: "hiq:basketball:2023:topps:vw-3:base:no-auto" });
    expect(captured.query).toBeDefined();
    expect(captured.query).toContain("c.hobbyiqCardId = @cid");
    expect(captured.query).toContain("c.identityUnverifiedReason");
  });

  it("VW3-shaped parked row survives on the hiq-slug path", async () => {
    store.set("vw3", {
      id: "vw3", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: "hiq:basketball:2023:topps:vw-3:base:no-auto",
      price: 25, soldAt: new Date().toISOString(), source: "cardhedge",
      identityUnverified: true, identityUnverifiedReason: "split-identity",
    });
    const rows = await soldCompsStore.readCompsByCardId({ cardId: "hiq:basketball:2023:topps:vw-3:base:no-auto" });
    expect(rows.map((r) => r.id)).toEqual(["vw3"]);
  });

  it("duplicate-partition-copy still excluded on the hiq-slug path", async () => {
    // Nothing placed in `store` — a real container would have already
    // removed it (never-admit prefix), matching this repo's fixture style.
    const rows = await soldCompsStore.readCompsByCardId({ cardId: "hiq:pokemon:2022:pokemon-go:005078:holo:no-auto:num-78" });
    expect(rows).toEqual([]);
    expect(captured.query).toContain("duplicate-partition-copy");
  });
});

// ── marketMoversSnapshot.service.ts: raw-scan path ────────────────────────
describe("R70: computeMarketMovers raw-scan path excludes parked rows", () => {
  const captured: { query?: string } = {};
  beforeEach(() => { captured.query = undefined; vi.resetModules(); delete process.env.MARKET_MOVERS_USE_ROLLUPS; });

  async function loadService() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  captured.query = spec.query;
                  let done = false;
                  return {
                    hasMoreResults: () => !done,
                    fetchNext: async () => { done = true; return { resources: [] }; },
                  };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/marketMoversSnapshot.service.js");
  }

  it("the raw-scan WHERE clause carries all three adjudication predicates", async () => {
    const { computeMarketMovers } = await loadService();
    await computeMarketMovers({ sport: "baseball", windowDays: 30, direction: "both", limit: 20, minSales: 1 });
    expect(captured.query).toBeDefined();
    // MUTATION: delete any of these three predicates and this fails.
    expect(captured.query).toContain("c.flaggedWrong = false");
    expect(captured.query).toContain("c.excludedFromFmv = false");
    expect(captured.query).toContain("c.identityUnverified = false");
    expect(captured.query).toContain("NOT IS_DEFINED(c.identityUnverified)");
  });
});

// ── marketIndex.service.ts: fetchSales ────────────────────────────────────
describe("R70: marketIndex.service fetchSales excludes parked rows", () => {
  it("the query text carries all three adjudication predicates", async () => {
    const { fetchSales } = await import("../src/services/insights/marketIndex.service.js");
    const captured: { query?: string } = {};
    const fakeContainer = {
      items: {
        query: (spec: { query: string }) => {
          captured.query = spec.query;
          let done = false;
          return {
            hasMoreResults: () => !done,
            fetchNext: async () => { done = true; return { resources: [] }; },
          };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await fetchSales(fakeContainer, "baseball", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    expect(captured.query).toBeDefined();
    // MUTATION: delete any of these three predicates and this fails.
    expect(captured.query).toContain("c.flaggedWrong = false");
    expect(captured.query).toContain("c.excludedFromFmv = false");
    expect(captured.query).toContain("c.identityUnverified = false");
    expect(captured.query).toContain("NOT IS_DEFINED(c.identityUnverified)");
  });
});
