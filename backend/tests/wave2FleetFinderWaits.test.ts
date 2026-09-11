/**
 * CF-A-RUN-IS-IDENTIFIED-BY-ITS-LOG-NOT-BY-A-SEARCH-TIMEOUT (2026-09-11).
 *
 * wave2FleetGates.test.ts pins the STATIC shape of find_run_for_slot() --
 * regexes over the shell source. This file drives the function FOR REAL,
 * against a fake `gh` on PATH, because the defect this fix replaces was not a
 * shape problem: run 34360565942 was a genuine census run, correctly the
 * newest un-rejected candidate, and `find_run_for_slot` still reported it
 * `unfound` because ONE clock bounded both "find a candidate" and "wait for
 * it to finish running" -- and completion for a 140-minute census routinely
 * outlasted the 15-minute default. A static regex pin cannot catch that: the
 * old code and the new code both contain a `sleep "$POLL_SECS"` and a
 * deadline check, and only running the loop against a run that stays
 * in_progress past the OLD single deadline proves the fix.
 *
 * THE FAKE `gh`. A tiny shell script placed first on PATH that answers
 * `gh run list ...`, `gh run view <id> --json status ...` and
 * `gh run view <id> --log` from a small JSON/text fixture directory the test
 * writes per case. It advances a run from `in_progress` to `completed` after
 * a configurable number of times it has been asked, so the test can prove the
 * finder is STILL POLLING (not given up) well past what used to be the one
 * shared deadline.
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

/**
 * Build a fake `gh` on its own directory, sourced onto PATH ahead of any real
 * one. `state` is a small append-only counter file so the fake can change its
 * answer (in_progress -> completed) across repeated invocations within one
 * `find_run_for_slot` poll loop, the same way a real run's status changes
 * over wall-clock time.
 *
 * `runs` describes the fixture's whole run list: each entry becomes a
 * candidate `gh run list` can return, with a `readyAfterPolls` count of how
 * many times its status must be asked before it flips from `in_progress` to
 * `completed`, and a `log` body returned once it is completed.
 */
type FakeRun = { id: string; createdAt: string; readyAfterPolls: number; log: string };

function fakeGh(dir: string, runs: FakeRun[]): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  for (const r of runs) writeFileSync(join(logsDir, `${r.id}.log`), r.log, "utf8");

  const runsJson = JSON.stringify(runs.map((r) => ({ databaseId: Number(r.id), createdAt: r.createdAt })));
  const readyMap = runs.map((r) => `${r.id}:${r.readyAfterPolls}`).join(" ");

  // A POSIX shell fake. `gh run list ... --jq ...` -> prints every run's id
  // (one per line, oldest first, matching the real `--jq ... | .[].databaseId`
  // shape). `gh run view <id> --json status --jq .status` -> in_progress until
  // the poll count for that id reaches its readyAfterPolls, then completed.
  // `gh run view <id> --log` -> that run's fixture log, but ONLY once
  // completed (mirrors the real refusal while a run is in progress).
  const script = `#!/usr/bin/env bash
set -u
RUNS_JSON='${runsJson.replace(/'/g, "'\\''")}'
READY_MAP="${readyMap}"
STATE_DIR="${toShellPath(stateDir)}"
LOGS_DIR="${toShellPath(logsDir)}"

poll_count_for() {
  local id="$1" f="$STATE_DIR/$id.polls" n
  n=$(cat "$f" 2>/dev/null || echo 0)
  n=$((n + 1))
  printf '%s' "$n" > "$f"
  printf '%s' "$n"
}
ready_after_for() {
  local id="$1" pair
  for pair in $READY_MAP; do
    case "$pair" in
      "$id":*) printf '%s' "\${pair#*:}"; return 0 ;;
    esac
  done
  printf '1'
}

if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  # Print ids oldest-first, one per line -- matches the real jq projection
  # find_run_for_slot consumes.
  node -e "const r=$RUNS_JSON; r.forEach(x=>console.log(x.databaseId));"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then
  id="$3"
  # find --json status --jq .status  vs  --log
  is_log=false
  for a in "$@"; do [ "$a" = "--log" ] && is_log=true; done
  if [ "$is_log" = "true" ]; then
    n=$(poll_count_for "$id")
    ready=$(ready_after_for "$id")
    if [ "$n" -ge "$ready" ]; then
      cat "$LOGS_DIR/$id.log" 2>/dev/null
      exit 0
    fi
    # A real 'gh run view --log' on an in_progress run refuses outright.
    echo "run is still in progress" >&2
    exit 1
  fi
  # --json status --jq .status
  n=$(poll_count_for "$id")
  ready=$(ready_after_for "$id")
  if [ "$n" -ge "$ready" ]; then
    printf 'completed\\n'
  else
    printf 'in_progress\\n'
  fi
  exit 0
fi
echo "fake gh: unhandled invocation: $*" >&2
exit 1
`;
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, script, { encoding: "utf8", mode: 0o755 });
  return binDir;
}

/**
 * Source the fleet script's functions (dispatcher cut, as wave2FleetGates.ts
 * does) and call find_run_for_slot against the fake gh, with a compressed
 * clock so the test runs in real seconds rather than real minutes.
 *
 * find_run_for_slot computes its two deadlines as `now + MINUTES * 60`
 * (bash integer arithmetic -- passing a fractional MINUTES value is a syntax
 * error, so the deadlines cannot be shrunk by passing sub-minute values
 * directly). Instead `date +%s` is shadowed with a 60x-FAST clock: real
 * elapsed seconds are multiplied by 60 before being reported, so
 * `IDENTIFY_TIMEOUT_MINUTES=2` elapses in 2 real seconds. This exercises the
 * function's OWN arithmetic and control flow completely unmodified --
 * `identifyTimeoutSecs`/`completionTimeoutSecs` below are real seconds this
 * test will actually wait, mapped 1:1 onto the MINUTES vars the function
 * reads.
 */
function runFinder(opts: {
  runs: FakeRun[];
  mode: string;
  slot: string;
  identifyTimeoutSecs: number;
  completionTimeoutSecs: number;
  pollSecs: number;
}): { rc: number; out: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "wave2-finder-"));
  const binDir = fakeGh(dir, opts.runs);
  const cut = fleetSrc.slice(0, fleetSrc.indexOf('case "${1:-}" in'));
  const harness = join(dir, "harness.sh");
  const dateOverride = `
# A 60x-fast clock: real elapsed seconds counted, multiplied by 60, so
# "MINUTES * 60" in the function under test elapses in 1/60th real time.
# Read is the ONLY thing overridden -- the function's own arithmetic and
# control flow are exercised exactly as shipped.
__T0=$(command date +%s)
date() {
  if [ "$1" = "+%s" ]; then
    local real; real=$(command date +%s)
    printf '%s\\n' $(( __T0 + (real - __T0) * 60 ))
  else
    command date "$@"
  fi
}
`;
  // With the 60x-fast clock above, "MINUTES" in the function under test is
  // really MINUTES real seconds -- so the test's *Secs options map straight
  // onto the MINUTES vars as plain integers (bash arithmetic stays integer,
  // and the function's own `* 60` multiplier is exactly cancelled by the
  // clock running 60x fast). A value must be >= 1 -- 0 would make the
  // deadline equal to "now" before the loop's first real check.
  const identifyMinutes = Math.max(1, Math.round(opts.identifyTimeoutSecs));
  const completionMinutes = Math.max(1, Math.round(opts.completionTimeoutSecs));
  writeFileSync(
    harness,
    `${cut}\n${dateOverride}\n`
      + `IDENTIFY_TIMEOUT_MINUTES=${identifyMinutes}\n`
      + `RUN_COMPLETION_TIMEOUT_MINUTES=${completionMinutes}\n`
      + `find_run_for_slot "${opts.mode}" "${opts.slot}" "1970-01-01T00:00:00Z"\n`,
    "utf8",
  );
  try {
    const out = execFileSync(BASH!, [toShellPath(harness)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${toShellPath(binDir)}:${process.env.PATH ?? ""}`,
        WAVE2_POLL_SECS: String(opts.pollSecs),
        LOGDIR: toShellPath(join(dir, "wave2-logs")),
      },
    });
    return { rc: 0, out: out.trim(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { rc: err.status ?? 1, out: (err.stdout ?? "").trim(), stderr: (err.stderr ?? "").trim() };
  }
}

const PARK_LANE_LOG = `Script confirmed: backend/scripts/relocate-pool-rows-by-list.cjs
some park-lane output, never a rematch-sold-comps banner
`;
const CENSUS_SLOT0_LOG = `Script confirmed: backend/scripts/rematch-sold-comps.cjs
rematch-sold-comps  MODE=census  READ ONLY  slot 0/32  budget 140m  limit none
CENSUS  slot 0/32  rows classified 231,480
finishLane: exiting code 0
`;

describe("find_run_for_slot, driven against a fake gh", () => {
  itShell("rejects a stranger's completed run and keeps looking", () => {
    const res = runFinder({
      runs: [
        { id: "9001", createdAt: "1970-01-01T00:00:01Z", readyAfterPolls: 1, log: PARK_LANE_LOG },
      ],
      mode: "census", slot: "0",
      identifyTimeoutSecs: 3, completionTimeoutSecs: 3, pollSecs: 1,
    });
    // The stranger completes immediately and never identifies as slot 0's
    // census -- the finder must give up as unfound (rc 1, no id printed)
    // rather than accepting it.
    expect(res.rc).toBe(1);
    expect(res.out).toBe("");
  });

  itShell("accepts the real run once it completes, even after several in_progress polls", () => {
    // readyAfterPolls=4 means the fake answers in_progress for the first
    // three status checks and completed on the fourth -- more polls than a
    // single old-style 15-minute/1-poll-per-60s window would often see in a
    // short test, and specifically MORE than one poll, proving the finder
    // does not give up on a still-running candidate.
    const res = runFinder({
      runs: [
        { id: "34360565942", createdAt: "1970-01-01T00:00:01Z", readyAfterPolls: 4, log: CENSUS_SLOT0_LOG },
      ],
      mode: "census", slot: "0",
      // Old single-clock code bounded the WHOLE search (discovery AND
      // completion) by identifyTimeoutSecs. Set it small here -- 2s -- so a
      // conflated clock would time out before the 4-poll completion the fake
      // requires, while completionTimeoutSecs is generous. If this test ever
      // regresses to the old single-clock shape, it fails here.
      identifyTimeoutSecs: 2, completionTimeoutSecs: 30, pollSecs: 1,
    });
    expect(res.rc).toBe(0);
    expect(res.out).toBe("34360565942");
  });

  itShell("gives up on a candidate that never completes within the completion clock, without re-searching", () => {
    const res = runFinder({
      runs: [
        // readyAfterPolls huge -- never completes inside this test's budget.
        { id: "1", createdAt: "1970-01-01T00:00:01Z", readyAfterPolls: 9999, log: CENSUS_SLOT0_LOG },
      ],
      mode: "census", slot: "0",
      identifyTimeoutSecs: 2, completionTimeoutSecs: 2, pollSecs: 1,
    });
    expect(res.rc).toBe(1);
    expect(res.out).toBe("");
    expect(res.stderr).toMatch(/has not completed within/);
  });
});
