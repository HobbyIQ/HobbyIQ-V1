// CF-OUR-POOL-PORTFOLIO-PRICER — helper unit tests. Only exercises the
// mapping-and-classification logic; the underlying hobbyIqFmv.service is
// mocked to isolate the mapping surface from Cosmos.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import type { HobbyIqFmvResult } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")
  >("../src/services/portfolioiq/hobbyIqFmv.service.js");
  return {
    ...actual,
    computeHobbyIqFmv: vi.fn(),
  };
});

async function loadModule() {
  return await import("../src/services/portfolioiq/priceFromOurPool.service.js");
}

async function computeMock() {
  const mod = await import("../src/services/portfolioiq/hobbyIqFmv.service.js");
  return mod.computeHobbyIqFmv as unknown as ReturnType<typeof vi.fn>;
}

const baseHolding = (): PortfolioHolding =>
  ({
    id: "h1",
    cardYear: 2026,
    setName: "2026 Bowman Baseball",
    cardTitle: "2026 Bowman Chrome Orange Eric Hartman #CPA-EHA",
    cardNumber: "CPA-EHA",
    parallel: "Orange Shimmer Refractor",
    playerName: "Eric Hartman",
    isAuto: true,
    quantity: 1,
    gradeCompany: "PSA",
    gradeValue: 10,
    hobbyiqCardId: "hiq:baseball:2026:bowman:CPA-EHA:orange-shimmer-refractor:auto",
  }) as unknown as PortfolioHolding;

function fmvResultShell(overrides: Partial<HobbyIqFmvResult>): HobbyIqFmvResult {
  return {
    slug: "hiq:baseball:2026:bowman:CPA-EHA:orange-shimmer-refractor:auto",
    fmv: null,
    compCount: 0,
    min: null,
    max: null,
    breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
    trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
    recentComps: [],
    method: "no-basis",
    basisNote: "",
    confidence: 0,
    population: null,
    quality: { score: 0, flaggedCompCount: 0, sources: [] },
    computedAt: new Date().toISOString(),
    cachedFrom: "sold_comps",
    ...overrides,
  };
}

describe("priceHoldingFromOurPool", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the FMV service reports no-basis", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(fmvResultShell({ method: "no-basis", fmv: null }));
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());
    expect(result).toBeNull();
  });

  // CF-RARE-CARD-ANCHOR-LABEL (2026-08-22). The rare-card rung anchors on the
  // LAST ACTUAL SALE of the exact slug and projects it by the parent pool's
  // drift — the most empirical answer we hold for a card too rare to have a
  // pool. Its wrapper used to report it as "no-basis", and the guard above
  // then dropped it, so the card went blank.
  //
  // Measured across 57 holdings with slugs: 8 discarded, $1,466.47 of value,
  // including Caglianone's $205.48 last sale.
  it("KEEPS a rare-card anchor — it is the last real sale of this exact card", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(fmvResultShell({
      method: "rare-card-anchor",
      fmv: 650,
      min: 487.5,
      max: 812.5,
      compCount: 1,
      confidence: 0.45,
      basisNote: "Last sold $650 on 2026-08-17. Parent pool thin (31 total sales) — anchor to last sale ±25%.",
    }));
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());

    expect(result).not.toBeNull();
    expect(result!.estimatedValue).toBe(650);
  });

  it("publishes the rare-card anchor as an ESTIMATE with a band, never as a fact", async () => {
    // The projection forward is modelled, so it must not read as observed —
    // but it must still reach the user, which is the entire point of the rung.
    const mock = await computeMock();
    mock.mockResolvedValue(fmvResultShell({
      method: "rare-card-anchor",
      fmv: 112,
      min: 95.2,
      max: 128.8,
      compCount: 1,
      confidence: 0.65,
      basisNote: "Last sold $67.34 on 2026-07-29. Comparable base pool up 65.9% since. Projected: $112.",
    }));
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());

    expect(result!.valuationStatus).toBe("estimated");
    expect(result!.fairMarketValue).toBeNull();
    expect(result!.estimateLow).not.toBeNull();
    expect(result!.estimateHigh).not.toBeNull();
    // The prose is the transparency surface — it names the sale and the drift.
    expect(result!.estimateBasis).toContain("Last sold");
  });

  it("returns null when fmv is 0 (no positive comps in pool)", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(fmvResultShell({ method: "direct-slug", fmv: 0, compCount: 0 }));
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());
    expect(result).toBeNull();
  });

  it("returns null when the holding has no slug and none can be derived", async () => {
    // Kill cardYear so deriveHoldingSlug returns null.
    const h = { ...baseHolding(), cardYear: undefined, hobbyiqCardId: undefined } as unknown as PortfolioHolding;
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(h);
    expect(result).toBeNull();
  });

  it("classifies direct-slug on a graded query as OBSERVED", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(
      fmvResultShell({
        method: "direct-slug",
        fmv: 2100,
        compCount: 8,
        min: 1900,
        max: 2400,
        confidence: 0.9,
        basisNote: "Priced from 8 sales of this exact card",
      }),
    );
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());
    expect(result).not.toBeNull();
    expect(result?.valuationStatus).toBe("observed");
    expect(result?.fairMarketValue).toBe(2100);
    expect(result?.estimatedValue).toBeNull();
    expect(result?.method).toBe("direct-slug");
    expect(result?.compsUsed).toBe(8);
    expect(result?.source).toBe("our-pool");
    // Estimate range fields should be null on observed
    expect(result?.estimateLow).toBeNull();
    expect(result?.estimateHigh).toBeNull();
  });

  it("classifies grade-cross-raw as ESTIMATED with band + confidence tier", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(
      fmvResultShell({
        method: "grade-cross-raw",
        fmv: 2200,
        compCount: 5,
        min: 1500,
        max: 3200,
        confidence: 0.75,  // -> "estimate" tier
        basisNote: "Grade estimated from 5 raw sales × PSA 10 multiplier",
      }),
    );
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());
    expect(result).not.toBeNull();
    expect(result?.valuationStatus).toBe("estimated");
    expect(result?.fairMarketValue).toBeNull();
    expect(result?.estimatedValue).toBe(2200);
    expect(result?.estimateConfidence).toBe("estimate");
    expect(result?.method).toBe("grade-cross-raw");
    // Band should exist (either explicit min/max within envelope, or ±20%)
    expect(result?.estimateLow).not.toBeNull();
    expect(result?.estimateHigh).not.toBeNull();
    expect(result!.estimateLow! < result!.estimatedValue!).toBe(true);
    expect(result!.estimateHigh! > result!.estimatedValue!).toBe(true);
  });

  it("falls back to ±20% band when pool min/max envelope is too wide", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(
      fmvResultShell({
        method: "grade-cross-raw",
        fmv: 1000,
        compCount: 3,
        min: 10,      // way below fmv * 0.5 → envelope too wide → use ±20%
        max: 9999,
        confidence: 0.5,
        basisNote: "wide-envelope test",
      }),
    );
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());
    expect(result?.estimateLow).toBeCloseTo(800, 1);
    expect(result?.estimateHigh).toBeCloseTo(1200, 1);
  });

  it("returns null gracefully when the FMV service throws", async () => {
    const mock = await computeMock();
    mock.mockRejectedValue(new Error("cosmos down"));
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(baseHolding());
    expect(result).toBeNull();
  });

  it("uses derived slug when holding.hobbyiqCardId is missing", async () => {
    const mock = await computeMock();
    mock.mockResolvedValue(
      fmvResultShell({ method: "direct-slug", fmv: 100, compCount: 3, confidence: 0.8 }),
    );
    const h = { ...baseHolding(), hobbyiqCardId: undefined } as unknown as PortfolioHolding;
    const { priceHoldingFromOurPool } = await loadModule();
    const result = await priceHoldingFromOurPool(h);
    // deriveHoldingSlug needs a discoverable sport — for Bowman Baseball
    // it succeeds, so we should get a live path.
    expect(result).not.toBeNull();
    expect(result?.source).toBe("our-pool");
    // The mock was called (proving we went past the null-slug bail).
    expect(mock).toHaveBeenCalled();
  });
});

describe("isPriceFromOurPoolEnabled", () => {
  const original = process.env.PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED;
  afterEach(() => {
    process.env.PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED = original;
  });

  it("returns false when unset", async () => {
    delete process.env.PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED;
    const { isPriceFromOurPoolEnabled } = await loadModule();
    expect(isPriceFromOurPoolEnabled()).toBe(false);
  });

  it.each(["true", "TRUE", "  true  ", "1", "yes"])(
    "returns true for %s",
    async (v) => {
      process.env.PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED = v;
      const { isPriceFromOurPoolEnabled } = await loadModule();
      expect(isPriceFromOurPoolEnabled()).toBe(true);
    },
  );

  it.each(["false", "0", "no", "off", ""])("returns false for %s", async (v) => {
    process.env.PORTFOLIO_PRICE_FROM_OUR_POOL_ENABLED = v;
    const { isPriceFromOurPoolEnabled } = await loadModule();
    expect(isPriceFromOurPoolEnabled()).toBe(false);
  });
});
