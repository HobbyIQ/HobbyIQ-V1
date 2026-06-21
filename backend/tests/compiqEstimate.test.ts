import { beforeAll, vi } from "vitest";
import request from "supertest";

// Post-CF-CARDHEDGE-HARD-CUTOVER: mocks target cardsight.router instead
// of the deleted cardhedge.client. The router's three exports
// (findCompsRouted, getCardSalesRouted, searchCardsRouted) return shapes
// identical to the prior cardhedge.client equivalents -- factory bodies
// port verbatim with only the function names renamed.
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardSalesRouted: vi.fn(async (cardId?: string) => {
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
        source: "cardsight",
        sale_type: "auction",
        title,
        url: null,
      }));
    }),
    searchCardsRouted: vi.fn(async (query?: string) => {
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
    findCompsRouted: vi.fn(async (query?: string) => {
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
            set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: variant "Orange Wave Auto" + title "Auto" → CPA subset
            year: 2024,
            number: null,
            variant: "Orange Wave Auto",
          };

      const now = Date.now();
      const sales = Array.from({ length: 8 }, (_, i) => ({
        price: 950 + i * 20,
        date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
        grade: "PSA 10",
        source: "cardsight",
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
  };
});

// CF-PAYMENTS-B1: /api/compiq/estimate now requires a session. Mock
// getUserBySession so the existing route-shape assertions still run; use
// pro_seller plan so requireRateLimited short-circuits (unlimited cap).
vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "pro_seller",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

import app from "../src/app";
describe("/api/compiq/estimate", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  it("returns required fields", async () => {
    const res = await request(app).post("/api/compiq/estimate").set("x-session-id", "test-sess").send({
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
    const res = await request(app).post("/api/compiq/estimate").set("x-session-id", "test-sess").send({});
    expect(res.status).toBe(200);
    expect(res.body.cardTitle).toBeDefined();
    // Sparse payload should hit the sufficiency gate and return null FMV
    // with an explanatory dataSufficiency block, or a numeric fallback.
    expect(
      res.body.fairMarketValue === null || typeof res.body.fairMarketValue === "number"
    ).toBe(true);
    if (res.body.fairMarketValue === null) {
      // CF-A(a) 2026-06-20: FMV is also nullable when the T3 base-auto-floor
      // rebucket fires — the dollars live in estimatedValue, dataSufficiency
      // stays sufficient because the pool was anchored. Two valid shapes:
      // (a) insufficiency (legacy) — dataSufficiency.sufficient: false
      // (b) T3 estimate (CF-A(a)) — valuationStatus: "estimated"
      const isT3Estimate =
        res.body.valuationStatus === "estimated" &&
        res.body.estimateBasis === "base_auto_floor";
      if (!isT3Estimate) {
        expect(res.body.dataSufficiency?.sufficient).toBe(false);
      }
    }
  });

  it("does not false-fire mechanism 1 for explicit Base parallel", async () => {
    const res = await request(app).post("/api/compiq/estimate").set("x-session-id", "test-sess").send({
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
