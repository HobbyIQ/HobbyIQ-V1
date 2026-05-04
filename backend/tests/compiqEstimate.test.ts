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
    expect(res.body.fairMarketValue).toBeGreaterThan(0);
    expect(res.body.quickSaleValue).toBeLessThanOrEqual(res.body.fairMarketValue);
    expect(res.body.premiumValue).toBeGreaterThanOrEqual(res.body.fairMarketValue);
    expect(res.body.dealScore).toBeGreaterThanOrEqual(0);
    expect(res.body.dealScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(res.body.explanation)).toBe(true);
  });

  it("returns valid fallback for sparse payload", async () => {
    const res = await request(app).post("/api/compiq/estimate").send({});
    expect(res.status).toBe(200);
    expect(res.body.cardTitle).toBeDefined();
    expect(res.body.fairMarketValue).toBeGreaterThan(0);
  });
});
