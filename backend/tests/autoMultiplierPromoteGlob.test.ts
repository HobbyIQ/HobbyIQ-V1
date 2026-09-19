/**
 * CF-A-NON-MATCHING-GLOB-KILLS-THE-STEP (2026-09-18).
 *
 * THE DEFECT. "Weekly Auto-Multiplier Calibration Refresh" has failed its last
 * two scheduled runs with `::error::scan produced no output file` — while the
 * scan in the step immediately above SUCCEEDED and said so:
 *
 *   [calibrate] DONE → .../backend/scripts/auto-multipliers-2026-09-13.json
 *   ::error::scan produced no output file
 *
 * The file exists, at the path the glob names. The failure was never about the
 * path — a 2026-07-26 fix had already corrected that and the bug outlived it.
 *
 * `actions/runner` executes every `run:` block as
 * `bash --noprofile --norc -e -o pipefail`. Given two patterns where the
 * SECOND matches nothing, `ls` exits 2; `pipefail` carries that status through
 * the pipe into `tail`; and `-e` kills the step AT THE ASSIGNMENT. The `if`
 * never runs. The error line appears in the log only because the runner echoes
 * the whole script before executing it — which is precisely why this reads as
 * "the glob found nothing" when the truth is the opposite.
 *
 * Reproduced before fixing:
 *   bash -e t.sh                  -> rc=0, promoted the file
 *   bash -e -o pipefail t.sh      -> rc=2, no output
 *
 * THE FIX: expand the glob without `ls`. Bash leaves an unmatched pattern as
 * the literal string, a `-f` test rejects those, and nothing in the search can
 * set a non-zero status — so the emptiness check is the only thing that
 * decides, which was the original intent.
 *
 * Pinned as workflow TEXT because that is the only surface a unit test has
 * here, and because this class of defect is invisible to the backend suite:
 * a workflow-only change runs no tests at all (see #2153).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = fs.readFileSync(
  path.join(repo, ".github", "workflows", "auto-multiplier-refresh.yml"), "utf8");

describe("the promote step survives a non-matching glob", () => {
  it("does NOT use `ls` over several patterns — that is what exits 2 under pipefail", () => {
    expect(yml,
      "`ls a* b*` exits 2 when b* matches nothing; with `-e -o pipefail` that "
      + "kills the step before the emptiness check can run")
      .not.toMatch(/ls backend\/scripts\/auto-multipliers-\*\.json backend\/auto-multipliers-\*\.json/);
  });

  it("expands the patterns directly and rejects unmatched literals with -f", () => {
    // Bash leaves an unmatched glob as its literal text, so the `-f` test is
    // what distinguishes a real file from a pattern that matched nothing.
    expect(yml).toMatch(/for f in backend\/scripts\/auto-multipliers-\*\.json backend\/auto-multipliers-\*\.json; do/);
    expect(yml).toMatch(/\[ -f "\$f" \] \|\| continue/);
  });

  it("still fails loudly when the scan really produced nothing", () => {
    // The check that must survive: an empty result is a real failure, and the
    // message now says where it looked.
    expect(yml).toMatch(/if \[ -z "\$DATED" \]; then/);
    expect(yml).toMatch(/::error::scan produced no output file/);
    expect(yml).toMatch(/searched backend\/scripts\/ and backend\//);
  });

  it("still promotes the NEWEST dated file", () => {
    // Dated filenames sort lexicographically, so string comparison picks the
    // newest — the property `| tail -1` used to provide.
    expect(yml).toMatch(/\[ "\$f" \\> "\$DATED" \]/);
    expect(yml).toMatch(/mv "\$DATED" backend\/data\/auto-multipliers-latest\.json/);
  });

  it("the scan step still writes where the promote step looks", () => {
    // The two halves must agree. The script writes to its own __dirname
    // (backend/scripts/), and the search covers it.
    const script = fs.readFileSync(
      path.join(repo, "backend", "scripts", "calibrate-auto-multipliers.cjs"), "utf8");
    expect(script).toMatch(/path\.join\(__dirname, `auto-multipliers-\$\{/);
    expect(yml).toMatch(/backend\/scripts\/auto-multipliers-\*\.json/);
  });
});
