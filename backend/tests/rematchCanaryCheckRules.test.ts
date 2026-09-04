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
type Cmp = { ok: boolean; regressions: string[]; notes: string[] };
type Checker = {
  median: (xs: number[]) => number | null;
  poolInputs: (rows: Record<string, unknown>[]) => Inputs;
  compareCanary: (c: Record<string, unknown>, b: Inputs, a: Inputs, tol?: number) => Cmp;
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
