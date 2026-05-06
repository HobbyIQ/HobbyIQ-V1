import request from "supertest";
import { afterEach, beforeEach, vi } from "vitest";
import app from "../src/app";

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
