/**
 * CF-APPLY-SCOPE-IS-NOT-HARDCODED-IMPROVE (2026-09-13).
 *
 * THE DEFECT THIS CLOSES. #2093 armed three further ruled scopes on the same
 * rematch-sold-comps.cjs apply path -- r26, r27, r28 -- selectable via the
 * EXISTING `scope` workflow-dispatch input, and a follow-up PR teaches the
 * census to carry `counts.r26` / `counts.r27` / `counts.r28` alongside
 * `counts.IMPROVE`. Neither of those PRs touches wave2-fleet.sh, and until
 * now the fleet could not drive an r26/r27/r28 apply or canary at all:
 *
 *   - `run_apply_slots()` (called by both `phase_canary` and `phase_apply`)
 *     hardcoded `dispatch apply-improve true improve "$s"` -- scope was a
 *     bash literal, not a parameter, so no caller could ever request r26.
 *   - `expected_writable()` read `j?.counts?.IMPROVE` literally, so even if
 *     scope COULD be threaded through, the gate would still compare an r26
 *     apply's written count against the IMPROVE class -- a different class
 *     entirely.
 *
 * WAVE2_APPLY_SCOPE (default `improve`, allowlist improve|r26|r27|r28,
 * anything else refused at startup) now drives both: `dispatch()`'s existing
 * `-f scope="$scope"` passthrough (untouched -- it always worked) is finally
 * fed something other than the literal `improve`, and `expected_writable()`
 * reads `counts.<SCOPE_COUNT_KEY>` (IMPROVE for scope=improve, the ruled
 * scope's own name verbatim otherwise).
 *
 * THIS FILE, LIKE wave2FleetInflightOwnChains.test.ts, drives dispatch() and
 * run_apply_slots() FOR REAL against a fake `gh` on PATH: "did scope=r26
 * actually reach the -f flag" and "does an r26 pass's in-flight table stay
 * separate from an improve pass's" are runtime properties a static regex pin
 * over the source cannot prove.
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

// ── STATIC PINS: the source shape ───────────────────────────────────────────

describe("WAVE2_APPLY_SCOPE is validated at startup, not defaulted silently", () => {
  it("defaults to improve", () => {
    expect(fleetSrc).toContain('SCOPE="${WAVE2_APPLY_SCOPE:-improve}"');
  });

  it("refuses any value outside the allowlist", () => {
    const block = fleetSrc.slice(fleetSrc.indexOf('SCOPE="${WAVE2_APPLY_SCOPE'), fleetSrc.indexOf("SCOPE_COUNT_KEY="));
    expect(block).toMatch(/improve\|r26\|r27\|r28\)\s*;;/);
    expect(block).toContain("die \"WAVE2_APPLY_SCOPE='$SCOPE' is not one of improve|r26|r27|r28");
  });

  it("maps improve to the IMPROVE count key and every ruled scope to its own name", () => {
    const block = fleetSrc.slice(fleetSrc.indexOf("case \"$SCOPE\" in\n  improve) SCOPE_COUNT_KEY"), fleetSrc.indexOf("case \"$SCOPE\" in\n  improve) SCOPE_COUNT_KEY") + 200);
    expect(block).toContain("improve) SCOPE_COUNT_KEY=IMPROVE ;;");
    expect(block).toMatch(/\*\)\s*SCOPE_COUNT_KEY="\$SCOPE" ;;/);
  });

  itShell("refuses an unknown scope before dispatching anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-scope-refuse-"));
    const harness = join(dir, "h.sh");
    writeFileSync(harness, `${fleetSrc}\n`, "utf8");
    try {
      execFileSync(BASH!, [toShellPath(harness), "census"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_APPLY_SCOPE: "refractor", WAVE2_DISPATCH: "false" },
      });
      expect.unreachable("expected the script to exit nonzero");
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: Buffer | string };
      expect(err.status).toBe(2);
      expect(String(err.stderr)).toContain("WAVE2_APPLY_SCOPE='refractor' is not one of improve|r26|r27|r28");
    }
  });

  itShell("accepts each of the four allowed scopes without refusing", () => {
    for (const scope of ["improve", "r26", "r27", "r28"]) {
      const dir = mkdtempSync(join(tmpdir(), "wave2-scope-ok-"));
      const harness = join(dir, "h.sh");
      writeFileSync(harness, `${cutDispatcher(fleetSrc)}\necho SCOPE_OK=$SCOPE\n`, "utf8");
      const out = execFileSync(BASH!, [toShellPath(harness)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_APPLY_SCOPE: scope },
      });
      expect(out.trim()).toBe(`SCOPE_OK=${scope}`);
    }
  });
});

describe("dispatch() is no longer fed the literal improve for an apply", () => {
  it("run_apply_slots dispatches $SCOPE, not a hardcoded improve", () => {
    const fn = fleetSrc.slice(fleetSrc.indexOf("run_apply_slots() {"), fleetSrc.indexOf("phase_canary() {"));
    expect(fn).toContain('dispatch apply-improve true "$SCOPE" "$s" "$tag"');
    expect(fn).not.toMatch(/dispatch apply-improve true improve/);
  });

  it("the census dispatch loop stays scope-blind (always improve at the dispatch layer)", () => {
    // Census reports every class in one pass; #1950's own comment already
    // establishes this is unrelated to MODE=apply-improve's scope gate, so
    // the census dispatch itself must NOT start reading $SCOPE.
    const fn = fleetSrc.slice(fleetSrc.indexOf("phase_census() {"), fleetSrc.indexOf("# ── PHASE: COLLECT"));
    expect(fn).toContain("dispatch census false improve");
  });

  it("the 7-flag dispatch shape is unchanged -- scope is threaded, not added", () => {
    const dispatched = [...fleetSrc.matchAll(/-f ([a-z_]+)=/g)].map((m) => m[1]);
    const allowed = new Set(["script", "apply", "mode", "scope", "slot", "slots", "concurrency"]);
    for (const name of dispatched) expect(allowed.has(name)).toBe(true);
    expect(new Set(dispatched).size).toBe(7);
  });
});

describe("expected_writable reads the scope's own count key", () => {
  function writeCensus(dir: string, slot: number, counts: Record<string, number>) {
    writeFileSync(join(dir, `census-slot-${slot}.json`), JSON.stringify({ counts }), "utf8");
  }

  function readExpected(scope: string, censusDir: string, slot = 0): { rc: number; out: string; err: string } {
    const dir = mkdtempSync(join(tmpdir(), "wave2-expected-"));
    const harness = join(dir, "h.sh");
    writeFileSync(
      harness,
      `${cutDispatcher(fleetSrc)}\nexpected_writable ${slot}\n`,
      "utf8",
    );
    try {
      const out = execFileSync(BASH!, [toShellPath(harness)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_APPLY_SCOPE: scope, WAVE2_CENSUS_DIR: toShellPath(censusDir) },
      });
      return { rc: 0, out: out.trim(), err: "" };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { rc: err.status ?? 1, out: (err.stdout ?? "").trim(), err: (err.stderr ?? "").trim() };
    }
  }

  itShell("scope=improve reads counts.IMPROVE, unchanged from before", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-census-"));
    writeCensus(dir, 0, { IMPROVE: 20867, r26: 5, r27: 0 });
    expect(readExpected("improve", dir)).toMatchObject({ rc: 0, out: "20867" });
  });

  itShell("scope=r26 reads counts.r26, not counts.IMPROVE", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-census-"));
    writeCensus(dir, 0, { IMPROVE: 20867, r26: 431, r27: 12, r28: 0 });
    expect(readExpected("r26", dir)).toMatchObject({ rc: 0, out: "431" });
  });

  itShell("scope=r27 and scope=r28 read their own keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-census-"));
    writeCensus(dir, 0, { IMPROVE: 100, r26: 1, r27: 77, r28: 0 });
    expect(readExpected("r27", dir)).toMatchObject({ rc: 0, out: "77" });
    expect(readExpected("r28", dir)).toMatchObject({ rc: 0, out: "0" });
  });

  itShell("refuses with a clear message when the artifact lacks the scope's key", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-census-"));
    // A census taken before the ruled-scope counts existed: IMPROVE only.
    writeCensus(dir, 0, { IMPROVE: 20867 });
    const res = readExpected("r26", dir);
    expect(res.rc).not.toBe(0);
    expect(res.err).toContain("census artifact carries no counts.r26; run a census that counts ruled scopes first");
  });

  itShell("an absent key is refused even when 0 would otherwise be a valid count", () => {
    // r28 present-and-zero must PASS (a real measurement of "nothing
    // writable"); r28 absent-entirely must REFUSE. These are opposite facts.
    const dir = mkdtempSync(join(tmpdir(), "wave2-census-"));
    writeCensus(dir, 0, { IMPROVE: 1, r26: 1, r27: 1 });
    const present = readExpected("r26", dir);
    expect(present).toMatchObject({ rc: 0, out: "1" });
    const absent = readExpected("r28", dir);
    expect(absent.rc).not.toBe(0);
    expect(absent.err).toContain("counts.r28");
  });
});

// ── RUNTIME: dispatch() and run_apply_slots() against a fake `gh` ──────────
//
// Same fake-gh harness style as wave2FleetInflightOwnChains.test.ts: a small
// Node helper the shell's `gh` shim shells out to, driven by a per-slot
// dispatch plan and a shared run-state file.

type FakeRun = {
  id: string | number;
  createdAt?: string;
  status: "queued" | "in_progress" | "completed";
  log?: string;
};

function fakeGh(dir: string, dispatchPlan: Record<string, FakeRun[]>): { binDir: string; stateDir: string } {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "runs.json"), "[]", "utf8");
  writeFileSync(join(stateDir, "plan.json"), JSON.stringify(dispatchPlan), "utf8");
  writeFileSync(join(stateDir, "next_id.txt"), "80000", "utf8");
  writeFileSync(join(stateDir, "dispatch_calls.json"), "{}", "utf8");
  writeFileSync(join(stateDir, "dispatch_log.json"), "[]", "utf8");

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
  if (isLog) {
    if (run.status !== "completed") { process.stderr.write("run is still in progress\\n"); process.exit(1); }
    process.stdout.write(run.log || "");
    process.exit(0);
  }
  console.log(run.status);
  process.exit(0);
}

if (args[0] === "workflow" && args[1] === "run") {
  // Record every -f flag this invocation carried, keyed by slot, so a test
  // can assert on exactly what dispatch() sent -- not just what the fixture
  // scripted back.
  let slot = null;
  const flags = {};
  for (const a of args) {
    const m = /^([a-z_]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2];
    const sm = /^slot=(\\d+)$/.exec(a);
    if (sm) slot = sm[1];
  }
  const dlog = load("dispatch_log.json");
  dlog.push({ slot, flags });
  save("dispatch_log.json", dlog);

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
  runs.push({ id: String(id), createdAt: spec.createdAt || new Date(Date.now()).toISOString(), status: spec.status, log: spec.log || "" });
  save("runs.json", runs);
  console.log("https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/" + id);
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
  return { binDir, stateDir };
}

function readDispatchLog(stateDir: string): Array<{ slot: string | null; flags: Record<string, string> }> {
  return JSON.parse(readFileSync(join(stateDir, "dispatch_log.json"), "utf8"));
}

function runHarness(opts: {
  binDir: string;
  logdir: string;
  censusDir?: string;
  scope: string;
  body: string;
}): { rc: number; out: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "wave2-scope-run-"));
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
        WAVE2_LOGDIR: toShellPath(opts.logdir),
        WAVE2_REPO: "HobbyIQ/HobbyIQ-V1",
        WAVE2_DISPATCH: "true",
        WAVE2_APPLY_SCOPE: opts.scope,
        ...(opts.censusDir ? { WAVE2_CENSUS_DIR: toShellPath(opts.censusDir) } : {}),
        WAVE2_POLL_SECS: "1",
      },
    });
    return { rc: 0, out: out.trim(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { rc: err.status ?? 1, out: (err.stdout ?? "").trim(), stderr: (err.stderr ?? "").trim() };
  }
}

/**
 * Like runHarness, but always captures stderr even on a zero exit -- needed
 * whenever the shell body itself swallows a nonzero function return (e.g.
 * `run_apply_slots ...; echo RC=$?`), which makes the harness process exit 0
 * even though a warn()/die() line was printed to stderr along the way.
 */
function runHarnessCaptureAll(opts: {
  binDir: string;
  logdir: string;
  censusDir?: string;
  scope: string;
  body: string;
}): { rc: number; out: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "wave2-scope-run-"));
  const harness = join(dir, "harness.sh");
  const stderrFile = join(dir, "stderr.log");
  writeFileSync(harness, `${cutDispatcher(fleetSrc)}\n${opts.body}\n`, "utf8");
  const wrapper = join(dir, "wrapper.sh");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nbash "${toShellPath(harness)}" 2>"${toShellPath(stderrFile)}"\necho EXIT=$?\n`, "utf8");
  const out = execFileSync(BASH!, [toShellPath(wrapper)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SHELL_TIMEOUT_MS - 10_000,
    env: {
      ...process.env,
      PATH: `${toShellPath(opts.binDir)}:${process.env.PATH ?? ""}`,
      WAVE2_LOGDIR: toShellPath(opts.logdir),
      WAVE2_REPO: "HobbyIQ/HobbyIQ-V1",
      WAVE2_DISPATCH: "true",
      WAVE2_APPLY_SCOPE: opts.scope,
      ...(opts.censusDir ? { WAVE2_CENSUS_DIR: toShellPath(opts.censusDir) } : {}),
      WAVE2_POLL_SECS: "1",
    },
  });
  const m = /EXIT=(-?\d+)/.exec(out);
  const stderr = readFileSync(stderrFile, "utf8");
  return { rc: m ? Number(m[1]) : -1, out: out.replace(/EXIT=-?\d+\s*$/, "").trim(), stderr: stderr.trim() };
}

const CENSUS_LOG_OK = (slot: number, scope: string) =>
  [
    "Script confirmed: backend/scripts/rematch-sold-comps.cjs",
    `rematch-sold-comps  MODE=apply-improve  WRITE  slot ${slot}/32  scope=${scope}  budget 140m  limit none`,
    "  re-keyed   10",
    "  skipped     0",
    "  failed      0",
    "  not reached 0",
    "  intended 10 = written 10 + skipped 0 + failed 0 + not reached 0",
    "  all 7 canaries hold -- the shard may stand, and the next shard may be censused.",
    "finishLane: exiting code 0",
    "",
  ].join("\n");

describe("run_apply_slots dispatches and gates the requested scope end-to-end", () => {
  itShell("default behaviour is unchanged: scope=improve dispatches -f scope=improve and gates on counts.IMPROVE", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-scope-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const censusDir = join(dir, "census");
    mkdirSync(censusDir, { recursive: true });
    writeFileSync(join(censusDir, "census-slot-0.json"), JSON.stringify({ counts: { IMPROVE: 10 } }), "utf8");

    const { binDir, stateDir } = fakeGh(dir, {
      "0": [{ id: 70001, status: "completed", log: CENSUS_LOG_OK(0, "improve") }],
    });

    const res = runHarness({
      binDir,
      logdir,
      censusDir,
      scope: "improve",
      body: `run_apply_slots true 0; echo RC=$?`,
    });
    expect(res.out).toContain("RC=0");

    const calls = readDispatchLog(stateDir);
    expect(calls.length).toBe(1);
    expect(calls[0].flags.scope).toBe("improve");
    expect(calls[0].flags.mode).toBe("apply-improve");
  });

  itShell("scope=r26 dispatches -f scope=r26 and gates on counts.r26", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-scope-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const censusDir = join(dir, "census");
    mkdirSync(censusDir, { recursive: true });
    // IMPROVE is deliberately a very different number from r26 -- if the gate
    // ever fell back to reading counts.IMPROVE for an r26 run, this canary
    // (10 written, ceiling 10) would still pass by coincidence only if r26
    // also happened to be >= 10; make IMPROVE smaller than written so a
    // wrong-key read would FAIL the canary instead of silently passing.
    writeFileSync(join(censusDir, "census-slot-0.json"), JSON.stringify({ counts: { IMPROVE: 2, r26: 10 } }), "utf8");

    const { binDir, stateDir } = fakeGh(dir, {
      "0": [{ id: 70002, status: "completed", log: CENSUS_LOG_OK(0, "r26") }],
    });

    const res = runHarness({
      binDir,
      logdir,
      censusDir,
      scope: "r26",
      body: `run_apply_slots true 0; echo RC=$?`,
    });
    expect(res.out).toContain("RC=0");

    const calls = readDispatchLog(stateDir);
    expect(calls.length).toBe(1);
    expect(calls[0].flags.scope).toBe("r26");
  });

  itShell("a census artifact missing counts.r26 makes the r26 apply refuse rather than gate on the wrong number", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-scope-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const censusDir = join(dir, "census");
    mkdirSync(censusDir, { recursive: true });
    // Only IMPROVE was ever censused -- r26 counting did not exist yet.
    writeFileSync(join(censusDir, "census-slot-0.json"), JSON.stringify({ counts: { IMPROVE: 10 } }), "utf8");

    const { binDir } = fakeGh(dir, {
      "0": [{ id: 70003, status: "completed", log: CENSUS_LOG_OK(0, "r26") }],
    });

    const res = runHarnessCaptureAll({
      binDir,
      logdir,
      censusDir,
      scope: "r26",
      body: `run_apply_slots true 0; echo RC=$?`,
    });
    expect(res.out).toContain("RC=1");
    expect(res.stderr).toContain("no census artifact for scope=r26");
  });

  itShell("an unknown scope refuses before run_apply_slots ever dispatches", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-scope-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const { binDir, stateDir } = fakeGh(dir, {});

    const res = runHarness({
      binDir,
      logdir,
      scope: "bogus-scope",
      body: `run_apply_slots true 0; echo RC=$?`,
    });
    // The SCOPE validation happens at source time (top of the script), before
    // this harness snippet even runs -- so the die() fires while sourcing
    // cutDispatcher(fleetSrc), and run_apply_slots is never reached.
    expect(res.rc).toBe(2);
    expect(res.stderr).toContain("is not one of improve|r26|r27|r28");
    expect(readDispatchLog(stateDir).length).toBe(0);
  });

  itShell("two scopes' apply logs and in-flight tables never collide", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-scope-fixture-"));
    const logdir = join(dir, "logs");
    mkdirSync(logdir, { recursive: true });
    const censusDir = join(dir, "census");
    mkdirSync(censusDir, { recursive: true });
    writeFileSync(
      join(censusDir, "census-slot-0.json"),
      JSON.stringify({ counts: { IMPROVE: 10, r27: 10 } }),
      "utf8",
    );

    const { binDir: binImprove } = fakeGh(dir, {
      "0": [{ id: 70004, status: "completed", log: CENSUS_LOG_OK(0, "improve") }],
    });
    const improveRes = runHarness({
      binDir: binImprove,
      logdir,
      censusDir,
      scope: "improve",
      body: `run_apply_slots true 0 >/dev/null; echo RC=$?`,
    });
    expect(improveRes.out).toContain("RC=0");

    const { binDir: binR27 } = fakeGh(dir, {
      "0": [{ id: 70005, status: "completed", log: CENSUS_LOG_OK(0, "r27") }],
    });
    const r27Res = runHarness({
      binDir: binR27,
      logdir,
      censusDir,
      scope: "r27",
      body: `run_apply_slots true 0 >/dev/null; echo RC=$?`,
    });
    expect(r27Res.out).toContain("RC=0");

    // Both scopes' own slot-0 apply logs exist side by side under distinct
    // names -- neither run overwrote the other's.
    const improveLog = readFileSync(join(logdir, "apply-improve-slot-0.log"), "utf8");
    const r27Log = readFileSync(join(logdir, "apply-r27-slot-0.log"), "utf8");
    expect(improveLog).toContain("scope=improve");
    expect(r27Log).toContain("scope=r27");
  });
});
