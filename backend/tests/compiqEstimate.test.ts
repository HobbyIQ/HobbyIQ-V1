import { beforeAll, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(async (cardId?: string) => {
    if (!cardId) return [];
    const title =
      cardId === "ohtani-base"
        ? "2018 Topps Chrome Shohei Ohtani #150 PSA 10"
        : "2024 Bowman Chrome Blake Burke PSA 10 Auto";
    const now = Date.now();
    return Array.from({ length: 8 }, (_, i) => ({
      price: 950 + i * 20,
      date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
      grade: "PSA 10",
      source: "card_hedge",
      sale_type: "auction",
      title,
      url: null,
    }));
  }),
  searchCards: vi.fn(async (query?: string) => {
    const q = (query ?? "").toLowerCase();
    if (!q) return [];
    if (q.includes("ohtani")) {
      return [
        {
          card_id: "ohtani-base",
          title: "2018 Topps Chrome Shohei Ohtani #150 PSA 10",
          player: "Shohei Ohtani",
        },
      ];
    }
    return [
      {
        card_id: "blake-burke",
        title: "2024 Bowman Chrome Blake Burke PSA 10 Auto",
        player: "Blake Burke",
      },
    ];
  }),
  findCompsByQuery: vi.fn(async (query?: string) => {
    const isOhtani = (query ?? "").toLowerCase().includes("ohtani");
    const card = isOhtani
      ? {
          card_id: "ohtani-base",
          title: "2018 Topps Chrome Shohei Ohtani #150 PSA 10",
          player: "Shohei Ohtani",
          set: "Topps Chrome",
          year: 2018,
          number: "150",
          variant: "Base",
        }
      : {
          card_id: "blake-burke",
          title: "2024 Bowman Chrome Blake Burke PSA 10 Auto",
          player: "Blake Burke",
          set: "Bowman Chrome",
          year: 2024,
          number: null,
          variant: "Orange Wave Auto",
        };

    const now = Date.now();
    const sales = Array.from({ length: 8 }, (_, i) => ({
      price: 950 + i * 20,
      date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
      grade: "PSA 10",
      source: "card_hedge",
      sale_type: "auction",
      title: card.title,
      url: null,
    }));

    return {
      card,
      sales,
      variantWarning: [],
      aiCategory: "Baseball",
    };
  }),
}));

import app from "../src/app";
describe("/api/compiq/estimate", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

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

  it("does not false-fire mechanism 1 for explicit Base parallel", async () => {
    const res = await request(app).post("/api/compiq/estimate").send({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Base",
      gradeCompany: "PSA",
      gradeValue: 10
    });

    expect(res.status).toBe(200);
    expect(res.body.failureReason).not.toBe("uncurated-subject-parallel");
    expect(res.body.mechanism).not.toBe("multiplier-anchored");
    expect(typeof res.body.compsUsed).toBe("number");
    expect(res.body.compsUsed).toBeGreaterThan(0);
    expect(typeof res.body.estimate).toBe("number");
    expect(res.body.estimate).toBeGreaterThan(0);
  });
});
