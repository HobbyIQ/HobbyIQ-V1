/**
 * CF-AN-EMPTY-LOG-IS-NOT-A-BUDGET-KILL (2026-09-07) -- the startup-narration
 * pin, and the relaunch-forwarding fix that made it necessary.
 *
 * WHAT HAPPENED. 19 of 121 rematch-sold-comps runner runs (15.7%) ended in
 * #1913's KILLED branch with an EMPTY /tmp/backfill.log. That branch's banner
 * says "KILLED before finish ... the lane never reached finishLane", which an
 * operator reads as a kill at the 150-minute ceiling -- work half done, rows
 * written, a slot to resume. Every one of those runs actually died in 55-70
 * SECONDS, at the first env check, having read no rows and written nothing.
 *
 * TWO DEFECTS, ONE SYMPTOM.
 *
 * 1. THE CAUSE. The rematch self-relaunch re-dispatched with `mode`, `slot`,
 *    `slots`, `years`, `limit` and `concurrency` -- but NOT `scope`. For
 *    MODE=apply-improve `scope` is the APPLY CLASS SCOPE and is REQUIRED, so
 *    the relaunch inherited the workflow default 'refractor', which that mode
 *    refuses by design. The chain re-dispatched itself into a guaranteed
 *    exit 2, eighteen slots deep.
 *
 * 2. WHY IT WAS INVISIBLE. The runner pipes the lane through
 *    `tee /tmp/backfill.log`, and `tee` sees STDOUT ONLY. Every startup
 *    refusal was `console.error` -- STDERR -- fired BEFORE the banner, which is
 *    the lane's first stdout write. So the refusal wrote an EMPTY log: exactly
 *    the state the KILLED branch reads as a kill.
 *
 * THE PIN. The lane's first stdout line is a SOURCE LITERAL printed before any
 * require, so no failing import, missing dist/, or OOM at module load can
 * suppress it. An empty backfill.log is no longer reachable from this lane.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..");
const runner = readFileSync(join(repoRoot, ".github", "workflows", "backfill-runner.yml"), "utf8");
const script = readFileSync(join(__dirname, "..", "scripts", "rematch-sold-comps.cjs"), "utf8");

describe("the lane narrates its own start before it can fail", () => {
  it("prints its STARTUP line before ANY require", () => {
    // The literal must sit above the first `require(` in the file. If a require
    // ever moves above it, a module-load failure goes back to writing an empty
    // log and the KILLED branch goes back to implying a budget kill.
    const startupAt = script.indexOf('console.log("rematch-sold-comps: STARTUP ok');
    const firstRequireAt = script.indexOf('require("path")');
    expect(startupAt).toBeGreaterThan(-1);
    expect(firstRequireAt).toBeGreaterThan(-1);
    expect(startupAt).toBeLessThan(firstRequireAt);
  });

  it("the STARTUP line is a source literal, not built from anything that can throw", () => {
    // No template interpolation of module state, no env read, no function call
    // other than process.pid -- the point is that nothing above it can fail.
    const line = script
      .split("\n")
      .find((l) => l.includes('"rematch-sold-comps: STARTUP ok'));
    expect(line).toBeTruthy();
    expect(line).toContain("console.log(");
    expect(line).not.toContain("process.env");
  });

  it("refusals reach STDOUT, because `tee` cannot see stderr", () => {
    // refuse() writes the SAME text to both streams. stderr keeps the Actions
    // red annotation; stdout puts it in the log the KILLED branch greps.
    expect(script).toContain("function refuse(phase, lines, code = 2) {");
    const body = script.slice(script.indexOf("function refuse(phase"));
    const end = body.indexOf("\n}\n");
    const fn = body.slice(0, end);
    expect(fn).toContain("console.error(l);");
    expect(fn).toContain("console.log(l);");
    // The exit code is the CALLER's: 2 for a refused input, 1 for a missing
    // COSMOS_CONNECTION_STRING (the house convention every script here keeps).
    expect(fn).toContain("process.exit(code)");
    expect(script).toContain('refuse("cosmos-env", ["COSMOS_CONNECTION_STRING not set"], 1)');
  });

  it("every startup refusal goes through refuse(), so none of them is stderr-only", () => {
    // A bare `console.error("FATAL...")` + exit is the shape that caused this
    // incident. There must be none left in the file.
    expect(script).not.toMatch(/console\.error\(`FATAL/);
    // The one remaining `console.error("FATAL:"` is the TOP-LEVEL CRASH
    // handler, which is a different case from a startup refusal -- but it had
    // the same blindness, so it mirrors to stdout too and finishLane(3) still
    // writes a real finish witness after it.
    const crash = script.slice(script.indexOf('.catch(async (e) =>'));
    expect(crash).toContain("console.error(msg);");
    expect(crash).toContain("console.log(msg);");
    // and the phases we know about are all named
    for (const phase of ["mode", "class-scope", "slot-range", "shard-table", "shard-units", "cosmos-env"]) {
      // `refuse(` may wrap its arguments across lines, so match across whitespace.
      expect(script).toMatch(new RegExp("refuse\\(\\s*\"" + phase + "\""));
    }
  });

  it("emits a machine-readable STARTUP REFUSED marker the runner can grep", () => {
    expect(script).toContain("rematch-sold-comps: STARTUP REFUSED at phase=");
  });
});

describe("the self-relaunch forwards the inputs the lane requires", () => {
  const relaunch = (() => {
    const at = runner.indexOf("Self-relaunch rematch-sold-comps until the shard is finished");
    expect(at).toBeGreaterThan(-1);
    // the dispatch line lives inside this step, before the next step begins
    const rest = runner.slice(at);
    const line = rest.split("\n").find((l) => l.includes("gh workflow run") && l.includes("script=rematch-sold-comps"));
    return line ?? "";
  })();

  it("forwards `scope` -- the input whose absence caused the 18 dead slots", () => {
    // THE FIX. Without this the relaunch inherits default 'refractor' and
    // MODE=apply-improve refuses it at exit 2, having done no work.
    expect(relaunch).toContain('-f scope="${{ inputs.scope }}"');
  });

  it("forwards the in-slot row filters, so a continuation is the same run", () => {
    expect(relaunch).toContain('-f sports="${{ inputs.sports }}"');
    expect(relaunch).toContain('-f setkey_like="${{ inputs.setkey_like }}"');
  });

  it("still forwards the shard identity it always did", () => {
    for (const f of ["mode", "concurrency", "slot", "slots", "years", "limit"]) {
      expect(relaunch).toContain(`-f ${f}="\${{ inputs.${f} }}"`);
    }
  });
});

describe("the KILLED branch tells a startup failure from a budget kill", () => {
  const branch = (() => {
    const at = runner.indexOf("Self-relaunch rematch-sold-comps until the shard is finished");
    const rest = runner.slice(at);
    return rest.slice(0, rest.indexOf("\n      - name:"));
  })();

  it("reads the STARTUP REFUSED marker and says the slot is UNSTARTED", () => {
    expect(branch).toContain('grep -aq "rematch-sold-comps: STARTUP REFUSED"');
    expect(branch).toContain("STARTUP REFUSED");
    expect(branch).toMatch(/NOT a budget kill/);
  });

  it("treats a genuinely empty log as its own, now-unreachable-from-this-lane case", () => {
    expect(branch).toContain('[ ! -s /tmp/backfill.log ]');
    expect(branch).toContain("EMPTY LOG");
  });

  it("names the died-during-module-load case between STARTUP ok and the banner", () => {
    expect(branch).toContain('grep -aq "rematch-sold-comps: STARTUP ok"');
    expect(branch).toContain("DIED DURING STARTUP");
  });

  it("keeps the real budget-kill wording for the case that is actually a kill", () => {
    expect(branch).toContain("KILLED before finish");
    // and the three-way outcome logic above it is untouched
    expect(branch).toContain('stopped at the .*budget');
    expect(branch).toContain("finishLane: exiting code");
  });
});
