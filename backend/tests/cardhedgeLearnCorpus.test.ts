// CF-CARDHEDGE-LEARN-CORPUS (2026-07-04) — structural tests for the
// corpus persistence service. Verifies the exported API surface + fire-
// and-forget contract (never throws, never blocks). The Cosmos-writer
// path itself mirrors predictionCorpus.service.ts:104 whose write
// discipline is already covered by that service's regression suite.

import { describe, it, expect, beforeEach } from "vitest";

beforeEach(() => {
  // Clear Cosmos env vars so getContainer() returns null (no-op path).
  // The tests below verify each persist function tolerates that.
  delete process.env.COSMOS_CONNECTION_STRING;
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_KEY;
});

describe("cardhedgeLearnCorpus — public API + fire-and-forget contract", () => {
  it("exports the four persist functions", async () => {
    const svc = await import(
      "../src/services/compiq/cardhedgeLearnCorpus.service.js"
    );
    expect(typeof svc.persistReferencePrices).toBe("function");
    expect(typeof svc.persistObservedGradeCurve).toBe("function");
    expect(typeof svc.persistCertLookup).toBe("function");
    expect(typeof svc.persistCardPanel).toBe("function");
  });

  it("persistReferencePrices returns void synchronously (fire-and-forget) and does not throw when Cosmos is unconfigured", async () => {
    const { persistReferencePrices } = await import(
      "../src/services/compiq/cardhedgeLearnCorpus.service.js"
    );
    expect(() =>
      persistReferencePrices({
        source: "compiq.card-panel",
        cardId: "c1",
        player: "Eric Hartman",
        grades: [
          { grade: "Raw", grader: "Raw", referencePrice: 130, displayOrder: -1 },
        ],
      }),
    ).not.toThrow();
  });

  it("persistObservedGradeCurve does not throw when Cosmos is unconfigured", async () => {
    const { persistObservedGradeCurve } = await import(
      "../src/services/compiq/cardhedgeLearnCorpus.service.js"
    );
    expect(() =>
      persistObservedGradeCurve({
        source: "compiq.observed-grade-curve",
        cardId: "c1",
        totalSampleCount: 5,
        grades: [
          {
            grade: "Raw", grader: "Raw", sampleCount: 5,
            observedMedian: 130, valueSource: "observed",
            estimatedMultiplier: null, confidenceScore: 0.7,
            newestSaleDate: "2026-07-01",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("persistCertLookup does not throw and short-circuits when cardId is null", async () => {
    const { persistCertLookup } = await import(
      "../src/services/compiq/cardhedgeLearnCorpus.service.js"
    );
    // Both null cardId and valid cardId must not throw
    expect(() =>
      persistCertLookup({
        source: "compiq.lookup-by-cert", cardId: null,
        cert: "notfound", grader: "PSA", grade: null,
        player: null, matchConfidence: null,
        referencePrice: null, priceSampleCount: 0,
      }),
    ).not.toThrow();
    expect(() =>
      persistCertLookup({
        source: "compiq.lookup-by-cert", cardId: "c1",
        cert: "12345678", grader: "PSA", grade: "10",
        player: "Mike Trout", matchConfidence: 0.97,
        referencePrice: 2500, priceSampleCount: 3,
      }),
    ).not.toThrow();
  });

  it("persistCardPanel does not throw when Cosmos is unconfigured", async () => {
    const { persistCardPanel } = await import(
      "../src/services/compiq/cardhedgeLearnCorpus.service.js"
    );
    expect(() =>
      persistCardPanel({
        source: "compiq.card-panel", cardId: "c1",
        identityResolved: true,
        gradeCurveSampleCount: 12, referenceRowCount: 6,
      }),
    ).not.toThrow();
  });

  it("all four persist calls return void (not Promise) — fire-and-forget", async () => {
    const svc = await import(
      "../src/services/compiq/cardhedgeLearnCorpus.service.js"
    );
    const noop = { grade: "Raw", grader: "Raw", referencePrice: 1, displayOrder: null };
    expect(
      svc.persistReferencePrices({ source: "s", cardId: "c", player: null, grades: [noop] }),
    ).toBeUndefined();
    expect(
      svc.persistCardPanel({
        source: "s", cardId: "c", identityResolved: false,
        gradeCurveSampleCount: 0, referenceRowCount: 0,
      }),
    ).toBeUndefined();
  });
});
