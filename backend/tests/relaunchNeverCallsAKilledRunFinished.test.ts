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
 *   (a) marker present                          -> more work, re-dispatch;
 *   (b) no marker, `finishLane: exiting code 0` -> the lane exited itself, done;
 *   (c) neither                                 -> KILLED. Not finished. FAIL.
 *   (d) `finishLane: exiting code <non-zero>`   -> FINISHED WITH A VERDICT. FAIL.
 *
 * THE FOURTH OUTCOME (#1913's blind spot). #1913 wrote (b) as "finishLane
 * present AND the step succeeded", which is right about (b) and wrong about
 * everything else a finishLane line can say. `finishLane(code)` takes a code,
 * and the lanes use it deliberately: BACKOFF exits 5, a refusal exits 2,
 * VERIFY INCOMPLETE exits 6/7, a scan-phase stop exits 5. Every one of those is
 * a lane that ran to its own exit and DECLARED something. None of them is a
 * kill.
 *
 * On 2026-09-07 run 34135736122 (ingest-universe-driver, apply) printed
 *
 *     SYSTEMIC ABORT      the control page did not serve either -- the host is
 *                         refusing this client; retry after 30 minutes
 *     finishLane: exiting code 5
 *
 * -- the #1916 BACKOFF path, working exactly as designed -- and the relaunch
 * step announced
 *
 *     ##[error]KILLED before finish -- the lane never reached finishLane
 *       budget marker: absent    finishLane line: 1
 *
 * a message contradicted by the very line it had just counted. The operator is
 * told to investigate a kill that did not happen, and the true instruction --
 * wait 30 minutes, then re-dispatch -- is nowhere in the log.
 *
 * So the finished arm is narrowed to code 0, and (d) gets its own arm: it names
 * the code, quotes the lane's own last SYSTEMIC/ABORT/BACKING OFF/VERIFY line,
 * says the re-dispatch was WITHHELD, and still exits 1 so the chain stays red.
 * Red is correct for (d) -- the work did not finish -- but red for the right
 * reason, with the retry-after hint the BACKOFF case depends on.
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

      // #1913 read ANY finishLane code as finished. A lane that exits 5 on a
      // BACKOFF reached finishLane and is NOT done, so the finished arm has to
      // name the code it accepts.
      expect(
        elif,
        `${step.name}'s finished branch matches "finishLane: exiting code [0-9]+" -- ANY code. `
          + `finishLane(code) is how a lane DECLARES a verdict: BACKOFF exits 5, a refusal 2, `
          + `VERIFY INCOMPLETE 6/7. Only code 0 means done, so the finished arm must match `
          + `"exiting code 0" specifically.`,
      ).toMatch(/finishLane: exiting code 0/);

      expect(
        elif,
        `${step.name}'s finished branch must still be the one that says "finished within `
          + `budget" — the operator reads that line to mean the lane is done, and it must now `
          + `be earned rather than assumed.`,
      ).toMatch(/finished within budget/);
    });
  }
});

/** The verdict arm -- outcome (d) -- is the elif between the finished arm and
 *  the killed `else`: the one that tests finishLane WITHOUT requiring code 0. */
function verdictBranch(run: string): string {
  const i = run.indexOf("finishLane: exiting code 0");
  if (i < 0) return "";
  const from = run.indexOf("\n          elif", i);
  const to = run.lastIndexOf("\n          else\n");
  return from < 0 || to < from ? "" : run.slice(from, to);
}

describe("a finishLane with a NON-ZERO code is a verdict, never a kill", () => {
  for (const step of STEPS) {
    it(`${step.name} has the verdict arm`, () => {
      const verdict = verdictBranch(stripComments(step.run));
      expect(
        verdict,
        `${step.name} has no arm between "finished" and "KILLED". #1913 left only three, so a `
          + `lane that reached finishLane and exited NON-ZERO -- a BACKOFF (5), a refusal (2), `
          + `a VERIFY INCOMPLETE (6/7) -- fell through to the killed branch and was reported as `
          + `"KILLED before finish ... the lane never reached finishLane", directly contradicted `
          + `by the "finishLane line: 1" the same message printed. That is run 34135736122.`,
      ).toMatch(/finishLane: exiting code \[0-9\]\+/);

      expect(
        /FINISHED WITH VERDICT code/.test(verdict),
        `${step.name}'s verdict arm must SAY the lane finished with a verdict and name the code. `
          + `"KILLED" is a false statement about a lane that printed its own exit line.`,
      ).toBe(true);
    });

    it(`${step.name} quotes the lane's own verdict line and withholds the re-dispatch`, () => {
      const verdict = verdictBranch(stripComments(step.run));
      // The operator's next action lives in the lane's own words -- "retry after
      // 30 minutes" for a BACKOFF, "what was not confirmed" for a VERIFY.
      expect(
        verdict,
        `${step.name}'s verdict arm must quote the last SYSTEMIC/ABORT/BACKING OFF/VERIFY line `
          + `from the log. A code alone does not tell the operator what to do next.`,
      ).toMatch(/SYSTEMIC\|ABORT\|BACKING OFF\|VERIFY INCOMPLETE/);

      expect(
        /re-dispatch withheld/.test(verdict),
        `${step.name}'s verdict arm must say the re-dispatch was WITHHELD: a BACKOFF means the `
          + `host is refusing this client, and an immediate relaunch walks straight back into it.`,
      ).toBe(true);

      expect(
        /gh workflow run/.test(verdict),
        `${step.name} re-dispatches from its verdict arm. A verdict is not a budget stop.`,
      ).toBe(false);
    });

    it(`${step.name} still FAILS the job on a verdict, so the chain sees red`, () => {
      const verdict = verdictBranch(stripComments(step.run));
      expect(
        /\n\s*exit 1\b/.test(verdict),
        `${step.name}'s verdict arm does not exit non-zero. The work did NOT finish, so the job `
          + `must still be red -- the fix is to the message, never to the conclusion.`,
      ).toBe(true);
      expect(
        /::error::/.test(verdict),
        `${step.name}'s verdict arm must be ::error::, matching the red conclusion it forces.`,
      ).toBe(true);
    });

    it(`${step.name} prints the retry-after hint on the BACKOFF code`, () => {
      const verdict = verdictBranch(stripComments(step.run));
      expect(
        verdict,
        `${step.name} must single out code 5 -- the BACKOFF exit -- with the retry-after hint. `
          + `"Wait, then re-dispatch" is the whole instruction the #1916 path is trying to give, `
          + `and #1913 replaced it with "investigate a kill".`,
      ).toMatch(/RC" = "5"/);
    });
  }
});

/** THE FIXTURE. The real tail of run 34135736122's log, and the classification
 *  every step's shell must reach on it. This is the test that would have caught
 *  #1913: it does not read the YAML, it RUNS the branch logic. */
const INCIDENT_LOG = [
  "  SYSTEMIC ABORT      the control page did not serve either — the host is refusing"
    + " this client; retry after 30 minutes",
  "finishLane: exiting code 5",
  "",
].join("\n");

/** Classify a log exactly as the step's shell does, from the step's OWN source:
 *  the four tests are lifted out of the YAML rather than restated here, so a
 *  step whose conditions drift is classified by its drifted conditions. */
function classify(run: string, log: string, outcome: string): string {
  const hasBudget = /stopped at the .*budget/.test(log);
  const finishedArm = /elif grep -aqE "finishLane: exiting code 0\( \|\$\)"/.test(run);
  const zero = /finishLane: exiting code 0( |$)/m.test(log);
  const anyCode = /finishLane: exiting code [0-9]+/.test(log);
  if (hasBudget) return "REDISPATCH";
  if (finishedArm ? zero && outcome === "success" : anyCode && outcome === "success") {
    return "FINISHED";
  }
  if (/elif grep -aqE "finishLane: exiting code \[0-9\]\+" \/tmp\/backfill\.log; then/.test(run)
      && anyCode) {
    return "VERDICT";
  }
  return "KILLED";
}

describe("the incident log classifies as a verdict, in every step", () => {
  for (const step of STEPS) {
    it(`${step.name} calls run 34135736122's log a VERDICT, not KILLED`, () => {
      expect(
        classify(stripComments(step.run), INCIDENT_LOG, "failure"),
        `${step.name} classifies a log ending "finishLane: exiting code 5" as KILLED. The lane `
          + `reached finishLane and exited on purpose with the #1916 BACKOFF verdict; calling `
          + `that a kill tells the operator to investigate a crash that never happened.`,
      ).toBe("VERDICT");
    });

    it(`${step.name} still calls a clean code-0 log FINISHED`, () => {
      expect(
        classify(stripComments(step.run), "all done\nfinishLane: exiting code 0\n", "success"),
        `${step.name} broke outcome (b) while adding (d): a lane that exited 0 on a successful `
          + `step is finished, and must not be re-reported as a verdict.`,
      ).toBe("FINISHED");
    });

    it(`${step.name} still calls a witness-less log KILLED`, () => {
      expect(
        classify(stripComments(step.run), "working...\n", "failure"),
        `${step.name} lost outcome (c): a log with neither the budget marker nor a finishLane `
          + `line is a KILL, and #1906 exists because it was being called finished.`,
      ).toBe("KILLED");
    });

    it(`${step.name} still re-dispatches on the budget marker`, () => {
      expect(
        classify(stripComments(step.run), "stopped at the 140-minute budget\n", "success"),
        `${step.name} lost outcome (a) -- the budget stop must still continue the fan-out.`,
      ).toBe("REDISPATCH");
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
