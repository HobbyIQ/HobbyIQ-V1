/**
 * CF-AN-INGEST-TWIN-NEVER-OUTLIVES-ITS-FOLD / #2221 REUSE (2026-09-19).
 *
 * resolveChecklistNumberedIngest.test.ts pins the module's OWN logic against
 * an injected `runQuery`/`breakerIsOpen`. This file proves the wiring at the
 * two real call sites is not just an injectable interface that could
 * silently diverge: `persistVendorSalesToPool.service.ts`'s EXPORTED
 * `narrowQuery` / `narrowBreakerIsOpen` / `withNarrowBreaker` are the actual
 * functions passed in, so a container that trips the breaker for
 * checklistNarrow's two per-sale queries ALSO stops this module's query --
 * one shared breaker, fed by every per-sale card_catalog narrow in the file,
 * exactly the "no second implementation" requirement from the #2221 review.
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

const persistMod = await import("../src/services/portfolioiq/persistVendorSalesToPool.service.js");
const { withNarrowBreaker, narrowQuery, narrowBreakerIsOpen, recordNarrowSkip, _narrowBreakerStateForTest, NARROW_QUERY_TIMEOUT_MS } =
  persistMod as unknown as {
    withNarrowBreaker: <T>(work: () => Promise<T>) => Promise<T>;
    narrowQuery: <T>(run: () => Promise<T>) => Promise<T>;
    narrowBreakerIsOpen: () => boolean;
    recordNarrowSkip: () => void;
    _narrowBreakerStateForTest: () => { consecutiveFailures: number; open: boolean; skipped: number; failed: number } | null;
    NARROW_QUERY_TIMEOUT_MS: number;
  };

const { resolveChecklistNumberedIngestId, newNumberedIngestCache } =
  await import("../src/services/catalog/resolveChecklistNumberedIngest.js");

const alwaysTimesOut = () => ({
  fetchAll: async () => {
    const err = new Error("The operation was aborted.");
    err.name = "TimeoutError";
    throw err;
  },
});
const healthy = () => ({
  fetchAll: async () => ({
    resources: [{
      id: "hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499",
      source: "checklistcenter-2026-08-30",
      setKey: "bowman",
      parallelSlug: "base-refractor",
      isAuto: true,
      printRun: 499,
    }],
  }),
});

const BASE_INPUT = {
  slug: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto",
  sport: "baseball",
  year: 2026,
  setKey: "bowman",
  cardNumber: "cpa-mh",
  parallelSlug: "refractor",
  isAuto: true,
  printRun: null as number | null,
};

const callThroughRealBreaker = (cardNumber: string) =>
  resolveChecklistNumberedIngestId(
    { ...BASE_INPUT, cardNumber, slug: `hiq:baseball:2026:bowman:${cardNumber}:refractor:auto` },
    {
      container: { items: { query: catalogQuery } } as never,
      cache: newNumberedIngestCache(),
      runQuery: (run) => narrowQuery(() => run()),
      breakerIsOpen: narrowBreakerIsOpen,
      recordSkip: recordNarrowSkip,
      queryOptions: { abortSignal: AbortSignal.timeout(NARROW_QUERY_TIMEOUT_MS) },
    },
  );

beforeEach(() => { catalogQuery.mockReset(); });

describe("resolveChecklistNumberedIngestId wired through the REAL persistVendorSalesToPool breaker", () => {
  it("a container that is not answering trips the SAME breaker checklistNarrow feeds, and this module then stops querying too", async () => {
    catalogQuery.mockImplementation(alwaysTimesOut);
    let state: ReturnType<typeof _narrowBreakerStateForTest> = null;

    await withNarrowBreaker(async () => {
      // Enough consecutive failures through THIS module alone to trip the
      // shared breaker -- proving the breaker counts this module's failures,
      // not only checklistNarrow's.
      for (let i = 0; i < 25; i++) await callThroughRealBreaker(`cpa-x${i}`);
      state = _narrowBreakerStateForTest();
    });

    expect(state!.open).toBe(true);
    expect(state!.failed).toBeGreaterThan(0);
  }, 30_000);

  it("once open, further calls issue ZERO queries and still return null (the sale still writes)", async () => {
    catalogQuery.mockImplementation(alwaysTimesOut);

    const result = await withNarrowBreaker(async () => {
      for (let i = 0; i < 20; i++) await callThroughRealBreaker(`cpa-y${i}`);
      const callsBeforeOpen = catalogQuery.mock.calls.length;
      const afterOpen = await callThroughRealBreaker("cpa-after-open");
      const callsAfterOpen = catalogQuery.mock.calls.length;
      return { afterOpen, issuedMore: callsAfterOpen > callsBeforeOpen };
    });

    expect(result.afterOpen).toBeNull();
    expect(result.issuedMore).toBe(false);
  }, 30_000);

  it("a healthy container never trips the breaker and resolves the numbered id normally", async () => {
    catalogQuery.mockImplementation(healthy);
    let state: ReturnType<typeof _narrowBreakerStateForTest> = null;

    const id = await withNarrowBreaker(async () => {
      const r = await callThroughRealBreaker("cpa-mh");
      state = _narrowBreakerStateForTest();
      return r;
    });

    expect(id).toBe("hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499");
    expect(state!.open).toBe(false);
    expect(state!.failed).toBe(0);
  }, 30_000);

  it("outside any withNarrowBreaker scope, behaves exactly as before (no breaker, no crash)", async () => {
    catalogQuery.mockImplementation(healthy);
    const id = await callThroughRealBreaker("cpa-mh-outside");
    expect(id).toBe("hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499");
  }, 30_000);
});
