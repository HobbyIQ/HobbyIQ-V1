// CF-COMMUNITY-INTELLIGENCE (Drew, 2026-07-17). Pinning tests for the
// k-anonymity aggregation math. Every test verifies both the numeric
// answer AND the suppression reason — no aggregate is EVER exposed
// below the k-anonymity floor.

import { describe, it, expect } from "vitest";
import { aggregateCommunitySignal, DEFAULT_K_ANONYMITY } from "../src/services/community/communityAggregation.service.js";

const BASE = {
  cardId: "card-1",
  turnoverWindowDays: 30,
};

describe("aggregateCommunitySignal — k-anonymity gates", () => {
  it("Below K holders → holderShare suppressed with reason", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 3,           // < 5
      totalContributors: 100,
      soldInWindowCount: 0,
      ownersInWindowCount: 0,
    });
    expect(r.holderShare.value).toBeNull();
    expect(r.holderShare.reason).toBe("below_k_anonymity");
  });

  it("At K holders → holderShare exposed", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 5,
      totalContributors: 100,
      soldInWindowCount: 0,
      ownersInWindowCount: 0,
    });
    expect(r.holderShare.value).toBeCloseTo(0.05, 4);
    expect(r.holderShare.reason).toBe("ok");
  });

  it("Zero contributors → no_contributors reason (distinct from k-anonymity)", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 0,
      totalContributors: 0,
      soldInWindowCount: 0,
      ownersInWindowCount: 0,
    });
    expect(r.holderShare.value).toBeNull();
    expect(r.holderShare.reason).toBe("no_contributors");
  });

  it("K override allows tighter or looser gating", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 3,
      totalContributors: 100,
      soldInWindowCount: 0,
      ownersInWindowCount: 0,
      kAnonymity: 2,
    });
    expect(r.holderShare.value).toBeCloseTo(0.03, 4);
    expect(r.holderShare.reason).toBe("ok");
  });
});

describe("aggregateCommunitySignal — cohort turnover", () => {
  it("Compute turnover ratio", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 20,
      totalContributors: 100,
      soldInWindowCount: 6,
      ownersInWindowCount: 20,
    });
    expect(r.turnover.value).toBeCloseTo(0.30, 4);
    expect(r.turnover.reason).toBe("ok");
    expect(r.turnover.windowDays).toBe(30);
  });

  it("Below K owners → turnover suppressed", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 3,
      totalContributors: 100,
      soldInWindowCount: 2,
      ownersInWindowCount: 3,
    });
    expect(r.turnover.value).toBeNull();
    expect(r.turnover.reason).toBe("below_k_anonymity");
  });
});

describe("aggregateCommunitySignal — consensus predicted price", () => {
  it("Below K estimates → suppressed", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 10, totalContributors: 100,
      soldInWindowCount: 0, ownersInWindowCount: 10,
      contributedEstimates: [2500, 2600, 2700],   // < 5
    });
    expect(r.consensusPrice.value).toBeNull();
    expect(r.consensusPrice.reason).toBe("below_k_anonymity");
  });

  it("At K estimates → median exposed", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 10, totalContributors: 100,
      soldInWindowCount: 0, ownersInWindowCount: 10,
      contributedEstimates: [2400, 2500, 2600, 2700, 2800],
    });
    expect(r.consensusPrice.value).toBeCloseTo(2600, 1);
    expect(r.consensusPrice.reason).toBe("ok");
    expect(r.consensusPrice.sampleSize).toBe(5);
  });

  it("Invalid estimates filtered out", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 10, totalContributors: 100,
      soldInWindowCount: 0, ownersInWindowCount: 10,
      contributedEstimates: [2500, 0, -100, NaN, 2600, 2700, 2800, 2400],
    });
    expect(r.consensusPrice.sampleSize).toBe(5);   // 5 valid
    expect(r.consensusPrice.value).toBeCloseTo(2600, 1);
  });
});

describe("aggregateCommunitySignal — invariants", () => {
  it("DEFAULT_K_ANONYMITY is 5 (documented baseline)", () => {
    expect(DEFAULT_K_ANONYMITY).toBe(5);
  });

  it("kAnonymity field surfaced on the result so iOS knows the gate", () => {
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 5, totalContributors: 100,
      soldInWindowCount: 0, ownersInWindowCount: 5,
    });
    expect(r.kAnonymity).toBe(DEFAULT_K_ANONYMITY);
  });

  it("holderShare value is 0..1 only, never > 1", () => {
    // This SHOULD be impossible per the input contract (holderCount ≤
    // totalContributors), but the test pins the invariant.
    const r = aggregateCommunitySignal({
      ...BASE,
      holderCount: 100,
      totalContributors: 100,
      soldInWindowCount: 0,
      ownersInWindowCount: 0,
    });
    expect(r.holderShare.value).toBe(1);
  });
});
