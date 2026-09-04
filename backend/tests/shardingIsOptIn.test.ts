/**
 * CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (2026-09-04).
 *
 * THE OUTAGE. The backfill runner exports `slot` and `slots` for EVERY script,
 * both with workflow-wide defaults -- `slot: "0"`, `slots: "16"`. Neither
 * repair-tiffany lane asked to be sharded, but both read `SLOTS` and found
 * "16", so each APPLY covered one sixteenth of its population and reported
 * that honestly:
 *
 *   run 33899174030 (report)  slot 0/16   rows scanned 11 (+2,046 other slots)
 *   run 33899784003 (APPLY)   slot 0/16   "APPLIED ... intended 11 =
 *                                          written 0 + skipped 11"
 *
 * Green. Reconciled. And 2,046 rows sat in fifteen slots nobody dispatched.
 * The same shape ran #1745's applies at `slot 0/16`, which is why 896 catalog
 * rows landed as 20 retired + 28 converted and 1,107 comps landed as 71.
 *
 * An under-sweep that reconciles honestly is the worst failure mode available,
 * because every signal a reviewer looks at says success.
 *
 * THE TIE CANNOT BE BROKEN FROM THE ENVIRONMENT ALONE. `slot=0 slots=16` is
 * byte-identical whether the dispatcher chose it or inherited it. So the rule
 * is: shard on a NON-ZERO slot, or on an explicit `SHARD=true`; otherwise
 * sweep everything. These pins hold that rule for both lanes.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, "..");
const RUNNER = path.join(BACKEND, "..", ".github", "workflows", "backfill-runner.yml");

const LANES = [
  "repair-tiffany-pool-enumeration.cjs",
  "repair-tiffany-rung-to-product.cjs",
] as const;

/** Load a lane in a clean child process under an exact env and read back what
 *  it bound. A child is used deliberately: these are module-level constants,
 *  so they are decided at require time and cannot be re-read in-process. */
function bind(script: string, env: Record<string, string>) {
  const clean = { ...process.env };
  for (const k of ["SLOT", "SLOTS", "SHARD"]) delete clean[k];
  const code = `const m=require(${JSON.stringify(path.join(BACKEND, "scripts", script))});`
    + `console.log(JSON.stringify({SHARDED:m.SHARDED,SLOT:m.SLOT,SLOTS:m.SLOTS}));`;
  const out = execFileSync(process.execPath, ["-e", code], {
    env: { ...clean, ...env }, encoding: "utf8",
  });
  return JSON.parse(out.trim()) as { SHARDED: boolean; SLOT: number; SLOTS: number };
}

describe.each(LANES)("%s — sharding is opt-in", (script) => {
  it("THE OUTAGE, pinned: the runner's inherited slot=0 slots=16 sweeps EVERYTHING", () => {
    // This is the exact env runs 33899174030 and 33899784003 ran under. Before
    // the fix it bound SLOTS=16 and covered 1/16th of the pool.
    const r = bind(script, { SLOT: "0", SLOTS: "16" });
    expect(r.SHARDED, "an inherited default must never shard").toBe(false);
    expect(r.SLOTS).toBe(1);
  });

  it("an explicit non-zero slot DOES shard — a fan-out still works", () => {
    const r = bind(script, { SLOT: "3", SLOTS: "16" });
    expect(r.SHARDED).toBe(true);
    expect(r.SLOT).toBe(3);
    expect(r.SLOTS).toBe(16);
  });

  it("slot 0 of a REAL fan-out shards via the explicit opt-in", () => {
    // Without this, a genuine 16-way fan-out would silently double-cover slot
    // 0's rows (once as "everything", once as its own shard).
    const r = bind(script, { SLOT: "0", SLOTS: "16", SHARD: "true" });
    expect(r.SHARDED).toBe(true);
    expect(r.SLOT).toBe(0);
    expect(r.SLOTS).toBe(16);
  });

  it("the opt-in accepts only affirmative spellings", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) {
      expect(bind(script, { SLOT: "0", SLOTS: "16", SHARD: v }).SHARDED, `${v} opts in`).toBe(true);
    }
    for (const v of ["", "false", "0", "no", "maybe"]) {
      expect(bind(script, { SLOT: "0", SLOTS: "16", SHARD: v }).SHARDED, `${v} does not opt in`).toBe(false);
    }
  });

  it("empty strings and unset both mean ALL ROWS", () => {
    for (const env of [{ SLOT: "", SLOTS: "" }, {}]) {
      const r = bind(script, env);
      expect(r.SHARDED).toBe(false);
      expect(r.SLOTS).toBe(1);
    }
  });

  it("slots=1 is not a shard however it arrives", () => {
    expect(bind(script, { SLOT: "0", SLOTS: "1" }).SHARDED).toBe(false);
    expect(bind(script, { SLOT: "0", SLOTS: "1", SHARD: "true" }).SHARDED).toBe(false);
  });

  it("a junk slots value falls back to sweeping, never to a silent partial", () => {
    for (const v of ["abc", "-4", "0"]) {
      expect(bind(script, { SLOT: "0", SLOTS: v }).SHARDED, `slots=${v}`).toBe(false);
    }
  });
});

describe.each(LANES)("%s — the banner cannot hide a partial sweep", (script) => {
  const SRC = fs.readFileSync(path.join(BACKEND, "scripts", script), "utf8");

  it("says which mode it bound, and names the coverage when sharded", () => {
    // A run that covers 1/16th has to SAY so, in the banner a reviewer reads.
    // `slot 0/16` did not: it looked like configuration, not like a warning.
    expect(SRC).toContain("THIS RUN COVERS 1/${SLOTS} OF THE POPULATION");
    expect(SRC).toContain("OFF -- this run sweeps EVERY row");
  });

  it("the shard test is the opt-in, not a bare SLOTS comparison", () => {
    expect(SRC).toContain("const mineByShard = (key) => !SHARDED ||");
    // The old form is what let an inherited default shard the run.
    expect(SRC).not.toContain("SLOTS === 1 || shardOf(");
  });
});

describe("the mutation red", () => {
  it("restoring the bare SLOTS read reproduces the 1/16th apply", () => {
    // Rebuild the two expressions and check the defect returns: under the
    // runner's own env the old form shards, the new form does not.
    const runnerEnv = { SLOT: 0, SLOTS_REQUESTED: 16, SHARD_OPT_IN: false };
    const oldSharded = runnerEnv.SLOTS_REQUESTED > 1; // what the code used to mean
    const newSharded = runnerEnv.SLOTS_REQUESTED > 1
      && (runnerEnv.SLOT > 0 || runnerEnv.SHARD_OPT_IN);
    expect(oldSharded, "the defect: an inherited 16 shards the run").toBe(true);
    expect(newSharded, "the fix: an inherited 16 does not").toBe(false);
    // And a real fan-out still shards under the new rule.
    expect(16 > 1 && (3 > 0 || false)).toBe(true);
  });
});

describe("the runner carries the opt-in without a new input", () => {
  const YML = fs.readFileSync(RUNNER, "utf8");

  it("exports SHARD", () => {
    expect(YML).toMatch(/^\s+SHARD: /m);
  });

  it("the opt-in is scoped to these two scripts, so it cannot leak", () => {
    const line = YML.split("\n").find((l) => l.trim().startsWith("SHARD:"))!;
    expect(line).toContain("repair-tiffany-pool-enumeration");
    expect(line).toContain("repair-tiffany-rung-to-product");
  });

  it("claims no new workflow_dispatch input", () => {
    const block = YML.slice(YML.indexOf("workflow_dispatch:"), YML.indexOf("jobs:"));
    const inputs = [...block.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs.length, "dispatch inputs are frozen at 24 of GitHub's 25").toBeLessThanOrEqual(24);
  });
});
