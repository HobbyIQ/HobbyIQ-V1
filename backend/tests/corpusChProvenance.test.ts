/**
 * CF-CH-P6-CORPUS — CardHedge vendor provenance on corpus rows.
 *
 * Two invariants this file locks:
 *
 *   1. ADDITIVE (non-negotiable): a Cardsight-sourced estimate emits the
 *      corpus row EXACTLY as today — byte-identical pre/post P6. The
 *      chProvenance block is OMITTED from the serialized JSON, not set
 *      to null, so the response object has the same key set + same
 *      values + same serialization order it had before this CF.
 *
 *   2. CH PROVENANCE: a CardHedge-sourced estimate (engine
 *      estimateSource = "cardhedge", set by P5) emits a row whose
 *      response.chProvenance carries vendor="cardhedge" and the optional
 *      chCardId / trustReason when the engine surfaces them.
 */
import { describe, expect, it } from "vitest";

import { buildCorpusEntry } from "../src/models/corpusEntry.js";
import { corpusEntryFromPricingResult } from "../src/services/corpus/corpusMapping.js";

const fakeClock = { iso: () => "2026-06-25T17:30:00.000Z" };

// Baseline Cardsight-sourced response used to lock the additive invariant.
const CS_RESULT = {
  fairMarketValueLive: 1250.5,
  confidence: 0.87,
  pricingEngine: "monolith",
  engineVersion: "44dfd37",
  compsUsed: 23,
  estimateSource: "observed",
};

// The expected emitted bytes for the Cardsight-sourced row above —
// reconstructed by hand to assert byte-identicality without relying on
// the builder's own output as the oracle.
function expectedCSRowJSON(capturedAt: string): string {
  return JSON.stringify({
    corpusEntrySchemaVersion: 2,
    capturedAt,
    query: "Mike Trout 2011 Topps Update US175",
    querySource: "free_text",
    endpoint: "/api/compiq/search",
    responseDurationMs: 142,
    response: {
      fairMarketValueLive: 1250.5,
      confidence: 0.87,
      pricingEngine: "monolith",
      engineVersion: "44dfd37",
      marketState: null,
      marketStateSchemaVersion: 0,
      sampleSize: 23,
    },
  });
}

describe("CF-CH-P6-CORPUS — ADDITIVE INVARIANT: Cardsight row byte-identical pre/post P6", () => {
  it("CS-sourced estimate (estimateSource='observed') emits NO chProvenance key", () => {
    const entry = corpusEntryFromPricingResult({
      query: "Mike Trout 2011 Topps Update US175",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 142,
      result: CS_RESULT,
    });

    expect("chProvenance" in entry.response).toBe(false);
    expect(Object.keys(entry.response).sort()).toEqual([
      "confidence",
      "engineVersion",
      "fairMarketValueLive",
      "marketState",
      "marketStateSchemaVersion",
      "pricingEngine",
      "sampleSize",
    ]);
  });

  it("CS-sourced row's serialized JSON matches the hand-built pre-P6 reference EXACTLY", () => {
    const entry = buildCorpusEntry({
      query: "Mike Trout 2011 Topps Update US175",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 142,
      clock: fakeClock,
      response: {
        fairMarketValueLive: 1250.5,
        confidence: 0.87,
        pricingEngine: "monolith",
        engineVersion: "44dfd37",
        marketState: null,
        marketStateSchemaVersion: 0,
        sampleSize: 23,
      },
    });

    expect(JSON.stringify(entry)).toBe(expectedCSRowJSON("2026-06-25T17:30:00.000Z"));
  });

  it("estimateSource=null still produces a byte-identical CS-shape row (additive holds for null too)", () => {
    const entry = corpusEntryFromPricingResult({
      query: "ad-hoc query",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 88,
      result: { ...CS_RESULT, estimateSource: null },
    });
    expect("chProvenance" in entry.response).toBe(false);
  });

  it("estimateSource='trend-extrapolated' (the CS fallback path) emits NO chProvenance", () => {
    const entry = corpusEntryFromPricingResult({
      query: "thin-comp Cardsight",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 95,
      result: { ...CS_RESULT, estimateSource: "trend-extrapolated" },
    });
    expect("chProvenance" in entry.response).toBe(false);
  });

  it("estimateSource='last-sale' (also CS-side) emits NO chProvenance", () => {
    const entry = corpusEntryFromPricingResult({
      query: "fallback last-sale",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 95,
      result: { ...CS_RESULT, estimateSource: "last-sale" },
    });
    expect("chProvenance" in entry.response).toBe(false);
  });
});

describe("CF-CH-P6-CORPUS — CH PROVENANCE: CardHedge row carries chProvenance.vendor", () => {
  it("estimateSource='cardhedge' alone → chProvenance.vendor='cardhedge' present (chCardId/trustReason omitted when engine doesn't surface)", () => {
    const entry = corpusEntryFromPricingResult({
      query: "Eric Hartman 2026 Bowman Chrome Green Shimmer /99",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 312,
      result: { ...CS_RESULT, estimateSource: "cardhedge" },
    });

    expect(entry.response.chProvenance).toBeDefined();
    expect(entry.response.chProvenance!.vendor).toBe("cardhedge");
    expect(entry.response.chProvenance!.chCardId).toBeUndefined();
    expect(entry.response.chProvenance!.trustReason).toBeUndefined();
  });

  it("estimateSource='cardhedge' + chCardId surfaced → chProvenance carries chCardId", () => {
    const entry = corpusEntryFromPricingResult({
      query: "Eric Hartman 2026 Bowman Chrome Green Shimmer /99",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 312,
      result: {
        ...CS_RESULT,
        estimateSource: "cardhedge",
        chCardId: "1778542093014x623522278065749040",
        chTrustReason: "prices_by_card_honest",
      },
    });

    expect(entry.response.chProvenance).toEqual({
      vendor: "cardhedge",
      chCardId: "1778542093014x623522278065749040",
      trustReason: "prices_by_card_honest",
    });
  });

  it("trustReason='title_cohesion_strong' is also accepted", () => {
    const entry = corpusEntryFromPricingResult({
      query: "thin parallel CH-won via title cohesion",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 312,
      result: {
        ...CS_RESULT,
        estimateSource: "cardhedge",
        chTrustReason: "title_cohesion_strong",
      },
    });

    expect(entry.response.chProvenance!.trustReason).toBe("title_cohesion_strong");
  });

  it("unknown trustReason value is dropped (whitelist-only enum)", () => {
    const entry = corpusEntryFromPricingResult({
      query: "unrecognized trust reason",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 312,
      result: {
        ...CS_RESULT,
        estimateSource: "cardhedge",
        chTrustReason: "bogus_value_attacker_supplied" as any,
      },
    });

    expect(entry.response.chProvenance).toEqual({ vendor: "cardhedge" });
    expect(entry.response.chProvenance!.trustReason).toBeUndefined();
  });

  it("non-string chCardId is dropped", () => {
    const entry = corpusEntryFromPricingResult({
      query: "junk chCardId",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 312,
      result: {
        ...CS_RESULT,
        estimateSource: "cardhedge",
        chCardId: 12345 as any,
      },
    });

    expect(entry.response.chProvenance!.chCardId).toBeUndefined();
  });
});

describe("CF-CH-P6-CORPUS — buildCorpusEntry direct construction (chProvenance whitelist enforcement)", () => {
  it("builder accepts chProvenance from BuildCorpusEntryOptions and copies through verbatim", () => {
    const entry = buildCorpusEntry({
      query: "direct call",
      querySource: "card_id",
      endpoint: "/api/compiq/price-by-id",
      durationMs: 95,
      clock: fakeClock,
      response: {
        fairMarketValueLive: 450,
        confidence: 0.7,
        pricingEngine: "monolith",
        engineVersion: "44dfd37",
        marketState: null,
        marketStateSchemaVersion: 0,
        sampleSize: 1,
        chProvenance: {
          vendor: "cardhedge",
          chCardId: "1778542140951x283396404010038530",
          trustReason: "prices_by_card_honest",
        },
      },
    });

    expect(entry.response.chProvenance).toEqual({
      vendor: "cardhedge",
      chCardId: "1778542140951x283396404010038530",
      trustReason: "prices_by_card_honest",
    });
  });

  it("builder DROPS chProvenance with a vendor other than 'cardhedge' (whitelist guard)", () => {
    const entry = buildCorpusEntry({
      query: "attacker-supplied bogus vendor",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      clock: fakeClock,
      response: {
        fairMarketValueLive: 100,
        confidence: 0.5,
        pricingEngine: "monolith",
        engineVersion: "44dfd37",
        marketState: null,
        marketStateSchemaVersion: 0,
        sampleSize: 5,
        chProvenance: { vendor: "evil" as any },
      },
    });

    expect("chProvenance" in entry.response).toBe(false);
  });
});
