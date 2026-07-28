// CF-VERIFY-QUEUE-SURFACE (Drew, 2026-07-28). Type-level + import-graph
// pinning tests for the verify queue foundation. Real Cosmos behavior
// verified live after the containers land.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  countPending,
  listPending,
  resolveQueued,
  enqueueForVerify,
} from "../src/services/portfolioiq/verifyQueue.service.js";
import {
  recordVerifyCorrection,
  lookupCorrectionForTitle,
} from "../src/services/portfolioiq/verifyCorrections.service.js";
import { computeDataQualityReport } from "../src/services/portfolioiq/dataQuality.service.js";

describe("verify-and-learn surface — exports", () => {
  it("exports the enqueue + resolve + list APIs", () => {
    expect(typeof enqueueForVerify).toBe("function");
    expect(typeof listPending).toBe("function");
    expect(typeof countPending).toBe("function");
    expect(typeof resolveQueued).toBe("function");
  });

  it("exports the corrections training log APIs", () => {
    expect(typeof recordVerifyCorrection).toBe("function");
    expect(typeof lookupCorrectionForTitle).toBe("function");
  });

  it("exports the pool-level dataQuality report", () => {
    expect(typeof computeDataQualityReport).toBe("function");
  });
});

describe("verify-and-learn surface — silent-safe when Cosmos absent", () => {
  // Sanity: none of these should throw in an env without a valid
  // COSMOS_CONNECTION_STRING. All go through cached-container helpers
  // that return null and the callers no-op.
  const restore = process.env.COSMOS_CONNECTION_STRING;
  beforeAll(() => {
    process.env.COSMOS_CONNECTION_STRING = "";
  });
  afterAll(() => {
    process.env.COSMOS_CONNECTION_STRING = restore ?? "";
  });

  it("enqueueForVerify returns null instead of throwing", async () => {
    const id = await enqueueForVerify({
      reason: "price-outlier",
      saleInput: {
        cardId: "test-card",
        playerName: "Test",
        price: 100,
        soldAt: new Date().toISOString(),
        source: "cardsight",
      },
    });
    expect(id).toBeNull();
  });

  it("listPending returns empty items", async () => {
    const r = await listPending();
    expect(r.items).toEqual([]);
  });

  it("countPending returns 0", async () => {
    expect(await countPending()).toBe(0);
  });

  it("dataQuality report returns zero-populated shape", async () => {
    const r = await computeDataQualityReport(180);
    expect(r.totalRows).toBe(0);
    expect(r.trustScore).toBe(0);
    expect(r.trustPercentageDisplay).toBe("0.0%");
    expect(r.buckets).toEqual({
      verified: 0,
      catalogMatched: 0,
      autoParsed: 0,
      uncertain: 0,
      flagged: 0,
      pendingVerify: 0,
    });
  });
});
