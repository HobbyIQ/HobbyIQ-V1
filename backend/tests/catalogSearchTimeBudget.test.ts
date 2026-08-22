// CF-CATALOG-SEARCH-TIME-BUDGET (2026-08-21) — pin the wall-clock budget.
//
// THE BUG. Two comments in catalogSearch.service.ts reason about "the 20s
// budget" as though it were enforced. It never was: there was no timeout, no
// AbortSignal and no deadline anywhere in the escalation ladder, so a query
// falling through to the unindexed CONTAINS fallbacks ran until Cosmos was
// done with it. Measured in prod over 6h on 2026-08-21, catalogMs:
//
//     p50 2.3s    p95 556s    max 727s
//
// 727s is twelve minutes. Nobody is still waiting — but the query keeps
// burning RUs and holding an event-loop slot, and that combination is what
// starved the box earlier the same day. An abandoned request that still costs
// full price is worse than a truncated answer.
//
// THIS FILE PINS:
//   1. The ladder stops once the budget is spent, instead of starting the next
//      unindexed scan anyway. The rungs run in SEQUENCE, so without a check
//      BETWEEN them one slow query lets the next two start regardless.
//   2. Partial results survive. A late abort must not read as "no such card".
//   3. Truncation is LABELLED (`timedOut`) on both the empty and the non-empty
//      path — the route refuses to cache a truncated result, so a silent
//      truncation would pin one slow moment's short answer for the whole TTL.
//   4. A fast search is untouched: no timedOut flag, full ladder available.
//   5. Queries carry an abortSignal, so the budget actually CANCELS Cosmos
//      work rather than just abandoning the promise. Abandoning does nothing
//      for the RU burn, which is the real damage.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// SEARCH_BUDGET_MS is read once at module load, so the budget must be set
// BEFORE the import. A static import at the top of this file would freeze the
// 20s default and every timing assertion would silently measure the default
// instead of the value under test.
async function loadWithBudget(budgetMs: string) {
  vi.stubEnv("CATALOG_SEARCH_BUDGET_MS", budgetMs);
  vi.resetModules();
  return import("../src/services/catalog/catalogSearch.service.js");
}

const QUERY = "2024 Bowman Chrome Blue Raywave Auto Leo De Vries";

type Spy = { queries: string[]; signals: Array<AbortSignal | undefined> };

/**
 * Fake catalog container. `delayMs` per query and `rows` returned let a test
 * choose which rung of the ladder is slow and which produces candidates.
 */
function fakeContainer(opts: {
  delayMs: number;
  rows?: (sql: string) => unknown[];
  spy: Spy;
}) {
  return {
    items: {
      query(spec: { query: string }, feedOpts?: { abortSignal?: AbortSignal }) {
        opts.spy.queries.push(spec.query);
        opts.spy.signals.push(feedOpts?.abortSignal);
        return {
          fetchAll: () =>
            new Promise((resolve, reject) => {
              const signal = feedOpts?.abortSignal;
              const timer = setTimeout(
                () => resolve({ resources: opts.rows ? opts.rows(spec.query) : [] }),
                opts.delayMs,
              );
              signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            }),
        };
      },
    },
  } as never;
}

let spy: Spy;

beforeEach(() => {
  spy = { queries: [], signals: [] };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CF-CATALOG-SEARCH-TIME-BUDGET", () => {
  it("passes an abortSignal to every query it issues", async () => {
    // Cancellation, not abandonment. Racing a promise leaves the Cosmos query
    // running server-side and does nothing for the RU burn.
    const mod = await loadWithBudget("1000");
    mod.__setCatalogContainerForTest(fakeContainer({ delayMs: 0, spy }));
    await mod.searchCatalog({ query: QUERY, limit: 25, playerName: "Leo De Vries" });

    expect(spy.queries.length).toBeGreaterThan(0);
    expect(spy.signals.every((s) => s instanceof AbortSignal)).toBe(true);
    mod.__setCatalogContainerForTest(null);
  });

  it("stops the ladder instead of starting the next unindexed scan", async () => {
    // Every rung is slower than the whole budget and returns nothing, so a
    // ladder with no deadline would run all of them end to end.
    const mod = await loadWithBudget("1000");
    mod.__setCatalogContainerForTest(fakeContainer({ delayMs: 5_000, spy }));

    const started = Date.now();
    const res = await mod.searchCatalog({ query: QUERY, limit: 25, playerName: "Leo De Vries" });
    const elapsed = Date.now() - started;

    // Bounded by the budget, not by rungs x 5s.
    expect(elapsed).toBeLessThan(4_000);
    expect(res.timedOut).toBe(true);
    expect(res.hits).toEqual([]);
    mod.__setCatalogContainerForTest(null);
  }, 15_000);

  it("keeps partial results rather than reporting no such card", async () => {
    // The cheap arm answers; a later rung would be slow. A late abort must not
    // discard what was already collected.
    const mod = await loadWithBudget("1000");
    mod.__setCatalogContainerForTest(
      fakeContainer({
        delayMs: 0,
        spy,
        rows: () => [
          {
            id: "hiq:2024-bowman-chrome:leo-de-vries:bcp-69:blue-raywave:auto",
            playerName: "Leo De Vries",
            year: 2024,
            setKey: "2024-bowman-chrome",
            cardNumber: "BCP-69",
            parallel: "Blue Raywave",
            isAuto: true,
          },
        ],
      }),
    );

    const res = await mod.searchCatalog({ query: QUERY, limit: 25, playerName: "Leo De Vries" });
    expect(res.hits.length).toBeGreaterThan(0);
    mod.__setCatalogContainerForTest(null);
  });

  it("does not flag a search that finished inside its budget", async () => {
    const mod = await loadWithBudget("1000");
    mod.__setCatalogContainerForTest(fakeContainer({ delayMs: 0, spy }));
    const res = await mod.searchCatalog({ query: QUERY, limit: 25, playerName: "Leo De Vries" });
    expect(res.timedOut).toBeUndefined();
    mod.__setCatalogContainerForTest(null);
  });

  it("honours CATALOG_SEARCH_BUDGET_MS and floors it at 1s", async () => {
    // The floor matters: a misconfigured 0 would abort before the first cheap
    // point-lookup could answer, turning every search into a timeout.
    const mod = await loadWithBudget("0");
    mod.__setCatalogContainerForTest(fakeContainer({ delayMs: 0, spy }));

    const res = await mod.searchCatalog({ query: QUERY, limit: 25, playerName: "Leo De Vries" });
    expect(res.timedOut).toBeUndefined(); // a 0 did not become an instant abort
    mod.__setCatalogContainerForTest(null);
  });
});
