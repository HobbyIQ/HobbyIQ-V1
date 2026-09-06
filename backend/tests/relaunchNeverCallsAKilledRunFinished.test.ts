/**
 * CF-A-KILLED-RUN-IS-NOT-A-FINISHED-RUN — the third outcome, pinned (#1906).
 *
 * THE RUN THAT WROTE THIS FILE. Ten APPLY shards of
 * retire-self-derived-identities were dispatched. Every one of them was KILLED
 * at the step's 150-minute ceiling:
 *
 *     ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
 *
 * A killed step prints nothing more. So its log carried NEITHER
 * `stopped at the 140-minute budget` NOR `finishLane: exiting code 0`. And the
 * relaunch step asked exactly ONE question —
 *
 *     if grep -aqE "stopped at the .*budget" /tmp/backfill.log; then  re-dispatch
 *     else                                                           "finished within budget"
 *
 * — so all ten announced
 *
 *     ::notice::… finished within budget (retired=…) — done, no re-dispatch.
 *
 * and the fan-out stopped. Ten lanes' worth of work half done, ten runs green,
 * and a completion notice on every one of them. `!cancelled()` is what makes
 * this reachable: it is TRUE after a step times out — deliberately, so a
 * budget-stopped step can still re-dispatch — which means the relaunch step
 * runs after a KILL too, and the `else` was the only branch left to catch it.
 *
 * THE RULE. Absence of the budget marker is not evidence of completion. It is
 * evidence of NOT-BUDGET, and not-budget splits two ways:
 *
 *   (a) marker present                        -> more work, re-dispatch;
 *   (b) no marker, `finishLane: exiting code` -> the lane exited itself, done;
 *   (c) neither, or the step did not succeed  -> KILLED. Not finished. FAIL.
 *
 * (b) is readable off the log because #1809/#1815 made `finishLane()` the
 * single exit path of every budgeted lane, and it writes that line with
 * `writeSync` — the operator's proof that the process ended on purpose. The
 * runner tees only STDOUT into /tmp/backfill.log, and no lane reachable from
 * these relaunch steps passes `narrateTo: "stderr"`, so the line lands in the
 * file the step greps. laneExitsWhenWorkIsDone pins the half of that contract
 * that lives in the scripts; this file pins the half that reads it, including
 * the two ways the witness could go missing.
 *
 * (c) FAILS rather than re-dispatching. A lane that never reached finishLane
 * died for an unknown reason with an unknown amount left; a blind re-dispatch
 * would send a fresh runner at a failure it may simply repeat. The job's
 * conclusion must read `failure` so the kill is visible, never a notice of
 * completion.
 *
 * MUTATION CHECK. Drop the killed branch from any one step — i.e. restore the
 * old two-branch `else echo "…finished within budget…"` — and
 * "every marker-keyed relaunch step handles the killed case" names that step.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_PATH = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
const RUNNER = fs.readFileSync(RUNNER_PATH, "utf8").replace(/\r\n/g, "\n");

const BUDGET_MARKER = /stopped at the \.\*budget/;
/** The line finishLane() writes with writeSync just before process.exit. */
const FINISH_LANE = /finishLane: exiting code/;

type Step = { name: string; src: string; run: string; gate: string; scripts: string[] };

/** Strip YAML comments so a comment QUOTING a branch cannot stand in for one.
 *  D18 learned this the hard way against the marker gate itself. */
const stripComments = (s: string) => s.replace(/^\s*#.*$/gm, "");

/** Every runner step that re-dispatches this workflow when the budget marker
 *  is in the log — the population this rule governs. The three lanes that
 *  decide completion some other way (a Cosmos probe, a next-start date,
 *  RELAUNCH_NEEDED) are deliberately NOT here: each reads a positive signal of
 *  work REMAINING rather than inferring completion from an absent marker. */
function markerRelaunchSteps(): Step[] {
  return RUNNER.split(/\n(?=      - name:)/)
    .filter((s) => /gh workflow run backfill-runner\.yml/.test(s))
    .map((s) => ({
      name: /- name:\s*(.*)/.exec(s)?.[1]?.trim() ?? "?",
      src: s,
      run: s.slice(s.indexOf("run: |")),
      gate: /^\s*if:\s*(.*)$/m.exec(s)?.[1]?.trim() ?? "",
      scripts: [...s.matchAll(/inputs\.script == '([^']+)'/g)].map((m) => m[1]),
    }))
    .filter((s) => BUDGET_MARKER.test(stripComments(s.run)));
}

const STEPS = markerRelaunchSteps();
const LANES = [...new Set(STEPS.flatMap((s) => s.scripts))];

/** The final `else` arm — outcome (c) — from the LAST `else` of the relaunch's
 *  own if/elif/else through its closing `fi`. Anchored on `else` rather than on
 *  the message, because the `::error::` that makes the job red is on the SAME
 *  line as the message and a slice starting at the text would cut it off. */
function killedBranch(run: string): string {
  const i = run.lastIndexOf("\n          else\n");
  return i < 0 ? "" : run.slice(i);
}

describe("the census finds the steps this rule governs", () => {
  it("parses the runner's marker-keyed relaunch steps", () => {
    // Sixty-three at the time of writing. A floor, not an equality: lanes are
    // added often, and every new one inherits the rule below.
    expect(STEPS.length).toBeGreaterThanOrEqual(60);
  });

  it("the lane that produced the bug is one of them", () => {
    expect(LANES).toContain("retire-self-derived-identities");
  });

  it("every one of them runs after a kill — which is what makes the bug reachable", () => {
    const notAfterKill = STEPS.filter((s) => !/!cancelled\(\)/.test(s.gate));
    expect(
      notAfterKill.map((s) => s.name),
      "!cancelled() is TRUE after a timeout, so these steps execute on a killed run too",
    ).toEqual([]);
  });
});

describe("every marker-keyed relaunch step handles the killed case", () => {
  for (const step of STEPS) {
    it(`${step.name} distinguishes KILLED from finished`, () => {
      const run = stripComments(step.run);

      expect(
        FINISH_LANE.test(run),
        `${step.name} never looks for "finishLane: exiting code". Without it, "no budget `
          + `marker" is read as "finished" — and a step KILLED at the 150-minute ceiling `
          + `prints neither, so the kill is announced as a clean finish. That is #1906: ten `
          + `killed APPLY shards of retire-self-derived-identities, all ten reported `
          + `"finished within budget", the fan-out silently stopped.`,
      ).toBe(true);

      expect(
        /KILLED before finish/.test(run),
        `${step.name} has no killed branch. The three outcomes are (a) marker -> re-dispatch, `
          + `(b) finishLane line -> done, (c) NEITHER -> killed. Without (c) the step still `
          + `defaults an unexplained log to "done".`,
      ).toBe(true);

      expect(
        /re-dispatch withheld/.test(run),
        `${step.name} must say the re-dispatch was WITHHELD. A lane that never reached `
          + `finishLane died for an unknown reason with an unknown amount left; a blind `
          + `re-dispatch sends a fresh runner at a failure it may simply repeat.`,
      ).toBe(true);
    });

    it(`${step.name} FAILS the job when the lane was killed`, () => {
      const run = stripComments(step.run);
      const killed = killedBranch(run);
      expect(
        /\n\s*exit 1\b/.test(killed),
        `${step.name} prints the killed message but does not exit non-zero, so the job still `
          + `concludes success — a green run carrying a kill is the defect, not the message.`,
      ).toBe(true);
      expect(
        /::error::/.test(killed),
        `${step.name} must raise the killed case as ::error::, not ::notice:: or ::warning:: — `
          + `it is the reason the job is red.`,
      ).toBe(true);
    });

    it(`${step.name} still re-dispatches on the budget marker, and ONLY there`, () => {
      const run = stripComments(step.run);
      // Outcome (a) is unchanged...
      const marker = /if grep -aqE "stopped at the \.\*budget"[\s\S]*?\n\s*elif\b/.exec(run)?.[0] ?? "";
      expect(
        marker,
        `${step.name}'s budget-marker branch must still be the branch that re-dispatches`,
      ).toMatch(/gh workflow run backfill-runner\.yml/);

      // ...and the killed branch must not have become a second one.
      const killed = killedBranch(run);
      expect(
        /gh workflow run/.test(killed),
        `${step.name} re-dispatches from its killed branch. A kill is not a budget stop: it `
          + `withholds the re-dispatch and fails.`,
      ).toBe(false);
    });
  }
});

describe("the finished branch is gated on BOTH witnesses", () => {
  for (const step of STEPS) {
    it(`${step.name} calls it finished only on finishLane AND a successful step`, () => {
      const run = stripComments(step.run);
      const elif = /\n\s*elif\b[\s\S]*?\n\s*else\b/.exec(run)?.[0] ?? "";
      expect(
        elif,
        `${step.name} has no elif branch between the marker test and the killed one`,
      ).toMatch(FINISH_LANE);

      // A log can be truncated, and a lane can print finishLane and still have
      // the step fail afterwards. The step's own outcome is the second witness.
      expect(
        elif,
        `${step.name} decides on the log alone. The finished branch must also require `
          + `steps.backfill.outcome == 'success', or a step that printed finishLane and then `
          + `failed is still called finished.`,
      ).toMatch(/steps\.backfill\.outcome/);

      expect(
        elif,
        `${step.name}'s finished branch must still be the one that says "finished within `
          + `budget" — the operator reads that line to mean the lane is done, and it must now `
          + `be earned rather than assumed.`,
      ).toMatch(/finished within budget/);
    });
  }
});

describe("the backfill step the relaunch reads is the one with the ceiling", () => {
  const step = RUNNER.split(/^      - name: /m).find((s) => /^Run backfill \(/.test(s)) ?? "";

  it("carries id: backfill, so steps.backfill.outcome resolves", () => {
    expect(step, "the relaunch steps read steps.backfill.outcome by this id")
      .toMatch(/^\s*id:\s*backfill\s*$/m);
  });

  it("has the 150-minute ceiling that produced the kills", () => {
    expect(/^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(step)?.[1]).toBe("150");
  });

  it("tees the lane's STDOUT into the log the relaunch greps", () => {
    // The finishLane line is only a usable witness if it lands in this file.
    expect(step).toMatch(/tee \/tmp\/backfill\.log/);
  });
});

describe("finishLane really prints the line the relaunch now depends on", () => {
  const LIB = fs.readFileSync(path.join(backend, "scripts", "lib", "runner-budget.cjs"), "utf8");
  const laneFiles = LANES
    .map((name) => ({ name, file: path.join(backend, "scripts", `${name}.cjs`) }))
    .filter(({ file }) => fs.existsSync(file));

  it("writes `finishLane: exiting code <n>` immediately before exiting", () => {
    const fn = /async function finishLane\([\s\S]*?\n\}/.exec(LIB)?.[0] ?? "";
    expect(fn).toMatch(/finishLane: exiting code \$\{code\}/);
    expect(fn.indexOf("finishLane: exiting code")).toBeLessThan(fn.indexOf("process.exit(code)"));
  });

  it("the census resolved the lane files it is asserting about", () => {
    expect(laneFiles.length).toBeGreaterThanOrEqual(60);
  });

  it("every lane a marker-relaunch step fires for routes its ending through finishLane", () => {
    // If a lane could finish WITHOUT printing the line, its clean run would be
    // misread as a kill — the opposite false verdict, and just as damaging.
    const missing = laneFiles
      .filter(({ file }) => !/finishLane\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map(({ name }) => name);
    expect(
      missing,
      `these lanes never call finishLane(), so a CLEAN run of theirs prints no exit line and `
        + `the relaunch step would now call it KILLED:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no such lane narrates its exit line to stderr, which the runner does not tee", () => {
    // `narrateTo: "stderr"` is legitimate for a lane whose stdout is a data
    // channel — but the runner tees stdout only, so such a lane's exit line
    // would never reach /tmp/backfill.log.
    const hidden = laneFiles
      .filter(({ file }) => /narrateTo/.test(fs.readFileSync(file, "utf8")))
      .map(({ name }) => name);
    expect(
      hidden,
      `these lanes narrate finishLane's output to a caller-chosen fd. If that fd is stderr the `
        + `exit line never reaches /tmp/backfill.log and every clean run reads as KILLED:\n  `
        + `${hidden.join("\n  ")}`,
    ).toEqual([]);
  });
});
