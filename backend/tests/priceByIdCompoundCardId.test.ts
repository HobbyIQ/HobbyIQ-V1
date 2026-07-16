// CF-EXPLODE-CARDSIGHT-PARALLELS (Drew, 2026-07-13, PR #413) — verifies
// /api/compiq/price-by-id parses the compound cardId format
// `{parentUUID}::{parallelUUID}` and routes both IDs to the Cardsight
// native price router. Ensures iOS can send exploded-candidate cardIds
// verbatim without any client-side splitting.

import { describe, expect, it, vi, afterEach } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import * as router from "../src/services/compiq/cardsightUuidPriceRouter.js";

async function signIn(): Promise<string> {
  const r = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const PARENT = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const PARALLEL = "334908f4-bf5f-4ed5-98c7-75113561ab55";
const COMPOUND = `${PARENT}::${PARALLEL}`;

const OK_RESPONSE = {
  success: true,
  cardId: PARENT,
  fairMarketValueLive: 1899.99,
  marketValue: 1899.99,
  marketTier: { label: null, value: 1899.99 },
  approximate: true,
  estimateBasis: "1 comp(s) via cardsight",
  predictedPrice: null,
  predictedPriceRange: null,
  predictedPriceAttribution: null,
  trendIQ: null,
  cardIdentity: {
    card_id: PARENT,
    player: "Eric Hartman",
    set: "Chrome Prospects Autographs",
    release: "Bowman",
    year: 2026,
    number: "CPA-EHA",
    parallel: null,
    title: "2026 Bowman Chrome Prospects Autographs Eric Hartman CPA-EHA",
  },
  compsUsed: 1,
  compsAvailable: 1,
  daysSinceNewestComp: 0,
  lastSale: null,
  confidence: 0.2,
  estimateSource: "raw-pool",
  predictedRange: null,
  regime: null,
  regimeConfidence: null,
  recentComps: [],
  priceHistory: null,
  priceSource: "cardsight",
  gradeBreakdown: [],
  gradedEstimates: [],
  nearestGradedAnchor: null,
  recommendation: null,
};

describe("POST /api/compiq/price-by-id — compound cardId parsing", () => {
  it("splits {parent}::{parallel} and threads both to Cardsight native router", async () => {
    const spy = vi.spyOn(router, "priceByCardsightUuid").mockResolvedValue(OK_RESPONSE as any);
    const sid = await signIn();
    const r = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", sid)
      .send({ cardId: COMPOUND });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0][0];
    expect(call.cardId).toBe(PARENT);
    expect(call.parallelId).toBe(PARALLEL);
    expect(r.body.priceSource).toBe("cardsight");
    expect(r.body.fairMarketValueLive).toBe(1899.99);
  });

  it("body-level parallelId still wins when both are present", async () => {
    const spy = vi.spyOn(router, "priceByCardsightUuid").mockResolvedValue(OK_RESPONSE as any);
    const bodyParallel = "b83de312-609d-4d58-af41-c8766a81835f";
    const sid = await signIn();
    await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", sid)
      .send({ cardId: COMPOUND, parallelId: bodyParallel });
    const call = spy.mock.calls[0][0];
    expect(call.cardId).toBe(PARENT);
    expect(call.parallelId).toBe(bodyParallel);
  });

  it("simple UUID cardId (no compound) still routes correctly", async () => {
    const spy = vi.spyOn(router, "priceByCardsightUuid").mockResolvedValue(OK_RESPONSE as any);
    const sid = await signIn();
    await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", sid)
      .send({ cardId: PARENT });
    const call = spy.mock.calls[0][0];
    expect(call.cardId).toBe(PARENT);
    expect(call.parallelId).toBeNull();
  });

  it("compound with malformed halves does NOT hit the Cardsight router", async () => {
    const spy = vi.spyOn(router, "priceByCardsightUuid").mockResolvedValue(OK_RESPONSE as any);
    const sid = await signIn();
    // Not a valid UUID pair — parser skips
    await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", sid)
      .send({ cardId: "not-a-uuid::also-not-a-uuid" });
    expect(spy).not.toHaveBeenCalled();
  });
});
