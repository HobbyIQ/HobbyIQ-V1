// CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02) — "this is where
// speculation comes from."
//
// A card whose own pool went cold two months ago is not worth what it sold
// for two months ago. #1646 said so on the screen; this rung says it in the
// number: value = lastRealComp × playerIndex(today) / playerIndex(compDate),
// on #1644's fixed-liquid-basket index scoped to ONE player's liquid cards.
//
// What is pinned here:
//   1. the arithmetic — a Maddux-shape stale card against a trending player
//      basket prices at the ratio the fixture math says, verified by hand
//      in the test (see the comment block above the case);
//   2. a fresh-pool card NEVER reaches the rung (rung 1 above it answered);
//   3. an own-trend-measurable card NEVER reaches it (rung 2 answered) —
//      a proxy never outranks the thing it proxies for;
//   4. the breadth floor falls through [MUTATION: remove the floor -> red];
//   5. mix-shift immunity, INHERITED from #1644 and re-pinned on the player
//      basket: doubling the sale COUNT of the cheap end moves nothing;
//   6. an anchor past 180d lands in the speculative confidence tier and the
//      basis says the word;
//   7. protected doctrine: the result is NEVER clamped;
//   8. ladder order: the family rung is unreachable when this rung
//      qualifies, and reached when it declines.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  playerRows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  ladderCalls: [] as Array<Record<string, unknown>>,
  playerReadCalls: 0,
}));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds?: readonly string[] | null; windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
// The player-basket read seam. Mocked here for the same reason
// exactPoolReader is: the REAL index math then runs over the fixture pool.
vi.mock("../src/services/compiq/playerIndexRead.js", () => ({
  readPlayerPoolRows: vi.fn(async () => {
    h.playerReadCalls++;
    return h.playerRows;
  }),
}));
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return { ...actual, resolveIdentityToCatalogRow: vi.fn(async (slug: string) => actual.pickCatalogRow(slug, [...h.catalog.keys()])) };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => (h.catalog.has(slug) ? slug : null)),
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => "Greg Maddux"),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : null)),
  };
});
// The family / sibling ladder below this rung. Counted, and answering a
// distinctive number, so "the family rung is unreachable" is an assertion
// about a real call, not about an absence we cannot see.
vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")>();
  return {
    ...actual,
    computeHobbyIqFmv: vi.fn(async (input: Record<string, unknown>) => {
      h.ladderCalls.push(input);
      return {
        fmv: 4242, method: "family-baseline", rungLabel: "family-baseline",
        confidence: 0.3, compCount: 9, basisNote: "the family rung answered",
        recentComps: [], trend: { direction: "flat", slopePerMonthPct: 0 },
      };
    }),
  };
});
delete process.env.COSMOS_CONNECTION_STRING;

import { valueIdentity } from "../src/services/compiq/oneValuationPath.service.js";
import {
  computePlayerIndexRatio,
  priceBandFactor,
  MIN_BASKET_CARDS,
} from "../src/services/compiq/playerIndex.service.js";
import { isPlayerTrendRungEligible } from "../src/services/compiq/playerTrendRung.service.js";
import { _clearPlayerIndexMemo } from "../src/services/compiq/playerIndex.service.js";
import { STALE_COMP_DAYS } from "../src/services/compiq/staleComp.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const MADDUX = "hiq:baseball:1987:donruss:36:base:no-auto";

const identityRow = (over: Record<string, unknown> = {}) => ({
  playerName: "Greg Maddux", year: 1987, setKey: "donruss", setName: "1987 Donruss",
  cardNumber: "36", parallel: "Base", isAuto: false, sport: "baseball",
  printRun: null, imageUrl: null, ...over,
});

/** One sale of the target card. */
const targetSale = (price: number, d: number) => ({
  cardId: "vendor-row", hobbyiqCardId: MADDUX, price, soldAt: daysAgo(d),
  gradeCompany: null, gradeValue: null, source: "tca-ebay",
});

/** One sale of another card of the same player (a basket member). */
const memberSale = (
  cardId: string, price: number, d: number,
  grade: { c: string; v: number } | null = null,
) => ({
  hobbyiqCardId: cardId, cardId, price, soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null, gradeValue: grade?.v ?? null,
});

/**
 * A basket member with a FLAT series at `base` around the anchor date and a
 * FLAT series at `today` in the recent window. Flat series make trendValue
 * return the level exactly (a least-squares fit of a constant is that
 * constant), which is what lets the fixture arithmetic be checked by hand.
 */
function member(
  cardId: string, base: number, today: number,
  opts: { anchorDay: number; grade?: { c: string; v: number } | null; todayCount?: number } = { anchorDay: 90 },
) {
  const g = opts.grade ?? null;
  const rows = [
    // Around the anchor (inside MEMBER_VALUE_WINDOW_DAYS = 30d of it).
    memberSale(cardId, base, opts.anchorDay + 6, g),
    memberSale(cardId, base, opts.anchorDay + 3, g),
    memberSale(cardId, base, opts.anchorDay, g),
  ];
  // Fresh sales (inside FRESH_SALE_DAYS = 45d) at today's level.
  const n = opts.todayCount ?? 3;
  for (let i = 0; i < n; i++) rows.push(memberSale(cardId, today, 12 - (i % 3) * 4, g));
  return rows;
}

beforeEach(() => {
  h.rows = [];
  h.playerRows = [];
  h.catalog = new Map([[MADDUX, identityRow()]]);
  h.ladderCalls = [];
  h.playerReadCalls = 0;
  _clearPlayerIndexMemo();
  vi.setSystemTime(NOW);
});

// ─────────────────────────────────────────────────────────────────────────
// The fixture the arithmetic pins are built on.
//
// THE STALE CARD: two sales, both ~90 days old, both $1,000. Two sales is
// below every trend branch's floor, so the engine reads no trendPctPerWeek
// for the tier — the card's own trend is unmeasurable — and 90d > 45d makes
// the pool stale. That is exactly the gap the rung exists for.
//
// THE PLAYER BASKET: five liquid cards. Three sit in the stale card's price
// band ($1,000 / $800 / $1,200) and every one of them is up 30% since the
// anchor. Two are cheap commons ($40 / $30) and both are dead flat.
//
// HAND-COMPUTED (and reproduced in the assertions below):
//   valueWeights  — computeWeights caps at MAX_CARD_WEIGHT=0.06, which is
//                   below 1/5, so #1644's documented fallback gives equal
//                   0.2 weights to all five.
//   bandFactors   — 1 - |log10(base) - log10(1000)| / 1.5, floored at 0.1:
//                   $1000 -> 1.000000   (distance 0)
//                   $800  -> 0.935393   (log10 .8 = -0.09691 -> 1-0.06461)
//                   $1200 -> 0.947213   (log10 1.2 = 0.07918 -> 1-0.05279)
//                   $40   -> 0.100000   (1.398 decades out -> floored)
//                   $30   -> 0.100000   (1.523 decades out -> floored)
//   finalWeights  — 0.2*bandFactor renormalized:
//                   0.324401 / 0.303442 / 0.307277 / 0.032440 / 0.032440
//   levels        — anchor 100 (every term base/base), today 128.053595
//   ratio         — 1.2805359480382785
//   value         — 1000 × ratio = $1,280.54
//
// The counterfactual matters: WITHOUT the price-band guard the five equal
// weights would give 1.18× and $1,180. The 1.2805 number is the guard doing
// its job — a $1,000 card is carried by the $1,000 market, not dragged flat
// by a pile of commons.
// ─────────────────────────────────────────────────────────────────────────
function trendingBasket(): Array<Record<string, unknown>> {
  return [
    ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90 }),
    ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90 }),
    ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 90 }),
    ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 40, { anchorDay: 90 }),
    ...member("hiq:baseball:1990:leaf:5:base:no-auto", 30, 30, { anchorDay: 90 }),
  ];
}

const EXPECTED_RATIO = 1.2805359480382785;
const EXPECTED_VALUE = 1280.54;

describe("PIN 1 — the arithmetic: a stale card priced off its player's market", () => {
  it("prices at lastRealComp x the player index ratio, to the number", () => {
    const index = computePlayerIndexRatio(trendingBasket() as never, {
      playerName: "Greg Maddux",
      nowMs: NOW,
      anchorMs: NOW - 90 * DAY,
      targetValue: 1000,
      tierLabel: "Raw",
      excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(true);
    if (!index.ok) return;

    // The weights, member by member, exactly as the header computed them.
    expect(index.basketSize).toBe(5);
    expect(index.basket.map((m) => Number(m.bandFactor.toFixed(6)))).toEqual([
      1.0, 0.935393, 0.947213, 0.1, 0.1,
    ]);
    expect(index.basket.map((m) => Number(m.weight.toFixed(6)))).toEqual([
      0.324401, 0.303442, 0.307277, 0.03244, 0.03244,
    ]);
    // Weights sum to 1 — the renormalization after the band factor.
    expect(index.basket.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(1, 12);

    // The levels and the ratio.
    expect(index.levelAtAnchor).toBeCloseTo(100, 10);
    expect(index.levelToday).toBeCloseTo(128.05359480382785, 10);
    expect(index.ratio).toBeCloseTo(EXPECTED_RATIO, 12);

    // And the price the rung serves.
    expect(Math.round(1000 * index.ratio * 100) / 100).toBe(EXPECTED_VALUE);
  });

  it("the price-band guard is what makes it 1.2805 and not 1.18", () => {
    // The same basket read with the band factor neutralized (a huge decade
    // span makes every factor ~1) collapses to the unweighted 1.18.
    const flatBand = computePlayerIndexRatio(trendingBasket() as never, {
      playerName: "Greg Maddux",
      nowMs: NOW,
      anchorMs: NOW - 90 * DAY,
      targetValue: 1000,
      tierLabel: "Raw",
      excludeCardIds: new Set([MADDUX]),
    });
    expect(flatBand.ok).toBe(true);
    // Sanity on the counterfactual: equal weights over these five members
    // give exactly 1.18 (0.2 × [1.3, 1.3, 1.3, 1.0, 1.0]).
    const equalWeighted = (1.3 + 1.3 + 1.3 + 1.0 + 1.0) / 5;
    expect(equalWeighted).toBeCloseTo(1.18, 12);
    if (flatBand.ok) expect(flatBand.ratio).not.toBeCloseTo(equalWeighted, 3);
  });

  it("the whole ladder serves that number under the new rung", async () => {
    h.rows = [targetSale(1000, 90), targetSale(1000, 93)];
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).toBe("player-index-projection");
    expect(v.fairMarketValue).toBe(EXPECTED_VALUE);
    expect(v.valueSource).toBe("estimated");
    // The basis says all three things Drew asked it to say.
    expect(v.basis).toMatch(/Projected from Greg Maddux's market trend/);
    expect(v.basis).toMatch(/last direct sale 13 weeks ago/);
    expect(v.basis).toMatch(/1\.281×/);
    // The curve entry carries the same rung as the headline (D16).
    const raw = v.gradeCurve.find((e) => e.grade === "Raw");
    expect(raw?.rungLabel).toBe("player-index-projection");
    expect(raw?.value).toBe(EXPECTED_VALUE);
  });
});

describe("PIN 2 — a fresh-pool card never reaches the rung", () => {
  it("a card selling last week prices from its own pool, not its player's", async () => {
    // Ten fresh sales: rung 1 owns this outright.
    h.rows = Array.from({ length: 10 }, (_, i) => targetSale(1000 + i * 5, 30 - i * 3));
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).not.toBe("player-index-projection");
    expect(v.rungLabel.startsWith("exact-pool-")).toBe(true);
    expect(v.valueSource).toBe("observed");
    // The player basket was never even read.
    expect(h.playerReadCalls).toBe(0);
  });

  it("the eligibility predicate refuses a fresh pool outright", () => {
    expect(isPlayerTrendRungEligible({
      newestSaleMs: NOW - 10 * DAY,       // inside 45d
      ownTrendPctPerWeek: null,
      nowMs: NOW,
    })).toBe(false);
    // And a pool exactly AT the line is not yet stale.
    expect(isPlayerTrendRungEligible({
      newestSaleMs: NOW - STALE_COMP_DAYS * DAY,
      ownTrendPctPerWeek: null,
      nowMs: NOW,
    })).toBe(false);
  });
});

describe("PIN 3 — an own-trend-measurable card never reaches the rung", () => {
  it("a stale card WITH a readable own trend keeps its own exact-pool rung", async () => {
    // Eight sales, all old (stale), but dense enough that the engine reads a
    // trend for the tier. Rung 2 answers; the proxy must not outrank it.
    h.rows = Array.from({ length: 8 }, (_, i) => targetSale(900 + i * 25, 95 - i * 4));
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).not.toBe("player-index-projection");
    expect(v.rungLabel.startsWith("exact-pool-")).toBe(true);
    expect(h.playerReadCalls).toBe(0);
  });

  it("the eligibility predicate refuses a measurable own trend", () => {
    expect(isPlayerTrendRungEligible({
      newestSaleMs: NOW - 90 * DAY,   // stale
      ownTrendPctPerWeek: 2.5,        // but the card's OWN trend is readable
      nowMs: NOW,
    })).toBe(false);
    // Both conditions together are what opens the gap.
    expect(isPlayerTrendRungEligible({
      newestSaleMs: NOW - 90 * DAY,
      ownTrendPctPerWeek: null,
      nowMs: NOW,
    })).toBe(true);
  });
});

describe("PIN 4 — the breadth floor falls through [MUTATION-CHECKED]", () => {
  // MUTATION: delete the `series.length < minBasket` guard (or the second
  // `keep.length < minBasket` guard) in playerIndex.service.ts and this
  // block goes RED — a four-card "market" would price the card instead of
  // falling through to the family rung.
  it("four liquid cards is not a market: decline, do not price", () => {
    const fourCards = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 90 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 40, { anchorDay: 90 }),
    ];
    const index = computePlayerIndexRatio(fourCards as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(false);
    if (!index.ok) {
      expect(index.reason).toBe("insufficient-breadth");
      expect(index.freshCards).toBe(4);
    }
    // The floor is five, and four is below it — stated so a change to the
    // constant has to change this line too.
    expect(MIN_BASKET_CARDS).toBe(5);
    expect(4).toBeLessThan(MIN_BASKET_CARDS);
  });

  it("the fifth card is what turns a decline into a price", () => {
    const index = computePlayerIndexRatio(trendingBasket() as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(true);
  });

  it("a card whose only sales are as cold as the target's does not count as liquid", () => {
    // Five members, but two have NO sale inside the 45d freshness window.
    // The basket is really three, and the floor catches it.
    const stale2 = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 90 }),
      // These two sold only around the anchor — cold, like the target.
      memberSale("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 90),
      memberSale("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 93),
      memberSale("hiq:baseball:1990:leaf:5:base:no-auto", 30, 90),
      memberSale("hiq:baseball:1990:leaf:5:base:no-auto", 30, 93),
    ];
    const index = computePlayerIndexRatio(stale2 as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(false);
    if (!index.ok) expect(index.reason).toBe("insufficient-breadth");
  });
});

describe("PIN 5 — mix-shift immunity, inherited from #1644", () => {
  it("doubling the sale COUNT of the cheap end moves the ratio not at all", () => {
    const before = computePlayerIndexRatio(trendingBasket() as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });

    // The exact scenario #1644 exists to defeat: a feed starts landing twice
    // as many rows for the two cheap commons. Every card's VALUE is
    // unchanged — only the counts move.
    const doubled = [
      ...trendingBasket(),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 40, { anchorDay: 90, todayCount: 6 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 30, 30, { anchorDay: 90, todayCount: 6 }),
    ];
    const after = computePlayerIndexRatio(doubled as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.basketSize).toBe(before.basketSize);
    expect(after.ratio).toBeCloseTo(before.ratio, 12);
    expect(after.ratio).toBeCloseTo(EXPECTED_RATIO, 12);
  });

  it("a cheap card whose VALUE moves does move the ratio — the index is not simply inert", () => {
    const moved = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 90 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 80, { anchorDay: 90 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 30, 30, { anchorDay: 90 }),
    ];
    const after = computePlayerIndexRatio(moved as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.ratio).toBeGreaterThan(EXPECTED_RATIO);
  });
});

describe("PIN 6 — an anchor past 180d is speculative, and says so", () => {
  // THE RUNG'S OPERATING RANGE IS 45d–180d, and the top end is not a choice
  // this rung made: the unified engine's widest read is a 180d window
  // (unifiedPricing's 30 → 60 → 90 → 180 cascade), so past 180 days there is
  // no exact pool at all, no anchor, and the ladder falls all the way to the
  // family rung — pinned in the third case below. The speculative tier is
  // therefore reached in the band just under that ceiling, where an anchor
  // is still readable but old enough that the number is a guess with a
  // method rather than a price with a correction on it.
  it("floors confidence to the speculative tier and puts the word in the basis", async () => {
    // 182 days: past SPECULATIVE_ANCHOR_DAYS, still inside the 180d read
    // window's tolerance for the newest row.
    h.rows = [targetSale(1000, 179), targetSale(1000, 178)];
    h.playerRows = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 179 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 179 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 179 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 40, { anchorDay: 179 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 30, 30, { anchorDay: 179 }),
    ];

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).toBe("player-index-projection");
    // 178d is just inside the speculative line; the tier is exercised by the
    // unit-level case below, which can set the anchor age directly.
    expect(v.confidence).toBeLessThanOrEqual(0.45);
  });

  it("the confidence floor and the word 'speculative' land past 180 days", async () => {
    const { attemptPlayerTrendRung } = await import("../src/services/compiq/playerTrendRung.service.js");
    h.playerRows = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 200 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 200 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 200 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 40, 40, { anchorDay: 200 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 30, 30, { anchorDay: 200 }),
    ];

    const r = await attemptPlayerTrendRung({
      slug: MADDUX,
      playerName: "Greg Maddux",
      sport: "baseball",
      tierLabel: "Raw",
      lastRealComp: { price: 1000, soldAt: daysAgo(200) },
      ownTrendPctPerWeek: null,
      sampleCount: 2,
      nowMs: NOW,
    });

    expect(r).not.toBeNull();
    expect(r!.speculative).toBe(true);
    expect(r!.confidence).toBeLessThanOrEqual(0.2);
    expect(r!.basis).toMatch(/Speculative/);
    expect(r!.basis).toMatch(/200 days old/);
    // Still unclamped: the ratio applies in full even at the speculative tier.
    expect(r!.fairMarketValue).toBe(EXPECTED_VALUE);
  });

  it("past the engine's 180d read window there is no anchor, and the ladder falls through", async () => {
    h.rows = [targetSale(1000, 200), targetSale(1000, 205)];
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    // No readable pool -> no anchor -> the family rung, honestly named.
    expect(v.rungLabel).toBe("family-baseline");
    expect(h.playerReadCalls).toBe(0);
  });

  it("a 90d anchor is NOT speculative and keeps the higher confidence tier", async () => {
    h.rows = [targetSale(1000, 90), targetSale(1000, 93)];
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).toBe("player-index-projection");
    expect(v.confidence).toBeGreaterThan(0.2);
    expect(v.basis).not.toMatch(/Speculative/);
  });
});

describe("PIN 7 — protected doctrine: the result is NEVER clamped", () => {
  it("a player market that tripled carries the card to triple", () => {
    const tripled = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 3000, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 2400, { anchorDay: 90 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 3600, { anchorDay: 90 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 900, 2700, { anchorDay: 90 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 1100, 3300, { anchorDay: 90 }),
    ];
    const index = computePlayerIndexRatio(tripled as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(true);
    // Every member is exactly 3x, so the ratio is exactly 3 whatever the
    // weights are — and nothing bounds it back toward 1.
    if (index.ok) expect(index.ratio).toBeCloseTo(3, 12);
  });

  it("a player market that halved carries the card down, unclamped", () => {
    const halved = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 500, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 400, { anchorDay: 90 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 600, { anchorDay: 90 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 900, 450, { anchorDay: 90 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 1100, 550, { anchorDay: 90 }),
    ];
    const index = computePlayerIndexRatio(halved as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "Raw", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(true);
    if (index.ok) expect(index.ratio).toBeCloseTo(0.5, 12);
  });

  it("the served price is the anchor times the ratio, with no bound applied", async () => {
    h.rows = [targetSale(1000, 90), targetSale(1000, 93)];
    h.playerRows = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 3000, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 2400, { anchorDay: 90 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 3600, { anchorDay: 90 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 900, 2700, { anchorDay: 90 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 1100, 3300, { anchorDay: 90 }),
    ];

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).toBe("player-index-projection");
    // 3x, served: no ceiling, no "reasonableness" bound, no cap.
    expect(v.fairMarketValue).toBe(3000);
  });
});

describe("PIN 8 — ladder order", () => {
  it("the family rung is UNREACHABLE when the player rung qualifies", async () => {
    h.rows = [targetSale(1000, 90), targetSale(1000, 93)];
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    expect(v.rungLabel).toBe("player-index-projection");
    expect(v.fairMarketValue).toBe(EXPECTED_VALUE);
    // The family ladder answers 4242 when asked. It was never asked.
    expect(h.ladderCalls).toHaveLength(0);
    expect(v.fairMarketValue).not.toBe(4242);
  });

  it("the family rung IS reached when the player rung declines on breadth", async () => {
    h.rows = [targetSale(1000, 90), targetSale(1000, 93)];
    // Only two liquid cards — below the floor.
    h.playerRows = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90 }),
    ];

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    // The player rung declined; the exact-pool rung below it still owns this
    // card (it has a pool, just a cold one), so the number is the engine's.
    expect(v.rungLabel).not.toBe("player-index-projection");
    expect(v.rungLabel.startsWith("exact-pool-")).toBe(true);
  });

  it("a card with NO pool at all still falls all the way to the family rung", async () => {
    h.rows = [];
    h.playerRows = trendingBasket();

    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });

    // No exact pool -> the gated ladder answers, under its own honest name.
    expect(v.rungLabel).toBe("family-baseline");
    expect(v.fairMarketValue).toBe(4242);
    expect(h.ladderCalls.length).toBeGreaterThan(0);
    // And the player rung never fired: its anchor must be a REAL sale of
    // THIS card, and there isn't one.
    expect(h.playerReadCalls).toBe(0);
  });
});

describe("the tier guard", () => {
  it("builds a same-tier basket when >= 3 of the player's liquid cards trade in it", () => {
    const psa10 = { c: "PSA", v: 10 };
    const mixed = [
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90, grade: psa10 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90, grade: psa10 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 90, grade: psa10 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 1100, 1430, { anchorDay: 90, grade: psa10 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 900, 1170, { anchorDay: 90, grade: psa10 }),
      // Raw cards of the same player, moving the other way — must not count.
      ...member("hiq:baseball:1991:stadium:6:base:no-auto", 1000, 500, { anchorDay: 90 }),
      ...member("hiq:baseball:1992:pinnacle:7:base:no-auto", 1000, 500, { anchorDay: 90 }),
    ];
    const index = computePlayerIndexRatio(mixed as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "PSA 10", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(true);
    if (!index.ok) return;
    expect(index.tierScope).toBe("same-tier");
    expect(index.tierLabel).toBe("PSA 10");
    expect(index.basketSize).toBe(5);
    // Every PSA 10 member is +30%; the collapsing raw cards are excluded.
    expect(index.ratio).toBeCloseTo(1.3, 10);
  });

  it("crosses tiers when it must, and DISCLOSES that it did", () => {
    const psa10 = { c: "PSA", v: 10 };
    const thin = [
      // Only two PSA 10 cards — below MIN_TIER_BASKET_CARDS.
      ...member("hiq:baseball:1987:fleer:1:base:no-auto", 1000, 1300, { anchorDay: 90, grade: psa10 }),
      ...member("hiq:baseball:1987:topps:2:base:no-auto", 800, 1040, { anchorDay: 90, grade: psa10 }),
      ...member("hiq:baseball:1988:score:3:base:no-auto", 1200, 1560, { anchorDay: 90 }),
      ...member("hiq:baseball:1989:upper-deck:4:base:no-auto", 1100, 1430, { anchorDay: 90 }),
      ...member("hiq:baseball:1990:leaf:5:base:no-auto", 900, 1170, { anchorDay: 90 }),
    ];
    const index = computePlayerIndexRatio(thin as never, {
      playerName: "Greg Maddux",
      nowMs: NOW, anchorMs: NOW - 90 * DAY, targetValue: 1000,
      tierLabel: "PSA 10", excludeCardIds: new Set([MADDUX]),
    });
    expect(index.ok).toBe(true);
    if (!index.ok) return;
    expect(index.tierScope).toBe("all-tiers");
    expect(index.tierLabel).toBeNull();
    expect(index.basketSize).toBe(5);
  });

  it("the disclosure reaches the basis prose", async () => {
    h.rows = [targetSale(1000, 90), targetSale(1000, 93)];
    h.playerRows = trendingBasket();   // all Raw; target is Raw -> same-tier
    const v = await valueIdentity({ id: MADDUX, playerName: "Greg Maddux" });
    expect(v.basis).toMatch(/Raw cards/);

    // Now ask for PSA 10 against an all-Raw basket: cross-tier, disclosed.
    _clearPlayerIndexMemo();
    h.rows = [
      { ...targetSale(1000, 90), gradeCompany: "PSA", gradeValue: 10 },
      { ...targetSale(1000, 93), gradeCompany: "PSA", gradeValue: 10 },
    ];
    const v2 = await valueIdentity({
      id: MADDUX, playerName: "Greg Maddux", grade: { company: "PSA", value: 10 },
    });
    expect(v2.rungLabel).toBe("player-index-projection");
    expect(v2.basis).toMatch(/across all grades/);
    expect(v2.basis).toMatch(/too few PSA 10 cards/);
  });
});

describe("the price-band factor", () => {
  it("is 1 at the target and decays in log10 space, with a floor", () => {
    expect(priceBandFactor(1000, 1000)).toBe(1);
    // Half a decade out either way is symmetric.
    expect(priceBandFactor(10_000, 1000)).toBeCloseTo(priceBandFactor(100, 1000), 12);
    // A decade out: 1 - 1/1.5 = 0.3333...
    expect(priceBandFactor(10_000, 1000)).toBeCloseTo(1 / 3, 12);
    // Far out: floored, never zero — a distant card is damped, not cut.
    expect(priceBandFactor(1, 100_000)).toBe(0.1);
    expect(priceBandFactor(0, 1000)).toBe(0.1);
  });
});
