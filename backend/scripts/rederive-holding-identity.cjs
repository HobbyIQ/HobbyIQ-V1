#!/usr/bin/env node
/**
 * rederive-holding-identity.cjs -- the dispatch shim for
 * `scripts/comp-quality/recheck-holding-identity.ts` MODE=rederive.
 *
 * WHY A SHIM AND NOT A REWRITE (Drew's R2, 2026-09-04).
 *
 * The re-derivation logic belongs beside the sweep it inverts: both call the
 * LIVE `canonicalize` out of `src/`, and a `.cjs` copy would either duplicate
 * that import or drift from it. But `backfill-runner.yml` runs exactly one
 * shape -- `node "backend/scripts/${{ inputs.script }}.cjs"` -- so a `.ts`
 * file under a subdirectory is unreachable from a dispatch however correct it
 * is. This file is the adapter between those two facts and holds NO logic of
 * its own: it execs tsx on the real script, in `backend/`, and exits with the
 * child's code.
 *
 * IT MUST RUN FROM `backend/`. The script it launches resolves the matcher as
 * `path.resolve(process.cwd(), "src/services/catalog/catalogMatcher.service.ts")`
 * and PRINTS it, precisely so a run from a stale tree is visible rather than
 * silently importing the wrong matcher. The runner checks out the repo root,
 * so cwd is forced here rather than inherited.
 *
 * Env passes straight through. The ones that matter:
 *   MODE=rederive     required -- this shim sets it if the dispatch did not,
 *                     because a dispatch of THIS script name can mean nothing
 *                     else, and the default (the unidentified sweep) is a
 *                     different pass over a different population.
 *   HOLDING_IDS       comma-separated holding ids or id prefixes. The runner
 *                     has no such input and is at its dispatch cap, so it
 *                     carries them in `titles` (exported as BCP_TITLES), which
 *                     the script already reads as a fallback.
 *   USER_ID           re-derive one user's holdings instead of a named list.
 *   BACKFILL_APPLY    the runner's apply flag. Report-only without it.
 *
 * Scope is NOT optional: with neither HOLDING_IDS nor USER_ID the script
 * refuses (exit 2) rather than sweeping every holding in the database.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const backend = path.resolve(__dirname, "..");
const target = path.join("scripts", "comp-quality", "recheck-holding-identity.ts");

// A dispatch of this script name means the rederive pass and nothing else.
// Set it rather than requiring the operator to remember, but do not OVERWRITE
// an explicit MODE -- a run that says something else should fail loudly in the
// script's own guard rather than be silently rewritten here.
const env = { ...process.env };
if (!String(env.MODE ?? "").trim()) env.MODE = "rederive";

console.log(`[shim]   ${target}  MODE=${env.MODE}  cwd=${backend}`);

const r = spawnSync("npx", ["tsx", target], {
  cwd: backend,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (r.error) {
  console.error("FATAL: could not launch tsx:", r.error.message);
  process.exit(3);
}
// Preserve the child's exit code EXACTLY: the script signals its outcomes
// through them (2 = refused scope, 4 = write conflict/failure, 5 = the
// read-back reconciliation disagreed), and a shim that collapsed them to 0/1
// would turn a failed verification into a green workflow.
process.exit(r.status === null ? 3 : r.status);
