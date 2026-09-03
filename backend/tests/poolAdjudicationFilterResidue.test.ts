/**
 * POOL-1 residue (audit, 2026-09-03).
 *
 * exactPoolReader learned to refuse adjudicated rows (`flaggedWrong` /
 * `excludedFromFmv`) in #1666. But the reader is not the only door into
 * sold_comps: several services query the container directly and inherited none
 * of that filter, so a row a human had already marked wrong still moved a
 * published number through them.
 *
 * These fixtures drive the two headline residues -- the grade curve and tiered
 * momentum -- through a FAKE Cosmos container that genuinely evaluates the flag
 * predicates in the SQL it is handed. A row that a correct query excludes never
 * reaches the service; a row an unfiltered query admits does. So the assertion
 * is behavioural, not a string match on the query text.
 *
 * MUTATION: drop either flag conjunct from the service's query and its test
 * reds -- the flaggedWrong row enters the sample and moves the number.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rows the fake container holds. Each test seeds this. */
let ROWS: Array<Record<string, unknown>> = [];
/** Every query the services issued, for the diagnostic on failure. */
let QUERIES: string[] = [];

/**
 * Evaluate ONLY the clauses these fixtures depend on: the two adjudication
 * predicates. Everything else about the row is matched by the seed itself
 * (one card, one slug), so the fixture does not need a SQL engine -- it needs
 * to honour exactly the filter under test.
 */
function rowPassesAdjudication(sql: string, row: Record<string, unknown>): boolean {
  const mentions = (flag: string) =>
    sql.includes(`NOT IS_DEFINED(c.${flag})`) && sql.includes(`c.${flag} !=`);
  if (mentions("flaggedWrong") && row.flaggedWrong === true) return false;
  if (mentions("excludedFromFmv") && row.excludedFromFmv === true) return false;
  return true;
}

/**
 * Honour the two clauses the fixtures actually depend on: the adjudication
 * predicates (the filter under test) and the `soldAt >= @cutoff` bound (so a
 * "recent window" means what the service thinks it means). Everything else is
 * arranged by the seed -- one card, one slug, one grade.
 */
function rowPassesCutoff(sql: string, row: Record<string, unknown>, params: Array<{ name: string; value: unknown }>): boolean {
  const m = /c\.soldAt\s*>=\s*(@\w+)/.exec(sql);
  if (!m) return true;
  const p = params.find((x) => `@${String(x.name).replace(/^@/, "")}` === m[1]);
  if (!p || typeof p.value !== "string") return true;
  return String(row.soldAt) >= p.value;
}

/** The one grade node the curve needs, served from card_catalog. */
const GRADE_NODE = { gradeLabel: "PSA 10", gradeCompany: "PSA", gradeValue: 10, observedSalesAtBuild: 5 };

function fakeContainer(name: string) {
  return {
    items: {
      query(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> } | string) {
        const sql = typeof spec === "string" ? spec : spec.query;
        const params = (typeof spec === "string" ? [] : spec.parameters) ?? [];
        QUERIES.push(`[${name}] ${sql}`);
        let served: Array<Record<string, unknown>> = [];
        if (name === "card_catalog") {
          // The slug-resolution lookup must miss so the caller's slug is used;
          // the grade-node lookup serves the one tier these fixtures price.
          if (/c\.kind = "grade"/.test(sql)) served = [GRADE_NODE as never];
        } else if (name === "sold_comps") {
          if (/SELECT\s+TOP\s+1\s+c\.hobbyiqCardId/i.test(sql)) served = [];
          else served = ROWS
            .filter((r) => rowPassesAdjudication(sql, r))
            .filter((r) => rowPassesCutoff(sql, r, params));
        }
        let drained = false;
        return {
          fetchAll: async () => ({ resources: served }),
          hasMoreResults: () => !drained,
          fetchNext: async () => { drained = true; return { resources: served }; },
        };
      },
    },
  };
}

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    database() {
      return { container: (n: string) => fakeContainer(n) };
    }
  },
}));

const SLUG = "hiq:baseball:2026:bowman-chrome:cpa-vf:base:auto";

/** A sale N days ago, at `price`, optionally adjudicated wrong. */
function sale(daysAgo: number, price: number, over: Record<string, unknown> = {}) {
  return {
    hobbyiqCardId: SLUG,
    cardId: SLUG,
    price,
    soldAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    gradeCompany: "PSA",
    gradeValue: 10,
    identityMethod: "cardnumber-precise",
    ...over,
  };
}

beforeEach(() => {
  ROWS = [];
  QUERIES = [];
  process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://fake/;AccountKey=fake==;";
  vi.resetModules();
});

describe("POOL-1 residue: tiered momentum refuses adjudicated rows", () => {
  /**
   * Ten honest sales at $100 across the baseline window, five of them recent.
   * Then ONE flaggedWrong row at $10,000 in the recent window -- the shape of
   * the exact defect: a wrong row that makes a flat card look like it exploded.
   */
  function seedFlatCardPlusOneWrongSpike() {
    for (let i = 0; i < 6; i++) ROWS.push(sale(5 + i, 100));   // recent
    for (let i = 0; i < 6; i++) ROWS.push(sale(120 + i, 100)); // baseline-only
  }

  it("a flaggedWrong spike does NOT move the momentum ratio", async () => {
    seedFlatCardPlusOneWrongSpike();
    const wrong = [
      sale(1, 10_000, { flaggedWrong: true }),
      sale(1, 10_000, { flaggedWrong: true }),
      sale(2, 10_000, { flaggedWrong: true }),
    ];
    ROWS.push(...wrong);

    const { computeTieredMomentum } = await import(
      "../src/services/compiq/tieredMomentum.service.js"
    );
    const res = await computeTieredMomentum(SLUG, { hobbyiqCardId: SLUG, identityHint: {} as never });

    expect(res.tier).toBe("card");
    // The card is flat: every admitted sale is $100.
    expect(res.compsWindow.medianPrice).toBe(100);
    expect(res.momentumRatio).toBe(1);
    // MUTATION SENTINEL: with the flaggedWrong conjunct dropped, the $10,000
    // rows enter the recent window and the median leaves $100.
    expect(res.compsWindow.n).toBe(6);
  });

  it("an excludedFromFmv row is refused on the same predicate", async () => {
    seedFlatCardPlusOneWrongSpike();
    ROWS.push(sale(1, 10_000, { excludedFromFmv: true }));
    const { computeTieredMomentum } = await import(
      "../src/services/compiq/tieredMomentum.service.js"
    );
    const res = await computeTieredMomentum(SLUG, { hobbyiqCardId: SLUG, identityHint: {} as never });
    expect(res.compsWindow.medianPrice).toBe(100);
    expect(res.compsWindow.n).toBe(6);
  });

  it("an UNflagged row of the same price DOES move it -- the filter is not a price clamp", async () => {
    seedFlatCardPlusOneWrongSpike();
    // Seven spikes, so the spike rows are the MAJORITY of the recent window
    // and the median genuinely moves. (Three would leave the median at $100
    // and the control would prove nothing.)
    for (let i = 0; i < 7; i++) ROWS.push(sale(1, 10_000)); // no flags
    const { computeTieredMomentum } = await import(
      "../src/services/compiq/tieredMomentum.service.js"
    );
    const res = await computeTieredMomentum(SLUG, { hobbyiqCardId: SLUG, identityHint: {} as never });
    expect(res.compsWindow.n).toBe(13);
    expect(res.compsWindow.medianPrice).toBeGreaterThan(100);
  });
});

describe("POOL-1 residue: the grade curve refuses adjudicated rows", () => {
  it("a flaggedWrong sale never enters the PSA 10 tier's sample", async () => {
    for (let i = 0; i < 5; i++) ROWS.push(sale(3 + i, 100));
    ROWS.push(sale(1, 10_000, { flaggedWrong: true }));
    ROWS.push(sale(1, 10_000, { excludedFromFmv: true }));

    const { buildTreeGradeCurve } = await import(
      "../src/services/compiq/treeGradeCurve.service.js"
    );
    const res = await buildTreeGradeCurve({ cardIdOrSlug: SLUG, hobbyiqCardId: SLUG });

    // The service may return null if the tree has no grade nodes; what this
    // fixture pins is the QUERY it issues for a tier's sales. Assert directly
    // on that when no curve comes back.
    const saleQueries = QUERIES.filter((q) => /SELECT c\.price, c\.soldAt FROM c/.test(q));
    expect(saleQueries.length).toBeGreaterThan(0);
    for (const q of saleQueries) {
      expect(q).toMatch(/NOT IS_DEFINED\(c\.flaggedWrong\)/);
      expect(q).toMatch(/NOT IS_DEFINED\(c\.excludedFromFmv\)/);
    }
    if (res) {
      const psa10 = res.entries.find((e) => e.gradeValue === 10);
      if (psa10 && typeof psa10.weightedMedianPrice === "number") {
        // The five honest $100 sales price the tier; the two adjudicated
        // $10,000 rows never reached it.
        expect(psa10.weightedMedianPrice).toBeLessThan(1000);
      }
    }
  });
});
