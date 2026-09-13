/**
 * CF-A-CURSOR-CARRIES-RESUME-STATE-NOT-A-REPORT (2026-09-13, #2073 cursor-size
 * follow-up, run 34782080801 slot 12).
 *
 * THE DEFECT, MEASURED TONIGHT. `saveCensusCursor`'s `aggregate` argument used
 * to be `censusAggregateToJSON()` -- the WHOLE in-memory census aggregate,
 * including every per-row/per-sample field (`samples`, `sampleCards`,
 * `reasons`, `byTier`, `subclasses`, `splitByClass`/`splitSegments`/
 * `splitSamples`, the slug-shape and R-scope detail maps and their sample
 * arrays). `mergeCensusAggregate` concatenates/unions those on every resumed
 * load, so the cursor doc GREW WITHOUT BOUND across a long walk: measured
 * 2026-09-13, slot 12 reached 2,081,532 chars (slot 15: 2,061,854, slot 2:
 * 1,905,982, slot 5: 1,875,034, slot 16: 1,735,792), and slot 12's run
 * 34782080801 hit Cosmos's 2MB document ceiling, logging `could not save
 * census cursor for slot 12 (Request size is too large)` nine times before
 * exiting 5 -- the self-relaunch correctly withheld, but the shard never
 * converges either.
 *
 * THE FIX (this file's two halves):
 *
 *   1. `saveCensusCursor` now refuses (FATAL, no retry against Cosmos) to
 *      write a doc over `CENSUS_CURSOR_MAX_BYTES` (512KB), naming the single
 *      largest top-level field instead of the nine-retries-then-a-generic-
 *      warning shape run 34782080801 actually produced.
 *   2. `main()`'s two checkpoint call sites now pass
 *      `censusAggregateToCompactJSON()` -- `counts`, `stats`, `splitTotal`,
 *      `scopeCounts` (r26/r27/r28), all plain numbers -- instead of the full
 *      aggregate. `loadCensusCursor`/`mergeCensusAggregate` are UNCHANGED and
 *      still read a FAT cursor written before this fix (they only ever look
 *      at field names they know about, so a fat cursor's extra detail is
 *      silently ignored on merge, never an error) -- the first save AFTER
 *      loading one already writes the compact shape.
 *
 * THIS FILE pins:
 *   - the size guard firing with the offending field named, against the
 *     committed `saveCensusCursor`/`largestCursorField`/`CENSUS_CURSOR_MAX_BYTES`
 *     (rematchCensusCursorResume.test.ts's `fakeControl` convention);
 *   - a real, unexported `main()` pass (the same child-process convention
 *     rematchCensusCursorE2E.test.ts uses) resuming from a ~2MB FAT cursor
 *     seeded directly into the fake `rematch_control` state file, and the
 *     cursor it writes back being compact (< 50KB) and still correctly
 *     resumed (unit A skipped, only unit B re-read).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

function loadScript(env: Record<string, string> = {}) {
  for (const k of Object.keys(require_.cache)) {
    if (k.includes("rematch-sold-comps")) delete require_.cache[k];
  }
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return require_(path.join(backend, "scripts", "rematch-sold-comps.cjs")) as any; }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const noop = () => {};

/** A fake `rematch_control` container -- same shape as
 *  rematchCensusCursorResume.test.ts's fakeControl(). */
function fakeControl(seed: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  return {
    store,
    items: {
      upsert: async (doc: any) => { store.set(doc.id, { ...doc }); return { resource: { ...doc } }; },
    },
    item: (id: string) => ({
      read: async () => {
        const d = store.get(id);
        if (!d) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
    }),
  };
}

/** Build an old-shape (pre-compaction) fat aggregate whose serialised cursor
 *  doc is comfortably over both the 512KB guard and Cosmos's 2MB ceiling --
 *  the same shape `censusAggregateToJSON()` used to produce, before this fix
 *  removed it, with `samples`/`reasons` holding enough distinct entries to
 *  reach ~2MB the way a long real walk's merged detail did.
 *
 *  `realCounts`/`realSeen` are the SMALL numbers that must actually merge
 *  correctly (matching the fixture's real row counts) -- kept independent of
 *  the padding loop below, which exists ONLY to inflate byte size the way a
 *  real multi-day walk's distinct reasons/samples/tiers would, not to model
 *  a real row count in the thousands. */
function buildFatAggregate(targetBytes: number, realCounts: { AGREE: number }, realSeen: number) {
  const samples: Record<string, { cardId: string; line: string }[]> = { AGREE: [], IMPROVE: [] };
  const reasons: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let i = 0;
  // Pad with realistic-shaped sample lines until the serialised aggregate
  // clears targetBytes -- mirrors how a real census's `samples`/`reasons`
  // maps grow with every distinct card/reason the walk has seen, not with a
  // fixed cap (SAMPLE_CAP bounds ONE class's array length, not how many
  // classes or how many distinct reason/tier keys accumulate). This counter
  // is deliberately NOT what counts/stats below report -- see the doc
  // comment above.
  while (true) {
    const line = `hiq:baseball:1989:topps:${i}:base:no-auto  1989 Topps #${i} Some Player -- classified AGREE (tier=checklist-backed)`;
    samples.AGREE.push({ cardId: `hiq:baseball:1989:topps:${i}:base:no-auto`, line });
    reasons[`agree  checklist-match-${i}`] = i + 1;
    byTier[`agree/tier-${i % 7}`] = (byTier[`agree/tier-${i % 7}`] ?? 0) + 1;
    i++;
    if (i % 200 === 0) {
      const size = Buffer.byteLength(JSON.stringify({ samples, reasons, byTier }), "utf8");
      if (size >= targetBytes) break;
    }
    if (i > 2_000_000) throw new Error("buildFatAggregate: runaway loop, targetBytes never reached");
  }
  return {
    counts: { AGREE: realCounts.AGREE, IMPROVE: 0, CONFLICT: 0, UNDERIVABLE: 0 },
    stats: { seen: realSeen, otherSlot: 0, filtered: 0, prefiltered: 0, intended: 0, written: 0, skipped: 0, failed: 0, duplicatesLeft: 0, alreadyGone: 0, notReached: 0 },
    splitTotal: 0,
    byTier, defects: {}, reasons, subclasses: {},
    splitByClass: {}, splitSegments: {},
    slugShapeCounts: {}, slugShapeByClass: {},
    gftByGrader: {}, gftByGrade: {}, gftBySport: {},
    yfvByDecade: {}, yfvBySetKey: {}, yfvBySport: {},
    sfpByPair: {}, sfpBySetKey: {},
    samples, sampleCards: {}, slugShapeSamples: {},
    splitSamples: [], gftSamples: [], yfvSamples: [], sfpSamples: [],
  };
}

describe("CENSUS_CURSOR_MAX_BYTES guard -- saveCensusCursor refuses an oversized doc and names the field", () => {
  let warnSpy: any, errSpy: any, logSpy: any;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(noop);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    errSpy = vi.spyOn(console, "error").mockImplementation(noop);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("the guard constant is 512KB -- comfortably under Cosmos's 2MB document ceiling", () => {
    const S = loadScript();
    expect(S.CENSUS_CURSOR_MAX_BYTES).toBe(512 * 1024);
  });

  it("largestCursorField names the single biggest top-level field by its own JSON byte size", () => {
    const S = loadScript();
    const doc = { id: "x", small: 1, aggregate: { samples: "a".repeat(10_000) }, unitsDone: ["a"] };
    const { key, bytes } = S.largestCursorField(doc);
    expect(key).toBe("aggregate");
    expect(bytes).toBeGreaterThan(9_000);
  });

  it("a compact-shaped aggregate never trips the guard -- saveCensusCursor upserts normally", async () => {
    const S = loadScript();
    const control = fakeControl();
    const ok = await S.saveCensusCursor(control, 7, {
      unitsDone: ["y=2020"],
      aggregate: { counts: { AGREE: 10, IMPROVE: 2, CONFLICT: 0, UNDERIVABLE: 1 }, stats: { seen: 13 }, splitTotal: 0, scopeCounts: { r26: 0, r27: 0, r28: 0 } },
      classified: 13,
    });
    expect(ok).toBe(true);
    expect(control.store.get("census-cursor::slot-7")).toBeTruthy();
  });

  it("an aggregate whose 'samples' field alone exceeds 512KB is refused -- FATAL names 'aggregate', never attempts items.upsert", async () => {
    const S = loadScript();
    const upsert = vi.fn(async (doc: any) => ({ resource: doc }));
    const control = { items: { upsert } };
    const fatAggregate = buildFatAggregate(600 * 1024, { AGREE: 999999 }, 999999); // over the 512KB guard, well under Cosmos's 2MB ceiling
    const ok = await S.saveCensusCursor(control, 12, {
      unitsDone: ["y=1989"],
      aggregate: fatAggregate,
      classified: 999999,
    });
    expect(ok).toBe(false);
    // NEVER attempted the network call -- the whole point of a guard that
    // runs before saveCensusCursor's own try/upsert/catch is to skip straight
    // past the nine-retries-then-warn shape run 34782080801 actually hit.
    expect(upsert).not.toHaveBeenCalled();
    const errored = errSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
    expect(errored).toMatch(/FATAL/);
    expect(errored).toMatch(/slot 12/);
    // Names the actual offending field, not a generic "too big".
    expect(errored).toMatch(/"aggregate"/);
    expect(errored).toMatch(/524288-byte guard/); // the guard threshold (512 * 1024), so the line is self-explaining
  });

  it("a ~2MB fat aggregate (the measured slot-12 shape) also trips the guard", async () => {
    const S = loadScript();
    const upsert = vi.fn(async (doc: any) => ({ resource: doc }));
    const control = { items: { upsert } };
    const fatAggregate = buildFatAggregate(2_000_000, { AGREE: 1 }, 1);
    const ok = await S.saveCensusCursor(control, 12, { unitsDone: [], aggregate: fatAggregate, classified: 1 });
    expect(ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("censusAggregateToCompactJSON / the compact cursor contract, driven end to end against a seeded FAT cursor", () => {
  const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
  const PRELOAD = join(backend, "tests", "fixtures", "census-cursor-e2e", "fake-cosmos-preload.cjs");
  const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));
  const itIfBuilt = DIST_EXISTS ? it : it.skip;
  const TEST_TIMEOUT_MS = 60_000;

  let dir: string;
  let censusOut: string;
  let controlStateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "census-compact-e2e-"));
    censusOut = join(dir, "census");
    controlStateFile = join(dir, "control-state.json");
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  function runPass(opts: { slowUnitMs: number; runMinutes: string }) {
    const env = {
      ...process.env,
      MODE: "census",
      SLOT: "0",
      SLOTS: "32",
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
      RUN_MINUTES: opts.runMinutes,
      CENSUS_OUT: censusOut,
      CONTROL_STATE_FILE: controlStateFile,
      SLOW_UNIT_MS: String(opts.slowUnitMs),
    };
    return spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
      cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
    });
  }

  itIfBuilt("a pass that finds a ~2MB FAT cursor (old shape) still resumes correctly, and finishes by CLEARING it -- never re-writing it fat", () => {
    // Seed a FAT cursor for slot 0, exactly the pre-fix shape: unit A
    // ("y=2025/s=pokemon") already done, the merged aggregate carrying the
    // full per-row detail a real long walk would have accumulated. The
    // fixture's own signature (measuredAt/scope/sports/setkeyLike/years) must
    // match what a cold `main()` run computes, or loadCensusCursor's
    // signature check drops it as stale before this test ever proves the
    // resume -- SHARD_TABLE.measuredAt/APPLY_SCOPE_RAW/etc default the same
    // way across every other file in this suite, so an empty-env signature
    // (computed via loadScript() below) is the one to match against.
    const S = loadScript();
    const signature = S.censusCursorSignature();
    // realCounts/realSeen = 3, matching unit A's real 3-row fixture -- the
    // padding that reaches 2MB is pure detail bulk, never counted here.
    const fatAggregate = buildFatAggregate(2_000_000, { AGREE: 3 }, 3);
    const fatCursor = {
      id: "census-cursor::slot-0", kind: S.CENSUS_CURSOR_KIND, slot: 0, slots: 32,
      signature,
      unitsDone: ["y=2025/s=pokemon"],
      classified: 3,
      aggregate: fatAggregate,
      partialUnit: null,
      updatedAt: new Date().toISOString(),
    };
    const fatBytes = Buffer.byteLength(JSON.stringify(fatCursor), "utf8");
    expect(fatBytes).toBeGreaterThan(1_900_000); // this test is only meaningful if the seed really is ~2MB, matching tonight's measured slot sizes

    writeFileSync(controlStateFile, JSON.stringify({ "census-cursor::slot-0": fatCursor }), "utf8");

    // A generous, unslowed pass: unit A is already done (skipped via the
    // seeded cursor), so this pass only has to classify unit B (2 rows).
    const res = runPass({ slowUnitMs: 0, runMinutes: "10" });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    // RESUMED: the fat cursor's unitsDone/classified were read and honoured
    // -- unit A skipped, its 3 rows carried forward, only unit B's 2 rows
    // freshly classified (3 + 2 = 5 total), exactly as a compact-cursor
    // resume would report.
    expect(out).toMatch(/CENSUS CURSOR: resuming slot 0 -- 1 of 2 unit\(s\) already classified in a prior pass \(3 rows carried forward/);
    expect(out).toMatch(/CENSUS\s+slot 0\/32\s+rows classified 5\b/);

    // FINISHED: every unit is now done, so the cursor is CLEARED, not
    // rewritten -- either way, nothing fat is left behind.
    expect(out).toMatch(/CENSUS CURSOR: slot 0 finished within budget -- every unit classified, cursor cleared\./);
    const controlState = JSON.parse(readFileSync(controlStateFile, "utf8"));
    expect(controlState["census-cursor::slot-0"]).toBeUndefined();
  }, TEST_TIMEOUT_MS + 10_000);

  itIfBuilt("a pass that STOPS mid-walk after resuming a FAT cursor rewrites a COMPACT one (< 50KB), never re-inflating it", () => {
    const S = loadScript();
    const signature = S.censusCursorSignature();
    // unitsDone is EMPTY below (no unit finished yet) and there is no
    // partialUnit token, so this pass restarts unit A cold and reclassifies
    // all 3 of its rows itself -- the prior pass's carried-forward
    // counts/seen are correctly 0 here, independent of how fat its detail
    // fields (samples/reasons/byTier) already were.
    const fatAggregate = buildFatAggregate(2_000_000, { AGREE: 0 }, 0);
    const fatCursor = {
      id: "census-cursor::slot-0", kind: S.CENSUS_CURSOR_KIND, slot: 0, slots: 32,
      signature,
      unitsDone: [], // unit A NOT done yet -- this pass will re-walk it and then stop before unit B
      classified: 0,
      aggregate: fatAggregate,
      partialUnit: null,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(controlStateFile, JSON.stringify({ "census-cursor::slot-0": fatCursor }), "utf8");

    // Slow unit A enough that the tight budget trips right after it, before
    // unit B is ever queried -- same mechanism rematchCensusCursorE2E.test.ts
    // uses for its own "stops at the unit boundary" pass.
    const res = runPass({ slowUnitMs: 8000, runMinutes: "1.6" });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";
    expect(out).toMatch(/stopped at the 1\.6-minute budget/);
    expect(out).toMatch(/CENSUS CURSOR: checkpointed 1 of 2 unit\(s\) for slot 0/);

    const controlState = JSON.parse(readFileSync(controlStateFile, "utf8"));
    const rewritten = controlState["census-cursor::slot-0"];
    expect(rewritten).toBeTruthy();
    expect(rewritten.unitsDone).toEqual(["y=2025/s=pokemon"]);

    // THE ASSERTION THIS TEST EXISTS FOR: the cursor this pass wrote back is
    // COMPACT, not the ~2MB fat shape it loaded. Well under the 50KB target
    // (in practice a few hundred bytes for a 2-unit fixture) and nowhere
    // near either the 512KB guard or Cosmos's 2MB ceiling.
    const rewrittenBytes = Buffer.byteLength(JSON.stringify(rewritten), "utf8");
    expect(rewrittenBytes).toBeLessThan(50 * 1024);

    // The compact aggregate carries ONLY numeric resume state -- none of the
    // fat shape's per-row detail fields survive the rewrite.
    expect(rewritten.aggregate).toHaveProperty("counts");
    expect(rewritten.aggregate).toHaveProperty("stats");
    expect(rewritten.aggregate).toHaveProperty("splitTotal");
    expect(rewritten.aggregate).toHaveProperty("scopeCounts");
    expect(rewritten.aggregate).not.toHaveProperty("samples");
    expect(rewritten.aggregate).not.toHaveProperty("reasons");
    expect(rewritten.aggregate).not.toHaveProperty("byTier");
    expect(rewritten.aggregate).not.toHaveProperty("subclasses");
    expect(rewritten.aggregate).not.toHaveProperty("sampleCards");
    expect(rewritten.aggregate).not.toHaveProperty("slugShapeSamples");
  }, TEST_TIMEOUT_MS + 10_000);
});
