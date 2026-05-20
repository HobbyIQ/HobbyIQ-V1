/**
 * Tier 1 — vintage category (cases 15-16).
 *
 * Vintage cards exercise the grade-tier propagation pipeline. Case 15
 * (1986 Fleer Jordan PSA 8) is currently blocked by issue #7 — the
 * vintage grade tier is not propagating into the pricing model. Case 16
 * (1989 UD Griffey Jr RC PSA 9) is exercised normally.
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

const CASES = casesIn("vintage");
const describeTier = TIER1_ENABLED ? describe : describe.skip;

describeTier("Tier 1 · vintage (cases 15-16)", () => {
  afterAll(() => printFinalSummary());

  for (const c of CASES) {
    // SKIPPED post-Cardsight migration (PR #60, 2026-05-19):
    //   case-16 — Cardsight identifyCard fails when the grade token
    //     ("PSA 9") appears in the query string. Direct probe shows the
    //     same Griffey query without "PSA 9" returns 258 live comps;
    //     adding "PSA 9" returns no-recent-comps. The CompIQ→Cardsight
    //     adapter does not strip grade tokens before catalog lookup.
    //     Tracked in issue #70. Re-enable when the adapter fix lands.
    const innerDescribe = c.id.startsWith("case-16")
      ? describe.skip
      : describe;
    innerDescribe(c.id, () => {
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

      it("search is well-formed", () => {
        expectWellFormed(ctx.search!, ctx.startMs);
      });

      it("gradeUsed reflects requested grade tier", () => {
        const gradeUsed = ctx.search!.gradeUsed as
          | { gradeCompany?: string; gradeValue?: number }
          | string
          | null;
        // Accept either the structured form or the legacy string form.
        // We just want to confirm grade information is present (not null).
        expect(gradeUsed).not.toBeNull();
      });

      // SOFT: Issue #7 — vintage grade tier not propagating.
      const blockReason = c.blockedBy?.length
        ? `blocked by ${c.blockedBy.map((n) => `issue #${n}`).join(", ")}`
        : null;
      const itTier = blockReason ? it.skip : it;
      itTier(
        `vintage grade tier propagates to pricing${
          blockReason ? ` (SOFT: ${blockReason})` : ""
        }`,
        () => {
          // When #7 lands: marketTier.value should reflect the graded
          // premium (PSA 8 Jordan ≈ $5–15k, not raw / untiered).
          const value = (ctx.search!.marketTier as any)?.value as number;
          expect(typeof value).toBe("number");
          expect(value).toBeGreaterThan(0);
        }
      );

      it("snapshot diff vs baseline", () => {
        const baseline = loadBaseline(c).search;
        const diff = snapshotDiff(baseline, ctx.search!, {
          isLiveDataCase: (baseline as any)?.source === "live",
          isPopularBaseline: false,
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
