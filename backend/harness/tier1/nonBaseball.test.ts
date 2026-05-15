/**
 * Tier 1 — non-baseball category (cases 17-18).
 *
 * Luka Doncic (NBA) and Justin Herbert (NFL). CardHedge currently
 * filters to baseball; these cases are expected to return well-formed
 * responses but NOT live comps. We assert "well-formed + no crash";
 * we explicitly DO NOT assert compsUsed > 0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginCase,
  casesIn,
  CASE_BUDGET_MS,
  expectWellFormed,
  hitSearch,
  loadBaseline,
  printFinalSummary,
  recordResult,
  snapshotDiff,
  TIER1_ENABLED,
} from "./_helpers.js";

const CASES = casesIn("non-baseball");
const describeTier = TIER1_ENABLED ? describe : describe.skip;

describeTier("Tier 1 · non-baseball (cases 17-18)", () => {
  afterAll(() => printFinalSummary());

  for (const c of CASES) {
    describe(c.id, () => {
      const ctx: {
        search?: Record<string, unknown>;
        startMs: number;
        notes: string[];
      } = { startMs: 0, notes: [] };

      beforeAll(
        async () => {
          ctx.startMs = beginCase(c).startMs;
          ctx.search = await hitSearch(c.query);
        },
        CASE_BUDGET_MS
      );

      it("response is well-formed even without comps", () => {
        expectWellFormed(ctx.search!, ctx.startMs);
      });

      it("does not crash or produce an error field", () => {
        expect(ctx.search!.success).toBe(true);
        expect(ctx.search!.error).toBeUndefined();
      });

      // NOTE: We deliberately do NOT assert compsUsed > 0 — CardHedge
      // baseball-only filter is the expected current behavior. When
      // multi-sport CH support lands, lift this into a hard assertion.

      it("snapshot diff vs baseline (shape-only — drift tolerated)", () => {
        const baseline = loadBaseline(c).search;
        const diff = snapshotDiff(baseline, ctx.search!, {
          isLiveDataCase: false,
          isPopularBaseline: false,
        });
        recordResult(c, {
          startMs: ctx.startMs,
          passed: true,
          softAsserted: false,
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
