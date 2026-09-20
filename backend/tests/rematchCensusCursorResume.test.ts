/**
 * CF-A-CENSUS-SLOT-RESUMES-IT-DOES-NOT-RESTART (2026-09-11).
 *
 * THE DEFECT. Slot 0 of the GREAT REMATCH census (523,940 rows measured at
 * capture, ~231,480 classified per 140-minute pass) is one of 18 of 32 slots
 * that never finish inside one RUN_MINUTES budget. Every self-relaunch
 * re-read the WHOLE slot from its first unit, so the pass count reset every
 * ~2h10m forever -- measured 2026-09-08/09: ~26 runners held ~20 hours before
 * a human cancelled 28 runs, and no census slot that large ever converged.
 *
 * THE FIX. `censusCursorId`/`censusCursorSignature`/`loadCensusCursor`/
 * `saveCensusCursor`/`clearCensusCursor` in rematch-sold-comps.cjs persist a
 * per-slot checkpoint to the `rematch_control` container: which
 * (cardYear, sportClass, sha1(id) % parts) UNITS are already classified, plus
 * the merged counts they produced. A relaunch loads that cursor, skips done
 * units, and adds its own units' counts to the SAME totals.
 *
 * THIS FILE pins the cursor I/O functions directly against a stubbed
 * container (the same convention rematchRevertEviction.test.ts uses for
 * `revertEvictions`' `pool`). The `mergeCensusAggregate` behaviour inside the
 * paging loop itself -- which is not exported, since it closes over `main()`'s
 * local counters -- is instead proven by rematchCensusCursorE2E.test.ts,
 * which drives the real, unexported `main()` as two actual child-process
 * passes with a simulated budget stop.
 *
 * NO NEW WORKFLOW INPUT. backend/scripts/wave2/wave2-fleet.sh and
 * .github/workflows/backfill-runner.yml both dispatch/relaunch
 * rematch-sold-comps with the SAME seven inputs as before -- the cursor is
 * discovered by the script itself from Cosmos, keyed by slot, never passed on
 * the command line. wave2FleetGates.test.ts's "dispatches ONLY the seven
 * inputs" pin is the enforcement for that half of the contract; this file
 * covers the script's own half.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Doc = Record<string, any>;

/** A fake `rematch_control` container: item().read()/.delete() + items.upsert(),
 *  the same shape fakePool() in rematchRevertEviction.test.ts drives the real
 *  `pool` container with. */
function fakeControl(seed: Doc[] = []) {
  const store = new Map<string, Doc>();
  for (const d of seed) store.set(d.id, { ...d });
  const log: string[] = [];
  return {
    store, log,
    items: {
      upsert: async (doc: Doc) => {
        log.push(`upsert ${doc.id}`);
        store.set(doc.id, { ...doc });
        return { resource: { ...doc } };
      },
    },
    item: (id: string, _pk: string) => ({
      read: async () => {
        const d = store.get(id);
        if (!d) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
      delete: async () => {
        log.push(`delete ${id}`);
        if (!store.delete(id)) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return {};
      },
    }),
  };
}

/** Drive the COMMITTED cursor functions under a given env, the same
 *  module-cache-drop `loadScript` pattern rematchRevertEviction.test.ts uses,
 *  since censusCursorSignature() reads several module-level env-derived
 *  consts (SHARD_TABLE, APPLY_SCOPE_RAW, SPORTS_FILTER, SETKEY_LIKE, YEARS). */
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

describe("censusCursorId + censusCursorSignature -- pure", () => {
  it("the cursor id is slot-scoped, so two slots can never collide", () => {
    const S = loadScript();
    expect(S.censusCursorId(0)).toBe("census-cursor::slot-0");
    expect(S.censusCursorId(7)).toBe("census-cursor::slot-7");
    expect(S.censusCursorId(0)).not.toBe(S.censusCursorId(7));
  });

  it("signaturesMatch is a deep-equality check over the signature shape", () => {
    const S = loadScript();
    const a = { measuredAt: "2026-09-01", scope: "improve", sports: [], setkeyLike: "", years: [] };
    const b = { ...a };
    const c = { ...a, scope: "both" };
    expect(S.signaturesMatch(a, b)).toBe(true);
    expect(S.signaturesMatch(a, c)).toBe(false);
  });
});

describe("loadCensusCursor / saveCensusCursor / clearCensusCursor -- the WRITE, on the committed functions", () => {
  let logSpy: any;
  beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(noop); vi.spyOn(console, "error").mockImplementation(noop); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a first-ever slot has no cursor -- loadCensusCursor returns null, not a throw", async () => {
    const S = loadScript();
    const control = fakeControl();
    const cursor = await S.loadCensusCursor(control, 0);
    expect(cursor).toBeNull();
  });

  it("saveCensusCursor persists unitsDone + the merged aggregate + classified, keyed by slot", async () => {
    const S = loadScript();
    const control = fakeControl();
    const aggregate = { counts: { AGREE: 10, IMPROVE: 2, CONFLICT: 0, UNDERIVABLE: 1 } };
    const ok = await S.saveCensusCursor(control, 5, { unitsDone: ["y=2025/s=pokemon"], aggregate, classified: 13 });
    expect(ok).toBe(true);
    const saved = control.store.get("census-cursor::slot-5");
    expect(saved.kind).toBe(S.CENSUS_CURSOR_KIND);
    expect(saved.slot).toBe(5);
    expect(saved.unitsDone).toEqual(["y=2025/s=pokemon"]);
    expect(saved.classified).toBe(13);
    expect(saved.aggregate).toEqual(aggregate);
    expect(typeof saved.signature).toBe("object");
    expect(typeof saved.updatedAt).toBe("string");
  });

  it("a saved cursor round-trips through loadCensusCursor when the signature matches", async () => {
    const S = loadScript();
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, { unitsDone: ["a", "b"], aggregate: { counts: {} }, classified: 100 });
    const loaded = await S.loadCensusCursor(control, 0);
    expect(loaded).not.toBeNull();
    expect(loaded.unitsDone).toEqual(["a", "b"]);
    expect(loaded.classified).toBe(100);
  });

  // THE PAGE CHECKPOINT (2026-09-12, #2058 follow-up): `unitsDone` alone
  // checkpoints only whole units, and several measured units (slot 0's
  // 484,940-row first unit among them) exceed a single 120-minute link's
  // throughput at sold_comps' fixed 10,000 RU autoscale -- so every relaunch
  // re-paged that same unit from row zero forever. `partialUnit` is the
  // finer grain: the in-flight unit's own Cosmos continuation token, saved
  // and round-tripped exactly like `unitsDone` and `aggregate` already are.
  it("saveCensusCursor persists a partialUnit (in-flight unit + continuation token) alongside unitsDone", async () => {
    const S = loadScript();
    const control = fakeControl();
    const partialUnit = { key: "y=2025/s=pokemon", continuationToken: "opaque-token-abc123" };
    const ok = await S.saveCensusCursor(control, 0, {
      unitsDone: ["y=1953"], aggregate: { counts: {} }, classified: 40000, partialUnit,
    });
    expect(ok).toBe(true);
    const saved = control.store.get("census-cursor::slot-0");
    expect(saved.partialUnit).toEqual(partialUnit);
  });

  it("saveCensusCursor with no partialUnit persists null, not undefined or an absent field", async () => {
    const S = loadScript();
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, { unitsDone: ["a"], aggregate: {}, classified: 1 });
    const saved = control.store.get("census-cursor::slot-0");
    expect(saved.partialUnit).toBeNull();
  });

  it("a saved partialUnit round-trips through loadCensusCursor", async () => {
    const S = loadScript();
    const control = fakeControl();
    const partialUnit = { key: "y=2025/s=pokemon", continuationToken: "tok-1" };
    await S.saveCensusCursor(control, 0, { unitsDone: [], aggregate: {}, classified: 20000, partialUnit });
    const loaded = await S.loadCensusCursor(control, 0);
    expect(loaded.partialUnit).toEqual(partialUnit);
  });

  it("a later save with partialUnit:null overwrites a previously saved in-flight token (the unit finished)", async () => {
    const S = loadScript();
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, {
      unitsDone: [], aggregate: {}, classified: 20000,
      partialUnit: { key: "y=2025/s=pokemon", continuationToken: "tok-1" },
    });
    // The unit that was in flight just finished: the next save marks it done
    // and must not leave the stale token behind for a resume to misread as
    // "still in progress".
    await S.saveCensusCursor(control, 0, { unitsDone: ["y=2025/s=pokemon"], aggregate: {}, classified: 484940, partialUnit: null });
    const loaded = await S.loadCensusCursor(control, 0);
    expect(loaded.unitsDone).toEqual(["y=2025/s=pokemon"]);
    expect(loaded.partialUnit).toBeNull();
  });

  it("a cursor written under a DIFFERENT signature is invalidated -- dropped, not repaired", async () => {
    const S = loadScript();
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, { unitsDone: ["a"], aggregate: {}, classified: 1 });
    // Tamper with the stored signature directly, as if the shard table (or
    // scope) had changed between the pass that wrote it and this one.
    const doc = control.store.get("census-cursor::slot-0");
    doc.signature = { ...doc.signature, scope: "a-different-scope-entirely" };
    const loaded = await S.loadCensusCursor(control, 0);
    expect(loaded).toBeNull();
  });

  it("clearCensusCursor removes the doc; a cleared slot starts cold again", async () => {
    const S = loadScript();
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, { unitsDone: ["a"], aggregate: {}, classified: 1 });
    expect(await S.loadCensusCursor(control, 0)).not.toBeNull();
    await S.clearCensusCursor(control, 0);
    expect(await S.loadCensusCursor(control, 0)).toBeNull();
  });

  it("clearCensusCursor on an ALREADY-clear slot does not throw (idempotent)", async () => {
    const S = loadScript();
    const control = fakeControl();
    await expect(S.clearCensusCursor(control, 9)).resolves.toBeUndefined();
  });

  it("a control read failure is non-fatal -- loadCensusCursor falls back to null, never throws", async () => {
    const S = loadScript();
    const control = { item: () => ({ read: async () => { throw new Error("throttled"); } }) };
    const cursor = await S.loadCensusCursor(control as any, 0);
    expect(cursor).toBeNull();
  });

  it("a control write failure is non-fatal -- saveCensusCursor returns false, never throws", async () => {
    const S = loadScript();
    const control = { items: { upsert: async () => { throw new Error("throttled"); } } };
    const ok = await S.saveCensusCursor(control as any, 0, { unitsDone: [], aggregate: {}, classified: 0 });
    expect(ok).toBe(false);
  });
});

/**
 * CF-AN-APPLY-WRITES-AS-IT-CLASSIFIES-AND-RESUMES (2026-09-14).
 *
 * THE DEFECT. MODE=apply-improve classified its WHOLE shard before writing a
 * single row, and no slot fits in one 120-minute link: run 34872320344 (slot
 * 31) reached 120,232 rows in 118.9m and run 34849159531 (slot 0) 117,917 in
 * 120m, both reconciling `intended 2,717 = written 0 + not reached 2,717`
 * with an EMPTY write ledger. With no apply cursor either, every relaunch
 * restarted at row 0, so the lane could never write anything at all.
 *
 * THE FIX has three halves and this block pins the one that is unit-testable
 * in isolation -- the cursor is now KEYED BY MODE, so an apply's checkpoint
 * and a census's can never be read for one another. (The write-as-you-go
 * drain and the resume itself close over main()'s locals and are proven end
 * to end in rematchApplyCursorE2E.test.ts.)
 */
describe("the resume cursor is keyed by MODE -- an apply and a census never collide", () => {
  it("MODE=apply-improve addresses a DIFFERENT document than MODE=census, for the same slot", () => {
    const census = loadScript({ MODE: "census" });
    const apply = loadScript({ MODE: "apply-improve" });
    expect(census.censusCursorId(31)).toBe("census-cursor::slot-31");
    expect(apply.censusCursorId(31)).toBe("apply-cursor::apply-improve::slot-31");
    expect(apply.censusCursorId(31)).not.toBe(census.censusCursorId(31));
  });

  it("the census id is UNCHANGED, so cursors already in rematch_control stay readable", () => {
    // The 32-slot census of 18.35M rows was mid-flight when this shipped.
    // Any change to this string restarts every one of those slots at unit 0.
    const S = loadScript({ MODE: "census" });
    expect(S.censusCursorId(0)).toBe("census-cursor::slot-0");
    expect(S.censusCursorId(7)).toBe("census-cursor::slot-7");
  });

  it("an IMPORTER that sets no MODE still gets the census id -- the safe default", () => {
    // Every other test in this file calls loadScript() with no MODE. Keying
    // the default off the empty string would have addressed
    // `apply-cursor::::slot-N`, a document nothing reads or writes.
    const S = loadScript();
    expect(S.censusCursorId(3)).toBe("census-cursor::slot-3");
  });

  it("the MODE travels in the SIGNATURE too, so a cross-mode read is refused even at the same id", async () => {
    const applyS = loadScript({ MODE: "apply-improve" });
    const control = fakeControl();
    await applyS.saveCensusCursor(control, 0, { unitsDone: [], aggregate: {}, classified: 10 });
    // The apply's own pass reads its own cursor back: same mode, same id.
    expect(await applyS.loadCensusCursor(control, 0)).not.toBeNull();
    // A census pointed at that exact document (as if the ids had collided)
    // must refuse it rather than resume a walk it did not make.
    const censusS = loadScript({ MODE: "census" });
    const applyDoc = control.store.get("apply-cursor::apply-improve::slot-0");
    expect(applyDoc).toBeDefined();
    control.store.set("census-cursor::slot-0", { ...applyDoc, id: "census-cursor::slot-0" });
    expect(await censusS.loadCensusCursor(control, 0)).toBeNull();
  });

  it("a census cursor written BEFORE the mode field existed still loads for a census (no migration)", async () => {
    const S = loadScript({ MODE: "census" });
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, { unitsDone: ["a"], aggregate: {}, classified: 1 });
    const doc = control.store.get("census-cursor::slot-0");
    expect(JSON.parse(JSON.stringify(doc.signature))).not.toHaveProperty("mode");
    // The load is the behaviour that actually matters: an untouched
    // pre-existing cursor still resumes its census.
    expect(await S.loadCensusCursor(control, 0)).not.toBeNull();
    // ...and a cursor stored with NO mode key at all (a genuinely old
    // document, not one this build wrote) loads too.
    const legacy = JSON.parse(JSON.stringify(doc));
    delete legacy.signature.mode;
    control.store.set("census-cursor::slot-0", legacy);
    expect(await S.loadCensusCursor(control, 0)).not.toBeNull();
  });

  it("an apply signature DOES carry the mode", () => {
    const S = loadScript({ MODE: "apply-improve" });
    expect(S.censusCursorSignature().mode).toBe("apply-improve");
  });
});

/**
 * CF-A-BACKING-CENSUS-AND-A-PLAIN-CENSUS-SHARE-ONE-CURSOR-ID (2026-09-20).
 *
 * THE DEFECT (second half of the census self-relaunch backing-loss report).
 * `censusCursorId` is keyed by MODE alone, never by SOURCES -- so a plain
 * census (MODE=census, no SOURCES) and a SOURCES=backing census of the SAME
 * slot address the EXACT SAME cursor document. Before this fix, either could
 * resume the other's checkpoint: a backing pass reading a plain census's
 * cursor would merge in a `stats`/`counts` total with NO backing tallies
 * behind it (the plain pass's `backing` block was never armed, so its
 * compact cursor JSON never carried one), and a plain census reading a
 * backing pass's cursor would resume fine but re-pay none of the backing
 * preload cost the prior pass already spent.
 *
 * THE FIX. `censusCursorSignature()` now also carries `sourcesMode: "backing"`
 * when `CENSUS_BACKING` is armed, `undefined` otherwise -- the same
 * "undefined matches only the mode every pre-existing cursor was written
 * under" trick `mode` already uses, so a cursor written before this field
 * existed (always a plain census, since SOURCES=backing shipped later) still
 * resumes under a plain census, and NEVER under a backing one.
 */
describe("the resume cursor's signature also carries the SOURCES mode -- backing and plain census never share a checkpoint", () => {
  it("a plain census (no SOURCES) signature carries sourcesMode: undefined", () => {
    const S = loadScript({ MODE: "census" });
    expect(S.censusCursorSignature().sourcesMode).toBeUndefined();
  });

  it("MODE=census SOURCES=backing carries sourcesMode: 'backing'", () => {
    const S = loadScript({ MODE: "census", SOURCES: "backing" });
    expect(S.censusCursorSignature().sourcesMode).toBe("backing");
  });

  it("a wrong SOURCES value (not literally 'backing') is the SAME signature as a plain census", () => {
    const plain = loadScript({ MODE: "census" });
    const wrong = loadScript({ MODE: "census", SOURCES: "some-other-thing" });
    expect(wrong.censusCursorSignature().sourcesMode).toBeUndefined();
    expect(plain.signaturesMatch(plain.censusCursorSignature(), wrong.censusCursorSignature())).toBe(true);
  });

  it("a backing pass refuses (starts fresh) a cursor written by a plain census of the SAME slot", async () => {
    const plainS = loadScript({ MODE: "census" });
    const control = fakeControl();
    await plainS.saveCensusCursor(control, 7, { unitsDone: ["a"], aggregate: { counts: {} }, classified: 500 });
    // Same id -- the defect this test pins is that the id alone is not
    // enough to keep the two modes apart.
    expect(plainS.censusCursorId(7)).toBe("census-cursor::slot-7");
    const backingS = loadScript({ MODE: "census", SOURCES: "backing" });
    expect(backingS.censusCursorId(7)).toBe("census-cursor::slot-7");
    // The backing pass reads the SAME document (proving the id collision is
    // real) but the signature check inside loadCensusCursor refuses it.
    expect(await backingS.loadCensusCursor(control, 7)).toBeNull();
  });

  it("a plain census refuses (starts fresh) a cursor written by a SOURCES=backing pass of the SAME slot", async () => {
    const backingS = loadScript({ MODE: "census", SOURCES: "backing" });
    const control = fakeControl();
    await backingS.saveCensusCursor(control, 3, { unitsDone: ["a"], aggregate: { counts: {}, backingBySport: { baseball: { backedStrict: 1, rowExistsNonStrict: 0, noRow: 0, unparseable: 0, parked: 0, notPricedFlagged: 0, unknown: 0 } } }, classified: 1 });
    const plainS = loadScript({ MODE: "census" });
    expect(await plainS.loadCensusCursor(control, 3)).toBeNull();
  });

  it("a backing pass DOES resume its own prior backing checkpoint -- the signature matches itself", async () => {
    const backingS = loadScript({ MODE: "census", SOURCES: "backing" });
    const control = fakeControl();
    await backingS.saveCensusCursor(control, 9, { unitsDone: ["a"], aggregate: { counts: {} }, classified: 1 });
    const backingS2 = loadScript({ MODE: "census", SOURCES: "backing" });
    expect(await backingS2.loadCensusCursor(control, 9)).not.toBeNull();
  });

  it("a legacy cursor with no sourcesMode key at all still resumes a plain census (no migration)", async () => {
    const S = loadScript({ MODE: "census" });
    const control = fakeControl();
    await S.saveCensusCursor(control, 0, { unitsDone: ["a"], aggregate: {}, classified: 1 });
    const doc = control.store.get("census-cursor::slot-0");
    // Round-tripped through JSON first, the same way the `mode` field's own
    // test above does: `fakeControl`'s upsert spreads the doc rather than
    // serializing it, so an `undefined`-valued key survives as a KEY here
    // even though a real Cosmos write (and JSON.stringify) would drop it --
    // matching what a genuinely pre-existing cursor document looks like.
    expect(JSON.parse(JSON.stringify(doc.signature))).not.toHaveProperty("sourcesMode");
    expect(await S.loadCensusCursor(control, 0)).not.toBeNull();
    // ...and a cursor stored with NO sourcesMode key at all (a genuinely old
    // document) loads too.
    const legacy = JSON.parse(JSON.stringify(doc));
    delete legacy.signature.sourcesMode;
    control.store.set("census-cursor::slot-0", legacy);
    expect(await S.loadCensusCursor(control, 0)).not.toBeNull();
  });
});

/**
 * THE COMPACT BUCKET CODEC + FOLD-TO-FIT (2026-09-20, cursor-size follow-up,
 * reviewer finding on #2360). A named `{backedStrict, rowExistsNonStrict,
 * ...}` object at BACKING_CELL_CAP (2,000) cells measured ~387 KB for
 * `backingByCell` alone -- close enough to CENSUS_CURSOR_MAX_BYTES (512 KB)
 * that the five slots most likely to NEED a resume (9/10/12/13/14, the
 * largest 2024-25 units, hence the most distinct cells) were also the most
 * likely to hit the FATAL size guard on their very first backing checkpoint
 * and lose the slot again. Two independent fixes, both pinned here on the
 * SHIPPED functions:
 *   1. `backingBucketsToArray`/`backingBucketsFromArray` -- a fixed-order
 *      `[n0..n6]` array instead of seven named keys, roughly HALVING the
 *      bytes (measured: ~199 KB for the same 2,000-cell worst case).
 *   2. `foldBackingByCellToFit` -- if the doc STILL does not fit (a
 *      genuinely huge slot), folds the smallest cells into "other" until it
 *      does, preserving every bucket's TOTAL exactly. NEVER a FATAL for
 *      backing data specifically.
 */
describe("backingBucketsToArray / backingBucketsFromArray -- the compact codec", () => {
  it("round-trips a named object through the array shape losslessly", () => {
    const S = loadScript();
    const named = { backedStrict: 1, rowExistsNonStrict: 2, noRow: 3, unparseable: 4, parked: 5, notPricedFlagged: 6, unknown: 7 };
    const arr = S.backingBucketsToArray(named);
    expect(arr).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(S.backingBucketsFromArray(arr)).toEqual(named);
  });

  it("backingBucketsFromArray also accepts an already-named object (defensive: a fat pre-fix cursor or a hand-built fixture)", () => {
    const S = loadScript();
    const named = { backedStrict: 9, rowExistsNonStrict: 0, noRow: 0, unparseable: 0, parked: 0, notPricedFlagged: 0, unknown: 0 };
    expect(S.backingBucketsFromArray(named)).toEqual(named);
  });

  it("backingBucketsFromArray on garbage input returns all-zero buckets rather than throwing", () => {
    const S = loadScript();
    const zero = { backedStrict: 0, rowExistsNonStrict: 0, noRow: 0, unparseable: 0, parked: 0, notPricedFlagged: 0, unknown: 0 };
    expect(S.backingBucketsFromArray(null)).toEqual(zero);
    expect(S.backingBucketsFromArray(undefined)).toEqual(zero);
    expect(S.backingBucketsFromArray("not an object")).toEqual(zero);
  });

  it("the compact array measurably shrinks a many-cell backingByCell versus the named-object shape", () => {
    const S = loadScript();
    const named: Record<string, unknown> = {};
    const compact: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) {
      const bucket = { backedStrict: 123456, rowExistsNonStrict: 123456, noRow: 123456, unparseable: 123456, parked: 123456, notPricedFlagged: 123456, unknown: 123456 };
      const key = `baseball|2024|some-really-long-set-key-name-${i}`;
      named[key] = bucket;
      compact[key] = S.backingBucketsToArray(bucket);
    }
    const namedBytes = Buffer.byteLength(JSON.stringify(named), "utf8");
    const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
    // Measured ~387 KB named vs ~199 KB compact for this exact shape -- the
    // pin is "meaningfully smaller" (at least a third smaller), not the
    // literal byte count, so it survives an unrelated field/key-length
    // change elsewhere without becoming a brittle exact-byte assertion.
    expect(compactBytes).toBeLessThan(namedBytes * 0.6);
  });
});

describe("foldBackingByCellToFit -- degrade instead of dying when backingByCell alone would blow the cursor's byte cap", () => {
  function bucket(n: number) { return [n, n, n, n, n, n, n]; }
  function sumAllBuckets(byCell: Record<string, number[]>) {
    const t = [0, 0, 0, 0, 0, 0, 0];
    for (const arr of Object.values(byCell)) for (let i = 0; i < 7; i++) t[i] += arr[i];
    return t;
  }

  it("a doc already under the byte cap is returned unchanged, folded: 0", () => {
    const S = loadScript();
    const doc = { id: "x", aggregate: { backingByCell: { a: bucket(1) } } };
    const { doc: out, folded } = S.foldBackingByCellToFit(doc, 100_000);
    expect(folded).toBe(0);
    expect(out).toBe(doc); // same reference -- no copy made when nothing changes
  });

  it("folds the SMALLEST cells first, preserves every bucket's TOTAL exactly, and fits under the cap", () => {
    const S = loadScript();
    const byCell: Record<string, number[]> = {};
    for (let i = 0; i < 50; i++) byCell[`cell-${i}`] = bucket(i + 1);
    const doc = { id: "x", aggregate: { backingByCell: byCell } };
    const before = sumAllBuckets(byCell);

    const { doc: out, folded } = S.foldBackingByCellToFit(doc, 400);
    expect(folded).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(400);
    expect(sumAllBuckets(out.aggregate.backingByCell)).toEqual(before);
    // The smallest cell (cell-0, total 7) must be among the folded ones --
    // it is gone from the kept map and its counts moved into "other".
    expect(out.aggregate.backingByCell["cell-0"]).toBeUndefined();
    expect(out.aggregate.backingByCell.other).toBeTruthy();
  });

  it("a PRE-EXISTING 'other' cell absorbs newly-folded cells rather than being overwritten", () => {
    const S = loadScript();
    const byCell: Record<string, number[]> = { other: bucket(999) };
    for (let i = 0; i < 50; i++) byCell[`cell-${i}`] = bucket(i + 1);
    const doc = { id: "x", aggregate: { backingByCell: byCell } };
    const before = sumAllBuckets(byCell);

    const { doc: out, folded } = S.foldBackingByCellToFit(doc, 400);
    expect(folded).toBeGreaterThan(0);
    expect(sumAllBuckets(out.aggregate.backingByCell)).toEqual(before);
    expect(out.aggregate.backingByCell.other[0]).toBeGreaterThanOrEqual(999);
  });

  it("A REAL 6,000-CELL WORST CASE checkpoints under CENSUS_CURSOR_MAX_BYTES with exact totals, fast", () => {
    const S = loadScript();
    const byCell: Record<string, number[]> = {};
    for (let i = 0; i < 6000; i++) byCell[`baseball|2024|some-really-long-set-key-name-${i}`] = bucket(123456);
    const doc = {
      id: "census-cursor::slot-12", kind: S.CENSUS_CURSOR_KIND, slot: 12, slots: 32,
      signature: { sourcesMode: "backing", measuredAt: "2026-09-01", scope: "", sports: [], setkeyLike: "", years: [2024, 2025] },
      unitsDone: ["a", "b"], classified: 1234567,
      aggregate: { counts: {}, stats: {}, backingBySport: { baseball: bucket(123456) }, backingByCell: byCell },
      partialUnit: { key: "x", continuationToken: "tok" },
      updatedAt: new Date().toISOString(),
    };
    const before = sumAllBuckets(byCell);
    const beforeBytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
    expect(beforeBytes).toBeGreaterThan(S.CENSUS_CURSOR_MAX_BYTES); // proves this fixture actually exercises the fold path

    const t0 = Date.now();
    const { doc: out, folded } = S.foldBackingByCellToFit(doc, S.CENSUS_CURSOR_MAX_BYTES);
    const elapsedMs = Date.now() - t0;

    expect(folded).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(S.CENSUS_CURSOR_MAX_BYTES);
    expect(sumAllBuckets(out.aggregate.backingByCell)).toEqual(before);
    // FAST: the incremental byte-budget arithmetic (see the function's own
    // header) means this never re-stringifies the WHOLE doc per fold --
    // the naive re-measure-every-iteration approach measured over 11
    // SECONDS for this exact fixture; this is a loose ceiling far short of
    // that, generous enough not to flake on a slow CI runner.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("saveCensusCursor folds automatically (via the SHIPPED function, not a re-implementation) and never FATALs for backing data", async () => {
    const S = loadScript({ MODE: "census", SOURCES: "backing" });
    const control = fakeControl();
    const byCell: Record<string, number[]> = {};
    for (let i = 0; i < 6000; i++) byCell[`baseball|2024|some-really-long-set-key-name-${i}`] = [123456, 123456, 123456, 123456, 123456, 123456, 123456];
    const ok = await S.saveCensusCursor(control, 12, {
      unitsDone: ["a"], classified: 1234567,
      aggregate: { counts: {}, stats: {}, backingBySport: { baseball: [123456, 123456, 123456, 123456, 123456, 123456, 123456] }, backingByCell: byCell },
    });
    expect(ok).toBe(true); // never false/FATAL for backing data specifically
    const saved = control.store.get("census-cursor::slot-12");
    expect(Buffer.byteLength(JSON.stringify(saved), "utf8")).toBeLessThanOrEqual(S.CENSUS_CURSOR_MAX_BYTES);
    expect(saved.aggregate.backingByCell.other).toBeTruthy();
  });

  it("the ARTIFACT'S FOLD MARKER (backingByCellFoldedForCheckpoint) reads off the SAME counter saveCensusCursor bumps -- the field census-slot-N.json's `backing` block carries, per module (2026-09-20)", async () => {
    // main() itself is not exported/callable in isolation from a unit test
    // (it only runs under require.main === module -- see
    // censusBackingE2E.test.ts for the real end-to-end drive of it). What
    // IS unit-testable, and is the actual wiring this marker depends on: the
    // counter saveCensusCursor bumps on a real fold is the SAME one
    // getCensusCursorBackingCellsFoldedTotal() reads, and main()'s artifact
    // build assigns exactly that getter's return value to
    // `backing.backingByCellFoldedForCheckpoint` (see the artifact literal
    // in main()). A FRESH module load starts the counter at 0 -- proven
    // first, so the non-zero value after a fold is not a leftover from an
    // earlier test in the same process.
    const S = loadScript({ MODE: "census", SOURCES: "backing" });
    expect(S.getCensusCursorBackingCellsFoldedTotal()).toBe(0);

    const control = fakeControl();
    const byCell: Record<string, number[]> = {};
    for (let i = 0; i < 6000; i++) byCell[`baseball|2024|some-really-long-set-key-name-${i}`] = [123456, 123456, 123456, 123456, 123456, 123456, 123456];
    await S.saveCensusCursor(control, 12, {
      unitsDone: ["a"], classified: 1234567,
      aggregate: { counts: {}, stats: {}, backingBySport: {}, backingByCell: byCell },
    });
    expect(S.getCensusCursorBackingCellsFoldedTotal()).toBeGreaterThan(0);

    // CUMULATIVE across multiple checkpoint saves in the same pass (see the
    // counter's own header) -- a second save that ALSO folds adds to the
    // running total rather than replacing it.
    const afterFirstSave = S.getCensusCursorBackingCellsFoldedTotal();
    const byCell2: Record<string, number[]> = {};
    for (let i = 0; i < 6000; i++) byCell2[`baseball|2025|another-really-long-set-key-name-${i}`] = [123456, 123456, 123456, 123456, 123456, 123456, 123456];
    await S.saveCensusCursor(control, 12, {
      unitsDone: ["a", "b"], classified: 2000000,
      aggregate: { counts: {}, stats: {}, backingBySport: {}, backingByCell: byCell2 },
    });
    expect(S.getCensusCursorBackingCellsFoldedTotal()).toBeGreaterThan(afterFirstSave);
  });
});

describe("describeSignatureMismatch -- names WHICH field(s) differ, for the cursor refusal log line", () => {
  it("names a single differing field with both sides' values", () => {
    const S = loadScript();
    const msg = S.describeSignatureMismatch({ scope: "improve", years: [2024] }, { scope: "both", years: [2024] });
    expect(msg).toContain("scope: saved=\"improve\" vs this pass=\"both\"");
    expect(msg).not.toContain("years:");
  });

  it("bounds the printed diffs at 6, naming how many more were left out", () => {
    const S = loadScript();
    const saved = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
    const current = { a: 10, b: 20, c: 30, d: 40, e: 50, f: 60, g: 70, h: 80 };
    const msg = S.describeSignatureMismatch(saved, current);
    for (const k of ["a", "b", "c", "d", "e", "f"]) expect(msg).toContain(`${k}:`);
    expect(msg).toContain("and 2 more"); // 8 total diffs, 6 printed, 2 left out
  });

  it("identical signatures produce no diffs (the caller only calls this when signaturesMatch already failed)", () => {
    const S = loadScript();
    const sig = { scope: "improve", years: [2024] };
    const msg = S.describeSignatureMismatch(sig, JSON.parse(JSON.stringify(sig)));
    expect(msg).toMatch(/no field-level difference/);
  });

  it("a real sourcesMode mismatch is named by loadCensusCursor's own warning", async () => {
    const S = loadScript({ MODE: "census" });
    const control = fakeControl();
    await S.saveCensusCursor(control, 4, { unitsDone: ["a"], aggregate: {}, classified: 1 });
    const backingS = loadScript({ MODE: "census", SOURCES: "backing" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    try {
      expect(await backingS.loadCensusCursor(control, 4)).toBeNull();
      const logged = warnSpy.mock.calls.map((args) => String(args[0])).join("\n");
      expect(logged).toMatch(/signature mismatch for slot 4/);
      expect(logged).toContain("sourcesMode:");
    } finally { warnSpy.mockRestore(); }
  });
});

// THE ACTUAL CHECKPOINT/RESTORE OF THE BACKING TALLIES (`censusAggregateToCompactJSON`
// / `mergeCensusAggregate`'s backing branch) closes over main()'s locals and is
// not exported -- it is proven end to end, driving the real `main()` across a
// simulated budget stop and resume, in censusBackingE2E.test.ts
// ("SOURCES=backing survives a budget-stop resume").
