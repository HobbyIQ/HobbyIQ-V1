/**
 * CF-A-DETACHED-BATCH-STILL-NEEDS-A-CEILING /
 * CF-A-THROTTLED-CONTAINER-IS-NOT-A-SLOW-ONE (Fable, 2026-09-16).
 *
 * MEASURED. Over 7 days the TCA webhook issued 16,975,370 card_catalog calls,
 * 8.2% failing at the SDK's 60 s default — and the load is not spread evenly.
 * The eight worst REQUESTS account for ~10M of them. The worst single one:
 *
 *   card_catalog calls   3,820,650
 *   window               19:05:59 -> 01:15:03   (370 MINUTES)
 *   p50 duration         35,019 ms
 *   failed               3,521,410  (92%)
 *
 * One HTTP request ran for six hours issuing 3.8M queries, nine in ten
 * failing.
 *
 * THE RE-ENTRY IS THE ABSENCE OF A CEILING, not a loop bug:
 *
 *   tcaWebhook.routes.ts:323-328  CF-TCA-WEBHOOK-ACK-FIRST removed the 25 s
 *     hard-bail and replaced it with NOTHING. `elapsedMs` at the end of
 *     processBatchAsync is REPORTED, never CHECKED.
 *   persistVendorSalesToPool.service.ts (the two narrow queries)  carried no
 *     FeedOptions — no abortSignal — so each rode the SDK's 60 s default plus
 *     its internal retries.
 *   Under that load the container throttles, the next query is slower, the 48
 *     concurrency slots are held longer, and the batch cannot finish.
 *
 * These pins hold the three bounds and — the part that matters most — that a
 * healthy batch is byte-for-byte unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogQuery = vi.fn();
vi.mock("@azure/cosmos", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  class FakeCosmosClient {
    database() { return { container: () => ({ items: { query: catalogQuery } }) }; }
  }
  return { ...actual, CosmosClient: FakeCosmosClient };
});

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING
  ?? "AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdC1rZXktbm90LWEtc2VjcmV0;";

const mod = await import("../src/services/portfolioiq/persistVendorSalesToPool.service.js");
const { withNarrowBreaker, _narrowBreakerStateForTest, _checklistNarrowForTest } = mod as unknown as {
  withNarrowBreaker: <T>(work: () => Promise<T>) => Promise<T>;
  _narrowBreakerStateForTest: () => { consecutiveFailures: number; open: boolean; skipped: number; failed: number } | null;
  _checklistNarrowForTest: (p: string, y: number, s: string | null) => Promise<unknown>;
};

/** A query that always times out, as a saturated container does. */
const alwaysTimesOut = () => ({
  fetchAll: async () => {
    const err = new Error("The operation was aborted.");
    err.name = "TimeoutError";
    throw err;
  },
});
/** A healthy query returning one usable candidate row. */
const healthy = () => ({
  fetchAll: async () => ({
    resources: [{
      cardNumber: "US175", setKey: "topps-update", parallel: "Base",
      sport: "baseball", playerName: "Test Player", source: "cardhedge", confidence: 0.85,
    }],
  }),
});

let seq = 0;
/** Unique per call: checklistNarrow has a process-wide CATALOG_CACHE that
 *  survives between tests and would otherwise hide the queries under test. */
const uniquePlayer = () => `Runaway Probe ${++seq}`;

beforeEach(() => { catalogQuery.mockReset(); });

describe("the breaker stops a batch from asking a container that is not answering", () => {
  it("opens after the consecutive-failure threshold and stops querying", async () => {
    catalogQuery.mockImplementation(alwaysTimesOut);
    let state: ReturnType<typeof _narrowBreakerStateForTest> = null;

    await withNarrowBreaker(async () => {
      for (let i = 0; i < 40; i++) {
        await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");
      }
      state = _narrowBreakerStateForTest();
    });

    expect(state!.open).toBe(true);
    // MUTATION CHECK: unbounded, all 40 sales query — and in prod that was
    // 3.8M queries in one request. The breaker caps the damage at the
    // threshold and every later sale is skipped without a query.
    expect(state!.skipped).toBeGreaterThan(0);
    expect(catalogQuery.mock.calls.length).toBeLessThan(40 * 2);
  }, 30_000);

  it("a skipped sale returns null — the same value a genuine catalog miss returns", async () => {
    catalogQuery.mockImplementation(alwaysTimesOut);

    const result = await withNarrowBreaker(async () => {
      for (let i = 0; i < 25; i++) await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");
      return _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");
    });

    // This is the whole safety argument. An open breaker does not invent a
    // cardNumber and does not throw — it returns what a miss returns, so the
    // caller writes the sale unnarrowed exactly as it already does when the
    // catalog has no row. Nothing about what gets written changes.
    expect(result).toBeNull();
  }, 30_000);

  it("a SUCCESS resets the consecutive counter — one timeout is noise", async () => {
    let call = 0;
    catalogQuery.mockImplementation(() => (++call % 3 === 0 ? alwaysTimesOut() : healthy()));
    let state: ReturnType<typeof _narrowBreakerStateForTest> = null;

    await withNarrowBreaker(async () => {
      for (let i = 0; i < 30; i++) await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");
      state = _narrowBreakerStateForTest();
    });

    // Intermittent failures must NOT trip the breaker: the signal is a
    // container that has stopped answering, not one that is occasionally slow.
    expect(state!.open).toBe(false);
  }, 30_000);

  it("the breaker is per-batch — one bad batch does not disable the narrow", async () => {
    catalogQuery.mockImplementation(alwaysTimesOut);
    await withNarrowBreaker(async () => {
      for (let i = 0; i < 25; i++) await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");
    });

    // Scope closed. A process-wide breaker would be a single bad batch
    // silently degrading every later one.
    expect(_narrowBreakerStateForTest()).toBeNull();

    catalogQuery.mockImplementation(healthy);
    const after = await withNarrowBreaker(async () =>
      _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update"));
    expect(after).not.toBeNull();
  }, 30_000);
});

describe("a healthy batch is unchanged", () => {
  it("MUTATION CHECK — no breaker trip, and the row resolves as before", async () => {
    catalogQuery.mockImplementation(healthy);
    let state: ReturnType<typeof _narrowBreakerStateForTest> = null;

    const result = await withNarrowBreaker(async () => {
      const r = await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");
      state = _narrowBreakerStateForTest();
      return r;
    });

    expect(state!.open).toBe(false);
    expect(state!.failed).toBe(0);
    expect(state!.skipped).toBe(0);
    // The resolved shape is what it always was: the narrow's own candidates.
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ number: string }>)[0].number).toBe("US175");
  }, 30_000);

  it("outside a breaker scope the narrow behaves exactly as before", async () => {
    catalogQuery.mockImplementation(healthy);

    const result = await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");

    // Every other caller — the rematch lanes, the eBay import, the backfills —
    // opts into nothing and changes not at all.
    expect(_narrowBreakerStateForTest()).toBeNull();
    expect(Array.isArray(result)).toBe(true);
  }, 30_000);
});

describe("the per-query deadline is present", () => {
  it("every narrow query carries an abortSignal", async () => {
    catalogQuery.mockImplementation(healthy);

    await _checklistNarrowForTest(uniquePlayer(), 2011, "topps-update");

    // MUTATION CHECK: these queries carried NO FeedOptions at all, so each rode
    // the SDK's 60 s default plus its internal retries — the direct cause of a
    // 35 s p50 per row against a saturated container.
    const [, options] = catalogQuery.mock.calls[0];
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  }, 30_000);
});
