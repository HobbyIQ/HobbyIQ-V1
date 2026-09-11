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
