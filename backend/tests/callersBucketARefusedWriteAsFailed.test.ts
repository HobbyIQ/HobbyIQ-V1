/**
 * CF-A-THROTTLED-WRITE-IS-NOT-A-WRITE (#2015 follow-up, 2026-09-09) — the
 * call-site audit.
 *
 * Once `recordSoldComp`'s catch returns `{ written: false, reason: "error" }`,
 * every caller that COUNTS `written` has a new value flowing through it. The
 * rule the audit applied to all 27 call sites:
 *
 *   a `reason: "error"` result is FAILED. Never skipped, never deduped, never
 *   silently counted as a write.
 *
 * The distinction is not cosmetic. `failed` means retryable -- re-run the
 * lane, the sale is still out there. `skipped` and `deduped` both mean DONE,
 * and a lane that files a throttled write under either will never come back
 * for it. That is how a transient 429 becomes a permanently missing sale.
 *
 * MOST callers were already correct and are pinned here so they stay that way:
 * `chHistoricalBackfill` (`else rowsFailed++`), `promotionJob` (`result.errors`
 * with the staging row left alone), `ebayOrderPoll` (`writeFailed`, which pins
 * the cursor), `emit-staging-to-pool` and `backfill-ebay-purchase-comps`
 * (`failed`). One was NOT, and this pins the fix:
 *
 *   - `historicalBackfill` incremented `written += 1` unconditionally after
 *     the await, so `chSalesWritten` was the count of sales ATTEMPTED. A
 *     backfill Cosmos throttled end to end reported a full success.
 * `bulk-import-ch-daily-to-sold-comps` had the SAME defect and #2015 already
 * fixed it caller-side, by reading the emit-failure counter's delta per batch.
 * It is left alone deliberately and pinned here for the opposite reason: the
 * counter delta and the new `written: false` report the SAME rows, so a lane
 * that read both would count every throttled sale twice.
 *
 * Text-level, and it says so: these are counter-increment sites, and the
 * defect in both was an increment that ran unconditionally.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]) => readFileSync(path.join(here, "..", ...p), "utf8");

describe("historicalBackfill counts a refused write as failed, not written", () => {
  const s = src("src", "services", "portfolioiq", "historicalBackfill.service.ts");

  it("captures the result rather than discarding it", () => {
    // `await recordSoldComp({...})` with no binding cannot branch on the
    // verdict — which is exactly how the bug survived.
    expect(s).not.toMatch(/\n      await recordSoldComp\(\{/);
    expect(s).toMatch(/const res = await recordSoldComp\(\{/);
  });

  it("increments written only when the write landed, and failed otherwise", () => {
    const guarded = s.match(/if \(res\.written\) written \+= 1; else failed \+= 1;/g) ?? [];
    // Both source paths: CH and CS.
    expect(guarded).toHaveLength(2);
    // The unconditional form must be gone.
    expect(s).not.toMatch(/\}\);\n      written \+= 1;/);
  });

  it("surfaces the failure count on the result so a caller can see an incomplete run", () => {
    expect(s).toContain("chSalesFailed: number;");
    expect(s).toContain("csSalesFailed: number;");
    expect(s).toContain("totalCHSalesFailed: number;");
    expect(s).toContain("totalCSSalesFailed: number;");
    // And it reaches the completion log, or a throttled run reads identical
    // to a clean one.
    expect(s).toMatch(/log\("historical_backfill\.complete"[\s\S]{0,600}?totalCHSalesFailed/);
  });

  it("a thrown write is also failed, not swallowed into silence", () => {
    expect(s).toMatch(/\} catch \{[\s\S]{0,200}?failed \+= 1;/);
  });
});

describe("bulk-import-ch-daily counts a throttled write ONCE, via the ledger delta", () => {
  const s = src("scripts", "bulk-import-ch-daily-to-sold-comps.cjs");

  it("counts swallowed writes from the emit-failure delta, which is exact", () => {
    // #2015 landed this lane's fix caller-side, reading the monotonic counter
    // around each batch. That delta is EXACTLY the throttled-write count, so
    // the lane needs no change now that the return value also reports it.
    expect(s).toContain("const failBefore = getEmitFailureCount();");
    expect(s).toContain("const swallowed = getEmitFailureCount() - failBefore;");
    expect(s).toContain("failedWrites += err + swallowed;");
    expect(s).toContain("landed -= swallowed;");
  });

  it("NO DOUBLE COUNT: it does NOT also branch on the return value", () => {
    // The two signals report the SAME rows -- a swallowed upsert increments
    // the counter AND returns `written: false`. Adding a `res.written` check
    // on top of the delta would count every throttled sale twice and drive
    // `emitted` negative under a real 429 storm. One of the two, never both.
    expect(s).not.toMatch(/res\.written === false/);
    expect(s).not.toMatch(/const res = await recordSoldComp\(w\);/);
  });

  it("says so, so the next reader does not 'improve' it into a double count", () => {
    expect(s).toContain("One of the two, never their sum.");
    // And the comment no longer claims the store-side fix is unmade.
    expect(s).not.toContain("NOT made here");
  });

  it("the reconcile identity still balances: intended = written + failed", () => {
    expect(s).toContain("if (emitted + failedWrites !== intendedWrites) {");
  });
});

describe("the callers that were already right stay right", () => {
  it("chHistoricalBackfill files a non-catalog-unmatched refusal as rowsFailed", () => {
    const s = src("src", "services", "portfolioiq", "chHistoricalBackfill.service.ts");
    expect(s).toMatch(
      /if \(res\.written\) rowsWritten\+\+;\s*\n\s*else if \(res\.reason === "catalog-unmatched"\) rowsUnmatched\+\+;\s*\n\s*else rowsFailed\+\+;/,
    );
  });

  it("promotionJob counts an error and leaves the staging row retryable", () => {
    const s = src("src", "services", "portfolioiq", "promotionJob.service.ts");
    // The `invalid-input / error` branch must NOT write status="promoted".
    expect(s).toMatch(/\/\/ invalid-input \/ error[\s\S]{0,300}?result\.errors \+= 1;\s*\n\s*continue;/);
  });

  it("ebayOrderPoll marks the write failed so the cursor does not advance past a lost sale", () => {
    const s = src("src", "services", "ebay", "ebayOrderPoll.service.ts");
    expect(s).toMatch(/\} else \{[\s\S]{0,400}?out\.writeFailed = true;/);
    expect(s).toContain('event: "ebay_poll_pool_write_failed"');
  });

  it("emit-staging-to-pool files an error as failed and does NOT flip the row to in-pool", () => {
    const s = src("scripts", "emit-staging-to-pool.cjs");
    // invalid-input is its own bucket; everything else non-written is failed.
    expect(s).toContain('if (!res.written) { if (res.reason === "invalid-input") invalid++; else failed++; return; }');
    // The early return above is what leaves the staging row at its old status,
    // so the drainer comes back for it.
  });

  it("backfill-ebay-purchase-comps files an error as failed, not alreadyPresent", () => {
    const s = src("scripts", "backfill-ebay-purchase-comps.cjs");
    expect(s).toMatch(/\} else \{\s*\n\s*s\.failed\+\+;/);
  });
});
