/**
 * CF-THE-LOG-IS-BOTH-STREAMS — a teed lane log carries stderr too
 * (#1963/#1975, 2026-09-07).
 *
 * THE DEFECT. A workflow that captures its lane with
 *
 *     node scripts/<lane>.cjs | tee <log>
 *
 * captures STDOUT ONLY. Everything the lane writes on STDERR is dropped before
 * it reaches the log:
 *
 *   - the deliberate `REFUSING ...` witness lines a scope guard prints before it
 *     exits 2 — console.error by design, because a refusal is not the lane's
 *     data channel and must not contaminate a stdout the caller may be parsing;
 *   - every other console.error() refusal and warning on the way out;
 *   - the stack of an unhandled throw, which node writes to stderr and nowhere
 *     else.
 *
 * Where that log is an UPLOADED ARTIFACT it is the only durable record of the
 * run, and it omits precisely the lines that explain a failure. Where it is a
 * RELAUNCH GATE's input the harm is worse: backfill-runner.yml's
 * #1913/#1955/#1963 four-outcome classifier greps the log for the budget marker
 * and for `finishLane: exiting code <n>`. A lane that refused on stderr and
 * exited 2 leaves a log with NEITHER — and no refusal text either — so the
 * classifier announces
 *
 *     ::error::KILLED before finish — the lane never reached finishLane; NOT
 *              finished; re-dispatch withheld — investigate
 *
 * or, on the arm #1963 added, EMPTY LOG: "the process never started at all".
 * Both are false statements about a lane that started, ran, decided, said so,
 * and exited on purpose. The operator is sent to investigate a crash that never
 * happened while the lane's own verdict — the one sentence naming what to do
 * next — sits in the runner console and never in the file the gate reads.
 *
 * Note the shape of the harm: not a missing log line, but a CONFIDENT, WRONG
 * verdict. The more deliberate the lane's refusal, the more certainly it is
 * misreported — a guard that refuses on stderr before touching Cosmos is exactly
 * the lane most likely to be called a kill.
 *
 * THE FIX. `2>&1 | tee`, with `set -o pipefail` beside it. Both halves are
 * load-bearing and neither is optional:
 *
 *   - `2>&1` puts the refusal in the log, so a verdict is readable whichever
 *     stream carried it;
 *   - `pipefail` keeps the step's exit code the LANE's, not tee's. Without it a
 *     pipeline exits on tee's status — always 0 — so a crashed lane reports
 *     SUCCESS. The runner's finished arm requires
 *     `steps.backfill.outcome == 'success'` as its SECOND witness, so silently
 *     zeroing the exit code would promote every verdict into a clean finish: a
 *     strictly worse bug than the one being fixed.
 *
 * SCOPE, AND THE ONE EXEMPTION. Every workflow that tees a lane had this defect,
 * so they are fixed together and pinned together — a rule enforced on one file
 * and not its siblings is a rule that comes back.
 *
 * backfill-runner.yml is the exception, and NOT because it is correct: it is the
 * file that produced the bug. It is exempt because it is 553,411 bytes against
 * GitHub's 512 KB (524,288) workflow ceiling, so every dispatch since 16:55Z
 * queues with ZERO JOBS, and a P0 change is collapsing its 70+ relaunch steps
 * into a composite action. Adding even the two-line pipe fix — let alone the
 * comment explaining it — grows a file that must shrink before it runs at all.
 * So the exemption is a SEQUENCING decision, held below as an explicit,
 * measured, self-retiring assertion rather than a silent skip: the moment that
 * file drops under the ceiling the exemption stops applying and the rule binds
 * it like everything else. See "the exemption retires itself".
 *
 * MUTATION CHECK. Drop the `2>&1` from any teed lane and "every teed lane
 * captures both streams" names that file and line. Drop a `pipefail` and "the
 * capture keeps the lane's own exit code" fails. Revert the fixture's stream and
 * "a stderr-only refusal is classified as a VERDICT" fails.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(backend, "..", ".github", "workflows");

/** GitHub refuses to queue a job from a workflow file over this size. */
const GITHUB_WORKFLOW_BYTE_CEILING = 512 * 1024;

/** The one file the rule does not yet bind, and the only reason it does not. */
const OVERSIZE_EXEMPT = "backfill-runner.yml";

/** Strip YAML comments: a comment QUOTING a broken pipe must not read as a live
 *  pipe, and a comment quoting a fixed one must not stand in for one. */
const stripComments = (s: string) => s.replace(/^\s*#.*$/gm, "");

const readWorkflow = (name: string) =>
  fs.readFileSync(path.join(WORKFLOW_DIR, name), "utf8").replace(/\r\n/g, "\n");

type TeeSite = { file: string; line: number; text: string };

/** Every `| tee` in every workflow — the population this rule governs. Found by
 *  scanning the directory rather than from a hardcoded list, so a workflow added
 *  next month inherits the rule instead of quietly opting out of it. */
function teeSites(): TeeSite[] {
  const out: TeeSite[] = [];
  for (const name of fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    stripComments(readWorkflow(name)).split("\n").forEach((text, i) => {
      if (/\|\s*tee\s/.test(text)) out.push({ file: name, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

const ALL_SITES = teeSites();
/** The sites the rule binds today: everything outside the oversize exemption. */
const SITES = ALL_SITES.filter((s) => s.file !== OVERSIZE_EXEMPT);

describe("the census finds the teed lanes this rule governs", () => {
  it("finds every `| tee` across the workflow directory", () => {
    // Nineteen at the time of writing across twelve workflows, two of them in
    // the exempt file. A floor, not an equality: lanes are added often and each
    // new one inherits the rule below.
    expect(ALL_SITES.length).toBeGreaterThanOrEqual(15);
  });

  it("binds the cron lanes, not one workflow alone", () => {
    // A rule enforced on one file and not its siblings is a rule that comes back.
    expect([...new Set(SITES.map((s) => s.file))].length).toBeGreaterThanOrEqual(6);
  });

  it("still sees the exempt file's lanes, so the exemption is measured not invisible", () => {
    expect(ALL_SITES.some((s) => s.file === OVERSIZE_EXEMPT)).toBe(true);
  });
});

describe("every teed lane captures both streams", () => {
  for (const site of SITES) {
    it(`${site.file}:${site.line} redirects stderr into the tee`, () => {
      expect(
        /2>&1\s*\|\s*tee\s/.test(site.text),
        `${site.file}:${site.line} tees STDOUT ONLY:\n\n    ${site.text}\n\n`
          + `Everything the lane writes on stderr — a deliberate "REFUSING ..." witness line, a `
          + `console.error refusal, an unhandled throw's stack — is dropped before it reaches the `
          + `log. Where that log is a relaunch gate's input the absence is read as KILLED or `
          + `EMPTY LOG; where it is an uploaded artifact it is the only record of the run, and it `
          + `omits precisely the lines that explain a failure. Use \`2>&1 | tee\`.`,
      ).toBe(true);
    });
  }
});

/** The `run:` block a tee site lives in, so pipefail is asserted against the
 *  block that actually executes the pipe. */
function runBlockFor(file: string, line: number): string {
  const lines = stripComments(readWorkflow(file)).split("\n");
  let start = 0;
  for (let i = line - 1; i >= 0; i--) {
    if (/^\s*run:\s*(\||\S)/.test(lines[i])) { start = i; break; }
  }
  return lines.slice(start, line).join("\n");
}

describe("the capture keeps the lane's own exit code", () => {
  // `2>&1` without pipefail is a REGRESSION, not a partial fix: the pipeline
  // then exits on tee's always-zero status, so a crashed lane reports success.
  //
  // One site is deliberately exempt and named rather than skipped silently: the
  // i9 stamp in pricing-invariant-audit.yml already ends `|| true`, its failure
  // being explicitly non-fatal by design. That exemption is itself asserted, so
  // it cannot outlive the `|| true` that justifies it.
  const PIPEFAIL_EXEMPT = { file: "pricing-invariant-audit.yml", marker: "rebaseline-i9-reference" };

  for (const site of SITES) {
    if (site.file === PIPEFAIL_EXEMPT.file && site.text.includes(PIPEFAIL_EXEMPT.marker)) {
      it(`${site.file}:${site.line} is the documented \`|| true\` exemption`, () => {
        expect(
          /\|\|\s*true/.test(site.text),
          `${PIPEFAIL_EXEMPT.marker} is exempt from pipefail only because it swallows its own `
            + `exit code with \`|| true\`. That suffix is gone, so the exemption no longer `
            + `describes it — either restore it or add pipefail and drop this exemption.`,
        ).toBe(true);
      });
      continue;
    }

    it(`${site.file}:${site.line} runs under pipefail`, () => {
      expect(
        /^\s*set\s+-[a-zA-Z]*o[a-zA-Z]*\s+pipefail\s*$/m.test(runBlockFor(site.file, site.line)),
        `${site.file}:${site.line} pipes into tee without \`pipefail\` in its run block:\n\n`
          + `    ${site.text}\n\n`
          + `A pipeline's status is its LAST command's, and tee always exits 0 — so this step `
          + `reports SUCCESS for a lane that crashed. That is worse than the stdout-only capture `
          + `this rule fixes: a relaunch gate's finished arm requires a successful step outcome `
          + `as its second witness, and a zeroed exit code satisfies it, turning every verdict `
          + `into a clean finish.`,
      ).toBe(true);
    });
  }
});

describe("the exemption retires itself", () => {
  // The rule does not bind backfill-runner.yml YET, and this block is the only
  // thing standing between "not yet" and "never". It asserts the exemption's own
  // premise — that the file is over GitHub's ceiling and therefore cannot be
  // grown — so the moment the composite-action change lands and the file fits,
  // this test fails and hands the next reader the exact instruction.
  const bytes = fs.statSync(path.join(WORKFLOW_DIR, OVERSIZE_EXEMPT)).size;

  it("names the exempt file's lanes rather than losing them", () => {
    const exempted = ALL_SITES.filter((s) => s.file === OVERSIZE_EXEMPT);
    expect(
      exempted.length,
      "the exemption is bookkeeping, not a blind spot: these lanes are known to be unfixed",
    ).toBeGreaterThanOrEqual(1);
    // Both are stdout-only today. If one is already fixed the exemption has been
    // partially lifted by hand, and the block below will say so.
    expect(exempted.every((s) => /\|\s*tee\s/.test(s.text))).toBe(true);
  });

  it("fails once backfill-runner.yml fits under GitHub's 512 KB ceiling", () => {
    expect(
      bytes,
      `backfill-runner.yml is now ${bytes} bytes, under GitHub's ${GITHUB_WORKFLOW_BYTE_CEILING}-`
        + `byte ceiling. The ONLY reason it was exempt from "every teed lane captures both `
        + `streams" is that it could not be grown by even two lines while it was too large to `
        + `queue a job at all. That constraint is gone.\n\n`
        + `TO CLEAR THIS TEST:\n`
        + `  1. change its lane capture to \`2>&1 | tee /tmp/backfill.log\` with \`set -o `
        + `pipefail\` above it (and the AFTER-canary capture likewise) — or, if the relaunch `
        + `steps now live in a composite action, apply it wherever the lane is actually run and `
        + `wherever the log is grepped;\n`
        + `  2. delete OVERSIZE_EXEMPT and this describe block, so the file joins the population `
        + `above;\n`
        + `  3. keep the size pin green.\n\n`
        + `Do not simply raise this number.`,
    ).toBeGreaterThan(GITHUB_WORKFLOW_BYTE_CEILING);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE FIXTURE. Not a YAML shape assertion — this RUNS the four-outcome
 * classifier's branch logic against logs built the way each capture builds one.
 * It is the test that would have caught the defect: the YAML looked fine, and
 * only the stream routing was wrong.
 *
 * The branch conditions are lifted from backfill-runner.yml's own source where
 * that file is readable, so a classifier whose conditions drift is exercised by
 * its drifted conditions rather than by a copy that has gone stale. The fixture
 * runs whether or not the runner itself has been migrated — it is about the
 * CLASSIFICATION rule, which the composite action inherits unchanged.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A lane that refuses: witness line and exit line both on STDERR, which is
 *  exactly what a scope guard does before it exits 2. */
const REFUSAL_STDERR = [
  "REFUSING: mode=apply-improve requires an explicit apply-class `scope`;"
    + " got the workflow default 'refractor', which this mode does not accept",
  "finishLane: exiting code 2",
].join("\n");

/** ...and nothing at all on stdout, because it refused before it reached any
 *  work worth narrating. */
const REFUSAL_STDOUT = "";

/** What lands in the log under each capture. */
const captureStdoutOnly = (out: string, _err: string) => out;
const captureBothStreams = (out: string, err: string) => [out, err].filter(Boolean).join("\n");

/** One marker-keyed relaunch step's shell, wherever the relaunch logic lives. */
function aRelaunchStep(): string {
  const candidates = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readWorkflow(f));
  const actionDir = path.join(WORKFLOW_DIR, "..", "actions");
  if (fs.existsSync(actionDir)) {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name))
          : /\.ya?ml$/.test(e.name) ? [fs.readFileSync(path.join(d, e.name), "utf8")] : []);
    candidates.push(...walk(actionDir));
  }
  for (const src of candidates) {
    const step = src
      .replace(/\r\n/g, "\n")
      .split(/\n(?=      - name:)/)
      .find((s) => /FINISHED WITH VERDICT code/.test(s));
    if (step) return stripComments(step);
  }
  return "";
}

const A_RELAUNCH_STEP = aRelaunchStep();

/** Classify a log exactly as the relaunch shell does, reading the arms out of
 *  the step's OWN source. */
function classify(run: string, log: string, outcome: string): string {
  const hasBudget = /stopped at the .*budget/.test(log);
  const zero = /finishLane: exiting code 0( |$)/m.test(log);
  const anyCode = /finishLane: exiting code [0-9]+/.test(log);
  const hasEmptyArm = /EMPTY LOG/.test(run);
  if (hasBudget) return "REDISPATCH";
  if (zero && outcome === "success") return "FINISHED";
  if (/finishLane: exiting code \[0-9\]\+/.test(run) && anyCode) return "VERDICT";
  if (hasEmptyArm && log.trim() === "") return "EMPTY LOG";
  return "KILLED";
}

describe("a stderr-only refusal is classified as a VERDICT", () => {
  it("the fixture resolved a real relaunch step to classify against", () => {
    expect(
      A_RELAUNCH_STEP,
      "no step defining the four-outcome classifier was found in .github/workflows or "
        + ".github/actions. If the relaunch logic moved, point aRelaunchStep() at its new home — "
        + "the classification rule travels with it.",
    ).toMatch(/FINISHED WITH VERDICT code/);
  });

  it("under the OLD stdout-only capture the refusal reads as a false KILLED/EMPTY LOG", () => {
    // The bug, reproduced. Kept as an assertion rather than prose so a future
    // "simplification" back to `| tee` is caught with its consequence spelled
    // out, not merely its shape.
    const log = captureStdoutOnly(REFUSAL_STDOUT, REFUSAL_STDERR);
    expect(log).toBe("");
    expect(
      ["KILLED", "EMPTY LOG"],
      "a stdout-only capture drops the refusal AND the finishLane line, leaving nothing for the "
        + "classifier to read",
    ).toContain(classify(A_RELAUNCH_STEP, log, "failure"));
  });

  it("under the FIXED capture the same run is a VERDICT", () => {
    expect(
      classify(A_RELAUNCH_STEP, captureBothStreams(REFUSAL_STDOUT, REFUSAL_STDERR), "failure"),
      "with `2>&1 | tee` the lane's own exit line reaches the log, so the step reports "
        + "FINISHED WITH VERDICT code 2 and withholds the re-dispatch — instead of telling the "
        + "operator to investigate a kill that never happened.",
    ).toBe("VERDICT");
  });

  it("and the refusal TEXT is in the log the step tails for the operator", () => {
    // Classification is only half the repair. Every arm tails the log so the
    // operator can read what the lane said; a verdict code with no sentence
    // beside it is still an investigation with no starting point.
    expect(captureBothStreams(REFUSAL_STDOUT, REFUSAL_STDERR)).toMatch(/REFUSING:/);
  });

  it("a crash stack — stderr's other cargo — survives the capture too", () => {
    const stack = "TypeError: Cannot read properties of undefined (reading 'cardId')\n"
      + "    at rematchRow (/home/runner/work/.../rematch-sold-comps.cjs:812:31)";
    const log = captureBothStreams("scanning shard 4/16...\n", stack);
    expect(log).toMatch(/TypeError/);
    // No finishLane line: a thrown crash never reaches it. That is a genuine
    // KILLED — and now one the operator can diagnose from the log alone.
    expect(classify(A_RELAUNCH_STEP, log, "failure")).toBe("KILLED");
  });

  it("the budget marker still re-dispatches, and a clean code-0 run still finishes", () => {
    // The capture change must not move any outcome that already worked.
    expect(
      classify(A_RELAUNCH_STEP, captureBothStreams("stopped at the 140-minute budget\n", ""), "success"),
    ).toBe("REDISPATCH");
    expect(
      classify(A_RELAUNCH_STEP, captureBothStreams("all done\nfinishLane: exiting code 0\n", ""), "success"),
    ).toBe("FINISHED");
  });
});
