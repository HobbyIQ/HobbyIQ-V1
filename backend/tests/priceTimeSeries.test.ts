// CF-PRICE-TIME-SERIES (Drew, 2026-07-15) — pins the sold_comps
// aggregation service that feeds iOS chart + seasonality signals.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  recordSoldComp,
  flagCompAsWrong,
  _setContainerForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";
import { buildPriceHistory } from "../src/services/portfolioiq/priceTimeSeries.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const cid = params.get("@cid");
            const from = params.get("@from");
            const to = params.get("@to");
            let rows = Array.from(store.values());
            if (cid) rows = rows.filter((d) => d.cardId === cid);
            if (from) rows = rows.filter((d) => d.soldAt >= from);
            if (to) rows = rows.filter((d) => d.soldAt <= to);
            rows.sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1));
            return { resources: rows };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          return { resource: store.get(`${pk}::${id}`) as T | undefined };
        },
      };
    },
  } as unknown as Container;
  return { container, store };
}

let store: Map<string, any>;
beforeEach(() => {
  const f = fakeContainer();
  store = f.store;
  _setContainerForTests(f.container);
});
afterEach(() => _setContainerForTests(null));

async function seed(cardId: string, sales: Array<{ price: number; date: string; source?: any; extId?: string; confidence?: number }>) {
  let idx = 0;
  for (const s of sales) {
    await recordSoldComp({
      cardId, playerName: "P", price: s.price, soldAt: s.date,
      source: s.source ?? "cardhedge",
      sourceExternalId: s.extId ?? `id-${idx++}`,
      confidence: s.confidence,
    });
  }
}

describe("buildPriceHistory — bucketing", () => {
  it("monthly bucketing groups sales by month-start (UTC)", async () => {
    // Use window="all" so we're not sensitive to today's date drift.
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z" },
      { price: 120, date: "2025-06-20T00:00:00Z" },
      { price: 90,  date: "2025-07-01T00:00:00Z" },
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toMatchObject({ bucketStart: "2025-06-01", count: 2, medianPrice: 110 });
    expect(r.points[1]).toMatchObject({ bucketStart: "2025-07-01", count: 1, medianPrice: 90 });
  });

  it("weekly bucketing groups by Sunday-anchored week", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-04T00:00:00Z" },  // Wed (week of Jun-1 Sunday)
      { price: 110, date: "2025-06-05T00:00:00Z" },
      { price: 120, date: "2025-06-08T00:00:00Z" },  // Sun (new week)
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "weekly" });
    expect(r.points).toHaveLength(2);
    expect(r.points[0].bucketStart).toBe("2025-06-01");  // week 1
    expect(r.points[0].count).toBe(2);
    expect(r.points[1].bucketStart).toBe("2025-06-08");
  });

  it("quarterly bucketing groups Q1/Q2/Q3/Q4", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-02-15T00:00:00Z" },  // Q1
      { price: 200, date: "2025-05-20T00:00:00Z" },  // Q2
      { price: 300, date: "2025-08-30T00:00:00Z" },  // Q3
      { price: 400, date: "2025-11-01T00:00:00Z" },  // Q4
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "quarterly" });
    expect(r.points.map((p) => p.bucketStart)).toEqual([
      "2025-01-01", "2025-04-01", "2025-07-01", "2025-10-01",
    ]);
  });
});

describe("buildPriceHistory — window filtering", () => {
  it("respects window=3m (drops older records)", async () => {
    const now = Date.now();
    await seed("cs-x", [
      { price: 100, date: new Date(now - 200 * 86_400_000).toISOString() },  // ~7mo old — out
      { price: 200, date: new Date(now - 60 * 86_400_000).toISOString() },   // 2mo — in
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "3m", bucket: "monthly" });
    expect(r.totalComps).toBe(1);
    expect(r.points[0].medianPrice).toBe(200);
  });

  it("window=all returns everything", async () => {
    await seed("cs-x", [
      { price: 100, date: "2020-01-15T00:00:00Z" },
      { price: 200, date: "2025-01-15T00:00:00Z" },
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    expect(r.totalComps).toBe(2);
  });
});

describe("buildPriceHistory — filtering + moderation", () => {
  it("excludes flaggedWrong rows (matches engine's augmentCompsWithUserPool skip)", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z", extId: "keep" },
      { price: 999, date: "2025-06-06T00:00:00Z", extId: "wrong" },
    ]);
    await flagCompAsWrong({
      cardId: "cs-x", compId: "cardhedge::wrong", flaggedByUserId: "u-mod",
    });
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    expect(r.totalComps).toBe(1);
    expect(r.points[0].medianPrice).toBe(100);
  });

  it("respects minConfidence threshold", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z", confidence: 0.9 },
      { price: 200, date: "2025-06-06T00:00:00Z", confidence: 0.3 },
    ]);
    const r = await buildPriceHistory({
      cardId: "cs-x", window: "all", bucket: "monthly", minConfidence: 0.7,
    });
    expect(r.totalComps).toBe(1);
    expect(r.points[0].medianPrice).toBe(100);
  });

  it("filters out zero/negative prices defensively", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z", extId: "ok" },
    ]);
    // Inject a bogus row directly (recordSoldComp would reject it)
    store.set("cs-x::cardhedge::bogus", {
      cardId: "cs-x", id: "cardhedge::bogus", playerName: "P", price: 0,
      soldAt: "2025-06-06T00:00:00Z", source: "cardhedge", confidence: 0.8, ttl: 1,
    });
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    expect(r.totalComps).toBe(1);
  });
});

describe("buildPriceHistory — output shape", () => {
  it("populates sourceBreakdown by source", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z", source: "cardhedge", extId: "a" },
      { price: 110, date: "2025-06-06T00:00:00Z", source: "cardhedge", extId: "b" },
      { price: 120, date: "2025-06-07T00:00:00Z", source: "cardsight", extId: "c" },
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    expect(r.points[0].sourceBreakdown).toEqual({ cardhedge: 2, cardsight: 1 });
  });

  it("populates min/max/mean/median correctly", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z" },
      { price: 200, date: "2025-06-06T00:00:00Z" },
      { price: 300, date: "2025-06-07T00:00:00Z" },
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    const p = r.points[0];
    expect(p.minPrice).toBe(100);
    expect(p.maxPrice).toBe(300);
    expect(p.meanPrice).toBe(200);
    expect(p.medianPrice).toBe(200);
  });

  it("returns empty points array + null dates when nothing matches", async () => {
    const r = await buildPriceHistory({ cardId: "unknown-card", window: "1y", bucket: "monthly" });
    expect(r.totalComps).toBe(0);
    expect(r.points).toHaveLength(0);
    expect(r.earliestSoldAt).toBeNull();
    expect(r.latestSoldAt).toBeNull();
  });

  it("carries earliestSoldAt + latestSoldAt from the filtered pool", async () => {
    await seed("cs-x", [
      { price: 100, date: "2025-06-05T00:00:00Z" },
      { price: 200, date: "2025-07-15T00:00:00Z" },
      { price: 300, date: "2025-05-01T00:00:00Z" },
    ]);
    const r = await buildPriceHistory({ cardId: "cs-x", window: "all", bucket: "monthly" });
    expect(r.earliestSoldAt).toBe("2025-05-01T00:00:00Z");
    expect(r.latestSoldAt).toBe("2025-07-15T00:00:00Z");
  });
});
