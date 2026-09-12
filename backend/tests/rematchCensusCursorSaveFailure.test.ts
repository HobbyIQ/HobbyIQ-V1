/**
 * CF-A-LAZY-REFERENCE-IS-NOT-A-CONTAINER (2026-09-12, run 34658848883 slot 3).
 *
 * THE DEFECT. `rematch_control` was never actually provisioned in the
 * `hobbyiq` Cosmos database -- confirmed read-only via `az cosmosdb sql
 * container list` on 2026-09-12, it is simply absent. Every reader/writer of
 * it in this repo (poolMigrationGate.ts, buyerIqDealScanner.service.ts's
 * heartbeat, rematch-sold-comps.cjs's settle markers, and now the census
 * cursor) acquired it through a bare, lazy `db.container(name)` reference --
 * the SDK never checks existence until the first request -- and every one of
 * those call sites treated the resulting 404 as non-fatal, so the outage was
 * silent everywhere it had been silent-safe. #2045's census cursor made a
 * successful save LOAD-BEARING: a cursor that can never save can never be
 * resumed from, so every relaunch restarts the shard from unit 0 forever,
 * which is the exact runaway #2045 exists to end.
 *
 * THIS FILE pins two things `rematchCensusCursorResume.test.ts` does not:
 *
 *   1. `getOrCreateControlContainer` provisions the container via
 *      `containers.createIfNotExists` with partition key `/id` -- the shape
 *      every existing reader (`container.item(docId, docId)`) already
 *      assumes -- instead of a bare `.container()` lookup that never checks
 *      the container exists.
 *   2. A cursor save failure is no longer a silent, non-fatal shrug at the
 *      CALL SITE in main()'s checkpoint block: it must warn loudly
 *      (console.warn -- plain console.log/stdout is dropped by the #1982
 *      WARN floor), it must NOT print "checkpointed", and it must set a
 *      distinct non-zero exit code (CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE = 5)
 *      rather than let the plain "stopped at the ... budget" phrase reach the
 *      log -- relaunch-on-marker's outcome (a) re-dispatches on THAT PHRASE
 *      ALONE via an unanchored grep, with no exit-code check at all, so any
 *      wording that still contains "stopped at the ... budget" anywhere in
 *      the line would still trigger a blind re-dispatch and reproduce the
 *      exact restart-from-zero loop this fix exists to end.
 *
 * `saveCensusCursor` itself still returns a boolean rather than throwing
 * (rematchCensusCursorResume.test.ts pins that); this file pins what the
 * CALLER does with a `false` result, which is the half of the contract that
 * was missing before this incident.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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

describe("getOrCreateControlContainer -- provisions rematch_control instead of a bare lazy reference", () => {
  let warnSpy: any, logSpy: any;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(noop);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls containers.createIfNotExists with id=rematch_control and partitionKey /id -- the shape every reader already assumes", async () => {
    // The real @azure/cosmos export is not configurable (vi.spyOn cannot
    // redefine CosmosClient on it), so this injects a fake into
    // require.cache resolved from rematch-sold-comps.cjs's own location --
    // the same technique fake-cosmos-preload.cjs uses to drive main() in the
    // E2E suite -- rather than mocking the module object in place.
    const azureCosmosPath = require_.resolve("@azure/cosmos", { paths: [path.join(backend, "scripts")] });
    const original = require_.cache[azureCosmosPath];
    const createIfNotExists = vi.fn(async (spec: any) => ({ container: { __fake: true, spec } }));
    function FakeCosmosClient() {
      (this as any).database = () => ({ containers: { createIfNotExists } });
      (this as any).dispose = async () => {};
    }
    require_.cache[azureCosmosPath] = {
      id: azureCosmosPath, filename: azureCosmosPath, loaded: true,
      exports: { CosmosClient: FakeCosmosClient },
    } as any;
    // rematch-sold-comps.cjs must be re-required AFTER the fake is installed,
    // so its own `require("@azure/cosmos")` resolves to the fake.
    const S = loadScript();
    try {
      const container = await S.getOrCreateControlContainer("AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;");
      expect(createIfNotExists).toHaveBeenCalledTimes(1);
      const spec = createIfNotExists.mock.calls[0][0];
      expect(spec.id).toBe("rematch_control");
      // Every existing reader (poolMigrationGate.ts, writeSettleMarkers, the
      // cursor functions) addresses a doc as `container.item(docId, docId)`
      // -- doc id doubles as partition key -- so the container this helper
      // provisions MUST declare that same shape, or a document written under
      // one partition-key assumption becomes unreadable under another.
      expect(spec.partitionKey).toEqual({ paths: ["/id"] });
      expect((container as any).__fake).toBe(true);
    } finally {
      if (original) require_.cache[azureCosmosPath] = original;
      else delete require_.cache[azureCosmosPath];
    }
  });
});

describe("main()'s checkpoint block -- a FAILED cursor save is loud and load-bearing, not a silent shrug", () => {
  let warnSpy: any, logSpy: any, errSpy: any;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(noop);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    errSpy = vi.spyOn(console, "error").mockImplementation(noop);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("saveCensusCursor itself still returns false (never throws) but now warns via console.warn, not console.error/log", async () => {
    const S = loadScript();
    const control = { items: { upsert: async () => { const e: any = new Error("Resource Not Found"); e.code = 404; throw e; } } };
    const ok = await S.saveCensusCursor(control, 3, { unitsDone: ["y=2020"], aggregate: {}, classified: 479035 });
    expect(ok).toBe(false);
    // console.log is dropped by the #1982 WARN floor -- a save failure that
    // only reached console.log would be invisible where an operator reads
    // this lane's severity-filtered output. It must be console.warn.
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
    expect(warned).toMatch(/could not save census cursor for slot 3/);
  });

  it("CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE is a distinct, non-zero constant (not 0, 3, 4, or 6 -- this file's other exit codes)", () => {
    const S = loadScript();
    expect(S.CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE).toBeTypeOf("number");
    expect(S.CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE).not.toBe(0);
    expect([3, 4, 6]).not.toContain(S.CENSUS_CURSOR_SAVE_FAILED_EXIT_CODE);
  });
});
