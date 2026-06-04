// CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): aging buckets pin.
//
// Locks the bucket list AND order. iOS depends on the order to render
// the "ACT NOW: 90-day cutoff approaching" banner on the >60d bucket.

import { describe, expect, it } from "vitest";
import { buildAging } from "../src/services/portfolioiq/erpAgingOverride.service";
import type { LedgerEntryForErp } from "../src/services/portfolioiq/erpReconciliation.service";

function entryAged(days: number, id: string, nowMs: number, over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  const soldMs = nowMs - days * 24 * 60 * 60 * 1000;
  return {
    id, userId: "u-1", holdingId: "h-1",
    playerName: "x", cardTitle: "x", quantitySold: 1, unitSalePrice: 100,
    grossProceeds: 100, fees: 0, tax: 0, shipping: 0,
    netProceeds: 100, costBasisSold: 50,
    realizedProfitLoss: 50, realizedProfitLossPct: 100,
    soldAt: new Date(soldMs).toISOString(),
    source: "ebay",
    needsReconciliation: true,
    ...over,
  } as unknown as LedgerEntryForErp;
}

describe("buildAging — 4-bucket list", () => {
  const nowMs = new Date("2026-06-04T00:00:00Z").getTime();

  it("returns exactly 4 buckets in the documented order", () => {
    const r = buildAging([], nowMs);
    expect(r.buckets.map((b) => b.bucket)).toEqual([
      "0-7d",
      "8-30d",
      "31-60d",
      ">60d",
    ]);
  });

  it("only the >60d bucket carries cutoffWarning=true", () => {
    const r = buildAging([], nowMs);
    expect(r.buckets[0].cutoffWarning).toBeUndefined();
    expect(r.buckets[1].cutoffWarning).toBeUndefined();
    expect(r.buckets[2].cutoffWarning).toBeUndefined();
    expect(r.buckets[3].cutoffWarning).toBe(true);
  });

  it("distributes entries to the right bucket by age in days", () => {
    const ledger: LedgerEntryForErp[] = [
      entryAged(3,  "e-fresh",       nowMs),
      entryAged(7,  "e-7d-edge",     nowMs),
      entryAged(15, "e-mid-30",      nowMs),
      entryAged(30, "e-30d-edge",    nowMs),
      entryAged(45, "e-mid-60",      nowMs),
      entryAged(60, "e-60d-edge",    nowMs),
      entryAged(75, "e-cutoff",      nowMs),
      entryAged(100,"e-over-cutoff", nowMs),
    ];
    const r = buildAging(ledger, nowMs);
    const byBucket = Object.fromEntries(
      r.buckets.map((b) => [b.bucket, b.entryIds]),
    );
    expect(byBucket["0-7d"]).toEqual(["e-fresh", "e-7d-edge"]);
    expect(byBucket["8-30d"]).toEqual(["e-mid-30", "e-30d-edge"]);
    expect(byBucket["31-60d"]).toEqual(["e-mid-60", "e-60d-edge"]);
    expect(byBucket[">60d"]).toEqual(["e-cutoff", "e-over-cutoff"]);
    expect(r.totalUnreconciled).toBe(8);
  });

  it("reconciled entries are excluded entirely", () => {
    const ledger: LedgerEntryForErp[] = [
      entryAged(5,  "e-reconciled", nowMs, { needsReconciliation: false }),
      entryAged(10, "e-unrec",      nowMs),
    ];
    const r = buildAging(ledger, nowMs);
    expect(r.totalUnreconciled).toBe(1);
    const ids = r.buckets.flatMap((b) => b.entryIds);
    expect(ids).toEqual(["e-unrec"]);
  });

  it("invalid soldAt → >60d bucket (defensive)", () => {
    const broken = entryAged(0, "e-broken", nowMs, { soldAt: "not-a-date" } as any);
    const r = buildAging([broken], nowMs);
    expect(r.buckets[3].entryIds).toEqual(["e-broken"]);
  });
});
