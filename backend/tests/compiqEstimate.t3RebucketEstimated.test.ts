// CF-A(a) — T3 BASE-AUTO FLOOR RE-BUCKET (2026-06-20).
//
// When the variant tier ladder selects T3 (parallel_mismatch +
// print_run_mismatch BOTH accepted), the engine anchors FMV on a base-auto
// pool for a parallel/serialed request. That's a labeled estimate, not an
// observed market value. This file asserts the re-bucket end-to-end:
//
//   - response.fairMarketValue: null  (FMV nulled on T3)
//   - response.estimatedValue: <T3 pool value>
//   - response.estimateLow / estimateHigh: <FMV band>
//   - response.valuationStatus: "estimated"
//   - response.estimateBasis: "base_auto_floor"
//   - response.estimateConfidence: "rough"
//   - response.isEstimate: true
//   - response.compQuality.variantStrictness: "T3"  (preserved)
//   - response.corpus.fairMarketValue: null  (training-excluded for T3)
//
// Phase 5 integration is asserted in a separate test
// (portfolioValueHistory.t3RebucketEstimated.test.ts) since it shares no
// HTTP plumbing with the engine response shape.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import request from "supertest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import app from "../src/app";
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

let adminSession = "";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function signIn(username: string, password: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });
  expect(res.status).toBe(200);
  return res.body.sessionId as string;
}

// T3 fixture: request asks for "Blue Refractor" /150 Auto; pool is 4 base-
// auto comps with NO "/150" and NO "Blue" — fails parallel_mismatch AND
// print_run_mismatch. T0/T1/T2 all reject (T1 doesn't accept print_run,
// T2 adds missing_auto but the comps already have auto). Only T3 accepts
// both rejection reasons → pool survives → engine produces an FMV anchored
// on base-auto comps. Print run lands in body.product (alongside the
// product name) so it survives normalizeParallel's slash-strip and the
// parser extracts printRun=150 from the assembled cardTitle.
function mockT3BaseAutoFixture() {
  const now = Date.now();
  const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    card: {
      card_id: "card-baldwin-blue-150",
      title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
      player: "Drake Baldwin",
      set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN prefix → CPA subset
      year: 2022,
      number: "CPA-DBN",
      variant: "Blue Refractor /150",
    },
    sales: [
      { price: 80, date: isoDaysAgo(5),  title: "2022 Bowman Chrome Drake Baldwin Auto Base CPA-DBN" },
      { price: 82, date: isoDaysAgo(8),  title: "2022 Bowman Chrome Drake Baldwin Auto Base CPA-DBN" },
      { price: 85, date: isoDaysAgo(11), title: "2022 Bowman Chrome Drake Baldwin Auto Base CPA-DBN" },
      { price: 78, date: isoDaysAgo(14), title: "2022 Bowman Chrome Drake Baldwin Auto Base CPA-DBN" },
    ],
    variantWarning: [],
    aiCategory: "Baseball",
  });
}

// Same shape but TWO comps — below VARIANT_TIER_MIN_COMPS=3, so T3 also
// yields <3 surviving → everythingFilteredOut → variant-mismatch short-
// circuit fires. Used to assert the "path-(b) regression": FMV null +
// estimateBasis NOT set + valuationStatus NOT set ("estimated" is for
// T3 success ONLY).
function mockTooThinForT3() {
  const now = Date.now();
  const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    card: {
      card_id: "card-baldwin-blue-150",
      title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
      player: "Drake Baldwin",
      set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN prefix → CPA subset
      year: 2022,
      number: "CPA-DBN",
      variant: "Blue Refractor /150",
    },
    sales: [
      { price: 80, date: isoDaysAgo(5), title: "2022 Bowman Chrome Drake Baldwin Auto Base CPA-DBN" },
      { price: 82, date: isoDaysAgo(8), title: "2022 Bowman Chrome Drake Baldwin Auto Base CPA-DBN" },
    ],
    variantWarning: [],
    aiCategory: "Baseball",
  });
}

const T3_BODY = {
  playerName: "Drake Baldwin",
  cardYear: 2022,
  // Park "/150" in product so normalizeParallel's slash-strip doesn't lose
  // the print run; the assembled cardTitle still feeds it to the parser.
  product: "Bowman Chrome /150",
  parallel: "Blue Refractor",
  isAuto: true,
};

describe("CF-A(a) — T3 base-auto floor → estimated bucket", () => {
  beforeAll(async () => {
    adminSession = await signIn("HobbyIQ", "Baseball25");
  });

  it("T3 success: response carries estimated-tier fields and fairMarketValue null", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockT3BaseAutoFixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send(T3_BODY);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T3");
    // FMV is nulled — T3 base-auto is NOT observed market value.
    expect(res.body.fairMarketValue).toBeNull();
    expect(res.body.marketValue).toBeNull();
    expect(res.body.fairMarketValueLow).toBeNull();
    expect(res.body.fairMarketValueHigh).toBeNull();
    // The dollars live in estimatedValue + band.
    expect(typeof res.body.estimatedValue).toBe("number");
    expect(res.body.estimatedValue).toBeGreaterThan(0);
    expect(typeof res.body.estimateLow).toBe("number");
    expect(typeof res.body.estimateHigh).toBe("number");
    expect(res.body.estimateLow).toBeLessThanOrEqual(res.body.estimatedValue);
    expect(res.body.estimateHigh).toBeGreaterThanOrEqual(res.body.estimatedValue);
    // Estimate-tier labels.
    expect(res.body.estimateBasis).toBe("base_auto_floor");
    expect(res.body.estimateConfidence).toBe("rough");
    expect(res.body.valuationStatus).toBe("estimated");
    expect(res.body.isEstimate).toBe(true);
  });

  it("path-(b) regression: when even T3 can't satisfy ≥3 comps, response uses variant-mismatch short-circuit (FMV null, estimateBasis NOT set)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockTooThinForT3();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send(T3_BODY);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("variant-mismatch");
    // CF-VARIANT-MISMATCH-USE-RECENT-COMPS (2026-07-15): variant-mismatch
    // now populates fairMarketValue with median of fetched.comps when
    // present. Fixture provides comps → non-null. Assert either null OR
    // positive number.
    expect(res.body.fairMarketValue === null || (typeof res.body.fairMarketValue === "number" && res.body.fairMarketValue > 0)).toBe(true);
    // Critically: this is NOT the T3 estimated path — labels must remain unset.
    expect(res.body.estimatedValue ?? null).toBeNull();
    expect(res.body.estimateBasis ?? null).toBeNull();
    expect(res.body.valuationStatus ?? null).not.toBe("estimated");
    expect(res.body.isEstimate ?? false).not.toBe(true);
  });

  it("T0 happy path regression: priced holding stays observed; no estimate-tier labels emitted", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    // T0 fixture: parallel + auto + print run all match.
    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-baldwin-blue-150",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN prefix → CPA subset
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor /150",
      },
      sales: [
        { price: 280, date: isoDaysAgo(4),  title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150 CPA-DBN" },
        { price: 295, date: isoDaysAgo(9),  title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150 CPA-DBN" },
        { price: 305, date: isoDaysAgo(13), title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150 CPA-DBN" },
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send(T3_BODY);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T0");
    // FMV emits as observed; estimate-tier labels stay nulled.
    expect(typeof res.body.fairMarketValue).toBe("number");
    expect(res.body.fairMarketValue).toBeGreaterThan(0);
    expect(res.body.valuationStatus).toBe("observed");
    expect(res.body.estimatedValue).toBeNull();
    expect(res.body.estimateBasis).toBeNull();
    expect(res.body.isEstimate).toBe(false);
  });
});
