// CF-TRENDIQ-SURFACES (2026-06-03) — gate + payload coverage.
//
// Validates the two new endpoints from STEP 2:
//   POST /api/compiq/trendiq        investor+ (trendIQComposite)
//   POST /api/compiq/trendiq/full   pro_seller (trendIQLayer3Full)
//
// Each: 401 no session, 402 for ineligible tiers, 200 for eligible tiers.
// /full additionally: TOS hedge (TRENDIQ_FULL_RAW_SALES_DISABLED) strips
// raw pre/post sales rows. /trendiq additionally: same-call cache hit
// dedups computeEstimate (the route-level 15-min cacheWrap).
//
// The composite-unchanged GUARDRAIL (the additive refactor preserves
// SegmentTrajectoryComponent byte-for-byte) is asserted in
// trendIQ.compute.test.ts, not here.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SegmentTrajectoryFull } from "../src/services/compiq/trendIQ.types.js";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) {
  currentUser = u;
}

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

const computeEstimateMock = vi.fn();

vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    computeEstimate: (...args: unknown[]) => computeEstimateMock(...args),
  };
});

import { __resetMemoryCacheForTest } from "../src/services/shared/cache.service.js";

const FIXTURE_TRENDIQ = {
  composite: 1.18,
  direction: "up" as const,
  impliedPct: 18.0,
  lastUpdated: "2026-06-01T12:00:00.000Z",
  components: {
    playerMomentum: {
      multiplier: 1.1,
      flags: ["trends_spike"],
      componentSignals: { trends: 0.07 },
      lastUpdated: "2026-06-01T12:00:00.000Z",
      sourceUrl: "https://fn-compiq/x",
    },
    cardTrajectory: {
      multiplier: 1.2,
      pctChange: 20,
      recentMedian: 120,
      olderMedian: 100,
      recentCount: 5,
      olderCount: 6,
      windowRecentDays: 14,
      windowOlderDays: 30,
    },
    segmentTrajectory: {
      multiplier: 1.2,
      pctChange: 20,
      effectiveAnchorDate: "2026-04-25T00:00:00.000Z",
      originalAnchorDate: "2026-04-25T00:00:00.000Z",
      windowDays: 60,
      preAnchorMedian: 100,
      postAnchorMedian: 120,
      preAnchorCount: 3,
      postAnchorCount: 4,
      siblingsScanned: 5,
      totalSamples: 20,
    },
  },
  weights: { playerMomentum: 0.2, cardTrajectory: 0.4, segmentTrajectory: 0.4 },
  coverage: "full" as const,
};

const FIXTURE_SEGMENT_FULL: SegmentTrajectoryFull = {
  siblingCardIds: ["sib-1", "sib-2", "sib-3", "sib-4", "sib-5"],
  reanchorApplied: false,
  effectiveAnchorDate: "2026-04-25T00:00:00.000Z",
  originalAnchorDate: "2026-04-25T00:00:00.000Z",
  preAnchorSales: [
    { price: 95, ts: 1714000000000 },
    { price: 100, ts: 1714200000000 },
    { price: 105, ts: 1714400000000 },
  ],
  postAnchorSales: [
    { price: 115, ts: 1715000000000 },
    { price: 120, ts: 1715200000000 },
    { price: 125, ts: 1715400000000 },
    { price: 122, ts: 1715600000000 },
  ],
  perWindow: {
    pre: { mean: 100, p25: 97.5, p75: 102.5 },
    post: { mean: 120.5, p25: 118.75, p75: 122.75 },
  },
};

function makeUser(plan: string) {
  return {
    userId: `u-${plan}`,
    email: `${plan}@t`,
    username: null,
    fullName: null,
    plan,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const CARD_ID = "00000000-1111-2222-3333-444455556666";
const VALID_BODY = { cardsightCardId: CARD_ID };

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  computeEstimateMock.mockReset();
  __resetMemoryCacheForTest();
  // Default mock: minimal est with the fixture trendIQ field.
  computeEstimateMock.mockImplementation(async (_body, _ctx, options) => {
    // For /full path: invoke the capture hook with the fixture rows.
    if (options && typeof options.captureSegmentTrajectoryFull === "function") {
      options.captureSegmentTrajectoryFull(FIXTURE_SEGMENT_FULL);
    }
    return {
      trendIQ: FIXTURE_TRENDIQ,
      signalsLastUpdated: FIXTURE_TRENDIQ.lastUpdated,
      cardIdentity: { card_id: CARD_ID, player: "Test Player" },
      gradeUsed: "PSA 10",
      source: "live",
      fairMarketValue: 120,
      verdict: "Hold",
    };
  });
  delete process.env.TRENDIQ_FULL_RAW_SALES_DISABLED;
});

afterEach(() => {
  delete process.env.TRENDIQ_FULL_RAW_SALES_DISABLED;
});

// ─── /api/compiq/trendiq — investor+ composite ─────────────────────────────

describe("POST /api/compiq/trendiq (trendIQComposite, investor+)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app).post("/api/compiq/trendiq").send(VALID_BODY);
    expect(r.status).toBe(401);
  });

  it("402 for free (lacks trendIQComposite)", async () => {
    setUser(makeUser("free"));
    const r = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(402);
    expect(r.body.feature).toBe("trendIQComposite");
    expect(r.body.requiredTier).toBe("investor");
  });

  it("402 for collector (lacks trendIQComposite)", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(402);
    expect(r.body.requiredTier).toBe("investor");
  });

  it("investor passes the gate and receives trendiq-only payload", async () => {
    setUser(makeUser("investor"));
    const r = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.cardsightCardId).toBe(CARD_ID);
    expect(r.body.trendIQ.composite).toBe(1.18);
    expect(r.body.trendIQ.coverage).toBe("full");
    expect(r.body.signalsLastUpdated).toBe(FIXTURE_TRENDIQ.lastUpdated);
    expect(r.body.cardIdentity?.card_id).toBe(CARD_ID);
    expect(r.body.gradeUsed).toBe("PSA 10");
    // Payload is trendiq-only — NO FMV / verdict / fields from /price-by-id.
    expect(r.body.fairMarketValue).toBeUndefined();
    expect(r.body.verdict).toBeUndefined();
    expect(r.body.predictedPrice).toBeUndefined();
    // /trendiq does NOT include /full data.
    expect(r.body.segmentTrajectoryFull).toBeUndefined();
  });

  it("pro_seller passes the gate", async () => {
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    expect(r.body.trendIQ.composite).toBe(1.18);
  });

  it("400 when cardsightCardId missing", async () => {
    setUser(makeUser("investor"));
    const r = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cardsightCardId/);
  });

  it("cacheWrap dedups: two back-to-back calls invoke computeEstimate once", async () => {
    setUser(makeUser("investor"));
    const r1 = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post("/api/compiq/trendiq")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r2.status).toBe(200);
    expect(computeEstimateMock).toHaveBeenCalledTimes(1);
  });
});

// ─── /api/compiq/trendiq/full — pro_seller composite + L3 raw ──────────────

describe("POST /api/compiq/trendiq/full (trendIQLayer3Full, pro_seller)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app).post("/api/compiq/trendiq/full").send(VALID_BODY);
    expect(r.status).toBe(401);
  });

  it("402 for free", async () => {
    setUser(makeUser("free"));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(402);
    expect(r.body.feature).toBe("trendIQLayer3Full");
    expect(r.body.requiredTier).toBe("pro_seller");
  });

  it("402 for collector", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(402);
    expect(r.body.requiredTier).toBe("pro_seller");
  });

  it("402 for investor (composite-only tier; cannot see L3 raw)", async () => {
    setUser(makeUser("investor"));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(402);
    expect(r.body.feature).toBe("trendIQLayer3Full");
    expect(r.body.requiredTier).toBe("pro_seller");
  });

  it("pro_seller passes the gate and receives full payload (raw rows present)", async () => {
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.trendIQ.composite).toBe(1.18);
    expect(r.body.segmentTrajectoryFull).toBeDefined();
    expect(r.body.segmentTrajectoryFull.siblingCardIds).toHaveLength(5);
    expect(r.body.segmentTrajectoryFull.reanchorApplied).toBe(false);
    expect(r.body.segmentTrajectoryFull.preAnchorSales).toHaveLength(3);
    expect(r.body.segmentTrajectoryFull.postAnchorSales).toHaveLength(4);
    expect(r.body.segmentTrajectoryFull.perWindow.pre.mean).toBe(100);
    expect(r.body.segmentTrajectoryFull.perWindow.post.mean).toBe(120.5);
    expect(r.body.segmentTrajectoryFull.rawSalesOmitted).toBeUndefined();
  });

  it("TOS hedge: TRENDIQ_FULL_RAW_SALES_DISABLED=1 strips raw sales rows", async () => {
    process.env.TRENDIQ_FULL_RAW_SALES_DISABLED = "1";
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    expect(r.body.segmentTrajectoryFull.rawSalesOmitted).toBe(true);
    expect(r.body.segmentTrajectoryFull.preAnchorSales).toBeUndefined();
    expect(r.body.segmentTrajectoryFull.postAnchorSales).toBeUndefined();
    // Non-raw fields still present.
    expect(r.body.segmentTrajectoryFull.siblingCardIds).toHaveLength(5);
    expect(r.body.segmentTrajectoryFull.perWindow.pre.mean).toBe(100);
    expect(r.body.segmentTrajectoryFull.perWindow.post.mean).toBe(120.5);
  });

  it("400 when cardsightCardId missing", async () => {
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cardsightCardId/);
  });

  it("segmentTrajectoryFull = null when capture hook never fires (sparse pool path)", async () => {
    setUser(makeUser("pro_seller"));
    // Override: no capture hook invocation.
    computeEstimateMock.mockImplementationOnce(async () => ({
      trendIQ: FIXTURE_TRENDIQ,
      signalsLastUpdated: FIXTURE_TRENDIQ.lastUpdated,
      cardIdentity: null,
      gradeUsed: null,
      source: "live",
    }));
    const r = await request(app)
      .post("/api/compiq/trendiq/full")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    expect(r.body.segmentTrajectoryFull).toBeNull();
  });
});
