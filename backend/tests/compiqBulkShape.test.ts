/**
 * /api/compiq/bulk per-item shape contract.
 *
 * This test fails loudly if any of the four pricing-emission fields go
 * missing from /bulk's per-item `data` block:
 *
 *   - fairMarketValueLive  (engine-emission symmetry with /search,
 *                            /price, /price-by-id — Option X)
 *   - compsUsed            (corpus sampleSize source)
 *   - compsAvailable       (UI / future analytics)
 *   - marketTier.value     (existing field; included for completeness)
 *
 * Background: prior to PR #2b, /bulk's per-item shape was missing
 * fairMarketValueLive AND compsUsed AND compsAvailable, which meant
 * corpus entries from /bulk would record null sampleSize and null FMV
 * on every write. The fix added all three; this test prevents
 * regression.
 */

import request from "supertest";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Disable the corpus writer for this test — we're asserting route
// shape, not Cosmos integration. The writer no-ops when this is set
// before module load (see writeCorpusEntry's disabled gate).
process.env.COMPIQ_CORPUS_DISABLED = "1";

// Mock computeEstimate so the route runs deterministically without
// touching upstream services or the network.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/compiqEstimate.service.js",
  );
  return {
    ...actual,
    computeEstimate: vi.fn(async (_body: any) => ({
      fairMarketValue: 250.0,
      premiumValue: 287.5,
      quickSaleValue: 220.0,
      marketDNA: { trend: "up" },
      confidence: { pricingConfidence: 75 },
      source: "live",
      verdict: "Test verdict",
      compsUsed: 12,
      compsAvailable: 18,
    })),
  };
});

let app: any;

beforeAll(async () => {
  // Import the app AFTER the mock is registered so the route picks up
  // the mocked computeEstimate.
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

describe("/api/compiq/bulk — per-item shape contract", () => {
  it("emits fairMarketValueLive, compsUsed, and compsAvailable on every per-item data block", async () => {
    const res = await request(app)
      .post("/api/compiq/bulk")
      .send({ queries: ["Card A", "Card B", "Card C"] });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(3);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toHaveLength(3);

    for (const item of res.body.results) {
      expect(item.status).toBe("ok");
      expect(item.data).toBeDefined();
      // The four pricing-emission fields under contract:
      expect(item.data.fairMarketValueLive).toBe(250.0);
      expect(item.data.compsUsed).toBe(12);
      expect(item.data.compsAvailable).toBe(18);
      expect(item.data.marketTier).toEqual({ value: 250.0, high: 287.5 });
    }
  });

  it("F1 regression: parses set-bearing query into structured body before computeEstimate", async () => {
    // Pre-fix bug: handler passed `{ playerName: query.trim() }`, so a query like
    // "Mike Trout 2011 Topps Update" became playerName="Mike Trout 2011 Topps Update".
    // CH-identity guard (compiqEstimate.service.ts:1194-1219) tokenized that into
    // ["mike","trout","2011","topps","update"], couldn't find "2011"/"topps"/"update"
    // in card.player ("Mike Trout") + card.title haystack, wiped comps as
    // identity-mismatch → source=no-recent-comps regardless of comp availability.
    //
    // Post-fix: handler calls parseCardQuery + requestFromParsed first, so
    // computeEstimate receives a STRUCTURED body with year, product, etc broken
    // out, and playerName stripped of set tokens.
    const svc = await import("../src/services/compiq/compiqEstimate.service.js");
    const mockFn = svc.computeEstimate as any;
    mockFn.mockClear();

    await request(app)
      .post("/api/compiq/bulk")
      .send({ queries: ["Mike Trout 2011 Topps Update US175"] });

    expect(mockFn).toHaveBeenCalledTimes(1);
    const passedBody = mockFn.mock.calls[0][0];
    // After parsing, playerName should be just "Mike Trout" (the player name),
    // NOT the raw query containing year/set/cardNumber tokens.
    expect(passedBody.playerName).toBe("Mike Trout");
    // Year, product, and cardNumber should be broken out as structured fields.
    expect(passedBody.cardYear).toBe(2011);
    expect(passedBody.product).toMatch(/Topps Update/i);
    expect(passedBody.cardNumber).toBe("US175");
  });

  it("writes fairMarketValueLive: null when the engine produces no FMV", async () => {
    // Re-mock for this single test to simulate a zero/missing FMV.
    const svc = await import("../src/services/compiq/compiqEstimate.service.js");
    (svc.computeEstimate as any).mockResolvedValueOnce({
      fairMarketValue: 0,
      premiumValue: 0,
      quickSaleValue: 0,
      marketDNA: { trend: "flat" },
      confidence: { pricingConfidence: 30 },
      source: "no-recent-comps",
      verdict: "no comps",
      compsUsed: 0,
      compsAvailable: 0,
    });

    const res = await request(app)
      .post("/api/compiq/bulk")
      .send({ queries: ["Empty Market Card"] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].data.fairMarketValueLive).toBeNull();
    expect(res.body.results[0].data.compsUsed).toBe(0);
    expect(res.body.results[0].data.compsAvailable).toBe(0);
  });
});
