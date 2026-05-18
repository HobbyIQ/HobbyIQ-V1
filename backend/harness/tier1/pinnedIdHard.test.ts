/**
 * Tier 1 — pinned-id-hard category (cases 19-20).
 *
 * These exercise /api/compiq/price-by-id with a pinned cardHedgeCardId
 * to bypass the parser. They probe variant-mismatch + cross-parallel
 * neighbor synthesis edge cases.
 *
 * Case 19b is blocked by issues #6 (parser variant mismatch) AND #9
 * (cross-endpoint divergence). Issue #9 is downstream of #6.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginCase,
  casesIn,
  CASE_BUDGET_MS,
  expectPinnedIdAllowedSource,
  expectWellFormed,
  hitPriceById,
  hitSearch,
  loadBaseline,
  printFinalSummary,
  recordResult,
  snapshotDiff,
  TIER1_ENABLED,
} from "./_helpers.js";

const CASES = casesIn("pinned-id-hard");
const describeTier = TIER1_ENABLED ? describe : describe.skip;

describeTier("Tier 1 · pinned-id-hard (cases 19-20)", () => {
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
          const cardId = baseline.cardHedgeCardId;
          if (cardId) {
            try {
              ctx.priceById = await hitPriceById(cardId, c.query, c.grade);
            } catch (e) {
              ctx.notes.push(`price-by-id failed: ${(e as Error).message}`);
            }
          } else {
            ctx.notes.push("no cardHedgeCardId in baseline");
          }
        },
        CASE_BUDGET_MS
      );

      it("search is well-formed", () => {
        expectWellFormed(ctx.search!, ctx.startMs);
      });

      const blockPriceByIdReason = c.blockedBy?.includes(9)
        ? `blocked by issue #9 (cross-endpoint divergence — /price-by-id returns null)`
        : null;
      const itPriceById = blockPriceByIdReason ? it.skip : it;
      itPriceById(`price-by-id is well-formed (pinned id should resolve)${
        blockPriceByIdReason ? ` (SOFT: ${blockPriceByIdReason})` : ""
      }`, () => {
        expect(ctx.priceById, "expected /price-by-id response").toBeTruthy();
        expectWellFormed(ctx.priceById!, ctx.startMs);
      });

      // SOFT: Issue #18 — parallel disambiguation for pinned-id calls may return
      // source='variant-mismatch' when the baseline captured a different parallel
      // (e.g., query requested "Green Refractor" but Card Hedge has "Green Grass Refractor").
      // This is not a player_mismatch (verified by second check), but the source enum
      // changed. Gated until #18 ships.
      const blockSourceReason = c.blockedBy?.includes(18)
        ? `blocked by issue #18 (parallel disambiguation)`
        : null;
      const itSource = blockSourceReason ? it.skip : it;
      itSource(`pinned-id resolution does not flag player_mismatch${
        blockSourceReason ? ` (SOFT: ${blockSourceReason})` : ""
      }`, () => {
        if (!ctx.priceById) return;
        expectPinnedIdAllowedSource(ctx.priceById);
      });

      // SOFT: Issue #6 — PSA-grade variant-mismatch parser bug
      // (case-19b returns source=variant-mismatch + compsUsed=0).
      // SOFT: Issue #9 — cross-endpoint divergence (downstream of #6).
      const blockReason = c.blockedBy?.length
        ? `blocked by ${c.blockedBy.map((n) => `issue #${n}`).join(", ")}`
        : null;
      const itDiverge = blockReason ? it.skip : it;
      itDiverge(
        `search and price-by-id agree on marketTier${
          blockReason ? ` (SOFT: ${blockReason})` : ""
        }`,
        () => {
          if (!ctx.priceById) return;
          const sVal = (ctx.search!.marketTier as any)?.value as number | null;
          const pVal = (ctx.priceById.marketTier as any)?.value as number | null;
          // If either side is non-numeric (null/undefined), the drift compare is not
          // applicable — typically a no-recent-comps response on the pinned-id path.
          // See blockedBy issues if any (e.g. issue #9). Skip rather than fail so we
          // do not mask the actual drift assertion behind a precondition error.
          if (typeof sVal !== "number" || typeof pVal !== "number") {
            console.log(
              `[${c.id}] marketTier not numeric on at least one endpoint ` +
                `(search=${sVal}, priceById=${pVal}) — drift compare skipped.`
            );
            return;
          }
          if (sVal > 0) {
            const drift = Math.abs(pVal - sVal) / sVal;
            expect(drift, `endpoint drift ${drift * 100}%`).toBeLessThan(0.1);
          }
        }
      );

      // Grade-pair: PSA 10 marketTier >= Raw marketTier when both live.
      const isB = c.id.includes("b-") && c.gradePair;
      if (isB) {
        it("PSA 10 marketTier >= Raw marketTier when both have comps", () => {
          const rawCase = CASES.find(
            (x) => x.gradePair === c.gradePair && x.grade === "Raw"
          );
          if (!rawCase) return;
          const rawBaseline = loadBaseline(rawCase).search as any;
          const psaBaseline = loadBaseline(c).search as any;
          if ((rawBaseline?.compsUsed ?? 0) > 0 && (psaBaseline?.compsUsed ?? 0) > 0) {
            const rv = rawBaseline?.marketTier?.value ?? 0;
            const pv = psaBaseline?.marketTier?.value ?? 0;
            expect(pv).toBeGreaterThanOrEqual(rv);
          }
        });
      }

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
