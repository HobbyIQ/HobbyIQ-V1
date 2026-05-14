import request from "supertest";
import app from "../src/app";
describe("/api/compiq/estimate", () => {
  it("returns required fields", async () => {
    const res = await request(app).post("/api/compiq/estimate").send({
      playerName: "Blake Burke",
      cardYear: 2024,
      product: "Bowman Chrome",
      parallel: "Orange Wave Auto",
      gradeCompany: "PSA",
      gradeValue: 10,
      isAuto: true
    });
    expect(res.status).toBe(200);
    expect(res.body.cardTitle).toBeDefined();
    // fairMarketValue is now nullable: null when data sufficiency gate fails.
    if (res.body.fairMarketValue !== null) {
      expect(typeof res.body.fairMarketValue).toBe("number");
      expect(res.body.fairMarketValue).toBeGreaterThanOrEqual(0);
      expect(res.body.quickSaleValue).toBeLessThanOrEqual(res.body.fairMarketValue);
      expect(res.body.premiumValue).toBeGreaterThanOrEqual(res.body.fairMarketValue);
    } else {
      // When FMV is null the sufficiency gate must explain why.
      expect(res.body.dataSufficiency).toBeDefined();
      expect(res.body.dataSufficiency.sufficient).toBe(false);
      expect(typeof res.body.dataSufficiency.message).toBe("string");
    }
    expect(res.body.dealScore).toBeGreaterThanOrEqual(0);
    expect(res.body.dealScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(res.body.explanation)).toBe(true);
  });

  it("returns valid fallback for sparse payload", async () => {
    const res = await request(app).post("/api/compiq/estimate").send({});
    expect(res.status).toBe(200);
    expect(res.body.cardTitle).toBeDefined();
    // Sparse payload should hit the sufficiency gate and return null FMV
    // with an explanatory dataSufficiency block, or a numeric fallback.
    expect(
      res.body.fairMarketValue === null || typeof res.body.fairMarketValue === "number"
    ).toBe(true);
    if (res.body.fairMarketValue === null) {
      expect(res.body.dataSufficiency?.sufficient).toBe(false);
    }
  });
});
