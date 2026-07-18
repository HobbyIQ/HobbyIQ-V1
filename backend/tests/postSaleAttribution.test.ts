// CF-POST-SALE-ATTRIBUTION (Drew, 2026-07-17). Pinning tests for the
// pure classification math.

import { describe, it, expect } from "vitest";
import { classifySale } from "../src/services/dailyiq/postSaleAttribution.service.js";
import type { ActionPlanSnapshotDoc } from "../src/services/dailyiq/actionPlanSnapshotStore.service.js";
import type { ActionVerdict } from "../src/services/dailyiq/dailyIqActionPlanCompute.service.js";

function snap(overrides: Partial<ActionPlanSnapshotDoc> = {}): ActionPlanSnapshotDoc {
  return {
    id: "h1::2026-07-10",
    holdingId: "h1",
    userId: "u1",
    cardId: "c1",
    date: "2026-07-10",
    verdict: "SELL_NOW" as ActionVerdict,
    urgency: 85,
    priceTarget: 2639,
    marketValueAtSnapshot: 1990,
    predictedPriceAtSnapshot: 2639,
    computedAt: "2026-07-10T12:00:00Z",
    ttl: 15552000,
    ...overrides,
  };
}

describe("classifySale — no snapshot", () => {
  it("no_verdict when snapshots empty", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 2500,
      snapshots: [],
    });
    expect(r.outcomeClass).toBe("no_verdict");
    expect(r.verdictAtSaleTime).toBeNull();
  });
});

describe("classifySale — SELL_NOW verdict", () => {
  it("Sale at target → verdict_hit", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 2639,
      snapshots: [snap({ verdict: "SELL_NOW", priceTarget: 2639 })],
    });
    expect(r.outcomeClass).toBe("verdict_hit");
    expect(r.verdictAtSaleTime).toBe("SELL_NOW");
    expect(r.daysSinceVerdict).toBe(5);
  });

  it("Sale within 5% below target → verdict_hit (tolerance)", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 2600,  // 1.5% below
      snapshots: [snap({ priceTarget: 2639 })],
    });
    expect(r.outcomeClass).toBe("verdict_hit");
  });

  it("Sale below tolerance → verdict_miss", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 2000,   // 24% below
      snapshots: [snap({ priceTarget: 2639 })],
    });
    expect(r.outcomeClass).toBe("verdict_miss");
    expect(r.priceTargetAtSnapshot).toBe(2639);
  });

  it("SELL_NOW with null priceTarget → verdict_hit (best-effort)", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 1000,
      snapshots: [snap({ priceTarget: null })],
    });
    expect(r.outcomeClass).toBe("verdict_hit");
  });
});

describe("classifySale — HOLD / WAIT verdicts", () => {
  it("Sold despite HOLD → hold_sold", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 3000,
      snapshots: [snap({ verdict: "HOLD", priceTarget: null })],
    });
    expect(r.outcomeClass).toBe("hold_sold");
  });

  it("Sold despite WAIT_TO_LIST → hold_sold", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 3000,
      snapshots: [snap({ verdict: "WAIT_TO_LIST" })],
    });
    expect(r.outcomeClass).toBe("hold_sold");
  });
});

describe("classifySale — GRADE_UP verdict", () => {
  it("Sold raw despite grade_up recommendation → verdict_miss", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 200,
      snapshots: [snap({ verdict: "GRADE_UP", priceTarget: 1000 })],
    });
    expect(r.outcomeClass).toBe("verdict_miss");
  });
});

describe("classifySale — LIST_HIGHER verdict", () => {
  it("Sold at target → verdict_hit", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 1000,
      snapshots: [snap({ verdict: "LIST_HIGHER", priceTarget: 1000 })],
    });
    expect(r.outcomeClass).toBe("verdict_hit");
  });
});

describe("classifySale — most recent snapshot wins", () => {
  it("Latest verdict is used even when older snapshots differ", () => {
    const r = classifySale({
      holdingId: "h1", userId: "u1", cardId: "c1",
      soldAt: "2026-07-15T12:00:00Z", salePrice: 2600,
      snapshots: [
        snap({ date: "2026-07-14", verdict: "SELL_NOW", priceTarget: 2639 }),
        snap({ date: "2026-07-10", verdict: "HOLD", priceTarget: null }),
      ],
    });
    expect(r.outcomeClass).toBe("verdict_hit");
    expect(r.verdictSnapshotDate).toBe("2026-07-14");
  });
});
