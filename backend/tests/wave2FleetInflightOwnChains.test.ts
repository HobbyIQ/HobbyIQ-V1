/**
 * CF-STAGGER-COUNTS-OWN-CHAINS-NOT-THE-SHARED-LANE (2026-09-12).
 *
 * THE DEFECT THIS REPLACES. `inflight_census_count` / `wait_for_inflight_room`
 * used to count every queued/in_progress run on the SHARED backfill-runner.yml
 * workflow created since the phase started -- no filter on script, mode or
 * slot. Measured: 6 real census slots plus 2 unrelated baseline-pool-snapshot
 * cron runs read as "8 in flight" against MAX_INFLIGHT_CENSUS_SLOTS=8, and
 * slot 10+ never dispatched though this fleet genuinely had room. The
 * workflow has no marker/free-text input to filter on (`script` is a fixed
 * dropdown) and `gh run list`'s displayTitle/name are the workflow's static
 * name regardless of script/mode/slot, so the fix is a table of THIS FLEET'S
 * OWN dispatched run ids (and their self-relaunch successors), never the
 * shared lane's raw count.
 *
 * This file drives inflight_census_count / wait_for_inflight_room / dispatch
 * FOR REAL against a fake `gh` on PATH, the same harness style as
 * wave2FleetFinderWaits.test.ts, because the property under test --
 * "a foreign run must never inflate this count, and a budget-stopped chain
 * must still count until its successor is visible or a grace window elapses"
 * -- is a runtime behaviour a static regex pin cannot prove.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_TIMEOUT_MS = 60_000;

const repoRoot = join(__dirname, "..", "..");
const FLEET = join(repoRoot, "backend", "scripts", "wave2", "wave2-fleet.sh");
const fleetSrc = readFileSync(FLEET, "utf8");

function findBash(): string | null {
  for (const candidate of ["bash", "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash", "/bin/bash"]) {
    try {
      execFileSync(candidate, ["-c", "true"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}
const BASH = findBash();
const HAS_BASH = BASH !== null;
const itShell = (name: string, fn: () => void) => it.runIf(HAS_BASH)(name, fn, SHELL_TIMEOUT_MS);

function toShellPath(p: string): string {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return win ? `/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : p;
}

const cutDispatcher = (src: string) => src.slice(0, src.indexOf('case "${1:-}" in'));

/**
 * A fake `gh` covering the three calls this fix's functions issue:
 *   - `gh run list --json databaseId,createdAt --jq ...`  -> every FakeRun
 *     created so far (including ones dispatched during the test itself),
 *     oldest first.
 *   - `gh run view <id> --json status --jq .status`        -> the run's
 *     current status, from its own fixture entry.
 *   - `gh run view <id> --log`                              -> the run's log,
 *     ONLY once its status is `completed` (mirrors the real refusal).
 *   - `gh workflow run ...`                                 -> creates a NEW
 *     run (appends to the state directory) and prints its URL, the same
 *     shape dispatch() parses a run id out of. Which slot the new run
 *     belongs to and what its log/status will be come from `dispatchPlan`,
 *     keyed by call order per slot -- so a test can script "slot 0's first
 *     dispatch is a foreign-looking run" vs "slot 0's second dispatch (the
 *     self-relaunch successor) is the real one".
 */
type FakeRun = {
  id: string;
  createdAt: string;
  status: "queued" | "in_progress" | "completed";
  log: string;
  /** Flip to "completed" only after this many `--json status` polls (see fakeGh's helper). */
  readyAfterPolls?: number;
};

function fakeGh(dir: string, initialRuns: FakeRun[], dispatchPlan: Record<string, FakeRun[]>): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "runs.json"), JSON.stringify(initialRuns), "utf8");
  writeFileSync(join(stateDir, "plan.json"), JSON.stringify(dispatchPlan), "utf8");
  writeFileSync(join(stateDir, "next_id.txt"), "90000", "utf8");
  writeFileSync(join(stateDir, "dispatch_calls.json"), "{}", "utf8");

  // The heavy lifting is in a Node helper the fake `gh` shells out to, so the
  // fixture logic is real JS rather than another layer of shell string
  // munging -- the shell wrapper only has to dispatch to it and print stdout.
  const helper = join(binDir, "gh-helper.js");
  writeFileSync(
    helper,
    `
const fs = require("fs");
const path = require("path");
const stateDir = process.argv[2];
const args = process.argv.slice(3);

function load(name) { return JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8")); }
function save(name, v) { fs.writeFileSync(path.join(stateDir, name), JSON.stringify(v), "utf8"); }

if (args[0] === "run" && args[1] === "list") {
  const runs = load("runs.json");
  runs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const r of runs) console.log(Number(r.id));
  process.exit(0);
}

if (args[0] === "run" && args[1] === "view") {
  const id = args[2];
  const isLog = args.includes("--log");
  const runs = load("runs.json");
  const run = runs.find((r) => String(r.id) === String(id));
  if (!run) process.exit(1);
  // readyAfterPolls: how many times --json status must be asked before this
  // run flips from its initial status to "completed". Lets a test simulate a
  // run finishing WHILE a polling loop (wait_for_inflight_room) is already
  // running it, without relying on Node's event loop -- which does not turn
  // during a synchronous execFileSync -- to fire a real-time mutation.
  if (!isLog && run.readyAfterPolls) {
    const countFile = path.join(stateDir, "poll-" + id + ".count");
    let n = Number(fs.readFileSync(countFile, "utf8").toString() || "0") || 0;
    n += 1;
    fs.writeFileSync(countFile, String(n), "utf8");
    if (n >= run.readyAfterPolls) run.status = "completed";
    save("runs.json", runs);
  }
  if (isLog) {
    if (run.status !== "completed") { process.stderr.write("run is still in progress\\n"); process.exit(1); }
    process.stdout.write(run.log);
    process.exit(0);
  }
  console.log(run.status);
  process.exit(0);
}

if (args[0] === "workflow" && args[1] === "run") {
  // Find the -f slot=N argument.
  let slot = null;
  for (const a of args) { const m = /^slot=(\\d+)$/.exec(a); if (m) slot = m[1]; }
  const plan = load("plan.json");
  const calls = load("dispatch_calls.json");
  const n = (calls[slot] || 0);
  calls[slot] = n + 1;
  save("dispatch_calls.json", calls);
  const seq = plan[slot] || [];
  const spec = seq[n] || seq[seq.length - 1];
  if (!spec) { console.error("no dispatch plan for slot " + slot); process.exit(1); }
  let nextId = Number(fs.readFileSync(path.join(stateDir, "next_id.txt"), "utf8"));
  const id = spec.id !== undefined ? spec.id : nextId++;
  fs.writeFileSync(path.join(stateDir, "next_id.txt"), String(nextId), "utf8");
  const runs = load("runs.json");
  runs.push({ id: String(id), createdAt: spec.createdAt || new Date(Date.now()).toISOString(), status: spec.status, log: spec.log || "", readyAfterPolls: spec.readyAfterPolls });
  save("runs.json", runs);
  console.log("https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/" + id);
  process.exit(0);
}

// Mutation helper the test uses between polls to advance a run's status.
if (args[0] === "__set_status") {
  const [, , id, status] = args;
  const runs = load("runs.json");
  const run = runs.find((r) => String(r.id) === String(id));
  if (run) run.status = status;
  save("runs.json", runs);
  process.exit(0);
}

console.error("fake gh: unhandled invocation: " + args.join(" "));
process.exit(1);
`,
    "utf8",
  );

  const script = `#!/usr/bin/env bash
exec node "${toShellPath(helper)}" "${toShellPath(stateDir)}" "$@"
`;
  writeFileSync(join(binDir, "gh"), script, { encoding: "utf8", mode: 0o755 });
  return binDir;
}

const CENSUS_LOG = (slot: number) =>
  [
    "Script confirmed: backend/scripts/rematch-sold-comps.cjs",
    `rematch-sold-comps  MODE=census  READ ONLY  slot ${slot}/32  budget 140m  limit none`,
    `CENSUS  slot ${slot}/32  rows classified 231,480`,
    "finishLane: exiting code 0",
    "",
  ].join("\n");

const CENSUS_BUDGET_LOG = (slot: number) =>
  [
    "Script confirmed: backend/scripts/rematch-sold-comps.cjs",
    `rematch-sold-comps  MODE=census  READ ONLY  slot ${slot}/32  budget 140m  limit none`,
    "lane stopped at the 140-minute budget -- relaunching",
    "",
  ].join("\n");

const FOREIGN_SNAPSHOT_LOG = [
  "Script confirmed: backend/scripts/baseline-pool-snapshot.cjs",
  "baseline-pool-snapshot  MODE=snapshot",
  "finishLane: exiting code 0",
  "",
].join("\n");

/** Run one shell snippet against the harness, with the fake gh on PATH. */
function runHarness(opts: { binDir: string; body: string; logdir: string }): { rc: number; out: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-"));
  const harness = join(dir, "harness.sh");
  writeFileSync(harness, `${cutDispatcher(fleetSrc)}\n${opts.body}\n`, "utf8");
  try {
    const out = execFileSync(BASH!, [toShellPath(harness)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SHELL_TIMEOUT_MS - 10_000,
      env: {
        ...process.env,
        PATH: `${toShellPath(opts.binDir)}:${process.env.PATH ?? ""}`,
        LOGDIR: toShellPath(opts.logdir),
        REPO: "HobbyIQ/HobbyIQ-V1",
        WAVE2_DISPATCH: "true",
        WAVE2_INFLIGHT_BUDGET_GRACE_SECS: "2",
        WAVE2_INFLIGHT_POLL_SECS: "1",
      },
    });
    return { rc: 0, out: out.trim(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { rc: err.status ?? 1, out: (err.stdout ?? "").trim(), stderr: (err.stderr ?? "").trim() };
  }
}

describe("inflight_census_count counts only this fleet's own tracked chains", () => {
  itShell("a foreign run on the shared lane is never counted, even if it is in_progress", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    // A foreign snapshot-cron run sits in_progress on the shared lane the
    // whole time. It is never tracked by this fleet's table (dispatch() was
    // never called for it), so inflight_census_count must read 0 even though
    // the shared lane objectively has a run going.
    const binDir = fakeGh(
      dir,
      [{ id: "1", createdAt: "1970-01-01T00:00:01Z", status: "in_progress", log: FOREIGN_SNAPSHOT_LOG }],
      {},
    );
    const res = runHarness({
      binDir,
      logdir,
      body: `inflight_reset_state test\ninflight_census_count test`,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("0");
  });

  itShell("a slot this fleet dispatched, still in_progress, counts as 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const binDir = fakeGh(dir, [], {
      "0": [{ id: 5001, status: "in_progress", createdAt: "1970-01-01T00:00:01Z" }],
    });
    const res = runHarness({
      binDir,
      logdir,
      body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
inflight_census_count test; echo
`,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("1");
  });

  itShell("a finished slot is no longer counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const binDir = fakeGh(dir, [], {
      "0": [{ id: 5002, status: "completed", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_LOG(0) }],
    });
    const res = runHarness({
      binDir,
      logdir,
      body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
inflight_census_count test; echo
`,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("0");
  });

  itShell(
    "a slot whose current link just budget-stopped still counts as 1 within the grace window, with no successor visible yet",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
      const logdir = join(dir, "logs");
      mkdirSync(logdir, { recursive: true });
      const binDir = fakeGh(dir, [], {
        "0": [{ id: 5003, status: "completed", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_BUDGET_LOG(0) }],
      });
      const res = runHarness({
        binDir,
        logdir,
        body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
inflight_census_count test; echo
`,
      });
      expect(res.rc).toBe(0);
      // Immediately after the budget-stop, nothing else was dispatched as a
      // successor, but we are well inside the (test-shortened) grace window --
      // the chain is one in-flight slot, not zero.
      expect(res.out).toBe("1");
    },
  );

  itShell("once the grace window elapses with no successor, the slot stops counting", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const binDir = fakeGh(dir, [], {
      "0": [{ id: 5004, status: "completed", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_BUDGET_LOG(0) }],
    });
    const res = runHarness({
      binDir,
      logdir,
      body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
inflight_census_count test >/dev/null   # first read stamps budget_at
sleep 3                                  # grace is 2s in this test env
inflight_census_count test; echo
`,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("0");
  });

  itShell("a budget-stopped slot whose self-relaunch successor is already visible counts as 1 and re-attaches to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    // The predecessor (5005) is already completed+budget by the time the
    // fleet first asks, and its successor (5006) is ALREADY in the run list
    // (createdAt a second later) -- simulating the real relaunch action
    // having already dispatched it inline.
    const binDir = fakeGh(
      dir,
      [{ id: "5006", createdAt: "1970-01-01T00:00:02Z", status: "in_progress", log: "" }],
      { "0": [{ id: 5005, status: "completed", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_BUDGET_LOG(0) }] },
    );
    const res = runHarness({
      binDir,
      logdir,
      body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
inflight_census_count test; echo
cat "$(inflight_state_dir test)/0.run_id"
`,
    });
    expect(res.rc).toBe(0);
    const [count, reattached] = res.out.split("\n");
    expect(count).toBe("1");
    // Re-attached to the successor's run id, not left pointing at the dead
    // predecessor -- proves the chain, not just the one run, is tracked.
    expect(reattached).toBe("5006");
  });

  itShell("a foreign run created in the same window as a budget stop is never mistaken for the successor", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    // A foreign run (an ad-hoc reprice-user-holdings dispatch) lands in the
    // exact same window right after the budget stop. It must be rejected by
    // run_log_identifies_slot and NOT adopted as slot 0's successor -- the
    // slot keeps counting via the grace window instead, never via a
    // misattributed run id.
    const binDir = fakeGh(
      dir,
      [
        {
          id: "9999",
          createdAt: "1970-01-01T00:00:02Z",
          status: "completed",
          log: [
            "Script confirmed: backend/scripts/reprice-user-holdings.cjs",
            "reprice-user-holdings  MODE=batch",
            "finishLane: exiting code 0",
            "",
          ].join("\n"),
        },
      ],
      { "0": [{ id: 5007, status: "completed", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_BUDGET_LOG(0) }] },
    );
    const res = runHarness({
      binDir,
      logdir,
      body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
inflight_census_count test; echo
cat "$(inflight_state_dir test)/0.run_id"
`,
    });
    expect(res.rc).toBe(0);
    const [count, trackedId] = res.out.split("\n");
    expect(count).toBe("1"); // still in-flight via the grace window
    expect(trackedId).toBe("5007"); // NOT reattached to the foreign 9999
  });

  itShell("two slots dispatched, one finished and one still running, counts exactly the running one", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const binDir = fakeGh(dir, [], {
      "0": [{ id: 6001, status: "completed", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_LOG(0) }],
      "1": [{ id: 6002, status: "in_progress", createdAt: "1970-01-01T00:00:01Z" }],
    });
    const res = runHarness({
      binDir,
      logdir,
      body: `
inflight_reset_state test
dispatch census false improve 0 test >&2
dispatch census false improve 1 test >&2
inflight_census_count test; echo
`,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("1");
  });
});

describe("wait_for_inflight_room blocks only on this fleet's own chains", () => {
  itShell("does not block when the cap is not reached, regardless of a foreign in_progress run", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const binDir = fakeGh(
      dir,
      [{ id: "1", createdAt: "1970-01-01T00:00:01Z", status: "in_progress", log: FOREIGN_SNAPSHOT_LOG }],
      {},
    );
    const res = runHarness({
      binDir,
      logdir,
      body: `
MAX_INFLIGHT_CENSUS_SLOTS=8
inflight_reset_state test
wait_for_inflight_room test
echo DONE
`,
    });
    expect(res.rc).toBe(0);
    // Must return immediately -- if the foreign run were counted this would
    // hang until the test's own timeout.
    expect(res.out).toBe("DONE");
  });

  itShell("blocks while own chains are at the cap, then proceeds once one finishes", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-inflight-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    // readyAfterPolls=3: the fake answers in_progress for the first two
    // `--json status` polls wait_for_inflight_room makes, then completed --
    // proving the loop re-polls a live candidate rather than reading one
    // stale snapshot (execFileSync blocks Node's event loop, so a real-time
    // setTimeout-driven mutation from the test process cannot fire while the
    // harness subprocess runs; the fake gh advances its own state instead).
    const binDir = fakeGh(dir, [], {
      "0": [{ id: 7001, status: "in_progress", createdAt: "1970-01-01T00:00:01Z", log: CENSUS_LOG(0), readyAfterPolls: 3 }],
    });

    const res = runHarness({
      binDir,
      logdir,
      body: `
MAX_INFLIGHT_CENSUS_SLOTS=1
INFLIGHT_POLL_SECS=1
inflight_reset_state test
dispatch census false improve 0 test >&2
wait_for_inflight_room test
echo DONE
`,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("DONE");
  });
});

describe("the fix does not touch follow_slot's identity checks", () => {
  it("follow_slot's body is byte-identical in the functions it calls", () => {
    const follow = fleetSrc.slice(fleetSrc.indexOf("follow_slot() {"), fleetSrc.indexOf("selected_slots() {"));
    expect(follow).toContain("find_run_for_slot");
    expect(follow).toContain('run_log_identifies_slot "$log" "$mode" "$slot"');
    // the inflight table's own verification reuses the identical function,
    // never a re-derived regex
    const inflight = fleetSrc.slice(fleetSrc.indexOf("inflight_refresh_slot() {"), fleetSrc.indexOf("inflight_find_successor() {"));
    expect(inflight).toContain('run_log_identifies_slot "$log" census "$slot"');
  });

  it("the stagger's dispatch call site passes the tag only from the census phase", () => {
    expect(fleetSrc).toContain('dispatch census false improve "$s" "$tag" || true');
    expect(fleetSrc).toContain('wait_for_inflight_room "$tag"');
  });
});
