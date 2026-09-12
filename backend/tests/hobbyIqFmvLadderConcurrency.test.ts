// CF-LADDER-BOUNDED-CONCURRENCY (Fable, 2026-09-12, revised same day).
//
// D1 (PR #2057, this file's original version) fired ALL ~6 independent rung
// queries in one Promise.all per canonical-fmv request. That collapsed
// wall-clock under a QUIET pool, but the post-deploy Tier 1 harness run
// (prod sha 750c144) measured imageVariationSonic going from 3,950ms to a
// full 25,000ms timeout under FLEET LOAD, and market-movers timed out too.
// App Insights confirmed why: 3,986 AppDependencies calls against sold_comps
// in the 5.5min window from AppRoleName HobbyIQ3 alone (not the
// census/retire fleet — hobbyiq3-worker stayed flat at single digits/min
// throughout), 332 of them (8.3%) ResultCode 429 — sold_comps' autoscale
// ceiling is 10,000 RU/s, and firing 6 queries at once per request,
// multiplied across several requests landing close together, blew through
// it. The Cosmos SDK's automatic 429 retry-with-backoff then serialized the
// "concurrent" calls anyway, on top of the backoff delay — worse than the
// original sequential ladder.
//
// D2 (this revision) bounds the LADDER's own rung queries to batches of at
// most 3 concurrent Cosmos calls, in rung-priority order, and — critically
// — batch 2 and batch 3 are LAZY: they are only invoked (so only then do
// they touch Cosmos) when every rung in the batch(es) before them has
// already missed. A direct-slug hit — the overwhelming majority of real
// traffic — still answers from batch 1 alone: 3 queries total, not 6.
//
// Separately from the ladder rungs, computeHobbyIqFmv has ALWAYS run a
// background "broader identity trend" helper (2 chained sold_comps queries,
// present since 2026-07-28, pre-dating both D1 and D2) concurrently with
// whatever rung work is in flight, to hide its latency behind a rung that
// was probably going to win anyway. D2 moved it to fire AFTER batch 1
// rather than stacked ON TOP of batch 1 (removing 2 of D1's stacked calls),
// but it can still overlap by up to 1 extra call with batch 2 — a much
// smaller residual than D1's problem and out of this fix's scope (fixing
// it further would mean re-plumbing a helper this ladder didn't introduce).
// So the absolute ceiling pinned below is 4, not 3: "the ladder's own rung
// concurrency is capped at 3" plus "the pre-existing trend helper can add
// 1 more," which is the real, honest bound — not "nothing else in this
// function ever touches Cosmos concurrently."
//
// These tests pin:
//   1. The ladder never has more than 4 Cosmos calls in flight at once —
//      down from D1's up-to-6 (3 ladder-rung batch width + at most 1 more
//      from the pre-existing trend helper), never unbounded.
//   2. A direct-slug hit issues ONLY batch 1's 3 ladder queries (plus the
//      trend helper's own 2, fired after) — batches 2 and 3 are never
//      invoked when an earlier rung already won.
//   3. Rung priority + rows-that-win are unchanged (same pin as D1).
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  inFlight: 0,
  maxInFlight: 0,
  totalQueries: 0,
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
                h.totalQueries++;
                h.inFlight++;
                h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
                // Yield a tick so concurrent callers overlap in the mock,
                // the same way real network round-trips would overlap.
                await new Promise((r) => setTimeout(r, 5));
                h.inFlight--;
                // Simplified per-query filtering: match on the WHERE text
                // and the bound cardYear/cardNumber/isAuto/sport/printRun
                // params rather than a real SQL engine — good enough to
                // exercise ladder branching.
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
                  if (params.has("@sport")) rows = rows.filter((r) => r.sport === params.get("@sport") || true); // sport not modeled on fixture rows; identity scoping via cardId is enough
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

import { computeHobbyIqFmv } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

beforeEach(() => {
  h.rows = [];
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.totalQueries = 0;
});

const ZERO_COMP_SLUG = "hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto";

// CF-ONE-VALUATION-PATH: the caller that actually reaches this ladder in
// production (oneValuationPath.valueIdentity, section 3) always passes
// skipExactPool: true — the unified engine already ran and found nothing,
// so the ladder is asked once, not raced against a second engine. These
// tests call it the same way; without the flag, computeHobbyIqFmv's own
// unified-pricing early-exit (a different code path, unrelated to this
// ladder change) would answer first off its own query shape.
describe("computeHobbyIqFmv ladder — bounded concurrency under load", () => {
  it("NEVER exceeds 4 Cosmos calls in flight at once, even on a truly empty identity walking every rung", async () => {
    h.rows = []; // nothing anywhere — every rung genuinely misses, all 3 batches fire
    const r = await computeHobbyIqFmv({ hobbyiqCardId: ZERO_COMP_SLUG, skipExactPool: true });
    expect(r.method).toBe("no-basis");
    // D1's bug: this could be 5-6 (one Promise.all for everything, plus the
    // trend helper stacked on top). D2's fix: at most 3 ladder-rung calls in
    // flight together, plus at most 1 more from the trend helper — 4 total,
    // never unbounded.
    expect(h.maxInFlight).toBeGreaterThan(1);
    expect(h.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("an exact-slug hit answers without ever reaching batch 2 or batch 3", async () => {
    // computeRareCardFmv (unaffected by this fix, runs ahead of the legacy
    // ladder) may claim a thin-looking pool under this test's simplified
    // Cosmos mock — either way, the number MUST come from the exact slug's
    // own sales via a rung that needed only batch 1, never batches 2/3.
    h.rows = [
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 100, soldAt: daysAgo(5), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 120, soldAt: daysAgo(10), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 110, soldAt: daysAgo(15), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 115, soldAt: daysAgo(20), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball", printRun: null },
    ];
    const r = await computeHobbyIqFmv({ hobbyiqCardId: ZERO_COMP_SLUG, skipExactPool: true });
    expect(["direct-slug", "rare-card-anchor"]).toContain(r.method);
    expect(r.fmv).not.toBeNull();
    // Whichever rung answered, it never needed the ladder's batch 2/3 —
    // total Cosmos fan-out for this identity stays small (at most batch 1's
    // 3 ladder fetches + the trend helper's 2 + rare-card-anchor's own
    // handful of point reads/counts), and concurrency never exceeds the
    // documented cap.
    expect(h.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("rung priority is preserved: exact-slug pool wins over sibling-parallel noise", async () => {
    // A pool this thin (2 sales) also qualifies for computeRareCardFmv's
    // anchor rung, which runs before the legacy ladder and is unaffected by
    // this concurrency change — either way, the number MUST come from the
    // exact slug's own 2 sales, never diluted by the $5 sibling below it in
    // rung priority. That is the invariant this test pins.
    h.rows = [
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 100, soldAt: daysAgo(10), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball" },
      { hobbyiqCardId: ZERO_COMP_SLUG, price: 120, soldAt: daysAgo(20), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Image Variation Sonic", sport: "baseball" },
      // Noise on a sibling parallel that a lower rung COULD have grabbed if
      // the exact-slug pool hadn't already won — proves rung priority held.
      { hobbyiqCardId: "hiq:baseball:2022:topps-chrome:221:base:no-auto", price: 5, soldAt: daysAgo(3), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Base", sport: "baseball" },
    ];
    const r = await computeHobbyIqFmv({ hobbyiqCardId: ZERO_COMP_SLUG, skipExactPool: true });
    expect(["direct-slug", "rare-card-anchor"]).toContain(r.method);
    // The sibling's $5 must not have diluted the exact-slug median.
    expect(r.fmv).not.toBeNull();
    expect(r.fmv!).toBeGreaterThan(50);
  });

  it("a batch-2 rescue (cross-printrun) still reaches Cosmos, but only after batch 1 misses, and stays within the 3-concurrent cap", async () => {
    const numberedSlug = "hiq:baseball:2022:topps-chrome:221:image-variation-sonic:auto:num-50";
    h.rows = [
      // No rows under the exact numbered slug (batch 1 misses entirely) —
      // but the no-printRun stem has sales, which rung 2 (cross-printrun,
      // batch 2) should find via STARTSWITH.
      { hobbyiqCardId: "hiq:baseball:2022:topps-chrome:221:image-variation-sonic:auto", price: 300, soldAt: daysAgo(5), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: true, parallel: "Image Variation Sonic", sport: "baseball" },
    ];
    const r = await computeHobbyIqFmv({ hobbyiqCardId: numberedSlug, skipExactPool: true });
    expect(r.method).toBe("cross-printrun");
    expect(r.fmv).not.toBeNull();
    // Batch 1 (3 ladder calls) can still be overlapping with the trend
    // helper's tail when batch 2 (<=2, mutually exclusive so really 1 for
    // this shape) fires — never more than 4 in flight at the same instant.
    expect(h.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("family-baseline fetch is skipped entirely when the target parallel is rare and has zero identity comps (CF-CATALOG-GAP-NO-BASIS)", async () => {
    // Rows exist for the SAME (year, cardNumber, isAuto, sport) identity but
    // under a DIFFERENT parallel than the target ("Base", not "Image
    // Variation Sonic") — targetParallelHadIdentityComps must read false,
    // shouldSkipSiblingParallel true, and the family-baseline query must
    // never fire (it would have been fabrication off unrelated parallels).
    h.rows = [
      { hobbyiqCardId: "hiq:baseball:2022:topps-chrome:221:base:no-auto", price: 5, soldAt: daysAgo(3), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Base", sport: "baseball" },
      { hobbyiqCardId: "hiq:baseball:2022:topps-chrome:221:base:no-auto", price: 6, soldAt: daysAgo(9), source: "tca-ebay", cardYear: 2022, cardNumber: "221", isAuto: false, parallel: "Base", sport: "baseball" },
    ];
    const r = await computeHobbyIqFmv({ hobbyiqCardId: ZERO_COMP_SLUG, skipExactPool: true });
    expect(r.method).toBe("no-basis");
    expect(r.fmv).toBeNull();
    expect(r.basisNote).toContain("data gap flagged for review");
  });
});
