import { describe, it, expect } from "vitest";
import { compLogEntryFromPricingResult } from "../src/services/compLogs/compLogMapping";

const NOW = Date.parse("2026-05-20T12:00:00Z");

function daysAgoIso(days: number): string {
  return new Date(NOW - days * 24 * 3600 * 1000).toISOString();
}

describe("compLogEntryFromPricingResult — basic field mapping", () => {
  it("maps player to lowercase and stamps schema version 1", () => {
    const e = compLogEntryFromPricingResult(
      {
        player: "Mike Trout",
        cardId: "ch_abc",
        query: "Mike Trout 2011 Topps Update",
        cardIdSource: "cardhedge",
        endpoint: "/api/compiq/search",
        durationMs: 250,
        parallel: null,
        grade: null,
        isAuto: false,
        result: { source: "live", fairMarketValueLive: 1000, confidence: 0.8, engineVersion: "abcdef0" },
      },
      NOW,
    );
    expect(e.compLogSchemaVersion).toBe(1);
    expect(e.player).toBe("mike trout");
    expect(e.timestamp).toBe(NOW);
    expect(e.latency_ms).toBe(250);
    expect(e.endpoint).toBe("/api/compiq/search");
    expect(e.cardId).toBe("ch_abc");
    expect(e.cardIdSource).toBe("cardhedge");
    expect(e.predictedPrice).toBe(1000);
    expect(e.confidence).toBe(0.8);
    expect(e.engineVersion).toBe("abcdef0");
  });

  it("falls back to 'unknown' when player is null/empty", () => {
    const a = compLogEntryFromPricingResult(
      { player: null, cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: {} }, NOW);
    const b = compLogEntryFromPricingResult(
      { player: "", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: {} }, NOW);
    const c = compLogEntryFromPricingResult(
      { player: "   ", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: {} }, NOW);
    expect(a.player).toBe("unknown");
    expect(b.player).toBe("unknown");
    expect(c.player).toBe("unknown");
  });

  it("falls back engineVersion to 'unknown' when missing", () => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: {} }, NOW);
    expect(e.engineVersion).toBe("unknown");
  });

  it("coerces non-numeric predicted/confidence to null", () => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false,
        result: { fairMarketValueLive: NaN, confidence: "0.8" as any } }, NOW);
    expect(e.predictedPrice).toBeNull();
    expect(e.confidence).toBeNull();
  });
});

describe("compLogEntryFromPricingResult — source / outcome mapping", () => {
  const cases: Array<[string, "cardsight" | "fallback", string]> = [
    ["live", "cardsight", "ok"],
    ["cardsight", "cardsight", "ok"],
    ["fallback", "fallback", "ok"],
    ["no-recent-comps", "fallback", "no_recent_comps"],
    ["neighbor-synthesis", "fallback", "neighbor_synthesis"],
    ["unsupported_sport", "fallback", "unsupported_sport"],
    ["variant-mismatch", "fallback", "variant_mismatch"],
    ["error", "fallback", "error"],
  ];
  it.each(cases)('source="%s" → source=%s, outcome=%s', (raw, expSource, expOutcome) => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { source: raw } }, NOW);
    expect(e.source).toBe(expSource);
    expect(e.outcome).toBe(expOutcome);
    expect(e.sourceDetail).toBe(raw);
  });

  it("preserves raw source verbatim in sourceDetail", () => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { source: "neighbor-synthesis" } }, NOW);
    expect(e.sourceDetail).toBe("neighbor-synthesis");
  });

  it("missing source defaults to fallback / ok", () => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: {} }, NOW);
    expect(e.source).toBe("fallback");
    expect(e.outcome).toBe("ok");
    expect(e.sourceDetail).toBeNull();
  });
});

describe("compLogEntryFromPricingResult — recent comps + rolling stats", () => {
  it("caps comps at 20 entries", () => {
    const recentComps = Array.from({ length: 30 }, (_, i) => ({
      price: 100 + i,
      soldDate: daysAgoIso(1),
    }));
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { recentComps } }, NOW);
    expect(e.comps).toHaveLength(20);
  });

  it("computes w7/w14/w30 counts and averages from soldDate windows", () => {
    const recentComps = [
      { price: 100, soldDate: daysAgoIso(1) },   // in w7, w14, w30
      { price: 200, soldDate: daysAgoIso(5) },   // in w7, w14, w30
      { price: 300, soldDate: daysAgoIso(10) },  // in w14, w30
      { price: 400, soldDate: daysAgoIso(20) },  // in w30
      { price: 500, soldDate: daysAgoIso(40) },  // outside
    ];
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { recentComps } }, NOW);
    expect(e.w7Count).toBe(2);
    expect(e.w7Avg).toBe(150);
    expect(e.w14Count).toBe(3);
    expect(e.w14Avg).toBe(200);
    expect(e.w30Count).toBe(4);
    expect(e.w30Avg).toBe(250);
  });

  it("ignores comps with missing or unparseable soldDate", () => {
    const recentComps = [
      { price: 100, soldDate: null },
      { price: 200, soldDate: "garbage" },
      { price: 300, soldDate: daysAgoIso(2) },
    ];
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { recentComps } }, NOW);
    expect(e.w7Count).toBe(1);
    expect(e.w7Avg).toBe(300);
  });

  it("emits 0/null when no comps fall in a window", () => {
    const recentComps = [{ price: 1, soldDate: daysAgoIso(60) }];
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { recentComps } }, NOW);
    expect(e.w7Count).toBe(0);
    expect(e.w7Avg).toBeNull();
    expect(e.w14Count).toBe(0);
    expect(e.w30Count).toBe(0);
  });

  it("tolerates string-typed prices and alternate field names", () => {
    const recentComps = [
      { salePrice: "150", saleDate: daysAgoIso(2) },
      { amount: 250, date: daysAgoIso(3) },
    ];
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: { recentComps } }, NOW);
    expect(e.comps).toEqual([
      { price: 150, soldDate: daysAgoIso(2) },
      { price: 250, soldDate: daysAgoIso(3) },
    ]);
    expect(e.w7Count).toBe(2);
    expect(e.w7Avg).toBe(200);
  });

  it("emits empty comps array when result has no recentComps", () => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: null, grade: null, isAuto: false, result: {} }, NOW);
    expect(e.comps).toEqual([]);
    expect(e.w7Count).toBe(0);
    expect(e.w14Count).toBe(0);
    expect(e.w30Count).toBe(0);
  });
});

describe("compLogEntryFromPricingResult — cohort fields", () => {
  it("passes through parallel/grade/isAuto verbatim", () => {
    const e = compLogEntryFromPricingResult(
      { player: "p", cardId: null, query: "x", cardIdSource: null, endpoint: "/x", durationMs: 0,
        parallel: "Refractor", grade: "PSA 10", isAuto: true, result: {} }, NOW);
    expect(e.parallel).toBe("Refractor");
    expect(e.grade).toBe("PSA 10");
    expect(e.isAuto).toBe(true);
  });
});
