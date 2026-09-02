#!/usr/bin/env node
/**
 * mutation-valuation-core.cjs — are the valuation core's guards load-bearing?
 *
 * CF-NEVER-AGAIN (Drew, 2026-09-02). A guard nobody can break is a guard nobody
 * has tested. D29's lesson was exactly this: a right guard with the wrong scope
 * passed every test it had, because none of them removed it.
 *
 * So this job takes the SHIPPED valuation core, applies a small fixed set of
 * doctrine-killing mutants, and asserts the suite goes RED for each one. A
 * mutant that leaves the suite GREEN means the guard has stopped doing
 * anything and the doctrine it encodes is decoration — that FAILS the job.
 *
 * THE MUTANTS ARE NOT INVENTED. Each one is the exact edit that was proven
 * lethal during the week of 2026-08-27..09-02, quoted from the PR that shipped
 * the guard:
 *
 *   union-guard-off     (#1627) unifiedIdentityAttempts stops refusing a
 *                       cross-product pool-twin union -> two products, one pool
 *   grade-refusal-off   (#1640) an unreadable grade borrows the largest other
 *                       tier instead of refusing -> a PSA 9 number under PSA 10
 *   swing-capture-null  (#1627) isSwingAlarming never fires -> a 10.4x cron
 *                       flap passes in silence
 *   externalid-collapse (#1637/#1638) externalIdOf reduced to the base id ->
 *                       two real sales collapse into one
 *
 * Mutation is IN-MEMORY ONLY: each mutant is written to a temp copy of the
 * tree, run, and discarded. The canonical files are never edited
 * (feedback_builders_never_touch_the_canonical_tree).
 *
 * Exit 0 = every mutant was caught. Exit 1 = a mutant survived (the real
 * failure this job exists to surface). Exit 2 = harness error.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const backend = path.resolve(__dirname, "..");
const ONLY = (process.env.MUTANTS || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Each mutant: the file to edit, the exact `find` -> `replace` that kills the
 * doctrine, and the suites that MUST go red as a result.
 *
 * `find` must occur exactly once — a mutant that no longer applies is itself a
 * finding (the guard was refactored and this harness is auditing nothing), so
 * an unapplied mutant fails the job rather than silently passing.
 */
const MUTANTS = [
  {
    name: "union-guard-off",
    doctrine: "CF-A-UNION-IS-ONE-CARD (#1627) — a union is one card",
    file: "src/services/portfolioiq/exactPoolSupremacy.ts",
    find: "const unionOk = !hiq || mayUnionIdentities(cid, hiq);",
    replace: "const unionOk = true;",
    suites: ["tests/poolTwinUnionIsOneCard.test.ts"],
    kills: "two identities naming different products merge into one pool again",
  },
  {
    name: "grade-refusal-off",
    doctrine: "CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (#1640) — an unreadable grade refuses",
    file: "src/services/compiq/unifiedPricing.service.ts",
    find: "      if (requestedGradeIsUnreadable) {\n        matched = undefined;   // refuse: no number beats a wrong-grade number\n      } else {\n        matched = gradeCurve[0];\n        requestedButFallbackMatched = true;\n      }",
    replace: "      matched = gradeCurve[0];\n      requestedButFallbackMatched = true;",
    suites: ["tests/exactGradeOutranksCrossGrade.test.ts"],
    kills: "an unreadable grade borrows the largest other tier — the Maddux $361.49 shape",
  },
  {
    name: "swing-capture-null",
    doctrine: "CF-A-SWING-IS-NOT-A-MARKET (#1627) — observe the swing, never clamp it",
    file: "src/services/portfolioiq/portfolioStore.service.ts",
    find: "  const r = swingRatio(from, to);\n  return r !== null && r > ratio;",
    replace: "  return false;",
    suites: ["tests/repriceSwingAlarm.test.ts"],
    kills: "a 10.4x pool-composition flap persists in silence",
  },
  {
    name: "externalid-collapse",
    doctrine: "CF-DIFFERENT-EXTERNAL-ID-IS-TWO-SALES (#1638) — the pool is sacred",
    file: "scripts/lib/collision-triage.cjs",
    find: "  const s = String(raw).trim();\n  return s.length ? s : null;",
    replace: "  const s = String(raw).trim().split(\"::\")[0];\n  return s.length ? s : null;",
    suites: ["tests/collisionTriage.mutation.test.ts", "tests/chDailyExternalIdNeverCollapses.test.ts"],
    kills: "two real sales under one base id collapse into a single row",
  },
];

/** Run vitest over `suites` inside `cwd`. Returns { red, output }. */
function runSuites(cwd, suites) {
  const res = spawnSync(
    process.execPath,
    [path.join(backend, "node_modules", "vitest", "vitest.mjs"), "run", ...suites],
    { cwd, encoding: "utf8", timeout: 15 * 60 * 1000, env: { ...process.env, CI: "true" } },
  );
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { red: res.status !== 0, output, status: res.status };
}

/** A disposable copy of the tree: src + scripts + tests, symlinked node_modules
 *  so the copy is cheap and the canonical tree is never touched. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-mutation-"));
  for (const entry of ["src", "scripts", "tests", "tsconfig.json", "vitest.config.ts", "package.json"]) {
    const from = path.join(backend, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, entry), { recursive: true });
  }
  const nm = path.join(dir, "node_modules");
  try {
    fs.symlinkSync(path.join(backend, "node_modules"), nm, "junction");
  } catch {
    fs.cpSync(path.join(backend, "node_modules"), nm, { recursive: true });
  }
  return dir;
}

function main() {
  const selected = ONLY.length ? MUTANTS.filter((m) => ONLY.includes(m.name)) : MUTANTS;
  if (!selected.length) { console.error(`FATAL: no mutants matched MUTANTS=${ONLY.join(",")}`); process.exit(2); }

  console.log(`mutation-valuation-core  ${selected.length} doctrine-killing mutants`);
  console.log(`  a mutant that leaves the suite GREEN is a guard that has stopped guarding.\n`);

  const sandbox = makeSandbox();
  const results = [];

  try {
    // Baseline: the suites must be GREEN unmutated, or "red under a mutant"
    // proves nothing at all.
    const allSuites = [...new Set(selected.flatMap((m) => m.suites))];
    console.log(`BASELINE  ${allSuites.length} suites, unmutated`);
    const base = runSuites(sandbox, allSuites);
    if (base.red) {
      console.error(`FATAL: baseline is RED before any mutation — a mutant cannot be proven lethal against a broken baseline.`);
      console.error(base.output.split("\n").slice(-25).join("\n"));
      process.exit(2);
    }
    console.log(`  baseline GREEN\n`);

    for (const m of selected) {
      const target = path.join(sandbox, m.file);
      const original = fs.readFileSync(target, "utf8");
      // Anchors are authored with \n; the checkout may be CRLF (it is on
      // Windows, and core.autocrlf decides). Match against a normalized copy so
      // a line-ending difference can never be mistaken for a refactored guard.
      const normalized = original.replace(/\r\n/g, "\n");
      const occurrences = normalized.split(m.find).length - 1;
      if (occurrences !== 1) {
        console.error(`  ✗ ${m.name}: anchor matched ${occurrences} times in ${m.file} (expected exactly 1).`);
        console.error(`      The guard was refactored and this mutant no longer applies — the harness is auditing nothing.`);
        results.push({ ...m, caught: false, reason: `anchor matched ${occurrences}x` });
        continue;
      }
      fs.writeFileSync(target, normalized.replace(m.find, m.replace));
      const { red, output } = runSuites(sandbox, m.suites);
      fs.writeFileSync(target, original);

      if (red) {
        console.log(`  ✓ ${m.name}  CAUGHT — ${m.suites.join(" ")} went red`);
        console.log(`      doctrine: ${m.doctrine}`);
        results.push({ ...m, caught: true });
      } else {
        console.log(`  ✗ ${m.name}  SURVIVED — the suite stayed GREEN`);
        console.log(`      doctrine: ${m.doctrine}`);
        console.log(`      without the guard: ${m.kills}`);
        console.log(output.split("\n").slice(-15).join("\n"));
        results.push({ ...m, caught: false, reason: "suite stayed green" });
      }
    }
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const survived = results.filter((r) => !r.caught);
  console.log(`\n${"=".repeat(68)}`);
  console.log(`MUTATION DIGEST   ${results.length - survived.length}/${results.length} mutants caught`);
  console.log(`${"=".repeat(68)}`);
  for (const r of results) console.log(`  ${r.caught ? "✓" : "✗"} ${r.name.padEnd(22)} ${r.caught ? "caught" : `SURVIVED (${r.reason})`}`);

  if (survived.length) {
    console.log(`\n${survived.length} mutant(s) survived. A guard that cannot be broken by its own`);
    console.log(`killing edit is not protecting the doctrine it was written for.`);
    process.exit(1);
  }
  console.log(`\nevery doctrine-killing mutant was caught — the guards are load-bearing.`);
  process.exit(0);
}

try { main(); } catch (e) {
  console.error("FATAL (mutation harness):", e?.stack || e?.message || e);
  process.exit(2);
}
