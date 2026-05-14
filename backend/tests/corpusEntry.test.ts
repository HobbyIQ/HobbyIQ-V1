/**
 * Privacy contract test for CorpusEntry — the load-bearing test of PR #2b.
 *
 * What this test asserts (and why it matters):
 *
 *   1. The output of buildCorpusEntry() has EXACTLY the allowed top-level
 *      keys — no more, no fewer. Even if a future change accidentally adds
 *      a field, this test fails until the allowed-keys list is updated
 *      (which forces a privacy-contract review in code review).
 *
 *   2. The output's nested `response` object has EXACTLY the allowed
 *      response-level keys.
 *
 *   3. No forbidden field NAME (userId, sessionToken, ip, etc.) appears
 *      anywhere in JSON.stringify(output). Defensive against renamed/nested
 *      leakage where keys are technically allowed but values originate
 *      from a forbidden field.
 *
 *   4. No forbidden field VALUE (the sentinel "FORBIDDEN_LEAK_*" strings
 *      seeded into the fake input) appears anywhere in the serialized
 *      output. Defensive against a builder that accidentally copies a
 *      forbidden value into an allowed slot.
 *
 *   5. Deterministic time: capturedAt comes from the injected clock, not
 *      from `new Date().toISOString()`. Verified by stamping a fixed ISO
 *      via a fake Clock and checking equality.
 *
 *   6. Query truncation at 500 chars with "...[truncated]" suffix.
 *
 * Initial run expectation: this test FAILS — buildCorpusEntry does not
 * exist yet. That failure is the gate for File 3 (the builder). When
 * File 3 lands, this same test should pass without modification.
 */

import { describe, it, expect } from "vitest";
// NOTE: buildCorpusEntry is intentionally imported from the type module.
// File 3 of PR #2b may implement it in this same file or in a separate
// services file with a re-export — the test pins the import surface
// (the public contract), not the implementation file (an internal
// concern). See conversation history for the architectural rationale.
import {
  buildCorpusEntry,
  type CorpusEntry,
} from "../src/models/corpusEntry";

// ---------------------------------------------------------------------------
// Allowed-keys lists — single source of truth for the privacy contract.
// Adding a field to CorpusEntry without updating these arrays is a
// deliberate code-review gate.
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_KEYS = [
  "capturedAt",
  "corpusEntrySchemaVersion",
  "endpoint",
  "query",
  "querySource",
  "response",
  "responseDurationMs",
].sort();

const ALLOWED_RESPONSE_KEYS = [
  "confidence",
  "engineVersion",
  "fairMarketValueLive",
  "marketState",
  "marketStateSchemaVersion",
  "pricingEngine",
  "sampleSize",
].sort();

// ---------------------------------------------------------------------------
// Forbidden field catalogue — every category from the CorpusEntry @privacy
// JSDoc block gets at least one representative field here. Values use
// the "FORBIDDEN_LEAK_<category>_<n>" sentinel pattern so a single regex
// can catch any leak and the sentinel itself identifies which category
// leaked.
// ---------------------------------------------------------------------------

const FORBIDDEN_FIELDS: Record<string, unknown> = {
  // User identity
  userId: "FORBIDDEN_LEAK_userId_001",
  userEmail: "forbidden+leak@example.invalid",
  accountId: "FORBIDDEN_LEAK_accountId_002",
  customerId: "FORBIDDEN_LEAK_customerId_003",
  username: "FORBIDDEN_LEAK_username_004",
  displayName: "FORBIDDEN_LEAK_displayName_005",
  profileId: "FORBIDDEN_LEAK_profileId_006",

  // Auth material
  sessionId: "FORBIDDEN_LEAK_sessionId_010",
  sessionToken: "FORBIDDEN_LEAK_sessionToken_011",
  refreshToken: "FORBIDDEN_LEAK_refreshToken_012",
  accessToken: "FORBIDDEN_LEAK_accessToken_013",
  authorization: "Bearer FORBIDDEN_LEAK_authHeader_014",
  apiKey: "FORBIDDEN_LEAK_apiKey_015",
  csrfToken: "FORBIDDEN_LEAK_csrfToken_016",
  cookie: "sid=FORBIDDEN_LEAK_cookie_017; theme=dark",

  // Network / location
  ip: "203.0.113.42",
  remoteAddress: "203.0.113.42",
  clientIp: "203.0.113.42",
  xForwardedFor: "203.0.113.42, 198.51.100.7",
  xRealIp: "203.0.113.42",
  country: "FORBIDDEN_LEAK_country_020",
  region: "FORBIDDEN_LEAK_region_021",
  city: "FORBIDDEN_LEAK_city_022",
  latitude: 37.7749,
  longitude: -122.4194,
  timezone: "FORBIDDEN_LEAK_timezone_023",

  // Device
  deviceId: "FORBIDDEN_LEAK_deviceId_030",
  installId: "FORBIDDEN_LEAK_installId_031",
  advertisingId: "FORBIDDEN_LEAK_advertisingId_032",
  userAgent:
    "Mozilla/5.0 (FORBIDDEN_LEAK_userAgent_033) AppleWebKit/537.36",
  deviceModel: "FORBIDDEN_LEAK_deviceModel_034",
  osVersion: "FORBIDDEN_LEAK_osVersion_035",
  fingerprint: "FORBIDDEN_LEAK_fingerprint_036",
  pushToken: "FORBIDDEN_LEAK_pushToken_037",

  // Correlation IDs
  requestId: "FORBIDDEN_LEAK_requestId_040",
  operationId: "FORBIDDEN_LEAK_operationId_041",
  traceId: "FORBIDDEN_LEAK_traceId_042",
  spanId: "FORBIDDEN_LEAK_spanId_043",
  xCorrelationId: "FORBIDDEN_LEAK_xCorrelationId_044",

  // Commercial / entitlement
  subscriptionTier: "FORBIDDEN_LEAK_subscriptionTier_050",
  planName: "FORBIDDEN_LEAK_planName_051",
  entitlementFlags: ["FORBIDDEN_LEAK_entitlement_052"],
  purchaseReceipt: "FORBIDDEN_LEAK_purchaseReceipt_053",
  storeKitTransactionId: "FORBIDDEN_LEAK_storeKitTxn_054",

  // Third-party identifiers from upstream comp sources
  ebayItemId: "FORBIDDEN_LEAK_ebayItemId_060",
  listingUrl: "https://example.invalid/itm/FORBIDDEN_LEAK_listingUrl_061",
  sellerId: "FORBIDDEN_LEAK_sellerId_062",
  sellerName: "FORBIDDEN_LEAK_sellerName_063",
  thumbnailUrl: "https://example.invalid/i/FORBIDDEN_LEAK_thumbnail_064.jpg",
  imageUrl: "https://example.invalid/i/FORBIDDEN_LEAK_image_065.jpg",
  marketplaceOrderNumber: "FORBIDDEN_LEAK_orderNumber_066",

  // Free-text user content from non-`query` request fields
  userNotes: "FORBIDDEN_LEAK_userNotes_070",
  customLabel: "FORBIDDEN_LEAK_customLabel_071",
  portfolioName: "FORBIDDEN_LEAK_portfolioName_072",
  alertName: "FORBIDDEN_LEAK_alertName_073",
};

// Single regex that catches any sentinel value leaking through. Network /
// location entries don't use the sentinel prefix because they need to look
// like real IP addresses to exercise realistic copy-through paths — they
// are matched by name in the field-name check below.
const SENTINEL_VALUE_REGEX = /FORBIDDEN_LEAK_/;

// Forbidden field NAMES (the keys of FORBIDDEN_FIELDS) — used to assert no
// forbidden key name appears anywhere in the serialized output.
const FORBIDDEN_FIELD_NAMES = Object.keys(FORBIDDEN_FIELDS);

// ---------------------------------------------------------------------------
// Fake Clock — duck-typed { now(): number; iso(): string }. Decouples this
// test from File 3's eventual Clock import-path decision; the builder's
// Clock parameter is structurally typed.
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-05-14T17:40:00.000Z";
const FIXED_MS = new Date(FIXED_ISO).getTime();

const fakeClock = {
  now: () => FIXED_MS,
  iso: () => FIXED_ISO,
};

// ---------------------------------------------------------------------------
// Build the realistic-but-poisoned input that the builder must filter.
// The legitimate fields sit alongside every forbidden field listed above,
// at BOTH the top-level options bag AND inside the `response` object,
// because both layers are realistic accidental-leak surfaces.
// ---------------------------------------------------------------------------

function buildPoisonedInput() {
  const legitimateResponse = {
    fairMarketValueLive: 1250.5,
    confidence: 0.87,
    pricingEngine: "monolith",
    engineVersion: "4f14338",
    marketState: "liquid",
    marketStateSchemaVersion: 1,
    sampleSize: 23,
    // Forbidden fields nested inside the response object — simulates a
    // future engine response accidentally surfacing PII-adjacent fields
    // that a naive builder might spread-copy.
    ...FORBIDDEN_FIELDS,
  };

  return {
    query: "Mike Trout 2011 Topps Update US175",
    querySource: "free_text" as const,
    endpoint: "/api/compiq/search",
    durationMs: 142,
    clock: fakeClock,
    response: legitimateResponse,
    // Forbidden fields at the top level — simulates accidentally spreading
    // an Express `req` or `req.headers` / `req.user` into the options bag.
    ...FORBIDDEN_FIELDS,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CorpusEntry privacy contract — buildCorpusEntry()", () => {
  it("produces exactly the allowed top-level keys", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    expect(Object.keys(out).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS);
  });

  it("produces exactly the allowed response-level keys", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    expect(Object.keys(out.response).sort()).toEqual(ALLOWED_RESPONSE_KEYS);
  });

  it("does not let any forbidden field NAME leak into the serialized output", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    const serialized = JSON.stringify(out);
    for (const forbiddenName of FORBIDDEN_FIELD_NAMES) {
      expect(
        serialized.includes(forbiddenName),
        `forbidden field name "${forbiddenName}" leaked into output`,
      ).toBe(false);
    }
  });

  it("does not let any forbidden field VALUE leak into the serialized output", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    const serialized = JSON.stringify(out);
    expect(
      SENTINEL_VALUE_REGEX.test(serialized),
      "a FORBIDDEN_LEAK_* sentinel value appeared in the output, meaning a forbidden value was copied into an allowed slot",
    ).toBe(false);
    // Network sentinels (IP addresses) don't carry the sentinel prefix —
    // check them explicitly by value.
    expect(serialized.includes("203.0.113.42")).toBe(false);
    expect(serialized.includes("198.51.100.7")).toBe(false);
    expect(serialized.includes("37.7749")).toBe(false);
    expect(serialized.includes("-122.4194")).toBe(false);
  });

  it("stamps corpusEntrySchemaVersion = 2 (literal)", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    expect(out.corpusEntrySchemaVersion).toBe(2);
  });

  it("uses the injected Clock for capturedAt (never new Date directly)", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    expect(out.capturedAt).toBe(FIXED_ISO);
  });

  it("passes through legitimate top-level fields verbatim", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    expect(out.query).toBe("Mike Trout 2011 Topps Update US175");
    expect(out.endpoint).toBe("/api/compiq/search");
    expect(out.responseDurationMs).toBe(142);
    expect(out.querySource).toBe("free_text");
  });

  it("passes through querySource = \"card_id\" verbatim", () => {
    const input = { ...buildPoisonedInput(), querySource: "card_id" as const };
    const out = buildCorpusEntry(input);
    expect(out.querySource).toBe("card_id");
  });

  it("passes through legitimate response fields verbatim", () => {
    const out = buildCorpusEntry(buildPoisonedInput());
    expect(out.response.fairMarketValueLive).toBe(1250.5);
    expect(out.response.confidence).toBe(0.87);
    expect(out.response.pricingEngine).toBe("monolith");
    expect(out.response.engineVersion).toBe("4f14338");
    expect(out.response.marketState).toBe("liquid");
    expect(out.response.marketStateSchemaVersion).toBe(1);
    expect(out.response.sampleSize).toBe(23);
  });

  it("truncates query longer than 500 chars with \"...[truncated]\" suffix", () => {
    const longQuery = "X".repeat(600);
    const input = { ...buildPoisonedInput(), query: longQuery };
    const out = buildCorpusEntry(input);
    expect(out.query.length).toBeLessThanOrEqual(500);
    expect(out.query.endsWith("...[truncated]")).toBe(true);
  });

  it("does NOT truncate queries at or under 500 chars", () => {
    const exactly500 = "Y".repeat(500);
    const input = { ...buildPoisonedInput(), query: exactly500 };
    const out = buildCorpusEntry(input);
    expect(out.query).toBe(exactly500);
    expect(out.query.endsWith("...[truncated]")).toBe(false);
  });

  it("returns an object that satisfies the CorpusEntry type structurally", () => {
    // Compile-time-style structural check: the output is assigned to a
    // typed variable. If the builder ever returns a shape that doesn't
    // satisfy CorpusEntry, this stops compiling.
    const out: CorpusEntry = buildCorpusEntry(buildPoisonedInput());
    expect(out).toBeDefined();
  });
});
