/**
 * CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD, runner-wide (2026-09-04).
 *
 * #1756 fixed the two repair-tiffany lanes. This suite pins the GENERALISED
 * rule and the ONE shared helper every other whitelisted script now uses.
 *
 * THE DEFECT, restated. .github/workflows/backfill-runner.yml exports `slot`
 * and `slots` to EVERY script in its whitelist, and both carry workflow-wide
 * defaults -- `slot: "0"`, `slots: "16"`. So the near-universal binding
 *
 *   const SLOTS = Number(process.env.SLOTS ?? 1);   // never saw undefined
 *
 * bound 16, not 1, on every dispatch. Fifty-three scripts beyond the two
 * Tiffany lanes carried that exact read. Each one silently swept a sixteenth
 * of its population and reconciled honestly while doing it.
 *
 * The pins below are mutation-sensitive: revert the helper to
 * `Number(env.SLOTS ?? 1)` and the first test fails.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, "..");
const SCRIPTS = path.join(BACKEND, "scripts");
const RUNNER = path.join(BACKEND, "..", ".github", "workflows", "backfill-runner.yml");
const require_ = createRequire(import.meta.url);

type Scope = {
  SHARDED: boolean; SLOT: number; SLOTS: number; SLOTS_REQUESTED: number;
  SHARD_OPT_IN: boolean; inheritedDefault: boolean;
  mine: (i: number) => boolean; banner: () => string;
};
const { runnerShardScope } = require_(
  path.join(SCRIPTS, "lib", "runner-shard-scope.cjs"),
) as { runnerShardScope: (opts?: Record<string, unknown>) => Scope };

/** The exact env the runner hands every script when nobody chooses a shard. */
const OUTAGE_ENV = { SLOT: "0", SLOTS: "16" };

describe("runnerShardScope — an inherited slots is not a chosen shard", () => {
  it("THE OUTAGE, pinned: the runner's inherited slot=0 slots=16 sweeps EVERYTHING", () => {
    const r = runnerShardScope({ env: OUTAGE_ENV });
    expect(r.SHARDED, "an inherited default must never shard").toBe(false);
    expect(r.SLOTS, "SLOTS must bind 1 so `% SLOTS` covers every row").toBe(1);
    expect(r.inheritedDefault, "and it must KNOW it inherited, so the banner can say so").toBe(true);
  });

  it("an explicit non-zero slot DOES shard — a real fan-out still works", () => {
    const r = runnerShardScope({ env: { SLOT: "3", SLOTS: "16" } });
    expect(r.SHARDED).toBe(true);
    expect(r.SLOT).toBe(3);
    expect(r.SLOTS).toBe(16);
  });

  it("slot 0 of a REAL fan-out shards via the explicit opt-in", () => {
    // Without this a genuine 16-way run would double-cover slot 0's rows:
    // once as "everything", once as its own shard.
    const r = runnerShardScope({ env: { ...OUTAGE_ENV, SHARD: "true" } });
    expect(r.SHARDED).toBe(true);
    expect(r.SLOT).toBe(0);
    expect(r.SLOTS).toBe(16);
  });

  it("the opt-in accepts affirmative spellings and nothing else", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on"]) {
      expect(runnerShardScope({ env: { ...OUTAGE_ENV, SHARD: v } }).SHARDED, v).toBe(true);
    }
    for (const v of ["false", "0", "no", "off", "", "  ", "maybe"]) {
      expect(runnerShardScope({ env: { ...OUTAGE_ENV, SHARD: v } }).SHARDED, v).toBe(false);
    }
  });

  it("unset, empty and junk all sweep every row — never a modulo by zero", () => {
    const envs = [{}, { SLOT: "", SLOTS: "" }, { SLOT: "abc", SLOTS: "xyz" },
      { SLOT: "0", SLOTS: "1" }, { SLOTS: "0" }, { SLOTS: "-4" }];
    for (const env of envs) {
      const r = runnerShardScope({ env });
      expect(r.SHARDED, JSON.stringify(env)).toBe(false);
      expect(r.SLOTS, JSON.stringify(env)).toBe(1);
      expect(r.mine(0)).toBe(true);
      expect(r.mine(7), "unsharded, every shard index is mine").toBe(true);
    }
  });

  it("a CLI --slot is a CHOICE, including --slot 0, which no default produces", () => {
    const zero = runnerShardScope({ env: OUTAGE_ENV, slotArg: "0", slotsArg: "16" });
    expect(zero.SHARDED, "a typed flag opts in on its own").toBe(true);
    expect(zero.SLOTS).toBe(16);
    const five = runnerShardScope({ env: OUTAGE_ENV, slotArg: "5", slotsArg: "16" });
    expect(five.SLOT).toBe(5);
    // An ABSENT flag (the empty string these scripts pass when unset) must NOT
    // opt in -- otherwise every dispatch shards again and the fix is undone.
    const none = runnerShardScope({ env: OUTAGE_ENV, slotArg: "", slotsArg: "" });
    expect(none.SHARDED).toBe(false);
    expect(none.SLOTS).toBe(1);
  });

  it("alwaysShard lanes keep their fan-out — they declare it as their normal mode", () => {
    const r = runnerShardScope({ env: { SLOT: "0", SLOTS: "32" }, alwaysShard: true });
    expect(r.SHARDED).toBe(true);
    expect(r.SLOTS).toBe(32);
    expect(r.inheritedDefault, "a declared fan-out is not an inherited one").toBe(false);
  });

  it("mine() partitions exactly once across a real fan-out", () => {
    const SLOTS = 16;
    for (let key = 0; key < 64; key++) {
      const owners: number[] = [];
      for (let slot = 0; slot < SLOTS; slot++) {
        const r = runnerShardScope({
          env: { SLOT: String(slot), SLOTS: String(SLOTS), SHARD: "true" },
        });
        if (r.mine(key % SLOTS)) owners.push(slot);
      }
      expect(owners, `key ${key} must be owned by exactly one slot`).toHaveLength(1);
    }
  });

  it("the banner NAMES the under-coverage instead of printing `slot 0/16` as config", () => {
    const off = runnerShardScope({ env: OUTAGE_ENV, label: "x" }).banner();
    expect(off).toMatch(/sweeps EVERY row/);
    expect(off, "it must name the inherited default so nobody re-derives this from a log")
      .toMatch(/inherited default/);
    const on = runnerShardScope({ env: { SLOT: "3", SLOTS: "16" }, label: "x" }).banner();
    expect(on).toMatch(/COVERS 1\/16 OF THE POPULATION/);
    expect(on).toMatch(/dispatch every slot 0\.\.15/);
  });
});

describe("the runner's defaults are what make this necessary", () => {
  it("backfill-runner.yml still exports slot=0 and slots=16 to every script", () => {
    // If these defaults ever go away the helper can be simplified -- but until
    // then the tie CANNOT be broken from the environment.
    const yml = fs.readFileSync(RUNNER, "utf8");
    expect(yml).toMatch(/^ {6}slots:$/m);
    expect(yml).toMatch(/^ {6}slot:$/m);
    expect(yml).toMatch(/default: "16"/);
    expect(yml).toMatch(/default: "0"/);
  });
});

/** Every whitelisted script the runner can dispatch. */
function whitelist(): string[] {
  const yml = fs.readFileSync(RUNNER, "utf8");
  const start = yml.indexOf("type: choice");
  const end = yml.indexOf("      apply:", start);
  const block = yml.slice(start, end > start ? end : undefined);
  const names = block.split(/\r?\n/)
    .map((l) => /^\s+-\s+([A-Za-z0-9._-]+)\s*(?:#.*)?$/.exec(l)?.[1])
    .filter((x): x is string => Boolean(x));
  return [...new Set(names)];
}

// Lanes whose NORMAL mode is a fan-out: they declare their own multi-slot
// default and ARE always dispatched across every slot. Verified against
// September's run history: rematch-sold-comps walked 0..31/32, census-split-
// identity walked all 64 slots twice, normalize-catalog-format owns one
// row-balanced partition per dispatch by construction.
const ALWAYS_SHARD = new Set([
  "rematch-sold-comps",
  "normalize-catalog-format",
  "census-split-identity",
]);

// rematch-canary-check reads SLOT but does NOT gate a population with it: it
// asserts the dispatched shard HAS a canary, and refuses to certify when it
// does not. It already treats an empty SLOT as "no shard named" explicitly,
// which is the very distinction this helper exists to make. Nothing to fix.
const NO_POPULATION_GATE = new Set(["rematch-canary-check"]);

describe("no whitelisted script reads SLOT/SLOTS raw any more", () => {
  const scripts = whitelist().filter((s) => fs.existsSync(path.join(SCRIPTS, `${s}.cjs`)));

  it("the whitelist resolves to real scripts", () => {
    expect(scripts.length).toBeGreaterThan(100);
  });

  it("every script that shards uses the ONE shared helper, never its own copy", () => {
    const offenders: string[] = [];
    for (const s of scripts) {
      const src = fs.readFileSync(path.join(SCRIPTS, `${s}.cjs`), "utf8");
      // Strip comments: the fix's OWN explanation quotes the old expression.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/runnerShardScope/.test(code) || NO_POPULATION_GATE.has(s)) continue;
      // A binding of SLOT/SLOTS from the environment, in any of the spellings
      // found across the whitelist (direct, or through an env()/arg() wrapper).
      const bindsRaw = /(?:const|let|var)\s+SLOTS?\b[^;\n]*\bSLOTS?\b\s*[,)]?[^;\n]*(?:process\.env\.SLOTS?|env\(\s*"SLOTS?"|arg\(\s*"slots?")/.test(code)
        || /(?:const|let|var)\s+SLOTS?\s*=\s*[^;\n]*(?:process\.env\.SLOTS?|env\(\s*"SLOTS?"|arg\(\s*"slots?")/.test(code);
      if (bindsRaw) offenders.push(s);
    }
    expect(offenders, "these bind SLOTS themselves and will inherit the runner's 16").toEqual([]);
    // 60s, not the 30s default. This sweep reads every .cjs in the dropdown
    // (~130 files) synchronously; run ALONGSIDE the other shard suites, which
    // read the same set, the cold-cache I/O alone exceeds 30s and the suite
    // fails as a timeout rather than on any assertion. shardOptInWhitelist.test
    // .ts carries the identical widening on its own whole-dropdown sweep, for
    // the identical reason.
  }, 60_000);

  it("under the runner's OUTAGE env every sweep lane covers the whole population", () => {
    // The binding is a module-level const decided at require time, so it is
    // read out of the source and re-evaluated with the SAME options the script
    // passes. A lane that still shards here would silently cover 1/16th in
    // production, green and honestly reconciled.
    const sharding: string[] = [];
    const declared: string[] = [];
    for (const s of scripts) {
      const src = fs.readFileSync(path.join(SCRIPTS, `${s}.cjs`), "utf8");
      const m = /const SHARD_SCOPE = runnerShardScope\(([\s\S]*?)\);\n/.exec(src);
      if (!m) continue;
      // An absent CLI flag is the empty string; that is the dispatch case.
      const optsSrc = m[1].trim().replace(/arg\([^)]*\)/g, '""') || "{}";
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const opts = new Function(`return (${optsSrc})`)() as Record<string, unknown>;
      const r = runnerShardScope({ ...opts, env: OUTAGE_ENV });
      if (r.SHARDED) (ALWAYS_SHARD.has(s) ? declared : sharding).push(s);
    }
    expect(sharding, "these would sweep 1/16th of their population and reconcile honestly")
      .toEqual([]);
    expect(declared.sort(), "the declared fan-outs must KEEP sharding")
      .toEqual([...ALWAYS_SHARD].sort());
  });

  it("the one exempt lane earns its exemption — it never gates a population by shard", () => {
    // rematch-canary-check is exempt above. That exemption is only honest while
    // the script keeps treating an ABSENT slot as "no shard named" rather than
    // as slot 0, and keeps using SLOT to CHECK a shard rather than to filter
    // the rows it measures. If either changes, this pin fails and the
    // exemption has to be re-earned.
    const src = fs.readFileSync(path.join(SCRIPTS, "rematch-canary-check.cjs"), "utf8");
    expect(src, "an absent SLOT must stay distinguishable from slot 0")
      .toMatch(/process\.env\.SLOT === undefined \|\| process\.env\.SLOT === ""/);
    expect(src, "and it must still REFUSE a shard with no canary rather than pass it")
      .toMatch(/has NO canary/);
    expect(src, "it must not read SLOTS at all — it does not partition anything")
      .not.toMatch(/process\.env\.SLOTS\b/);
  });
});
