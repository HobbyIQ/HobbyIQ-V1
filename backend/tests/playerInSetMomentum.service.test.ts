/**
 * CF-PLAYER-IN-SET-MOMENTUM (2026-06-09) — fetchPlayerInSetMomentum.
 *
 * Mocks fetchCompsByPlayer at the module boundary so tests are pure
 * (no Cardsight network). Asserts:
 *  - rising / falling / stable classification via recent-7 vs prior-7
 *  - clamp [0.85, 1.20]
 *  - null (omit) when player+set has no sales OR thin pools
 *  - never falls back to a player-wide blob
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: vi.fn(),
}));

import { fetchCompsByPlayer } from "../src/services/compiq/compsByPlayer.service";
import { fetchPlayerInSetMomentum } from "../src/services/compiq/playerInSetMomentum.service";

const PLAYER = "Konnor Griffin";
const PRODUCT = "Bowman Draft";
const YEAR = 2024;

function compOnDay(price: number, daysAgo: number) {
  const t = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { cardId: "x", price, date: t, title: "x", source: "cardsight" as const };
}

function mockComps(prices: number[]) {
  // Most recent first — `prices[0]` is the most recent sale.
  const comps = prices.map((p, i) => compOnDay(p, i));
  (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    player: PLAYER,
    product: PRODUCT,
    cardYear: YEAR,
    cardIds: ["base", "auto", "refractor"],
    comps,
    cached: false,
    warnings: [],
  });
}

describe("fetchPlayerInSetMomentum", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when player or product is missing", async () => {
    expect(await fetchPlayerInSetMomentum({ playerName: "", product: PRODUCT })).toBeNull();
    expect(await fetchPlayerInSetMomentum({ playerName: PLAYER, product: "" })).toBeNull();
    expect(fetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("returns null when the aggregate returns 0 sales (TRUE MISS, honest omit)", async () => {
    (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      player: PLAYER, product: PRODUCT, cardYear: YEAR,
      cardIds: [], comps: [], cached: false, warnings: [],
    });
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).toBeNull();
  });

  it("returns null when thin pool (recent or prior window < 3 samples)", async () => {
    mockComps([100, 110, 120, 130, 140]); // 5 total → recent=5, prior=0
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).toBeNull();
  });

  it("rising: recent-7 avg significantly above prior-7 avg → multiplier > 1.08 + flag", async () => {
    // recent 7 avg = 1200, prior 7 avg = 800 → ratio 1.5 → clamp 1.20 → rising
    mockComps([1200, 1200, 1200, 1200, 1200, 1200, 1200, 800, 800, 800, 800, 800, 800, 800]);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).not.toBeNull();
    expect(out!.multiplier).toBe(1.2);
    expect(out!.flags).toEqual(["player_in_set", "rising"]);
    expect(out!.componentSignals.recent_avg).toBe(1200);
    expect(out!.componentSignals.prior_avg).toBe(800);
    expect(out!.componentSignals.pool_size).toBe(14);
  });

  it("falling: recent-7 below prior-7 → multiplier < 0.93 + flag", async () => {
    // recent 7 = 500, prior 7 = 1000 → ratio 0.5 → clamp 0.85 → falling
    mockComps([500, 500, 500, 500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(0.85);
    expect(out!.flags).toEqual(["player_in_set", "falling"]);
  });

  it("stable: recent ≈ prior → multiplier in [0.93, 1.08] + flag", async () => {
    // recent = 1000, prior = 990 → ratio 1.01 → stable
    mockComps([1000, 1000, 1000, 1000, 1000, 1000, 1000, 990, 990, 990, 990, 990, 990, 990]);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.flags).toEqual(["player_in_set", "stable"]);
    expect(out!.multiplier).toBeGreaterThanOrEqual(0.93);
    expect(out!.multiplier).toBeLessThanOrEqual(1.08);
  });

  it("clamps ratio above 1.20 down to 1.20 (no runaway)", async () => {
    mockComps([10000, 10000, 10000, 10000, 10000, 10000, 10000, 100, 100, 100, 100, 100, 100, 100]);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(1.2);
  });

  it("clamps ratio below 0.85 up to 0.85 (no runaway)", async () => {
    mockComps([1, 1, 1, 1, 1, 1, 1, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(0.85);
  });

  it("sorts by date desc — out-of-order inputs land correctly", async () => {
    // Build sales explicitly out of order; mark the OLDER ones at high
    // price (1000) and the NEWER ones at low price (500) → recent-7 avg
    // should be 500 (lower), prior-7 avg should be 1000 (higher) → falling
    const recent = [0, 1, 2, 3, 4, 5, 6].map((d) => compOnDay(500, d));   // newest
    const older  = [7, 8, 9, 10, 11, 12, 13].map((d) => compOnDay(1000, d));
    const shuffled = [...older, ...recent]; // older first to verify sort works
    (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      player: PLAYER, product: PRODUCT, cardYear: YEAR,
      cardIds: [], comps: shuffled, cached: false, warnings: [],
    });
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.componentSignals.recent_avg).toBe(500);
    expect(out!.componentSignals.prior_avg).toBe(1000);
    expect(out!.flags).toEqual(["player_in_set", "falling"]);
  });

  it("drops records with non-finite or non-positive prices", async () => {
    (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      player: PLAYER, product: PRODUCT, cardYear: YEAR,
      cardIds: [], comps: [
        ...[0, 1, 2, 3, 4, 5, 6].map((d) => compOnDay(1100, d)),
        ...[7, 8, 9, 10, 11, 12, 13].map((d) => compOnDay(1000, d)),
        compOnDay(-5, 14),           // garbage; dropped
        compOnDay(NaN as any, 15),   // garbage; dropped
        compOnDay(0, 16),            // garbage; dropped
      ],
      cached: false, warnings: [],
    });
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.componentSignals.recent_avg).toBe(1100);
    expect(out!.componentSignals.prior_avg).toBe(1000);
  });

  it("returns null when fetchCompsByPlayer throws — never falls back to player-wide blob", async () => {
    (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cardsight 500"));
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).toBeNull();
  });

  it("sourceUrl is null + lastUpdated is now (live, not from blob)", async () => {
    mockComps(Array.from({ length: 14 }, (_, i) => 1000 + i));
    const before = Date.now();
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    const after = Date.now();
    expect(out!.sourceUrl).toBeNull();
    const ts = Date.parse(out!.lastUpdated!);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
