/**
 * Privacy + correctness tests for corpusEntryFromPricingResult — the
 * adapter from CompIQ pricing route responses to CorpusEntry. This is
 * the second load-bearing test in PR #2b: even if buildCorpusEntry()
 * has a perfect privacy contract, a careless mapper could route a
 * forbidden field from `result.*` into an allowed corpus slot.
 *
 * What this test asserts:
 *
 *   1. Allowed-field passthrough: whitelisted fields on the result
 *      object (fairMarketValueLive, confidence, pricingEngine,
 *      engineVersion, compsUsed) land in the correct corpus slots,
 *      with compsUsed → sampleSize rename verified.
 *
 *   2. Aspirational defaults: marketState is null and
 *      marketStateSchemaVersion is 0 regardless of what (if anything)
 *      the route emits, because no pricing endpoint surfaces them yet.
 *
 *   3. Privacy contract THROUGH the mapper: forbidden fields planted
 *      on the result object using the FORBIDDEN_LEAK_<category>_<n>
 *      sentinel pattern do not appear in the serialized corpus entry
 *      (defensive against the mapper accidentally widening its
 *      whitelist or spread-copying the result).
 *
 *   4. querySource discrimination:
 *      - free_text path: query string passed through with
 *        querySource: "free_text".
 *      - card_id path: cardsightCardId stored in the `query` slot
 *        with querySource: "card_id".
 *
 *   5. Query truncation cap enforced through the mapper (not bypassed)
 *      at 500 chars, with the off-by-one boundary at exactly 500 chars
 *      not triggering truncation.
 */

import { describe, it, expect } from "vitest";
import { corpusEntryFromPricingResult } from "../src/services/corpus/corpusMapping";

// ---------------------------------------------------------------------------
// Forbidden field sentinels — same shape as corpusEntry.test.ts. One
// representative per privacy category. Network sentinels are real-looking
// IP addresses, which we check by literal value (no FORBIDDEN_LEAK_ prefix).
// ---------------------------------------------------------------------------

const FORBIDDEN_FIELDS: Record<string, unknown> = {
  userId: "FORBIDDEN_LEAK_userId_001",
  userEmail: "forbidden+leak@example.invalid",
  accountId: "FORBIDDEN_LEAK_accountId_002",
  sessionId: "FORBIDDEN_LEAK_sessionId_010",
  sessionToken: "FORBIDDEN_LEAK_sessionToken_011",
  accessToken: "FORBIDDEN_LEAK_accessToken_013",
  authorization: "Bearer FORBIDDEN_LEAK_authHeader_014",
  apiKey: "FORBIDDEN_LEAK_apiKey_015",
  cookie: "sid=FORBIDDEN_LEAK_cookie_017",
  ip: "203.0.113.42",
  remoteAddress: "203.0.113.42",
  xForwardedFor: "203.0.113.42, 198.51.100.7",
  country: "FORBIDDEN_LEAK_country_020",
  deviceId: "FORBIDDEN_LEAK_deviceId_030",
  userAgent: "Mozilla/5.0 (FORBIDDEN_LEAK_userAgent_033)",
  requestId: "FORBIDDEN_LEAK_requestId_040",
  traceId: "FORBIDDEN_LEAK_traceId_042",
  subscriptionTier: "FORBIDDEN_LEAK_subscriptionTier_050",
  storeKitTransactionId: "FORBIDDEN_LEAK_storeKitTxn_054",
  ebayItemId: "FORBIDDEN_LEAK_ebayItemId_060",
  listingUrl: "https://example.invalid/itm/FORBIDDEN_LEAK_listingUrl_061",
  sellerId: "FORBIDDEN_LEAK_sellerId_062",
  imageUrl: "https://example.invalid/i/FORBIDDEN_LEAK_image_065.jpg",
  userNotes: "FORBIDDEN_LEAK_userNotes_070",
  portfolioName: "FORBIDDEN_LEAK_portfolioName_072",
};

const SENTINEL_VALUE_REGEX = /FORBIDDEN_LEAK_/;
const FORBIDDEN_FIELD_NAMES = Object.keys(FORBIDDEN_FIELDS);

function buildPoisonedResult() {
  return {
    fairMarketValueLive: 1250.5,
    confidence: 0.87,
    pricingEngine: "monolith",
    engineVersion: "abc1234",
    compsUsed: 23,
    // Forbidden fields planted directly on the result object — the
    // shape a careless route would pass straight through.
    ...FORBIDDEN_FIELDS,
  };
}

// ---------------------------------------------------------------------------
// Allowed-field passthrough
// ---------------------------------------------------------------------------

describe("corpusEntryFromPricingResult — allowed-field passthrough", () => {
  it("maps whitelisted result fields to the correct corpus slots", () => {
    const entry = corpusEntryFromPricingResult({
      query: "luka prizm rookie auto",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 142,
      result: buildPoisonedResult(),
    });

    expect(entry.response.fairMarketValueLive).toBe(1250.5);
    expect(entry.response.confidence).toBe(0.87);
    expect(entry.response.pricingEngine).toBe("monolith");
    expect(entry.response.engineVersion).toBe("abc1234");
    // compsUsed → sampleSize rename
    expect(entry.response.sampleSize).toBe(23);
  });

  it("renames compsUsed → sampleSize even when only compsUsed is present", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/price",
      durationMs: 100,
      result: { compsUsed: 7 },
    });
    expect(entry.response.sampleSize).toBe(7);
  });

  it("writes default pricingEngine=\"monolith\" when result omits it", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: { fairMarketValueLive: 100 },
    });
    expect(entry.response.pricingEngine).toBe("monolith");
  });

  it("writes default engineVersion=\"unknown\" when result omits it", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: { fairMarketValueLive: 100 },
    });
    expect(entry.response.engineVersion).toBe("unknown");
  });

  it("writes null sampleSize when result has no compsUsed", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: { fairMarketValueLive: 100 },
    });
    expect(entry.response.sampleSize).toBeNull();
  });

  it("handles null/undefined result gracefully (all aspirational nulls)", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: null,
    });
    expect(entry.response.fairMarketValueLive).toBeNull();
    expect(entry.response.confidence).toBeNull();
    expect(entry.response.sampleSize).toBeNull();
    expect(entry.response.pricingEngine).toBe("monolith");
    expect(entry.response.engineVersion).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Aspirational defaults — marketState always null, version always 0
// ---------------------------------------------------------------------------

describe("corpusEntryFromPricingResult — aspirational marketState defaults", () => {
  it("writes marketState: null and marketStateSchemaVersion: 0 with a real result", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: buildPoisonedResult(),
    });
    expect(entry.response.marketState).toBeNull();
    expect(entry.response.marketStateSchemaVersion).toBe(0);
  });

  it("ignores marketState on the result (the engine doesn't surface it yet — corpus is the source of truth)", () => {
    // If the engine ever emits marketState on a route result before the
    // mapper is intentionally updated to read it, the corpus must still
    // write null — bumping it accidentally would invalidate downstream
    // schema-version consumers.
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: { marketState: "liquid", marketStateSchemaVersion: 1 } as any,
    });
    expect(entry.response.marketState).toBeNull();
    expect(entry.response.marketStateSchemaVersion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Privacy contract through the mapper
// ---------------------------------------------------------------------------

describe("corpusEntryFromPricingResult — privacy contract", () => {
  it("does not let any forbidden field NAME on result leak into the serialized entry", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 142,
      result: buildPoisonedResult(),
    });
    const serialized = JSON.stringify(entry);
    for (const forbiddenName of FORBIDDEN_FIELD_NAMES) {
      expect(
        serialized.includes(forbiddenName),
        `forbidden field name "${forbiddenName}" leaked through the mapper`,
      ).toBe(false);
    }
  });

  it("does not let any forbidden field VALUE on result leak into the serialized entry", () => {
    const entry = corpusEntryFromPricingResult({
      query: "test",
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 142,
      result: buildPoisonedResult(),
    });
    const serialized = JSON.stringify(entry);
    expect(
      SENTINEL_VALUE_REGEX.test(serialized),
      "a FORBIDDEN_LEAK_* sentinel value leaked through the mapper",
    ).toBe(false);
    expect(serialized.includes("203.0.113.42")).toBe(false);
    expect(serialized.includes("198.51.100.7")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// querySource discrimination
// ---------------------------------------------------------------------------

describe("corpusEntryFromPricingResult — querySource discrimination", () => {
  it("free_text: stores the user query and tags it free_text (/price-by-id with query)", () => {
    // Mirrors the route logic: /price-by-id received a non-empty query,
    // so the corpus records that query with querySource="free_text".
    const entry = corpusEntryFromPricingResult({
      query: "luka prizm rookie auto",
      querySource: "free_text",
      endpoint: "/api/compiq/price-by-id",
      durationMs: 100,
      result: { fairMarketValueLive: 500 },
    });
    expect(entry.query).toBe("luka prizm rookie auto");
    expect(entry.querySource).toBe("free_text");
  });

  it("card_id: stores cardsightCardId in the query slot and tags it card_id (/price-by-id without query)", () => {
    // Mirrors the route logic: /price-by-id received no query, so the
    // corpus records cardsightCardId in the query slot with
    // querySource="card_id" (CF-PRICE-BY-ID-MIGRATION renamed the
    // request body field from cardHedgeCardId to cardsightCardId).
    const entry = corpusEntryFromPricingResult({
      query: "6134bc63-1a2b-4c3d-9e0f-aabbccddeeff",
      querySource: "card_id",
      endpoint: "/api/compiq/price-by-id",
      durationMs: 100,
      result: { fairMarketValueLive: 500 },
    });
    expect(entry.query).toBe("6134bc63-1a2b-4c3d-9e0f-aabbccddeeff");
    expect(entry.querySource).toBe("card_id");
  });
});

// ---------------------------------------------------------------------------
// Query length cap — enforced through the mapper (not bypassed)
// ---------------------------------------------------------------------------

describe("corpusEntryFromPricingResult — query length cap", () => {
  it("truncates queries longer than 500 chars with the ...[truncated] suffix", () => {
    const longQuery = "X".repeat(600);
    const entry = corpusEntryFromPricingResult({
      query: longQuery,
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: null,
    });
    expect(entry.query.length).toBeLessThanOrEqual(500);
    expect(entry.query.endsWith("...[truncated]")).toBe(true);
  });

  it("does NOT truncate at exactly 500 chars (off-by-one boundary)", () => {
    const exactly500 = "Y".repeat(500);
    const entry = corpusEntryFromPricingResult({
      query: exactly500,
      querySource: "free_text",
      endpoint: "/api/compiq/search",
      durationMs: 100,
      result: null,
    });
    expect(entry.query).toBe(exactly500);
    expect(entry.query.endsWith("...[truncated]")).toBe(false);
  });
});
