/**
 * CF-PLAYER-IN-SET-MOMENTUM (2026-06-09) — fetchPlayerInSetMomentum.
 * CF-PLAYER-IN-SET-PER-CARD-DIRECTION (2026-06-10) — per-card median
 * ratio aggregation, not pooled recent-vs-prior averages.
 *
 * Asserts:
 *  - null (omit) when player+set missing OR 0 sales OR <2 qualifying cards
 *  - per-card recent-vs-prior MEDIAN ratio; cards w/o ≥3 in each window excluded
 *  - aggregated signal = median of per-card ratios
 *  - clamp [0.85, 1.20]
 *  - rising / falling / stable classification from the aggregated ratio
 *  - mix-skew immunity: cheap-base-skewed recent window can't masquerade as direction
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

function sale(cardId: string, price: number, daysAgo: number) {
  const t = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { cardId, price, date: t, title: "x", source: "cardsight" as const };
}

function mockBundle(comps: Array<ReturnType<typeof sale>>, cardIds: string[] = []) {
  (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    player: PLAYER,
    product: PRODUCT,
    cardYear: YEAR,
    cardIds,
    comps,
    cached: false,
    warnings: [],
  });
}

/** Generate a card's 14 sales: recent 7 at recentPrice, prior 7 at priorPrice. */
function cardSales(cardId: string, recentPrice: number, priorPrice: number) {
  const out = [];
  for (let d = 0; d < 7; d++) out.push(sale(cardId, recentPrice, d));
  for (let d = 7; d < 14; d++) out.push(sale(cardId, priorPrice, d));
  return out;
}

describe("fetchPlayerInSetMomentum (per-card median ratios)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when player or product is missing", async () => {
    expect(await fetchPlayerInSetMomentum({ playerName: "", product: PRODUCT })).toBeNull();
    expect(await fetchPlayerInSetMomentum({ playerName: PLAYER, product: "" })).toBeNull();
    expect(fetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("returns null when the aggregate returns 0 sales (TRUE MISS, honest omit)", async () => {
    mockBundle([]);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).toBeNull();
  });

  it("returns null when <2 cards have ≥3 in BOTH windows (single-card concentration)", async () => {
    // Only one card has enough; others are thin
    const comps = [
      ...cardSales("A", 100, 90),         // qualifies
      ...[0, 1, 2].map((d) => sale("B", 50, d)), // recent=3, prior=0 — disqualified
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).toBeNull();
  });

  it("MIX-SKEW IMMUNITY: cheap base in recent window + expensive auto in prior does NOT pull signal", async () => {
    // The whole point of this CF: pooled recent_avg vs prior_avg would
    // read this as floor-falling (recent $50 << prior $500). Per-card
    // says: every card individually flat → stable.
    //
    // Card A (base): 7 sales at $50, all in the RECENT 7 days; no prior sales.
    // Card B (auto): 7 sales at $500, all in the PRIOR 7-14 day window; no recent.
    // Card C (refractor): 14 sales, 7 recent + 7 prior, ALL at $200 → ratio 1.0
    // Card D (1-of-1):   14 sales, 7 recent + 7 prior, ALL at $1000 → ratio 1.0
    //
    // Pooled recent_avg = (7×50 + 7×200 + 7×1000) / 21 = ~417
    // Pooled prior_avg  = (7×500 + 7×200 + 7×1000) / 21 = ~567
    // Pooled would read ~0.74 → FLOOR-FALLING (mix-skew).
    //
    // Per-card: cards A & B disqualified (one window empty); C&D ratio=1.0
    // → aggregated 1.0 → STABLE. Real direction surfaces.
    const comps = [
      ...[0, 1, 2, 3, 4, 5, 6].map((d) => sale("A_base", 50, d)),       // disqualified
      ...[7, 8, 9, 10, 11, 12, 13].map((d) => sale("B_auto", 500, d)),  // disqualified
      ...cardSales("C_refractor", 200, 200),                            // ratio 1.0
      ...cardSales("D_oneofone", 1000, 1000),                           // ratio 1.0
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).not.toBeNull();
    expect(out!.multiplier).toBe(1.0);
    expect(out!.flags).toEqual(["player_in_set", "stable"]);
    expect(out!.componentSignals.qualifying_cards).toBe(2);
    expect(out!.componentSignals.cards_in_pool).toBe(4);
  });

  it("rising: per-card ratios median > 1.08 + flag", async () => {
    // 3 cards individually up by ~50% → median ratio 1.5 → clamp 1.20 → rising
    const comps = [
      ...cardSales("A", 150, 100), // ratio 1.5
      ...cardSales("B", 150, 100), // ratio 1.5
      ...cardSales("C", 150, 100), // ratio 1.5
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(1.2);
    expect(out!.flags).toEqual(["player_in_set", "rising"]);
    expect(out!.componentSignals.qualifying_cards).toBe(3);
  });

  it("falling: per-card ratios median < 0.93 + flag (REAL direction, not mix)", async () => {
    // Each card individually down ~50% — this is REAL falling, not mix
    const comps = [
      ...cardSales("A", 50, 100),  // ratio 0.5
      ...cardSales("B", 50, 100),  // ratio 0.5
      ...cardSales("C", 50, 100),  // ratio 0.5
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(0.85);
    expect(out!.flags).toEqual(["player_in_set", "falling"]);
  });

  it("stable: per-card ratios median ≈ 1.0 → flag stable", async () => {
    const comps = [
      ...cardSales("A", 100, 99),
      ...cardSales("B", 100, 99),
      ...cardSales("C", 100, 99),
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.flags).toEqual(["player_in_set", "stable"]);
  });

  it("median of ratios picks the middle value (one card down hard does not dominate)", async () => {
    // Three cards: A down 50% (ratio 0.5), B stable (1.0), C up 50% (1.5)
    // Median picks 1.0 → stable (NOT pulled by either extreme)
    const comps = [
      ...cardSales("A", 50, 100),  // ratio 0.5
      ...cardSales("B", 100, 100), // ratio 1.0
      ...cardSales("C", 150, 100), // ratio 1.5
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.componentSignals.aggregated_ratio).toBe(1.0);
    expect(out!.flags).toEqual(["player_in_set", "stable"]);
  });

  it("clamps aggregated ratio above 1.20 down to 1.20", async () => {
    const comps = [
      ...cardSales("A", 10000, 100),
      ...cardSales("B", 10000, 100),
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(1.2);
  });

  it("clamps aggregated ratio below 0.85 up to 0.85", async () => {
    const comps = [
      ...cardSales("A", 1, 1000),
      ...cardSales("B", 1, 1000),
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.multiplier).toBe(0.85);
  });

  it("sorts each card's sales by date desc before splitting (out-of-order input)", async () => {
    // Card A: older sales submitted first; should still land in PRIOR window after sort.
    // Card B: same.
    const recentA = [0, 1, 2, 3, 4, 5, 6].map((d) => sale("A", 500, d));
    const priorA  = [7, 8, 9, 10, 11, 12, 13].map((d) => sale("A", 1000, d));
    const recentB = [0, 1, 2, 3, 4, 5, 6].map((d) => sale("B", 500, d));
    const priorB  = [7, 8, 9, 10, 11, 12, 13].map((d) => sale("B", 1000, d));
    mockBundle([...priorA, ...recentA, ...priorB, ...recentB]); // intentionally jumbled
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.flags).toEqual(["player_in_set", "falling"]);
  });

  it("drops sales with non-finite or non-positive prices per-card", async () => {
    const comps = [
      ...cardSales("A", 100, 99),
      ...cardSales("B", 100, 99),
      sale("A", -5, 14),
      sale("A", NaN as any, 15),
      sale("B", 0, 16),
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out!.flags).toEqual(["player_in_set", "stable"]);
  });

  it("returns null when fetchCompsByPlayer throws — never falls back to player-wide blob", async () => {
    (fetchCompsByPlayer as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cardsight 500"));
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).toBeNull();
  });

  it("componentSignals surfaces per-card breakdown", async () => {
    const comps = [
      ...cardSales("A", 120, 100),
      ...cardSales("B", 80, 100),
      ...cardSales("C", 100, 100),
    ];
    mockBundle(comps);
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    expect(out).not.toBeNull();
    const cs: any = out!.componentSignals;
    expect(Array.isArray(cs.per_card_ratios)).toBe(true);
    expect(cs.per_card_ratios).toHaveLength(3);
    const byCard = Object.fromEntries(cs.per_card_ratios.map((p: any) => [p.cardId, p]));
    expect(byCard.A.ratio).toBe(1.2);
    expect(byCard.B.ratio).toBeCloseTo(0.8, 3);
    expect(byCard.C.ratio).toBe(1.0);
  });

  it("sourceUrl is null + lastUpdated is now (live, not from blob)", async () => {
    const comps = [
      ...cardSales("A", 100, 100),
      ...cardSales("B", 100, 100),
    ];
    mockBundle(comps);
    const before = Date.now();
    const out = await fetchPlayerInSetMomentum({ playerName: PLAYER, product: PRODUCT, cardYear: YEAR });
    const after = Date.now();
    expect(out!.sourceUrl).toBeNull();
    const ts = Date.parse(out!.lastUpdated!);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
