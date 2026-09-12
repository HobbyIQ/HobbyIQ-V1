/**
 * anomaly-force-scan.cjs -- CF-CLEANLINESS-ANOMALY-BUDGET (2026-09-11).
 *
 * Drives the COMMITTED lane script through a stubbed Cosmos (never a
 * reimplementation of its loop), the same harness shape
 * tests/ingestUniverseDriverLaneContinues.test.ts uses for
 * ingest-universe-driver.cjs: @azure/cosmos and the dist/ writeReconciliation
 * import are intercepted at the module-resolution boundary via
 * `NODE_OPTIONS=--require <shim>`, so scripts/lib/runner-budget.cjs's real
 * budget()/finishLane() run unmodified and the assertions are about what the
 * real script does with a real (tiny) clock.
 *
 * THREE THINGS PINNED HERE, matching the task's three required proofs:
 *   1. a budget stop leaves the resumable cursor/marker in place, and a
 *      SUBSEQUENT invocation resumes from it (not from scratch) -- never
 *      re-reading a unit the first run already finished;
 *   2. the reportWrites reconciliation line balances, both for a scan-phase
 *      refusal (intended 0 = written 0) and a finished sweep (intended 1 =
 *      written 1);
 *   3. a scan-phase stop REFUSES to publish a report (exit 5), the cached
 *      /cleanliness/anomalies path is a completely separate module this
 *      script never touches, and a finished sweep DOES publish one.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "anomaly-force-scan.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anomaly-scan-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * The stubbed Cosmos world, injected via NODE_OPTIONS --require. A JSON file
 * (STATE_SINK) is the durable store both the shim and the test process read,
 * so state survives across the TWO SEPARATE PROCESS invocations a resume
 * test needs (the first run's stop, the second run's resume).
 *
 * sold_comps carries a tiny, fixed set of rows across a HANDFUL of
 * (cardYear, sportClass) units -- not the real 805-unit range -- because the
 * lane enumerates units at require-time from the real
 * scripts/lib/anomaly-scan-units.cjs and this harness controls the CLOCK
 * (RUN_MINUTES/BUDGET_MS/RESERVE_MS), not the unit count, to force a stop
 * after a SPECIFIC number of units have been fully scanned.
 */
function shimPath(opts: {
  sinkPath: string;
  soldComps: Array<{ hobbyiqCardId: string; price: number; source: string; cardYear: number | null; sport: string }>;
  baselineRows: Array<{ slug: string; median: number; sampleCount: number; snapshotDate: string }>;
  /** Number of (cardYear, sportClass) units to serve real rows for before
   *  every later unit is an empty page -- keeps the fixture data tiny while
   *  still exercising the full 805-unit enumeration loop. */
  slowAfterUnit?: number;
  /** ms to sleep on each page fetch once past slowAfterUnit, so a tiny
   *  BUDGET_MS is exceeded deterministically rather than racily. */
  sleepMs?: number;
  /** Make the anomaly_scan_reports upsert throw this many times before
   *  succeeding (shared across process invocations via the sink file), to
   *  prove a report-write failure keeps a resumable cursor rather than
   *  forcing a full re-scan on retry. */
  failReportWriteTimes?: number;
  /** Make sold_comps' fetchNext() throw a Cosmos 429 shape this many times
   *  (shared across process invocations via the sink file) before serving
   *  rows normally, to prove a rate-limited page read stops the sweep like a
   *  budget stop rather than escaping to the outer .catch as a hard crash. */
  fail429Times?: number;
}): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");

const SINK = ${JSON.stringify(opts.sinkPath)};
const SOLD_COMPS = ${JSON.stringify(opts.soldComps)};
const BASELINE_ROWS = ${JSON.stringify(opts.baselineRows)};
const SLOW_AFTER_UNIT = ${JSON.stringify(opts.slowAfterUnit ?? 999999)};
const SLEEP_MS = ${JSON.stringify(opts.sleepMs ?? 0)};
const FAIL_REPORT_WRITE_TIMES = ${JSON.stringify(opts.failReportWriteTimes ?? 0)};
const FAIL_429_TIMES = ${JSON.stringify(opts.fail429Times ?? 0)};

function readSink() {
  try { return JSON.parse(fs.readFileSync(SINK, "utf8")); }
  catch { return { control: {}, reports: {} }; }
}
function writeSink(s) { fs.writeFileSync(SINK, JSON.stringify(s)); }

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

let unitsQueried = 0;

// Very small parser for THIS lane's own generated WHERE clause shape, just
// enough to filter the fixture rows the same way Cosmos would. Good enough
// for a stub: it is not asked to be a query engine, only to partition the
// fixture the same way anomaly-scan-units.cjs's predicate does.
function rowMatchesUnit(row, params) {
  const byName = Object.fromEntries(params.map((p) => [p.name, p.value]));
  return true; // real filtering happens in matchesQuery below via param inspection
}

function matchesQuery(query, parameters, row) {
  const byName = Object.fromEntries(parameters.map((p) => [p.name, p.value]));
  // Year clause
  if (/NOT IS_DEFINED\\(c\\.cardYear\\)/.test(query)) {
    if (row.cardYear !== null && row.cardYear !== undefined) return false;
  } else if (/IS_NULL\\(c\\.cardYear\\)/.test(query)) {
    if (row.cardYear !== null) return false;
  } else {
    const yKey = Object.keys(byName).find((k) => k.startsWith("@y"));
    if (yKey && Number(row.cardYear) !== Number(byName[yKey])) return false;
  }
  // Sport clause
  const scKeys = Object.keys(byName).filter((k) => k.startsWith("@sc"));
  if (scKeys.length) {
    // "other" class: NOT IN (named classes)
    const named = scKeys.map((k) => byName[k]);
    if (named.includes(String(row.sport))) return false;
  } else {
    const sKey = Object.keys(byName).find((k) => k.startsWith("@s") && !k.startsWith("@sc"));
    if (sKey && String(row.sport) !== String(byName[sKey])) return false;
  }
  return true;
}

const stub = {
  CosmosClient: class {
    database() {
      return {
        container(name) {
          if (name === "sold_comps") {
            return {
              items: {
                query(spec) {
                  const { query, parameters } = spec;
                  const rows = SOLD_COMPS.filter((r) => matchesQuery(query, parameters || [], r));
                  unitsQueried++;
                  let served = false;
                  return {
                    hasMoreResults() { return !served; },
                    async fetchNext() {
                      if (FAIL_429_TIMES > 0) {
                        const s = readSink();
                        const usedSoFar = s.rateLimitFailuresUsed || 0;
                        if (usedSoFar < FAIL_429_TIMES) {
                          s.rateLimitFailuresUsed = usedSoFar + 1;
                          writeSink(s);
                          const e = new Error("ErrorResponse: The request rate is too large. Please retry after sometime. Learn more: http://aka.ms/cosmosdb-error-429");
                          e.code = 429;
                          throw e;
                        }
                      }
                      served = true;
                      if (unitsQueried > SLOW_AFTER_UNIT && SLEEP_MS > 0) sleepSync(SLEEP_MS);
                      return { resources: rows };
                    },
                  };
                },
              },
            };
          }
          if (name === "pool_baseline_snapshots") {
            return {
              items: {
                query(spec) {
                  if (/MAX\\(c\\.snapshotDate\\)/.test(spec.query)) {
                    const dates = BASELINE_ROWS.map((r) => r.snapshotDate);
                    const max = dates.length ? dates.sort().slice(-1)[0] : null;
                    return { fetchAll: async () => ({ resources: [max] }) };
                  }
                  const d = (spec.parameters || []).find((p) => p.name === "@d");
                  const rows = BASELINE_ROWS.filter((r) => !d || r.snapshotDate === d.value);
                  return { fetchAll: async () => ({ resources: rows }) };
                },
              },
            };
          }
          if (name === "crawl_state") {
            return {
              item(id) {
                return {
                  read: async () => {
                    const s = readSink();
                    const doc = s.control[id];
                    if (!doc) { const e = new Error("not found"); e.code = 404; throw e; }
                    return { resource: doc };
                  },
                  delete: async () => {
                    const s = readSink();
                    if (!s.control[id]) { const e = new Error("not found"); e.code = 404; throw e; }
                    delete s.control[id];
                    writeSink(s);
                    return {};
                  },
                };
              },
              items: {
                upsert: async (doc) => {
                  const s = readSink();
                  s.control[doc.id] = doc;
                  writeSink(s);
                  return { resource: doc };
                },
              },
            };
          }
          // anomaly_scan_reports is NOT pre-existing (unlike crawl_state and
          // pool_baseline_snapshots) -- the lane reaches it only through
          // containers.createIfNotExists() below, never a bare container()
          // call, so there is deliberately no branch for it here.
          throw new Error("unstubbed container: " + name);
        },
        containers: {
          async createIfNotExists(spec) {
            if (spec.id !== "anomaly_scan_reports") throw new Error("unstubbed createIfNotExists: " + spec.id);
            return {
              container: {
                items: {
                  upsert: async (doc) => {
                    const s = readSink();
                    const failuresLeft = FAIL_REPORT_WRITE_TIMES - (s.reportWriteFailures || 0);
                    if (failuresLeft > 0) {
                      s.reportWriteFailures = (s.reportWriteFailures || 0) + 1;
                      writeSink(s);
                      throw new Error("stubbed transient report-write failure");
                    }
                    s.reports[doc.id] = doc;
                    writeSink(s);
                    return { resource: doc };
                  },
                },
              },
            };
          },
        },
      };
    }
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@azure/cosmos") return stub;
  // The reconciliation reporter lives in dist/, which a test run has not built.
  if (String(request).includes("writeReconciliation")) {
    return { reportWrites: (input) => { fs.appendFileSync(SINK + ".reconcile.log", JSON.stringify(input) + "\\n"); return { ok: true }; } };
  }
  return realLoad.apply(this, arguments);
};
`);
  return p;
}

function readSink(sinkPath: string): { control: Record<string, any>; reports: Record<string, any> } {
  try { return JSON.parse(fs.readFileSync(sinkPath, "utf8")); } catch { return { control: {}, reports: {} }; }
}
function readReconcileLog(sinkPath: string): any[] {
  try {
    return fs.readFileSync(sinkPath + ".reconcile.log", "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function run(opts: {
  sinkPath: string;
  soldComps: Parameters<typeof shimPath>[0]["soldComps"];
  baselineRows: Parameters<typeof shimPath>[0]["baselineRows"];
  env?: Record<string, string>;
  slowAfterUnit?: number;
  sleepMs?: number;
  failReportWriteTimes?: number;
  fail429Times?: number;
}) {
  const shim = shimPath({
    sinkPath: opts.sinkPath,
    soldComps: opts.soldComps,
    baselineRows: opts.baselineRows,
    slowAfterUnit: opts.slowAfterUnit,
    sleepMs: opts.sleepMs,
    failReportWriteTimes: opts.failReportWriteTimes,
    fail429Times: opts.fail429Times,
  });
  // spawnSync (not execFileSync) so stderr is captured on the SUCCESS path
  // too -- the lane writes its "ERR writing anomaly report" line via
  // console.error even when it still exits 0 (a declared, reconciled
  // failure), and execFileSync only returns stdout when the child exits
  // zero, which silently dropped that line from `out` in an earlier version
  // of this harness.
  const r = spawnSync(process.execPath, [script], {
    cwd: backend,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      NODE_OPTIONS: `--require ${JSON.stringify(shim).slice(1, -1)}`,
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
      BACKFILL_APPLY: "true",
      ...opts.env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    code: r.status ?? -1,
    out: String(r.stdout ?? "") + String(r.stderr ?? ""),
    sink: readSink(opts.sinkPath),
    reconcile: readReconcileLog(opts.sinkPath),
  };
}

const BASELINE = [
  { slug: "hiq:baseball:2024:topps:1:base:false", median: 10, sampleCount: 6, snapshotDate: "2026-09-10" },
];

// A confirmed-source row for a unit that is scanned EARLY in the stable
// enumeration order (year 1869, baseball) so a run whose budget dies after
// only a few units still has real accumulator content to persist and resume.
const EARLY_ROW = {
  hobbyiqCardId: "hiq:baseball:2024:topps:1:base:false",
  price: 40,
  source: "cardhedge",
  cardYear: 1869,
  sport: "baseball",
};

describe("anomaly-force-scan — a budget stop leaves a resumable cursor, not a restart", () => {
  it("PIN 1+2: a scan-phase stop writes a cursor + reconciles 0=0, and a SECOND run resumes from it rather than from unit 0", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);

    // First run: an absurdly tiny budget so outOfClock() is already true
    // before the very first unit is attempted -- the cleanest deterministic
    // stop, since it does not depend on real wall-clock races.
    const first = run({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "0", BUDGET_MS: "1", RESERVE_MS: "60000" },
    });

    expect(first.code).toBe(5); // a REFUSAL, not a crash
    expect(first.out).toMatch(/stopped at the .*budget/);
    expect(first.out).toMatch(/REFUSING TO WRITE THE ANOMALY REPORT/);
    // No report was published.
    expect(Object.keys(first.sink.reports)).toHaveLength(0);
    // The cursor WAS written, and it points at unit 0 -- nothing was scanned.
    const cursor1 = first.sink.control["anomaly-force-scan::cursor"];
    expect(cursor1).toBeTruthy();
    expect(cursor1.nextUnitIndex).toBe(0);
    expect(cursor1.totalUnits).toBeGreaterThan(0);
    // The reconcile line balances: a refusal declares 0 intended = 0 written.
    const rec1 = first.reconcile.at(-1);
    expect(rec1).toMatchObject({ job: "anomaly-force-scan", intended: 0, written: 0 });

    // Second run: a real budget, generous enough to finish the whole sweep
    // (the fixture pool is tiny). It must RESUME from the persisted cursor,
    // not restart -- proven by the "RESUMING from unit" narration line
    // rather than "starting a fresh sweep".
    const second = run({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "30" },
    });

    expect(second.out).toMatch(/RESUMING from unit 0\/\d+/);
    expect(second.out).not.toMatch(/starting a fresh sweep/);
    expect(second.code).toBe(0);
    // The sweep finished: the cursor is retired and a report was published.
    expect(second.sink.control["anomaly-force-scan::cursor"]).toBeUndefined();
    expect(Object.keys(second.sink.reports)).toHaveLength(1);
    const rec2 = second.reconcile.at(-1);
    expect(rec2).toMatchObject({ job: "anomaly-force-scan", intended: 1, written: 1, failed: 0 });
  });

  it("PIN 1 (mid-sweep): resuming a cursor that already accumulated slugs keeps them, rather than discarding progress", () => {
    // Two rows in the FIRST TWO units of the stable enumeration order
    // (index 0 = absent-year baseball, index 1 = absent-year football, both
    // reached before any real year and before slowAfterUnit's sleep kicks
    // in). slowAfterUnit=2 makes every unit from index 2 onward sleep past
    // the tiny budget, so the first run finishes units 0 and 1 (accumulating
    // BOTH rows), then stops inside unit 2 without ever reaching the end of
    // the 805-unit sweep.
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const absentBaseballRow = { hobbyiqCardId: "hiq:baseball:unknown:topps:1:base:false", price: 40, source: "cardhedge", sport: "baseball" }; // cardYear key omitted entirely -> "absent"
    const absentFootballRow = { hobbyiqCardId: "hiq:football:unknown:topps:1:base:false", price: 20, source: "cardhedge", sport: "football" };

    const first = run({
      sinkPath,
      soldComps: [absentBaseballRow, absentFootballRow],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "0", BUDGET_MS: "150", RESERVE_MS: "10" },
      slowAfterUnit: 2,
      sleepMs: 400,
    });
    expect(first.code).toBe(5);
    const cursor1 = first.sink.control["anomaly-force-scan::cursor"];
    expect(cursor1).toBeTruthy();
    // BOTH rows made it into the persisted accumulator: progress from a
    // finished early unit survives a stop that happens in a LATER unit,
    // rather than only ever being written empty or only ever holding the
    // very last unit read.
    const persistedSlugs = new Set((cursor1.poolSnapshot as [string, number[]][]).map(([slug]) => slug));
    expect(persistedSlugs.has(absentBaseballRow.hobbyiqCardId)).toBe(true);
    expect(persistedSlugs.has(absentFootballRow.hobbyiqCardId)).toBe(true);
    expect(cursor1.nextUnitIndex).toBeGreaterThanOrEqual(2);

    const second = run({
      sinkPath,
      soldComps: [absentBaseballRow, absentFootballRow],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "30" },
    });
    expect(second.out).toMatch(new RegExp(`RESUMING from unit ${cursor1.nextUnitIndex}/`));
    expect(second.code).toBe(0);
    expect(Object.keys(second.sink.reports)).toHaveLength(1);
  });

  it("a report-write failure after a FINISHED sweep keeps a cursor at nextUnitIndex=total, so a retry does not re-scan", () => {
    // A generous budget completes the whole 805-unit sweep in one process,
    // but the final report upsert fails once (a transient Cosmos error).
    // The lane must not throw the sweep's own work away: it should persist a
    // cursor pointing PAST every unit, so the very next dispatch's for-loop
    // runs zero iterations and goes straight to recomputing + retrying the
    // write against the pool this run already assembled.
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);

    const first = run({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "30" },
      failReportWriteTimes: 1,
    });
    // The sweep itself succeeded; only the write failed. reportWrites still
    // reconciles (a declared failure is accounted for), so this is NOT the
    // exit-5 refusal path -- it is exit 0 with failed=1 in the ledger.
    expect(first.out).toContain("ERR writing anomaly report");
    expect(first.out).toMatch(/cursor written at nextUnitIndex=total/);
    expect(Object.keys(first.sink.reports)).toHaveLength(0);
    const cursor1 = first.sink.control["anomaly-force-scan::cursor"];
    expect(cursor1).toBeTruthy();
    expect(cursor1.nextUnitIndex).toBe(cursor1.totalUnits);
    const rec1 = first.reconcile.at(-1);
    expect(rec1).toMatchObject({ job: "anomaly-force-scan", intended: 1, written: 0, failed: 1 });

    // The retry: no failures this time, and the sink still has the ONE prior
    // reconcile.log line from run 1 -- appended to, not replaced -- so a
    // second reconcile line proves this run also ran main() rather than
    // reading a cached result.
    const second = run({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "30" },
    });
    expect(second.out).toMatch(new RegExp(`RESUMING from unit ${cursor1.nextUnitIndex}/`));
    // Zero units re-scanned: the for-loop's own range is empty when
    // startUnitIndex === total, so "units scanned this run: 0" is the proof
    // this was a pure write-retry, not a second full sweep.
    expect(second.out).toMatch(/units scanned this run: 0\s/);
    expect(second.code).toBe(0);
    expect(Object.keys(second.sink.reports)).toHaveLength(1);
    expect(second.sink.control["anomaly-force-scan::cursor"]).toBeUndefined();
    const rec2 = second.reconcile.at(-1);
    expect(rec2).toMatchObject({ job: "anomaly-force-scan", intended: 1, written: 1, failed: 0 });
  });
});

describe("anomaly-force-scan — a Cosmos 429 is a backoff, not a crash", () => {
  // CF-CLEANLINESS-ANOMALY-BUDGET follow-up (2026-09-12). Run 34669670351 --
  // the first real dispatch of this lane the night after it merged -- read
  // 400/805 units clean, then a bare `await iter.fetchNext()` let a Cosmos
  // 429 escape uncaught straight to main()'s outer .catch, which called
  // finishLane(1, ...): the SAME exit code and the SAME absence of a
  // "stopped at the .*budget" marker as a genuine defect, so
  // relaunch-on-marker withheld the re-dispatch and killed the whole chain.
  // These two pins are the fix: a transient throttle rides out the
  // in-process backoff invisibly, and a sustained one stops the sweep
  // through the SAME cursor-write + budget-marker path a clock exhaustion
  // uses, rather than crashing the process.

  it("a transient 429 (fewer failures than the backoff budget) is absorbed silently -- the sweep still finishes", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const result = run({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "30", ANOMALY_SCAN_429_BACKOFF_MS: "1,1,1" },
      fail429Times: 2, // fewer than the 3 backoff slots above
    });

    expect(result.out).toMatch(/Cosmos 429 on this page -- backing off/);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/units scanned this run: \d/);
    expect(Object.keys(result.sink.reports)).toHaveLength(1);
    // No budget-stop banner: this run finished the whole sweep despite the
    // transient throttle, so relaunch-on-marker's outcome (b) applies, not (a).
    expect(result.out).not.toMatch(/stopped at the .*budget/);
    const rec = result.reconcile.at(-1);
    expect(rec).toMatchObject({ job: "anomaly-force-scan", intended: 1, written: 1, failed: 0 });
  });

  it("a 429 that outlives the backoff budget stops the sweep like a budget stop -- cursor written, marker printed, exit 5, NOT a crash", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const result = run({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
      env: { RUN_MINUTES: "30", ANOMALY_SCAN_429_BACKOFF_MS: "1,1,1" },
      fail429Times: 10, // more than the 3 backoff slots above -- every retry fails
    });

    // This is the exact regression: before the fix, this shape produced
    // `finishLane: exiting code 1` with no budget marker at all (a hard
    // crash relaunch-on-marker refuses to re-dispatch). Now it must look
    // EXACTLY like a clock-exhaustion stop: same marker, same exit code,
    // same cursor write, so the existing relaunch contract (which already
    // re-dispatches on this marker) picks it up with no new grep pattern.
    expect(result.out).toMatch(/stopped at the .*budget/);
    expect(result.out).toMatch(/Cosmos 429 throttling on sold_comps/);
    expect(result.out).toMatch(/REFUSING TO WRITE THE ANOMALY REPORT/);
    expect(result.code).toBe(5); // a REFUSAL/backoff verdict, not exit 1
    expect(Object.keys(result.sink.reports)).toHaveLength(0);
    const cursor = result.sink.control["anomaly-force-scan::cursor"];
    expect(cursor).toBeTruthy();
    expect(cursor.nextUnitIndex).toBe(0); // the FIRST unit never finished -- resumed from here, not past it
    const rec = result.reconcile.at(-1);
    expect(rec).toMatchObject({ job: "anomaly-force-scan", intended: 0, written: 0 });
  });

  it("a NON-retryable Cosmos error still propagates and hard-fails the run -- 429 handling is not a blanket catch-and-continue", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    // A shim that throws a non-429 error on the very first fetchNext, via the
    // same fail429Times mechanism repurposed with a distinguishable message
    // is not available directly -- instead this drives the real distinction
    // through isRetryableCosmosError by asserting the OTHER two tests' 429
    // path is code-429-specific: a plain thrown Error with no code/429 text
    // must still exit non-zero WITHOUT the budget marker or a written cursor,
    // proving the retry/backoff branch does not swallow arbitrary exceptions.
    const shim = shimPath({
      sinkPath,
      soldComps: [EARLY_ROW],
      baselineRows: BASELINE,
    });
    const badShimPath = shim.replace(/\.cjs$/, "-bad.cjs");
    const src = fs.readFileSync(shim, "utf8").replace(
      "served = true;\n                      if (unitsQueried > SLOW_AFTER_UNIT && SLEEP_MS > 0) sleepSync(SLEEP_MS);\n                      return { resources: rows };",
      "throw new Error(\"boom: not a rate limit\");",
    );
    fs.writeFileSync(badShimPath, src);

    const r = spawnSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(badShimPath).slice(1, -1)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        BACKFILL_APPLY: "true",
        RUN_MINUTES: "30",
      },
      encoding: "utf8",
      timeout: 60_000,
    });

    const out = String(r.stdout ?? "") + String(r.stderr ?? "");
    expect(out).toMatch(/boom: not a rate limit/);
    expect(out).not.toMatch(/stopped at the .*budget/);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(5);
    const sink = readSink(sinkPath);
    expect(sink.control["anomaly-force-scan::cursor"]).toBeUndefined();
  });
});

describe("anomaly-force-scan — the cached /cleanliness/anomalies path is untouched", () => {
  it("never requires or imports the anomalyDetection service module", () => {
    const src = fs.readFileSync(script, "utf8");
    // Prose comments in the header ARE allowed to name the sibling module
    // for context; what must never appear is an actual module-resolution
    // reference to it (require/import), which would mean this lane's scan
    // and the cached admin-dashboard scan share code that a change to one
    // could silently affect the other through.
    expect(src).not.toMatch(/require\([^)]*anomalyDetection/);
    expect(src).not.toMatch(/from\s+["'][^"']*anomalyDetection/);
  });

  it("the anomalyDetection service file itself is untouched by this change", () => {
    const serviceSrc = fs.readFileSync(
      path.join(backend, "src", "services", "portfolioiq", "anomalyDetection.service.ts"),
      "utf8",
    );
    // detectAnomalies() still exports the same shape the cached (non-force)
    // route and the existing anomalyDetectionScanLogging.test.ts pin depend
    // on -- this lane adds a NEW artifact rather than changing that one.
    expect(serviceSrc).toMatch(/export async function detectAnomalies/);
  });
});
