/**
 * CF-A-RECONCILE-VERDICT-MUST-REACH-THE-EXIT-CODE (run 34360565942, 2026-09-09).
 *
 * WHAT HAPPENED. The wave-2 canary run (rematch-sold-comps, mode=apply-
 * improve, scope=improve, slot 0/32) burned 118.6 of its 120-minute budget
 * classifying the shard, so the apply-improve worker pool hit
 * `budgetLeft() < 90000` on its very first claim. All CONCURRENCY=16 workers
 * raced a SHARED `idx` counter: each claimed a distinct `my`, saw the budget
 * already gone, and independently added `improvable.length - my` -- its own
 * WHOLE remaining tail -- to `stats.notReached`. The tails overlap almost
 * entirely, so the bucket summed to
 *
 *   sum_{my=0..15} (2179 - my) = 34,744
 *
 * against 2,179 intended -- a reconciliation drift the script's own gate
 * correctly detected (`recon !== stats.intended`) and correctly flagged by
 * setting `process.exitCode = 4`, printing "WORK VANISHED" and "UNACCOUNTED
 * 2,179 (100.00% of intended)". But the module's entry point called
 * `finishLane(0, ctx)` with a HARDCODED 0, which calls `process.exit(0)` and
 * throws away whatever `process.exitCode` the reconcile had set. The step
 * exited 0 -- green -- despite writing nothing of an intended 2,179 and
 * printing its own "do not treat this run as complete" banner.
 *
 * TWO INDEPENDENT DEFECTS, TWO INDEPENDENT FIXES:
 *
 *   1. The worker race overcounts "not reached" under concurrency when the
 *      budget is already exhausted at loop entry. Fixed by having each
 *      worker count ONLY the single row `my` it claimed (and keep draining
 *      `idx`, cheaply, so every row is still claimed and counted by exactly
 *      one worker) instead of the whole tail from its own claim point.
 *   2. A correctly-detected reconciliation drift did not reach the process
 *      exit code, because the entry point ignored `process.exitCode`. Fixed
 *      by reading `process.exitCode` into the `finishLane()` call instead of
 *      hardcoding 0, so a lane that catches its own drift now FAILS the step
 *      instead of reporting green over "UNACCOUNTED 2,179".
 *
 * This file pins both: a standalone reproduction of the worker-race
 * arithmetic (proving the buggy shape overcounts and the fixed shape always
 * reconciles, at the exact concurrency and population size of the canary
 * run), and a static read of the shipped script confirming the dangerous
 * patterns are gone and the fixed ones are present.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "rematch-sold-comps.cjs");
const script = fs.readFileSync(scriptPath, "utf8");

/**
 * Reproduces the exact shape of the apply-improve (and revert-eviction)
 * worker pool: `Promise.all(Array.from({ length: CONCURRENCY }, worker))`,
 * every worker looping `while (idx < n) { const my = idx++; ... }` over a
 * SHARED `idx`, under a budget already exhausted for the whole run -- the
 * t=0 budget-stop shape that hit run 34360565942.
 *
 * Each worker's own `async` body runs synchronously up to its first
 * `await`, exactly like the real code, so `stopsOnFirstClaim` mirrors the
 * BUGGY shape's `return` (one claim per worker, then it exits) and
 * `false` mirrors the FIXED shape's `continue` (a worker keeps draining
 * `idx` after a budget-exhausted claim, cheaply, with no Cosmos read --
 * modelled here as an `await` so concurrent workers still interleave).
 */
async function simulateBudgetStop(n: number, concurrency: number, stopsOnFirstClaim: boolean) {
  let idx = 0;
  let notReached = 0;
  const worker = async () => {
    while (idx < n) {
      const my = idx++;
      if (stopsOnFirstClaim) {
        // THE BUG: sums the WHOLE remaining tail from this worker's own
        // claim point, then stops claiming -- exactly `improvable.length -
        // my; return;` in the shipped (pre-fix) script.
        notReached += n - my;
        return;
      }
      // THE FIX: counts only the one row this worker claimed, then keeps
      // draining `idx` so every remaining row is still claimed -- by some
      // worker, exactly once -- instead of being left for nobody.
      notReached += 1;
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(n, 1)) }, worker));
  return notReached;
}

describe("apply-improve worker-pool reconciliation under a t=0 budget stop", () => {
  it("BUGGY shape (whole remaining tail per claim, then stop) reproduces the exact 34,744 overcount seen in run 34360565942", async () => {
    const n = 2179;
    const concurrency = 16;
    const notReached = await simulateBudgetStop(n, concurrency, true);
    // This is the drift the run's own gate caught: 34,744 accounted vs 2,179
    // intended. Pinning the buggy shape here proves the diagnosis, not that
    // the buggy shape should exist -- the fixed shape below is what ships.
    expect(notReached).toBe(34744);
    expect(notReached).not.toBe(n);
  });

  it("FIXED shape (one unit per claim, keep draining) reconciles exactly at the canary run's own population and concurrency", async () => {
    const n = 2179;
    const concurrency = 16;
    const notReached = await simulateBudgetStop(n, concurrency, false);
    expect(notReached).toBe(n);
  });

  it("FIXED shape reconciles exactly across a range of populations and concurrencies, including odd remainders", async () => {
    for (const n of [0, 1, 15, 16, 17, 2179, 5000]) {
      for (const concurrency of [1, 4, 16, 32]) {
        // eslint-disable-next-line no-await-in-loop
        const notReached = await simulateBudgetStop(n, concurrency, false);
        expect(notReached).toBe(n);
      }
    }
  });
});

describe("shipped script: the two defects from run 34360565942 stay fixed", () => {
  it("no longer sums the whole remaining tail per worker claim in the apply-improve loop", () => {
    // The buggy line summed `improvable.length - my` per claiming worker,
    // which is what produced the 34,744-vs-2,179 drift. It must be gone.
    expect(script).not.toContain("stats.notReached += improvable.length - my");
    expect(script).not.toContain("for (let z = my; z < improvable.length; z++) perClass[improvable[z].kind].notReached++;");
  });

  it("no longer sums the whole remaining tail per worker claim in the revert-eviction loop", () => {
    expect(script).not.toContain("stats.notReached += candidates.length - my; return;");
  });

  it("the apply-improve budget stop counts exactly one row per claim and keeps draining idx", () => {
    expect(script).toContain("stats.notReached++;");
    expect(script).toContain("perClass[improvable[my].kind].notReached++;");
  });

  it("the entry point no longer hardcodes exit code 0, throwing away a reconcile-detected drift", () => {
    // The exact defect: `finishLane(0, ctx || {})` unconditionally, which
    // called process.exit(0) even after the reconcile set process.exitCode
    // to 4 (drift) or 6 (scope failure).
    expect(script).not.toContain('finishLane(0, ctx || {})');
    expect(script).toContain("finishLane(process.exitCode || 0, ctx || {})");
  });

  it("the reconcile still sets a nonzero process.exitCode on drift, so the fix has something to carry", () => {
    expect(script).toContain("process.exitCode = 4");
    expect(script).toContain("process.exitCode = 6");
  });
});
