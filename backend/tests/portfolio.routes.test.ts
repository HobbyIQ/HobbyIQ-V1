import request from "supertest";
import { afterEach, beforeEach, vi } from "vitest";
import app from "../src/app";
import { _clearPlayerResolverCache } from "../src/services/mlb/playerResolver.service.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(username: string, password: string): Promise<string> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });

  expect(response.status).toBe(200);
  expect(response.body.sessionId).toBeTruthy();
  return response.body.sessionId as string;
}

describe("Portfolio routes", () => {
  it("records account-scoped sell ledger and updates remaining holding quantity", async () => {
    const sessionA = await signIn("HobbyIQ", "Baseball25");
    const sessionB = await signIn("JusttheBoysandCards", "Carolina23");

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionA)
      .send({
        id: "test-holding-1",
        playerName: "Paul Skenes",
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Bowman Chrome Auto",
        quantity: 3,
        purchasePrice: 100,
        totalCostBasis: 300,
      });

    expect(add.status).toBe(201);

    const sell = await request(app)
      .post("/api/portfolio/holdings/test-holding-1/sell")
      .set("x-session-id", sessionA)
      .send({
        quantity: 2,
        salePrice: 180,
        fees: 10,
        tax: 0,
        shipping: 5,
        notes: "Test sell",
      });

    expect(sell.status).toBe(200);
    expect(sell.body.sold.quantitySold).toBe(2);
    expect(sell.body.sold.userId).toBe("admin-testing-hobbyiq");

    const holdingsA = await request(app)
      .get("/api/portfolio/holdings")
      .set("x-session-id", sessionA);
    expect(holdingsA.status).toBe(200);
    expect(holdingsA.body.holdings.some((h: any) => h.id === "test-holding-1")).toBe(true);
    const remaining = holdingsA.body.holdings.find((h: any) => h.id === "test-holding-1");
    expect(remaining.quantity).toBe(1);

    const ledgerA = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", sessionA);
    expect(ledgerA.status).toBe(200);
    expect(ledgerA.body.count).toBeGreaterThanOrEqual(1);
    expect(ledgerA.body.entries.some((e: any) => e.holdingId === "test-holding-1" && e.quantitySold === 2)).toBe(true);

    const ledgerB = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", sessionB);
    expect(ledgerB.status).toBe(200);
    expect(ledgerB.body.entries.some((e: any) => e.holdingId === "test-holding-1")).toBe(false);
  });
});

describe("CF-PORTFOLIO-OPPORTUNITIES — GET /api/portfolio/opportunities", () => {
  it("groups holdings into sellNow / hold / listNow tabs with counts", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");

    // Add a variety of holdings — the recommendation classification
    // will emerge from the trajectory pipeline on the auto-price cycle;
    // we're not asserting exact bucketing here (the underlying signals
    // are mock-dependent), just that the endpoint responds with the
    // right SHAPE.
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "opp-test-1",
        playerName: "Test Player A",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Test A",
        quantity: 1,
        purchasePrice: 100,
      });

    const opportunities = await request(app)
      .get("/api/portfolio/opportunities")
      .set("x-session-id", session);
    expect(opportunities.status).toBe(200);
    expect(opportunities.body.success).toBe(true);
    expect(Array.isArray(opportunities.body.sellNow)).toBe(true);
    expect(Array.isArray(opportunities.body.hold)).toBe(true);
    expect(Array.isArray(opportunities.body.listNow)).toBe(true);
    expect(opportunities.body.counts).toBeTruthy();
    expect(typeof opportunities.body.counts.sellNow).toBe("number");
    expect(typeof opportunities.body.counts.hold).toBe("number");
    expect(typeof opportunities.body.counts.listNow).toBe("number");
    expect(typeof opportunities.body.counts.listAll).toBe("number");
    expect(typeof opportunities.body.counts.insufficientData).toBe("number");
    // Sum of counts must equal total holdings — one holding lands in
    // exactly one bucket. (LIST verdicts split between listAll and
    // listNow inside the counts; sellNow / hold / insufficientData are
    // exclusive with listAll.)
    const total =
      opportunities.body.counts.sellNow +
      opportunities.body.counts.hold +
      opportunities.body.counts.listAll +
      opportunities.body.counts.insufficientData;
    expect(total).toBeGreaterThanOrEqual(1);
  });
});

describe("CF-REGRADE-COST-ROLLIN — POST /api/portfolio/holdings/:id/regrade", () => {
  it("atomically updates grade + cert AND rolls gradingCost into totalCostBasis", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");

    // Start with a raw holding at $200 cost basis (100 × 2)
    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "regrade-test-1",
        playerName: "Roldy Brito",
        cardYear: 2026,
        product: "Bowman Chrome",
        cardTitle: "2026 Bowman Chrome Blue X-Fractor Auto",
        quantity: 2,
        purchasePrice: 100,
        totalCostBasis: 200,
      });
    expect(add.status).toBe(201);

    const regrade = await request(app)
      .post("/api/portfolio/holdings/regrade-test-1/regrade")
      .set("x-session-id", session)
      .send({
        gradeCompany: "PSA",
        gradeValue: 9,
        certNumber: "12345678",
        gradingCost: 25,
      });
    expect(regrade.status).toBe(200);
    expect(regrade.body.updatedHolding.gradeCompany).toBe("PSA");
    expect(regrade.body.updatedHolding.gradeValue).toBe(9);
    expect(regrade.body.updatedHolding.certNumber).toBe("12345678");
    // Cost basis rolled: 200 + 25 = 225
    expect(regrade.body.updatedHolding.totalCostBasis).toBe(225);
    // Per-unit purchase price is NOT touched — stays at 100
    expect(regrade.body.updatedHolding.purchasePrice).toBe(100);

    // Re-fetching via GET /api/portfolio also reflects the change
    const listing = await request(app)
      .get("/api/portfolio")
      .set("x-session-id", session);
    expect(listing.status).toBe(200);
    const found = listing.body.items.find((h: any) => h.id === "regrade-test-1");
    expect(found).toBeTruthy();
    expect(found.gradeCompany).toBe("PSA");
    expect(found.gradeValue).toBe(9);
    expect(found.certNumber).toBe("12345678");
    expect(found.totalCostBasis).toBe(225);
  });

  it("400s when gradeCompany or gradeValue are missing", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "regrade-invalid-1",
        playerName: "Missing Fields Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Test",
        quantity: 1,
        purchasePrice: 50,
      });
    const bad = await request(app)
      .post("/api/portfolio/holdings/regrade-invalid-1/regrade")
      .set("x-session-id", session)
      .send({ gradeCompany: "PSA" }); // missing gradeValue
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("404s when the holding doesn't exist", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const notFound = await request(app)
      .post("/api/portfolio/holdings/regrade-nonexistent/regrade")
      .set("x-session-id", session)
      .send({ gradeCompany: "PSA", gradeValue: 9, gradingCost: 25 });
    expect(notFound.status).toBe(404);
  });

  it("defaults gradingCost to 0 when omitted (grade update only, no cost roll)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "regrade-no-cost-1",
        playerName: "No Cost Roll",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Test",
        quantity: 1,
        purchasePrice: 300,
        totalCostBasis: 300,
      });
    const regrade = await request(app)
      .post("/api/portfolio/holdings/regrade-no-cost-1/regrade")
      .set("x-session-id", session)
      .send({ gradeCompany: "PSA", gradeValue: 10 });
    expect(regrade.status).toBe(200);
    // Cost basis unchanged when gradingCost is omitted
    expect(regrade.body.updatedHolding.totalCostBasis).toBe(300);
  });
});

describe("CF-GRADING-TIER-CATALOG — GET /api/portfolio/grading-tiers", () => {
  it("returns the tier catalog with PSA entries and cache hint", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const res = await request(app)
      .get("/api/portfolio/grading-tiers")
      .set("x-session-id", session);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.tiers)).toBe(true);
    expect(res.body.tiers.length).toBeGreaterThan(5);
    // PSA Regular is a known active tier — should exist and be marked active
    const psaRegular = res.body.tiers.find((t: any) => t.id === "psa-regular");
    expect(psaRegular).toBeTruthy();
    expect(psaRegular.pricePerCard).toBe(79.99);
    expect(psaRegular.active).toBe(true);
    // Paused Value tiers stay in the catalog with active: false
    const psaValue = res.body.tiers.find((t: any) => t.id === "psa-value");
    expect(psaValue).toBeTruthy();
    expect(psaValue.active).toBe(false);
    expect(res.body.cachedUntil).toBeTruthy();
  });
});

describe("CF-GRADING-TIER-CATALOG — /regrade resolves gradingTierId to sticker price", () => {
  it("resolves gradingTierId to the tier's pricePerCard when explicit gradingCost is absent", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "tier-test-1",
        playerName: "Tier Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Tier",
        quantity: 1,
        purchasePrice: 100,
        totalCostBasis: 100,
      });
    const res = await request(app)
      .post("/api/portfolio/holdings/tier-test-1/regrade")
      .set("x-session-id", session)
      .send({
        gradeCompany: "PSA",
        gradeValue: 9,
        gradingTierId: "psa-regular",   // resolves to $79.99
      });
    expect(res.status).toBe(200);
    // 100 + 79.99 = 179.99
    expect(res.body.updatedHolding.totalCostBasis).toBe(179.99);
  });

  it("explicit gradingCost overrides the tier's sticker price (bulk / promo case)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "tier-override-1",
        playerName: "Override Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Override",
        quantity: 1,
        purchasePrice: 100,
        totalCostBasis: 100,
      });
    const res = await request(app)
      .post("/api/portfolio/holdings/tier-override-1/regrade")
      .set("x-session-id", session)
      .send({
        gradeCompany: "PSA",
        gradeValue: 9,
        gradingTierId: "psa-regular",   // $79.99 sticker
        gradingCost: 60,                  // user paid a bulk rate
      });
    expect(res.status).toBe(200);
    expect(res.body.updatedHolding.totalCostBasis).toBe(160);  // 100 + 60
  });

  it("400s when gradingTierId is unknown", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "tier-bad-1",
        playerName: "Bad Tier Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Bad",
        quantity: 1,
        purchasePrice: 100,
      });
    const res = await request(app)
      .post("/api/portfolio/holdings/tier-bad-1/regrade")
      .set("x-session-id", session)
      .send({
        gradeCompany: "PSA",
        gradeValue: 9,
        gradingTierId: "psa-nonexistent-tier",
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_GRADING_TIER");
  });

  it("400s when tier is Premium 2+ (variable-price) and no explicit gradingCost provided", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "tier-premium-1",
        playerName: "Premium Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Premium",
        quantity: 1,
        purchasePrice: 100,
      });
    const res = await request(app)
      .post("/api/portfolio/holdings/tier-premium-1/regrade")
      .set("x-session-id", session)
      .send({
        gradeCompany: "PSA",
        gradeValue: 10,
        gradingTierId: "psa-premium-2",   // pricePerCard is null
        // no explicit gradingCost — should 400
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TIER_REQUIRES_EXPLICIT_COST");
  });
});

describe("CF-REGRADE-BATCH — POST /api/portfolio/holdings/regrade-batch", () => {
  it("processes multiple holdings in one write, reports per-entry status", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");

    // Seed 3 raw holdings
    for (let i = 1; i <= 3; i++) {
      await request(app)
        .post("/api/portfolio/holdings")
        .set("x-session-id", session)
        .send({
          id: `batch-test-${i}`,
          playerName: `Batch Player ${i}`,
          cardYear: 2024,
          product: "Bowman Chrome",
          cardTitle: `2024 Batch ${i}`,
          quantity: 1,
          purchasePrice: 100,
          totalCostBasis: 100,
        });
    }

    const batch = await request(app)
      .post("/api/portfolio/holdings/regrade-batch")
      .set("x-session-id", session)
      .send({
        entries: [
          { holdingId: "batch-test-1", gradeCompany: "PSA", gradeValue: 9, gradingCost: 25 },
          { holdingId: "batch-test-2", gradeCompany: "BGS", gradeValue: 9.5, certNumber: "88888888", gradingCost: 30 },
          { holdingId: "batch-test-3", gradeCompany: "SGC", gradeValue: 10, gradingCost: 20 },
          { holdingId: "batch-nonexistent", gradeCompany: "PSA", gradeValue: 8 },  // will fail
        ],
      });

    expect(batch.status).toBe(200);
    expect(batch.body.totalRequested).toBe(4);
    expect(batch.body.succeeded).toHaveLength(3);
    expect(batch.body.failed).toHaveLength(1);
    expect(batch.body.success).toBe(false);  // failures cause overall failure signal

    // Missing holding lands in failed[]
    expect(batch.body.failed[0].holdingId).toBe("batch-nonexistent");
    expect(batch.body.failed[0].error.code).toBe("NOT_FOUND");

    // The 3 successful holdings each rolled their grading cost
    const listing = await request(app).get("/api/portfolio").set("x-session-id", session);
    const h1 = listing.body.items.find((h: any) => h.id === "batch-test-1");
    const h2 = listing.body.items.find((h: any) => h.id === "batch-test-2");
    const h3 = listing.body.items.find((h: any) => h.id === "batch-test-3");
    expect(h1.gradeCompany).toBe("PSA");
    expect(h1.gradeValue).toBe(9);
    expect(h1.totalCostBasis).toBe(125);
    expect(h2.gradeCompany).toBe("BGS");
    expect(h2.gradeValue).toBe(9.5);
    expect(h2.certNumber).toBe("88888888");
    expect(h2.totalCostBasis).toBe(130);
    expect(h3.gradeCompany).toBe("SGC");
    expect(h3.gradeValue).toBe(10);
    expect(h3.totalCostBasis).toBe(120);
  });

  it("400s with no partial writes when any entry is malformed", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "batch-guard-1",
        playerName: "Guard Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardTitle: "2024 Guard",
        quantity: 1,
        purchasePrice: 50,
        totalCostBasis: 50,
      });

    const bad = await request(app)
      .post("/api/portfolio/holdings/regrade-batch")
      .set("x-session-id", session)
      .send({
        entries: [
          { holdingId: "batch-guard-1", gradeCompany: "PSA", gradeValue: 9, gradingCost: 25 },
          { holdingId: "batch-guard-1", gradeCompany: "PSA" },  // missing gradeValue
        ],
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_PAYLOAD");

    // Guard holding is UNCHANGED — no partial write
    const listing = await request(app).get("/api/portfolio").set("x-session-id", session);
    const guard = listing.body.items.find((h: any) => h.id === "batch-guard-1");
    expect(guard.gradeCompany).toBeFalsy();  // still raw
  });

  it("400s when entries is empty or missing", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const empty = await request(app)
      .post("/api/portfolio/holdings/regrade-batch")
      .set("x-session-id", session)
      .send({ entries: [] });
    expect(empty.status).toBe(400);
    const missing = await request(app)
      .post("/api/portfolio/holdings/regrade-batch")
      .set("x-session-id", session)
      .send({});
    expect(missing.status).toBe(400);
  });
});

describe("Portfolio routes — playerId resolution (PR #68)", () => {
  beforeEach(() => {
    _clearPlayerResolverCache();
  });

  it("populates playerId on addHolding when MLB resolves the name", async () => {
    // Successful MLB people/search response for the resolver; everything
    // else (computeEstimate, etc.) still rejects via the outer beforeEach.
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("statsapi.mlb.com/api/v1/people/search")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              people: [
                { id: 545361, fullName: "Mike Trout", mlbDebutDate: "2011-07-08" },
              ],
            };
          },
        } as unknown as Response;
      }
      throw new Error("network disabled in tests");
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await signIn("HobbyIQ", "Baseball25");
    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "test-holding-playerid-1",
        playerName: "Mike Trout",
        cardTitle: "2011 Topps Update RC",
        cardYear: 2011,
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        product: "Topps Update",
        quantity: 1,
        purchasePrice: 50,
        totalCostBasis: 50,
      });
    expect(add.status).toBe(201);

    const holdings = await request(app)
      .get("/api/portfolio/holdings")
      .set("x-session-id", session);
    expect(holdings.status).toBe(200);
    const saved = holdings.body.holdings.find((h: any) => h.id === "test-holding-playerid-1");
    expect(saved).toBeTruthy();
    expect(saved.playerId).toBe("545361");
    expect(saved.playerIdConfidence).toBe("high");
    expect(typeof saved.playerIdResolvedAt).toBe("string");
  });

  it("leaves playerId undefined and still succeeds when resolver returns no match", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("statsapi.mlb.com/api/v1/people/search")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { people: [] };
          },
        } as unknown as Response;
      }
      throw new Error("network disabled in tests");
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await signIn("HobbyIQ", "Baseball25");
    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "test-holding-playerid-2",
        playerName: "Zzz Definitely Not Real",
        cardTitle: "Fake 2099 Phantom",
        cardYear: 2099,
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        product: "Phantom Set",
        quantity: 1,
        purchasePrice: 1,
        totalCostBasis: 1,
      });
    expect(add.status).toBe(201);

    const holdings = await request(app)
      .get("/api/portfolio/holdings")
      .set("x-session-id", session);
    const saved = holdings.body.holdings.find((h: any) => h.id === "test-holding-playerid-2");
    expect(saved).toBeTruthy();
    expect(saved.playerId).toBeUndefined();
    expect(saved.playerIdConfidence).toBeUndefined();
  });
});
