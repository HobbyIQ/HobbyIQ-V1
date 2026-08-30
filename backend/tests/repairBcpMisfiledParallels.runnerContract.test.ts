/**
 * D33 -- the contract between repair-bcp-misfiled-parallels.cjs and the
 * backfill runner. Three things break silently when they drift, and each has
 * cost a real run before:
 *
 *  1. The script must be on the runner's whitelist, or the dispatch is rejected.
 *  2. The budget line must be the EXACT string the relaunch step greps. A job
 *     that stops at its budget but prints a different sentence never relaunches,
 *     and the fleet quietly does a fraction of the work (CF-RELAUNCH-ONLY-ON-
 *     BUDGET, #1361).
 *  3. The relaunch must forward MODE. This script exits 1 without one, so a
 *     relaunch that dropped it would fail every continuation.
 *
 * And the one that is not about the runner: MODE has no default, because a
 * whole-scope write that picks its own population is the shape that reported
 * 13.14M rows for a source nobody named.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..");
const runner = readFileSync(join(repoRoot, ".github", "workflows", "backfill-runner.yml"), "utf8");
const script = readFileSync(join(__dirname, "..", "scripts", "repair-bcp-misfiled-parallels.cjs"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MODES } = require("../scripts/repair-bcp-misfiled-parallels.cjs");

describe("the runner can dispatch this script", () => {
  it("is on the script whitelist", () => {
    expect(runner).toContain("          - repair-bcp-misfiled-parallels\n");
  });

  it("documents every mode on the `mode` input, so a dispatcher can find them", () => {
    const modeInput = runner.slice(runner.indexOf("      mode:"), runner.indexOf("      shard_hex:"));
    for (const m of MODES) expect(modeInput).toContain(`'${m}'`);
  });

  it("has a relaunch step keyed to this script and gated on apply", () => {
    expect(runner).toContain("inputs.script == 'repair-bcp-misfiled-parallels' && inputs.apply == true");
  });

  it("the relaunch never fires on a cancel", () => {
    const step = runner.slice(runner.indexOf("Self-relaunch the misfiled-parallel repair"));
    expect(step.slice(0, 2000)).toContain("!cancelled()");
  });
});

describe("the budget marker the relaunch greps is the one the script prints", () => {
  it("the script prints the exact sentence", () => {
    // Character for character, em dash included.
    expect(script).toContain("`\\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`");
  });

  it("the runner greps a pattern that sentence matches", () => {
    const step = runner.slice(runner.indexOf("Self-relaunch the misfiled-parallel repair"));
    const grep = step.slice(0, 2500).match(/grep -aqE "([^"]+)"/);
    expect(grep).not.toBeNull();
    const printed = "\nstopped at the 140-minute budget — the relaunch continues from here";
    expect(new RegExp(grep![1]).test(printed)).toBe(true);
  });

  it("the count the relaunch reads is the line the script prints on APPLY", () => {
    const step = runner.slice(runner.indexOf("Self-relaunch the misfiled-parallel repair"));
    const grep = step.slice(0, 2500).match(/grep -aoE "(\^  CHANGED[^"]+)"/);
    expect(grep).not.toBeNull();
    // The APPLY branch of the summary prints "  CHANGED" with the padding.
    expect(new RegExp(grep![1]).test("  CHANGED                 47,267")).toBe(true);
  });

  it("forwards MODE, without which the relaunch would exit 1 every time", () => {
    const step = runner.slice(runner.indexOf("Self-relaunch the misfiled-parallel repair"));
    const dispatch = step.slice(0, 2500);
    expect(dispatch).toContain("-f mode=");
    for (const input of ["slot", "slots", "scope", "sources", "sports", "years", "concurrency"]) {
      expect(dispatch).toContain(`-f ${input}=`);
    }
  });
});

describe("a whole-scope write refuses to guess its own scope", () => {
  it("MODE has no default in the script", () => {
    expect(script).toContain('const MODE = String(process.env.MODE || "").trim().toLowerCase();');
    expect(script).not.toMatch(/process\.env\.MODE \|\| "(card-as-parallel|chrome-ladder|first-edition|names|number-glued)"/);
  });

  it("exits 1 when MODE is absent or unknown", () => {
    expect(script).toContain("FATAL: MODE is required and has no default");
    expect(script).toContain('FATAL: unknown MODE');
    // Both paths exit 1 (a scope refusal), not 3 (a crash).
    const fatalBlock = script.slice(script.indexOf("FATAL: MODE is required"), script.indexOf("COSMOS_CONNECTION_STRING not set"));
    expect(fatalBlock).toContain("process.exit(1)");
  });

  it("shards by sha1(id), not by setKey", () => {
    // CF-SHARD-AXIS-MUST-BE-GUARANTEED-AND-MEASURED: four products would put
    // roughly half the population on one worker.
    expect(script).toContain('crypto.createHash("sha1").update(String(id))');
    expect(script).not.toMatch(/shardOf\s*=\s*\([^)]*\)\s*=>[^;]*setKey/);
  });

  it("reads BACKFILL_APPLY as well as APPLY -- the runner exports the former", () => {
    // CF-RUNNER-EXPORTS-BACKFILL-APPLY: an "APPLY" dispatch once ran report-only
    // with entirely plausible counters.
    expect(script).toContain('process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"');
  });

  it("takes CONCURRENCY from BACKFILL_CONCURRENCY, which is what the runner sets", () => {
    expect(script).toContain("process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY");
  });
});

describe("every write goes through catalogRowOps", () => {
  it("uses moveCatalogRow and retireCatalogRow, and never deletes or upserts a catalog row itself", () => {
    expect(script).toContain("moveCatalogRow");
    expect(script).toContain("retireCatalogRow");
    // The only direct catalog write is the MODE=names patch, which changes no
    // id and so is a patch by definition, exactly as the D15 precedent does it.
    const directDeletes = script.match(/cat\.item\([^)]*\)\.delete\(/g) ?? [];
    expect(directDeletes).toHaveLength(0);
    const directUpserts = script.match(/cat\.items\.upsert\(/g) ?? [];
    expect(directUpserts).toHaveLength(0);
  });

  it("passes salesContainer on every move, so no sale is stranded", () => {
    const moves = script.match(/moveCatalogRow\(cat, row, newSlug,[\s\S]*?\}\);/g) ?? [];
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (const m of moves) expect(m).toContain("salesContainer: sold");
  });

  it("passes dryRun on every move and retire, so REPORT ONLY writes nothing", () => {
    const calls = script.match(/(moveCatalogRow|retireCatalogRow)\([\s\S]*?\}\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c).toContain("dryRun");
  });

  it("never writes a parallel onto a row it could not place", () => {
    // retire-prose-parallel-rows' rule: unplaceable is reported, never Base.
    expect(script).not.toMatch(/value:\s*"Base"/);
    expect(script).toContain("never mint");
  });
});
