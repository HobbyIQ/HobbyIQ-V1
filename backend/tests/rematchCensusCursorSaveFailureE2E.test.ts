/**
 * CF-A-LAZY-REFERENCE-IS-NOT-A-CONTAINER -- the END-TO-END pin for a FAILED
 * cursor save (2026-09-12, run 34658848883 slot 3).
 *
 * rematchCensusCursorE2E.test.ts drives two real child-process passes across
 * a SUCCESSFUL checkpoint/resume. rematchCensusCursorSaveFailure.test.ts pins
 * the container-provisioning helper and the exit-code constant directly.
 * THIS FILE drives the real, unexported main() through a budget stop whose
 * cursor save FAILS (FAIL_CURSOR_UPSERT=true on the fake `rematch_control`
 * container -- see fake-cosmos-preload.cjs), and asserts on the three things
 * the incident needed and did not have:
 *
 *   1. stdout does NOT claim "checkpointed" for a save that failed.
 *   2. stdout does NOT contain a bare "stopped at the ... budget" line --
 *      relaunch-on-marker's outcome (a) re-dispatches on an UNANCHORED grep
 *      for exactly that phrase, with no exit-code check, so any surviving
 *      match anywhere in the log would still trigger the blind re-dispatch
 *      that reproduces the restart-from-zero loop #2045 exists to end.
 *   3. The process exits with CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE (5), not 0
 *      -- so `finishLane: exiting code 5` lands in the log and
 *      relaunch-on-marker's "finishLane with a NON-ZERO code" arm reports the
 *      verdict and withholds the re-dispatch instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const backend = join(__dirname, "..");
const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
const PRELOAD = join(backend, "tests", "fixtures", "census-cursor-e2e", "fake-cosmos-preload.cjs");
const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));

const itIfBuilt = DIST_EXISTS ? it : it.skip;
const TEST_TIMEOUT_MS = 60_000;

describe("rematch-sold-comps.cjs MODE=census, a budget stop whose cursor save FAILS", () => {
  let dir: string;
  let censusOut: string;
  let controlStateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "census-save-fail-e2e-"));
    censusOut = join(dir, "census");
    controlStateFile = join(dir, "control-state.json");
  });
  afterEach(() => { /* mkdtempSync dirs are OS temp; leaving a small dir on failure is fine */ });

  itIfBuilt("does not print 'checkpointed', does not print a bare budget-stop line, and exits with the distinct failure code", () => {
    const env = {
      ...process.env,
      MODE: "census",
      SLOT: "0",
      SLOTS: "32",
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
      RUN_MINUTES: "1.6",
      CENSUS_OUT: censusOut,
      CONTROL_STATE_FILE: controlStateFile,
      SLOW_UNIT_MS: "8000",
      FAIL_CURSOR_UPSERT: "true",
    };
    const res = spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
      cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
    });
    const out = res.stdout ?? "";
    const errOut = res.stderr ?? "";

    // The failure was reached (unit 1 finished, budget then tripped before
    // unit 2) -- same shape as run 34658848883 slot 3's real log.
    expect(out).toMatch(/CENSUS\s+slot 0\/32\s+rows classified 3\b/);

    // 1. NEVER claims a checkpoint that did not happen. The "NOT
    // checkpointed" line itself goes out via console.warn (fd 2 / stderr) --
    // deliberately, since plain console.log/stdout is dropped by the #1982
    // WARN floor -- so it is asserted against errOut below, not stdout.
    expect(out).not.toMatch(/CENSUS CURSOR: checkpointed/);
    expect(errOut).toMatch(/CENSUS CURSOR: NOT checkpointed for slot 0/);

    // 2. NEVER lets the bare budget-stop phrase reach the log -- this is the
    // exact string relaunch-on-marker's outcome (a) greps for, unanchored,
    // with no exit-code check at all.
    const fullLog = out + "\n" + errOut;
    expect(fullLog).not.toMatch(/stopped at the .*budget/);

    // The failure is still loud (console.warn -- combined with stderr since
    // console.warn writes to fd 2, which this test does not merge into
    // `out` above by design, matching how /tmp/backfill.log is stdout-only
    // and an operator's terminal shows both streams).
    expect(errOut).toMatch(/could not save census cursor for slot 0/);
    expect(errOut).toMatch(/NOT checkpointed for slot 0/);

    // 3. Exits with the distinct, load-bearing failure code -- never 0, and
    // never silently mapped into the ordinary "stopped at the budget" reading
    // relaunch-on-marker's outcome (a) would otherwise re-dispatch on.
    expect(out).toMatch(/finishLane: exiting code 5/);
    expect(res.status).toBe(5);
  }, TEST_TIMEOUT_MS + 10_000);
});
