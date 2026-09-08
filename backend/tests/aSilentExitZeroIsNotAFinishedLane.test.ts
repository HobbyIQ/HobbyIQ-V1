// CF-A-SILENT-EXIT-ZERO-IS-NOT-A-FINISHED-LANE (2026-09-08).
//
// THE RUN. 34231217320 — retire-self-derived-identities, sport=football,
// slot 4/16, apply=true. Its teed /tmp/backfill.log ends here:
//
//   13:20:27  retire-self-derived-identities  sport=football  APPLY
//   13:20:27    sharding ON -- slot 4/16. ...
//   13:20:27    budget 110m loop + 10m unit reserve + 10m verify cap ...
//   13:21:03    1,434 (year, setKey) products in football
//   13:21:03    this run owns 85 products
//   (nothing)
//   13:21:40  step ends — "Run backfill (APPLY)"  outcome: SUCCESS
//
// No progress line, no `APPLIED` banner, no `RECONCILE`, no `VERIFY BY READ`,
// no `finishLane: exiting code`, and no `FATAL` from the lane's own `.catch`.
// The relaunch composite read no budget marker and no finishLane line and
// called it "KILLED before finish", which is what the four-outcome contract
// says it must. Both witnesses were wrong in opposite directions, because the
// process had neither crashed, nor been killed, nor finished: node EXITED 0
// with an EMPTY EVENT LOOP while `main()` was still pending.
//
// THE MECHANISM, which this suite reproduces from first principles below. A
// budgeted lane between its banner and its verify holds NO REF'D HANDLE of its
// own: `retry()` sleeps on unref'd timers deliberately (a retry nobody awaits
// must not hold the process), the budget's cap timer is armed only inside
// `capped()` — i.e. only during the post-loop verify — and the sole ref'd
// handles are the Cosmos SDK's sockets. When the SDK abandons a request
// without settling its promise, those sockets go, the loop is empty, and node
// exits 0 having run no `.then`, no `.catch` and no `process.on('exit')`.
//
// card_catalog's autoscale went 400,000 -> 40,000 RU/s on 2026-09-07, the day
// before this run, which is what turned a rare drop into a routine one. The
// throughput change is not the defect; the lane's inability to SAY ANYTHING
// about it is.
//
// TWO PROPERTIES ARE PINNED HERE, and they fail independently:
//
//   1. THE MECHANISM IS REAL and the keepalive closes it. A pending promise
//      plus only unref'd timers exits 0 in silence; the same program with the
//      budget's keepalive armed does not.
//   2. THE RETIRE LANE ARMS IT, and narrates its product loop, so a log can
//      never again dead-end at "this run owns N products".
//
// MUTATIONS THAT MUST TURN THIS FILE RED:
//   - unref the keepalive interval           -> test 1b exits early, silent
//   - drop `LANE_BUDGET.keepalive(...)`      -> test 2a fails
//   - drop the per-product narration         -> test 2b fails
//   - drop releaseKeepalive from finishLane  -> test 1c never exits
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const LIB_PATH = path.join(BACKEND, "scripts", "lib", "runner-budget.cjs");
const LIB = read("backend", "scripts", "lib", "runner-budget.cjs");
const LANE = read("backend", "scripts", "retire-self-derived-identities.cjs");

/** Run a throwaway script under the real node with a hard wall-clock kill.
 *  `timedOut` distinguishes "did not exit" from "exited", which is the whole
 *  distinction this file is about. */
function runNode(source: string, killMs = 20000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silent-exit-"));
  const file = path.join(dir, "probe.cjs");
  fs.writeFileSync(file, source);
  const r = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    timeout: killMs,
    killSignal: "SIGKILL",
    cwd: BACKEND,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
    timedOut: r.signal === "SIGKILL",
  };
}

const REQUIRE_LIB = `const { budget, finishLane } = require(${JSON.stringify(LIB_PATH)});`;

// ── 1. THE MECHANISM, AND THE HANDLE THAT CLOSES IT ────────────────────────
describe("a pending lane with no ref'd handle exits 0 in silence", () => {
  // 1a. THE BUG ITSELF, with no keepalive. This is the shape of run
  // 34231217320: work pending, only unref'd timers alive. It must exit 0 and
  // print NOTHING — if this ever stops being true the defect is gone from node
  // itself and the keepalive below is belt-and-braces rather than the fix.
  it("reproduces the run: exit 0, no output, no .then, no .catch", () => {
    const r = runNode([
      'const pending = new Promise(() => {});',
      '(async () => { await pending; })()',
      '  .then(() => console.log("finishLane: exiting code 0"))',
      '  .catch(() => console.log("FATAL"));',
      'process.on("exit", () => {});',
      'const t = setTimeout(() => {}, 60000); if (t.unref) t.unref();',
    ].join("\n"));
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
    // The silence is the defect. Not a FATAL, not a finishLane line: nothing.
    expect(r.stdout.trim()).toBe("");
    expect(r.stdout).not.toContain("finishLane");
    expect(r.stdout).not.toContain("FATAL");
  });

  // 1b. THE SAME PROGRAM WITH THE KEEPALIVE ARMED. It must NOT exit: the lane
  // stays alive to be stopped by its own budget or killed at the step ceiling
  // with a truthful verdict, which is the observable state every other gate in
  // this repo is built to read. Unref the interval and this test goes green
  // for the wrong reason — hence the assertion on stdout too, which an
  // unref'd (and therefore unfired) interval cannot satisfy.
  it("the keepalive holds the loop open, and says so, instead of exiting silently", () => {
    const r = runNode([
      'process.env.LANE_KEEPALIVE_MS = "300";',
      REQUIRE_LIB,
      'const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 1000 });',
      'b.keepalive("probe lane");',
      'const pending = new Promise(() => {});',
      '(async () => { await pending; })()',
      '  .then(() => console.log("finishLane: exiting code 0"))',
      '  .catch(() => console.log("FATAL"));',
      'const t = setTimeout(() => {}, 60000); if (t.unref) t.unref();',
    ].join("\n"), 6000);
    // It had to be killed: it did not silently exit.
    expect(r.timedOut).toBe(true);
    // And it was not silent while it waited — a heartbeat localises the wedge.
    expect(r.stdout).toMatch(/narrate: heartbeat 1 — probe lane alive at/);
  });

  // 1c. THE KEEPALIVE MUST NOT BECOME A NEW WAY TO HANG. finishLane releases
  // it before exiting, so a lane that IS done still exits promptly. Delete the
  // release from finishLane and this hangs until the kill.
  it("finishLane releases the keepalive, so a finished lane still exits", () => {
    const r = runNode([
      'process.env.LANE_KEEPALIVE_MS = "300";',
      REQUIRE_LIB,
      'const b = budget({ minutes: 110, reserveMs: 1000, verifyMs: 1000 });',
      'b.keepalive("probe lane");',
      '(async () => 0)().then(() => finishLane(0, { budget: b }));',
    ].join("\n"), 10000);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("finishLane: exiting code 0");
  });

  // The interval must be REF'D. An unref'd interval is the exact defect this
  // file exists for, and the source is where that intent is stated.
  it("the keepalive interval is never unref'd", () => {
    const block = LIB.slice(
      LIB.indexOf("const keepalive = (label)"),
      LIB.indexOf("const releaseKeepalive"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/unref\s*\(\s*\)/);
    expect(block).toContain("setInterval");
  });
});

// ── 2. THE RETIRE LANE ARMS IT AND NARRATES ITS LOOP ───────────────────────
describe("retire-self-derived-identities can no longer dead-end at its banner", () => {
  it("arms the keepalive before the product loop", () => {
    expect(LANE).toMatch(/LANE_BUDGET\.keepalive\(/);
    // Before the loop, not after it: a keepalive armed after the read that
    // dropped is a keepalive that was never alive when it mattered.
    expect(LANE.indexOf("LANE_BUDGET.keepalive("))
      .toBeLessThan(LANE.indexOf("for (const p of mine)"));
  });

  it("narrates every product it starts, so a wedge names a (year, setKey)", () => {
    expect(LANE).toContain("narrate(`product ${productsDone}/${mine.length}");
    expect(LANE).toContain("narrate(`product loop finished");
  });

  // THE NARRATIONS MUST STAY INVISIBLE TO THE RUNNER. The relaunch composite
  // greps `stopped at the .*budget`; the lane's own summary step greps the
  // anchored `^  retired \(twin\)` and `^  identityUnverified` count lines. A
  // narration that matched any of them would move a number an operator reads,
  // or re-dispatch a slot that never asked to continue.
  it("no narration can collide with a runner grep", () => {
    const added = LANE.split("\n").filter((l) => l.includes("narrate(`product"));
    expect(added.length).toBeGreaterThan(0);
    for (const line of added) {
      expect(line).not.toMatch(/stopped at the .*budget/);
      expect(line).not.toMatch(/^ {2}(retired \(twin\)|identityUnverified)/);
    }
    // The heartbeat carries the same `narrate:` prefix, for the same reason.
    // narrator() writes a line VERBATIM, so the prefix is the caller's to
    // state; a heartbeat without it would sit at column 0 in the tee'd log
    // where the runner's anchored greps can see it.
    expect(LIB).toContain("`narrate: heartbeat ${beats}");
  });
});
