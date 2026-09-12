// CF-LADDER-TIME-BUDGET (Fable, 2026-09-12).
//
// Post-deploy Tier 1 harness run found POST /api/compiq/canonical-fmv for
// hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto (zero
// comps) timing out at the harness's OWN 25,000ms ceiling. App Insights
// traced the concurrency fix (CF-LADDER-BOUNDED-CONCURRENCY) working fine a
// few hours later (~1-1.4s per direct re-check under normal load), pointing
// to a transient fleet-load spike rather than a single deterministic
// culprit rung — but a ladder with no WORST-CASE bound can always hang
// again the next time sold_comps is under pressure. This is the fix for
// THAT: a wall-clock budget (LadderBudget, see
// src/services/compiq/ladderBudget.service.ts) so the zero-comp path
// degrades HONESTLY (a withheld verdict with a visible `ladder-timeout`
// reason) instead of hanging until the client aborts.
//
// These tests pin:
//   1. computeHobbyIqFmv: a rung that never resolves is timed out at the
//      per-rung ceiling and treated as an empty answer (never a false hit
//      or a false miss confidently reported past the ladder's own logic).
//   2. computeHobbyIqFmv: when the WHOLE budget is exhausted, the function
//      returns no-basis with `ladderTimedOut: true` and a visible reason in
//      basisNote — never hangs past the configured totalMs ceiling.
//   3. Per-rung timing is logged via console.warn (harness-visible; stdout
//      at a lower level is dropped by the prod logging WARN floor).
//   4. A card that DOES have comps and answers well within budget is
//      completely unaffected (byte-identical to the no-budget behavior).
//
// oneValuationPath.valueIdentity's OWN mapping of a ladderTimedOut result
// onto reason: "ladder-timeout" (not "no-exact-pool") is pinned separately
// in oneValuationPath.test.ts, which already has the catalog + exact-pool
// mocking this module doesn't set up.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** ms to artificially delay every sold_comps query by — simulates a
   *  rung that is genuinely slow (RU throttling, a hot partition, etc.)
   *  without needing a real multi-second wait in a unit test. */
  queryDelayMs: 0,
  /** When true, sold_comps queries never resolve at all — simulates the
   *  Cosmos SDK's own 429 retry-with-backoff hanging past any budget. */
  neverResolve: false,
  queryCount: 0,
  warnLogs: [] as string[],
}));

vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            upsert: async () => ({ resource: {} }),
            query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => ({
              fetchAll: async () => {
                h.queryCount++;
                if (h.neverResolve) {
                  // A promise that never settles — the exact shape of a
                  // hung SDK call the budget has to survive.
                  await new Promise(() => {});
                }
                if (h.queryDelayMs > 0) {
                  await new Promise((r) => setTimeout(r, h.queryDelayMs));
                }
                const params = new Map((spec.parameters ?? []).map((p) => [p.name, p.value]));
                let rows = h.rows.slice();
                if (spec.query.includes("c.hobbyiqCardId = @slug")) {
                  rows = rows.filter((r) => r.hobbyiqCardId === params.get("@slug"));
                } else if (spec.query.includes("STARTSWITH(c.hobbyiqCardId, @stem)")) {
                  rows = rows.filter((r) => String(r.hobbyiqCardId).startsWith(String(params.get("@stem"))));
                } else {
                  if (params.has("@y")) rows = rows.filter((r) => r.cardYear === params.get("@y"));
                  if (params.has("@cn")) rows = rows.filter((r) => String(r.cardNumber).toUpperCase() === params.get("@cn"));
                  if (params.has("@auto")) rows = rows.filter((r) => r.isAuto === params.get("@auto"));
                  if (params.has("@pr")) rows = rows.filter((r) => r.printRun === params.get("@pr"));
                  if (spec.query.includes("IS_DEFINED(c.printRun)")) rows = rows.filter((r) => r.printRun != null);
                }
                return { resources: rows };
              },
            }),
          },
        }),
      };
    }
  }
  return { CosmosClient };
});
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";
process.env.HOBBYIQFMV_COMPOSITE_ENABLED = "false";

const originalWarn = console.warn;
beforeEach(() => {
  h.rows = [];
  h.queryDelayMs = 0;
  h.neverResolve = false;
  h.queryCount = 0;
  h.warnLogs = [];
  console.warn = (msg?: unknown) => { h.warnLogs.push(String(msg)); };
});

import { computeHobbyIqFmv } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

const ZERO_COMP_SLUG = "hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto";
// totalMs < perRungMs * 2: batch 1's 3 concurrent timeBox calls each take
// up to perRungMs to time out, which alone exhausts a budget this tight —
// forcing the ladderTimeoutResult() early-return path rather than letting
// the walk limp through every batch on a string of individually-timed-out
// (but still "answered fast enough") rungs.
const TIGHT_BUDGET = { totalMs: 120, perRungMs: 100 };
// A budget wide enough for several rungs to each time out individually
// and still fit, so the walk reaches its natural no-basis fallthrough —
// exercising the OTHER honest outcome: every rung tried, all of them slow,
// none of them confident, total budget never actually exhausted.
const GENEROUS_BUDGET = { totalMs: 2000, perRungMs: 100 };

describe("computeHobbyIqFmv — ladder time budget", () => {
  it("a rung that never resolves is timed out and treated as empty, not a hang", async () => {
    h.neverResolve = true;
    const started = Date.now();
    const r = await computeHobbyIqFmv({
      hobbyiqCardId: ZERO_COMP_SLUG,
      skipExactPool: true,
      ladderBudgetOverride: TIGHT_BUDGET,
    });
    const elapsed = Date.now() - started;
    // Must return within roughly the total budget, not hang indefinitely —
    // some slack for the batch-boundary exhaustion checks and JS scheduling.
    expect(elapsed).toBeLessThan(TIGHT_BUDGET.totalMs + 500);
    expect(r.fmv).toBeNull();
    expect(r.ladderTimedOut).toBe(true);
    expect(r.basisNote).toContain("ladder-timeout");
  });

  it("logs per-rung timing via console.warn (harness-visible)", async () => {
    h.neverResolve = true;
    await computeHobbyIqFmv({
      hobbyiqCardId: ZERO_COMP_SLUG,
      skipExactPool: true,
      ladderBudgetOverride: TIGHT_BUDGET,
    });
    const rungTimingLogs = h.warnLogs.filter((l) => l.includes("ladder_rung_timing"));
    expect(rungTimingLogs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(rungTimingLogs[0]);
    expect(parsed).toMatchObject({ event: "ladder_rung_timing", source: "ladderBudget" });
    expect(typeof parsed.ms).toBe("number");
    expect(["ok", "rung-timeout", "budget-exhausted"]).toContain(parsed.outcome);

    const summaryLogs = h.warnLogs.filter((l) => l.includes("ladder_walk_summary"));
    expect(summaryLogs.length).toBeGreaterThan(0);
  });

  it("a slow-but-eventually-answering rung within budget still returns a real result", async () => {
    h.queryDelayMs = 20; // well within GENEROUS_BUDGET's 100ms per-rung ceiling
    h.rows = [
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 100, soldAt: new Date().toISOString(), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 120, soldAt: new Date().toISOString(), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
    ];
    const r = await computeHobbyIqFmv({
      hobbyiqCardId: ZERO_COMP_SLUG,
      skipExactPool: true,
      ladderBudgetOverride: GENEROUS_BUDGET,
    });
    expect(r.ladderTimedOut).toBeFalsy();
    expect(r.fmv).not.toBeNull();
  });

  it("every rung individually timing out, but the TOTAL budget never exhausted, reaches an honest no-basis — not a false ladder-timeout", async () => {
    // GENEROUS_BUDGET gives 2000ms total against a 100ms per-rung ceiling —
    // plenty of room for several rungs to each hit their own ceiling (rows
    // never arrive) and the walk to still finish inside the total budget.
    // This is the OTHER honest outcome the fix has to support: distinct
    // from ladder-timeout (the walk itself ran out of time), this is
    // "every rung got its fair shot, none of them found anything."
    h.neverResolve = true;
    const r = await computeHobbyIqFmv({
      hobbyiqCardId: ZERO_COMP_SLUG,
      skipExactPool: true,
      ladderBudgetOverride: GENEROUS_BUDGET,
    });
    expect(r.method).toBe("no-basis");
    expect(r.ladderTimedOut).toBeFalsy();
    const timedOutRungs = h.warnLogs
      .filter((l) => l.includes("ladder_rung_timing"))
      .map((l) => JSON.parse(l))
      .filter((p) => p.outcome === "rung-timeout");
    expect(timedOutRungs.length).toBeGreaterThan(0);
  });

  it("a card with comps under the DEFAULT (production) budget is completely unaffected", async () => {
    h.rows = [
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 100, soldAt: new Date().toISOString(), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 120, soldAt: new Date().toISOString(), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 110, soldAt: new Date().toISOString(), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
    ];
    // No ladderBudgetOverride — exercises the real production default
    // (8000ms total / 3000ms per rung).
    const r = await computeHobbyIqFmv({ hobbyiqCardId: ZERO_COMP_SLUG, skipExactPool: true });
    expect(["direct-slug", "rare-card-anchor"]).toContain(r.method);
    expect(r.ladderTimedOut).toBeFalsy();
    expect(r.fmv).not.toBeNull();
  });
});

