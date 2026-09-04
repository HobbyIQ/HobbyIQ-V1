/**
 * THE CANARY CHECK'S TWO STRUCTURAL DEFECTS, from the 2026-09-04 halt.
 *
 * Two shards of the base-eviction apply wave exited 5 on canary regressions
 * and the fleet was stopped. Read against the pool afterwards, ZERO rows had
 * left any of the four "regressed" canaries by a base eviction, and the shard
 * axis proves it could not have been otherwise: slot 1 holds {2025 football,
 * 1956} and slot 3 holds {2024 football, 2025 other}, while the four canaries
 * are 1979, 1984, 1991 and 2017 -- years those shards never touch.
 *
 * DEFECT 1 -- the union double-counted. measure() concatenated the partition
 * query and the field query without de-duplicating by id. A sale can sit in
 * both (a cross-source CH/CS pair sharing one id), so the BEFORE count was
 * inflated. The nightly "Sold Comps Dedup" job (04:45 UTC, cross_source=true)
 * then collapsed those pairs between the BEFORE (04:33/04:37) and the AFTER
 * (05:03/05:06), and the check read a concurrent job's correct cleanup as its
 * own shard's damage. The live pool confirms the duplicate ids exactly:
 * 1984 Fleer #301 had 4, 1991 Score #396 had 1, 2017 Chrome #169 Pink had 1 --
 * matching the reported losses of 2, 3 and 2 rows.
 *
 * DEFECT 2 -- "rows went down" is the wrong assertion for this scope. Under
 * scope=base-eviction a PARALLEL-pool canary is SUPPOSED to lose base-titled
 * rows; that is the entire intended effect. The rule failed shards for doing
 * their job. What replaces it: a loss on a parallel canary must be ACCOUNTED
 * FOR by the eviction marker, and an unexplained loss still fails. On a BASE
 * canary nothing can ever be evicted away, so the strict rule stands.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Inputs = {
  rows: number; anchor: number | null; protectedRows: number; protectedIds: string[];
  newestAt?: string | null; newestPrice?: number | null; evictedAway?: number;
};
type Cmp = { ok: boolean; regressions: string[]; notes: string[]; touched?: boolean; attributed?: boolean; moved?: number };
/** One pool's row in the apply's write ledger: what THIS shard moved here. */
type Touch = { fromCount?: number; toCount?: number; from?: string[]; to?: string[] };
type Ledger = { doc: Record<string, unknown> & { written?: number }; pools: Record<string, Touch> };
type Checker = {
  median: (xs: number[]) => number | null;
  poolInputs: (rows: Record<string, unknown>[]) => Inputs;
  /** `touch`: null = no ledger (strict); undefined = ledger exists but does
   *  not name this pool (untouched); an object = this shard wrote here. */
  compareCanary: (c: Record<string, unknown>, b: Inputs, a: Inputs, tol?: number, touch?: Touch | null) => Cmp;
  loadLedger: (file: string) => Ledger | null;
};
const C = require_(path.join(backend, "scripts", "rematch-canary-check.cjs")) as Checker;

const BASE_CANARY = { name: "1979 topps 390 base", slug: "hiq:baseball:1979:topps:390:base:no-auto" };
const PARALLEL_CANARY = { name: "2017 topps-chrome 169 pink", slug: "hiq:baseball:2017:topps-chrome:169:pink-refractor:no-auto" };

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  rows: 100, anchor: 10, protectedRows: 1, protectedIds: ["p1@slug"], evictedAway: 0, ...over,
});

afterEach(() => { delete process.env.SCOPE; });

describe("DEFECT 2 -- a parallel canary is SUPPOSED to lose base rows", () => {
  it("an accounted-for loss on a PARALLEL canary under eviction scope is a note, not a regression", () => {
    process.env.SCOPE = "base-eviction";
    // The real slot-30 shape: 97 -> 95, and both departures carry the marker.
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 97, anchor: 1500 }), inputs({ rows: 95, anchor: 520, evictedAway: 2 }));
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/accounted for by the eviction marker/);
  });

  it("the anchor move that follows an intended eviction is a note too", () => {
    process.env.SCOPE = "base-eviction";
    // $1500 -> $520 is 65%, far past the 10% tolerance, and entirely expected:
    // the leading edge is recomputed once mis-filed sales leave the pool.
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 97, anchor: 1500 }), inputs({ rows: 95, anchor: 520, evictedAway: 2 }));
    expect(r.notes.join(" ")).toMatch(/expected under base eviction/);
  });

  it("an UNEXPLAINED loss on a parallel canary still fails -- the marker is the evidence", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 97 }), inputs({ rows: 95, evictedAway: 0 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/2 unexplained/);
  });

  it("MUTATION PIN -- a BASE canary may never lose rows, eviction scope or not", () => {
    process.env.SCOPE = "base-eviction";
    // Nothing can be evicted OUT of a base pool: base is where evictions land.
    // If this ever passes, the relaxation has been applied too widely and the
    // check has stopped defending the pools it exists for.
    const r = C.compareCanary(BASE_CANARY, inputs({ rows: 174 }), inputs({ rows: 173, evictedAway: 1 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/pool LOST 1 row/);
  });

  it("MUTATION PIN -- outside eviction scope the strict rule is untouched", () => {
    // scope unset = the IMPROVE class, where a verified pool has no reason to shrink.
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 97 }), inputs({ rows: 95, evictedAway: 2 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/pool LOST 2 row/);
  });

  it("a PROTECTED row leaving is a regression in every scope", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 97, protectedRows: 2, protectedIds: ["p1@s", "p2@s"] }), inputs({ rows: 95, protectedRows: 1, protectedIds: ["p1@s"], evictedAway: 2 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/PROTECTED row left the pool/);
  });

  it("an empty pool is a regression even when every departure is explained", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 2 }), inputs({ rows: 0, anchor: null, evictedAway: 2 }));
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/EMPTY/);
  });
});

describe("the anchor is the leading edge, never an FMV", () => {
  it("is the median of the newest three, so the incident's numbers reproduce", () => {
    // AFTER the duplicate $1500 row was retired: [1500, 520, 408.51] -> 520.
    expect(C.median([1500, 520, 408.51])).toBe(520);
    // BEFORE, with the duplicate counted twice: [1500, 1500, 520] -> 1500.
    // That is the whole of the "anchor moved 65.3%" alarm.
    expect(C.median([1500, 1500, 520])).toBe(1500);
  });

  it("poolInputs de-duplicates nothing itself -- that is measure()'s job", () => {
    const rows = [
      { id: "a", price: 10, soldAt: "2026-09-01T00:00:00Z" },
      { id: "b", price: 20, soldAt: "2026-08-01T00:00:00Z" },
    ];
    expect(C.poolInputs(rows).rows).toBe(2);
  });
});

/**
 * DEFECT 3 -- A VERDICT WAS NEVER ATTRIBUTED (the 2026-09-04 second halt).
 *
 * Runs 33846426659 (slot 1) and 33846443590 (slot 2) both reconciled
 * `intended 0 = written 0` -- every candidate had already been applied by an
 * earlier pass -- and both still exited 5. They were failed on the slot-14 and
 * slot-26 canaries: pools belonging to OTHER shards, which a slot-1 or slot-2
 * apply cannot reach. The same canary reported two different after-values in
 * the two runs ($23.39 -> $4.69 at 08:04Z, $23.39 -> $2.85 at 08:15Z) because
 * the pool kept moving while the gate watched it.
 *
 * Read against sold_comps afterwards, the cause is unambiguous and is not the
 * shard: the CardHedge daily ingest landed 4 new sales in the 2025 bowman-draft
 * bdc-1 pool and 7 in the 1986 fleer-stickers pool between 07:50Z and 08:26Z,
 * every one of them newer than the baseline's newest. The anchor is the median
 * of the newest three, so new sales redefine it outright:
 *   bdc-1        median(2.85, 4.69, 2.00) = 2.85   (the 08:15Z reading)
 *   fleer #8     median(3050, 3950, 1875) = 3050   (the 11.4% "regression")
 * Zero rows were rekeyed into either pool, zero evicted away, and zero rekeys
 * of any kind touched either slug.
 *
 * A shard that wrote nothing cannot have regressed a pool. The gate now reads
 * the apply's WRITE LEDGER and only holds the shard to account for pools the
 * ledger says it wrote in.
 */
describe("DEFECT 3 -- a regression must be ATTRIBUTED to the shard under test", () => {
  const ledgerTouch = (over: Record<string, unknown> = {}) => ({ fromCount: 2, toCount: 0, from: ["x", "y"], to: [], ...over });

  it("the incident reproduces: an anchor move in an UNTOUCHED pool is a note, not exit 5", () => {
    process.env.SCOPE = "base-eviction";
    // slot 1's real numbers on the slot-14 canary: $23.39 -> $4.69, +2 rows,
    // and the ledger (undefined for this pool) says slot 1 never wrote here.
    const r = C.compareCanary(
      BASE_CANARY,
      inputs({ rows: 579, anchor: 23.39 }),
      inputs({ rows: 581, anchor: 4.69 }),
      10,
      undefined,
    );
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/pool changed by other writers/);
    expect(r.notes.join(" ")).toMatch(/this shard wrote nothing here/);
  });

  it("the 11.4% fleer-stickers move is a note too when the shard never wrote there", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(
      BASE_CANARY,
      inputs({ rows: 1838, anchor: 2738.88 }),
      inputs({ rows: 1845, anchor: 3050 }),
      10,
      undefined,
    );
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toMatch(/anchor moved 11\.4%/);
  });

  it("a row-count LOSS in an untouched pool is a note -- the nightly dedup is not this shard", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(BASE_CANARY, inputs({ rows: 100 }), inputs({ rows: 97, evictedAway: 0 }), 10, undefined);
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toMatch(/3 fewer row\(s\)/);
  });

  it("the verdict names the shard's own movement when the pool IS touched", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(BASE_CANARY, inputs({ rows: 100 }), inputs({ rows: 100 }), 10, ledgerTouch({ fromCount: 3, toCount: 4 }));
    expect(r.touched).toBe(true);
    expect(r.moved).toBe(7);
    expect(r.notes.join(" ")).toMatch(/this shard moved 7 row\(s\) in this pool \(out 3, in 4\)/);
  });

  it("MUTATION PIN -- an untouched-pool anchor move must NOT exit 5", () => {
    // If this ever fails, the attribution has been reverted and the fleet is
    // once again haltable by any concurrent ingest. That is the whole bug.
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(BASE_CANARY, inputs({ anchor: 100 }), inputs({ anchor: 10 }), 10, undefined);
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
  });

  it("MUTATION PIN -- a TOUCHED pool losing rows with no marker still exits 5", () => {
    // The relaxation must not leak into pools the shard actually wrote in.
    // A base canary can never be evicted out of, so any loss there is damage.
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(BASE_CANARY, inputs({ rows: 174 }), inputs({ rows: 173, evictedAway: 0 }), 10, ledgerTouch());
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/pool LOST 1 row/);
  });

  it("MUTATION PIN -- a TOUCHED parallel pool's unexplained loss still exits 5", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(PARALLEL_CANARY, inputs({ rows: 97 }), inputs({ rows: 95, evictedAway: 0 }), 10, ledgerTouch());
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/2 unexplained/);
  });

  it("a PROTECTED row leaving is a regression even in a pool the shard never touched", () => {
    // Attribution relaxes what is merely DIFFERENT. It never relaxes what no
    // writer in the system is allowed to do at all.
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(
      BASE_CANARY,
      inputs({ protectedRows: 2, protectedIds: ["p1@s", "p2@s"] }),
      inputs({ protectedRows: 1, protectedIds: ["p1@s"] }),
      10,
      undefined,
    );
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/PROTECTED row left the pool/);
  });

  it("an EMPTY pool is a regression even in a pool the shard never touched", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(BASE_CANARY, inputs({ rows: 2 }), inputs({ rows: 0, anchor: null }), 10, undefined);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/EMPTY/);
  });

  it("NO LEDGER degrades CLOSED -- every canary is treated as touched and the old rules stand", () => {
    // A checker that cannot attribute must not hand out passes it did not
    // earn. `null` is "no ledger at all", and it must behave exactly as the
    // pre-attribution checker did.
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(BASE_CANARY, inputs({ rows: 174 }), inputs({ rows: 173, evictedAway: 0 }), 10, null);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/pool LOST 1 row/);

    const a = C.compareCanary(BASE_CANARY, inputs({ anchor: 100 }), inputs({ anchor: 10 }), 10, null);
    expect(a.ok).toBe(false);
    expect(a.regressions.join(" ")).toMatch(/anchor moved 90\.0%/);
  });

  it("the #1711 eviction rules are untouched on a TOUCHED parallel canary", () => {
    process.env.SCOPE = "base-eviction";
    const r = C.compareCanary(
      PARALLEL_CANARY,
      inputs({ rows: 97, anchor: 1500 }),
      inputs({ rows: 95, anchor: 520, evictedAway: 2 }),
      10,
      ledgerTouch(),
    );
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toMatch(/accounted for by the eviction marker/);
    expect(r.notes.join(" ")).toMatch(/expected under base eviction/);
  });
});

describe("loadLedger -- the gate's evidence, and what it does without any", () => {
  it("returns null when the file does not exist, so the caller stays strict", () => {
    expect(C.loadLedger("/tmp/definitely-not-a-real-ledger-path-9f3a.json")).toBeNull();
  });

  it("returns null for an unreadable ledger rather than an empty one", () => {
    // An empty ledger means "touched nothing" and would relax every canary.
    // A CORRUPT ledger must never be read that way -- it degrades closed.
    const bad = path.join(os.tmpdir(), `hiq-bad-ledger-${process.pid}.json`);
    fs.writeFileSync(bad, "{not json");
    try {
      expect(C.loadLedger(bad)).toBeNull();
    } finally {
      fs.unlinkSync(bad);
    }
  });

  it("reads the pools an apply wrote", () => {
    const good = path.join(os.tmpdir(), `hiq-good-ledger-${process.pid}.json`);
    fs.writeFileSync(good, JSON.stringify({
      job: "rematch-sold-comps", slot: 1, slots: 32, written: 2, poolsTouched: 1,
      pools: { "hiq:baseball:1956:topps:292:base:no-auto": { fromCount: 2, toCount: 0, from: ["a", "b"], to: [] } },
    }));
    try {
      const l = C.loadLedger(good);
      expect(l).not.toBeNull();
      expect(Object.keys(l!.pools)).toEqual(["hiq:baseball:1956:topps:292:base:no-auto"]);
      expect(l!.doc.written).toBe(2);
    } finally {
      fs.unlinkSync(good);
    }
  });

  it("an apply that wrote nothing yields an EMPTY pools map, not a null ledger", () => {
    // This is the shape both halted runs would have emitted, and it is the
    // positive claim "this shard moved nothing anywhere".
    const empty = path.join(os.tmpdir(), `hiq-empty-ledger-${process.pid}.json`);
    fs.writeFileSync(empty, JSON.stringify({ job: "rematch-sold-comps", slot: 1, written: 0, poolsTouched: 0, pools: {} }));
    try {
      const l = C.loadLedger(empty);
      expect(l).not.toBeNull();
      expect(Object.keys(l!.pools)).toEqual([]);
      // and every canary is therefore untouched -> notes, never exit 5
      const r = C.compareCanary(BASE_CANARY, inputs({ anchor: 23.39 }), inputs({ anchor: 4.69 }), 10, l!.pools[String(BASE_CANARY.slug)]);
      expect(r.ok).toBe(true);
    } finally {
      fs.unlinkSync(empty);
    }
  });
});
