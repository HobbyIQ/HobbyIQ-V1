/**
 * refresh-market-signals.cjs -- CF-MARKET-SIGNALS-SCAN-BUDGET (2026-09-12).
 *
 * Drives the COMMITTED lane script through a stubbed Cosmos (never a
 * reimplementation of its loop), the same harness shape
 * tests/anomalyForceScanResume.test.ts uses for anomaly-force-scan.cjs:
 * @azure/cosmos and the dist/ marketMomentum + writeReconciliation imports
 * are intercepted at the module-resolution boundary via
 * `NODE_OPTIONS=--require <shim>`, so scripts/lib/runner-budget.cjs's real
 * budget()/finishLane() run unmodified and the assertions are about what the
 * real script does with a real (tiny) clock.
 *
 * THE FAILURE THIS PINS. Run 34688789170 (2026-09-12) read 5,071,211 of a
 * multi-million-row 60-day window in the full 12-minute budget and never
 * finished the scan -- and until this fix, a stop there kept NOTHING: the
 * next dispatch re-read the identical prefix from row zero, guaranteed to
 * lose the same race by a wider margin as the pool keeps growing. This file
 * pins the fix in four parts:
 *
 *   1. a scan-phase budget stop persists a resumable cursor (continuation
 *      token + the rows already read, chunked across crawl_state docs) and
 *      a SUBSEQUENT run resumes the physical scan from there rather than
 *      from row zero -- proven by fewer fetchNext() calls on the second run
 *      than a fresh scan would need, and by the emitted signals reflecting
 *      rows from BOTH runs;
 *   2. a cursor older than CURSOR_MAX_AGE_MS (the window has moved on to a
 *      different dispatch) is discarded rather than resumed from;
 *   3. a transient Cosmos 429 on a page fetch is absorbed by the in-process
 *      backoff and the scan still finishes; a 429 that outlives the backoff
 *      stops the scan through the EXACT SAME cursor-write + budget-marker +
 *      exit-5 path a clock exhaustion uses, never a bare crash;
 *   4. the reportWrites reconciliation line balances for both a scan-phase
 *      refusal (intended 0 = written 0) and a finished run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "refresh-market-signals.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-signals-scan-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

type SoldCompRow = {
  soldAt: string;
  price: number;
  sport: string;
  isAuto: boolean;
  autoStyle: string | null;
  hobbyiqCardId: string;
  gradeCompany: string | null;
  gradeValue: number | null;
  composite: { colorFamily?: string; edition?: string; finishModifier?: string; insertSet?: string } | null;
};

/**
 * The stubbed Cosmos world, injected via NODE_OPTIONS --require. A JSON file
 * (STATE_SINK) is the durable store both the shim and the test process read,
 * so state survives across the TWO SEPARATE PROCESS invocations a resume
 * test needs (the first run's stop, the second run's resume).
 *
 * sold_comps is served in fixed-size pages (PAGE_SIZE rows each) with a
 * continuation token that is just the next page index as a string -- good
 * enough for a stub: it does not need to be a real Cosmos token, only to
 * exercise the SAME resume contract (pass the token back in, get the next
 * page, `hasMoreResults()` false once exhausted).
 */
function shimPath(opts: {
  sinkPath: string;
  soldComps: SoldCompRow[];
  pageSize?: number;
  fail429Times?: number;
  /** Sleep this many ms inside fetchNext() before resolving, so real wall-
   *  clock time passes between pages and a tiny BUDGET_MS can deterministically
   *  admit exactly one page before outOfClock() trips ahead of the next. */
  sleepMsPerPage?: number;
}): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");

const SINK = ${JSON.stringify(opts.sinkPath)};
const SOLD_COMPS = ${JSON.stringify(opts.soldComps)};
const PAGE_SIZE = ${JSON.stringify(opts.pageSize ?? 2)};
const FAIL_429_TIMES = ${JSON.stringify(opts.fail429Times ?? 0)};
const SLEEP_MS_PER_PAGE = ${JSON.stringify(opts.sleepMsPerPage ?? 0)};

function readSink() {
  try { return JSON.parse(fs.readFileSync(SINK, "utf8")); }
  catch { return { control: {}, signals: {}, fetchNextCalls: 0, rateLimitFailuresUsed: 0 }; }
}
function writeSink(s) { fs.writeFileSync(SINK, JSON.stringify(s)); }
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

const stub = {
  CosmosClient: class {
    database() {
      return {
        container(name) {
          if (name === "sold_comps") {
            return {
              items: {
                query(spec, feedOptions) {
                  const { parameters } = spec;
                  const since = (parameters || []).find((p) => p.name === "@since")?.value;
                  const rows = SOLD_COMPS.filter((r) => !since || r.soldAt >= since);
                  let startIndex = 0;
                  const ct = feedOptions && feedOptions.continuationToken;
                  if (ct) startIndex = Number(ct);
                  let cursor = startIndex;
                  return {
                    hasMoreResults() { return cursor < rows.length; },
                    async fetchNext() {
                      const s = readSink();
                      s.fetchNextCalls = (s.fetchNextCalls || 0) + 1;
                      writeSink(s);

                      if (FAIL_429_TIMES > 0) {
                        const usedSoFar = s.rateLimitFailuresUsed || 0;
                        if (usedSoFar < FAIL_429_TIMES) {
                          s.rateLimitFailuresUsed = usedSoFar + 1;
                          writeSink(s);
                          const e = new Error("ErrorResponse: The request rate is too large. Please retry after sometime. Learn more: http://aka.ms/cosmosdb-error-429");
                          e.code = 429;
                          throw e;
                        }
                      }

                      if (SLEEP_MS_PER_PAGE > 0) sleepSync(SLEEP_MS_PER_PAGE);
                      const page = rows.slice(cursor, cursor + PAGE_SIZE);
                      cursor += PAGE_SIZE;
                      const more = cursor < rows.length;
                      return {
                        resources: page,
                        continuationToken: more ? String(cursor) : undefined,
                        continuation: more ? String(cursor) : undefined,
                      };
                    },
                  };
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
          if (name === "market_signals") {
            return {
              items: {
                upsert: async (doc) => {
                  const s = readSink();
                  s.signals[doc.id || (doc.dimension + "::" + doc.key)] = doc;
                  writeSink(s);
                  return { resource: doc };
                },
              },
            };
          }
          throw new Error("unstubbed container: " + name);
        },
      };
    }
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // refresh-market-signals.cjs requires this via an ABSOLUTE path
  // (path.join(backend, "node_modules/@azure/cosmos")), not the bare
  // specifier -- unlike anomaly-force-scan.cjs's require("@azure/cosmos").
  // Matching only the bare string here would let the REAL SDK load and try
  // a live network call against the fake AccountEndpoint, which hangs on
  // DNS/connect rather than failing fast. Normalise backslashes (string
  // methods only -- calling require() from inside an overridden
  // Module._load recurses) and match both the bare specifier and the
  // absolute-path form.
  const reqNorm = String(request).split("").map((ch) => (ch === String.fromCharCode(92) ? "/" : ch)).join("");
  const isCosmosSpecifier = reqNorm === "@azure/cosmos" || reqNorm.endsWith("node_modules/@azure/cosmos");
  if (isCosmosSpecifier) return stub;
  // marketMomentum.service.js and writeReconciliation.js live in dist/, and
  // marketMomentum additionally pulls in cosmosConnectionPolicy.js -- none of
  // which a test run needs the REAL Cosmos wiring for.
  if (String(request).includes("cosmosConnectionPolicy")) {
    return { cosmosOptionsFromConnectionString: (cs) => ({ connectionString: cs }) };
  }
  if (String(request).includes("writeReconciliation")) {
    return { reportWrites: (input) => { fs.appendFileSync(SINK + ".reconcile.log", JSON.stringify(input) + "\\n"); return { ok: true }; } };
  }
  if (String(request).includes("marketMomentum.service")) {
    return {
      upsertMomentumSignal: async (doc) => {
        const s = readSink();
        const dateKey = doc.computedAt.slice(0, 10);
        const id = doc.dimension + "::" + doc.key + "::" + dateKey;
        s.signals[id] = doc;
        writeSink(s);
      },
    };
  }
  return realLoad.apply(this, arguments);
};
`);
  return p;
}

function readSink(sinkPath: string): { control: Record<string, any>; signals: Record<string, any>; fetchNextCalls: number } {
  try { return JSON.parse(fs.readFileSync(sinkPath, "utf8")); }
  catch { return { control: {}, signals: {}, fetchNextCalls: 0 }; }
}
function readReconcileLog(sinkPath: string): any[] {
  try {
    return fs.readFileSync(sinkPath + ".reconcile.log", "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function run(opts: {
  sinkPath: string;
  soldComps: SoldCompRow[];
  pageSize?: number;
  fail429Times?: number;
  sleepMsPerPage?: number;
  env?: Record<string, string>;
}) {
  const shim = shimPath({
    sinkPath: opts.sinkPath,
    soldComps: opts.soldComps,
    pageSize: opts.pageSize,
    fail429Times: opts.fail429Times,
    sleepMsPerPage: opts.sleepMsPerPage,
  });
  const r = spawnSync(process.execPath, [script], {
    cwd: backend,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      NODE_OPTIONS: `--require ${JSON.stringify(shim).slice(1, -1)}`,
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
      MARKET_SIGNALS_APPLY: "true",
      MARKET_SIGNALS_MIN_VOLUME: "1",
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

const NOW = Date.now();
const isoMinutesAgo = (mins: number) => new Date(NOW - mins * 60000).toISOString();

/** Six rows, all well inside a 30-day window (so WINDOW_DAYS=30 default puts
 *  every row in the "current" bucket) with a composite so the scan's own
 *  `IS_DEFINED(c.composite)` predicate keeps them, and distinct colorFamily
 *  values so more than one signal key exists. */
function fixtureRows(n: number): SoldCompRow[] {
  return Array.from({ length: n }, (_, i) => ({
    soldAt: isoMinutesAgo(5 + i),
    price: 10 + i,
    sport: "baseball",
    isAuto: false,
    autoStyle: null,
    hobbyiqCardId: `hiq:baseball:2024:topps:${i}:base:false`,
    gradeCompany: null,
    gradeValue: null,
    composite: { colorFamily: i % 2 === 0 ? "GOLD" : "BLUE" },
  }));
}

describe("refresh-market-signals — a scan-phase budget stop leaves a resumable cursor, not a restart", () => {
  it("PIN 1+2: a scan-phase stop writes a cursor, and a SECOND run resumes from it rather than re-reading row 0", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(6); // 3 pages of 2 rows each

    // First run: each page fetch sleeps 150ms (real wall-clock time), and
    // the budget's RESERVE_MS (200ms) sits between one and two page-times.
    // outOfClock() is checked BEFORE each fetch: at t=0 (before page 1)
    // there is a full 300ms budget left, comfortably over the 200ms reserve,
    // so page 1 is fetched; by the time the pre-check for page 2 runs
    // (t>=150ms), only <=150ms remains, which is under the 200ms reserve, so
    // the loop stops there deterministically -- not racing on an instant
    // in-memory fetch completing in under a millisecond.
    const first = run({
      sinkPath,
      soldComps: rows,
      pageSize: 2,
      sleepMsPerPage: 150,
      env: { RUN_MINUTES: "5", BUDGET_MS: "300", RESERVE_MS: "200" },
    });

    expect(first.code).toBe(5); // a REFUSAL, not a crash
    expect(first.out).toMatch(/stopped at the .*budget/);
    expect(first.out).toMatch(/REFUSING TO EMIT SIGNALS/);
    expect(first.out).toMatch(/scan cursor written/);
    // No signals were published.
    expect(Object.keys(first.sink.signals)).toHaveLength(0);
    // The cursor manifest exists and carries fewer rows than the full fixture.
    const manifest1 = first.sink.control["refresh-market-signals::scan-cursor"];
    expect(manifest1).toBeTruthy();
    expect(manifest1.rowCount).toBeGreaterThan(0);
    expect(manifest1.rowCount).toBeLessThan(rows.length);
    expect(manifest1.continuationToken).toBeTruthy();
    const rec1 = first.reconcile.at(-1);
    expect(rec1).toMatchObject({ job: "refresh-market-signals", intended: 0, written: 0 });

    const fetchNextCallsFirstRun = first.sink.fetchNextCalls;

    // Second run: a generous budget, same fixture (same @since window --
    // the fixture's soldAt values are relative to a fixed NOW computed once
    // at module load, so both runs see the identical window as long as they
    // execute within the same wall-clock minute bucket the ISO strings were
    // built from).
    const second = run({
      sinkPath,
      soldComps: rows,
      pageSize: 2,
      env: { RUN_MINUTES: "30" },
    });

    expect(second.out).toMatch(/RESUMING scan from cursor/);
    expect(second.code).toBe(0);
    // The cursor is retired once the scan finishes.
    expect(second.sink.control["refresh-market-signals::scan-cursor"]).toBeUndefined();
    // Signals were published from the FULL row set (both colorFamily keys).
    const goldSignal = Object.values(second.sink.signals).find((d: any) => d.dimension === "colorFamily" && d.key === "GOLD") as any;
    const blueSignal = Object.values(second.sink.signals).find((d: any) => d.dimension === "colorFamily" && d.key === "BLUE") as any;
    expect(goldSignal).toBeTruthy();
    expect(blueSignal).toBeTruthy();
    // currVolume across GOLD+BLUE must reflect all 6 rows, not just the rows
    // the second run's own fetchNext calls served -- proving the resumed run
    // combined the persisted cursor rows with the freshly-fetched ones.
    expect(goldSignal.metrics.currVolume + blueSignal.metrics.currVolume).toBe(rows.length);

    // The second run needed strictly fewer fetchNext() calls than a cold
    // scan of all 6 rows at pageSize 2 would (3 calls) -- it only fetched the
    // remaining page(s) the first run had not yet reached.
    const fetchNextCallsSecondRun = second.sink.fetchNextCalls - fetchNextCallsFirstRun;
    expect(fetchNextCallsSecondRun).toBeLessThan(3);
  });

  it("a cursor older than CURSOR_MAX_AGE_MS is discarded, not resumed from", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(4);

    // Seed a cursor by hand with an `updatedAt` far in the past -- older than
    // the (tiny, test-only) MARKET_SIGNALS_CURSOR_MAX_AGE_MS the run below
    // sets, so it is discarded regardless of its sinceIso/continuationToken.
    const seedProc = spawnSync(process.execPath, ["-e", `
      const fs = require("fs");
      const rows = ${JSON.stringify(rows.slice(0, 2))};
      const s = { control: {}, signals: {}, fetchNextCalls: 0 };
      s.control["refresh-market-signals::scan-cursor"] = {
        id: "refresh-market-signals::scan-cursor",
        sinceIso: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        continuationToken: "2",
        rowCount: 2,
        chunkCount: 1,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };
      s.control["refresh-market-signals::scan-cursor::chunk::0"] = { rows };
      fs.writeFileSync(${JSON.stringify(sinkPath)}, JSON.stringify(s));
    `], { encoding: "utf8" });
    expect(seedProc.status).toBe(0);

    // MAX_AGE_MS well under the one-hour-old cursor seeded above.
    const result = run({
      sinkPath, soldComps: rows, pageSize: 2,
      env: { RUN_MINUTES: "30", MARKET_SIGNALS_CURSOR_MAX_AGE_MS: "1000" },
    });

    expect(result.out).toMatch(/starting a fresh scan \(discarding a cursor too old to trust/);
    expect(result.code).toBe(0);
  });
});

describe("refresh-market-signals — a Cosmos 429 mid-scan is a backoff, not a crash", () => {
  it("a transient 429 (fewer failures than the backoff budget) is absorbed silently -- the scan still finishes", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(4);
    const result = run({
      sinkPath,
      soldComps: rows,
      pageSize: 2,
      fail429Times: 2, // fewer than the 3 default backoff slots
      env: { RUN_MINUTES: "30", MARKET_SIGNALS_429_BACKOFF_MS: "1,1,1" },
    });

    expect(result.out).toMatch(/Cosmos 429 on this page -- backing off/);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/stopped at the .*budget/);
    const rec = result.reconcile.at(-1);
    expect(rec).toMatchObject({ job: "refresh-market-signals" });
    expect(rec.intended).toBeGreaterThan(0);
    expect(rec.intended).toBe(rec.written);
  });

  it("a 429 that outlives the backoff budget stops the scan like a budget stop -- cursor written, marker printed, exit 5, NOT a crash", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(4);
    const result = run({
      sinkPath,
      soldComps: rows,
      pageSize: 2,
      fail429Times: 10, // more than the 3 backoff slots -- every retry fails
      env: { RUN_MINUTES: "30", MARKET_SIGNALS_429_BACKOFF_MS: "1,1,1" },
    });

    // This is the exact regression #2068 fixed one lane over: before this
    // fix, an uncaught 429 on a bare fetchNext() would propagate to main()'s
    // outer .catch and hard-fail with no budget marker at all.
    expect(result.out).toMatch(/stopped at the .*budget/);
    expect(result.out).toMatch(/Cosmos is throttling sold_comps \(429\)/);
    expect(result.out).toMatch(/REFUSING TO EMIT SIGNALS/);
    expect(result.code).toBe(5);
    expect(Object.keys(result.sink.signals)).toHaveLength(0);
    const manifest = result.sink.control["refresh-market-signals::scan-cursor"];
    expect(manifest).toBeTruthy();
    const rec = result.reconcile.at(-1);
    expect(rec).toMatchObject({ job: "refresh-market-signals", intended: 0, written: 0 });
  });

  it("a NON-retryable Cosmos error still propagates and hard-fails the run -- 429 handling is not a blanket catch-and-continue", () => {
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(2);
    const shim = shimPath({ sinkPath, soldComps: rows, pageSize: 2 });
    const badShimPath = shim.replace(/\.cjs$/, "-bad.cjs");
    const src = fs.readFileSync(shim, "utf8").replace(
      "const page = rows.slice(cursor, cursor + PAGE_SIZE);",
      "throw new Error(\"boom: not a rate limit\");\n                      const page = rows.slice(cursor, cursor + PAGE_SIZE);",
    );
    fs.writeFileSync(badShimPath, src);

    const r = spawnSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(badShimPath).slice(1, -1)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        MARKET_SIGNALS_APPLY: "true",
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
    expect(sink.control["refresh-market-signals::scan-cursor"]).toBeUndefined();
  });
});

describe("refresh-market-signals — the scan rate is measured and printed", () => {
  it("prints a rows/s line via a warning-level channel after a scan that read at least one row", () => {
    // sleepMsPerPage guarantees measurable elapsed time deterministically --
    // without it, a CI runner fast enough to serve every in-memory page
    // inside the same millisecond legitimately measures elapsedS=0, which is
    // the OTHER (unmeasurable-rate) branch this line supports, not a bug in
    // either the line or this pin.
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(4);
    const result = run({ sinkPath, soldComps: rows, pageSize: 2, sleepMsPerPage: 5, env: { RUN_MINUTES: "30" } });

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/scan rate: [\d,]+ rows\/s/);
  });

  it("still prints the row count and elapsed time when elapsed time rounds to unmeasurable", () => {
    // The regression this pins: run 34700743614 (PR #2080's own first CI
    // check) failed here because the ORIGINAL guard was `elapsedS > 0 &&
    // fetchedThisRun > 0` -- a scan fast enough that Date.now() before and
    // after the loop round to the SAME millisecond skipped the line
    // entirely, silently, rather than reporting an unmeasurably high rate.
    const sinkPath = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const rows = fixtureRows(4);
    const result = run({ sinkPath, soldComps: rows, pageSize: 2, env: { RUN_MINUTES: "30" } });

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/scan rate: ([\d,]+ rows\/s|rate unmeasurable \(elapsed < 1ms\))/);
  });
});
