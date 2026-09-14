/**
 * CF-AN-APPLY-WRITES-AS-IT-CLASSIFIES-AND-RESUMES -- the END-TO-END pin.
 *
 * THE DEFECT (measured on prod, 2026-09-14). MODE=apply-improve deferred EVERY
 * write until its whole shard was classified, and no slot fits in one
 * 120-minute link: run 34872320344 (slot 31) reached 120,232 rows in 118.9m
 * and run 34849159531 (slot 0) 117,917 in 120m -- both reconciling
 * `intended 2,717 = written 0 + skipped 0 + failed 0 + not reached 2,717`
 * with `WRITE LEDGER 0 pool(s) touched`. The write phase sat BELOW the classify
 * loop, so the budget always expired before it began. With no apply cursor
 * either, every relaunch restarted at row 0: the lane could never write a
 * single row, at any throughput.
 *
 * THE FIX, pinned here against the REAL, unexported `main()` driven as actual
 * child processes (the convention rematchCensusCursorE2E.test.ts established,
 * because main() builds its own CosmosClient and cannot be reached by the
 * container-stubbing the other rematch tests use):
 *
 *   1. WRITE AS IT CLASSIFIES. Each page's candidates are relocated at the end
 *      of that page, so a budget stop leaves committed work. Pinned by pass 1
 *      writing a non-zero number of rows while stopping at its budget -- the
 *      exact assertion the two prod runs above would have failed.
 *   2. RECONCILE STILL BALANCES. `intended = written + skipped + failed + not
 *      reached`, now with writes landing mid-walk and counts carried across
 *      links by the cursor.
 *   3. RESUME. A relaunch reads the apply's OWN cursor (keyed by mode, so it
 *      can never be confused with the census's) and continues from the saved
 *      continuation token instead of row 0 -- and the shard CONVERGES: every
 *      row ends at its derived address after enough links, which is the whole
 *      point and the thing the old code could not do at all.
 *
 * THE CURSOR NEVER STEPS OVER UNWRITTEN WORK. The token advances only past a
 * page whose queue actually drained; a page whose writes were cut short by the
 * budget is re-read by the relaunch. Without that guard the fixture converged
 * to only 2 of its 6 rows -- the token skipping the rows pass 1 classified but
 * never wrote -- which is exactly the silent data-loss shape the cursor exists
 * to prevent. The `already-at-target` re-check makes the re-read free of
 * double-writes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const backend = join(__dirname, "..");
const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
const PRELOAD = join(backend, "tests", "fixtures", "apply-cursor-e2e", "fake-cosmos-preload.cjs");
const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));

// Like the census e2e: this file exercises the REAL main() against a REAL
// compiled dist/, so it skips rather than false-passing on an unbuilt tree.
const itIfBuilt = DIST_EXISTS ? it : it.skip;

const TEST_TIMEOUT_MS = 90_000;

/** Slot 15 is the shard table's home for cardYear 2021 with no sport or hash
 *  split (`y=2021`), so every fixture row lands in one slot and `rowInSlot`
 *  admits it -- no dependence on the hashing of any particular id. */
const SLOT = "15";

function runPass(opts: {
  controlStateFile: string;
  poolStateFile: string;
  censusOut: string;
  runMinutes: string;
  slowPageMs: number;
  apply?: boolean;
}) {
  const env = {
    ...process.env,
    MODE: "apply-improve",
    SCOPE: "improve",
    SLOT,
    SLOTS: "32",
    APPLY: opts.apply === false ? "false" : "true",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
    RUN_MINUTES: opts.runMinutes,
    CENSUS_OUT: opts.censusOut,
    CONTROL_STATE_FILE: opts.controlStateFile,
    POOL_STATE_FILE: opts.poolStateFile,
    APPLY_ROW_COUNT: "6",
    APPLY_PAGE_ROWS: "2",
    SLOW_PAGE_MS: String(opts.slowPageMs),
    // Checkpoint on EVERY page, so the budget stop in these short passes still
    // leaves a persisted token (the 5-minute default would never fire here).
    CENSUS_PAGE_CHECKPOINT_PAGES: "1",
  };
  return spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
    cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
}

/** Every pool row's current slug, counted -- the only question that matters. */
function poolBySlug(poolStateFile: string): Record<string, number> {
  const pool = JSON.parse(readFileSync(poolStateFile, "utf8"));
  const out: Record<string, number> = {};
  for (const row of Object.values<any>(pool)) out[row.cardId] = (out[row.cardId] ?? 0) + 1;
  return out;
}

const BASE = "hiq:baseball:2021:topps-chrome:27:base:no-auto";
const DERIVED = "hiq:baseball:2021:topps-chrome:27:refractor:no-auto";

describe("rematch-sold-comps.cjs MODE=apply-improve writes as it classifies and resumes across a relaunch", () => {
  let dir: string;
  let controlStateFile: string;
  let poolStateFile: string;
  let censusOut: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apply-cursor-e2e-"));
    controlStateFile = join(dir, "control-state.json");
    poolStateFile = join(dir, "pool-state.json");
    censusOut = join(dir, "census");
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  itIfBuilt("a pass that hits its budget mid-shard STILL WRITES, and checkpoints where it got to", () => {
    // RUN_MINUTES=1.6 -> a 96,000ms budget; each 2-row page sleeps 4,000ms, and
    // the loop stops when under 90,000ms remain -- so the budget trips after
    // the first page or two, well before the 6-row shard is classified. That
    // is precisely the state in which the OLD code wrote nothing at all.
    const res = runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "1.6", slowPageMs: 4000 });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(out).toMatch(/stopped at the .*budget/);

    // THE REGRESSION PIN. `re-keyed N` with N > 0 on a budget-stopped pass.
    const reKeyed = /^\s*re-keyed\s+([\d,]+)/m.exec(out);
    expect(reKeyed, `no "re-keyed" line in:\n${out.slice(-3000)}`).not.toBeNull();
    const written = Number(reKeyed![1].replace(/,/g, ""));
    expect(written).toBeGreaterThan(0);

    // ...and those writes are real rows in the pool, not just a counter.
    expect(poolBySlug(poolStateFile)[DERIVED]).toBe(written);

    // The write ledger -- what the canary gate attributes damage with -- names
    // both pools the re-key touched, and is no longer empty.
    expect(out).toMatch(/WRITE LEDGER\s+2 pool\(s\) touched/);

    // The reconcile still balances, with the tail booked as not reached.
    const recon = /intended ([\d,]+) = written ([\d,]+) \+ skipped ([\d,]+) \+ failed ([\d,]+) \+ not reached ([\d,]+)/.exec(out);
    expect(recon).not.toBeNull();
    const [intended, w, skipped, failed, notReached] = recon!.slice(1).map((n) => Number(n.replace(/,/g, "")));
    expect(w + skipped + failed + notReached).toBe(intended);
    expect(w).toBe(written);

    // A cursor exists for the APPLY, under its own mode-keyed id.
    const control = JSON.parse(readFileSync(controlStateFile, "utf8"));
    expect(Object.keys(control)).toContain(`apply-cursor::apply-improve::slot-${SLOT}`);
    expect(control[`apply-cursor::apply-improve::slot-${SLOT}`].partialUnit?.continuationToken).toBeTruthy();
    // ...and NOT under the census's id, which belongs to a different walk.
    expect(Object.keys(control)).not.toContain(`census-cursor::slot-${SLOT}`);
  }, TEST_TIMEOUT_MS);

  itIfBuilt("a relaunch RESUMES from the saved token instead of restarting at row 0", () => {
    const first = runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "1.6", slowPageMs: 4000 });
    expect(`${first.stdout}${first.stderr}`).toMatch(/stopped at the .*budget/);

    const second = runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "10", slowPageMs: 0 });
    const out = `${second.stdout ?? ""}${second.stderr ?? ""}`;

    // The narration names the APPLY cursor (not the census's) and says it is
    // resuming from a saved page token.
    expect(out).toMatch(/APPLY CURSOR: resuming slot 15/);
    expect(out).toMatch(/carries this pass straight to its saved continuation token/);

    // Pass 1's counts are MERGED into pass 2's totals, not overwritten: the
    // reconcile is cumulative across the link, so `intended` exceeds the rows
    // pass 2 classified on its own.
    const recon = /intended ([\d,]+) = written ([\d,]+) \+ skipped ([\d,]+) \+ failed ([\d,]+) \+ not reached ([\d,]+)/.exec(out);
    expect(recon).not.toBeNull();
    const [intended, w, skipped, failed, notReached] = recon!.slice(1).map((n) => Number(n.replace(/,/g, "")));
    expect(w + skipped + failed + notReached).toBe(intended);
    expect(w).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  itIfBuilt("enough relaunches CONVERGE the shard -- every row reaches its derived address, exactly once", () => {
    // Three budget-stopped links then one unbounded one, the shape the runner
    // produces. The old code would still be at zero after any number of these.
    for (let i = 0; i < 3; i++) {
      runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "1.6", slowPageMs: 4000 });
    }
    runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "10", slowPageMs: 0 });

    const bySlug = poolBySlug(poolStateFile);
    // All 6 rows moved, none left behind at the base slug, and no row
    // duplicated by being written twice across two links (the `already-at-
    // target` re-check is what makes a re-read page harmless).
    expect(bySlug[DERIVED]).toBe(6);
    expect(bySlug[BASE]).toBeUndefined();

    // A finished shard clears its cursor, so an unrelated later dispatch of
    // the same slot starts clean rather than "resuming" a finished walk.
    const control = JSON.parse(readFileSync(controlStateFile, "utf8"));
    expect(control[`apply-cursor::apply-improve::slot-${SLOT}`]).toBeUndefined();
  }, TEST_TIMEOUT_MS * 2);

  itIfBuilt("a REPORT-ONLY pass never resumes -- a dry run reports the whole shard it was pointed at", () => {
    // A cursor left by a prior APPLY must not make a later report silently
    // describe only the tail. A dry run writes nothing, so it has no progress
    // to resume and must always start cold.
    const first = runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "1.6", slowPageMs: 4000 });
    expect(`${first.stdout}${first.stderr}`).toMatch(/stopped at the .*budget/);

    const report = runPass({ controlStateFile, poolStateFile, censusOut, runMinutes: "10", slowPageMs: 0, apply: false });
    const out = `${report.stdout ?? ""}${report.stderr ?? ""}`;
    expect(out).toMatch(/REPORT ONLY/);
    expect(out).not.toMatch(/APPLY CURSOR: resuming/);
  }, TEST_TIMEOUT_MS);
});
