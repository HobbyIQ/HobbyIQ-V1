/**
 * CF-A-CONST-IS-NOT-A-HOISTED-FUNCTION — every budgeted lane's module scope,
 * EVALUATED, not merely parsed.
 *
 * THE INCIDENT. `.github/workflows/ch-fanout-to-sold-comps.yml` failed every
 * night from 2026-09-06 (run 34200832460, 09-08 07:44). The script died on its
 * very first executed statement:
 *
 *   ReferenceError: Cannot access 'budget' before initialization
 *     const CLOCK = budget({ minutes: RUN_MINUTES, ... });
 *
 * The runner-budget refactor (#1947/#1951/#1970/#1975) left
 * `const { budget, finishLane } = require(".../runner-budget.cjs")` FOURTEEN
 * LINES BELOW that call. A `const` is in its temporal dead zone until its own
 * line runs, so the lane threw before printing a banner, a budget marker or
 * anything `finishLane` would have said. The run read as a bare red X.
 *
 * THE COST. sold_comps took 42k `source=cardhedge` rows for sold-day 09-07 and
 * 4 for 09-08, against a normal 75–90k/day.
 *
 * WHY THIS TEST EVALUATES INSTEAD OF PARSING. A TDZ is not a syntax error.
 * `node --check` reports the broken file CLEAN — verified against the pre-fix
 * revision. Only running the top level catches it, so each lane is SPAWNED
 * under BUDGET_DRY_PARSE=1: the script evaluates its module scope, including
 * the `budget()` call, then exits 0 before constructing a Cosmos client or
 * reading a row. No network, no writes.
 *
 * MUTATION-SENSITIVE BY CONSTRUCTION. Moving that require back below the CLOCK
 * line reproduces the exact production ReferenceError and turns the first case
 * below red — confirmed by mutating the file and re-running.
 *
 * THE SECOND CASE is the census: EVERY other lane that calls budget(), spawned
 * the same way. Those lanes require dist/ at their top level, which the suite's
 * `tests/setup/ensureDistBuilt.ts` globalSetup guarantees, so each one really
 * does evaluate its whole module scope here. Most then exit non-zero on their
 * own refusal — an empty COSMOS_CONNECTION_STRING, a missing `scope` — and that
 * is FINE and deliberately not asserted on: those refusals fire after the
 * budget block, so reaching one proves the budget line survived. The assertion
 * is narrow and exact: no lane may emit "Cannot access 'x' before
 * initialization". That is the one failure this file exists to prevent, and it
 * is the one a green CI would otherwise have shipped three nights running.
 *
 * A source-level ordering check backs the sweep up, so a lane that grows an
 * early `process.exit()` before its budget line still cannot hide a TDZ.
 * Comments are stripped first — the runner-budget prose quotes `budget()`
 * freely, and four lanes' block comments match it in prose alone.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

/** The lane the incident was about. Spawned for real. */
const FANOUT = "bulk-import-ch-daily-to-sold-comps.cjs";

/** Strip block and line comments so prose that mentions `budget()` — of which
 *  these files have a great deal — cannot be mistaken for a call site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

function budgetScripts(): string[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".cjs"))
    .filter((f) => /=\s*budget\(/.test(stripComments(fs.readFileSync(path.join(SCRIPTS_DIR, f), "utf8"))))
    .sort();
}

describe("the CH fan-out lane's module scope actually evaluates", () => {
  it("reaches and executes its budget() call under a stub env, exit 0", () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, FANOUT)], {
      env: {
        ...process.env,
        BUDGET_DRY_PARSE: "1",
        // Deliberately empty: the dry-parse exit must come BEFORE anything
        // that would need a connection, so this can never touch Cosmos.
        COSMOS_CONNECTION_STRING: "",
        BACKFILL_APPLY: "false",
        BULK_TIME_BUDGET_MIN: "300",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(String(r.stderr)).not.toMatch(/Cannot access '[^']+' before initialization/);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    // The workflow's BULK_TIME_BUDGET_MIN=300 still seeds RUN_MINUTES — the
    // budget CONTRACT is unchanged by the ordering fix.
    expect(String(r.stdout)).toContain("dry-parse OK");
    expect(String(r.stdout)).toContain("RUN_MINUTES=300");
  });

  it("a syntax check alone would NOT have caught this — hence the spawn above", () => {
    // Documents why `node --check` is not sufficient: it passes on a TDZ.
    const r = spawnSync(process.execPath, ["--check", path.join(SCRIPTS_DIR, FANOUT)], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
  });
});

describe("no budgeted lane calls budget() before it is required", () => {
  it("finds the lanes to check", () => {
    // A census that silently matched nothing would be a green light forever.
    expect(budgetScripts().length).toBeGreaterThan(50);
    expect(budgetScripts()).toContain(FANOUT);
  });

  it.each(budgetScripts())("%s evaluates its module scope without a TDZ", (file) => {
    // dist/ is guaranteed by tests/setup/ensureDistBuilt.ts, so this really
    // does execute each lane's top level rather than dying on a missing build.
    const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, file)], {
      env: {
        ...process.env,
        BUDGET_DRY_PARSE: "1",
        // Empty on purpose: a lane that refuses for want of a connection has
        // already run its budget line, which is all this case is asserting.
        COSMOS_CONNECTION_STRING: "",
        BACKFILL_APPLY: "false",
        APPLY: "false",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    // Only the TDZ is a failure. Exit status is NOT asserted: these lanes exit
    // non-zero on their own refusals, and rewriting them to exit 0 under a stub
    // env would be a far larger change than the defect warrants.
    expect(
      String(r.stderr),
      `${file}: threw a temporal-dead-zone ReferenceError at module load. Something is ` +
        `used above the line that declares it — the defect that killed the CH fan-out cron.`,
    ).not.toMatch(/Cannot access '[^']+' before initialization/);
  });

  it.each(budgetScripts())("%s requires runner-budget above its first budget() call", (file) => {
    const code = stripComments(fs.readFileSync(path.join(SCRIPTS_DIR, file), "utf8")).split(/\r?\n/);

    const declIdx = code.findIndex((l) => /(?:const|let|var)\s*\{[^}]*\bbudget\b[^}]*\}\s*=\s*require\(/.test(l));
    const useIdx = code.findIndex((l) => /=\s*budget\(/.test(l));

    expect(useIdx, `${file}: census selected a file with no budget() call`).toBeGreaterThanOrEqual(0);
    expect(declIdx, `${file}: calls budget() but never requires it from lib/runner-budget.cjs`).toBeGreaterThanOrEqual(0);
    expect(
      declIdx,
      `${file}: budget() is called on line ${useIdx + 1} but required on line ${declIdx + 1}. ` +
        `A const is in its temporal dead zone until its own line runs, so this throws ` +
        `"Cannot access 'budget' before initialization" at module load — the defect that killed ` +
        `the CH fan-out cron for three nights. Move the require above the call.`,
    ).toBeLessThan(useIdx);
  });
});
