/**
 * CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD — the runner's opt-in LIST,
 * pinned (2026-09-05).
 *
 * THE GAP THIS CLOSES. #1756 taught the scripts the rule ("an inherited
 * slot=0 slots=16 is not a chosen shard") and #1765 moved it into the one
 * helper, runner-shard-scope.cjs. Both halves are already pinned:
 * runnerShardScope.test.ts holds the helper's decision table and
 * shardingIsOptIn.test.ts holds the two Tiffany lanes' bindings.
 *
 * Neither pins the half that actually reaches a dispatch: the WORKFLOW's
 * `SHARD:` expression, which decides for WHICH scripts `parents_only == true`
 * becomes SHARD=true. retire-self-derived-identities had the rule in its code,
 * a proven 16-slot axis in #1799, and a budget that #1803 fitted under the step
 * ceiling — and still could not fan out, because it was not on that line. The
 * dispatch came back
 *
 *   sharding OFF -- this run sweeps EVERY row (slots=16 is the runner's
 *   inherited default, not a chosen shard; pass SHARD=true with slot=0 to
 *   fan out)
 *
 * which is the helper working correctly and the workflow not carrying the
 * signal. A lane can only be one line of YAML away from a silent full sweep
 * once, so the line is now parsed and asserted rather than read.
 *
 * WHAT IS ASSERTED, and why each is a real failure mode:
 *
 *   (1) every script named on the SHARD line exists in the dropdown whitelist
 *       — an opt-in for a script nobody can dispatch is dead YAML, and a typo
 *         in a script name fails EXACTLY this way, silently.
 *   (2) every script named on the SHARD line actually calls runnerShardScope
 *       — the opt-in is meaningless to a script that never reads SHARD, and
 *         its presence would advertise a fan-out that does not exist.
 *   (3) none of them passes `alwaysShard: true`
 *       — those scripts (rematch-sold-comps, normalize-catalog-format,
 *         census-split-identity) shard on the env alone and are NOT the
 *         ambiguity this opt-in exists to resolve; listing one would be a sign
 *         the rule had been misunderstood.
 *   (4) the signal is `parents_only == true`, on a BOOLEAN input, and no new
 *       workflow_dispatch input was claimed (24 of GitHub's 25 are used).
 *   (5) a lane whose relaunch step re-dispatches itself forwards
 *       `parents_only` — a slot-0 continuation that dropped it would rebind
 *       as an inherited default and widen from one shard to a full sweep
 *       mid-fleet.
 *
 * MUTATION-SENSITIVE BY CONSTRUCTION. Drop retire-self-derived-identities
 * (or either Tiffany lane) from the SHARD expression and the coverage test
 * fails BY NAME. Misspell a script there and (1) fails. Point it at a script
 * that does not shard and (2) fails. Drop the `parents_only` forward from the
 * retire lane's relaunch and (5) fails.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const RUNNER = read(".github", "workflows", "backfill-runner.yml");

/** The single `SHARD:` env export, as one logical line. */
function shardExpression(): string {
  const line = RUNNER.split("\n").find((l) => /^\s+SHARD:\s/.test(l));
  expect(line, "backfill-runner.yml must export SHARD").toBeTruthy();
  return line as string;
}

/** The scripts the SHARD expression names — parsed out of the `${{ ... }}`
 *  expression itself, never listed here, so this suite reads whatever the
 *  workflow currently says rather than what it said when this was written. */
function optedInScripts(): string[] {
  return [...shardExpression().matchAll(/inputs\.script\s*==\s*'([^']+)'/g)].map((m) => m[1]);
}

/** Every script name the dropdown can dispatch. The whitelist IS the surface:
 *  a script nobody can dispatch cannot opt into anything. Same parse the
 *  #1803 budget pin uses, deliberately — one reading of the dropdown. */
function whitelistedScripts(): string[] {
  const blk = RUNNER.slice(RUNNER.indexOf("      script:"));
  const m = /options:\n((?:\s*(?:-|#).*\n)+)/.exec(blk);
  expect(m, "the script input must declare its options list").toBeTruthy();
  return (m as RegExpExecArray)[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

/** A dispatchable script's source, or null when no .cjs answers to that name.
 *  Memoised: the whitelist is ~130 scripts and two suites below sweep all of
 *  them, which is enough cold-cache I/O to blow vitest's 30s default when the
 *  file runs alongside others. */
const SRC_CACHE = new Map<string, string | null>();
function sourceOf(script: string): string | null {
  if (!SRC_CACHE.has(script)) {
    const p = path.join(ROOT, "backend", "scripts", `${script}.cjs`);
    SRC_CACHE.set(script, fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") : null);
  }
  return SRC_CACHE.get(script) ?? null;
}

const OPTED_IN = optedInScripts();

describe("the runner's SHARD opt-in names real, shardable lanes", () => {
  it("the expression names at least the three lanes with a proven shard axis", () => {
    // Not an exhaustive list — new lanes may join. This is the mutation guard:
    // removing any of these from the workflow turns this red BY NAME, which is
    // exactly the failure retire-self-derived-identities shipped with.
    for (const script of [
      "repair-tiffany-pool-enumeration",
      "repair-tiffany-rung-to-product",
      "retire-self-derived-identities",
    ]) {
      expect(OPTED_IN, `${script} must be able to opt slot 0 into its fan-out`).toContain(script);
    }
  });

  it("every opted-in script is in the dropdown whitelist — no dead or typo'd names", () => {
    const whitelist = new Set(whitelistedScripts());
    const strays = OPTED_IN.filter((s) => !whitelist.has(s));
    expect(strays, "an opt-in for an undispatchable script is dead YAML").toEqual([]);
  });

  it("every opted-in script actually reads the opt-in, via the ONE helper", () => {
    const deaf: string[] = [];
    for (const script of OPTED_IN) {
      const src = sourceOf(script);
      expect(src, `${script}.cjs must exist to be dispatched`).toBeTruthy();
      // Either the shared helper (#1765) or, for the two lanes that predate it
      // and still carry the inlined rule (#1756), a direct SHARD read.
      const readsOptIn = /runnerShardScope\(/.test(src as string)
        || /process\.env\.SHARD\b/.test(src as string);
      if (!readsOptIn) deaf.push(script);
    }
    expect(deaf, "these scripts are offered an opt-in they never read").toEqual([]);
  });

  it("no opted-in script is an alwaysShard lane — that is a different rule", () => {
    // rematch-sold-comps / normalize-catalog-format / census-split-identity
    // declare sharding as their normal mode and shard on the env alone. They
    // have no slot-0 ambiguity to resolve, so listing one would mean the rule
    // had been misread.
    const wrong = OPTED_IN.filter((s) => /alwaysShard:\s*true/.test(sourceOf(s) ?? ""));
    expect(wrong, "an alwaysShard lane does not need — and must not use — this opt-in").toEqual([]);
  });
});

describe("the opt-in signal itself", () => {
  it("rides parents_only == true, and claims no new dispatch input", () => {
    const expr = shardExpression();
    expect(expr, "the explicit signal is the boolean input, not a slots comparison")
      .toContain("inputs.parents_only == true");
    // The rejected alternative, pinned as rejected: `slots != 16` would refuse
    // to shard the one width the budget arithmetic recommends and would shard a
    // typo'd slots=15 by accident.
    expect(expr).not.toMatch(/inputs\.slots\s*!=/);
  });

  it("parents_only is declared BOOLEAN, so its default can never opt anyone in", () => {
    const block = RUNNER.slice(RUNNER.indexOf("      parents_only:"));
    const decl = block.slice(0, block.indexOf("\n      mode:"));
    expect(decl).toMatch(/type:\s*boolean/);
    expect(decl).toMatch(/default:\s*false/);
  });

  it("dispatch inputs stay at 24 of GitHub's 25 — the opt-in bought no new one", () => {
    const block = RUNNER.slice(RUNNER.indexOf("workflow_dispatch:"), RUNNER.indexOf("\npermissions:"));
    const inputs = [...block.matchAll(/^ {6}([a-z_0-9]+):$/gm)].map((m) => m[1]);
    expect(inputs.length, "workflow_dispatch is capped at 25 inputs").toBeLessThanOrEqual(24);
    expect(inputs).toContain("parents_only");
  });

  it("only ONE script reads PARENTS_ONLY, and it is not an opted-in lane", () => {
    // The whole reason this input is safe to reuse as a signal: no lane on the
    // SHARD line has a competing meaning for it. A READ is `process.env.
    // PARENTS_ONLY` or an `env("PARENTS_ONLY", ...)` helper — not the name
    // appearing in a header comment, which several lanes now do precisely
    // BECAUSE they document that they never read it.
    const READS_PARENTS_ONLY =
      /(?:process\.)?env\s*(?:\.\s*PARENTS_ONLY\b|\[\s*["']PARENTS_ONLY["']\s*\]|\(\s*["']PARENTS_ONLY["'])/;
    const readers = whitelistedScripts()
      .filter((s) => READS_PARENTS_ONLY.test(sourceOf(s) ?? ""));
    expect(readers).toEqual(["rehome-catalog-rows-to-own-partition"]);
    expect(OPTED_IN).not.toContain("rehome-catalog-rows-to-own-partition");
    // 60s, not the 30s default: this is the one test here that reads every
    // script in the dropdown (~130 files), and on a cold cache alongside other
    // suites that is enough I/O to time out on the default.
  }, 60_000);
});

describe("a self-relaunching lane keeps its shard across a budget stop", () => {
  /** The relaunch step for one script: the `gh workflow run` line that
   *  re-dispatches it. A continuation is a fresh dispatch, so every input that
   *  carries meaning has to be forwarded explicitly. */
  function relaunchDispatch(script: string): string | undefined {
    return RUNNER.split("\n").find(
      (l) => l.includes("gh workflow run backfill-runner.yml") && l.includes(`-f script=${script} `),
    );
  }

  for (const script of OPTED_IN) {
    const line = relaunchDispatch(script);
    // Not every lane self-relaunches; only the ones that do are asserted.
    if (!line) continue;
    it(`${script}'s relaunch forwards parents_only`, () => {
      expect(line, `a slot-0 continuation of ${script} that drops the opt-in silently widens `
        + "from one shard to a full sweep mid-fleet").toContain("-f parents_only=");
      // And it must keep carrying the shard coordinates themselves.
      expect(line).toContain("-f slot=");
      expect(line).toContain("-f slots=");
    });
  }
});
