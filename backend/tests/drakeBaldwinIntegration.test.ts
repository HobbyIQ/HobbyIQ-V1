// Drake Baldwin integration — variant filter behavior across the tier ladder.
//
// HISTORY:
//   Pre CF-VARIANT-FILTER-LOOSENING, this fixture exercised the
//   variant-mismatch short-circuit: comps were for the right card_id but
//   none had "Blue Refractor" in the title, so the strict variant filter
//   dropped them and the response returned marketValue=null + Mechanism 1
//   multiplier-anchored predictedPrice as the substitute estimate.
//
//   Post CF-VARIANT-FILTER-LOOSENING (Option B), this case now promotes to
//   T1 (drop parallel check) — the tier ladder finds the 4-5 surviving
//   refractor/auto comps and prices from them with:
//     - variantStrictness = "T1"
//     - confidence cap = 80 (min(80, computed))
//     - verdict text = "Variant approximation — parallel unverified"
//     - marketValue = number (was null before)
//
// The Mechanism 1 multiplier-anchored path is now exercised only when the
// tier ladder exhausts at T3 (every-tier-hard-reject). The second test
// here drives that path with a player-name-mismatch fixture (the
// player_name_missing_from_comp rejection is the never-relaxed invariant).

import { describe, it, expect, vi } from "vitest";

// Post-CF-CARDHEDGE-HARD-CUTOVER: mocks target cardsight.router instead
// of the deleted cardhedge.client. The router's findCompsRouted return
// shape (RoutedResult) matches the prior cardhedge findCompsByQuery shape.
// CF-CARDSIGHT-REMOVAL (Wave 3): stub the trendIQ L3 forward-projection seam so
// computeEstimate doesn't make an un-mocked ~5s live fetchCompsByPlayer HTTP call
// and exceed the 5000ms vitest timeout. Empty comps keeps trendIQ "insufficient"
// (identical to the live fallback), leaving all assertions unaffected.
vi.mock("../src/services/compiq/compsByPlayer.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCompsByPlayer: vi.fn(
      async (input: { playerName: string; product: string; cardYear?: number }) => ({
        player: input.playerName,
        product: input.product,
        ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
        cardIds: [],
        comps: [],
        cached: false,
        warnings: [],
      }),
    ),
  };
});

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

describe("Drake Baldwin integration — CF-VARIANT-FILTER-LOOSENING tier T1 promotion", () => {
  it("promotes to T1 (drop parallel) when no comp title matches 'Blue Refractor' but auto/player do", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-drake-blue-auto-150",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN-style auto → CPA subset
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 250, date: isoDaysAgo(20), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Purple Refractor Auto /250" },
        { price: 1100, date: isoDaysAgo(24), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Gold Refractor Auto /50" },
      ],
      // variantWarning is now informational per Q8 lock — does NOT trigger
      // a short-circuit. The tier ladder handles graceful degradation.
      variantWarning: ["auto_mismatch"],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any, testCallContext)) as Record<string, any>;

    // Source: success path (not variant-mismatch — the ladder rescued it).
    expect(result.source).toBe("live");

    // marketValue: populated by T1 pricing (was null pre-CF).
    expect(typeof result.marketValue).toBe("number");
    expect(result.marketValue).toBeGreaterThan(0);

    // variantStrictness surfaced in compQuality so iOS / sweeps / backtests
    // can identify tier-loosened estimates.
    expect(result.compQuality?.variantStrictness).toBe("T1");

    // Verdict text override per Q2 lock — exact string match.
    expect(result.verdict).toBe("Variant approximation — parallel unverified");

    // Confidence cap per Q1 lock: pricingConfidence ≤ 80 (T1 tier cap).
    expect(typeof result.confidence?.pricingConfidence).toBe("number");
    expect(result.confidence.pricingConfidence).toBeLessThanOrEqual(80);
    expect(result.confidence.pricingConfidence).toBeGreaterThan(0);

    // Tier ladder trace exposes per-tier comp counts; T0 should have 0
    // (no "Blue Refractor" matches), T1 ≥ 3 (parallel relaxed).
    expect(result.compQuality?.tierLadderTrace?.T0).toBe(0);
    expect(result.compQuality?.tierLadderTrace?.T1).toBeGreaterThanOrEqual(3);

    // Post PR #419 (CF-SLOPE-VALUATION-MAIN-ENGINE): when the comp pool
    // has ≥2 dated records with distinct dates, linear regression fits
    // the whole pool and overrides trendiq-projection. Attribution
    // switches from `mechanism: "trendiq-projection"` to
    // `method: "linear-regression"`. Both are valid semantically —
    // linear-regression is the newer, uniform-across-vendors path.
    // Fallback to trendiq-projection is preserved on thin/undated pools.
    expect(typeof result.predictedPrice).toBe("number");
    const attr: any = result.predictedPriceAttribution;
    const attrLabel = attr?.method ?? attr?.mechanism;
    expect(["linear-regression", "trendiq-projection"]).toContain(attrLabel);
    // Bounded by design: predictedPrice is a fair estimate anchored to
    // fmv. Linear-regression can extend further than the ±18% trendiq
    // clamp; loosen the bounds to ±40% so both paths pass. Wider bound
    // still catches gross regressions (e.g. a $10 fmv shouldn't produce
    // a $10,000 predicted price).
    const fmv = result.fairMarketValue as number;
    expect(result.predictedPrice).toBeGreaterThanOrEqual(fmv * 0.6 - 0.01);
    expect(result.predictedPrice).toBeLessThanOrEqual(fmv * 1.4 + 0.01);
  });
});

describe("variant-mismatch fallback — Mechanism 1 still fires when tier ladder exhausts at T3", () => {
  it("returns source=variant-mismatch + Mechanism 1 predictedPrice when player_name_missing rejects every tier", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    // Cardsight returns comps but they're for the WRONG PLAYER — the
    // player_name_missing_from_comp rejection is the never-relaxed
    // invariant, so every tier hard-rejects → T3 exhausted →
    // variant-mismatch short-circuit fires → Mechanism 1 produces a
    // predictedPrice substitute.
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-drake-blue-auto-150",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: CPA-DBN-style auto → CPA subset
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft Mike Trout Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft Mike Trout Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft Shohei Ohtani Refractor Auto /250" },
        { price: 250, date: isoDaysAgo(20), title: "2022 Bowman Draft Aaron Judge Refractor Auto /250" },
        { price: 1100, date: isoDaysAgo(24), title: "2022 Bowman Draft Ronald Acuna Gold Refractor Auto /50" },
      ],
      variantWarning: ["auto_mismatch"],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any, testCallContext)) as Record<string, any>;

    // Tier ladder exhausted at T3 → fall through to variant-mismatch.
    expect(result.source).toBe("variant-mismatch");
    // CF-VARIANT-MISMATCH-USE-RECENT-COMPS (2026-07-15): variant-mismatch
    // now populates marketValue/fairMarketValue with median of fetched.comps
    // when any present. Accept null OR positive number.
    expect(result.marketValue == null || (typeof result.marketValue === "number" && result.marketValue > 0)).toBe(true);
    expect(result.fairMarketValue == null || (typeof result.fairMarketValue === "number" && result.fairMarketValue > 0)).toBe(true);

    // Mechanism 1 still wired into the variant-mismatch fallback path —
    // predictedPriceAttribution is populated (may be null predictedPrice if
    // the multiplier table doesn't have a match, but the attribution object
    // is the structural contract). Mechanism 1 unit-level correctness is
    // covered by multiplierAnchoredPredictedPrice.test.ts.
    expect(result.predictedPriceAttribution).toBeDefined();
    expect(result.predictedPriceAttribution?.mechanism).toBe("multiplier-anchored");

    // compsAvailable surfaces raw fetched count (5) so iOS can show
    // "5 comps on file — none match your variant" instead of zero.
    expect(result.compsAvailable).toBe(5);
    expect(result.compsUsed).toBe(0);
  });
});
