/**
 * CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS, for relocate-catalog-rows-by-list.
 *
 * THE RUN THAT WROTE THIS FILE. Run 34079952456 — APPLY over the 13,295-entry
 * soccer bare-key list (11,630 retires + 1,665 reslugs) — was KILLED:
 *
 *   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
 *
 * with no budget marker, no reconcile line and no `finishLane: exiting code`.
 * #1913's KILLED branch fired and correctly withheld the re-dispatch, so the
 * work stopped at 4,935 of 11,630 retires and the run went red.
 *
 * THE DEFECT WAS THE ABSENCE OF A CHECK, NOT ITS PLACEMENT. The obvious
 * hypotheses were both wrong and are recorded so nobody re-tests them:
 *
 *   - "the budget check is outside the retire branch"  — there was no budget
 *     check anywhere. The lane never required runner-budget.cjs at all.
 *   - "#1940's confirmRetired made the row too expensive" — its 3 reads +
 *     backoff + cross-partition query only escalate past the FIRST point read
 *     when that read still sees the row, and run 34079952456 printed
 *     `read-back needed a retry` exactly 0 times across 4,935 retires. The
 *     backoff path was never entered.
 *
 * What was actually true is arithmetic, measured from the two runs' own logs:
 *
 *   REPORT 34077554971  11,630 retires in   886s = 0.076 s/row
 *   APPLY  34079952456   4,935 retires in 9,010s = 1.826 s/row
 *
 * The report runs the same reads; it skips the WRITE half (retireCatalogRow's
 * graded sweep + delete, and the read-back). At 1.826 s/row the file needed
 * ~6.7 hours — 2.7x the ceiling. No placement of a check makes that finish;
 * only a budget that STOPS and a relaunch that CONTINUES does.
 *
 * WHAT THIS FILE PINS, against the real script under a fake container:
 *
 *   1. the budget stops the loop mid-list, in BOTH branches;
 *   2. the marker prints and matches the runner's grep;
 *   3. the banner says `stopped at N of M`;
 *   4. the PARTIAL run still reconciles — `not reached` carries the remainder;
 *   5. the process EXITS via finishLane rather than being killed.
 *
 * MUTATION CHECK (the last describe): the same probe with the budget check
 * REMOVED runs the whole list, prints no marker and reconciles nothing as
 * deferred — i.e. this pin fails against the code as it was on 2026-09-07.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(backend, "scripts", "relocate-catalog-rows-by-list.cjs");
const script = fs.readFileSync(SCRIPT, "utf8");

/** A list of `n` retires and `m` reslugs, retires first — the shape of every
 *  committed list this lane consumes. */
function makeList(dir: string, retires: number, reslugs: number): string {
  const entries = [
    ...Array.from({ length: retires }, (_, i) => ({
      id: `hiq:soccer:2022:panini-prizm:${i}:silver-prizm:no-auto`,
      action: "retire",
      reason: "a bare product key is not an address",
      evidence: "probe",
    })),
    ...Array.from({ length: reslugs }, (_, i) => ({
      id: `hiq:soccer:2022:panini-prizm:r${i}:gold-prizm:no-auto`,
      action: "reslug",
      to: `hiq:soccer:2022:panini-prizm:r${i}:gold-prizm:no-auto:num-10`,
      reason: "the print run belongs in the address",
      evidence: "probe",
    })),
  ];
  const file = path.join(dir, "probe-list.json");
  fs.writeFileSync(file, JSON.stringify({ generatedAt: "2026-09-07", forLane: "probe", rulings: [], entries, excluded: [] }));
  return file;
}

/**
 * A preload that replaces `@azure/cosmos` and the two dist services with fakes
 * — so the real lane runs its real loop, its real classify, its real banner and
 * its real budget, against a container that answers instantly.
 *
 * EVERY UNIT COSTS `unitMs`. That is what makes the budget observable: with a
 * tiny BUDGET_MS and a per-unit cost, the loop must stop partway or the pin is
 * measuring nothing.
 */
function preload(dir: string, unitMs: number, mutate: boolean): string {
  const file = path.join(dir, "preload.cjs");
  fs.writeFileSync(file, `
const Module = require("node:module");
const path = require("node:path");
const realResolve = Module._resolveFilename;
// Burn wall clock synchronously: the budget reads Date.now(), so a unit has to
// actually consume time rather than merely await a timer the fake resolves.
const spend = (ms) => { const t = Date.now(); while (Date.now() - t < ms) {} };
const UNIT_MS = ${unitMs};

// THE FAKE MODELS DELETION, and it has to. The lane does not believe its own
// delete: retireCatalogRow is followed by confirmRetired, which re-reads and
// only counts the retire when the row is GONE. A fake whose read always
// answers would fail every entry and this pin would be measuring the failure
// path rather than the budget. So the container keeps a "gone" set that the
// fake retire/move writes into and every read consults.
const gone = new Set();
const container = (name) => ({
  item(id, pk) {
    return { read: async () => (gone.has(id)
      ? { resource: undefined }
      : { resource: { id, cardId: pk, playerName: "Probe", setName: "Probe Set", sport: "soccer" } }) };
  },
  // Two shapes ride this one query: salesAt's COUNT (a number) and
  // confirmRetired's id lookup (rows). A deleted id must return NEITHER a
  // count nor a row, so the parameter decides.
  items: {
    query: (spec) => ({
      fetchAll: async () => {
        const p = (spec && spec.parameters) || [];
        const q = String((spec && spec.query) || "");
        if (/SELECT c\.id FROM c WHERE c\.id = @id/.test(q)) {
          const id = (p.find((x) => x.name === "@id") || {}).value;
          return { resources: gone.has(id) ? [] : [{ id }] };
        }
        return { resources: [0] };
      },
    }),
  },
});
const fakeCosmos = {
  CosmosClient: class {
    constructor() {}
    database() { return { container: (n) => container(n) }; }
    dispose() {}
  },
};
const fakeOps = {
  // The WRITE half — the 1.75 s/row the report never pays. Charged here so the
  // budget has something to stop, and recorded in \`gone\` so the lane's own
  // verify-by-read confirms it exactly as it would against Cosmos.
  retireCatalogRow: async (c, id) => {
    spend(UNIT_MS); gone.add(id);
    return { action: "retire", rowDeleted: true, gradedChildrenRetired: 0 };
  },
  // A move vacates the source; the destination is readable because it is not
  // in \`gone\`. That is what the lane's \`landed && sourceGone\` check reads.
  moveCatalogRow: async (c, row, to, changed, opts) => {
    spend(UNIT_MS);
    if (!(opts && opts.dryRun)) gone.add(row.id);
    return { action: "moved", salesRepointed: 0, gradedChildrenRetired: 0 };
  },
};
const fakeReconcile = { reportWrites: () => {} };

Module._resolveFilename = function (request, ...rest) {
  if (request === "@azure/cosmos") return "FAKE_COSMOS";
  if (request.includes("catalogRowOps.service")) return "FAKE_OPS";
  if (request.includes("writeReconciliation")) return "FAKE_RECONCILE";
  return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/cosmos") return fakeCosmos;
  if (request.includes("catalogRowOps.service")) return fakeOps;
  if (request.includes("writeReconciliation")) return fakeReconcile;
  return realLoad.call(this, request, ...rest);
};

${mutate ? `
// ── THE MUTATION ─────────────────────────────────────────────────────────
// Restore the pre-fix behaviour: a budget that never reports being out of
// clock, i.e. the lane as it was when run 34079952456 was killed.
const budgetLib = require(path.join(${JSON.stringify(backend)}, "scripts", "lib", "runner-budget.cjs"));
const realBudget = budgetLib.budget;
budgetLib.budget = (opts) => { const b = realBudget(opts); return { ...b, outOfClock: () => false }; };
` : ""}
`);
  return file;
}

/** Run the real lane under the fake container. `timeout` is how a NON-EXITING
 *  process is detected without hanging this suite. */
function runLane(opts: { retires: number; reslugs: number; budgetMs: number; unitMs: number; mutate?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relocate-budget-"));
  const list = makeList(dir, opts.retires, opts.reslugs);
  const pre = preload(dir, opts.unitMs, opts.mutate === true);
  const r = spawnSync(process.execPath, ["--require", pre, SCRIPT], {
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    cwd: backend,
    env: {
      ...process.env,
      SCOPE: list,
      BACKFILL_APPLY: "true",
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://probe/;AccountKey=probe==;",
      BUDGET_MS: String(opts.budgetMs),
      RESERVE_MS: String(Math.max(opts.unitMs * 2, 50)),
      VERIFY_MS: "1000",
    },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
    timedOut: r.signal === "SIGKILL",
  };
}

// ── 1. THE BUDGET STOPS THE LOOP, AND SAYS SO ──────────────────────────────
describe("the list lane stops at its budget instead of being killed at the ceiling", () => {
  // A retire-only list: the branch that ran in the killed run.
  const retireOnly = runLane({ retires: 200, reslugs: 0, budgetMs: 1200, unitMs: 40 });

  it("the process EXITS — it is not killed, as run 34079952456 was", () => {
    expect(retireOnly.timedOut, "the lane had to be killed; it never exited itself").toBe(false);
    expect(retireOnly.stdout).toContain("finishLane: exiting code 0");
  });

  it("prints the marker the runner's relaunch greps for, verbatim", () => {
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). This is the exact regex the workflow
    // uses: `grep -aqE "stopped at the .*budget"`.
    expect(retireOnly.stdout).toMatch(/stopped at the .*budget/);
  });

  it("the marker is a SOURCE LITERAL, not assembled where a refactor can reword it", () => {
    expect(script).toMatch(/stopped at the \$\{b\.RUN_MINUTES\}-minute budget/);
  });

  it("the banner says how far it got: `stopped at N of M`", () => {
    const m = /stopped at ([\d,]+) of ([\d,]+)/.exec(retireOnly.stdout);
    expect(m, `no 'stopped at N of M' in:\n${retireOnly.stdout.slice(-1200)}`).toBeTruthy();
    const stopped = Number((m as RegExpExecArray)[1].replace(/,/g, ""));
    const total = Number((m as RegExpExecArray)[2].replace(/,/g, ""));
    expect(total).toBe(200);
    // Genuinely partial: it did work, and it did not finish.
    expect(stopped).toBeGreaterThan(0);
    expect(stopped).toBeLessThan(200);
  });

  it("the PARTIAL run still reconciles — the remainder is `not reached`, never lost", () => {
    const m = /reconciled: intended ([\d,]+) = written ([\d,]+) \+ skipped ([\d,]+) \+ refused ([\d,]+) \+ failed ([\d,]+) \+ not reached ([\d,]+)/
      .exec(retireOnly.stdout);
    expect(m, `no reconcile line in:\n${retireOnly.stdout.slice(-1200)}`).toBeTruthy();
    const [, i, w, s, rf, fl, nr] = (m as RegExpExecArray).map((x) => Number(String(x).replace(/,/g, "")));
    expect(w + s + rf + fl + nr).toBe(i);
    expect(nr, "a budget stop must defer the entries it never read").toBeGreaterThan(0);
    expect(w, "the entries it DID reach were written").toBeGreaterThan(0);
    // A reconcile mismatch would have set exitCode 4.
    expect(retireOnly.stdout).not.toContain("RECONCILE MISMATCH");
  });

  it("names the idempotence that makes the relaunch safe", () => {
    expect(retireOnly.stdout).toContain("IDEMPOTENT");
  });
});

// ── 2. BOTH BRANCHES, NOT JUST THE RETIRE ONE ──────────────────────────────
//
// The budget lives ABOVE the retire/reslug fork precisely so neither branch can
// be the one that forgets it. A list whose retires are all cheap-skipped and
// whose reslugs do the work proves the reslug half is governed too.
describe("the budget governs the reslug branch as well as the retire branch", () => {
  const reslugOnly = runLane({ retires: 0, reslugs: 200, budgetMs: 1200, unitMs: 40 });

  it("a reslug-only list stops at the budget and prints the marker", () => {
    expect(reslugOnly.timedOut).toBe(false);
    expect(reslugOnly.stdout).toMatch(/stopped at the .*budget/);
    const m = /stopped at ([\d,]+) of ([\d,]+)/.exec(reslugOnly.stdout);
    expect(m).toBeTruthy();
    expect(Number((m as RegExpExecArray)[1].replace(/,/g, ""))).toBeLessThan(200);
  });

  it("the check sits above the fork, so neither branch can omit it", () => {
    // The window is the loop head up to the first thing done WITH the entry:
    // the classify. A check that landed after it would be outside this slice.
    const from = script.indexOf("for (const e of entries)");
    const to = script.indexOf("const c = classifyEntry(e);", from);
    expect(from, "the work loop must exist").toBeGreaterThan(0);
    expect(to, "the loop must classify each entry").toBeGreaterThan(from);
    expect(
      script.slice(from, to),
      "outOfClock() must be checked before the entry is classified or read",
    ).toContain("b.outOfClock()");
  });

  it("it is a PRE-check: the entry that would overrun is never started", () => {
    // The loop-top defect #1799 named: `Date.now() - t0 > BUDGET` AFTER a unit.
    expect(script).not.toMatch(/Date\.now\(\)\s*-\s*\w+\s*>=?\s*(?:RUN_MS|BUDGET_MS)\s*[);]/);
  });
});

// ── 3. A LIST THAT FITS FINISHES, AND DOES NOT RELAUNCH ────────────────────
describe("a list that fits in the budget finishes and prints no marker", () => {
  const complete = runLane({ retires: 10, reslugs: 5, budgetMs: 60000, unitMs: 1 });

  it("no marker — a finished lane must never manufacture one and relaunch forever", () => {
    expect(complete.stdout).not.toMatch(/stopped at the .*budget/);
    expect(complete.stdout).toContain("finishLane: exiting code 0");
    expect(complete.status).toBe(0);
  });

  it("reconciles the whole list with nothing deferred", () => {
    expect(complete.stdout).toMatch(/reconciled: intended 15 = written 15 \+ skipped 0 \+ refused 0 \+ failed 0 \+ not reached 0/);
    expect(complete.stdout).toContain("<- the whole list");
  });
});

// ── 4. THE MUTATION CHECK ──────────────────────────────────────────────────
//
// A pin that cannot fail is decoration. This runs the SAME probe with
// outOfClock() forced false — the lane exactly as it was when run 34079952456
// was killed — and asserts the marker and the deferral both disappear.
describe("MUTATION: remove the budget check and the lane runs the whole list", () => {
  // Same budget, same list length, cheaper unit — so the mutated lane can
  // actually reach the end inside this suite's spawn timeout and PROVE it ran
  // past its budget rather than merely being slow. 200 x 10ms = 2s of work
  // against a 1.2s budget: a lane that checked its clock would stop.
  const mutated = runLane({ retires: 200, reslugs: 0, budgetMs: 1200, unitMs: 10, mutate: true });

  it("the control: the SAME list and budget DO stop when the check is present", () => {
    const control = runLane({ retires: 200, reslugs: 0, budgetMs: 1200, unitMs: 10 });
    expect(control.stdout).toMatch(/stopped at the .*budget/);
  });

  it("without the check there is no marker — so the relaunch never fires", () => {
    expect(mutated.stdout).not.toMatch(/stopped at the .*budget/);
  });

  it("without the check nothing is deferred — it runs past its budget to the end", () => {
    expect(mutated.stdout).toMatch(/reconciled: intended 200 = written 200 \+ skipped 0 \+ refused 0 \+ failed 0 \+ not reached 0/);
  });
});
