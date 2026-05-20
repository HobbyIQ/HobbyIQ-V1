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
        cardTitle: "2024 Bowman Chrome Auto",
        quantity: 3,
        purchasePrice: 100,
        totalCostBasis: 300,
        currentValue: 450,
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
        quantity: 1,
        purchasePrice: 50,
        totalCostBasis: 50,
        currentValue: 100,
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
        quantity: 1,
        purchasePrice: 1,
        totalCostBasis: 1,
        currentValue: 1,
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
