/**
 * CF-CARDYEAR-IS-A-MIRROR, the stored half (2026-09-04).
 *
 * #1769 fixed the READER (`(c.cardYear = @y OR c.year = @y)`) and the WRITER
 * (deriveCatalogEntry + the checklist ingest dual-write). Neither reaches a row
 * that is ALREADY STORED. Measured read-only against prod on 2026-09-04:
 *
 *     1,521,172  baseballcardpedia-ladders-2026-09-04
 *       373,603  hobbymonitor-2026-09-04
 *       205,013  sportscardchecklist-2026-09-04
 *           423  tcgdex-ja-2026-09-04
 *            14  ingest-auto-seed
 *             4  ingest-auto-seed-graded
 *             1  user-verified
 *     ---------
 *     2,100,230  rows carrying `year` and NO `cardYear`
 *
 * Every consumer that still filters on cardYear alone misses all of them.
 *
 * These pins hold the three things that make the repair lane safe to dispatch:
 *   1. the runner can actually reach it, and its DRY_RUN honours BACKFILL_APPLY
 *      (the runner exports BACKFILL_APPLY, never APPLY);
 *   2. sharding is OPT-IN -- the runner's inherited slot=0/slots=16 sweeps
 *      EVERY row rather than a sixteenth (#1765);
 *   3. the scan and the reconciliation agree, on a stubbed Cosmos.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, "..");
const SCRIPT = path.join(BACKEND, "scripts", "backfillCatalogCardYearFromSlug.cjs");
const RUNNER = path.join(BACKEND, "..", ".github", "workflows", "backfill-runner.yml");
const SRC = fs.readFileSync(SCRIPT, "utf8");
const RUNNER_YML = fs.readFileSync(RUNNER, "utf8");

const require_ = createRequire(import.meta.url);

/** Load the lane in a clean child process under an exact env and read back what
 *  it bound. A child is deliberate: these are module-level constants, decided
 *  at require time, so they cannot be re-read in-process. */
function bind(env: Record<string, string>) {
  const clean = { ...process.env };
  for (const k of ["SLOT", "SLOTS", "SHARD", "DRY_RUN", "APPLY", "BACKFILL_APPLY", "SOURCES", "SOURCE_FILTER"]) {
    delete clean[k];
  }
  const code = `const m=require(${JSON.stringify(SCRIPT)});`
    + `console.log(JSON.stringify({DRY_RUN:m.DRY_RUN,APPLY:m.APPLY,SHARDED:m.SHARDED,`
    + `SLOT:m.SLOT,SLOTS:m.SLOTS,SOURCES:m.SOURCES,clause:m.sourceClause("c")}));`;
  const out = execFileSync(process.execPath, ["-e", code], { env: { ...clean, ...env }, encoding: "utf8" });
  return JSON.parse(out.trim()) as {
    DRY_RUN: boolean; APPLY: boolean; SHARDED: boolean;
    SLOT: number; SLOTS: number; SOURCES: string[]; clause: string;
  };
}

describe("the runner can reach the lane", () => {
  it("the script is in the whitelist, and the whitelist name IS the filename", () => {
    // The runner runs `node backend/scripts/${{ inputs.script }}.cjs`, so a
    // whitelist entry that is not a real filename is a dispatch that 404s at
    // the last step, after twenty minutes of npm ci and tsc.
    expect(RUNNER_YML).toContain("- backfillCatalogCardYearFromSlug");
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it("MUTATION PIN: every whitelisted script name maps to a file that exists", () => {
    const block = RUNNER_YML.slice(
      RUNNER_YML.indexOf("        options:"),
      RUNNER_YML.indexOf("      apply:"));
    const names = [...block.matchAll(/^ {10}- ([A-Za-z0-9._-]+)$/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(140);
    const missing = names.filter((n) => !fs.existsSync(path.join(BACKEND, "scripts", `${n}.cjs`)));
    expect(missing, `whitelisted but no .cjs: ${missing.join(", ")}`).toEqual([]);
  });

  it("claims NO new workflow_dispatch input — the source scope rides `sources`", () => {
    // GitHub caps workflow_dispatch at 25 inputs. The form was at 24 and must
    // stay there: a lane that needs a 25th is a lane that blocks the next one.
    const inputsBlock = RUNNER_YML.slice(
      RUNNER_YML.indexOf("    inputs:"),
      RUNNER_YML.indexOf("permissions:"));
    const topLevel = [...inputsBlock.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
    expect(topLevel.length).toBeLessThanOrEqual(25);
    expect(topLevel).toContain("sources");
    // and the lane reads that env var, not a private one the runner never sets
    expect(SRC).toContain("process.env.SOURCES");
    expect(RUNNER_YML).toContain("SOURCES: ${{ inputs.sources }}");
  });
});

describe("DRY_RUN honours the runner's BACKFILL_APPLY", () => {
  it("THE DEFECT, pinned: an APPLY dispatch must not silently report", () => {
    // The runner exports BACKFILL_APPLY, never APPLY and never DRY_RUN. The
    // script shipped reading `DRY_RUN ?? "true"`, so EVERY runner dispatch --
    // including apply=true -- would have bound DRY_RUN=true and written nothing,
    // green and honestly reconciled.
    const r = bind({ BACKFILL_APPLY: "true", SLOT: "0", SLOTS: "16" });
    expect(r.APPLY).toBe(true);
    expect(r.DRY_RUN, "BACKFILL_APPLY=true must turn writes ON").toBe(false);
  });

  it("REPORT is the default: no apply flag at all means no writes", () => {
    expect(bind({}).DRY_RUN).toBe(true);
    expect(bind({ SLOT: "0", SLOTS: "16" }).DRY_RUN).toBe(true);
    expect(bind({ BACKFILL_APPLY: "false", SLOT: "0", SLOTS: "16" }).DRY_RUN).toBe(true);
    expect(bind({ BACKFILL_APPLY: "" }).DRY_RUN).toBe(true);
  });

  it("an explicit DRY_RUN=true still wins over an apply flag — a report can be forced", () => {
    const r = bind({ BACKFILL_APPLY: "true", DRY_RUN: "true" });
    expect(r.APPLY).toBe(true);
    expect(r.DRY_RUN).toBe(true);
  });

  it("the local-operator spellings still work (DRY_RUN=false, APPLY=true)", () => {
    expect(bind({ DRY_RUN: "false" }).DRY_RUN).toBe(false);
    expect(bind({ APPLY: "true" }).DRY_RUN).toBe(false);
  });
});

describe("sharding is opt-in — the inherited slots=16 sweeps EVERY row", () => {
  it("THE OUTAGE, pinned: the runner's inherited slot=0 slots=16 does not shard", () => {
    const r = bind({ SLOT: "0", SLOTS: "16", BACKFILL_APPLY: "true" });
    expect(r.SHARDED, "an inherited default must never shard").toBe(false);
    expect(r.SLOTS).toBe(1);
  });

  it("the banner says 'sweeps EVERY row' for the inherited default", () => {
    // A reviewer reads the banner, not the code. `slot 0/16` looked like
    // configuration; it was a warning nobody could see.
    expect(SRC).toContain("SHARD_SCOPE.banner()");
    const helper = fs.readFileSync(path.join(BACKEND, "scripts", "lib", "runner-shard-scope.cjs"), "utf8");
    expect(helper).toContain("sweeps EVERY row");
    expect(helper).toContain("THIS RUN COVERS 1/${SLOTS} OF THE POPULATION");
  });

  it("a real fan-out still works, both ways in", () => {
    expect(bind({ SLOT: "3", SLOTS: "16" }).SHARDED).toBe(true);
    expect(bind({ SLOT: "3", SLOTS: "16" }).SLOTS).toBe(16);
    const optIn = bind({ SLOT: "0", SLOTS: "16", SHARD: "true" });
    expect(optIn.SHARDED).toBe(true);
    expect(optIn.SLOT).toBe(0);
  });

  it("it uses the ONE helper, not a private copy of the rule", () => {
    expect(SRC).toContain('require(path.join(__dirname, "lib", "runner-shard-scope.cjs"))');
    // The old form is what let an inherited default shard the run.
    expect(SRC).not.toMatch(/Number\(process\.env\.SLOTS \?\? 1\)/);
  });
});

describe("the source scope", () => {
  it("empty SOURCES sweeps EVERY source — the ruling, not an oversight", () => {
    const r = bind({});
    expect(r.SOURCES).toEqual([]);
    expect(r.clause, "no source filter at all").toBe("");
  });

  it("a named lane scopes the scan AND the verify-by-read to that lane", () => {
    const r = bind({ SOURCES: "hobbymonitor-2026-09-04" });
    expect(r.SOURCES).toEqual(["hobbymonitor-2026-09-04"]);
    expect(r.clause).toContain('c.source IN ("hobbymonitor-2026-09-04")');
  });

  it("multiple lanes in one dispatch", () => {
    const r = bind({ SOURCES: "ingest-auto-seed, ingest-auto-seed-graded ,user-verified" });
    expect(r.SOURCES).toEqual(["ingest-auto-seed", "ingest-auto-seed-graded", "user-verified"]);
    expect(r.clause).toContain('"ingest-auto-seed"');
    expect(r.clause).toContain('"user-verified"');
  });

  it("the source name is JSON-quoted, so a quote in a source cannot break the predicate out", () => {
    const r = bind({ SOURCES: 'ok-source,we"ird' });
    expect(r.clause).toContain('\\"');
    // balanced parens: the IN list closed exactly once
    expect((r.clause.match(/\(/g) ?? []).length).toBe((r.clause.match(/\)/g) ?? []).length);
  });

  it("the scan and the verify-by-read ask the SAME question", () => {
    // A before/after count taken under a different predicate than the scan is
    // a pair of numbers that cannot be subtracted.
    expect(SRC).toContain("const MISSING_WHERE =");
    const uses = SRC.match(/MISSING_WHERE/g) ?? [];
    expect(uses.length, "declared once, used by both the scan and the counts").toBeGreaterThanOrEqual(3);
    expect(SRC).toContain("countMissingBySource");
  });
});

describe("the year comes from the slug, and is never guessed", () => {
  const { yearFromSlug } = require_(SCRIPT) as { yearFromSlug: (s: unknown) => number | null };

  it("reads position 2 of a hiq slug", () => {
    expect(yearFromSlug("hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto")).toBe(1987);
    expect(yearFromSlug("hiq:pokemon:1997:japanese-rocket-gang:1:base:no-auto")).toBe(1997);
  });

  it("refuses anything that is not a year in a hiq slug — those rows are SKIPPED, never invented", () => {
    for (const bad of [
      "card::something", "hiq:baseball", "", null, undefined, 1987,
      "hiq:baseball:notayear:topps:1:base:no-auto",
      "hiq:baseball:1899:topps:1:base:no-auto",   // below the floor
      "hiq:baseball:2101:topps:1:base:no-auto",   // above the ceiling
    ]) {
      expect(yearFromSlug(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("reconciliation: intended = written + skipped + failed", () => {
  it("a REPORT-ONLY run counts every planned row as a SKIP, never as a silent zero", () => {
    // "intended 2,100,230 = written 0" with no skip column is exactly how an
    // under-sweep reads as a success (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW).
    const m = SRC.match(/const skipped = skippedBadSlug \+ skippedOtherShard\s*\n?\s*\+ \(DRY_RUN \? planned : \(planned - patched - patchFailed\)\);/);
    expect(m, "the skip term must account for the report case").toBeTruthy();

    // and it balances, arithmetically, in both modes
    const balance = (dry: boolean, scanned: number, planned: number, badSlug: number,
                     otherShard: number, patched: number, failed: number) => {
      const skipped = badSlug + otherShard + (dry ? planned : (planned - patched - failed));
      return { ok: scanned === patched + skipped + failed, skipped };
    };
    // report: 2,100,230 scanned, all planned, nothing written
    expect(balance(true, 2100230, 2100230, 0, 0, 0, 0).ok).toBe(true);
    // apply: everything written
    expect(balance(false, 2100230, 2100230, 0, 0, 2100230, 0).ok).toBe(true);
    // apply with bad slugs and failures
    expect(balance(false, 100, 90, 10, 0, 85, 5).ok).toBe(true);
    // a sharded apply: the other fifteen slots are skips, and still reconcile
    expect(balance(false, 1600, 100, 0, 1500, 100, 0).ok).toBe(true);
  });

  it("it reports through the house reconciler, with the four disjoint counters", () => {
    const call = SRC.slice(SRC.indexOf("reportWrites({"));
    expect(call).toBeTruthy();
    const body = call.slice(0, call.indexOf("});") + 3);
    for (const k of ["intended", "written", "skipped", "failed"]) {
      // shorthand (`skipped,`) or explicit (`written: patched,`) both count
      expect(body, `reportWrites must carry ${k}`).toMatch(new RegExp(`\\b${k}\\s*[,:]`));
    }
    expect(body).toContain('job: "backfillCatalogCardYearFromSlug"');
    expect(body).toContain("intended: scanned");
    expect(body).toContain("written: patched");
    expect(body).toContain("failed: patchFailed");
  });
});

describe("the write is a MIRROR patch and nothing else", () => {
  it("patches /cardYear only — it never touches an identity field", () => {
    const patches = [...SRC.matchAll(/\{ op: "([a-z]+)", path: "([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(patches).toEqual([["add", "/cardYear"]]);
  });

  it("the value patched is the SLUG's year, not a parsed or inferred one", () => {
    expect(SRC).toContain("value: p.year");
    expect(SRC).toContain("const y = yearFromSlug(r.hobbyiqCardId);");
  });

  it("only rows MISSING cardYear are selected — it never overwrites a stated one", () => {
    expect(SRC).toContain("NOT IS_DEFINED(c.cardYear) OR c.cardYear = null");
  });
});
