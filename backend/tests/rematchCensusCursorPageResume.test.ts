/**
 * CF-A-CENSUS-SLOT-RESUMES-IT-DOES-NOT-RESTART, THE PAGE GRAIN (2026-09-12,
 * #2058 follow-up).
 *
 * rematchCensusCursorE2E.test.ts pins the ORIGINAL, coarser fix: a budget
 * stop that lands exactly AT a unit boundary checkpoints `unitsDone` and a
 * relaunch skips that whole unit. That fix is necessary but not sufficient:
 * measured on the real fleet, slot 0's own first unit (484,940 rows) alone
 * exceeds one 120-minute link's throughput at every rate observed
 * (144-203 in-slot rows/s classifies 1.02M-1.44M rows per link, and a unit
 * has to be crossed WHOLE to checkpoint at all) -- runs 34686318652,
 * 34686403508, 34686374165 and 34688675098 all printed "checkpointed 0 of 2
 * unit(s)" after burning a full budget, so every relaunch re-paged that same
 * first unit from row zero, forever.
 *
 * THIS FILE drives the real, unexported `main()` through a budget stop that
 * lands STRICTLY BETWEEN two pages of the SAME unit (never at its end), using
 * fake-cosmos-preload.cjs's UNIT_A_PAGE_ROWS/UNIT_A_ROW_COUNT knobs, and
 * proves:
 *
 *   PASS 1  Stops mid-unit-A, having classified only the first page(s).
 *           Asserts: `stopped at the ... budget`, a `partialUnit` cursor
 *           persisted for unit A's key, and `unitsDone` still EMPTY (unit A
 *           is not finished, so it must not be marked done).
 *   PASS 2  Same slot. Reads pass 1's partialUnit, resumes unit A from its
 *           saved continuation token (not row 1), finishes it, then unit B.
 *           Asserts: the SECOND pass's own row-count contribution is only
 *           the REMAINING rows of unit A plus all of unit B -- never unit A's
 *           already-classified prefix reclassified -- so the combined total
 *           across both passes equals the fixture's true row count exactly
 *           once, with nothing double-counted and nothing dropped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const backend = join(__dirname, "..");
const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
const PRELOAD = join(backend, "tests", "fixtures", "census-cursor-e2e", "fake-cosmos-preload.cjs");
const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));

const itIfBuilt = DIST_EXISTS ? it : it.skip;
const TEST_TIMEOUT_MS = 60_000;

// Unit A carries 6 rows fixture-wide, paged 2 at a time -> 3 pages. Unit B
// (1953, unchanged) carries its usual 2 rows in one page.
const UNIT_A_ROW_COUNT = 6;
const UNIT_A_PAGE_ROWS = 2;

function runPass(opts: { censusOut: string; controlStateFile: string; slowUnitMs: number; runMinutes: string }) {
  const env = {
    ...process.env,
    MODE: "census",
    SLOT: "0",
    SLOTS: "32",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
    RUN_MINUTES: opts.runMinutes,
    CENSUS_OUT: opts.censusOut,
    CONTROL_STATE_FILE: opts.controlStateFile,
    SLOW_UNIT_MS: String(opts.slowUnitMs),
    UNIT_A_ROW_COUNT: String(UNIT_A_ROW_COUNT),
    UNIT_A_PAGE_ROWS: String(UNIT_A_PAGE_ROWS),
    // Force a checkpoint attempt on every single page, so a budget stop
    // landing between page 1 and page 2 of unit A is guaranteed to have a
    // freshly saved partialUnit token from page 1 to resume from -- this
    // test is about proving the RESUME wiring, not tuning the checkpoint
    // cadence (rematchCensusCursorResume.test.ts covers the cadence knobs
    // directly against the pure save/load functions).
    CENSUS_PAGE_CHECKPOINT_PAGES: "1",
    CENSUS_PAGE_CHECKPOINT_MS: "1",
  };
  const res = spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
    cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
  return res;
}

describe("rematch-sold-comps.cjs MODE=census, a budget stop landing MID-UNIT (between two pages of the same unit)", () => {
  let dir: string;
  let censusOut: string;
  let controlStateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "census-page-resume-"));
    censusOut = join(dir, "census");
    controlStateFile = join(dir, "control-state.json");
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  itIfBuilt("pass 1 stops between unit A's pages, checkpoints a partialUnit, and does NOT mark unit A done", () => {
    // RUN_MINUTES=1.9 -> 114,000ms budget. Every page of unit A sleeps
    // 20,000ms, checked by `budgetLeft() < 90000` both BEFORE each fetch and
    // again right after (the second check is this fix's own addition, so a
    // checkpoint save's own wall-clock cost cannot push a pass past its
    // budget before the next stop test). After page 1 (20s elapsed)
    // budgetLeft() is ~94,000ms -- above the reserve, page 2 proceeds; after
    // page 2 (40s elapsed) budgetLeft() is ~74,000ms -- UNDER the reserve, so
    // the loop stops there, before page 3 is ever fetched. 4 of unit A's 6
    // rows classified (2 pages x 2 rows), never reaching unit B.
    const res = runPass({ censusOut, controlStateFile, slowUnitMs: 20000, runMinutes: "1.9" });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    expect(out).toMatch(/stopped at the 1\.9-minute budget/);
    expect(out).toMatch(/CENSUS\s+slot 0\/32\s+rows classified 4\b/); // 2 pages of unit A only
    expect(out).toMatch(/CENSUS CURSOR: checkpointed 0 of 2 unit\(s\) for slot 0.*unit y=2025\/s=pokemon is IN PROGRESS/);

    const controlState = JSON.parse(readFileSync(controlStateFile, "utf8"));
    const cursor = controlState["census-cursor::slot-0"];
    expect(cursor).toBeTruthy();
    // THE KEY ASSERTION THIS FILE EXISTS FOR: unitsDone is EMPTY (unit A
    // never finished, so it must never be marked done -- that would make a
    // relaunch skip its remaining 2 rows entirely), while partialUnit
    // carries the exact resume point inside it.
    expect(cursor.unitsDone).toEqual([]);
    expect(cursor.partialUnit).toBeTruthy();
    expect(cursor.partialUnit.key).toBe("y=2025/s=pokemon");
    expect(cursor.partialUnit.continuationToken).toBe("unitA:4");
    expect(cursor.classified).toBe(4);
  }, TEST_TIMEOUT_MS + 10_000);

  itIfBuilt("pass 2 resumes unit A from its saved page token (not row 1), finishes it, then unit B -- no row double-counted or dropped", () => {
    const first = runPass({ censusOut, controlStateFile, slowUnitMs: 20000, runMinutes: "1.9" });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/stopped at the 1\.9-minute budget/);

    // Pass 2: same slot, no slowdown, generous budget.
    const second = runPass({ censusOut, controlStateFile, slowUnitMs: 0, runMinutes: "10" });
    expect(second.status).toBe(0);
    const out = second.stdout ?? "";

    // RESUMES mid-unit: the cursor line names the partial unit explicitly.
    expect(out).toMatch(/CENSUS CURSOR: resuming slot 0.*page checkpoint inside unit y=2025\/s=pokemon carries this pass straight to its saved continuation token/);

    // This pass's OWN classification pass sees only the REMAINING 2 rows of
    // unit A (rows 5-6, via the resumed token) plus unit B's 2 rows = 4 --
    // never unit A's already-classified rows 1-4 again. Combined with pass
    // 1's merged-in 4, the final total is 8 (6 + 2), which is the fixture's
    // TRUE row count exactly once.
    expect(out).toMatch(/CENSUS\s+slot 0\/32\s+rows classified 8\b/);
    expect(out).toMatch(/CENSUS CURSOR: slot 0 finished within budget -- every unit classified, cursor cleared\./);
    expect(out).not.toMatch(/stopped at the .*budget/);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.classified).toBe(8); // 6 (unit A) + 2 (unit B), counted exactly once each
    expect(artifact.stoppedAtBudget).toBe(false);
    expect(artifact.units.map((u: { key: string }) => u.key).sort()).toEqual(["y=1953", "y=2025/s=pokemon"]);

    const controlState = JSON.parse(readFileSync(controlStateFile, "utf8"));
    expect(controlState["census-cursor::slot-0"]).toBeUndefined();
  }, TEST_TIMEOUT_MS + 10_000);
});
