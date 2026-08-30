/**
 * D29/R2 -- the fleet contract for apply-cpa-product-rule.cjs.
 *
 * A fleet script's shape is load-bearing and every clause here is a bug we
 * already shipped once:
 *
 *   the exit-1 refusal   MODE=source with no SOURCES defaulted to
 *                        baseballcardpedia and reported 13.14M rows
 *                        (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME)
 *   the budget marker    the relaunch step greps this EXACT string; a job that
 *                        is killed cannot print it, and a marker that drifts by
 *                        one character silently stops every relaunch
 *                        (CF-RELAUNCH-GATES-ON-THE-BUDGET-MARKER)
 *   BACKFILL_APPLY       the runner exports BACKFILL_APPLY, not APPLY; an
 *                        "APPLY" dispatch once ran report-only with plausible
 *                        counters (CF-RUNNER-EXPORTS-BACKFILL-APPLY)
 *   disjoint counters    a sub-total of `written` counted again as `skipped`
 *                        reconciles to nonsense (CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER)
 *
 * The refusals are executed for real -- a subprocess, its actual exit code --
 * because a refusal that is only asserted by reading the source is not a
 * refusal. They run WITHOUT a Cosmos connection string on purpose: the scope
 * check must fire before anything reaches the network.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BACKEND = path.resolve(__dirname, "..");
const SCRIPT = path.join(BACKEND, "scripts", "apply-cpa-product-rule.cjs");
const SRC = readFileSync(SCRIPT, "utf8");

/**
 * Run the script and return { code, out }. Never throws on a non-zero exit.
 *
 * `delete`, not `= ""`, for the scope vars: the script deliberately
 * distinguishes UNSET (take the default) from SET-BUT-EMPTY (a widening, which
 * it refuses), so blanking them here would test the wrong branch. Vitest also
 * puts MODE=test in the environment, which is exactly the ambient-value trap
 * this helper has to clear.
 */
function run(env: Record<string, string>): { code: number; out: string } {
  // The env is REPLACED, not spread over process.env: inheriting an ambient
  // SPORTS/YEARS/FAMILY would hand the script the very scope these tests assert
  // it does not have, and vitest itself puts MODE=test in the environment --
  // exactly the ambient-value trap. Only the vars node needs to start are kept.
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    COMSPEC: process.env.COMSPEC ?? "",
  };
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      // cwd is pinned to backend/ so the run does not depend on where vitest
      // was invoked from.
      cwd: BACKEND,
      env: { ...base, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("apply-cpa-product-rule refuses an unscoped write", () => {
  it("exits 1 when MODE is missing -- there is no default mode", () => {
    const r = run({ COSMOS_CONNECTION_STRING: "x" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/MODE is required and has no default/);
  });

  it("exits 1 on an unknown MODE rather than falling through to a default", () => {
    const r = run({ COSMOS_CONNECTION_STRING: "x", MODE: "everything" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unknown MODE/);
  });

  it("exits 1 when FAMILY is emptied without SCOPE=all -- that is every product", () => {
    const r = run({ COSMOS_CONNECTION_STRING: "x", MODE: "report", FAMILY: "" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAMILY is empty/);
  });

  it("exits 1 when YEARS names no year, instead of scanning all of them", () => {
    const r = run({ COSMOS_CONNECTION_STRING: "x", MODE: "report", YEARS: "2026-2020" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/names no year/);
  });

  it("exits 1 when PREFIXES is emptied -- R2 was ruled on CPA/BCPA numbers", () => {
    const r = run({ COSMOS_CONNECTION_STRING: "x", MODE: "report", PREFIXES: "" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PREFIXES is empty/);
  });

  it("puts every refusal AHEAD of every require that can throw, so a stale dist cannot fake it", () => {
    // The defect #1565 fixed for fold-checklist-numbered-twins, and the one
    // this branch shipped: the refusals sat inside main(), BELOW top-level
    // requires of @azure/cosmos and four dist/ modules. With a stale or absent
    // dist the process died on MODULE_NOT_FOUND -- which also exits 1 -- so the
    // `code` assertions above passed for the wrong reason and only the message
    // assertions caught it. Assert the ORDER in the source, not just the
    // observed exit code, because an exit code cannot tell the two apart.
    const refusals = [
      "MODE is required and has no default",
      "unknown MODE",
      "names no year",
      "SPORTS is empty",
      "PREFIXES is empty",
      "FAMILY is empty",
    ].map((msg) => {
      const at = SRC.indexOf(msg);
      expect(at, `refusal not found in source: ${msg}`).toBeGreaterThan(-1);
      return at;
    });
    const last = Math.max(...refusals);

    // Every top-level require EXCEPT the node builtins `path` and `crypto`,
    // which cannot fail to resolve, must come after the LAST refusal.
    const risky = [...SRC.matchAll(/^[ \t]*(?:const|let|var)\b[^\n]*\brequire\([^\n]*$/gm)]
      .filter((m) => !/require\((["'])(?:node:)?(?:path|crypto)\1\)/.test(m[0]));

    expect(risky.length).toBeGreaterThan(0);
    for (const m of risky) expect(m.index ?? 0).toBeGreaterThan(last);
  });

  it("exits 1 with no connection string, before touching the network", () => {
    const r = run({ MODE: "report" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/COSMOS_CONNECTION_STRING not set/);
  });
});

describe("the fleet contract", () => {
  it("prints the budget marker EXACTLY as the relaunch step greps it", () => {
    // .github/workflows/backfill-runner.yml greps /stopped at the .*budget/.
    expect(SRC).toContain("stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here");
  });

  it("reads BACKFILL_APPLY, which is what the runner actually exports", () => {
    expect(SRC).toMatch(/process\.env\.BACKFILL_APPLY/);
  });

  it("defaults to writing NOTHING -- apply is opt-in", () => {
    expect(SRC).toMatch(/const APPLY = String\(process\.env\.BACKFILL_APPLY \|\| process\.env\.APPLY \|\| ""\) === "true"/);
    // and dryRun is derived from it, never hardcoded false
    expect(SRC).toMatch(/dryRun: !APPLY \|\| MODE !== "fold"/);
  });

  it("shards on the identity key and takes concurrency from the runner", () => {
    expect(SRC).toMatch(/process\.env\.SLOT/);
    expect(SRC).toMatch(/process\.env\.SLOTS/);
    expect(SRC).toMatch(/process\.env\.BACKFILL_CONCURRENCY/);
    expect(SRC).toMatch(/shardOf\(k\) === SLOT/);
  });

  it("queries serially -- card_catalog at 100 RU/s hangs on the default fan-out", () => {
    expect(SRC).toMatch(/maxDegreeOfParallelism: 1/);
    expect(SRC).toMatch(/bufferItems: false/);
  });

  it("moves rows through catalogRowOps and sales through its salesContainer, never by hand", () => {
    expect(SRC).toMatch(/moveCatalogRow/);
    expect(SRC).toMatch(/salesContainer: pool/);
    // no hand-rolled delete/upsert of catalog rows
    expect(SRC).not.toMatch(/cat\.items\.upsert|cat\.item\([^)]*\)\.delete/);
  });

  it("reconciles with DISJOINT counters -- no sub-total is counted twice", () => {
    const call = /reportWrites\(\{[\s\S]*?\}\);/.exec(SRC)?.[0] ?? "";
    expect(call, "reportWrites must be called").toBeTruthy();
    const written = /written: ([^,]+),/.exec(call)?.[1] ?? "";
    const skipped = /skipped: ([^,]+),/.exec(call)?.[1] ?? "";
    expect(written.trim()).toBe("s.foldGroups");
    // the written counter must not reappear inside skipped
    expect(skipped).not.toContain("foldGroups");
    expect(skipped).not.toContain("s.moved");
    expect(skipped).not.toContain("s.folded");
    expect(skipped).not.toContain("s.replaced");
    // and `notReached` must be intended, not silently dropped (a budget stop
    // otherwise over-accounts)
    expect(call).toMatch(/intended: s\.identities \+ s\.notReached/);
    expect(skipped).toContain("notReached");
  });

  it("asks the tested rule for the decision instead of re-implementing it", () => {
    expect(SRC).toMatch(/require\(path\.join\(backend, "dist\/services\/catalog\/cpaProductRule\.js"\)\)/);
    expect(SRC).toMatch(/decideCpaProduct\(/);
  });
});

describe("the runner is wired for this script", () => {
  const YML = readFileSync(path.resolve(__dirname, "../../.github/workflows/backfill-runner.yml"), "utf8");

  it("is on the whitelist", () => {
    expect(YML).toMatch(/^\s+- apply-cpa-product-rule$/m);
  });

  it("has a marker-keyed self-relaunch that forwards the whole scope verbatim", () => {
    const step = /Self-relaunch the CPA product rule[\s\S]*?(?=\n      - name:|\n\n      -)/.exec(YML)?.[0] ?? "";
    expect(step, "the relaunch step must exist").toBeTruthy();
    // CF-RELAUNCH-GATES-ON-THE-BUDGET-MARKER: on the marker only, never a count,
    // never on cancel.
    expect(step).toMatch(/stopped at the \.\*budget/);
    expect(step).toMatch(/!cancelled\(\)/);
    expect(step).toMatch(/inputs\.apply == true/);
    for (const input of ["slot", "slots", "mode", "concurrency", "sports", "scope"]) {
      expect(step, `relaunch must forward ${input}`).toContain(`inputs.${input}`);
    }
  });
});
