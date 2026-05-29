// CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING — verifies the sibling-pool rescue
// branch inside computeEstimate. When direct Cardsight comps fall under the
// thin-data sufficiency threshold AND fetchSiblingSales returns enough sales
// from related cards, the response should:
//
//   - source: "sibling-pool"
//   - verdict: "Estimated from similar cards — variant unverified"
//   - confidence.pricingConfidence: <= 65 (capped per design lock)
//   - fairMarketValue / quickSaleValue / premiumValue all populated as numbers
//   - compsUsed: reflects combined pool (direct + sibling)
//
// Reference: CF-CARDSIGHT-SIBLING-DISCOVERY (e2d5864) for the Approach A
// helper, docs/phase0/cardsight_sibling_discovery_investigation.md for the
// upstream methodology, Phase 1 verification report (2026-05-26) for the
// architectural gap this test guards against regressing.

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";

// Direct comp fetch path: post-CF-CARDHEDGE-HARD-CUTOVER mocks target
// cardsight.router instead of the deleted cardhedge.client. Return a
// valid card identity (so cardIdentity gets populated) but ZERO recent
// sales (forces the thin-data insufficient branch).
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardSalesRouted: vi.fn(async () => []),
    searchCardsRouted: vi.fn(async () => [
      {
        card_id: "exact-card-uuid",
        title: "2024 Bowman Draft Chrome Caleb Bonemer CPA-CBO Auto",
        player: "Caleb Bonemer",
        set: "Bowman Draft Chrome",
        year: 2024,
        number: "CPA-CBO",
        variant: "Chrome Prospect Autograph",
      },
    ]),
    findCompsRouted: vi.fn(async () => ({
      card: {
        card_id: "exact-card-uuid",
        title: "2024 Bowman Draft Chrome Caleb Bonemer CPA-CBO Auto",
        player: "Caleb Bonemer",
        set: "Bowman Draft Chrome",
        year: 2024,
        number: "CPA-CBO",
        variant: "Chrome Prospect Autograph",
      },
      sales: [], // ← thin-data trigger
      variantWarning: [],
      aiCategory: "Baseball",
    })),
  };
});

// Sibling-pool path: fetchCompsByPlayer mock. fetchSiblingSales (the
// imported helper in compiqEstimate) wraps this and excludes the exact
// card_id. Return a healthy sibling pool to exercise the rescue branch.
vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: vi.fn(async () => {
    const now = Date.now();
    return {
      player: "Caleb Bonemer",
      product: "Bowman Draft Chrome",
      cardYear: 2024,
      cardIds: ["sibling-a", "sibling-b", "sibling-c", "exact-card-uuid"],
      comps: Array.from({ length: 12 }, (_, i) => ({
        cardId: i % 3 === 0 ? "sibling-a" : i % 3 === 1 ? "sibling-b" : "sibling-c",
        price: 90 + i * 5,
        date: new Date(now - i * 3 * 24 * 60 * 60 * 1000).toISOString(),
        title: `Comp ${i}`,
        source: "cardsight" as const,
      })),
      cached: false,
      warnings: [],
    };
  }),
}));

import app from "../src/app";

describe("CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING — sibling-pool rescue branch", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  it("rescues thin-data card via sibling pool with capped confidence + tagged source", async () => {
    const res = await request(app).post("/api/compiq/estimate").send({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft Chrome",
      parallel: "Chrome Prospect Autograph",
      isAuto: true,
    });

    expect(res.status).toBe(200);

    // Source flag — distinct from "live" (direct) and "no-recent-comps" (failure)
    expect(res.body.source).toBe("sibling-pool");

    // Verdict text — exact match per design lock
    expect(res.body.verdict).toBe("Estimated from similar cards — variant unverified");

    // Confidence cap — pricingConfidence <= 65
    expect(res.body.confidence).toBeDefined();
    expect(typeof res.body.confidence.pricingConfidence).toBe("number");
    expect(res.body.confidence.pricingConfidence).toBeLessThanOrEqual(65);
    expect(res.body.confidence.pricingConfidence).toBeGreaterThan(0);

    // All pricing tiers populated as numbers (not null like the unrescued path)
    expect(typeof res.body.fairMarketValue).toBe("number");
    expect(res.body.fairMarketValue).toBeGreaterThan(0);
    expect(typeof res.body.quickSaleValue).toBe("number");
    expect(res.body.quickSaleValue).toBeGreaterThan(0);
    expect(typeof res.body.premiumValue).toBe("number");
    expect(res.body.premiumValue).toBeGreaterThan(0);

    // Ordering invariants — quickSale ≤ fair ≤ premium
    expect(res.body.quickSaleValue).toBeLessThanOrEqual(res.body.fairMarketValue);
    expect(res.body.premiumValue).toBeGreaterThanOrEqual(res.body.fairMarketValue);

    // compsUsed reflects combined pool (direct=0 + sibling=12). Exclude the
    // exact card_id; sibling pool has 12 comps but the helper excludes the
    // one card_id that matches the exact card, so effective sibling count
    // is what fetchCompsByPlayer returned minus same-card hits.
    expect(typeof res.body.compsUsed).toBe("number");
    expect(res.body.compsUsed).toBeGreaterThanOrEqual(3);

    // dataSufficiency block reflects sibling-pool semantics
    expect(res.body.dataSufficiency).toBeDefined();
    expect(res.body.dataSufficiency.sufficient).toBe(true);
    expect(res.body.dataSufficiency.level).toBe("low");
  });
});
