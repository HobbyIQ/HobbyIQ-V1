/**
 * Tier 1 — popular-baseline category (cases 12-14).
 *
 * These are liquid, well-known cards (Skenes RC, Elly RC, Wander Franco
 * 1st auto). They MUST return live comps with compsUsed >= 5 and
 * fairMarketValueLive > 0; any other source is a fatal regression.
 *
 * Issue #8 (Skenes / Elly under-anchored) gates a SOFT assertion on
 * absolute FMV magnitude — when #8 lands we expect FMV >= $50, today
 * the engine reports $12 for Skenes / $7 for Elly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginCase,
  casesIn,
  CASE_BUDGET_MS,
  expectLiveData,
  expectWellFormed,
  hitPriceById,
  hitSearch,
  loadBaseline,
  printFinalSummary,
  recordResult,
  snapshotDiff,
  TIER1_ENABLED,
} from "./_helpers.js";

const CASES = casesIn("popular-baseline");
const describeTier = TIER1_ENABLED ? describe : describe.skip;

describeTier("Tier 1 · popular-baseline (cases 12-14)", () => {
  afterAll(() => printFinalSummary());

  for (const c of CASES) {
    describe(c.id, () => {
      const ctx: {
        search?: Record<string, unknown>;
        priceById?: Record<string, unknown>;
        startMs: number;
        notes: string[];
      } = { startMs: 0, notes: [] };

      beforeAll(
        async () => {
          ctx.startMs = beginCase(c).startMs;
          ctx.search = await hitSearch(c.query);
          const baseline = loadBaseline(c);
          if (baseline.cardHedgeCardId) {
            try {
              ctx.priceById = await hitPriceById(
                baseline.cardHedgeCardId,
                c.query,
                c.grade
              );
            } catch (e) {
              ctx.notes.push(`price-by-id failed: ${(e as Error).message}`);
            }
          }
        },
        CASE_BUDGET_MS
      );

      it("search is well-formed", () => {
        expectWellFormed(ctx.search!, ctx.startMs);
      });


      const blockMinCompsReason = c.blockedBy?.includes(55)
        ? `blocked by issue #55 (Card Hedge comp supply thinned)`
        : null;
      const itMinComps = blockMinCompsReason ? it.skip : it;
      itMinComps(
        `search returns live comps with FMV > 0 (FATAL: popular baseline MUST be live)${
          blockMinCompsReason ? ` (SOFT: ${blockMinCompsReason})` : ""
        }`,
        () => {
          expectLiveData(ctx.search!, { minComps: 5, assertFmv: true, minFmv: 0 });
        }
      );


      const itMinCompsPriceById = blockMinCompsReason ? it.skip : it;
      itMinCompsPriceById(
        `price-by-id is well-formed when available${
          blockMinCompsReason ? ` (SOFT: ${blockMinCompsReason})` : ""
        }`,
        () => {
          if (!ctx.priceById) return;
          expectWellFormed(ctx.priceById, ctx.startMs);
          expectLiveData(ctx.priceById, { minComps: 5, assertFmv: true, minFmv: 0 });
        }
      );

      // SOFT: Issue #8 — Skenes / Elly under-anchored at ~$10–12.
      // When #8 ships, FMV should be ≥ $50; until then we skip.
      const isUnderanchored =
        c.id.startsWith("case-12") || c.id.startsWith("case-13");
      const blockReason = c.blockedBy?.length
        ? `blocked by ${c.blockedBy.map((n) => `issue #${n}`).join(", ")}`
        : null;
      const itAnchor = isUnderanchored && blockReason ? it.skip : it;
      itAnchor(
        `FMV reflects market reality${blockReason ? ` (SOFT: ${blockReason})` : ""}`,
        () => {
          const fmv = ctx.search!.fairMarketValueLive as number | null;
          expect(typeof fmv).toBe("number");
          expect(fmv as number).toBeGreaterThanOrEqual(50);
        }
      );

      it("snapshot diff vs baseline (strict — source must remain live)", () => {
        const baseline = loadBaseline(c).search;
        const diff = snapshotDiff(baseline, ctx.search!, {
          isLiveDataCase: true,
          isPopularBaseline: true,
        });
        recordResult(c, {
          startMs: ctx.startMs,
          passed: true,
          softAsserted: Boolean(c.blockedBy?.length),
          diff,
          notes: ctx.notes,
        });
        if (diff.warnings.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(`  [SNAPSHOT WARN] ${c.id}: ${diff.warnings.join("; ")}`);
        }
        if (diff.fatal.length > 0) {
          throw new Error(`snapshot fatal: ${diff.fatal.join("; ")}`);
        }
      });
    });
  }
});
