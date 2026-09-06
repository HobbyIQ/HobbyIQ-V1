// CF-CI-NEVER-CANCELS-A-MAIN-PUSH (2026-09-07).
//
// THE BUG. Both required-check workflows declared
//
//     concurrency:
//       group: <name>-${{ github.ref }}
//       cancel-in-progress: true
//
// On a push to main `github.ref` is `refs/heads/main` for EVERY commit, so
// every main push landed in ONE concurrency group and each merge CANCELLED the
// run still verifying the commit before it. Observed 2026-09-06: three merges
// inside four minutes killed each other's push runs --
//
//     916e7c7f  run started 17:51:13Z, cancelled 17:52:58Z
//     84f71477  run started 17:52:42Z, cancelled 17:55:31Z
//     c374b030  run started 17:55:13Z, cancelled 17:58:36Z
//
// -- each one cancelled seconds after the NEXT merge's run started. Those
// three merged trees were never verified by CI. Sixteen main commits since the
// push trigger was added (#1840) carry a cancelled run rather than a completed
// one.
//
// WHY IT IS SILENT. A cancelled run is not a red X. Branch protection is
// satisfied by the PULL REQUEST run, which had already passed, so nothing
// blocks and nothing alerts. The push run is the only record that the MERGED
// tree -- base plus PR, which is not the tree the PR run tested -- still
// passes. Losing it loses the only post-merge verification there is, and a
// later unrelated push "covers" the gap by accident.
//
// THE INVARIANT. Cancellation is a PULL REQUEST optimisation and nothing else.
//   - pull_request: superseded runs MAY cancel. Only the head commit merges,
//     so verifying an abandoned intermediate commit is wasted runner time.
//   - push to main: a run must NEVER be cancellable. Every main commit gets
//     its own group (keyed by `github.sha`), and `cancel-in-progress` is a
//     bare-false expression for every non-PR event.
//
// SCOPE. Deploy workflows are deliberately NOT covered. deploy-web.yml keeps
// `cancel-in-progress: true` on its push lane on purpose: deploys must stay
// serialized and a superseded deploy SHOULD die rather than race a newer one
// onto the same environment. Cancelling a deploy loses nothing -- the newer
// deploy supersedes it. Cancelling a TEST loses the only proof the tree was
// verified. That is the whole difference, and it is why this pin names its
// workflows explicitly instead of sweeping the directory.
//
// MUTATION. Restore `cancel-in-progress: true` (or re-key the group to
// `github.ref`) in any covered workflow and this file goes red.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

const wf = (name: string) =>
  fs.readFileSync(path.join(WORKFLOW_DIR, name), "utf8").replace(/\r\n/g, "\n");

/**
 * The workflow with every full-line `#` comment removed. Text assertions MUST
 * run against this, never the raw file: these workflows carry long rationale
 * comments that quote the very strings being asserted against
 * (`cancel-in-progress: true`, `github.ref`), and matching those would be a
 * false positive hiding a real regression. Same guard
 * backendWebCheckContexts.test.ts and workflowAlertGates.test.ts use.
 */
const code = (yml: string) => yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** The top-level `concurrency:` block only, comments stripped. */
function concurrencyBlock(yml: string): string {
  const c = code(yml);
  const start = c.search(/^concurrency:$/m);
  expect(start, "workflow declares a top-level `concurrency:` block").toBeGreaterThan(-1);
  const after = c.slice(start + "concurrency:".length);
  const endRel = after.search(/^\S/m);
  return endRel === -1 ? after : after.slice(0, endRel);
}

/** The `on:` block only, comments stripped. */
function onBlock(yml: string): string {
  const c = code(yml);
  const start = c.search(/^on:$/m);
  expect(start, "workflow has an `on:` block").toBeGreaterThan(-1);
  const after = c.slice(start + 3);
  const endRel = after.search(/^\S/m);
  return endRel === -1 ? after : after.slice(0, endRel);
}

function field(block: string, key: string): string {
  const m = block.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, "m"));
  expect(m, `concurrency block declares \`${key}:\``).not.toBeNull();
  return m![1];
}

/**
 * Workflows that verify a tree and run on push to main. The two required
 * contexts plus the pricing harness, which is not required but is the only
 * other suite that records a verdict on main commits.
 *
 * Deploy workflows are excluded ON PURPOSE -- see the SCOPE note above.
 */
const VERIFYING_WORKFLOWS = [
  { file: "test.yml", group: "backend-tests" },
  { file: "web-unit-tests.yml", group: "web-unit-tests" },
  { file: "regression.yml", group: "regression" },
] as const;

/** Byte-exact required contexts from main's branch protection. */
const REQUIRED_CONTEXT_FILES = ["test.yml", "web-unit-tests.yml"] as const;

describe("no verifying workflow can cancel a main push run", () => {
  for (const { file, group } of VERIFYING_WORKFLOWS) {
    describe(file, () => {
      const yml = wf(file);

      it("runs on push to main, so its push runs are worth protecting", () => {
        // If this stops being true the pin below is vacuous -- a workflow that
        // never runs on main push cannot have a main push run cancelled.
        expect(onBlock(yml)).toContain("  push:\n    branches: [main]");
      });

      it("cancel-in-progress is gated on the event being a pull_request", () => {
        // THE INVARIANT. A literal `true` here is the bug: it applies to push
        // runs too. The value must be an expression that is false for
        // anything that is not a pull_request.
        const cip = field(concurrencyBlock(yml), "cancel-in-progress");
        expect(cip, `${file}: cancel-in-progress must not be an unconditional literal`).not.toBe(
          "true",
        );
        expect(cip).toBe("${{ github.event_name == 'pull_request' }}");
      });

      it("the group keys push runs by commit, never by ref", () => {
        // `github.ref` is `refs/heads/main` for EVERY main commit -- one
        // shared group, so consecutive merges cancel each other even when
        // cancel-in-progress is correct. Push runs must key on github.sha so
        // each commit gets a group of its own.
        const g = field(concurrencyBlock(yml), "group");
        expect(g).toBe(
          `${group}-\${{ github.event_name == 'pull_request' && github.head_ref || github.sha }}`,
        );
        // The non-PR fallback is what push runs land in. It must be the sha.
        expect(g, `${file}: the non-pull_request branch of the group must be github.sha`).toMatch(
          /\|\|\s*github\.sha\s*\}\}$/,
        );
      });

      it("no bare github.ref survives anywhere in the concurrency block", () => {
        // Belt and braces: a group like `<name>-${{ github.ref }}-${{ github.sha }}`
        // would pass a naive substring check while still collapsing PR runs.
        // Nothing in this block should reference github.ref at all.
        expect(concurrencyBlock(yml)).not.toContain("github.ref");
      });
    });
  }

  it("every required-check workflow is covered by this pin", () => {
    // A required check is the gate on main. If one is added or renamed and
    // nobody adds it here, the new gate silently reacquires the bug.
    const covered = new Set<string>(VERIFYING_WORKFLOWS.map((w) => w.file));
    for (const f of REQUIRED_CONTEXT_FILES) {
      expect(covered, `required-check workflow ${f} must be pinned here`).toContain(f);
    }
  });

  it("no OTHER workflow that runs on push to main can cancel its own push runs", () => {
    // The sweep. Catches a workflow that acquires the pattern later without
    // anyone updating VERIFYING_WORKFLOWS. Deploy workflows are the sole
    // allowed exception: a superseded deploy SHOULD die rather than race a
    // newer one onto the same environment, and it loses no verification.
    const DEPLOY_EXEMPT = new Set(["deploy-web.yml", "deploy-worker.yml"]);

    const offenders: string[] = [];
    for (const f of fs.readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
      if (DEPLOY_EXEMPT.has(f)) continue;
      const yml = wf(f);
      const c = code(yml);
      if (!/^concurrency:$/m.test(c)) continue;
      if (!/^\s+push:\n\s+branches:\s*\[\s*main\s*\]/m.test(c)) continue;
      const cip = c.match(/^\s+cancel-in-progress:\s*(.+?)\s*$/m)?.[1];
      if (cip === "true") offenders.push(f);
    }
    expect(offenders, "these workflows would cancel a main push run").toEqual([]);
  });

  it("the deploy workflow keeps its own serialization untouched", () => {
    // Documents what deploy-web.yml does TODAY so a future reader does not
    // "fix" it to match the test workflows. Its push lane deliberately keys on
    // github.ref and cancels in progress: only one deploy of main should be
    // in flight, and the newest one wins.
    const c = code(wf("deploy-web.yml"));
    expect(c).toContain("cancel-in-progress: true");
    expect(c).toContain("github.ref");
  });
});
