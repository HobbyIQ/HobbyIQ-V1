/**
 * CF-ONE-COSMOS-CLIENT-ON-THE-PRICE-PATH (Fable, 2026-09-15).
 *
 * THE DEFECT. POST /api/compiq/price hung to Azure's 240 s front-end kill
 * (HTTP 499) on star queries — "2024 Bowman Chrome Ohtani Base" is both a real
 * user report and the setdoc-baseline smoke case. Three facts compounded:
 *
 *   1. compiq.routes.ts built a BRAND-NEW CosmosClient per request, from the
 *      raw connection STRING, which is the one call shape that takes no
 *      connection policy. enableEndpointDiscovery therefore stayed at the SDK
 *      default (true) with a location cache that, on a client discarded at the
 *      end of the request, never populated. cosmosConnectionPolicy.ts exists
 *      to prevent exactly this and measures the cost: 4 root "GET /" round
 *      trips per operation instead of 2 for a client's whole life.
 *   2. Nothing in backend/src sets requestTimeout or bounds retryOptions, and
 *      there is no Express server-level timeout, so under 429s the SDK retried
 *      without a ceiling.
 *   3. The block then ran up to two cross-partition TOP 60 fan-outs whose
 *      every predicate is LOWER()/CONTAINS() — not index-servable.
 *
 * These pins hold the two halves of the fix that are checkable without prod:
 * the route takes the shared handle and never constructs a client of its own,
 * and an over-budget lookup answers with a REFUSAL rather than hanging. The
 * refusal shape is the one smoke-test-pricing-tiers.withheldReasonOf already
 * reads — null FMV plus a named reason — so a withheld price still clears
 * engine_ok and the nightly reprice still runs.
 */
import request from "supertest";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING
  ?? "AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdC1rZXktbm90LWEtc2VjcmV0;";

/** Every CosmosClient constructed while the route runs. Empty is the pin. */
const constructedClients: unknown[] = [];

vi.mock("@azure/cosmos", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const Real = actual.CosmosClient as new (...args: unknown[]) => unknown;
  class CountingCosmosClient extends (Real as any) {
    constructor(...args: unknown[]) {
      super(...args);
      constructedClients.push(args[0]);
    }
  }
  return { ...actual, CosmosClient: CountingCosmosClient };
});

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user", email: "t@t", username: null, fullName: null,
      plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

/** The shared handle the route must take. Its queries are the seam. */
const catalogQuery = vi.fn();
vi.mock("../src/services/portfolioiq/cardCatalog.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardCatalogContainer: vi.fn(async () => ({
      items: { query: catalogQuery },
    })),
  };
});

// computeEstimate is the fall-through path. A deadline must NOT reach it —
// that is the whole point of the early return, so this mock doubles as the
// assertion that it was not called.
const computeEstimate = vi.fn(async () => ({
  fairMarketValue: 42, source: "live", compsUsed: 1, compsAvailable: 1,
  recentComps: [], cardIdentity: { cardId: "should-not-be-reached" },
  confidence: { pricingConfidence: 50 },
}));
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, computeEstimate };
});

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

beforeEach(() => {
  // Reset AFTER app import, so the repositories and services that build their
  // own memoised clients at module load are not counted. The pin is about what
  // the REQUEST constructs, and the pre-fix route constructed one per request —
  // so a per-request window is the honest place to measure it.
  constructedClients.length = 0;
  catalogQuery.mockReset();
  computeEstimate.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * The cardNumber-less star query that triggers the player-lookup block.
 *
 * Each case uses a DIFFERENT YEAR rather than a suffix. Two reasons, both
 * learned the hard way: /price is response-cached on the normalised query, so
 * cases must not collide; and a trailing token like "b2" is read by
 * parseCardQuery as a CARD NUMBER, which routes the request into the
 * cardNumber-ful canonical-first branch instead of the player-lookup branch
 * this file is about. Verified against the parser: every year below yields
 * cardNumber=null, confidence=0.5, set="Bowman Chrome".
 */
const starQuery = (year: number) => year + " Bowman Chrome Ohtani Base";
const post = (year: number) =>
  request(app).post("/api/compiq/price")
    .set("x-session-id", "test-session")
    .send({ query: starQuery(year) });

const abortingFetchAll = () => ({
  fetchAll: async () => {
    const err = new Error("The operation was aborted.");
    err.name = "TimeoutError";
    throw err;
  },
});

describe("the price path takes the process Cosmos client, never its own", () => {
  it("constructs NO CosmosClient while serving a star query", async () => {
    catalogQuery.mockReturnValue({ fetchAll: async () => ({ resources: [] }) });

    await post(2024);

    // MUTATION CHECK: with the pre-fix "new _CC(cn).database(...)" line this
    // holds one entry PER REQUEST — and the entry is the bare connection
    // STRING, the call shape that carries no connection policy at all. A
    // client built through the shared helper is passed an OPTIONS OBJECT, so
    // even a legitimate lazy construction would not look like this.
    const perRequestStringClients = constructedClients.filter((a) => typeof a === "string");
    expect(perRequestStringClients).toEqual([]);
  });

  it("reads card_catalog through the shared handle", async () => {
    catalogQuery.mockReturnValue({ fetchAll: async () => ({ resources: [] }) });

    await post(2023);

    // The shared container's query seam is what actually ran. Pre-fix this
    // was never touched: the route queried its own private container object.
    expect(catalogQuery).toHaveBeenCalled();
  });

  it("passes an abortSignal on the catalog fan-out", async () => {
    catalogQuery.mockReturnValue({ fetchAll: async () => ({ resources: [] }) });

    await post(2022);

    const options = catalogQuery.mock.calls[0][1] as { abortSignal?: unknown } | undefined;
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
    // Pre-fix there was no second argument at all — the query could only be
    // stopped by the process ending or Azure killing the front-end socket.
  });
});

describe("an over-budget catalog lookup is withheld, not hung", () => {
  it("answers with a null FMV and a named reason when the fan-out aborts", async () => {
    catalogQuery.mockReturnValue(abortingFetchAll());

    const res = await post(2021);

    expect(res.status).toBe(200);
    expect(res.body.fairMarketValue).toBeNull();
    // A withheld price is null PLUS a visible reason — never a bare null,
    // which is the outage shape the smoke reports as unreasoned.
    expect(res.body.canonicalFmvWithheld?.reason).toBe("catalog-lookup-timeout");
    expect(typeof res.body.verdict).toBe("string");
    expect(res.body.verdict.length).toBeGreaterThan(0);
  });

  it("does NOT fall through to computeEstimate on a deadline", async () => {
    catalogQuery.mockReturnValue(abortingFetchAll());

    await post(2020);

    // This is the load-bearing half. A deadline that fell through would spend
    // the ENTIRE CH-dependent computeEstimate ladder after the budget was
    // already gone — which is how a slow request became a 240 s one.
    expect(computeEstimate).not.toHaveBeenCalled();
  });

  it("a genuine lookup fault still falls through to the estimator", async () => {
    catalogQuery.mockReturnValue({
      fetchAll: async () => { throw new Error("Bad Request: syntax error in SQL"); },
    });

    const res = await post(2019);

    // MUTATION CHECK: a real Cosmos fault is NOT a deadline. Treating every
    // error as withheld would silently retire the fall-through path and turn
    // ordinary query bugs into refusals.
    expect(computeEstimate).toHaveBeenCalled();
    expect(res.body.canonicalFmvWithheld?.reason).not.toBe("catalog-lookup-timeout");
  });
});
