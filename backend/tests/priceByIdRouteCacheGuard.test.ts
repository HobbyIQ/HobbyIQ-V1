// CF-ROUTE-CACHE-VALIDATION (2026-06-08): read-time validator on the
// /api/compiq/price-by-id route cache.
//
// The route memoizes the FULL response (cardIdentity, marketTier,
// recentComps, etc.) for 15 min via cacheWrap. The upstream consistency
// guard in fetchComps fires only on cache MISS (when computeEstimate
// actually runs). A poisoned route entry written during a vendor flap
// (Cardsight returning a different card under the requested id) would
// replay for the full TTL — every served response cached and never
// re-validated.
//
// This file pins the new route-level validator: after cacheWrap returns,
// assert response.cardIdentity.card_id === requested cardId.
// On mismatch: bust the entry, recompute ONCE via the direct producer
// (bypassing cacheWrap), and either cache the corrected result OR — if
// fresh recompute is STILL mismatched — return the unresolved shape and
// refuse to re-cache.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

// Per-test injection: cacheGet returns either Frazier-shaped (poisoned)
// payload or null. cacheSet / cacheDel are tracked so the test can assert
// the bust + re-cache flow.
let cacheGetReturn: any = null;
const cacheDelCalls: string[] = [];
const cacheSetCalls: Array<{ key: string; value: string; ttl: number }> = [];

vi.mock("../src/services/shared/cache.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    // cacheWrap is invoked inside the route at line 912; we intercept it
    // to simulate a cache HIT with the poisoned payload (case 1+2).
    cacheWrap: vi.fn(async (_key: string, fn: () => Promise<any>) => {
      if (cacheGetReturn) return cacheGetReturn;
      return await fn();
    }),
    cacheDel: vi.fn(async (key: string) => { cacheDelCalls.push(key); }),
    cacheSet: vi.fn(async (key: string, value: string, ttl: number) => {
      cacheSetCalls.push({ key, value, ttl });
    }),
  };
});

// Authenticated as a free-tier user with the daily price-check cap
// available — bypass requireRateLimited's count read by stubbing usage.
let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

// Mock computeEstimate so we can drive the recompute path's identity
// independently. `computeEstimateReturn` is the est object the producer
// invokes computeEstimate to get.
let computeEstimateReturn: any = null;
let computeEstimateCallCount = 0;
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    computeEstimate: vi.fn(async () => {
      computeEstimateCallCount += 1;
      return computeEstimateReturn;
    }),
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

const TROUT_ID = "fda530ab-e925-460e-ab88-63199ef975e9";
const FRAZIER_ID = "96dabacb-419f-449b-a532-c8d4fc1cd991";

// Build a route-response-shape payload that LOOKS like what
// producePriceByIdResponse would return for the given cardIdentity. The
// route's validator reads cardIdentity.card_id off the top of the
// response — the rest of the shape is rounded out so iOS sees a coherent
// response if it ever leaked.
function buildRouteResponseShape(opts: {
  cardIdentityCardId: string;
  player?: string;
  number?: string;
  fmv?: number;
  compsUsed?: number;
}) {
  return {
    success: true,
    cardId: TROUT_ID, // route echoes the REQUESTED id verbatim
    summary: "ok",
    marketTier: { value: opts.fmv ?? 1, high: opts.fmv ?? 1 },
    buyZone: [null, null],
    holdZone: [null, null],
    sellZone: [null, null],
    fairMarketValueLive: opts.fmv ?? 1,
    marketValue: opts.fmv ?? 1,
    predictedPrice: null,
    predictedPriceRange: null,
    predictedPriceAttribution: null,
    trendIQ: null,
    signalsLastUpdated: null,
    confidence: 0,
    approximate: false,
    outOfScopeReason: null,
    source: "live",
    trendAnalysis: { market_direction: "flat", change_from_older_to_recent: null, liquidity: "Normal", broaderTrend: null },
    recentComps: [],
    cardIdentity: {
      card_id: opts.cardIdentityCardId,
      title: opts.player ?? null,
      player: opts.player ?? null,
      set: "Base Set",
      year: 2011,
      number: opts.number ?? null,
      variant: null,
    },
    gradeUsed: null,
    compsUsed: opts.compsUsed ?? 0,
    compsAvailable: opts.compsUsed ?? 0,
    daysSinceNewestComp: null,
    broaderTrend: null,
  };
}

// Build a computeEstimate `est` whose .cardIdentity.card_id is what the
// downstream route response will surface (line 1027:
// `cardIdentity: (est as any).cardIdentity ?? null`).
function buildEstWithIdentity(cardId: string, player: string, number: string) {
  return {
    fairMarketValue: 377,
    quickSaleValue: 332,
    premiumValue: 433,
    marketDNA: { trend: "flat", speed: "Normal" },
    confidence: { pricingConfidence: 80 },
    verdict: "Hold",
    source: "live",
    cardIdentity: {
      card_id: cardId,
      title: player,
      player,
      set: "Base Set",
      year: 2011,
      number,
      variant: null,
    },
    recentComps: [],
    compsUsed: 20,
    compsAvailable: 26,
    daysSinceNewestComp: 1,
    gradeUsed: "Raw",
  };
}

let app: any;
beforeEach(async () => {
  vi.clearAllMocks();
  cacheGetReturn = null;
  cacheDelCalls.length = 0;
  cacheSetCalls.length = 0;
  computeEstimateReturn = null;
  computeEstimateCallCount = 0;
  currentUser = {
    userId: "u-1", email: "u@t", username: null, fullName: null,
    plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z",
  };
  if (!app) app = (await import("../src/app")).default;
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("CF-ROUTE-CACHE-VALIDATION: poisoned cache → bust + recompute → corrected result", () => {
  it("Frazier-shaped cache HIT + Trout-shaped recompute → client receives Trout, cacheDel called, corrected result re-cached", async () => {
    // (a) The cacheWrap call returns the poisoned Frazier-shaped payload.
    cacheGetReturn = buildRouteResponseShape({
      cardIdentityCardId: FRAZIER_ID,
      player: "Todd Frazier",
      number: "US270",
      fmv: 1,
      compsUsed: 4,
    });
    // (b) The recompute path's computeEstimate returns Trout identity.
    computeEstimateReturn = buildEstWithIdentity(TROUT_ID, "Mike Trout", "US175");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const resp = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "s")
      .send({ cardId: TROUT_ID });

    expect(resp.status).toBe(200);

    // Client must see TROUT — the corrected, recomputed result.
    expect(resp.body.cardIdentity).toBeTruthy();
    expect(resp.body.cardIdentity.card_id).toBe(TROUT_ID);
    expect(resp.body.cardIdentity.player).toBe("Mike Trout");
    expect(resp.body.cardIdentity.number).toBe("US175");
    expect(resp.body.cardId).toBe(TROUT_ID);

    // cacheDel was called on the poisoned routeKey.
    expect(cacheDelCalls.length).toBe(1);
    expect(cacheDelCalls[0]).toMatch(/compiq:price-by-id:v4/);

    // computeEstimate was called for the recompute (the cache HIT
    // shortcuts the producer originally; the validator's direct
    // producer call drives the single recompute).
    expect(computeEstimateCallCount).toBe(1);

    // The corrected result was re-cached under the SAME routeKey for
    // the remainder of the 15-min TTL window.
    expect(cacheSetCalls.length).toBe(1);
    expect(cacheSetCalls[0].key).toMatch(/compiq:price-by-id:v4/);
    const envelope = JSON.parse(cacheSetCalls[0].value);
    expect(envelope._v).toBeDefined();
    expect(envelope._v.cardIdentity.card_id).toBe(TROUT_ID);
    expect(typeof envelope._ts).toBe("number");

    // The mismatch was logged with the subsystem tag so Group B alerts
    // see it.
    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const mismatchLog = lines.find((l) => l.includes("route_cache_card_id_mismatch"));
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog).toContain('"subsystem":"cardsight"');
    expect(mismatchLog).toContain(`"requestedId":"${TROUT_ID}"`);
    expect(mismatchLog).toContain(`"cachedCardId":"${FRAZIER_ID}"`);
    expect(mismatchLog).toContain('"cachedPlayer":"Todd Frazier"');

    errSpy.mockRestore();
  });

  it("Frazier-shaped cache HIT + recompute STILL Frazier-shaped → UNRESOLVED, NOT re-cached, second mismatch logged", async () => {
    // (a) Same poison cache hit as test 1.
    cacheGetReturn = buildRouteResponseShape({
      cardIdentityCardId: FRAZIER_ID,
      player: "Todd Frazier",
      number: "US270",
      fmv: 1,
      compsUsed: 4,
    });
    // (b) But this time the recompute ALSO returns Frazier — vendor
    //     hasn't healed yet, or the upstream cs:pricing entry is also
    //     poisoned. Client must NOT see Frazier; must receive UNRESOLVED.
    computeEstimateReturn = buildEstWithIdentity(FRAZIER_ID, "Todd Frazier", "US270");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const resp = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "s")
      .send({ cardId: TROUT_ID });

    expect(resp.status).toBe(200);

    // Unresolved shape: no FMV, no comps, stub identity keyed on REQUESTED
    // id (NOT Frazier's). The "couldn't price" UI renders.
    expect(resp.body.cardId).toBe(TROUT_ID);
    expect(resp.body.marketTier).toEqual({ value: null, high: null });
    expect(resp.body.marketValue).toBeNull();
    expect(resp.body.compsUsed).toBe(0);
    expect(resp.body.source).toBe("unresolved");

    expect(resp.body.cardIdentity).toBeTruthy();
    expect(resp.body.cardIdentity.card_id).toBe(TROUT_ID);
    expect(resp.body.cardIdentity.player).toBeNull();
    expect(resp.body.cardIdentity.number).toBeNull();

    // cacheDel was called to bust the poisoned entry.
    expect(cacheDelCalls.length).toBe(1);

    // computeEstimate was called once (the single recompute attempt).
    expect(computeEstimateCallCount).toBe(1);

    // The unresolved result is NOT re-cached — would re-poison the key.
    expect(cacheSetCalls.length).toBe(0);

    // Both mismatch events were logged: the initial detect + the
    // post-recompute still-mismatched outcome.
    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(lines.some((l) => l.includes("route_cache_card_id_mismatch"))).toBe(true);
    const stillLog = lines.find((l) => l.includes("route_cache_recompute_still_mismatched"));
    expect(stillLog).toBeDefined();
    expect(stillLog).toContain('"subsystem":"cardsight"');
    expect(stillLog).toContain(`"requestedId":"${TROUT_ID}"`);
    expect(stillLog).toContain(`"recomputedCardId":"${FRAZIER_ID}"`);

    errSpy.mockRestore();
  });

  it("clean cache HIT (cardIdentity.card_id === requested) → validator does NOT fire; result served as-is, no re-cache", async () => {
    cacheGetReturn = buildRouteResponseShape({
      cardIdentityCardId: TROUT_ID,
      player: "Mike Trout",
      number: "US175",
      fmv: 377,
      compsUsed: 20,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const resp = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "s")
      .send({ cardId: TROUT_ID });

    expect(resp.status).toBe(200);
    expect(resp.body.cardIdentity.card_id).toBe(TROUT_ID);
    expect(resp.body.cardIdentity.player).toBe("Mike Trout");

    // No bust, no recompute, no re-cache.
    expect(cacheDelCalls.length).toBe(0);
    expect(computeEstimateCallCount).toBe(0);
    expect(cacheSetCalls.length).toBe(0);

    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(lines.find((l) => l.includes("route_cache_card_id_mismatch"))).toBeUndefined();

    errSpy.mockRestore();
  });
});
