/**
 * CF-MARKET-READ (2026-06-08) — fact pack + template + validator unit
 * tests. No supertest, no network — pure-function coverage.
 */
import { describe, it, expect } from "vitest";
import {
  buildMarketReadFactPack,
  templateMarketRead,
  validateMarketReadNumbers,
  hashFactPack,
  buildLLMPrompt,
  generateMarketRead,
  isConditionReason,
  pickCardImageUrl,
  type MarketReadFactPack,
} from "../src/services/compiq/marketRead.service";

const TROUT_ID = "fda530ab-e925-460e-ab88-63199ef975e9";

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function rec(
  price: number,
  title: string,
  daysAgo: number,
  listing_type: "fixed" | "auction" | null = "fixed",
) {
  return {
    price,
    title,
    date: isoDaysAgo(daysAgo),
    source: "ebay" as const,
    listing_type,
    url: null,
  };
}

function makeTroutPricing() {
  // Mirror the live Trout 21d window snapshot — 11 clean fixed-price
  // sales + 4 auction sales in 14d, plus older comps for the older
  // window. Cardsight returns these as `raw.records[]`.
  return {
    card: {
      card_id: TROUT_ID,
      name: "Mike Trout",
      number: "US175",
      set: { set_id: "fake", name: "Base Set", year: "2011", release: "Topps Update" },
    },
    raw: {
      count: 19,
      records: [
        // Fixed-price 14d (10 clean + 1 Flawless = 11)
        rec(200, "2011 Topps Update Mike Trout RC Rookie #US175 Angels", 3, "fixed"),
        rec(248.99, "2011 Topps Update Series - Mike Trout #US175 (RC) - Future HOF Legend", 15, "fixed"),
        rec(250, "2011 Topps Update Series - Mike Trout #US175 (RC)", 12, "fixed"),
        rec(299.99, "2011 Topps Update Series - Mike Trout #US175 (RC)", 13, "fixed"),
        rec(309.99, "2011 TOPPS UPDATE SERIES - MIKE TROUT #US175 - GREAT CONDITION MINT!!", 4, "fixed"),
        rec(319.99, "Topps 2011 Update Series Mike Trout Angels #US175 Rookie Card", 0, "fixed"),
        rec(420, "2011 Topps Update #US175 Mike Trout Rookie RC", 2, "fixed"),
        rec(470.27, "2011 Topps Update Mike Trout #US175 4f5", 12, "fixed"),
        rec(480, "2011 Topps Update Series - Mike Trout #US175 (RC)", 3, "fixed"),
        rec(500, "Topps 2011 Update Series Mike Trout #US175 Rookie Los Angeles Angels MLB", 6, "fixed"),
        rec(650, "2011 Topps Update Series - Mike Trout #US175 (RC) Flawless Mint Condition", 5, "fixed"),
        // Auction 14d (4)
        rec(158, "2011 Topps Update Mike Trout RC Rookie #US175 Angels Corner Damage", 9, "auction"),
        rec(183.52, "MIKE TROUT 2011 TOPPS UPDATE ROOKIE #US175 ANGELS RC Q0M-621", 4, "auction"),
        rec(235.5, "2011 Topps Update Series - Mike Trout #US175 (RC)", 6, "auction"),
        rec(250.02, "2011 Topps Update Mike Trout RC Rookie #US175 Angels", 5, "auction"),
        // Older window (15-30d) for the trajectory's older bucket
        rec(350, "Topps 2011 Update Series Mike Trout Rookie #US175 Los Angeles Angels MLB", 15, "fixed"),
        rec(350, "2011 Topps Update Series - Mike Trout #US175 (RC)", 18, "fixed"),
        rec(376, "2011 Topps Update #US175 Mike Trout Angels RC Rookie", 17, "auction"),
        rec(295, "2011 Topps Update Series Mike Trout #US175 (RC) Future Hall Of Famer", 17, "fixed"),
      ],
    },
    graded: [],
    meta: { total_records: 19, last_sale_date: isoDaysAgo(0) },
  } as any;
}

describe("buildMarketReadFactPack", () => {
  it("assembles bin/auction split from the 14d clean pool", () => {
    const pricing = makeTroutPricing();
    const est = {
      compsUsed: 22,
      compsAvailable: 26,
      fairMarketValue: 368,
      trendIQ: {
        components: { cardTrajectory: { pctChange: 0 } },
        composite: 1.0,
        direction: "flat",
      },
    };
    const fp = buildMarketReadFactPack(pricing, "Raw", est, TROUT_ID);

    expect(fp.cardId).toBe(TROUT_ID);
    expect(fp.grade).toBe("Raw");
    expect(fp.windowDays).toBe(14);
    expect(fp.sampleUsed).toBe(22);
    expect(fp.sampleAvailable).toBe(26);

    // Fixed-price 14d (the 11 clean BIN sales above; the "Corner Damage"
    // and "Flawless..." entries also classify as fixed but Corner Damage
    // gets keyword-excluded, Flawless survives post-CF-EXCLUSION-WORD-BOUNDARY).
    // Bin count: 10 clean + 1 Flawless = 11. NOTE: $200 has no damage
    // keyword in its title here so it survives.
    expect(fp.binCount).toBeGreaterThanOrEqual(10);
    expect(fp.binMedian).toBeGreaterThan(300);

    // Auction 14d (4 entries above; $158 Corner Damage is keyword-excluded
    // so 3 survive).
    expect(fp.auctionCount).toBeGreaterThanOrEqual(3);
    expect(fp.auctionMedian).toBeLessThan(300);

    // Trend
    expect(fp.trendPct).toBe(0);
    expect(fp.trendDirection).toBe("flat");

    // FMV pass-through
    expect(fp.fmv).toBe(368);
  });

  it("emits exclusion histogram with friendly labels", () => {
    const pricing = makeTroutPricing();
    const est = {
      compsUsed: 22,
      compsAvailable: 26,
      fairMarketValue: 368,
      trendIQ: { components: { cardTrajectory: { pctChange: 0 } } },
    };
    const fp = buildMarketReadFactPack(pricing, "Raw", est, TROUT_ID);

    // At least the "Corner Damage" comp should have been excluded.
    expect(fp.excludedCount).toBeGreaterThanOrEqual(1);
    expect(fp.topExclusionReasons.length).toBeGreaterThanOrEqual(1);
    const damageReason = fp.topExclusionReasons.find((r) =>
      r.reason.includes("damage") || r.label.toLowerCase().includes("damage"),
    );
    expect(damageReason).toBeDefined();
    // Label is plain-language, not raw keyword.
    expect(damageReason?.label).not.toContain("keyword:");
  });

  it("handles empty pool gracefully (null medians, 0 counts)", () => {
    const empty = {
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    } as any;
    const est = { compsUsed: 0, compsAvailable: 0, fairMarketValue: null };
    const fp = buildMarketReadFactPack(empty, "Raw", est, TROUT_ID);
    expect(fp.binCount).toBe(0);
    expect(fp.binMedian).toBeNull();
    expect(fp.auctionCount).toBe(0);
    expect(fp.auctionMedian).toBeNull();
    expect(fp.priceMin).toBeNull();
    expect(fp.priceMax).toBeNull();
    expect(fp.fmv).toBeNull();
  });
});

describe("templateMarketRead", () => {
  const baseFp: MarketReadFactPack = {
    cardId: TROUT_ID,
    grade: "Raw",
    sampleUsed: 22,
    sampleAvailable: 26,
    windowDays: 14,
    priceMin: 183.52,
    priceMax: 650,
    binMedian: 420,
    binCount: 9,
    binPriceMin: 200,
    binPriceMax: 650,
    auctionMedian: 235.5,
    auctionCount: 3,
    trendDirection: "flat",
    trendPct: 0,
    excludedCount: 4,
    excludedPriceMin: 158,
    excludedPriceMax: 200,
    topExclusionReasons: [
      { reason: "keyword:please read", count: 2, label: "seller condition warnings" },
      { reason: "keyword:damage", count: 2, label: "seller-described damage" },
    ],
    fmv: 368,
  };

  it("emits an advisor-voice 3-sentence summary for the Trout-shaped fact pack", () => {
    // CF-MARKET-READ-ADVISOR-VOICE (2026-06-08): S1+S2 merged into a
    // benchmark + selling-counsel sentence; S3 is trend counsel (flat
    // drops the pct); S4 keeps the damaged/read callout.
    const text = templateMarketRead(baseFp);
    // S1+S2 — advisor-toned benchmark.
    expect(text).toContain("For a clean raw copy");
    expect(text).toContain("anchor to the fixed-price market");
    expect(text).toContain("settling around $420");
    expect(text).toContain("9 sales");
    expect(text).toContain("$200");   // binPriceMin
    expect(text).toContain("$650");   // binPriceMax
    expect(text).toContain("auctions close lower near $236");
    expect(text).toContain("listing it and being patient tends to beat a quick auction");
    // Sample-size opener is GONE.
    expect(text).not.toContain("Based on");
    expect(text).not.toContain("22 of 26");
    expect(text).not.toContain("14 days");
    expect(text).not.toContain("Buy It Now");
    // Whole-dollar rounding intact.
    expect(text).not.toContain("$235.5");
    // S3 — flat trend, no pct.
    expect(text).toContain("The market's held steady the past two weeks");
    expect(text).toContain("no urgency either direction");
    expect(text).not.toContain("holding roughly flat");
    expect(text).not.toContain("at 0%");
    // S4 — unchanged damaged/read variant.
    expect(text).toContain("The 4 cheapest sales");
    expect(text).toContain("$158");
    expect(text).toContain("that's why they sold low");
    expect(text).toContain("Don't value a clean card against them");
    expect(text).toContain("seller-described damage");
  });

  // CF-MARKET-READ-EXCLUDED-CALLOUT (2026-06-08): three variants.

  it("S4 damaged/read variant: condition reasons → cheapest-callout advisory", () => {
    const text = templateMarketRead(baseFp);
    expect(text).toContain("The 4 cheapest sales");
    expect(text).toContain("are flagged for");
    expect(text).toContain("that's why they sold low");
    expect(text).toContain("Don't value a clean card against them");
    // Does NOT cite outlier in the condition variant (even if outliers
    // were also present, the variant focuses on condition reasons).
    expect(text).not.toContain("outlier");
    expect(text).not.toContain("set aside");
  });

  it("S4 damaged/read singular: 1 excluded sale → 'The cheapest sale ... is flagged ...'", () => {
    const fpOne = {
      ...baseFp,
      excludedCount: 1,
      excludedPriceMin: 175,
      excludedPriceMax: 175,
      topExclusionReasons: [
        { reason: "keyword:please read", count: 1, label: "seller condition warnings" },
      ],
    };
    const text = templateMarketRead(fpOne);
    expect(text).toContain("The cheapest sale (around $175) is flagged for seller condition warnings");
    expect(text).toContain("that's why it sold low");
    expect(text).toContain("Don't value a clean card against it");
  });

  it("S4 outlier-only variant: only 'outlier' reason → neutral 'set aside as outliers'", () => {
    const fpOutlier = {
      ...baseFp,
      excludedCount: 2,
      excludedPriceMin: 870,
      excludedPriceMax: 1200,
      topExclusionReasons: [
        { reason: "outlier", count: 2, label: "price outliers" },
      ],
    };
    const text = templateMarketRead(fpOutlier);
    expect(text).toContain("2 sales were set aside as outliers");
    // Does NOT claim damaged/read on an outlier-only exclusion.
    expect(text).not.toContain("damaged");
    expect(text).not.toContain("read description");
    expect(text).not.toContain("cheapest");
    expect(text).not.toContain("Don't value a clean card");
  });

  it("S4 outlier-only singular: 1 outlier → 'was set aside as outlier' (still plural noun is fine)", () => {
    const fpOne = {
      ...baseFp,
      excludedCount: 1,
      excludedPriceMin: 1200,
      excludedPriceMax: 1200,
      topExclusionReasons: [
        { reason: "outlier", count: 1, label: "price outliers" },
      ],
    };
    const text = templateMarketRead(fpOne);
    expect(text).toContain("1 sale was set aside as outliers");
  });

  it("S4 generic variant: non-condition non-outlier reasons (e.g. lot sales) → generic exclusion line", () => {
    const fpLot = {
      ...baseFp,
      excludedCount: 3,
      excludedPriceMin: 30,
      excludedPriceMax: 80,
      topExclusionReasons: [
        { reason: "keyword:lot of", count: 2, label: "lot sales" },
        { reason: "keyword:digital", count: 1, label: "non-physical listings" },
      ],
    };
    const text = templateMarketRead(fpLot);
    expect(text).toContain("3 sales");
    expect(text).toContain("(between $30 and $80)");
    expect(text).toContain("were excluded for lot sales or non-physical listings");
    // Generic variant does NOT use the damaged/read advisory.
    expect(text).not.toContain("Don't value a clean card");
    expect(text).not.toContain("set aside as outliers");
  });

  it("S4 mixed condition + outlier: damaged/read variant fires (condition wins), cites only condition labels", () => {
    const fpMixed = {
      ...baseFp,
      excludedCount: 5,
      excludedPriceMin: 158,
      excludedPriceMax: 870,
      topExclusionReasons: [
        { reason: "keyword:damage", count: 2, label: "seller-described damage" },
        { reason: "outlier", count: 2, label: "price outliers" },
        { reason: "keyword:please read", count: 1, label: "seller condition warnings" },
      ],
    };
    const text = templateMarketRead(fpMixed);
    // Damaged/read variant phrasing
    expect(text).toContain("The 5 cheapest sales");
    expect(text).toContain("that's why they sold low");
    // Cites ONLY the condition labels, not "price outliers"
    expect(text).toContain("seller-described damage");
    expect(text).toContain("seller condition warnings");
    expect(text).not.toContain("price outliers");
  });

  it("suppresses auction clause when auction side is n<2 (bin-only advisor)", () => {
    const fpOnlyBin = { ...baseFp, auctionCount: 0, auctionMedian: null };
    const text = templateMarketRead(fpOnlyBin);
    expect(text).not.toContain("auctions");
    // Still leads with the benchmark + fixed-price anchor; no Buy It
    // Now naming in advisor voice.
    expect(text).toContain("anchor to the fixed-price market");
    expect(text).toContain("settling around $420");
  });

  it("auction-only variant (binCount<3, auctionCount>=3): advisor counsel still names fixed-price as patience option", () => {
    const fpAuctionOnly = { ...baseFp, binCount: 0, binMedian: null, binPriceMin: null, binPriceMax: null, auctionCount: 5, auctionMedian: 220 };
    const text = templateMarketRead(fpAuctionOnly);
    expect(text).toContain("Recent activity is mostly auctions (5 sales)");
    expect(text).toContain("closing around $220");
    expect(text).toContain("auction closes typically run below fixed-price");
    expect(text).toContain("listing it and being patient may beat a quick auction");
  });

  it("emits up/down trend counsel (advisor voice) with the directional pct", () => {
    const fpUp = { ...baseFp, trendDirection: "up" as const, trendPct: 12.5 };
    const upText = templateMarketRead(fpUp);
    expect(upText).toContain("Momentum's building");
    expect(upText).toContain("buyers are paying up about 12.5%");
    expect(upText).not.toContain("ticked up");

    const fpDown = { ...baseFp, trendDirection: "down" as const, trendPct: -15.4 };
    const downText = templateMarketRead(fpDown);
    expect(downText).toContain("Cooling off about 15.4%");
    expect(downText).toContain("if you're selling, sooner may beat later");
    expect(downText).not.toContain("median is off");
  });

  it("flat trend drops the pct from prose entirely", () => {
    const fpFlat = { ...baseFp, trendDirection: "flat" as const, trendPct: 1.6 };
    const text = templateMarketRead(fpFlat);
    expect(text).toContain("The market's held steady the past two weeks");
    expect(text).toContain("no urgency either direction");
    // No "1.6%" or "at X%" anywhere in the flat sentence.
    expect(text).not.toContain("1.6%");
    expect(text).not.toContain("holding roughly flat");
  });

  it("graded grade drops 'clean' from openingNoun ('PSA 10 copy' not 'clean PSA 10 copy')", () => {
    const fpPSA = {
      ...baseFp,
      grade: "PSA 10",
      binMedian: 1200,
      binPriceMin: 1000,
      binPriceMax: 1450,
      auctionMedian: 950,
    };
    const text = templateMarketRead(fpPSA);
    expect(text).toContain("For a PSA 10 copy");
    expect(text).not.toContain("clean PSA 10");
  });

  it("auction-median NOT lower than BIN: drops the 'patience' counsel and uses neutral phrasing", () => {
    const fpEven = { ...baseFp, auctionMedian: 425 }; // > binMedian 420
    const text = templateMarketRead(fpEven);
    expect(text).toContain("auctions are landing near $425");
    expect(text).toContain("either route can work");
    expect(text).not.toContain("close lower");
    expect(text).not.toContain("being patient tends to beat");
  });

  it("emits the advisor thin-sample sentence when sampleUsed is 0", () => {
    const fpThin = { ...baseFp, sampleUsed: 0, binCount: 0, auctionCount: 0, excludedCount: 0 };
    const text = templateMarketRead(fpThin);
    expect(text).toContain("Too few recent raw sales to give a confident benchmark");
    // Even thin sample still gets a trend counsel sentence (flat default).
    expect(text).toContain("The market's held steady");
  });
});

describe("validateMarketReadNumbers", () => {
  const fp: MarketReadFactPack = {
    cardId: TROUT_ID,
    grade: "Raw",
    sampleUsed: 22,
    sampleAvailable: 26,
    windowDays: 14,
    priceMin: 200,
    priceMax: 650,
    binMedian: 315,
    binCount: 11,
    binPriceMin: 200,
    binPriceMax: 650,
    auctionMedian: 210,
    auctionCount: 4,
    trendDirection: "flat",
    trendPct: 0,
    excludedCount: 4,
    excludedPriceMin: 158,
    excludedPriceMax: 200,
    topExclusionReasons: [],
    fmv: 368,
  };

  it("accepts a paragraph using only fact-pack numbers", () => {
    const text =
      "Based on 22 of 26 raw sales over the last 14 days. Buy It Now listings (11 sales) cluster around $315 with most of the spread between $200 and $650. Auctions tend toward $210.";
    const v = validateMarketReadNumbers(text, fp);
    expect(v.ok).toBe(true);
    expect(v.offendingNumbers).toEqual([]);
  });

  it("rejects a paragraph with a hallucinated number", () => {
    const text =
      "Based on 22 of 26 raw sales over the last 14 days. The market is at $999."; // 999 not in fact pack
    const v = validateMarketReadNumbers(text, fp);
    expect(v.ok).toBe(false);
    expect(v.offendingNumbers).toContain(999);
  });

  it("accepts absolute value of negative trend pct", () => {
    const fpDown = { ...fp, trendPct: -9.7 };
    const text = "Recent vs prior median is off about 9.7%.";
    const v = validateMarketReadNumbers(text, fpDown);
    expect(v.ok).toBe(true);
  });

  it("always accepts the literal 0", () => {
    const text = "0 sales were excluded. The pool is holding flat at 0%.";
    const v = validateMarketReadNumbers(text, fp);
    expect(v.ok).toBe(true);
  });
});

describe("hashFactPack + buildLLMPrompt", () => {
  const fpA: MarketReadFactPack = {
    cardId: TROUT_ID,
    grade: "Raw",
    sampleUsed: 22,
    sampleAvailable: 26,
    windowDays: 14,
    priceMin: 200,
    priceMax: 650,
    binMedian: 315,
    binCount: 11,
    binPriceMin: 200,
    binPriceMax: 650,
    auctionMedian: 210,
    auctionCount: 4,
    trendDirection: "flat",
    trendPct: 0,
    excludedCount: 4,
    excludedPriceMin: 158,
    excludedPriceMax: 200,
    topExclusionReasons: [],
    fmv: 368,
  };

  it("produces a stable 16-char hex digest", () => {
    const h = hashFactPack(fpA);
    expect(h).toMatch(/^[a-f0-9]{16}$/);
    expect(hashFactPack(fpA)).toBe(h); // deterministic
  });

  it("hash changes when any load-bearing field changes", () => {
    const before = hashFactPack(fpA);
    expect(hashFactPack({ ...fpA, binMedian: 316 })).not.toBe(before);
    expect(hashFactPack({ ...fpA, excludedCount: 5 })).not.toBe(before);
    expect(hashFactPack({ ...fpA, sampleUsed: 21 })).not.toBe(before);
  });

  it("prompt {system, user} includes the fact pack, ground rules, and the template anchor", () => {
    // CF-MARKET-READ-LLM-WIRE-UP (2026-06-10): buildLLMPrompt now returns
    // {system, user}; the user message includes the template paragraph
    // as a voice anchor.
    const templateAnchor = "Recent sales cluster around the same neighborhood with no real movement.";
    const { system, user } = buildLLMPrompt(fpA, templateAnchor);
    // System owns voice + grounding + no-value + excluded rules
    expect(system).toContain("VOICE");
    expect(system).toContain("GROUNDING");
    expect(system).toContain("Use ONLY the numbers and facts in the FACT PACK");
    expect(system).toContain("NO-VALUE CASE");
    // User owns the per-card payload + the voice anchor
    expect(user).toContain("Reference paragraph");
    expect(user).toContain(templateAnchor);
    expect(user).toContain("FACT PACK");
    expect(user).toContain('"sampleUsed": 22');
  });
});

// CF-MARKET-READ-EXCLUDED-CALLOUT (2026-06-08): per-comp excluded-comps
// array + condition-reason classifier.

describe("isConditionReason", () => {
  it("recognizes damage / read / as-is / scuff stems", () => {
    expect(isConditionReason("keyword:damage")).toBe(true);
    expect(isConditionReason("keyword:damaged")).toBe(true);
    expect(isConditionReason("keyword:please read")).toBe(true);
    expect(isConditionReason("keyword:crease")).toBe(true);
    expect(isConditionReason("keyword:as is")).toBe(true);
    expect(isConditionReason("keyword:scuff")).toBe(true);
    expect(isConditionReason("keyword:worn")).toBe(true);
    expect(isConditionReason("keyword:trimmed")).toBe(true);
  });

  it("rejects outlier + non-condition keywords", () => {
    expect(isConditionReason("outlier")).toBe(false);
    expect(isConditionReason("invalid")).toBe(false);
    expect(isConditionReason("keyword:lot of")).toBe(false);
    expect(isConditionReason("keyword:digital")).toBe(false);
    expect(isConditionReason("keyword:redemption")).toBe(false);
    expect(isConditionReason("keyword:reprint")).toBe(false);
  });
});

describe("generateMarketRead excludedComps[]", () => {
  function isoDaysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }
  function rec(
    price: number,
    title: string,
    daysAgo: number,
    listing_type: "fixed" | "auction" = "fixed",
  ) {
    return {
      price,
      title,
      date: isoDaysAgo(daysAgo),
      source: "ebay" as const,
      listing_type,
      url: null,
    };
  }

  it("returns excludedComps with per-comp price + reason + label, sorted newest first", async () => {
    const pricing = {
      card: { card_id: TROUT_ID, name: "Mike Trout", number: "US175" },
      raw: {
        count: 6,
        records: [
          // Clean sales — should survive
          rec(420, "2011 Topps Update Mike Trout #US175 RC", 2),
          rec(470, "2011 Topps Update Mike Trout #US175 (RC)", 5),
          rec(500, "Topps 2011 Update Series Mike Trout #US175 Rookie", 6),
          // Excluded sales
          rec(158, "2011 Topps Update Mike Trout RC Corner Damage", 9, "auction"),
          rec(175, "*** Please Read*** 2011 Topps Update Mike Trout #US175 (RC)", 7),
          rec(160, "Please Read Desciption 2011 Topps Update Mike Trout #US175 (RC)", 4),
        ],
      },
      graded: [],
      meta: { total_records: 6, last_sale_date: isoDaysAgo(0) },
    } as any;

    const est = {
      compsUsed: 3,
      compsAvailable: 6,
      fairMarketValue: 430,
      trendIQ: { components: { cardTrajectory: { pctChange: 0 } } },
    };

    const result = await generateMarketRead(pricing, "Raw", est, TROUT_ID);
    expect(result.excludedComps).toHaveLength(3);
    // Each entry has the required shape
    for (const e of result.excludedComps) {
      expect(typeof e.price).toBe("number");
      expect(typeof e.date).toBe("string");
      expect(typeof e.title).toBe("string");
      expect(typeof e.reason).toBe("string");
      expect(typeof e.label).toBe("string");
      expect(e.reason.startsWith("keyword:") || e.reason === "outlier").toBe(true);
    }
    // Labels are plain-language (no "keyword:" prefix).
    for (const e of result.excludedComps) {
      expect(e.label).not.toContain("keyword:");
    }
    // Sorted newest first.
    const dates = result.excludedComps.map((e) => Date.parse(e.date));
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
    // Specific reasons present
    const reasons = result.excludedComps.map((e) => e.reason);
    expect(reasons).toContain("keyword:damage");
    expect(reasons).toContain("keyword:please read");
  });

  it("empty excludedComps when nothing in-window was filtered", async () => {
    const pricing = {
      card: { card_id: TROUT_ID, name: "Mike Trout", number: "US175" },
      raw: {
        count: 3,
        records: [
          rec(420, "2011 Topps Update Mike Trout #US175 RC", 2),
          rec(470, "2011 Topps Update Mike Trout #US175 (RC)", 5),
          rec(500, "Topps 2011 Update Series Mike Trout #US175 Rookie", 6),
        ],
      },
      graded: [],
      meta: { total_records: 3, last_sale_date: isoDaysAgo(0) },
    } as any;
    const est = {
      compsUsed: 3,
      compsAvailable: 3,
      fairMarketValue: 470,
      trendIQ: { components: { cardTrajectory: { pctChange: 0 } } },
    };
    const result = await generateMarketRead(pricing, "Raw", est, TROUT_ID);
    expect(result.excludedComps).toEqual([]);
  });
});

// CF-CARD-HERO-IMAGE (2026-06-08): selection chain.
describe("pickCardImageUrl", () => {
  function isoDaysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }
  function rec(
    price: number,
    daysAgo: number,
    image_url: string | null,
    listing_type: "fixed" | "auction" = "fixed",
  ) {
    return {
      title: `comp #${price}`,
      price,
      date: isoDaysAgo(daysAgo),
      source: "ebay" as const,
      listing_type,
      url: null,
      image_url,
    };
  }

  it("picks the most recent grade-pool record at/above 0.65 * binMedian", () => {
    const pricing = {
      raw: {
        count: 5,
        records: [
          rec(200, 1, "https://img/cheap.jpg"),     // most recent BUT below threshold (273)
          rec(420, 3, "https://img/anchor.jpg"),    // above threshold; older
          rec(480, 5, "https://img/older.jpg"),     // above threshold; even older
        ],
      },
      graded: [],
      meta: { total_records: 5, last_sale_date: isoDaysAgo(1) },
    } as any;
    const pick = pickCardImageUrl(pricing, "Raw", 420);
    // Threshold = 273. Most recent comp >= 273 is the $420 from 3d ago.
    expect(pick).toBe("https://img/anchor.jpg");
  });

  it("falls back to the most recent comp when none meet the threshold", () => {
    const pricing = {
      raw: {
        count: 3,
        records: [
          rec(100, 1, "https://img/recent-cheap.jpg"),  // below threshold
          rec(150, 5, "https://img/older-cheap.jpg"),   // below threshold
          rec(180, 10, "https://img/oldest-cheap.jpg"), // below threshold
        ],
      },
      graded: [],
      meta: { total_records: 3, last_sale_date: isoDaysAgo(1) },
    } as any;
    const pick = pickCardImageUrl(pricing, "Raw", 420);
    // Threshold = 273; nothing qualifies. Most recent with image wins.
    expect(pick).toBe("https://img/recent-cheap.jpg");
  });

  it("ignores records without an image_url", () => {
    const pricing = {
      raw: {
        count: 3,
        records: [
          rec(420, 1, null), // newest, but NO image → must be skipped
          rec(420, 3, "https://img/with-image.jpg"),
        ],
      },
      graded: [],
      meta: { total_records: 2, last_sale_date: isoDaysAgo(1) },
    } as any;
    const pick = pickCardImageUrl(pricing, "Raw", 420);
    expect(pick).toBe("https://img/with-image.jpg");
  });

  it("when binMedian is null, returns most recent grade-pool image regardless of price", () => {
    const pricing = {
      raw: {
        count: 2,
        records: [
          rec(50, 1, "https://img/anything.jpg"),
          rec(420, 5, "https://img/older.jpg"),
        ],
      },
      graded: [],
      meta: { total_records: 2, last_sale_date: isoDaysAgo(1) },
    } as any;
    const pick = pickCardImageUrl(pricing, "Raw", null);
    expect(pick).toBe("https://img/anything.jpg");
  });

  it("PSA 10: pulls from graded[PSA][10] pool, not raw", () => {
    const pricing = {
      raw: {
        count: 1,
        records: [rec(420, 1, "https://img/raw-card.jpg")],
      },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              records: [
                rec(1200, 1, "https://img/psa10-slab.jpg"),
                rec(1300, 3, "https://img/psa10-older.jpg"),
              ],
            },
          ],
        },
      ],
      meta: { total_records: 3, last_sale_date: isoDaysAgo(1) },
    } as any;
    const pick = pickCardImageUrl(pricing, "PSA 10", 1184);
    // PSA 10 threshold = 1184 * 0.65 = 769.6. Both PSA 10 records qualify;
    // most recent wins. Raw photo must NOT be picked.
    expect(pick).toBe("https://img/psa10-slab.jpg");
    expect(pick).not.toBe("https://img/raw-card.jpg");
  });

  it("graded fallback: when grade pool has NO image, falls back to raw pool most recent", () => {
    const pricing = {
      raw: {
        count: 2,
        records: [
          rec(420, 1, "https://img/raw-newest.jpg"),
          rec(400, 5, "https://img/raw-older.jpg"),
        ],
      },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              // PSA 10 records exist but have NO image_url
              records: [rec(1200, 1, null), rec(1300, 3, null)],
            },
          ],
        },
      ],
      meta: { total_records: 4, last_sale_date: isoDaysAgo(1) },
    } as any;
    const pick = pickCardImageUrl(pricing, "PSA 10", 1184);
    // Grade pool returned no usable hero → fall back to raw pool.
    // Threshold here is 1184 * 0.65 = 769.6; raw comps are below that,
    // so the most-recent raw with image wins.
    expect(pick).toBe("https://img/raw-newest.jpg");
  });

  it("returns undefined when both grade pool and raw pool have no images", () => {
    const pricing = {
      raw: { count: 1, records: [rec(420, 1, null)] },
      graded: [],
      meta: { total_records: 1, last_sale_date: isoDaysAgo(1) },
    } as any;
    expect(pickCardImageUrl(pricing, "Raw", 420)).toBeUndefined();
  });

  it("returns undefined on a missing-grade request when raw is also empty", () => {
    const pricing = {
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    } as any;
    expect(pickCardImageUrl(pricing, "PSA 10", 1184)).toBeUndefined();
  });
});

// CF-MARKET-READ-LLM-WIRE-UP (2026-06-10) — LLM hook gating + fallback
// behavior under the orchestrator. Pure-mocked OpenAI client; no network.
import { describe as describeLlm, it as itLlm, expect as expectLlm, vi, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

// AzureOpenAI must be `new`-able; declare a real class inside the mock
// factory so the constructor contract is satisfied. `createMock` is
// hoisted, so the class body can capture it via closure.
vi.mock("openai", () => {
  class MockAzureOpenAI {
    chat = { completions: { create: createMock } };
  }
  return { AzureOpenAI: MockAzureOpenAI };
});

import { generateMarketRead as generateMarketReadLlm } from "../src/services/compiq/marketRead.service";

function llmTroutPricingSeed() {
  // Minimal pricing payload that produces a non-thin fact pack so the
  // template emits real content (otherwise the "too few sales" branch
  // dominates and the LLM has nothing distinctive to mimic).
  const rec2 = (price: number, days: number, kind: "fixed" | "auction" = "fixed") => ({
    price,
    title: "2011 Topps Update Mike Trout #US175 RC",
    date: new Date(Date.now() - days * 86_400_000).toISOString(),
    source: "ebay" as const,
    listing_type: kind,
    url: null,
  });
  return {
    card: {
      card_id: TROUT_ID,
      name: "Mike Trout",
      number: "US175",
      set: { set_id: "x", name: "Base Set", year: "2011", release: "Topps Update" },
    },
    raw: {
      count: 12,
      records: [
        rec2(380, 1), rec2(385, 2), rec2(395, 3), rec2(400, 4), rec2(405, 5),
        rec2(410, 6), rec2(415, 7), rec2(420, 8), rec2(425, 9), rec2(430, 10),
        rec2(210, 1, "auction"), rec2(220, 4, "auction"),
      ],
    },
    graded: [],
    meta: { total_records: 12, last_sale_date: new Date().toISOString() },
  } as any;
}

const llmEst = { compsUsed: 12, compsAvailable: 12, fairMarketValue: 402, trendIQ: { components: { cardTrajectory: { pctChange: 0, recentMedian: 400 } } } };

describeLlm("generateMarketRead LLM hook (CF-MARKET-READ-LLM-WIRE-UP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MARKET_READ_LLM;
    process.env.AZURE_OPENAI_ENDPOINT = "https://fake-openai.openai.azure.com/";
    process.env.AZURE_OPENAI_API_KEY = "fake-key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o-mini";
  });

  itLlm("flag OFF (default) → LLM is never called, template served", async () => {
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-flag-off");
    expectLlm(result.source).toBe("template");
    expectLlm(result.marketRead).toContain("anchor to the fixed-price market");
    expectLlm(createMock).not.toHaveBeenCalled();
  });

  itLlm("flag ON + valid LLM output → source=llm, LLM text wins", async () => {
    process.env.MARKET_READ_LLM = "on";
    // Output uses only the fmv ($402) — every other quantity spelled
    // out as a word so the validator has zero false-positive surface.
    createMock.mockResolvedValue({
      choices: [{
        message: { content: "Recent sales cluster around $402 across a handful of fixed-price copies, with auctions landing a touch lower. The market's held steady the past two weeks, with no real movement either direction." }
      }],
    });
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-llm-valid");
    expectLlm(result.source).toBe("llm");
    expectLlm(result.marketRead).toMatch(/Recent sales cluster around \$402/);
    expectLlm(createMock).toHaveBeenCalledTimes(1);
  });

  itLlm("flag ON + LLM invents a dollar figure → validator rejects, template served", async () => {
    process.env.MARKET_READ_LLM = "on";
    createMock.mockResolvedValue({
      choices: [{ message: { content: "Recent sales cluster around $999.99 with bin median of $402." } }],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-llm-invent");
    expectLlm(result.source).toBe("template");
    expectLlm(warnSpy).toHaveBeenCalledWith(expectLlm.stringContaining("LLM output rejected"));
    warnSpy.mockRestore();
  });

  itLlm("flag ON + LLM throws → template served, no propagation", async () => {
    process.env.MARKET_READ_LLM = "on";
    createMock.mockRejectedValue(new Error("openai 500"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-llm-throw");
    expectLlm(result.source).toBe("template");
    expectLlm(warnSpy).toHaveBeenCalledWith(expectLlm.stringContaining("LLM call failed"));
    warnSpy.mockRestore();
  });

  itLlm("flag ON + LLM returns empty content → template served", async () => {
    process.env.MARKET_READ_LLM = "on";
    createMock.mockResolvedValue({ choices: [{ message: { content: "" } }] });
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-llm-empty");
    expectLlm(result.source).toBe("template");
  });

  itLlm("flag ON but AZURE_OPENAI env unset → LLM is null-out before client construction", async () => {
    process.env.MARKET_READ_LLM = "on";
    delete process.env.AZURE_OPENAI_ENDPOINT;
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-no-env");
    expectLlm(result.source).toBe("template");
    expectLlm(createMock).not.toHaveBeenCalled();
  });

  itLlm("flag ON + LLM takes longer than 2500ms → AbortSignal.timeout fires, template served", async () => {
    process.env.MARKET_READ_LLM = "on";
    // AbortSignal.timeout(2500) is wired up by the implementation. We
    // simulate the wire by having the mock honor the abort signal from
    // options — the openai client passes the signal down to the
    // request. When the signal fires before resolution, the promise
    // rejects with an AbortError. The mock mimics that behavior.
    createMock.mockImplementation((_body: unknown, opts: { signal?: AbortSignal } | undefined) => {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({
          choices: [{ message: { content: "Recent sales cluster around $402." } }],
        }), 5000);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("Request was aborted");
          (err as { name?: string }).name = "AbortError";
          reject(err);
        });
      });
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-llm-timeout");
    expectLlm(result.source).toBe("template");
    expectLlm(warnSpy).toHaveBeenCalledWith(expectLlm.stringContaining("LLM call failed"));
    warnSpy.mockRestore();
  }, 7000);

  itLlm("AZURE_OPENAI_DEPLOYMENT_MARKETREAD takes precedence over AZURE_OPENAI_DEPLOYMENT", async () => {
    process.env.MARKET_READ_LLM = "on";
    process.env.AZURE_OPENAI_DEPLOYMENT_MARKETREAD = "gpt-4o-mini-marketread";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o";
    createMock.mockImplementation((body: { model?: string }) => {
      // Capture what was sent so we can assert the deployment name.
      (createMock as unknown as { lastModel?: string }).lastModel = body.model;
      return Promise.resolve({
        choices: [{ message: { content: "Recent sales cluster around $402." } }],
      });
    });
    await generateMarketReadLlm(llmTroutPricingSeed(), "Raw", llmEst, "card-deploy-pref");
    expectLlm((createMock as unknown as { lastModel?: string }).lastModel).toBe("gpt-4o-mini-marketread");
    delete process.env.AZURE_OPENAI_DEPLOYMENT_MARKETREAD;
  });

  itLlm("NULL-FMV HARDENING: when fp.fmv is null, user message prepends the no-value NOTE", async () => {
    // Direct test of buildLLMPrompt — assertively check the literal
    // prepend so a future code edit that removes it will fail this
    // test. The model's behavior under that note is sample-reviewed
    // separately at the STEP 2 HALT.
    const fpNoFmv: MarketReadFactPack = {
      cardId: "x",
      grade: "Raw",
      sampleUsed: 2,
      sampleAvailable: 2,
      windowDays: 14,
      priceMin: null, priceMax: null,
      binMedian: null, binCount: 0,
      binPriceMin: null, binPriceMax: null,
      auctionMedian: null, auctionCount: 0,
      trendDirection: "flat", trendPct: 0,
      excludedCount: 0,
      excludedPriceMin: null, excludedPriceMax: null,
      topExclusionReasons: [],
      fmv: null,
    };
    const { user } = buildLLMPrompt(fpNoFmv, "(template)");
    expectLlm(user.startsWith("NOTE: fmv is null")).toBe(true);
  });

  itLlm("NULL-FMV HARDENING: when fmv present + sample healthy, no prepend", async () => {
    const fpHealthy: MarketReadFactPack = {
      cardId: "x",
      grade: "Raw",
      sampleUsed: 22,
      sampleAvailable: 26,
      windowDays: 14,
      priceMin: 200, priceMax: 650,
      binMedian: 450, binCount: 8,
      binPriceMin: 200, binPriceMax: 650,
      auctionMedian: 235.5, auctionCount: 3,
      trendDirection: "flat", trendPct: 0,
      excludedCount: 4,
      excludedPriceMin: 158, excludedPriceMax: 200,
      topExclusionReasons: [],
      fmv: 402,
    };
    const { user } = buildLLMPrompt(fpHealthy, "(template)");
    expectLlm(user.startsWith("NOTE: fmv is null")).toBe(false);
    expectLlm(user.startsWith("Reference paragraph")).toBe(true);
  });

  itLlm("NULL-FMV HARDENING: when sampleUsed < 3, prepend fires even if fmv looks set", async () => {
    // Low-sample variant — the user brief specified "fmv is null OR
    // low-sample". sampleUsed=2 means the system shouldn't price even
    // if a stub fmv is present.
    const fpThin: MarketReadFactPack = {
      cardId: "x",
      grade: "Raw",
      sampleUsed: 2,
      sampleAvailable: 2,
      windowDays: 14,
      priceMin: 100, priceMax: 200,
      binMedian: 150, binCount: 1,
      binPriceMin: 150, binPriceMax: 150,
      auctionMedian: null, auctionCount: 0,
      trendDirection: "flat", trendPct: 0,
      excludedCount: 0,
      excludedPriceMin: null, excludedPriceMax: null,
      topExclusionReasons: [],
      fmv: 150,
    };
    const { user } = buildLLMPrompt(fpThin, "(template)");
    expectLlm(user.startsWith("NOTE: fmv is null")).toBe(true);
  });

  itLlm("cache-hit on the same fact-pack hash → LLM only called once across repeat invocations", async () => {
    process.env.MARKET_READ_LLM = "on";
    createMock.mockResolvedValue({
      choices: [{ message: { content: "Recent sales cluster around $402 across 10 Buy It Now copies." } }],
    });
    const cardId = "card-cache-hit-" + Date.now();
    const seed = llmTroutPricingSeed();
    await generateMarketReadLlm(seed, "Raw", llmEst, cardId);
    await generateMarketReadLlm(seed, "Raw", llmEst, cardId);
    expectLlm(createMock).toHaveBeenCalledTimes(1);
  });
});
