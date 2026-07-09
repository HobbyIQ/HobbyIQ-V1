// CF-CATALOG-MISS-SIBLING-RESCUE (2026-07-09, Drew — Devin Taylor red auto).
//
// Regression guard: when findCompsRouted returns { card: null, sales: [] }
// (the "no CH match" or "CH match but no trusted comps" outcome), the
// computeEstimate flow used to short-circuit to source="catalog-miss" and
// return null pricing — WITHOUT ever probing the sibling pool. That hid
// pricing for thin-market autos and parallels whose base/sibling cards
// were actively priced.
//
// The fix synthesizes a card identity from the parsed queryContext
// (playerName + product + year + parallel) and lets the existing sibling-
// pool rescue path anchor pricing. This test locks in that behavior.

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";

// findCompsRouted returns the "catalog-miss" trigger: card=null, sales=[].
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardSalesRouted: vi.fn(async () => []),
    searchCardsRouted: vi.fn(async () => []),
    findCompsRouted: vi.fn(async () => ({
      card: null, // ← catalog-miss trigger (previously short-circuited)
      sales: [],
      variantWarning: [],
      aiCategory: "Baseball",
    })),
  };
});

// Sibling pool is healthy — fetchCompsByPlayer returns 12 sales across 3
// sibling card_ids. This is what the synthetic-identity probe uses to
// rescue pricing.
vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: vi.fn(async () => {
    const now = Date.now();
    return {
      player: "Devin Taylor",
      product: "Bowman Draft Chrome",
      cardYear: 2025,
      cardIds: ["dt-base-auto", "dt-refractor-auto", "dt-gold-auto"],
      comps: Array.from({ length: 12 }, (_, i) => ({
        cardId:
          i % 3 === 0 ? "dt-base-auto" : i % 3 === 1 ? "dt-refractor-auto" : "dt-gold-auto",
        price: 120 + i * 8,
        date: new Date(now - i * 3 * 24 * 60 * 60 * 1000).toISOString(),
        title: `Devin Taylor sibling comp ${i}`,
        source: "cardsight" as const,
      })),
      cached: false,
      warnings: [],
    };
  }),
}));

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

describe("CF-CATALOG-MISS-SIBLING-RESCUE — Devin Taylor 2025 Bowman red auto", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  it("does NOT return source=catalog-miss when sibling pool has sales", async () => {
    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", "test-sess")
      .send({
        playerName: "Devin Taylor",
        cardYear: 2025,
        product: "Bowman Draft Chrome",
        parallel: "Red",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    // Pre-fix behavior: source === "catalog-miss" and everything null.
    // Post-fix: sibling rescue kicks in and returns "sibling-pool" pricing.
    expect(res.body.source).not.toBe("catalog-miss");
  });

  it("returns pricing anchored on the sibling pool (fmv > 0)", async () => {
    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", "test-sess")
      .send({
        playerName: "Devin Taylor",
        cardYear: 2025,
        product: "Bowman Draft Chrome",
        parallel: "Red",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    // CF-PARALLEL-FLOOR-PROJECTION (2026-07-09): Red /5 matches the
    // rare-parallel bracket → more specific parallel-floor-projection
    // fires BEFORE sibling-pool rescue. Both are valid rescues; the
    // projection is the tighter estimate when print-run is known.
    expect(["parallel-floor-projection", "sibling-pool"]).toContain(res.body.source);
    expect(typeof res.body.fairMarketValue).toBe("number");
    expect(res.body.fairMarketValue).toBeGreaterThan(0);
    expect(res.body.compsUsed).toBeGreaterThan(0);
  });

  it("cardIdentity is populated from the parsed queryContext (not null)", async () => {
    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", "test-sess")
      .send({
        playerName: "Devin Taylor",
        cardYear: 2025,
        product: "Bowman Draft Chrome",
        parallel: "Red",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    // The rescued path exposes the synthesized identity so iOS can render
    // player + product headings on the card panel even though the exact
    // SKU wasn't in CH's trusted pool.
    expect(res.body.cardIdentity).toBeDefined();
    expect(res.body.cardIdentity).not.toBeNull();
    expect(res.body.cardIdentity.player).toBe("Devin Taylor");
    expect(res.body.cardIdentity.set).toBe("Bowman Draft Chrome");
    expect(res.body.cardIdentity.year).toBe(2025);
    expect(res.body.cardIdentity.variant).toBe("Red");
    // card_id is empty string — iOS treats empty card_id as "not
    // navigable" which is exactly the correct behavior for an
    // estimated-from-siblings result.
    expect(res.body.cardIdentity.card_id).toBe("");
  });

  it("still returns source=catalog-miss when there is no queryContext to synthesize from", async () => {
    // No playerName / product → cannot build a synthetic identity → the
    // original catalog-miss short-circuit still fires. Guards against the
    // rescue path silently masking genuinely-unresolvable queries.
    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", "test-sess")
      .send({
        // Deliberately missing playerName + product.
        cardYear: 2025,
        parallel: "Red",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("catalog-miss");
    expect(res.body.cardIdentity).toBeNull();
  });
});
