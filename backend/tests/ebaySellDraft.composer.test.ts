// CF-EBAY-SELL-LOOP (Drew, 2026-09-02). The pins for the listing draft.
//
// What these lock is not "the composer runs" — it is the doctrine:
//
//   1. The price is the ENGINE's projection with its rung label. The
//      composer serves what computeCanonicalFmv answered and never
//      computes, adjusts or invents a number.
//   2. A speculative or self-anchored value carries its label INTO the
//      draft text. Not into a tooltip, not into an optional field the
//      client may drop — into the description block a buyer reads.
//   3. When the engine declines, there is NO price. The composer does not
//      fall back to a stored field, which is exactly the bug this shipped
//      to fix.
//
// The engine is injected, so none of this touches Cosmos or a comp pool.

import { describe, expect, it } from "vitest";

import {
  composeSellDraftPricing,
  buildBasisBlock,
  appendBasisBlock,
  priceSummaryLine,
  labelsForResult,
  type SellDraftHolding,
} from "../src/services/ebay/ebaySellDraft.service.js";
import type { CanonicalFmvResult } from "../src/services/compiq/canonicalFmv.service.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The fixture holding: a real-shaped Bowman Chrome auto, identified. */
function holding(over: Partial<SellDraftHolding> = {}): SellDraftHolding {
  return {
    cardId: "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto:num-150",
    playerName: "Theo Gillen",
    cardYear: 2024,
    product: "Bowman Chrome",
    setName: "Bowman Chrome",
    parallel: "Blue Refractor",
    cardNumber: "CPA-TG",
    gradeCompany: "PSA",
    gradeValue: 10,
    printRun: 150,
    isAuto: true,
    sport: "baseball",
    ...over,
  };
}

type Comp = CanonicalFmvResult["provenance"]["comps"][number];

function comp(over: Partial<Comp> = {}): Comp {
  return {
    price: 700,
    soldAt: "2026-08-20T00:00:00.000Z",
    source: "ebay-browse-ended",
    parallel: "Blue Refractor",
    verifiedByUser: false,
    ...over,
  };
}

function fmvResult(over: Partial<CanonicalFmvResult> = {}): CanonicalFmvResult {
  return {
    fmv: 729.5,
    method: "direct-comp",
    rungLabel: "exact-pool-projection",
    confidence: 0.82,
    provenance: {
      summary: "6 same-parallel comps + 4%/mo player momentum",
      // 6 comps priced it; `comps` carries the display sample the engine
      // truncates to. compCount is the pool, comps.length is the sample.
      compCount: 6,
      comps: [comp(), comp({ price: 750 })],
      trendPctPerMonth: 4,
      multipliers: {},
    },
    computedAt: "2026-09-02T12:00:00.000Z",
    recentRange: { n: 6, min: 640, p25: 690, median: 715, p75: 745, max: 810 },
    ...over,
  } as CanonicalFmvResult;
}

/** An injected engine that answers with `result` and records the input. */
function engine(result: CanonicalFmvResult) {
  const calls: unknown[] = [];
  return {
    calls,
    computeFmv: async (input: unknown) => {
      calls.push(input);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// PIN 1 — the price is the engine's, with its rung
// ---------------------------------------------------------------------------

describe("draft price comes from the engine, labelled", () => {
  it("serves the engine's projection and its rung label", async () => {
    const e = engine(fmvResult());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    expect(pricing.status).toBe("engine");
    // 729.50 -> cents, unchanged. No rounding policy of our own.
    expect(pricing.priceCents).toBe(72950);
    expect(pricing.rungLabel).toBe("exact-pool-projection");
    expect(pricing.exactPool).toBe(true);
    expect(pricing.confidence).toBe(0.82);
    expect(pricing.basis).toBe("6 same-parallel comps + 4%/mo player momentum");
    // The POOL that priced it (6), not the 2-row display sample.
    expect(pricing.compCount).toBe(6);
    expect(pricing.range).toEqual({ n: 6, min: 640, median: 715, max: 810 });
    // A clean exact-pool answer needs no disclosure.
    expect(pricing.labels).toEqual([]);
  });

  it("asks the engine with the holding's identity, not a re-derived one", async () => {
    const e = engine(fmvResult());
    await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    expect(e.calls).toHaveLength(1);
    expect(e.calls[0]).toMatchObject({
      cardId: "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto:num-150",
      parallel: "Blue Refractor",
      gradeCompany: "PSA",
      gradeValue: 10,
      cardYear: 2024,
      cardNumber: "CPA-TG",
      player: "Theo Gillen",
    });
  });

  it("prefers hobbyiqCardId over a vendor cardId", async () => {
    const e = engine(fmvResult());
    await composeSellDraftPricing(
      holding({ hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:cpa-tg:base:auto" }),
      { computeFmv: e.computeFmv },
    );
    expect((e.calls[0] as { cardId: string }).cardId).toBe(
      "hiq:baseball:2024:bowman-chrome:cpa-tg:base:auto",
    );
  });

  it("NEVER falls back to a stored price field when the engine declines", async () => {
    // The bug this fixed: prepare read predictedPrice/fairMarketValue off
    // the holding. Those fields are present here and must be ignored.
    const stale = holding() as SellDraftHolding & Record<string, unknown>;
    stale.predictedPrice = 999;
    stale.fairMarketValue = 888;
    stale.estimatedValue = 777;

    const e = engine(
      fmvResult({
        fmv: null,
        method: "no-basis",
        rungLabel: "no-basis",
        confidence: 0,
        provenance: { summary: "no rung produced a value", comps: [], trendPctPerMonth: null, multipliers: {} },
        recentRange: null,
      }),
    );
    const { pricing } = await composeSellDraftPricing(stale, { computeFmv: e.computeFmv });

    expect(pricing.status).toBe("engine-declined");
    expect(pricing.priceCents).toBeNull();
    // The rung that declined is still named.
    expect(pricing.rungLabel).toBe("no-basis");
    expect(pricing.declineReason).toContain("no rung produced a value");
  });

  it("does not call the engine at all when the holding has no identity", async () => {
    const e = engine(fmvResult());
    const { pricing } = await composeSellDraftPricing(
      holding({ cardId: null, hobbyiqCardId: null }),
      { computeFmv: e.computeFmv },
    );

    expect(e.calls).toHaveLength(0);
    expect(pricing.status).toBe("no-identity");
    expect(pricing.priceCents).toBeNull();
    expect(pricing.declineReason).toContain("no confirmed card identity");
  });

  it("an engine failure yields no price, never a guess", async () => {
    const { pricing } = await composeSellDraftPricing(holding(), {
      computeFmv: async () => {
        throw new Error("cosmos timeout");
      },
    });
    expect(pricing.status).toBe("engine-error");
    expect(pricing.priceCents).toBeNull();
    expect(pricing.declineReason).toContain("cosmos timeout");
  });
});

// ---------------------------------------------------------------------------
// PIN 2 — labels, and their journey into the draft text
// ---------------------------------------------------------------------------

describe("speculative and self-anchored values carry their labels", () => {
  it("labels a player-index projection speculative, in those words", async () => {
    const e = engine(
      fmvResult({
        method: "tiered-momentum-player",
        rungLabel: "player-index-projection",
        confidence: 0.4,
        provenance: {
          summary: "last real sale 2026-03-01 carried on player index",
          comps: [comp({ soldAt: "2026-03-01T00:00:00.000Z" })],
          trendPctPerMonth: 2,
          multipliers: {},
        },
      }),
    );
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    expect(pricing.exactPool).toBe(false);
    const spec = pricing.labels.find((l) => l.code === "speculative");
    expect(spec).toBeDefined();
    expect(spec!.text.toLowerCase()).toContain("speculative");

    // And it reaches the buyer-facing text.
    const block = buildBasisBlock(pricing);
    expect(block.toLowerCase()).toContain("speculative");
  });

  it("labels a pool anchored only on the seller's own purchase", async () => {
    const e = engine(
      fmvResult({
        provenance: {
          summary: "1 self-comp",
          // The whole pool is that one self-comp — pool and sample agree,
          // so "the only sale" is literally true.
          compCount: 1,
          comps: [comp({ source: "holding::abc-123" })],
          trendPctPerMonth: null,
          multipliers: {},
        },
      }),
    );
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    const self = pricing.labels.find((l) => l.code === "self-anchored");
    expect(self).toBeDefined();
    expect(self!.text).toContain("your own purchase");
    expect(buildBasisBlock(pricing)).toContain("your own purchase");
  });

  it("counts a partly self-anchored pool honestly", () => {
    const labels = labelsForResult(
      fmvResult({
        provenance: {
          summary: "mixed",
          compCount: 3,
          comps: [comp({ verifiedByUser: true }), comp(), comp()],
          trendPctPerMonth: null,
          multipliers: {},
        },
      }),
    );
    const self = labels.find((l) => l.code === "self-anchored");
    expect(self!.text).toContain("1 of 3");
  });

  it("names a fallback rung when the exact pool did not answer", () => {
    const labels = labelsForResult(
      fmvResult({ method: "cross-parallel", rungLabel: "cross-parallel" }),
    );
    const fb = labels.find((l) => l.code === "fallback-rung");
    expect(fb).toBeDefined();
    expect(fb!.text).toContain("cross-parallel");
  });

  it("does not double up 'fallback' on a speculative rung", () => {
    const labels = labelsForResult(
      fmvResult({ rungLabel: "player-index-projection", confidence: 0.9 }),
    );
    expect(labels.map((l) => l.code)).toEqual(["speculative"]);
  });

  it("says so when confidence is thin", () => {
    const labels = labelsForResult(fmvResult({ confidence: 0.2 }));
    expect(labels.some((l) => l.code === "low-confidence")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PIN 3 — the description block is honest
// ---------------------------------------------------------------------------

describe("the basis block", () => {
  it("states the price, the rung in plain words, and the evidence", async () => {
    const e = engine(fmvResult());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    const block = buildBasisBlock(pricing);

    expect(block).toContain("How this price was set");
    expect(block).toContain("$729.50");
    expect(block).toContain("projected next sale");
    expect(block).toContain("the sales trend for this exact card and grade");
    // The pool that priced it (6), not the 2-row display sample.
    expect(block).toContain("6 sales");
    expect(block).toContain("$640.00");
    expect(block).toContain("$810.00");
    expect(block).toContain("Projection, not a guarantee");
    // It never claims certainty.
    expect(block.toLowerCase()).not.toContain("guaranteed");
  });

  it("reproduces EVERY label, not just the loudest", async () => {
    const e = engine(
      fmvResult({
        rungLabel: "player-index-projection",
        confidence: 0.15,
        provenance: {
          summary: "cold pool",
          compCount: 1,
          comps: [comp({ source: "holding::abc" })],
          trendPctPerMonth: null,
          multipliers: {},
        },
      }),
    );
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    expect(pricing.labels.map((l) => l.code)).toEqual([
      "speculative",
      "self-anchored",
      "low-confidence",
    ]);

    const block = buildBasisBlock(pricing);
    for (const l of pricing.labels) {
      // Each label's own sentence is present (apostrophes survive escaping).
      expect(block).toContain(l.text.slice(0, 40));
    }
  });

  it("makes NO claim when the price is not HobbyIQ's", async () => {
    const e = engine(fmvResult({ fmv: null, rungLabel: "no-basis" }));
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    expect(buildBasisBlock(pricing)).toBe("");
    // and appending it leaves the seller's body untouched
    expect(appendBasisBlock("<b>My card</b>", pricing)).toBe("<b>My card</b>");
  });

  it("appends after the seller's body rather than replacing it", async () => {
    const e = engine(fmvResult());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    const out = appendBasisBlock("<b>Mint condition, ships fast</b>", pricing);

    expect(out.startsWith("<b>Mint condition, ships fast</b>")).toBe(true);
    expect(out).toContain("How this price was set");
  });

  it("escapes interpolated text so the block cannot inject markup", () => {
    const labels = labelsForResult(
      fmvResult({
        // A rung name is closed vocabulary, but the escape is belt-and-braces.
        rungLabel: "cross-parallel",
      }),
    );
    expect(labels.some((l) => l.code === "fallback-rung")).toBe(true);
  });

  it("summarises the price in one line for the seller", async () => {
    const e = engine(fmvResult());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    expect(priceSummaryLine(pricing)).toContain("$729.50");
    expect(priceSummaryLine(pricing)).toContain("projected next sale");
  });

  it("the summary explains a decline instead of showing a number", async () => {
    const e = engine(fmvResult({ fmv: null, rungLabel: "no-basis" }));
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    expect(priceSummaryLine(pricing)).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// PIN 4 — the sell signal is context, never a price input
// ---------------------------------------------------------------------------

describe("sell-signal context", () => {
  it("rides along without touching the price", async () => {
    const e = engine(fmvResult());
    const withTrend = holding({
      confidence: 0.8,
      lastUpdated: new Date().toISOString(),
    });
    const bare = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    const trended = await composeSellDraftPricing(withTrend, { computeFmv: e.computeFmv });

    // A signal is present either way (a `none` carries its reason), and the
    // price is byte-identical across both.
    expect(trended.sellSignal).not.toBeNull();
    expect(trended.pricing.priceCents).toBe(bare.pricing.priceCents);
  });

  it("a holding with no trend gets a none carrying its reason", async () => {
    const e = engine(fmvResult());
    const { sellSignal } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    expect(sellSignal!.signal).toBe("none");
    expect(sellSignal!.reason).toBe("no-trend-data");
  });
});

// ---------------------------------------------------------------------------
// PIN — the count a buyer reads is the POOL, never the display sample
// ---------------------------------------------------------------------------
//
// CF-COMP-COUNT-IS-THE-POOL (Drew, 2026-09-02). canonicalFmv.service.ts
// truncates `provenance.comps` to the first 8-10 rows at every rung that
// has comps — it is a display sample for the transparency sheet, not the
// evidence pool. Reading its length told a buyer "Based on 8 sales" for a
// card with 726 same-parallel comps, and "1 of 8 are your own" when the
// truth was 1 of 15. Both numbers reach listing text a buyer acts on, so
// both must come from the engine's own pool total.
//
// The fixture is exactly that shape: a pool of 15 with a sample of 8.

describe("the sale count is the evidence pool, not the truncated sample", () => {
  /** 8 sampled rows out of a 15-comp pool — one of them the seller's own. */
  const truncated = () =>
    fmvResult({
      provenance: {
        summary: "15 same-parallel comps + 4%/mo player momentum",
        compCount: 15,
        comps: [
          comp({ source: "holding::mine-1" }),
          comp({ price: 705 }),
          comp({ price: 710 }),
          comp({ price: 715 }),
          comp({ price: 720 }),
          comp({ price: 725 }),
          comp({ price: 730 }),
          comp({ price: 735 }),
        ],
        trendPctPerMonth: 4,
        multipliers: {},
      },
    });

  it("reports the pool total, not the sample length", async () => {
    const e = engine(truncated());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    // The sample really is 8 rows — that is the shape being defended against.
    expect(truncated().provenance.comps).toHaveLength(8);
    expect(pricing.compCount).toBe(15);
    expect(pricing.compCount).not.toBe(8);
  });

  it("writes the pool total into the buyer-facing basis block", async () => {
    const e = engine(truncated());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    const block = buildBasisBlock(pricing);

    expect(block).toContain("Based on 15 sales");
    expect(block).not.toContain("Based on 8 sales");
  });

  it("states the self-anchored ratio against the same denominator", async () => {
    const e = engine(truncated());
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    const self = pricing.labels.find((l) => l.code === "self-anchored");
    expect(self).toBeDefined();
    expect(self!.text).toContain("1 of 15");
    expect(self!.text).not.toContain("1 of 8");
    // And it reaches the text a buyer actually reads.
    expect(buildBasisBlock(pricing)).toContain("1 of 15");
  });

  it("does not call a sampled pool wholly self-anchored", async () => {
    // Every SAMPLED row is the seller's own, but the pool is 15. Saying
    // "the only sale behind this estimate is your own" would be false.
    const e = engine(
      fmvResult({
        provenance: {
          summary: "15 comps",
          compCount: 15,
          comps: [comp({ source: "holding::a" }), comp({ source: "holding::b" })],
          trendPctPerMonth: null,
          multipliers: {},
        },
      }),
    );
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });

    const self = pricing.labels.find((l) => l.code === "self-anchored");
    expect(self!.text).toContain("2 of 15");
    expect(self!.text).not.toContain("the only sale");
  });

  it("falls back to the sample only when the engine reports no count", async () => {
    // Results minted before compCount existed still render a number, and
    // it can only understate the pool, never overstate it.
    const e = engine(
      fmvResult({
        provenance: {
          summary: "legacy result",
          compCount: null,
          comps: [comp(), comp()],
          trendPctPerMonth: null,
          multipliers: {},
        },
      }),
    );
    const { pricing } = await composeSellDraftPricing(holding(), { computeFmv: e.computeFmv });
    expect(pricing.compCount).toBe(2);
  });
});
