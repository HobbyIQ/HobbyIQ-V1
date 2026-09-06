// CF-CI-REQUIRED-CONTEXTS (2026-09-05). `Backend Unit Tests` and
// `Web Unit Tests` are REQUIRED status checks on main (strict=false).
//
// A required check that never reports is NOT a pass and NOT a skip — the PR
// sits at BLOCKED forever, waiting on a context no workflow will ever produce.
// That was live: #1835 added web-unit-tests.yml with path filters, and #1838
// (which touched no web path) showed exactly one check, `Backend Unit Tests`,
// and reported mergeStateStatus=BLOCKED.
//
// The fix is the standard skip-job pair. Each real workflow keeps its path
// filter — CI minutes matter, the backend suite is ~5 minutes — and is paired
// with a skip workflow that triggers on the EXACT complement of those paths
// and declares a job with the SAME name. The required context is the JOB
// name, not the workflow name: verified from `gh pr checks 1838`, where the
// workflow named `backend-tests` reports the context `Backend Unit Tests`.
//
// These pins exist because the failure mode is silent. Nothing goes red when
// the complement drifts; PRs just stop being mergeable. So we assert the
// structure directly:
//   - both required contexts appear as job `name:` values, byte-exact
//   - every real trigger path is mirrored in its skip's `paths-ignore`, and
//     vice versa, so no PR can fall between the two
//   - the real workflows have no bare-negation (`!`) path entries, which
//     create a third region matching NEITHER side of the pair
//   - both fire on pull_request AND push to main (the push side is what
//     records the context on main itself)
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const wf = (name: string) =>
  fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8").replace(/\r\n/g, "\n");

/** The exact required-context strings from main's branch protection. */
const REQUIRED_CONTEXTS = ["Backend Unit Tests", "Web Unit Tests"] as const;

/**
 * Pull the `- "..."` entries out of one `paths:`/`paths-ignore:` block under a
 * given event. Deliberately a small text parser rather than a YAML dependency:
 * backend/ has no YAML parser, and workflowAlertGates.test.ts sets the
 * precedent that a workflow-only change is pinned by its text.
 */
function pathList(yml: string, event: "pull_request" | "push", key: "paths" | "paths-ignore"): string[] {
  // Slice the `on:` block: from `on:` to the next top-level key.
  const onStart = yml.search(/^on:$/m);
  expect(onStart, "workflow has an `on:` block").toBeGreaterThan(-1);
  const after = yml.slice(onStart + 3);
  const endRel = after.search(/^\S/m);
  const onBlock = endRel === -1 ? after : after.slice(0, endRel);

  // Slice the event block out of `on:` (events are indented 2).
  const evRe = new RegExp(`^  ${event}:$`, "m");
  const evStart = onBlock.search(evRe);
  if (evStart === -1) return [];
  const afterEv = onBlock.slice(evStart + `  ${event}:`.length);
  const evEndRel = afterEv.search(/^  \S/m);
  const evBlock = evEndRel === -1 ? afterEv : afterEv.slice(0, evEndRel);

  // Slice the paths / paths-ignore list (indented 4) out of the event block.
  const keyRe = new RegExp(`^    ${key}:$`, "m");
  const kStart = evBlock.search(keyRe);
  if (kStart === -1) return [];
  const afterKey = evBlock.slice(kStart + `    ${key}:`.length);
  const kEndRel = afterKey.search(/^    \S/m);
  const kBlock = kEndRel === -1 ? afterKey : afterKey.slice(0, kEndRel);

  return [...kBlock.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
}

/** Every `name:` declared on a job (indented 4, directly under `jobs:`). */
function jobNames(yml: string): string[] {
  const jobsStart = yml.search(/^jobs:$/m);
  expect(jobsStart, "workflow has a `jobs:` block").toBeGreaterThan(-1);
  return [...yml.slice(jobsStart).matchAll(/^    name:\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

/** The four workflows that together must cover every PR. */
const PAIRS = [
  { context: "Backend Unit Tests", real: "test.yml", skip: "test-skip.yml" },
  { context: "Web Unit Tests", real: "web-unit-tests.yml", skip: "web-unit-tests-skip.yml" },
] as const;

describe("required check contexts are produced by EVERY pull_request", () => {
  for (const { context, real, skip } of PAIRS) {
    describe(`${context} (${real} + ${skip})`, () => {
      const realYml = wf(real);
      const skipYml = wf(skip);

      it("both workflows declare a job with the byte-exact required-context name", () => {
        // Unquoted in YAML, so compare the raw string. A stray quote, a
        // trailing space, or a case change silently orphans the context.
        expect(jobNames(realYml)).toContain(context);
        expect(jobNames(skipYml)).toContain(context);
      });

      it("the skip job is the cheap one — no checkout, no install, no test run", () => {
        // The whole point is CI minutes. If the skip job grows real steps the
        // pair costs more than just dropping the path filters.
        expect(skipYml).not.toMatch(/actions\/checkout/);
        expect(skipYml).not.toMatch(/actions\/setup-node/);
        expect(skipYml).not.toMatch(/npm (ci|test|run build)/);
      });

      for (const event of ["pull_request", "push"] as const) {
        describe(event, () => {
          it("the real workflow filters on paths and the skip mirrors them in paths-ignore", () => {
            const realPaths = pathList(realYml, event, "paths");
            const skipIgnore = pathList(skipYml, event, "paths-ignore");

            expect(realPaths.length, `${real} ${event} has a paths list`).toBeGreaterThan(0);

            // THE INVARIANT. Set equality both ways: anything the real
            // workflow runs on must be ignored by the skip (else BOTH run and
            // the context is ambiguous), and anything the skip ignores must be
            // covered by the real one (else NEITHER runs — the missing-check
            // bug). Sorted compare so ordering is free to change.
            expect([...skipIgnore].sort()).toEqual([...realPaths].sort());
          });

          it("uses no bare `!` negation, which would match neither side of the pair", () => {
            // test.yml once carried `"!backend/harness/**"`. `paths-ignore`
            // cannot express that complement, so a harness-only PR matched
            // NOTHING and produced no context at all. Keep negations out.
            for (const p of pathList(realYml, event, "paths")) {
              expect(p.startsWith("!"), `${real} path ${p} must not be a negation`).toBe(false);
            }
            // A real workflow must never carry both keys: GitHub rejects
            // paths + paths-ignore on the same event.
            expect(pathList(realYml, event, "paths-ignore")).toEqual([]);
            expect(pathList(skipYml, event, "paths")).toEqual([]);
          });

          it("the skip workflow is scoped to main, like the check it stands in for", () => {
            expect(skipYml).toMatch(new RegExp(`  ${event}:\\n    branches: \\[main\\]`));
          });
        });
      }
    });
  }

  it("the backend suite runs harness tests, so harness paths must trigger it", () => {
    // `npm test` is `vitest run --exclude "**/harness/tier1/**"` — everything
    // under harness/ EXCEPT tier1 is part of the required suite. The trigger
    // has to agree, or a harness-only PR merges without running the tests it
    // just changed. `backend/**` covers it; assert the exclusion did not creep
    // back into the trigger.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "package.json"), "utf8"));
    expect(pkg.scripts.test).toContain("harness/tier1");
    expect(wf("test.yml")).not.toContain("!backend/harness");
    expect(pathList(wf("test.yml"), "pull_request", "paths")).toContain("backend/**");
  });

  it("covers both required contexts and no others", () => {
    expect(PAIRS.map((p) => p.context).sort()).toEqual([...REQUIRED_CONTEXTS].sort());
  });
});
