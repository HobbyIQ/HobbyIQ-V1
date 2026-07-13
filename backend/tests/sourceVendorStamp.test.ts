// CF-SOURCE-VENDOR (2026-07-13) — verify every priced holding write path
// stamps sourceVendor + sourceVendorUpdatedAt. Foundation for multi-vendor
// pricing (Cardsight + eBay-direct).

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const r = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

describe("sourceVendor stamped on priced holdings", () => {
  it("wire shape surfaces sourceVendor + sourceVendorUpdatedAt (nil-safe for unpriced legacy)", async () => {
    const session = await signIn();
    // Seed a holding without sourceVendor — legacy shape
    await request(app).post("/api/portfolio/holdings").set("x-session-id", session).send({
      id: "vendor-legacy",
      playerName: "Legacy Test",
      cardYear: 2020,
      product: "Legacy Set",
      cardNumber: "1",
      quantity: 1,
      purchasePrice: 50,
      totalCostBasis: 50,
      isAuto: false,
    });

    const r = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const h = r.body.holdings.find((x: any) => x.id === "vendor-legacy");
    expect(h).toBeTruthy();
    // Legacy holdings surface undefined/null for sourceVendor — no bogus
    // "cardhedge" stamp when engine hasn't priced.
    expect(h.sourceVendor === undefined || h.sourceVendor === null).toBe(true);
    expect(h.sourceVendorUpdatedAt === undefined || h.sourceVendorUpdatedAt === null).toBe(true);
  });

  it("wire shape passes through sourceVendor when set (mock engine wrote 'cardhedge')", async () => {
    const session = await signIn();
    // Seed a holding with explicit sourceVendor — simulating a post-price shape
    await request(app).post("/api/portfolio/holdings").set("x-session-id", session).send({
      id: "vendor-ch-priced",
      playerName: "Priced Test",
      cardYear: 2020,
      product: "Priced Set",
      cardNumber: "2",
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
      isAuto: false,
    });

    // Direct PATCH to inject the vendor field (simulating the engine write
    // path stamping after a CH-sourced price landed)
    const p = await request(app)
      .patch("/api/portfolio/holdings/vendor-ch-priced")
      .set("x-session-id", session)
      .send({
        sourceVendor: "cardhedge",
        sourceVendorUpdatedAt: "2026-07-13T12:00:00Z",
      });
    expect(p.status).toBe(200);

    const r = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const h = r.body.holdings.find((x: any) => x.id === "vendor-ch-priced");
    expect(h.sourceVendor).toBe("cardhedge");
    expect(h.sourceVendorUpdatedAt).toBe("2026-07-13T12:00:00Z");
  });

  it("sourceVendor accepts all 4 canonical values on write", async () => {
    const session = await signIn();
    const canonical = ["cardhedge", "cardsight", "ebay", "manual"] as const;
    for (const vendor of canonical) {
      const id = `vendor-${vendor}`;
      await request(app).post("/api/portfolio/holdings").set("x-session-id", session).send({
        id,
        playerName: `Test ${vendor}`,
        cardYear: 2020,
        product: "Test Set",
        cardNumber: vendor,
        quantity: 1,
        purchasePrice: 100,
        totalCostBasis: 100,
        isAuto: false,
        sourceVendor: vendor,
        sourceVendorUpdatedAt: new Date().toISOString(),
      });
      const r = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
      const h = r.body.holdings.find((x: any) => x.id === id);
      expect(h.sourceVendor).toBe(vendor);
    }
  });
});
