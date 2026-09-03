/**
 * CF-CHRONIC-REDS-DIST (2026-09-03) — vitest globalSetup.
 *
 * THE CLASS. A standing group of suites is red on any clone that has not run
 * `npm run build`:
 *
 *     Error: Cannot find module '.../backend/dist/services/ops/writeReconciliation.js'
 *
 * The failure is at IMPORT time, so the whole file reports 0 tests — a silent
 * gap, not a visible red assertion.
 *
 * WHY THESE TESTS LEGITIMATELY NEED dist/, and are not "just using the wrong
 * import". They do not require dist themselves. They require a SHIPPED OPS
 * SCRIPT out of backend/scripts/*.cjs — audit-pricing-invariants.cjs,
 * conform-holdings-to-catalog.cjs, consolidate-catalog-duplicates.cjs,
 * explodeCatalogGrades.cjs, materialize-graded-identities.cjs,
 * sold-comps-cross-source-dedup.cjs, triage-contenthash-collisions.cjs — and
 * those scripts are plain CommonJS that runs in production against compiled
 * output:
 *
 *     const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
 *
 * That require IS the prod contract. ~200 ops scripts under backend/scripts/
 * are written this way. Rewriting them to point at src/ would make the tests
 * pass while testing something the operator never runs, and would break the
 * scripts themselves on the App Service box, where only dist/ is deployed.
 * So the honest split is: the contract here is "the compiled artifact works",
 * and the fix is to guarantee the artifact exists before the suite runs.
 *
 * (The two suites that required dist/ DIRECTLY for a pure helper —
 * bcpCardLineIsNotARung, bcpLadderScopeIsAProduct — are the other half of the
 * split and were converted to src imports instead. See those files.)
 *
 * WHAT THIS DOES. Builds once per `vitest run`, and only when dist/ is
 * missing or older than the newest file in src/. A clone that has already
 * built pays nothing; a fresh clone pays the tsc cost once instead of losing
 * ten suites. Never runs the tests against a stale dist.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, "..", "..");
const SRC = path.join(BACKEND, "src");
const DIST = path.join(BACKEND, "dist");

/** Newest mtime under a directory tree (0 if the tree is absent). */
function newestMtime(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let newest = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(root);
  return newest;
}

export default function setup(): void {
  // Opt-out for the deploy pipeline, which builds explicitly beforehand.
  if (process.env.SKIP_TEST_DIST_BUILD === "1") return;

  const srcNewest = newestMtime(SRC);
  const distNewest = newestMtime(DIST);

  if (distNewest > 0 && distNewest >= srcNewest) return; // dist is current

  const why = distNewest === 0 ? "dist/ is missing" : "dist/ is older than src/";
  // eslint-disable-next-line no-console
  console.log(`[ensureDistBuilt] ${why} — running \`npm run build\` once so the ops-script suites can load their prod requires.`);

  execFileSync("npm", ["run", "build"], {
    cwd: BACKEND,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (!fs.existsSync(path.join(DIST, "services", "ops", "writeReconciliation.js"))) {
    throw new Error(
      "[ensureDistBuilt] build finished but dist/services/ops/writeReconciliation.js is absent — " +
        "the ops-script suites cannot run against a compiled artifact that was not produced.",
    );
  }
}
