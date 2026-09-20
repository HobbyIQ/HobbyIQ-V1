// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). computeMarketMovers's raw
// scan groups sold_comps rows by (cardId, parallel, gradeCompany,
// gradeValue) and computes prior/current medians + salesInWindow directly
// from the group — the exact shape the FMV path's median-of-last-3
// double-weighting bug exploited. This pins that a CardHedge dual-id twin
// no longer inflates salesInWindow or skews the medians, while a genuinely
// distinct sale at a different price is untouched and still drives a real
// mover.
//
// CF-VOLUME-READERS-NEED-DISTINCT-WRITERS (2026-09-20, review fix). This
// surface COUNTS sales, so it dedupes with `onlyWhen: distinctWriterShape`
// — a pair collapses ONLY when the two rows are different writer shapes
// (the CardHedge dual-id bug's real signature), never on price+time alone.
// Every fixture below carries realistic source/sourceExternalId fields so
// "twin" and "distinct" mean what they mean in production.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            query: () => {
              let done = false;
              return {
                hasMoreResults: () => !done,
                fetchNext: async () => {
                  done = true;
                  return { resources: h.rows };
                },
              };
            },
          },
        }),
      };
    }
  }
  return { CosmosClient };
});
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";
delete process.env.MARKET_MOVERS_USE_ROLLUPS;

import { computeMarketMovers } from "../src/services/compiq/marketMoversSnapshot.service.js";

const sale = (price: number, daysAgo: number, extra: Record<string, unknown> = {}) => ({
  cardId: "hiq:baseball:2024:topps:1:base:no-auto",
  playerName: "Test Player",
  setName: "Topps",
  parallel: null,
  cardNumber: "1",
  cardYear: 2024,
  gradeCompany: null,
  gradeValue: null,
  price,
  soldAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  imageUrl: null,
  title: null,
  source: "cardhedge",
  sourceExternalId: `ch-daily::${Math.random().toString(36).slice(2)}`,
  ...extra,
});

beforeEach(() => { h.rows = []; });

describe("computeMarketMovers — CardHedge dual-id twin is not double-counted", () => {
  it("a genuine dual-id twin pair (bare + composite ch-daily shape) counts as ONE sale in salesInWindow", async () => {
    const twinTime = Date.now() - 2 * 86_400_000;
    h.rows = [
      // prior window: 3 genuine sales at $10
      sale(10, 6), sale(10, 5), sale(10, 4),
      // current window: a twin pair at $30 (minutes apart, two DIFFERENT
      // writer shapes -- the real dual-id bug signature) + one more real sale
      { ...sale(30, 2), soldAt: new Date(twinTime).toISOString(), sourceExternalId: "ch-daily::abc111" },
      { ...sale(30, 2), soldAt: new Date(twinTime + 5 * 60_000).toISOString(), sourceExternalId: "ch-daily::card-1::2026-07-14T00:00:00Z::3000" },
      sale(35, 1),
    ];
    const result = await computeMarketMovers({ sport: "baseball", windowDays: 7, direction: "both", limit: 20, minSales: 3 });
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    const mover = result.movers.find((m) => m.cardId === "hiq:baseball:2024:topps:1:base:no-auto");
    expect(mover).toBeDefined();
    // 3 prior + (2 twin-collapsed-to-1 + 1 real) = 3 prior + 2 current = 5,
    // never 6 — the twin must not inflate the count.
    expect(mover!.salesInWindow).toBe(5);
  });

  it("KEEPS two SAME-shape sales at the same price/moment -- volume readers never blunt-collapse on price+time alone", async () => {
    // Two rows from the SAME writer shape (both bare ch-daily::<token>) at
    // the identical price and moment: this is real repeated-price volume,
    // NOT the dual-id bug, so both must survive. This is exactly what the
    // plain gradeKey|price rule (used everywhere else) would have wrongly
    // collapsed -- the reason this call site needs `onlyWhen` at all.
    const sameMoment = new Date(Date.now() - 2 * 86_400_000).toISOString();
    h.rows = [
      sale(10, 6), sale(10, 5), sale(10, 4),
      { ...sale(30, 2), soldAt: sameMoment, sourceExternalId: "ch-daily::tokenA" },
      { ...sale(30, 2), soldAt: sameMoment, sourceExternalId: "ch-daily::tokenB" },
    ];
    const result = await computeMarketMovers({ sport: "baseball", windowDays: 7, direction: "both", limit: 20, minSales: 3 });
    if ("unavailable" in result) throw new Error("unavailable");
    const mover = result.movers.find((m) => m.cardId === "hiq:baseball:2024:topps:1:base:no-auto");
    expect(mover).toBeDefined();
    expect(mover!.salesInWindow).toBe(5); // 3 prior + 2 current (both survive)
  });

  it("30 genuine same-shape sales of a common in one hour ALL count -- never collapsed to 1", async () => {
    // Prior sales at $9.99 (clears moverCredibility's $5 minPriorUsd floor),
    // current sales at $14.99 -- a real, rankable move -- so this test
    // exercises the COUNT (salesInWindow), not the credibility/ranking gate.
    const base = Date.now() - 2 * 86_400_000;
    const currentSales = Array.from({ length: 30 }, (_, i) =>
      ({ ...sale(14.99, 2), soldAt: new Date(base + i * 60_000).toISOString(), sourceExternalId: `ch-daily::token-${i}` }));
    h.rows = [sale(9.99, 6), sale(9.99, 5), sale(9.99, 4), ...currentSales];
    const result = await computeMarketMovers({ sport: "baseball", windowDays: 7, direction: "both", limit: 20, minSales: 3 });
    if ("unavailable" in result) throw new Error("unavailable");
    const mover = result.movers.find((m) => m.cardId === "hiq:baseball:2024:topps:1:base:no-auto");
    expect(mover).toBeDefined();
    expect(mover!.salesInWindow).toBe(33); // 3 prior + 30 current, none collapsed
  });

  it("KEEPS two genuinely distinct sales at different prices in the same window", async () => {
    h.rows = [
      sale(10, 6), sale(10, 5), sale(10, 4),
      sale(30, 2), sale(35, 1), sale(40, 1),
    ];
    const result = await computeMarketMovers({ sport: "baseball", windowDays: 7, direction: "both", limit: 20, minSales: 3 });
    if ("unavailable" in result) throw new Error("unavailable");
    const mover = result.movers.find((m) => m.cardId === "hiq:baseball:2024:topps:1:base:no-auto");
    expect(mover).toBeDefined();
    expect(mover!.salesInWindow).toBe(6);
  });

  it("never merges two DIFFERENT grades sharing a price and moment", async () => {
    const sameMoment = new Date(Date.now() - 2 * 86_400_000).toISOString();
    h.rows = [
      sale(10, 6), sale(10, 5), sale(10, 4),
      { ...sale(30, 2, { gradeCompany: null, gradeValue: null }), soldAt: sameMoment },
      { ...sale(30, 2, { gradeCompany: "PSA", gradeValue: 10 }), soldAt: sameMoment },
      sale(35, 1),
    ];
    const result = await computeMarketMovers({ sport: "baseball", windowDays: 7, direction: "both", limit: 20, minSales: 1 });
    if ("unavailable" in result) throw new Error("unavailable");
    // Two separate groups: (parallel=null, grade=Raw) and (parallel=null, grade=PSA 10).
    // Raw group: prior 3 @ $10, current [$30, $35] (2 sales). PSA 10 group:
    // no prior sales, so it is excluded (prior.length === 0 continue) —
    // confirms the raw group's current count is 2, not 1 (which it would be
    // if the raw/PSA10 rows at $30 had wrongly collapsed together).
    const mover = result.movers.find((m) => m.cardId === "hiq:baseball:2024:topps:1:base:no-auto");
    expect(mover).toBeDefined();
    expect(mover!.salesInWindow).toBe(5); // 3 prior + 2 current (raw group only)
  });
});
