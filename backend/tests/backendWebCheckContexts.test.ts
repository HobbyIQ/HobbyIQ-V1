// CF-CI-REQUIRED-CONTEXTS (2026-09-05). `Backend Unit Tests` and
// `Web Unit Tests` are REQUIRED status checks on main (strict=false).
//
// THE BUG. A required check that never reports is NOT a pass and NOT a skip —
// the PR sits at BLOCKED forever, waiting on a context no workflow will ever
// produce. That was live: #1835 added web-unit-tests.yml with `paths:`
// filters, so #1838 (which touched no web path) showed exactly one check and
// reported mergeStateStatus=BLOCKED.
//
// WHY NOT A SKIP-JOB PAIR. The obvious fix is a second workflow whose job has
// the same name, triggered on the complement via `paths-ignore`. It does not
// work, and this was confirmed empirically on #1840 rather than reasoned
// about:
//
//   `paths` matches when ANY changed file matches.
//   `paths-ignore` skips only when EVERY changed file matches.
//
// Those are not complements. Any PR touching one web file and one backend
// file satisfies a workflow's `paths` AND its twin's `paths-ignore`, so BOTH
// jobs run and the required context is reported TWICE. Under strict=false a
// duplicated context is worse than a missing one: the fast green skip job can
// satisfy the gate while the real suite is still pending or already red.
// Workflow-level path filters simply cannot express "exactly once".
//
// THE SHAPE. Both workflows therefore trigger on every pull_request and every
// push to main with NO `paths:` filter, so each context reports exactly once,
// always. The path check moved INSIDE the job: a `changes` step diffs against
// the base and sets an output, and the expensive steps (~5 min for backend,
// npm ci + next build for web) carry
// `if: steps.changes.outputs.run == 'true'`. A no-op run costs a few seconds
// of runner time, which is the price of a gate that is never missing and
// never doubled.
//
// These pins exist because the failure mode is SILENT — nothing goes red when
// a filter creeps back in, PRs just quietly stop being mergeable.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const wf = (name: string) =>
  fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8").replace(/\r\n/g, "\n");

/**
 * The workflow with every full-line `#` comment removed. Text assertions MUST
 * run against this, never the raw file: these workflows carry long rationale
 * comments that quote the very strings being asserted against (`paths:`,
 * `npm ci`), and matching those would be a false positive hiding a real
 * regression. Same guard workflowAlertGates.test.ts uses.
 */
const code = (yml: string) => yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** The `on:` block only, comments stripped. */
function onBlock(yml: string): string {
  const c = code(yml);
  const start = c.search(/^on:$/m);
  expect(start, "workflow has an `on:` block").toBeGreaterThan(-1);
  const after = c.slice(start + 3);
  const endRel = after.search(/^\S/m);
  return endRel === -1 ? after : after.slice(0, endRel);
}

/** Every `name:` declared on a job (indented 4, directly under `jobs:`). */
function jobNames(yml: string): string[] {
  const c = code(yml);
  const jobsStart = c.search(/^jobs:$/m);
  if (jobsStart === -1) return [];
  return [...c.slice(jobsStart).matchAll(/^    name:\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

/** The exact required-context strings from main's branch protection. */
const REQUIRED = [
  {
    context: "Backend Unit Tests",
    file: "test.yml",
    // Paths that must still cause the real suite to run, via the in-job gate.
    gated: ["backend/", "\\.github/workflows/test\\.yml$"],
  },
  {
    context: "Web Unit Tests",
    file: "web-unit-tests.yml",
    gated: [
      "apps/web/",
      "backend/src/services/compiq/",
      "\\.github/workflows/web-unit-tests\\.yml$",
    ],
  },
] as const;

describe("required check contexts report on EVERY pull_request", () => {
  for (const { context, file, gated } of REQUIRED) {
    describe(`${context} (${file})`, () => {
      const yml = wf(file);

      it("declares a job whose name is the byte-exact required context", () => {
        // The required context is the JOB name, not the workflow name —
        // verified from `gh pr checks 1838`, where the workflow named
        // `backend-tests` reports the context `Backend Unit Tests`. A stray
        // quote, trailing space, or case change silently orphans the gate.
        expect(jobNames(yml)).toContain(context);
      });

      it("has NO path filter on pull_request or push — the check must always report", () => {
        // THE INVARIANT. This is the whole fix. A `paths:` or `paths-ignore:`
        // here is what left #1838 unmergeable.
        const on = onBlock(yml);
        expect(on).not.toMatch(/^\s*paths:/m);
        expect(on).not.toMatch(/^\s*paths-ignore:/m);
      });

      it("fires on both pull_request and push to main", () => {
        // pull_request gates the merge; push records the context on main
        // itself. test.yml previously had no `push:` trigger at all.
        const on = onBlock(yml);
        for (const event of ["pull_request", "push"]) {
          expect(on).toContain(`  ${event}:\n    branches: [main]`);
        }
      });

      it("gates the expensive steps on an in-job changes check", () => {
        // Filters are gone, so the cheapness has to come from somewhere. If
        // this step disappears, every PR pays for the full suite.
        const c = code(yml);
        expect(c).toMatch(/^        id: changes$/m);
        expect(c).toContain("steps.changes.outputs.run == 'true'");

        // Every npm step must carry the guard, or the "skip" still runs the
        // costly work. Count guards against npm steps rather than trusting
        // that one `if:` somewhere covers them all.
        const npmSteps = [...c.matchAll(/^        run: npm /gm)].length;
        const guards = [...c.matchAll(/steps\.changes\.outputs\.run == 'true'/g)].length;
        expect(npmSteps, `${file} has npm steps to gate`).toBeGreaterThan(0);
        expect(guards, `${file}: every npm step plus setup-node is guarded`).toBeGreaterThanOrEqual(
          npmSteps,
        );
      });

      it("the gate still runs the suite for every path that used to trigger it", () => {
        // Moving a filter into the job must not narrow it. Each previously
        // triggering prefix has to appear in the in-job matcher.
        const c = code(yml);
        for (const g of gated) {
          expect(c, `${file} gate must still match ${g}`).toContain(g);
        }
      });

      it("fails OPEN when there is no usable base ref", () => {
        // A missing or unresolvable base must RUN the suite, not skip it. The
        // wrong direction here silently stops testing anything.
        const c = code(yml);
        expect(c).toContain("NEEDS_FULL_RUN=yes");
        expect(c).toMatch(/if \[ "\$NEEDS_FULL_RUN" = "yes" \]; then\n\s+echo "run=true"/);
      });
    });
  }

  it("no skip-pair workflow survives — a same-named twin double-reports the context", () => {
    // #1840 briefly carried test-skip.yml / web-unit-tests-skip.yml. They are
    // deleted, and must stay deleted: `paths` (ANY-match) and `paths-ignore`
    // (ALL-match) are not complements, so a mixed PR ran both and reported
    // each required context twice.
    const dir = path.join(ROOT, ".github", "workflows");
    const twins = fs.readdirSync(dir).filter((f) => /-skip\.ya?ml$/.test(f));
    expect(twins).toEqual([]);

    // Belt and braces: exactly one workflow may declare each required context.
    const all = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    for (const { context } of REQUIRED) {
      const owners = all.filter((f) => jobNames(wf(f)).includes(context));
      expect(owners, `exactly one workflow declares "${context}"`).toHaveLength(1);
    }
  });

  it("the backend suite runs harness tests, so harness paths must reach the gate", () => {
    // `npm test` is `vitest run --exclude "**/harness/tier1/**"` — everything
    // under harness/ EXCEPT tier1 is part of the required suite. test.yml
    // once excluded `"!backend/harness/**"` from its trigger, so a
    // harness-only PR both produced no context AND never ran the tests it
    // changed. `backend/` in the gate covers it; keep the negation out.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "package.json"), "utf8"));
    expect(pkg.scripts.test).toContain("harness/tier1");
    expect(code(wf("test.yml"))).not.toContain("!backend/harness");
  });
});
