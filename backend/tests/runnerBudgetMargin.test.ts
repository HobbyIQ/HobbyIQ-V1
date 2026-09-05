// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS — every budgeted lane, pinned.
//
// #1799 pinned ONE lane (retire-self-derived-identities) after run
// 33960686247 reconciled clean at 12:43:23 and was killed at 12:58:10 by
//
//   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
//
// The 887 seconds in between were an unbounded post-loop verify. The data was
// fine; the job was red; the operator read a working lane as a broken one.
//
// That pin was per-script and hard-coded to one file. This one is the census
// generalised: it enumerates EVERY script the backfill runner's dropdown can
// dispatch, keeps the ones that declare a time budget, and computes each
// lane's worst-case wall clock against the workflow's real `timeout-minutes`.
//
//   worst case = RUN_MINUTES + RESERVE_MS + VERIFY_MS + startup
//
// A lane with no unit reserve fails BY NAME. A lane with an unbounded
// post-loop aggregate and no verify cap fails BY NAME. A lane whose budget
// leaves under 15 minutes of margin fails BY NAME. The failure message names
// the script so the fix is obvious without reading this file.
//
// MUTATION-SENSITIVE BY CONSTRUCTION:
//   - raise any lane's RUN_MINUTES back to 140  -> margin < 15 -> red
//   - delete a lane's verify cap                -> unbounded-verify case -> red
//   - delete a lane's unit reserve              -> reserve case -> red
//   - shrink the workflow's timeout-minutes     -> every lane's margin drops
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const RUNNER = read(".github", "workflows", "backfill-runner.yml");

/** The step that actually runs the script. Its `timeout-minutes` is the
 *  ceiling every lane's budget has to live under — read from the workflow,
 *  never hard-coded here, so shrinking it turns this suite red. */
function stepCeilingMinutes(): number {
  const step = RUNNER.split(/^      - name: /m).find((s) => /^Run backfill \(/.test(s));
  expect(step, "the 'Run backfill' step must exist in backfill-runner.yml").toBeTruthy();
  const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(step as string);
  expect(m, "the 'Run backfill' step must declare timeout-minutes").toBeTruthy();
  return Number((m as RegExpExecArray)[1]);
}

/** Every script name the dropdown can dispatch. The whitelist IS the surface:
 *  a script nobody can dispatch cannot time a step out. */
function whitelistedScripts(): string[] {
  const blk = RUNNER.slice(RUNNER.indexOf("      script:"));
  const m = /options:\n((?:\s*(?:-|#).*\n)+)/.exec(blk);
  expect(m, "the script input must declare its options list").toBeTruthy();
  return (m as RegExpExecArray)[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

/** Measured startup: connection + the scope enumeration before the loop's t0.
 *  Run 33960686247: step start 10:27:57 -> loop t0 10:28:16. Rounded up. */
const STARTUP_MINUTES = 1;

/** The margin the rule requires between a lane's worst case and the ceiling. */
const REQUIRED_MARGIN_MINUTES = 15;

type Lane = {
  script: string;
  file: string;
  src: string;
  runMinutes: number;
  reserveMs: number | null;
  verifyMs: number | null;
  /** UNBOUNDED cross-partition aggregates — the shape that hung #1799.
   *
   *  NOT every `COUNT(1)` qualifies, and the distinction is the whole point.
   *  An aggregate filtered to ONE row's identity — `c.hobbyiqCardId = @s`,
   *  `STARTSWITH(c.id, @p)` inside the work loop — is an index-served point
   *  lookup costing milliseconds, and lanes run thousands of them by design.
   *  What killed run 33960686247 was the other kind: an aggregate over a
   *  whole sport or a whole container, run AFTER the loop, whose cost scales
   *  with the corpus rather than with the work just done. Only that kind is
   *  required to sit under a cap, because only that kind can outlive the
   *  step. Counting the cheap ones too would push every lane into a cap it
   *  does not need, and a pin that cries wolf gets deleted. */
  unboundedVerify: number;
  /** A bare `Date.now() - t0 > BUDGET` check, i.e. the loop-top defect. */
  bareCheck: boolean;
};

/** Every spelling of the budget in use across the whitelist. A lane that
 *  invents a new one is not silently skipped — `unparsed` below fails. */
const BUDGET_PATTERNS: RegExp[] = [
  /const RUN_MS = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\) \* 60_?000/,
  /const RUN_MINUTES = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\)/,
  /const RUN_MINUTES = Number\(arg\("[a-z-]+", *(?:process\.)?env\(?"?RUN_MINUTES"?,? *"?(\d+)"?\)?\)\)/,
  /const RUN_MINUTES = Number\(arg\("[a-z-]+", *process\.env\.RUN_MINUTES \?\? "(\d+)"\)\)/,
  /const RUN_MINUTES = Math\.max\(\d+, Number\(arg\("[a-z-]+", "(\d+)"\)\)\)/,
  /const BUDGET_MS = Number\(process\.env\.[A-Z_]+ \|\| (\d+) \* 60 \* 1000\)/,
  /runMinutes\((\d+)\)/,
  /minutes: (\d+)[,\s]/,
];

/** ms literal from a `const NAME = Number(process.env.X || <expr>)` default,
 *  where <expr> is a product of integer literals (`10 * 60 * 1000`). */
function msDefault(src: string, name: string): number | null {
  const re = new RegExp(
    `${name}\\s*=\\s*Number\\(process\\.env\\.[A-Z_]+ \\|\\| ([0-9]+(?:\\s*\\*\\s*[0-9]+)*)\\)`,
  );
  const m = re.exec(src);
  if (m) return m[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
  // The shared helper's call site: `budget({ ..., reserveMs: 90 * 1000 })`.
  const kw = name.replace(/_MS$/, "").toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
  const m2 = new RegExp(`${kw}Ms:\\s*([0-9]+(?:\\s*\\*\\s*[0-9]+)*)`).exec(src);
  if (m2) return m2[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
  return null;
}

/**
 * Count the aggregates whose cost scales with the CORPUS rather than with one
 * row — the shape that can still be running when the runner kills the step.
 *
 * An aggregate is bounded when every predicate it carries pins it to a single
 * identity: an equality or prefix on an id/slug field, bound to a parameter.
 * Anything else — a bare `${PRED}`, a CONTAINS/LOWER scan, a whole-sport
 * equality, a DISTINCT over a set — is unbounded for this purpose and has to
 * live under the cap.
 */
function countUnboundedVerifies(src: string): number {
  // POSITION IS THE DISTINCTION, not just cost. An expensive scan BEFORE the
  // loop — a scope guard that refuses a wrong dispatch, an estimate mode that
  // is the whole job — spends budget the loop then does not get, which the
  // reserve and the margin already cover. It cannot strand a reconciliation,
  // because there is nothing yet to reconcile.
  //
  // What killed run 33960686247 is the scan AFTER the loop: the counts have
  // printed, the reconcile has balanced, the writes are durable — and then an
  // unbounded aggregate holds the step open until the runner kills it, taking
  // the exit code and the operator's confidence down with it. Only a scan
  // positioned after the work has that failure mode, so only that one is
  // required to sit under a cap.
  let n = 0;
  for (const m of src.matchAll(/SELECT VALUE COUNT\([\s\S]{0,400}?(?=["`'])/g)) {
    const q = m[0];
    // Pinned to one row's identity: an index-served point lookup costing
    // milliseconds. Lanes run thousands of these inside the loop by design.
    const pinned =
      /\b(?:c\.hobbyiqCardId|c\.cardId|c\.id|c\.sourceExternalId)\s*(?:=|!=)\s*@/.test(q) ||
      /STARTSWITH\(\s*c\.(?:id|cardId|hobbyiqCardId)\s*,\s*@/.test(q);
    const widened = /CONTAINS\(|LOWER\(|DISTINCT|\$\{PRED\}|IS_DEFINED/.test(q);
    if (pinned && !widened) continue;
    if (!afterTheWork(src, m.index ?? 0)) continue;
    n++;
  }
  return n;
}

/** True when an offset sits after the point where the lane has already
 *  reported — i.e. after a reconcile/banner/AFTER line, which is exactly the
 *  window in which a hang costs a clean run its exit code. */
function afterTheWork(src: string, at: number): boolean {
  // Anchors are CALL sites, never declarations. `function reconcile(...)` is
  // usually declared near the top of a lane and called at the very bottom;
  // anchoring on the declaration would mark every in-loop helper below it as
  // post-loop and fail lanes whose scans are cheap point lookups (observed on
  // repair-bcp-misfiled-parallels: scans at 405/414, reconcile CALL at 608).
  const reported = [
    /reconciled: intended/,
    /(?<!function )\breconcile\(`/,
    /banner\(stopReason\)/,
    /\bAFTER\s+\$\{/,
    /VERIFY BY READ/,
  ];
  for (const re of reported) {
    const m = re.exec(src);
    if (m && m.index < at) return true;
  }
  return false;
}

const unparsed: string[] = [];

function loadLanes(): Lane[] {
  const lanes: Lane[] = [];
  for (const script of whitelistedScripts()) {
    const file = path.join("backend", "scripts", `${script}.cjs`);
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const src = read(file);
    if (!/RUN_MINUTES|BUDGET_MS/.test(src)) continue;

    let runMinutes: number | null = null;
    for (const re of BUDGET_PATTERNS) {
      const m = re.exec(src);
      if (m) { runMinutes = Number(m[1]); break; }
    }
    if (runMinutes === null) { unparsed.push(script); continue; }

    lanes.push({
      script, file, src, runMinutes,
      // A lane whose reserve is a FRACTION of its budget (census-unknown-setkey
      // sizes it as RUN_MINUTES * 6000, floored) states the floor as a literal
      // so the worst case stays computable without evaluating the expression.
      reserveMs:
        msDefault(src, "RESERVE_MS")
        ?? msDefault(src, "PRODUCT_RESERVE_MS")
        ?? msDefault(src, "RESERVE_FLOOR_MS"),
      verifyMs: msDefault(src, "VERIFY_MS"),
      unboundedVerify: countUnboundedVerifies(src),
      bareCheck: /Date\.now\(\)\s*-\s*\w+\s*>=?\s*(?:RUN_MS|BUDGET_MS)\s*[)\;]/.test(src),
    });
  }
  return lanes;
}

const CEILING = stepCeilingMinutes();
const LANES = loadLanes();

describe("every budgeted runner lane stops under the action ceiling", () => {
  it("the ceiling is read from the workflow, and it is the 150 the kill hit", () => {
    expect(CEILING).toBe(150);
  });

  it("the census found the budgeted lanes it is supposed to govern", () => {
    // A guard against the loader silently matching nothing and the whole
    // suite passing vacuously (feedback_retired_correction_verify_output_not_existence).
    expect(LANES.length).toBeGreaterThanOrEqual(60);
  });

  it("every budgeted lane's RUN_MINUTES is parseable — a new spelling is not a free pass", () => {
    expect(
      unparsed,
      `these lanes declare a budget this pin cannot read, so their margin is uncomputable: ${unparsed.join(", ")}`,
    ).toEqual([]);
  });

  // ── THE MARGIN, PER LANE, BY NAME ────────────────────────────────────────
  for (const lane of LANES) {
    describe(lane.script, () => {
      it("declares a unit reserve, so the budget stops BEFORE a unit, not after one", () => {
        expect(
          lane.reserveMs,
          `${lane.script} has no RESERVE_MS: its budget check admits one more unit of `
            + `unbounded size after expiry. Size a reserve to the lane's largest unit `
            + `and check it BEFORE each unit.`,
        ).not.toBeNull();
        expect(lane.reserveMs as number).toBeGreaterThan(0);
      });

      it("checks the clock before each unit, never with a bare over-budget test", () => {
        expect(
          lane.bareCheck,
          `${lane.script} still tests \`Date.now() - t0 > BUDGET\`. That is the loop-top `
            + `defect: it admits one whole extra unit past expiry.`,
        ).toBe(false);
      });

      it("bounds its post-loop verify, or reads nothing after the loop", () => {
        if (lane.unboundedVerify === 0) return; // nothing unbounded to cap
        expect(
          lane.verifyMs,
          `${lane.script} runs ${lane.unboundedVerify} UNBOUNDED cross-partition COUNT() aggregate(s) with `
            + `no VERIFY_MS cap. That is the exact shape that ran 887s and got run `
            + `33960686247 killed at the ceiling AFTER it had reconciled clean.`,
        ).not.toBeNull();
        expect(lane.verifyMs as number).toBeGreaterThan(0);
        expect(lane.src, `${lane.script} must report an unread count, never print it as zero`)
          .toMatch(/UNCONFIRMED \(verify cap\)/);
        expect(lane.src).toMatch(/UNREAD, not zero/);
      });

      it(`worst case leaves >= ${REQUIRED_MARGIN_MINUTES} minutes under the ${CEILING}m ceiling`, () => {
        const reserve = (lane.reserveMs ?? 0) / 60000;
        const verify = (lane.verifyMs ?? 0) / 60000;
        const worstCase = lane.runMinutes + reserve + verify + STARTUP_MINUTES;
        const margin = CEILING - worstCase;
        expect(
          margin,
          `${lane.script}: RUN_MINUTES=${lane.runMinutes} + ${reserve}m reserve + ${verify}m `
            + `verify + ${STARTUP_MINUTES}m startup = ${worstCase}m against a ${CEILING}m `
            + `ceiling leaves ${margin}m — need >= ${REQUIRED_MARGIN_MINUTES}.`,
        ).toBeGreaterThanOrEqual(REQUIRED_MARGIN_MINUTES);
      });
    });
  }

  it("the 140-minute default that leaves 10 minutes of margin is gone from every lane", () => {
    // The regression is the VALUE, so the pin is on the value. 140 + any
    // reserve + any verify does not fit under 150.
    const still140 = LANES.filter((l) => l.runMinutes >= 140).map((l) => l.script);
    expect(
      still140,
      `these lanes still budget >= 140 minutes under a ${CEILING}-minute ceiling: ${still140.join(", ")}`,
    ).toEqual([]);
  });
});

// ── THE BANNERS OPERATORS GATE ON ──────────────────────────────────────────
//
// CF-RELAUNCH-ONLY-ON-BUDGET (#1361): the workflow's self-relaunch steps grep
// the script's own stdout for a budget marker. The whole point of an earlier
// stop is that the lane RELAUNCHES and continues; a reworded marker silently
// ends the fan-out after one slice, which is a quieter version of the same
// bug. Changing a budget must never change the marker.
describe("the budget marker every relaunch greps for still prints verbatim", () => {
  const marker = /stopped at the .*budget/;

  for (const lane of LANES.filter((l) => /stopped at the/.test(l.src))) {
    it(`${lane.script} prints a marker the runner's grep matches`, () => {
      const lines = lane.src.split("\n").filter((l) => /stopped at the/.test(l));
      expect(lines.some((l) => marker.test(l)), `${lane.script}'s marker must match ${marker}`).toBe(true);
    });
  }

  it("the relaunch steps still grep for the marker they have always grepped for", () => {
    const greps = RUNNER.match(/grep -aqE "stopped at the [^"]*"/g) ?? [];
    expect(greps.length, "the marker-gated relaunch steps must exist").toBeGreaterThan(0);
    for (const g of greps) expect(g).toMatch(/stopped at the \.\*budget/);
  });
});
