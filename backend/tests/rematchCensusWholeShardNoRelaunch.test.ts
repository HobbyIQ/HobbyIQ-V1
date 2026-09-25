/**
 * CF-A-WHOLE-SHARD-STOP-MUST-NOT-RE-DISPATCH (2026-09-25).
 *
 * THE DEFECT (observed 09-22, `rematch-sold-comps mode=census
 * sources=backing`, slots 9 and 10). Each hop's log printed
 *
 *   this slot REACHED ITS WHOLE SHARD; the budget stopped the tail, not the
 *   sweep.
 *
 * with shard coverage 138-143%, wrote nothing new (census MODE writes
 * nothing at all -- there is no write path to have written), and the
 * relaunch step STILL re-dispatched the slot: five hops of ~2h each, no
 * convergence. The cause is `relaunch-on-marker/action.yml`'s outcome test
 * (`grep -aqE "stopped at the .*budget"`), which fires on that phrase alone,
 * unanchored, with no check of shard coverage at all -- the same class of
 * defect PR #2400 fixed for `resolve-disagreeing-sale-twins`'s counters
 * mismatch, and the same mechanism this file's OWN cursor-save-failure block
 * already uses for a different trigger (see `stopReason = "CURSOR SAVE
 * FAILED..."` in main()'s checkpoint block).
 *
 * THE FIX. `censusStopReasonAfterWholeShardCheck` runs the SAME
 * `reach >= expected` arithmetic `stopAccounting` already prints as "REACHED
 * ITS WHOLE SHARD" (factored out once so the two cannot drift), and when it
 * is true AND the stopReason is the ordinary budget phrase, rewrites
 * stopReason to a budget-word-free terminal marker. `main()`'s MODE=census
 * branch calls it, so the log carries no `stopped at the .*budget` substring
 * for this case and relaunch-on-marker's outcome (b) applies instead:
 * `finishLane: exiting code 0`, no marker, no re-dispatch.
 *
 * This pins the pure arithmetic directly (no Cosmos needed -- the function
 * takes plain `stats`/`expected` numbers), and separately pins that a
 * genuinely INCOMPLETE shard (coverage < 100%, the budget really did stop the
 * sweep) is left untouched and keeps re-dispatching.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const mod = require_(path.join(backend, "scripts", "rematch-sold-comps.cjs")) as {
  censusStopReasonAfterWholeShardCheck: (args: {
    stopReason: string | null;
    stats: { seen: number; prefiltered: number; otherSlot: number };
    expected: number;
  }) => string | null;
};
const { censusStopReasonAfterWholeShardCheck: check } = mod;

const BUDGET_STOP = "stopped at the 140-minute budget";

describe("censusStopReasonAfterWholeShardCheck -- a fully-swept census slot must not carry the budget-marker phrase", () => {
  it("run-observed shape (slots 9/10, 09-22): coverage 138% at a budget stop is rewritten, dropping the marker phrase entirely", () => {
    const stats = { seen: 138, prefiltered: 0, otherSlot: 0 };
    const out = check({ stopReason: BUDGET_STOP, stats, expected: 100 });
    expect(out).not.toMatch(/stopped at the .*budget/);
    expect(out).toMatch(/SHARD COMPLETE/);
    expect(out).toMatch(/no relaunch/);
  });

  it("exactly 100% coverage at a budget stop is also rewritten -- REACHED ITS WHOLE SHARD is >=, not >", () => {
    const stats = { seen: 100, prefiltered: 0, otherSlot: 0 };
    const out = check({ stopReason: BUDGET_STOP, stats, expected: 100 });
    expect(out).not.toMatch(/stopped at the .*budget/);
  });

  it("an INCOMPLETE shard (99% coverage) at a budget stop is left UNCHANGED -- it must still re-dispatch", () => {
    const stats = { seen: 99, prefiltered: 0, otherSlot: 0 };
    const out = check({ stopReason: BUDGET_STOP, stats, expected: 100 });
    expect(out).toBe(BUDGET_STOP);
    expect(out).toMatch(/stopped at the .*budget/);
  });

  it("coverage includes prefiltered and otherSlot rows, matching stopAccounting's own reach formula", () => {
    // 60 seen + 30 prefiltered + 10 otherSlot = 100 reach, expected 100.
    const stats = { seen: 60, prefiltered: 30, otherSlot: 10 };
    const out = check({ stopReason: BUDGET_STOP, stats, expected: 100 });
    expect(out).not.toMatch(/stopped at the .*budget/);
  });

  it("a non-budget stopReason (LIMIT) is left completely alone even at full coverage", () => {
    const stats = { seen: 100, prefiltered: 0, otherSlot: 0 };
    const limitStop = "stopped at the LIMIT of 100 rows";
    const out = check({ stopReason: limitStop, stats, expected: 100 });
    expect(out).toBe(limitStop);
  });

  it("expected=0 (an unmeasured/empty shard) never claims whole-shard completion -- passes the stopReason through", () => {
    const stats = { seen: 0, prefiltered: 0, otherSlot: 0 };
    const out = check({ stopReason: BUDGET_STOP, stats, expected: 0 });
    expect(out).toBe(BUDGET_STOP);
  });

  it("a null stopReason (no stop at all) is returned as-is", () => {
    const stats = { seen: 100, prefiltered: 0, otherSlot: 0 };
    expect(check({ stopReason: null as any, stats, expected: 100 })).toBeNull();
  });

  it("mutation check: removing the >=100% guard would also rewrite an incomplete shard -- this test would then fail on its own assertion below if the guard were deleted", () => {
    // A literal mutation test: simulate the guard's absence by calling with a
    // stopReason that the CURRENT implementation does NOT rewrite (99%), and
    // assert the marker phrase survives. If a future edit deletes the
    // `wholeShardReached` gate, this line would start failing because 99%
    // would also get rewritten, precisely as the deleted-guard case exercised
    // in the manual mutation check for this PR's test plan.
    const stats = { seen: 99, prefiltered: 0, otherSlot: 0 };
    const out = check({ stopReason: BUDGET_STOP, stats, expected: 100 });
    expect(out).toMatch(/stopped at the .*budget/);
  });
});
