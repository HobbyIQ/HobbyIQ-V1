// CF-ATTRIBUTION-HEALTH (Drew, 2026-07-17). Pinning tests for the
// pure buildSuspect / computeAttributionScore logic. Cosmos mocking
// happens through the buildSuspect entrypoint so we don't need a
// container stub for the compute half.

import { describe, it, expect } from "vitest";
import {
  buildSuspect,
  computeAttributionScore,
  VERIFIED_SCORE_THRESHOLD,
  MIN_TOTAL_SALES_FOR_SIGNAL,
} from "../src/services/portfolioiq/attributionHealthAnalyze.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import type { CHCardAttributionStats } from "../src/types/chSalePhash.types.js";

function mkHolding(overrides: Partial<PortfolioHolding> & { cardId?: string } = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Eric Hartman",
    cardTitle: "2026 Bowman Hartman Refractor",
    cardYear: 2026,
    setName: "Bowman",
    cardNumber: "CPA-EHA",
    parallel: "Refractor",
    ...overrides,
  } as PortfolioHolding & { cardId?: string };
}

function mkStats(overrides: Partial<CHCardAttributionStats> = {}): CHCardAttributionStats {
  return {
    id: "card-abc",
    card_id: "card-abc",
    total_hashed_sales: 20,
    cluster_count: 2,
    largest_cluster_size: 15,
    smallest_cluster_size: 5,
    suspect: true,
    last_updated: "2026-07-17T06:00:00Z",
    ...overrides,
  };
}

describe("computeAttributionScore", () => {
  it("clean single-cluster card scores 1.0", () => {
    const stats = mkStats({
      total_hashed_sales: 20,
      cluster_count: 1,
      largest_cluster_size: 20,
      smallest_cluster_size: 20,
      suspect: false,
    });
    expect(computeAttributionScore(stats)).toBe(1);
  });

  it("even 50/50 split scores 0.5", () => {
    const stats = mkStats({
      total_hashed_sales: 10,
      largest_cluster_size: 5,
      smallest_cluster_size: 5,
    });
    expect(computeAttributionScore(stats)).toBe(0.5);
  });

  it("dominant + tiny outlier scores near 1", () => {
    const stats = mkStats({
      total_hashed_sales: 100,
      largest_cluster_size: 95,
      smallest_cluster_size: 5,
    });
    expect(computeAttributionScore(stats)).toBe(0.95);
  });

  it("zero total defensively returns 1", () => {
    const stats = mkStats({ total_hashed_sales: 0, largest_cluster_size: 0 });
    expect(computeAttributionScore(stats)).toBe(1);
  });
});

describe("buildSuspect — filter/gate cases", () => {
  it("returns null when stats is missing", () => {
    const s = buildSuspect(mkHolding({ cardId: "abc" }), "abc", null);
    expect(s).toBeNull();
  });

  it("returns null when stats.suspect is false", () => {
    const stats = mkStats({ suspect: false, cluster_count: 1, largest_cluster_size: 20, smallest_cluster_size: 20 });
    expect(buildSuspect(mkHolding({ cardId: "abc" }), "abc", stats)).toBeNull();
  });

  it("returns null when total_hashed_sales < MIN_TOTAL_SALES_FOR_SIGNAL", () => {
    const stats = mkStats({
      total_hashed_sales: MIN_TOTAL_SALES_FOR_SIGNAL - 1,
      largest_cluster_size: 3,
      smallest_cluster_size: 2,
    });
    expect(buildSuspect(mkHolding({ cardId: "abc" }), "abc", stats)).toBeNull();
  });

  it("returns null when attributionScore >= VERIFIED_SCORE_THRESHOLD", () => {
    // 19/20 = 0.95 → above 0.85 threshold, filtered out even though suspect
    const stats = mkStats({
      total_hashed_sales: 20,
      largest_cluster_size: 19,
      smallest_cluster_size: 1,
      suspect: true,
    });
    expect(buildSuspect(mkHolding({ cardId: "abc" }), "abc", stats)).toBeNull();
  });

  it("returns null when total_hashed_sales <= 0 defensively", () => {
    const stats = mkStats({ total_hashed_sales: 0 });
    expect(buildSuspect(mkHolding({ cardId: "abc" }), "abc", stats)).toBeNull();
  });
});

describe("buildSuspect — happy path", () => {
  it("emits a suspect when signal is low_confidence + suspect flag set", () => {
    // 12/20 = 0.6 → below 0.85 threshold
    const stats = mkStats({
      total_hashed_sales: 20,
      largest_cluster_size: 12,
      smallest_cluster_size: 8,
    });
    const s = buildSuspect(mkHolding({ id: "h1", cardId: "abc" }), "abc", stats);
    expect(s).not.toBeNull();
    expect(s!.holdingId).toBe("h1");
    expect(s!.cardId).toBe("abc");
    expect(s!.confidence).toBe("low_confidence");
    expect(s!.attributionScore).toBe(0.6);
    expect(s!.reason).toContain("8 sales hash-cluster");
    expect(s!.otherCandidates).toEqual([]);
  });

  it("uses singular 'sale' in reason when only 1 outlier", () => {
    // Need to keep score below threshold but only 1 outlier — 6 total, 5 vs 1 → 0.833
    const stats = mkStats({
      total_hashed_sales: 6,
      largest_cluster_size: 5,
      smallest_cluster_size: 1,
    });
    const s = buildSuspect(mkHolding({ id: "h1", cardId: "abc" }), "abc", stats);
    expect(s).not.toBeNull();
    expect(s!.reason).toContain("1 sale hash-cluster");
    expect(s!.reason).not.toContain("1 sales");
  });

  it("passes through player + cardTitle from holding", () => {
    const stats = mkStats({
      total_hashed_sales: 20,
      largest_cluster_size: 12,
      smallest_cluster_size: 8,
    });
    const s = buildSuspect(
      mkHolding({ id: "h1", cardId: "abc", playerName: "Aaron Judge", cardTitle: "2016 Bowman Judge RC" }),
      "abc",
      stats,
    );
    expect(s!.player).toBe("Aaron Judge");
    expect(s!.cardTitle).toBe("2016 Bowman Judge RC");
  });

  it("falls back to composed description when cardTitle absent", () => {
    const stats = mkStats({
      total_hashed_sales: 20,
      largest_cluster_size: 12,
      smallest_cluster_size: 8,
    });
    const holding = mkHolding({
      id: "h1",
      cardId: "abc",
      cardTitle: undefined,
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "Bowman",
      cardNumber: "CPA-EHA",
      parallel: "Refractor",
    });
    const s = buildSuspect(holding, "abc", stats);
    expect(s!.cardTitle).toBe("2026 Bowman Eric Hartman CPA-EHA Refractor");
  });

  it("falls back to 'unknown' player when playerName absent", () => {
    const stats = mkStats({
      total_hashed_sales: 20,
      largest_cluster_size: 12,
      smallest_cluster_size: 8,
    });
    const s = buildSuspect(
      mkHolding({ id: "h1", cardId: "abc", playerName: undefined }),
      "abc",
      stats,
    );
    expect(s!.player).toBe("unknown");
  });

  it("VERIFIED_SCORE_THRESHOLD is 0.85 (pinned)", () => {
    expect(VERIFIED_SCORE_THRESHOLD).toBe(0.85);
  });

  it("MIN_TOTAL_SALES_FOR_SIGNAL is 6 (pinned)", () => {
    expect(MIN_TOTAL_SALES_FOR_SIGNAL).toBe(6);
  });
});
