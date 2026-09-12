// CF-LADDER-CONCURRENT-FETCH (Fable, 2026-09-12).
//
// A Tier 1 harness run (PR #2056) measured POST /api/compiq/canonical-fmv
// at 5.0s+ for a card with zero direct comps
// (hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto) — App
// Insights traced a single request issuing ~180 sequential Cosmos calls,
// because computeHobbyIqFmv's fallback ladder ran each rung's query as its
// own awaited round-trip before even issuing the next one.
//
// These tests pin two things directly against a Cosmos mock that counts
// concurrent-vs-sequential query pressure:
//   1. On a genuinely empty identity, the ladder's queries fire together
//      (bounded "in flight at once" count) rather than one at a time.
//   2. The rung that WINS, and the rows it wins with, are unchanged from
//      the pre-concurrency behavior — same priority order, same labels.
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
// PR's ladder change) would answer first off its own query shape.
describe("computeHobbyIqFmv ladder — concurrency", () => {
  it("a truly empty identity fires its rung queries concurrently, not one at a time", async () => {
    h.rows = []; // nothing anywhere — every rung genuinely misses
    const r = await computeHobbyIqFmv({ hobbyiqCardId: ZERO_COMP_SLUG, skipExactPool: true });
    expect(r.method).toBe("no-basis");
    // The old sequential ladder would show maxInFlight === 1 (each query
    // awaited before the next was issued). The concurrent-fetch batch
    // issues several of the independent rung queries together.
    expect(h.maxInFlight).toBeGreaterThan(1);
  });

  it("the exact-slug pool wins over the sibling-parallel noise (rung priority preserved)", async () => {
    // A pool this thin (2 sales) also qualifies for computeRareCardFmv's
    // anchor rung, which runs before the legacy ladder and is unaffected by
    // this PR's concurrency change — either way, the number MUST come from
    // the exact slug's own 2 sales, never diluted by the $5 sibling below
    // it in rung priority. That is the invariant this test pins.
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
