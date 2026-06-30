// CF-REPRICE-PINNED-AUTHORITATIVE-SECOND-SITE (2026-06-17): the original
// pinnedAuthoritative fix patched ONE of two persistence sites. autoPriceHolding
// (add/update/per-holding refresh) got the flag, but repriceHoldingsForUser
// (scheduled job + POST /reprice/batch) did not — so the engine re-resolved
// by sparse identity on every 6h tick and overwrote $331 back to $2.
//
// This file proves the second site now passes cardId +
// pinnedAuthoritative through computeEstimate, with the same default-off
// semantics for unpinned holdings.
//
// Test surface: mock computeEstimate to CAPTURE the body argument, then exercise
// the scheduled-path route POST /api/portfolio/reprice/batch on:
//   (1) a pinned holding (cardId set + sparse identity)        → flag=true, cardId set
//   (2) an unpinned holding (no cardId, full identity)         → flag absent/false, no cardId
//
// Mirrors the pattern in autoPricePersistTrendIQ.test.ts (which exercises BOTH
// persistence sites for trendIQ field plumbing — the same "two persistence
// sites" lesson applies here).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { readUserDoc, writeUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";
// Same freshness-gate / throttle override as autoPricePersistTrendIQ — the
// reprice path defaults to a per-user throttle + a 60s-fresh skip that would
// silently no-op our test holding.
process.env.PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS = "1";
process.env.PORTFOLIO_REPRICE_HTTP_THROTTLE_MS = "1";

const TROUT_2011_PINNED_ID = "fda530ab-e925-460e-ab88-63199ef975e9";
const NOW_ISO_FIXED = "2026-06-17T20:00:00.000Z";

// Module-level mock — both autoPriceHolding (called by addHolding seed)
// AND repriceHoldingsForUser (called by /reprice/batch) see the same fixture.
// We override per-test via mockImplementationOnce when we care about a
// specific call. Captured args are inspected below.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/compiqEstimate.service.js",
  );
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 331,
      premiumValue: 380,
      quickSaleValue: 290,
      marketDNA: { trend: "flat", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 90 },
      source: "live",
      verdict: "Hold",
      action: "Hold",
      compsUsed: 18,
      compsAvailable: 22,
      recentComps: [],
      cardIdentity: { card_id: TROUT_2011_PINNED_ID, year: 2011, release: "Topps Update" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 1,
      variantWarning: [],
      effectiveFmv: 331,
      predictedPrice: 292,
      predictedPriceRange: { low: 270, high: 314 },
      predictedPriceAttribution: { mechanism: "trendiq-projection" },
      signalsLastUpdated: NOW_ISO_FIXED,
    })),
  };
});

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network disabled in tests")),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(res.status).toBe(200);
  expect(res.body.sessionId).toBeTruthy();
  return {
    sessionId: res.body.sessionId as string,
    userId: res.body.user?.userId as string,
  };
}

// Seed a holding directly into the in-memory test-mode store, bypassing
// addHolding so the seed write doesn't call computeEstimate and consume
// captured calls before we get to the reprice site.
async function seedHolding(
  userId: string,
  holdingId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const doc = await readUserDoc(userId);
  doc.holdings[holdingId] = {
    id: holdingId,
    quantity: 1,
    purchasePrice: 250,
    totalCostBasis: 250,
    cardStatus: "active",
    ...fields,
  } as any;
  await writeUserDoc(userId, doc);
}

describe("repriceHoldingsForUser — pinned-authoritative wiring (CF-REPRICE-PINNED-AUTHORITATIVE-SECOND-SITE)", () => {
  it("PINNED holding (cardId + sparse identity): /reprice/batch passes cardId + pinnedAuthoritative=true to computeEstimate", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `pinned-sparse-${Date.now()}`;

    // Seed: cardId set, identity fields ABSENT (the exact Drew Trout
    // shape that surfaced the bug). lastUpdated old enough to pass the
    // PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS=1 gate.
    await seedHolding(userId, holdingId, {
      playerName: "Mike Trout",
      cardId: TROUT_2011_PINNED_ID,
      // intentionally NO cardYear / product / parallel / gradeCompany /
      // gradeValue — the sparse-identity case.
      lastUpdated: "2026-06-17T00:00:00.000Z",
    });

    const compiqEstimateService = await import(
      "../src/services/compiq/compiqEstimate.service.js",
    );
    const mockFn = compiqEstimateService.computeEstimate as unknown as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    const r = await request(app)
      .post("/api/portfolio/reprice/batch")
      .set("x-session-id", sessionId)
      .send({});
    expect(r.status).toBe(200);

    // Sanity: the reprice loop actually called computeEstimate for our holding.
    expect(mockFn).toHaveBeenCalled();
    const calls = mockFn.mock.calls.filter(
      (call: any[]) => call[1]?.holdingId === holdingId,
    );
    expect(
      calls.length,
      `reprice did not call computeEstimate for ${holdingId}; full calls: ${JSON.stringify(mockFn.mock.calls)}`,
    ).toBeGreaterThan(0);

    // The PINNED-AUTHORITATIVE assertion: body must carry the stored
    // cardId AND pinnedAuthoritative=true.
    const [body, callContext] = calls[0];
    expect(body.cardId).toBe(TROUT_2011_PINNED_ID);
    expect(body.pinnedAuthoritative).toBe(true);
    // playerName preserved as REAL (no UUID overload, corpus-clean rule).
    expect(body.playerName).toBe("Mike Trout");
    // Sanity on the context: source/holdingId/userId routed as expected.
    expect(callContext.source).toBe("portfolio-reprice");
    expect(callContext.holdingId).toBe(holdingId);
    expect(callContext.routedFromHolding).toBe(true);
  });

  it("UNPINNED holding (no cardId, full identity): /reprice/batch leaves cardId undefined + pinnedAuthoritative=false (unaffected)", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `unpinned-full-${Date.now()}`;

    // Seed: NO cardId, full identity fields populated. Default-off
    // semantics: flag must NOT fire, gate behaves exactly as today.
    await seedHolding(userId, holdingId, {
      playerName: "Paul Skenes",
      cardYear: 2024,
      product: "Topps Chrome",
      lastUpdated: "2026-06-17T00:00:00.000Z",
    });

    const compiqEstimateService = await import(
      "../src/services/compiq/compiqEstimate.service.js",
    );
    const mockFn = compiqEstimateService.computeEstimate as unknown as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    const r = await request(app)
      .post("/api/portfolio/reprice/batch")
      .set("x-session-id", sessionId)
      .send({});
    expect(r.status).toBe(200);

    const calls = mockFn.mock.calls.filter(
      (call: any[]) => call[1]?.holdingId === holdingId,
    );
    expect(calls.length).toBeGreaterThan(0);

    const [body] = calls[0];
    expect(body.cardId).toBeUndefined();
    expect(body.pinnedAuthoritative).toBe(false);
    expect(body.playerName).toBe("Paul Skenes");
    expect(body.cardYear).toBe(2024);
    expect(body.product).toBe("Topps Chrome");
  });

  // ── CF-IDENTITY-HYDRATION-COMPLETION (2026-06-18) ─────────────────────────
  // The success path is covered by hydrateHoldingIdentityFromEstimate.test
  // .ts (14 cases). This test specifically pins the SKIP-PATH wire — the
  // gap the fcf7c59 canary uncovered. Hartman's variant-mismatch return
  // hits the confidence-gate skip branch in repriceHoldingsForUser, but
  // the engine still returns rich cardIdentity on that branch (verified
  // live before this CF). The hoist makes the patch flow into both
  // writebacks; this test asserts the skip-writeback now applies it.

  const HARTMAN_PINNED_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";

  it("CF-COMPLETION: PINNED holding that takes the confidence-gate SKIP path still hydrates identity from rich cardIdentity (the Hartman case)", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `skip-path-hartman-${Date.now()}`;

    await seedHolding(userId, holdingId, {
      playerName: "Eric Hartman",
      cardId: HARTMAN_PINNED_ID,
      parallel: "Blue X-Fractor /150",                                   // user-entered
      parallelId: "b83de312-609d-4d58-af41-c8766a81835f",                // system-set
      // ALL other identity fields undefined — same as Drew's real
      // Hartman holdings in Cosmos.
      lastUpdated: "2026-06-17T00:00:00.000Z",
    });

    const compiqEstimateService = await import(
      "../src/services/compiq/compiqEstimate.service.js",
    );
    const mockFn = compiqEstimateService.computeEstimate as unknown as ReturnType<typeof vi.fn>;
    // Override the default mock with the Hartman variant-mismatch shape
    // captured live on the deployed dist BEFORE this CF: rich cardIdentity
    // present, but pricing fields all zero / source: "variant-mismatch".
    mockFn.mockImplementationOnce(async () => ({
      // Confidence gate triggers SKIP — all three thresholds fail.
      fairMarketValue: 0,
      compsUsed: 0,
      confidence: { pricingConfidence: 0 },
      source: "variant-mismatch",
      verdict: "No comps found for this exact variant…",
      // CRITICAL: rich cardIdentity even on the skip branch — engine's
      // pinned-id path resolves catalog identity during fetchComps,
      // independent of whether comps survive the variant filter.
      cardIdentity: {
        card_id: HARTMAN_PINNED_ID,
        title: "Eric Hartman",
        player: "Eric Hartman",
        set: "Chrome Prospects Autographs",
        release: "Bowman",
        year: 2026,
        number: "CPA-EHA",
        variant: null,
      },
      premiumValue: 0,
      quickSaleValue: 0,
      compsAvailable: 47,
      recentComps: [],
      variantWarning: [],
      effectiveFmv: 0,
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: { mechanism: "unavailable" },
      signalsLastUpdated: null,
    }));

    const r = await request(app)
      .post("/api/portfolio/reprice/batch")
      .set("x-session-id", sessionId)
      .send({});
    expect(r.status).toBe(200);

    // Sanity: the holding was actually walked AND took the skip branch.
    const targetUpdate = (r.body.updates ?? []).find(
      (u: any) => u.id === holdingId,
    );
    expect(targetUpdate, `reprice did not touch ${holdingId}`).toBeDefined();
    expect(targetUpdate.status).toBe("skipped");
    expect(targetUpdate.reason).toMatch(/variant-mismatch|confidence-gate/);

    // The MAIN assertion: identity fields hydrated even on the skip path.
    const stored = await getHoldingFromStore(userId, holdingId);
    expect(stored).not.toBeNull();
    expect(stored.cardYear).toBe(2026);
    expect(stored.setName).toBe("Chrome Prospects Autographs");
    expect(stored.product).toBe("Bowman");                              // literal release
    expect(stored.cardNumber).toBe("CPA-EHA");
    expect(stored.isAuto).toBe(true);                                   // catalog "Autographs" → heuristic fill

    // Parallel + parallelId verbatim — user-entered NOT clobbered.
    expect(stored.parallel).toBe("Blue X-Fractor /150");
    expect(stored.parallelId).toBe("b83de312-609d-4d58-af41-c8766a81835f");

    // Pricing fields stay un-stamped on the skip path (existing contract).
    // fairMarketValue absent OR untouched at whatever the seed value was.
    expect(stored.fairMarketValue ?? null).toBeNull();

    // Skip-path verdict / recommendation stamped as today.
    expect(stored.verdict).toBe("Variant mismatch");
    expect(stored.recommendation).toBe("Hold");
  });
});

// Test helper imported locally to avoid touching shared imports.
async function getHoldingFromStore(
  userId: string,
  holdingId: string,
): Promise<any | null> {
  const doc = await readUserDoc(userId);
  return doc.holdings[holdingId] ?? null;
}
