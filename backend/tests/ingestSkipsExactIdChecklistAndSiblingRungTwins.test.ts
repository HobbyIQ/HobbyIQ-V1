/**
 * CF-A-SIBLING-KEY-IS-STILL-THE-SAME-RUNG (Drew, 2026-09-25).
 *
 * ROOT CAUSE. `ingest-checklist-csv-to-catalog.cjs` and its planner
 * (`planStagedDirectory`) dedupe on EXACT id only, and the planner has no
 * Cosmos access. A staged row whose (year, cardNumber, parallel slug, isAuto,
 * printRun) already exists under a SIBLING setKey (`bowman` vs
 * `bowman-chrome`) -- or at the exact id under another checklist source --
 * passed REPORT as "0 collisions" and became a duplicate row: a split pool
 * (150 lava rows 09-21, 1,410 draft-sapphire rows 09-21, 658 RA- rows caught
 * only in review 09-22).
 *
 * THE FIX, exercised end to end here against the REAL script (never a copy):
 *
 *   (a) exact-id checklist present -> the upsert is SKIPPED, never attempted,
 *       counted as `already present (checklist)`;
 *   (b) exact-id DERIVED present -> unchanged behaviour, still written
 *       (checklist supersedes derived);
 *   (c) no exact-id match, but the SAME rung already checklist-attested under
 *       a SIBLING setKey -> SKIPPED, counted as `rung twin under sibling
 *       key`, with an example named in the banner;
 *   (d) no twin anywhere -> written, same as before this change;
 *   (e) the rows-read reconciliation still balances with both new buckets
 *       folded in;
 *   (f) REPORT mode writes nothing and never touches the Cosmos stub's query
 *       method (this pin's own historical contract -- REPORT returns before
 *       any Cosmos call at all).
 *
 * The Cosmos stub is injected via `--require`, exactly like
 * csvIngestSourceDuplicatesDeclaredToReconciler.test.ts, so `written`,
 * `reportWrites` and the banner arithmetic are all the REAL script's, driven
 * as a child process.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterAll } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-checklist-csv-to-catalog.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-sibling-twin-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function stageDir(name: string, csv: string, manifest: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(tmp, "d-"));
  fs.writeFileSync(path.join(d, `${name}.csv`), csv);
  fs.writeFileSync(path.join(d, `${name}.manifest.json`), JSON.stringify(manifest));
  return d;
}

type StubRow = {
  id: string; setKey: string; parallel: string | null; isAuto: boolean;
  printRun: number | null; source: string; playerName?: string; cardNumber?: string;
};

/**
 * Stubs ONLY `@azure/cosmos`. `byId` seeds the exact-id point-read table;
 * `bySibling` seeds what the rung-level query returns (every fixture below
 * queries once per staged row, so this is a flat list filtered by the query
 * predicate the stub re-implements minimally: sport/year/cardNumber). Every
 * `items.upsert` call is recorded so a test can assert what was ACTUALLY
 * written, not merely what the banner claims.
 */
function shimOf(opts: { byId?: Record<string, StubRow>; bySibling?: StubRow[]; queryShouldNotBeCalled?: boolean } = {}): { path: string; writtenFile: string } {
  const writtenFile = path.join(tmp, `written-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(writtenFile, "[]");
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const fs = require("node:fs");
const Module = require("node:module");
const BY_ID = ${JSON.stringify(opts.byId ?? {})};
const BY_SIBLING = ${JSON.stringify(opts.bySibling ?? [])};
const QUERY_SHOULD_NOT_BE_CALLED = ${opts.queryShouldNotBeCalled ? "true" : "false"};
const WRITTEN_FILE = ${JSON.stringify(writtenFile)};
const stub = {
  CosmosClient: class {
    database() {
      return {
        container() {
          return {
            item(id) {
              return {
                read: async () => {
                  if (BY_ID[id]) return { resource: BY_ID[id] };
                  const e = new Error("404"); e.code = 404; throw e;
                },
              };
            },
            items: {
              upsert: async (doc) => {
                const written = JSON.parse(fs.readFileSync(WRITTEN_FILE, "utf8"));
                written.push(doc);
                fs.writeFileSync(WRITTEN_FILE, JSON.stringify(written));
                return { resource: doc };
              },
              query(spec) {
                if (QUERY_SHOULD_NOT_BE_CALLED) {
                  throw new Error("REPORT mode must never call items.query");
                }
                let done = false;
                return {
                  hasMoreResults: () => !done,
                  fetchNext: async () => { done = true; return { resources: BY_SIBLING }; },
                };
              },
            },
          };
        },
      };
    }
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return stub;
  return realLoad.apply(this, arguments);
};
`);
  return { path: p, writtenFile };
}

const COSMOS_CONNECTION_STRING = "AccountEndpoint=https://example.invalid:443/;AccountKey=ZmFrZQ==;";

function runIngestApply(dir: string, shimPath: string, extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [script], {
    env: {
      ...process.env, ...extraEnv,
      COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist",
      BACKFILL_APPLY: "true", REINGEST: "true",
      NODE_OPTIONS: `--require ${JSON.stringify(shimPath)}`,
    },
    encoding: "utf8",
  });
  return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), status: typeof r.status === "number" ? r.status : 1 };
}

function runIngestReport(dir: string, shimPath: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: {
        ...process.env, COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist",
        NODE_OPTIONS: `--require ${JSON.stringify(shimPath)}`,
      },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: String(err.stdout ?? ""), status: typeof err.status === "number" ? err.status : 1 };
  }
}

describe("exact-id checklist present -> the write is SKIPPED, never attempted", () => {
  const dir = stageDir("2020-twin-basketball-exact", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2020, setKey: "exact-test-set", setName: "2020 Exact Test" });

  it("skips the row and counts it as already present (checklist), never as written", () => {
    const id = "hiq:basketball:2020:exact-test-set:1:base:no-auto";
    const { path: shim, writtenFile } = shimOf({
      byId: { [id]: { id, setKey: "exact-test-set", parallel: null, isAuto: false, printRun: null, source: "beckett" } },
    });
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toMatch(/already present \(checklist\)\s+1/);
    expect(stdout).toContain("catalog rows written   0");
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(0);
  });
});

describe("exact-id DERIVED present -> unchanged: still written (checklist supersedes derived)", () => {
  const dir = stageDir("2020-twin-basketball-derived", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "basketball", year: 2020, setKey: "derived-test-set", setName: "2020 Derived Test" });

  it("writes the row -- a derived incumbent never blocks a checklist write", () => {
    const id = "hiq:basketball:2020:derived-test-set:1:base:no-auto";
    const { path: shim, writtenFile } = shimOf({
      byId: { [id]: { id, setKey: "derived-test-set", parallel: null, isAuto: false, printRun: null, source: "ingest-auto-seed" } },
    });
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toContain("already present (checklist) 0");
    expect(stdout).toContain("catalog rows written   1");
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(1);
  });
});

describe("sibling-key rung twin -> SKIPPED, with an example named in the banner", () => {
  const dir = stageDir("2020-twin-baseball-sibling", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Silver Prizm,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman" });

  it("counts the row as a rung twin under a sibling key and names the sibling + player in the example", () => {
    const { path: shim, writtenFile } = shimOf({
      bySibling: [{
        id: "hiq:baseball:2020:bowman-chrome:1:silver-prizm:no-auto",
        setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null,
        source: "sportscardchecklist", playerName: "Alpha Player",
      }],
    });
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toMatch(/rung twin under sibling key\s+1/);
    expect(stdout).toContain("catalog rows written   0");
    expect(stdout).toMatch(/1\|Silver Prizm -> sibling key "bowman-chrome"/);
    expect(stdout).toContain("Alpha Player");
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(0);
  });
});

describe("no twin anywhere -> written, exactly as before this change", () => {
  const dir = stageDir("2020-twin-baseball-clean", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Silver Prizm,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Clean" });

  it("writes the row when neither the exact id nor any sibling key already holds this rung", () => {
    const { path: shim, writtenFile } = shimOf({});
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toContain("rung twin under sibling key 0");
    expect(stdout).toContain("catalog rows written   1");
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(1);
  });
});

describe("the rows-read reconciliation balances with both new buckets folded in", () => {
  // 3 rows: #1 exact-id checklist present (skip), #2 sibling twin (skip), #3
  // clean (write) -- every bucket this fix adds exercised in one run.
  const dir = stageDir("2020-twin-baseball-mixed", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,,false,,Alpha Player",
    "base,2,Silver Prizm,false,,Beta Player",
    "base,3,,false,,Gamma Player",
    "",
  ].join("\n"), { sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Mixed" });

  it("csv rows read 3 = written 1 + ... + present/checklist 1 + rung twin 1  (balances)", () => {
    const id1 = "hiq:baseball:2020:bowman:1:base:no-auto";
    const { path: shim, writtenFile } = shimOf({
      byId: { [id1]: { id: id1, setKey: "bowman", parallel: null, isAuto: false, printRun: null, source: "beckett" } },
      bySibling: [{
        id: "hiq:baseball:2020:bowman-chrome:2:silver-prizm:no-auto",
        setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null,
        source: "sportscardchecklist", playerName: "Beta Player",
      }],
    });
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toMatch(/csv rows read 3 = written 1 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 0 \+ present\/checklist 1 \+ rung twin 1\s+\(balances\)/);
    expect(stdout).not.toContain("WORK VANISHED");
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(1);
  });
});

describe("the manifest can explicitly waive the guard -- never an env flag", () => {
  const dir = stageDir("2020-twin-baseball-waived", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Silver Prizm,false,,Alpha Player",
    "",
  ].join("\n"), {
    sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Waived",
    allowSiblingRungTwins: true,
    allowSiblingRungTwinsReason: "test fixture: reprint set deliberately mirrors its parent's numbering",
  });

  it("writes the row even though a checklist-grade sibling twin exists, because the manifest states a reason -- AND the waiver is still visible in the banner", () => {
    const { path: shim, writtenFile } = shimOf({
      bySibling: [{
        id: "hiq:baseball:2020:bowman-chrome:1:silver-prizm:no-auto",
        setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null,
        source: "sportscardchecklist", playerName: "Alpha Player",
      }],
    });
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toContain("rung twin under sibling key 0");
    expect(stdout).toContain("catalog rows written   1");
    // CF-WAIVED-IS-NOT-INVISIBLE: the waiver is informational, counted
    // separately from written (never added to the reconciliation), and
    // names the manifest's own stated reason.
    expect(stdout).toMatch(/rung twins WAIVED \(reason: test fixture: reprint set deliberately mirrors its parent's numbering\) 1/);
    expect(stdout).toMatch(/WAIVED: 1\|Silver Prizm -> sibling key "bowman-chrome"/);
    expect(stdout).toMatch(/csv rows read 1 = written 1 \+ failed 0 \+ skipped 0 \+ refused 0 \+ source duplicates 0 \+ present\/checklist 0 \+ rung twin 0\s+\(balances\)/);
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(1);
  });

  it("an unreasoned allowSiblingRungTwins (no string reason) does NOT waive the guard", () => {
    const dirNoReason = stageDir("2020-twin-baseball-waived-noreason", [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,Silver Prizm,false,,Alpha Player",
      "",
    ].join("\n"), {
      sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Waived No Reason",
      allowSiblingRungTwins: true,
      // no allowSiblingRungTwinsReason
    });
    const { path: shim, writtenFile } = shimOf({
      bySibling: [{
        id: "hiq:baseball:2020:bowman-chrome:1:silver-prizm:no-auto",
        setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null,
        source: "sportscardchecklist", playerName: "Alpha Player",
      }],
    });
    const { stdout, status } = runIngestApply(dirNoReason, shim);
    expect(status).toBe(0);
    expect(stdout).toContain("rung twin under sibling key 1");
    expect(stdout).toContain("catalog rows written   0");
    expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(0);
  });
});

describe("mutation checks: both skip branches actually gate the write", () => {
  it("removing the exact-id checklist-present guard writes the row instead of skipping it", () => {
    const src = fs.readFileSync(script, "utf8");
    const marker = /if \(known && catalogAuthorityOf\(known\.source\) === "checklist" && !\(product\.allowSiblingRungTwins\)\) \{\s*alreadyPresentChecklist\+\+;\s*return;\s*\}/;
    expect(src).toMatch(marker);
    const mutated = src.replace(marker, "");
    expect(mutated).not.toBe(src);

    const id = "hiq:basketball:2020:mutant-exact-test-set:1:base:no-auto";
    const dir = stageDir("2020-mutant-exact", [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,,false,,Alpha Player",
      "",
    ].join("\n"), { sport: "basketball", year: 2020, setKey: "mutant-exact-test-set", setName: "2020 Mutant Exact" });
    const { path: shim, writtenFile } = shimOf({
      byId: { [id]: { id, setKey: "mutant-exact-test-set", parallel: null, isAuto: false, printRun: null, source: "beckett" } },
    });
    const mutantPath = path.join(path.dirname(script), `mutant-exact-${Date.now()}.cjs`);
    fs.writeFileSync(mutantPath, mutated);
    try {
      const { status } = runIngestApply(dir, shim, {});
      const r2 = spawnSync(process.execPath, [mutantPath], {
        env: {
          ...process.env, COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist",
          BACKFILL_APPLY: "true", REINGEST: "true",
          NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
        },
        encoding: "utf8",
      });
      expect(r2.status).toBe(0);
      // The mutant no longer skips: the row it should have refused now lands.
      expect(String(r2.stdout)).toContain("catalog rows written   1");
      expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(1);
      void status;
    } finally {
      try { fs.rmSync(mutantPath, { force: true }); } catch { /* best effort */ }
    }
  });

  it("removing the sibling-rung-twin guard writes the row instead of skipping it", () => {
    const src = fs.readFileSync(script, "utf8");
    const marker = /\} else \{\s*rungTwinUnderSiblingKey\+\+;\s*if \(rungTwinExamples\.length < 20\) rungTwinExamples\.push\(example\);\s*return;\s*\}/;
    expect(src).toMatch(marker);
    // Removing only the `return;` inside the un-waived branch: the row is
    // still COUNTED as a twin, but no longer SKIPPED -- the exact shape of
    // "the guard fires but does not gate the write" this test exists to
    // catch.
    const mutated = src.replace(
      marker,
      "} else {\n              rungTwinUnderSiblingKey++;\n              if (rungTwinExamples.length < 20) rungTwinExamples.push(example);\n            }",
    );
    expect(mutated).not.toBe(src);

    const dir = stageDir("2020-mutant-sibling", [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,Silver Prizm,false,,Alpha Player",
      "",
    ].join("\n"), { sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Mutant Sibling" });
    const { path: shim, writtenFile } = shimOf({
      bySibling: [{
        id: "hiq:baseball:2020:bowman-chrome:1:silver-prizm:no-auto",
        setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null,
        source: "sportscardchecklist", playerName: "Alpha Player",
      }],
    });
    const mutantPath = path.join(path.dirname(script), `mutant-sibling-${Date.now()}.cjs`);
    fs.writeFileSync(mutantPath, mutated);
    try {
      const r2 = spawnSync(process.execPath, [mutantPath], {
        env: {
          ...process.env, COSMOS_CONNECTION_STRING, DIR: dir, SOURCE: "sportscardchecklist",
          BACKFILL_APPLY: "true", REINGEST: "true",
          NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
        },
        encoding: "utf8",
      });
      // The mutant still COUNTS the twin (rungTwinUnderSiblingKey++) but no
      // longer SKIPS it (no `return;`), so the row it should have refused is
      // BOTH written AND counted as skipped -- the exact "guard fires but
      // does not gate" shape this test exists to catch. The row landing in
      // two buckets at once is exactly what the rows-read reconciliation
      // (CF-CSV-ROWS-READ-MUST-EQUAL-EVERY-BUCKET-THAT-CLAIMS-ONE) exists to
      // catch, so the mutant's own FATAL exit is the proof the guard mattered.
      expect(r2.status).not.toBe(0);
      expect(String(r2.stdout) + String(r2.stderr)).toMatch(/MISMATCH|FATAL/);
      expect(JSON.parse(fs.readFileSync(writtenFile, "utf8"))).toHaveLength(1);
    } finally {
      try { fs.rmSync(mutantPath, { force: true }); } catch { /* best effort */ }
    }
  });
});

describe("the twin query is capped by its own semaphore, independent of CONCURRENCY", () => {
  // 20 distinct rows in one file, all clean (no twin, no exact-id match), so
  // every row reaches the twin query and the run's CONCURRENCY (default 48)
  // fans all 20 out at once -- if the semaphore did not cap them, up to 20
  // concurrent `items.query` calls would be in flight at once.
  const rows = Array.from({ length: 20 }, (_, i) => `base,${i + 1},Silver Prizm,false,,Player ${i + 1}`);
  const dir = stageDir("2020-twin-baseball-burst", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    ...rows,
    "",
  ].join("\n"), { sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Burst" });

  function burstShim(limit: number): { path: string; maxInFlightFile: string } {
    const maxInFlightFile = path.join(tmp, `maxinflight-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(maxInFlightFile, "0");
    const p = path.join(tmp, `shim-burst-${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(p, `
const fs = require("node:fs");
const Module = require("node:module");
const MAX_FILE = ${JSON.stringify(maxInFlightFile)};
let inFlight = 0;
const stub = {
  CosmosClient: class {
    database() {
      return {
        container() {
          return {
            item() { return { read: async () => { const e = new Error("404"); e.code = 404; throw e; } }; },
            items: {
              upsert: async (doc) => ({ resource: doc }),
              query() {
                let done = false;
                return {
                  hasMoreResults: () => !done,
                  fetchNext: async () => {
                    inFlight++;
                    const max = Number(fs.readFileSync(MAX_FILE, "utf8"));
                    if (inFlight > max) fs.writeFileSync(MAX_FILE, String(inFlight));
                    // Hold the "query" open briefly so overlapping callers,
                    // if the semaphore did not cap them, would actually
                    // overlap here rather than resolving before the next one
                    // even starts.
                    await new Promise((r) => setTimeout(r, 15));
                    inFlight--;
                    done = true;
                    return { resources: [] };
                  },
                };
              },
            },
          };
        },
      };
    }
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return stub;
  return realLoad.apply(this, arguments);
};
`);
    return { path: p, maxInFlightFile };
  }

  it("never lets more than TWIN_QUERY_LIMIT (default 6) twin queries run at once, even with CONCURRENCY=48 fanning out 20 rows", () => {
    const { path: shim, maxInFlightFile } = burstShim(6);
    const { stdout, status } = runIngestApply(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toContain("catalog rows written   20");
    const maxInFlight = Number(fs.readFileSync(maxInFlightFile, "utf8"));
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it("honours a TWIN_QUERY_LIMIT override", () => {
    const { path: shim, maxInFlightFile } = burstShim(2);
    const { stdout, status } = runIngestApply(dir, shim, { TWIN_QUERY_LIMIT: "2" });
    expect(status).toBe(0);
    expect(stdout).toContain("catalog rows written   20");
    const maxInFlight = Number(fs.readFileSync(maxInFlightFile, "utf8"));
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("REPORT mode writes nothing and never touches Cosmos at all", () => {
  const dir = stageDir("2020-twin-baseball-report", [
    "category,cardNumber,parallel,isAuto,printRun,player",
    "base,1,Silver Prizm,false,,Alpha Player",
    "",
  ].join("\n"), { sport: "baseball", year: 2020, setKey: "bowman", setName: "2020 Bowman Report" });

  it("stays true to the pre-existing REPORT contract: no APPLY env means no Cosmos call, so the sibling guard never runs", () => {
    // queryShouldNotBeCalled: true -- if REPORT mode ever reached the guard,
    // the stub would throw and this run would exit non-zero.
    const { path: shim } = shimOf({ queryShouldNotBeCalled: true });
    const { stdout, status } = runIngestReport(dir, shim);
    expect(status).toBe(0);
    expect(stdout).toContain("catalog rows written   1");
    expect(stdout).toContain("REPORT ONLY — nothing written");
  });
});
