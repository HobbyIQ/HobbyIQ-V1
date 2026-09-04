/**
 * THE WAY BACK -- MODE=apply-improve SCOPE=revert-eviction.
 *
 * The base-eviction wave wrote 1,456 rows before it was halted, and 12 of them
 * are DAMAGED: G6 now says the title states the stored slug's own parallel, so
 * the eviction should never have run and a genuine parallel sale is sitting on
 * a base pool. This pins the undo.
 *
 * REVERT IS A SCOPE, NOT A LANE. The undo lives inside the same script, behind
 * the same MODE, the same `scope` dispatch input, the same BACKFILL_APPLY and
 * the same reconciliation -- no new workflow input (GitHub caps
 * workflow_dispatch at 25 and 24 are used), no one-off repair script. It
 * consults G6 through the SAME classifier function the eviction path consults,
 * so the two can never disagree about which rows are damaged.
 *
 * Two levels, both against the COMMITTED script:
 *
 *   `revertVerdict`     pure over one document -- the SELECTION rule, driven
 *                       with plain objects and no Cosmos at all
 *   `revertEvictions`   the WRITE, driven against the stubbed container the
 *                       other apply tests use, so what is pinned is what ships
 *                       rather than a test's re-implementation of it
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;

type Doc = Record<string, any>;

/** The $250 Josh Allen Mercury row, as the wave left it. */
const ORIGIN = "hiq:football:2025:topps:ppm-ja:mercury:no-auto";
const BASE = "hiq:football:2025:topps-cosmic-chrome:ppm-ja:base:no-auto";
const TITLE = "2025 Topps Cosmic Chrome Josh Allen Planetary Pursuit Mercury #PPM-JA Bills";

/** A row the wave evicted: it now sits on the BASE slug and carries both
 *  markers the eviction branch writes. */
const evictedRow = (over: Doc = {}): Doc => ({
  id: "sc-ppm-ja", cardId: BASE, hobbyiqCardId: BASE, source: "cardhedge",
  title: TITLE, sport: "football", cardYear: 2025, setName: "Topps Cosmic Chrome",
  cardNumber: "PPM-JA", parallel: "Base", isAuto: false, printRun: null,
  price: 250, soldAt: "2026-08-28T00:00:00.000Z",
  contentHash: "hash-of-the-base-partition",
  rekeyedFrom: [{ id: "sc-ppm-ja", cardId: ORIGIN, hobbyiqCardId: ORIGIN, title: TITLE }],
  rekeyedAt: "2026-09-03T04:00:00.000Z",
  rekeyedReason: "GREAT REMATCH (2026-09-02): CONFLICT/BASE-EVICTION -- ...",
  baseEvictionEvidence: {
    storedSlugParallel: "mercury", titleQuoted: TITLE, storedParallelField: "Base",
    storedPrintRunField: null, baseDestSlug: BASE, baseDestChecklistBacked: true,
  },
  _rid: "x", _etag: "y", _ts: 1,
  ...over,
});

/** A CORRECT eviction: the title states no parallel, so G6 agrees with it and
 *  the row must stay exactly where the wave put it. */
const correctlyEvictedRow = (over: Doc = {}): Doc => evictedRow({
  id: "sc-terse", title: "2025 Topps Cosmic Chrome Josh Allen #PPM-JA Bills",
  baseEvictionEvidence: {
    storedSlugParallel: "mercury", titleQuoted: "2025 Topps Cosmic Chrome Josh Allen #PPM-JA Bills",
    storedParallelField: "Base", storedPrintRunField: null,
    baseDestSlug: BASE, baseDestChecklistBacked: true,
  },
  ...over,
});

describe("revertVerdict -- the SELECTION rule, pure over one document", () => {
  let S: any;
  beforeEach(() => { S = require_(path.join(backend, "scripts", "rematch-sold-comps.cjs")); });

  it("the damaged row reverts, to the slug the marker recorded", () => {
    const v = S.revertVerdict(evictedRow());
    expect(v.revert).toBe(true);
    expect(v.reason).toBe("G6-refuses-the-eviction");
    expect(v.origin).toBe(ORIGIN);
    expect(v.g6).toEqual({ phrase: "mercury", from: "slug" });
  });

  it("a CORRECT eviction is left exactly where the wave put it", () => {
    const v = S.revertVerdict(correctlyEvictedRow());
    expect(v.revert).toBe(false);
    expect(v.reason).toBe("G6-agrees-with-the-eviction");
  });

  it("a row this script never evicted is untouchable, whatever its shape", () => {
    // The marker is the ONLY selector. Without it the revert cannot reach a
    // row, so it can never move something a different writer keyed.
    const noMarker = evictedRow();
    delete noMarker.baseEvictionEvidence;
    expect(S.revertVerdict(noMarker)).toMatchObject({ revert: false, reason: "no-eviction-marker" });
    expect(S.revertVerdict(null)).toMatchObject({ revert: false, reason: "no-eviction-marker" });
    expect(S.revertVerdict({})).toMatchObject({ revert: false, reason: "no-eviction-marker" });
  });

  it("PROTECTED is protected in BOTH directions -- putting a row back is still a write", () => {
    for (const over of [
      { source: "ebay-user-purchase" },
      { source: "manual-user-entry" },
      { verifiedByUser: true },
    ]) {
      const v = S.revertVerdict(evictedRow(over));
      expect(v.revert, JSON.stringify(over)).toBe(false);
      expect(v.reason).toBe("protected-since-the-eviction");
    }
  });

  it("a malformed marker is SKIPPED and named, never repaired by inference", () => {
    // No origin recorded, so there is no destination -- and the revert never
    // derives one. It reports and moves on.
    expect(S.revertVerdict(evictedRow({ rekeyedFrom: [] })))
      .toMatchObject({ revert: false, reason: "marker-carries-no-origin-slug" });
    expect(S.revertVerdict(evictedRow({ rekeyedFrom: undefined })))
      .toMatchObject({ revert: false, reason: "marker-carries-no-origin-slug" });
    expect(S.revertVerdict(evictedRow({ rekeyedFrom: [{ id: "x" }] })))
      .toMatchObject({ revert: false, reason: "marker-carries-no-origin-slug" });
  });

  it("a row already back at its origin is a no-op, not a second move", () => {
    expect(S.revertVerdict(evictedRow({ cardId: ORIGIN })))
      .toMatchObject({ revert: false, reason: "already-at-the-origin-slug" });
  });

  it("G6 is asked about the ORIGIN slug, not the row's current one", () => {
    // The current slug is the BASE slug the eviction produced; asking whether
    // the title states THAT parallel would always be no, and the revert would
    // never fire. The question is whether the title states the parallel the
    // eviction took away.
    expect(K.storedParallelStatedInTitle({
      title: TITLE, storedSlug: BASE, stored: { parallel: "Base" }, setKey: "topps-cosmic-chrome",
    })).toBeNull();
    expect(S.revertVerdict(evictedRow()).revert).toBe(true);
  });
});

/** A minimal Cosmos container: a map keyed (id, partition), a query that
 *  serves a fixed seed, and an ORDER LOG so a test can prove the sale arrived
 *  before the old row was deleted. Same house pattern as the apply tests. */
function fakePool(seed: Doc[] = []) {
  const store = new Map<string, Doc>();
  const log: string[] = [];
  const key = (id: string, pk: string) => `${pk}::${id}`;
  for (const d of seed) store.set(key(d.id, d.cardId), { ...d });
  return {
    log,
    all: () => [...store.values()],
    items: {
      query: () => {
        let served = false;
        return {
          hasMoreResults: () => !served,
          fetchNext: async () => {
            served = true;
            // The query is `IS_DEFINED(c.baseEvictionEvidence)`; the fake
            // honours it rather than serving the whole store, so a test that
            // seeds an unmarked row proves the SELECTOR, not the verdict.
            return { resources: [...store.values()].filter((d) => d.baseEvictionEvidence !== undefined) };
          },
        };
      },
      upsert: async (doc: Doc) => {
        log.push(`upsert ${doc.cardId}`);
        store.set(key(doc.id, doc.cardId), { ...doc });
        return { resource: { ...doc } };
      },
    },
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
      delete: async () => {
        log.push(`delete ${pk}`);
        if (!store.delete(key(id, pk))) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return {};
      },
    }),
  };
}

/**
 * Drive the COMMITTED `revertEvictions` with a given APPLY setting.
 *
 * BACKFILL_APPLY is read at module load, so the module cache is dropped and
 * the script re-required under the env the test wants -- the same thing the
 * runner does to it, rather than a flag the test invents.
 */
function loadScript(env: Record<string, string>) {
  for (const k of Object.keys(require_.cache)) {
    if (k.includes("rematch-sold-comps")) delete require_.cache[k];
  }
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return require_(path.join(backend, "scripts", "rematch-sold-comps.cjs")); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const noop = () => {};
const writes: any[] = [];
const reportWrites = (o: any) => { writes.push(o); };
const retry = (fn: any) => fn();

describe("revertEvictions -- the WRITE, on the committed script", () => {
  let logSpy: any;
  beforeEach(() => { writes.length = 0; logSpy = vi.spyOn(console, "log").mockImplementation(noop); });
  afterEach(() => { logSpy.mockRestore(); });

  it("REPORT FIRST: without BACKFILL_APPLY it names every row and touches nothing", async () => {
    const S = loadScript({ BACKFILL_APPLY: "false", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow(), correctlyEvictedRow()]);
    const stats = await S.revertEvictions({ pool, retry, reportWrites });

    expect(stats.intended).toBe(1);
    expect(stats.written).toBe(1);          // "would revert"
    // NOTHING moved.
    expect(pool.log).toEqual([]);
    expect(pool.all().map((d) => d.cardId).sort()).toEqual([BASE, BASE]);
    // ...and no reconciliation was reported, because nothing was written.
    expect(writes).toEqual([]);

    // The report names the exact rows, with both slugs -- a report-only run
    // whose output cannot be checked against the apply is not a report.
    const printed = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
    expect(printed).toContain("sc-ppm-ja");
    expect(printed).toContain(BASE);
    expect(printed).toContain(ORIGIN);
    expect(printed).toContain("mercury");
    expect(printed).not.toContain("sc-terse");
  });

  it("A SHARDED REVERT SAYS SO -- SLOTS defaults to 32 and would silently do 1/32 of the job", async () => {
    // The census's SLOTS default is 32. A revert dispatched without `slots`
    // inherits it, reads a thirty-second of the marked rows and reconciles
    // perfectly over that thirty-second -- a green run that did almost none of
    // the work, which is the failure mode nothing else here would catch.
    const S = loadScript({ BACKFILL_APPLY: "false", SLOTS: "32", SLOT: "0" });
    const pool = fakePool([evictedRow(), evictedRow({ id: "sc-2" }), evictedRow({ id: "sc-3" })]);
    await S.revertEvictions({ pool, retry, reportWrites });
    const printed = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
    expect(printed).toMatch(/SLOT 0\/32/);
    expect(printed).toContain("slots=1");

    // ...and at slots=1 it says it owns everything, with no warning.
    logSpy.mockClear();
    const S1 = loadScript({ BACKFILL_APPLY: "false", SLOTS: "1", SLOT: "0" });
    const pool1 = fakePool([evictedRow()]);
    const stats = await S1.revertEvictions({ pool: pool1, retry, reportWrites });
    expect(stats.intended).toBe(1);
    expect(logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n")).toContain("owns every marked row");
  });

  it("APPLY: the damaged row goes back to its origin on BOTH id fields", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow(), correctlyEvictedRow()]);
    const stats = await S.revertEvictions({ pool, retry, reportWrites });

    expect(stats).toMatchObject({ intended: 1, written: 1, skipped: 0, failed: 0, notReached: 0 });
    const moved = pool.all().find((d) => d.id === "sc-ppm-ja")!;
    expect(moved.cardId).toBe(ORIGIN);
    // BOTH fields, or the row is split and the exact pool reader prices it
    // into two cards -- the defect the rematch exists to end.
    expect(moved.hobbyiqCardId).toBe(ORIGIN);

    // The correct eviction was NOT touched.
    const left = pool.all().find((d) => d.id === "sc-terse")!;
    expect(left.cardId).toBe(BASE);
    expect(left.baseEvictionEvidence).toBeDefined();
  });

  it("CF-A-SALE-IS-NEVER-LOST: the sale ARRIVES before the old row is deleted", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow()]);
    await S.revertEvictions({ pool, retry, reportWrites });
    expect(pool.log).toEqual([`upsert ${ORIGIN}`, `delete ${BASE}`]);
    // one row, not two -- the base copy is gone
    expect(pool.all().length).toBe(1);
  });

  it("the contentHash is recomputed for the NEW partition", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow()]);
    await S.revertEvictions({ pool, retry, reportWrites });
    const moved = pool.all()[0];
    // Carrying the base partition's hash across would make the row invisible
    // to the store's pre-write dedup at its new key.
    expect(moved.contentHash).not.toBe("hash-of-the-base-partition");
    expect(String(moved.contentHash)).toMatch(/\S/);
  });

  it("THE MARKER IS NEVER DELETED -- it is renamed, and an audit trail is added", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow()]);
    await S.revertEvictions({ pool, retry, reportWrites });
    const moved = pool.all()[0];

    // Erasing the evidence would make a reverted row indistinguishable from
    // one the wave never touched, and the next census would have no way to
    // know it had already been ruled on.
    expect(moved.baseEvictionEvidence).toBeUndefined();
    expect(moved.revertedEvictionEvidence).toMatchObject({ storedSlugParallel: "mercury", baseDestSlug: BASE });
    expect(moved.revertedFrom).toEqual([
      { id: "sc-ppm-ja", cardId: BASE, hobbyiqCardId: BASE, title: TITLE },
    ]);
    expect(String(moved.evictionRevertedAt)).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The reason quotes what was seen, so the round trip is readable from the
    // document alone rather than from a run log nobody kept.
    expect(moved.evictionRevertedReason).toContain("mercury");
    expect(moved.evictionRevertedReason).toContain(ORIGIN);
    expect(moved.evictionRevertedReason).toContain(BASE);
    // The ORIGINAL eviction's own trail survives untouched beside it.
    expect(moved.rekeyedFrom).toEqual([{ id: "sc-ppm-ja", cardId: ORIGIN, hobbyiqCardId: ORIGIN, title: TITLE }]);
  });

  it("THE PARALLEL FIELD IS NOT INVENTED -- the revert moves the key, nothing else", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow()]);
    await S.revertEvictions({ pool, retry, reportWrites });
    const moved = pool.all()[0];
    // The eviction did not change this field -- guard 2 required it blank to
    // begin with. Writing "Mercury" here now would be the revert asserting an
    // identity, which is the one thing an undo must not do. The next census
    // reads the row fresh at its restored key.
    expect(moved.parallel).toBe("Base");
    expect(moved.printRun).toBeNull();
    expect(moved.price).toBe(250);
    expect(moved.title).toBe(TITLE);
  });

  it("a row this script never evicted is never selected, even seeded beside one that was", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const stranger: Doc = {
      id: "sc-stranger", cardId: BASE, hobbyiqCardId: BASE, source: "cardhedge",
      title: TITLE, parallel: "Base", price: 99,
      // Same title, same slug, no marker -- and so out of reach.
      rekeyedFrom: [{ id: "sc-stranger", cardId: ORIGIN }],
    };
    const pool = fakePool([evictedRow(), stranger]);
    const stats = await S.revertEvictions({ pool, retry, reportWrites });
    expect(stats.intended).toBe(1);
    expect(pool.all().find((d) => d.id === "sc-stranger")!.cardId).toBe(BASE);
  });

  it("RE-READ AT WRITE TIME: a row that changed under us is skipped, not written on the old verdict", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow()]);
    // Between the page read and the write, somebody marks the row as the
    // user's own. The FIRST read (the page) sees the row as it was; the
    // re-read at write time sees it as it is now.
    const realItem = pool.item.bind(pool);
    let reads = 0;
    (pool as any).item = (id: string, pk: string) => {
      const h = realItem(id, pk);
      return {
        read: async () => {
          const r = await h.read();
          reads++;
          if (reads >= 1) r.resource.source = "ebay-user-purchase";
          return r;
        },
        delete: h.delete,
      };
    };
    const stats = await S.revertEvictions({ pool, retry, reportWrites });
    expect(stats.intended).toBe(1);
    expect(stats.written).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(pool.all()[0].cardId).toBe(BASE);   // untouched
  });

  it("RECONCILIATION: intended = written + skipped + failed + not reached, and it is reported", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow(), evictedRow({ id: "sc-2" }), correctlyEvictedRow()]);
    const stats = await S.revertEvictions({ pool, retry, reportWrites });
    expect(stats.written + stats.skipped + stats.failed + stats.notReached).toBe(stats.intended);
    expect(stats.intended).toBe(2);
    expect(writes).toEqual([{
      job: "rematch-sold-comps:revert-eviction",
      intended: 2, written: 2, skipped: 0, failed: 0,
    }]);
  });

  it("VERIFY BY READ: a store that loses the write fails the row instead of deleting the original", async () => {
    const S = loadScript({ BACKFILL_APPLY: "true", SLOTS: "1", SLOT: "0" });
    const pool = fakePool([evictedRow()]);
    // The upsert silently does nothing -- the shape a verify-by-read exists to
    // catch. The base row must SURVIVE: a failed move is never a lost sale.
    pool.items.upsert = (async (doc: Doc) => { pool.log.push(`upsert ${doc.cardId}`); return { resource: { ...doc } }; }) as any;
    const stats = await S.revertEvictions({ pool, retry, reportWrites });
    expect(stats.failed).toBe(1);
    expect(stats.written).toBe(0);
    expect(pool.log.some((l) => l.startsWith("delete"))).toBe(false);
    expect(pool.all()[0].cardId).toBe(BASE);
  });
});

describe("the scope, and the runner that reads it", () => {
  it("scope=revert-eviction is understood, and arms NO write class", () => {
    for (const spelling of ["revert-eviction", "revert-evictions", "revert", "REVERT_EVICTION", "Revert Eviction"]) {
      const r = K.parseApplyScope(spelling);
      expect(r.ok, spelling).toBe(true);
      expect(r.revert, spelling).toBe(true);
      // The crucial half: a revert dispatch cannot also write an eviction or
      // an improve. `classes` is empty, so `writableUnderScope` is false for
      // every classified row there is.
      expect([...r.classes]).toEqual([]);
    }
  });

  it("REVERT AND WRITE IN ONE RUN IS REFUSED -- there is no safe reading of it", () => {
    for (const bad of ["revert-eviction,improve", "revert-eviction,base-eviction", "revert,both"]) {
      const r = K.parseApplyScope(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.revert).toBe(false);
      expect([...r.classes]).toEqual([]);
      expect(r.reason).toMatch(/REVERT and to WRITE/);
    }
  });

  it("a scope that is PART understood is not understood, revert included", () => {
    const r = K.parseApplyScope("revert-eviction,bogus");
    expect(r.ok).toBe(false);
    // The flag must go down with the verdict, or a caller reading `revert`
    // without checking `ok` runs the undo on a refused parse.
    expect(r.revert).toBe(false);
  });

  it("the runner's inherited default 'refractor' still arms nothing at all", () => {
    const r = K.parseApplyScope("refractor");
    expect(r.ok).toBe(false);
    expect(r.revert).toBe(false);
    expect([...r.classes]).toEqual([]);
    // ...and the refusal names the revert among the options, so a dispatcher
    // reading the error learns the scope exists.
    expect(r.reason).toContain("revert-eviction");
  });

  it("NO NEW WORKFLOW INPUT: the revert rides script/mode/scope/apply/slot/slots", () => {
    const fs = require_("node:fs") as typeof import("node:fs");
    const runner = fs.readFileSync(path.join(backend, "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    // GitHub caps workflow_dispatch at 25 inputs. The revert must not have
    // added one -- it uses the free-form `scope` the runner already exports.
    const inputs = (runner.match(/^      [a-zA-Z_][a-zA-Z0-9_-]*:$/gm) ?? []).length;
    expect(inputs).toBeLessThanOrEqual(25);
    expect(runner).toMatch(/^\s+scope:$/m);
    expect(runner).not.toMatch(/revert[_-]?eviction:/);
  });

  it("the script refuses an apply whose scope it cannot read, BEFORE reading Cosmos", () => {
    const { spawnSync } = require_("node:child_process") as typeof import("node:child_process");
    const r = spawnSync(process.execPath, [path.join(backend, "scripts", "rematch-sold-comps.cjs")], {
      encoding: "utf8",
      env: { ...process.env, MODE: "apply-improve", SCOPE: "refractor", SLOT: "0", SLOTS: "32", COSMOS_CONNECTION_STRING: "unused" },
    });
    expect(r.status).toBe(2);
    expect(`${r.stderr}`).toMatch(/needs a class scope/);
    // Same cold-corpus subprocess cost the other script-driving pins carry:
    // this spawns a `node` that builds the phrase corpus before it reaches the
    // scope gate. The assertion is the EXIT CODE, not the clock.
  }, 180_000);

  it("scope=revert-eviction gets PAST the scope gate and stops at the connection check", () => {
    const { spawnSync } = require_("node:child_process") as typeof import("node:child_process");
    const r = spawnSync(process.execPath, [path.join(backend, "scripts", "rematch-sold-comps.cjs")], {
      encoding: "utf8",
      env: { ...process.env, MODE: "apply-improve", SCOPE: "revert-eviction", SLOT: "0", SLOTS: "1", COSMOS_CONNECTION_STRING: "" },
    });
    expect(`${r.stderr}`).toMatch(/COSMOS_CONNECTION_STRING not set/);
    expect(`${r.stderr}`).not.toMatch(/needs a class scope/);
    // SLOTS=1 is legal for a revert and would have been fatal for a census:
    // the revert shards on sha1(id), not on the 32-slot measured year table.
    expect(`${r.stderr}`).not.toMatch(/measured shard table has/);
  }, 180_000);
});
