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
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-CBO prefix → CPA subset (Bowman Draft Chrome release)
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
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-CBO prefix → CPA subset (Bowman Draft Chrome release)
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

// CF-PAYMENTS-B1: /api/compiq/estimate now session-gated.
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

describe("CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING — sibling-pool rescue branch", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  it("rescues thin-data card via sibling pool with capped confidence + tagged source", async () => {
    const res = await request(app).post("/api/compiq/estimate").set("x-session-id", "test-sess").send({
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

  // CF-PREDICTION-PATH-FMV-FALLBACK (PREDICTION-ROBUSTNESS-RECON Option C,
  // 2026-06-02) — lock the new TrendIQ + predictedPrice wiring on the
  // sibling-pool rescue path. Before this CF: predictedPrice was structurally
  // null on this path (corpus measured 27/27 = 100% null over 14d). After:
  // computePredictedPrice runs against the L2+L3 composite computed from the
  // data the rescue already gathered. predictedPrice is non-null on every
  // success; coverage flag reflects which layers populated.
  describe("CF-PREDICTION-PATH-FMV-FALLBACK — TrendIQ + predictedPrice wiring", () => {
    it("emits non-null trendIQ + non-null predictedPrice (closes the 27/27 corpus gap)", async () => {
      const res = await request(app).post("/api/compiq/estimate").set("x-session-id", "test-sess").send({
        playerName: "Caleb Bonemer",
        cardYear: 2024,
        product: "Bowman Draft Chrome",
        parallel: "Chrome Prospect Autograph",
        isAuto: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.source).toBe("sibling-pool");

      // Non-regression: FMV value preserved unchanged on this path.
      // (The directive said "Leave the existing FMV computation untouched";
      // the helper above already asserts fmv > 0, this re-locks the same.)
      expect(typeof res.body.fairMarketValue).toBe("number");
      expect(res.body.fairMarketValue).toBeGreaterThan(0);

      // NEW: trendIQ field is now lifted into the sibling-pool response
      // (was absent before this CF — iOS got `trendIQ: null` here).
      expect(res.body.trendIQ).toBeDefined();
      expect(res.body.trendIQ).not.toBeNull();
      expect(typeof res.body.trendIQ.composite).toBe("number");
      expect(res.body.trendIQ.composite).toBeGreaterThanOrEqual(0.70);
      expect(res.body.trendIQ.composite).toBeLessThanOrEqual(1.50);
      expect(["up", "flat", "down"]).toContain(res.body.trendIQ.direction);
      // Coverage may be any of the 8-row matrix values; the test mocks
      // 0 direct comps + 12 sibling sales with no anchor (newestTs=0),
      // so segmentTrajectory returns null with reason="no_anchor" and
      // cardTrajectory returns null with insufficient direct pool. Both
      // layers absent → composite=1.0, direction="flat", coverage="insufficient".
      expect(res.body.trendIQ.coverage).toBe("insufficient");
      expect(res.body.trendIQ.components.playerMomentum).toBeNull();
      expect(res.body.trendIQ.components.cardTrajectory).toBeNull();
      expect(res.body.trendIQ.components.segmentTrajectory).toBeNull();

      // NEW: predictedPrice is non-null. With coverage=insufficient and
      // a finite FMV, computePredictedPrice gracefully sets factor=1.0
      // and returns predictedPrice = round2(fmv * 1.0). This is the
      // "no movement signal — estimated current value" semantic the
      // recon HALT documented as Option C's worst case.
      expect(typeof res.body.predictedPrice).toBe("number");
      expect(res.body.predictedPrice).not.toBeNull();
      expect(res.body.predictedPrice).toBe(res.body.fairMarketValue);

      // Predicted range echoes the no-movement-signal case: ±8% around
      // the predictedPrice (which equals fmv here).
      expect(res.body.predictedPriceRange).not.toBeNull();
      expect(res.body.predictedPriceRange.low).toBeLessThan(res.body.predictedPrice);
      expect(res.body.predictedPriceRange.high).toBeGreaterThan(res.body.predictedPrice);

      // NEW: mechanism = trendiq-projection (replaced mechanism1's
      // multiplier-anchored which used to fail with
      // "uncurated-subject-parallel" on this path).
      expect(res.body.predictedPriceAttribution.mechanism).toBe("trendiq-projection");
      expect(typeof res.body.predictedPriceAttribution.forwardProjectionFactor).toBe("number");
      expect(res.body.predictedPriceAttribution.forwardProjectionFactor).toBe(1.0);
      expect(res.body.predictedPriceAttribution.trendIQComposite).toBe(1.0);
      expect(res.body.predictedPriceAttribution.trendIQCoverage).toBe("insufficient");

      // signalsLastUpdated mirrors trendIQ.lastUpdated. L1 not fetched
      // on this path → null is the correct value.
      expect(res.body.signalsLastUpdated).toBeNull();
    });

    it("non-regression: existing source/verdict/confidence assertions still hold with trendIQ wired", async () => {
      const res = await request(app).post("/api/compiq/estimate").set("x-session-id", "test-sess").send({
        playerName: "Caleb Bonemer",
        cardYear: 2024,
        product: "Bowman Draft Chrome",
        parallel: "Chrome Prospect Autograph",
        isAuto: true,
      });
      // These four assertions are the original sibling-pool contract.
      // Locked here a second time to catch any future drift introduced
      // by trendIQ + predictedPrice work — if any of these regress, the
      // bigger contract is broken regardless of what trendIQ does.
      expect(res.body.source).toBe("sibling-pool");
      expect(res.body.verdict).toBe("Estimated from similar cards — variant unverified");
      expect(res.body.confidence.pricingConfidence).toBeLessThanOrEqual(65);
      expect(res.body.fairMarketValue).toBeGreaterThan(0);
    });
  });
});
