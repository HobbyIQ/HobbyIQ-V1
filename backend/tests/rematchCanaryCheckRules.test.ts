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
  /** Rows that left this slug by an IMPROVE re-key, counted from the same
   *  `rekeyedFrom` marker `evictedAway` uses (2026-09-05, the wave-2 halt). */
  improveRekeyedAway?: number; improveRekeyedIds?: string[];
  /** Departures made by a writer that leaves no rematch marker -- the row is
   *  still resident in the container at a different address (2026-09-05,
   *  the wave-4 halt). */
  foreignRekeyedAway?: number; foreignRekeyedRows?: string[];
  ids?: string[];
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
  /** Exported so the residency rule -- the safety property of DEFECT 5 --
   *  can be pinned against a fake container. */
  measure: (pool: unknown, slug: string, priorIds?: string[]) => Promise<Inputs & {
    foreignRekeyedAway?: number; foreignRekeyedRows?: string[]; ids?: string[];
  }>;
};
const C = require_(path.join(backend, "scripts", "rematch-canary-check.cjs")) as Checker;

const BASE_CANARY = { name: "1979 topps 390 base", slug: "hiq:baseball:1979:topps:390:base:no-auto" };
const PARALLEL_CANARY = { name: "2017 topps-chrome 169 pink", slug: "hiq:baseball:2017:topps-chrome:169:pink-refractor:no-auto" };

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  rows: 100, anchor: 10, protectedRows: 1, protectedIds: ["p1@slug"], evictedAway: 0,
  improveRekeyedAway: 0, improveRekeyedIds: [],
  foreignRekeyedAway: 0, foreignRekeyedRows: [], ...over,
});

afterEach(() => { delete process.env.SCOPE; });

/**
 * DEFECT 4 -- AN IMPROVE RE-KEY IS AN ACCOUNTED-FOR DEPARTURE, NOT DAMAGE.
 *
 * Wave 2 of the GREAT REMATCH apply fleet halted on this canary twice, and
 * both halts were false. The pool and the three rows, read off prod
 * 2026-09-05 after the two applies:
 *
 *   canary  hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499
 *           13 rows (partition 7 + field 6) -> 10 (partition 4 + field 6)
 *
 *   tca-ebay::407113176192  $100.00  slot 5
 *     "2026 Bowman Redemption Justin Gonzalez Refractor  Auto /499 Red Sox Redeemed B"
 *   tca-ebay::198573811927  $148.00  slot 6
 *     "REDEMPTION : Justin Gonzales [Refractor /499] #CPA-JG 2026 Bowman Chrome Auto"
 *   tca-ebay::287538862055  $224.99  slot 6
 *     "2026 Bowman Chrome Justin Gonzales 1st Auto Refractor /499 #CPA-JG Red Sox"
 *
 * All three moved bowman -> bowman-chrome on the SAME cardNumber, parallel,
 * print run and auto flag, and all three carry
 * `rekeyedReason: "GREAT REMATCH (2026-09-01): IMPROVE, checklist-backed,
 * filled printRun"`.
 *
 * THE MOVE IS RIGHT, AND THE REASON IS THE ROW'S OWN FIELDS. Every one stores
 * `setName: "Bowman Chrome"`, and `storedIdentity` in rematch-sold-comps.cjs
 * reads setName -- not the slug -- so the stored setKey was ALREADY
 * `bowman-chrome`. The setKey axis was SAME; the only axis that moved was
 * printRun (absent on the row, 499 on the checklist). The destination
 * `hiq:baseball:2026:bowman-chrome:cpa-jg:refractor:auto:num-499` is
 * checklist-backed (`checklistcenter-2026-08-29`, verificationStatus
 * "verified", printRun 499). The write made the row's ADDRESS agree with the
 * identity the row already stated -- one card, one row, one pool.
 *
 * Drew's holding row `ebay-user-purchase::147349440137-10083282594225`
 * (setName "2026 Bowman", PROTECTED) did NOT move and is still on the
 * holding's slug. The boundary held exactly where it should.
 */
describe("DEFECT 4 -- an attributed IMPROVE re-key is not a regression", () => {
  const GONZ = { name: "Gonzalez 2026 Bowman CPA-JG Refractor auto /499", slug: "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499" };
  const DEST = "hiq:baseball:2026:bowman-chrome:cpa-jg:refractor:auto:num-499";
  const PROTECTED_ID = "ebay-user-purchase::147349440137-10083282594225@hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499";
  const before = () => inputs({ rows: 13, anchor: 249.99, protectedRows: 1, protectedIds: [PROTECTED_ID] });

  it("the slot-5 shape: 13 -> 12, one row re-keyed away, PASS with a note that names it", () => {
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 12, anchor: 249.99, protectedRows: 1, protectedIds: [PROTECTED_ID],
      improveRekeyedAway: 1, improveRekeyedIds: [`tca-ebay::407113176192@${DEST}`],
    }), 10, { fromCount: 1, toCount: 0, from: ["tca-ebay::407113176192"], to: [] });
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.notes.join(" ")).toContain("accounted for by the rekeyedFrom marker");
    // The verdict must NAME the row that left, not merely count it.
    expect(r.notes.join(" ")).toContain("tca-ebay::407113176192");
  });

  it("the slot-6 shape: the cumulative 13 -> 10, every departure named in the note", () => {
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 10, anchor: 249.99, protectedRows: 1, protectedIds: [PROTECTED_ID],
      improveRekeyedAway: 3,
      improveRekeyedIds: [`tca-ebay::198573811927@${DEST}`, `tca-ebay::287538862055@${DEST}`, `tca-ebay::407113176192@${DEST}`],
    }), 10, { fromCount: 2, toCount: 0, from: ["tca-ebay::198573811927", "tca-ebay::287538862055"], to: [] });
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    // All three rows the fleet moved are named in the verdict.
    for (const id of ["tca-ebay::198573811927", "tca-ebay::287538862055", "tca-ebay::407113176192"]) {
      expect(r.notes.join(" ")).toContain(id);
    }
  });

  it("the anchor recomputed without the $100 and $148 departures is a note, not a failure", () => {
    // Removing the two cheapest sales moves the leading edge well past the 10%
    // tolerance. That is the intended effect of moving them.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 10, anchor: 224.99 * 1.4, protectedRows: 1, protectedIds: [PROTECTED_ID],
      improveRekeyedAway: 3, improveRekeyedIds: [`tca-ebay::407113176192@${DEST}`],
    }), 10, { fromCount: 3, toCount: 0, from: [], to: [] });
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toContain("the leading edge is recomputed without them");
  });

  it("MUTATION PIN -- a departure with NO re-key marker still exits 5", () => {
    // The whole safety argument: only a MARKED departure is excused. Drop the
    // marker and the same shape must fail.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 12, protectedRows: 1, protectedIds: [PROTECTED_ID], improveRekeyedAway: 0,
    }), 10, { fromCount: 1, toCount: 0, from: ["tca-ebay::407113176192"], to: [] });
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("pool LOST 1 row");
  });

  it("MUTATION PIN -- a PARTIALLY accounted loss fails and names the unexplained remainder", () => {
    // 3 left, only 1 carries the marker. The other 2 are unexplained and the
    // gate must not launder them through the accounted-for clause.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 10, protectedRows: 1, protectedIds: [PROTECTED_ID], improveRekeyedAway: 1,
    }), 10, { fromCount: 3, toCount: 0, from: [], to: [] });
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("2 unexplained");
  });

  it("the cross-shard case: more departures measured than THIS ledger names still passes", () => {
    // THE REGRESSION THIS PIN EXISTS FOR. Slot 6 measured 3 departures while
    // its own ledger named 2, because slot 5 moved the third before slot 6's
    // baseline was taken. An earlier draft bounded the discount by the
    // ledger's `fromCount` and failed this shard while printing
    // "0 unexplained" -- a verdict that contradicted itself.
    //
    // The marker, not one shard's bookkeeping, is the evidence: all 3 rows
    // carry `rekeyedFrom`, so all 3 are accounted for.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 10, anchor: 249.99, protectedRows: 1, protectedIds: [PROTECTED_ID],
      improveRekeyedAway: 3,
    }), 10, { fromCount: 2, toCount: 0, from: ["tca-ebay::198573811927", "tca-ebay::287538862055"], to: [] });
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    // And it must never print the self-contradicting sentence again.
    expect(r.regressions.join(" ")).not.toContain("0 unexplained");
  });

  it("MUTATION PIN -- a PROTECTED row leaving is STILL a regression, marker or not", () => {
    // Drew's holding row must never be excusable by any accounting.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 12, protectedRows: 0, protectedIds: [],
      improveRekeyedAway: 1, improveRekeyedIds: [`${PROTECTED_ID}`],
    }), 10, { fromCount: 1, toCount: 0, from: [], to: [] });
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("PROTECTED row left the pool");
  });

  it("an UNTOUCHED pool is reported as other writers' work, never as an IMPROVE re-key", () => {
    // A pool this shard never wrote in is attributed to the other writers, and
    // the re-key marker of some other lane must not relabel that as this
    // shard's intended effect. (The untouched branch answers first, so this
    // pins the SENTENCE the reader gets, which is the thing that decides
    // whether a human goes looking at the right lane.)
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 12, protectedRows: 1, protectedIds: [PROTECTED_ID], improveRekeyedAway: 1,
    }), 10, undefined);
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toContain("other writers");
    expect(r.notes.join(" ")).not.toContain("rekeyedFrom marker");
  });

  it("MUTATION PIN -- with NO ledger the gate stays strict and an accounted loss still fails", () => {
    // `touched` is true when there is no ledger (the degrade-closed path), but
    // an unattributable apply must not get the benefit of the new clause: the
    // gate cannot tell whose re-key that marker records. Passing `null`
    // (no ledger) must still exit 5 on the very shape that passes with one.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 12, anchor: 249.99, protectedRows: 1, protectedIds: [PROTECTED_ID],
      improveRekeyedAway: 1, improveRekeyedIds: [`tca-ebay::407113176192@${DEST}`],
    }), 10, null);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("pool LOST 1 row");
  });

  it("MUTATION PIN -- a pool that lost NOTHING cannot use the clause to excuse an anchor move", () => {
    // `lost > 0` guards it: an anchor that jumps in a pool with every row
    // still in it is unexplained by any departure and must still fail.
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 13, anchor: 2.0, protectedRows: 1, protectedIds: [PROTECTED_ID], improveRekeyedAway: 3,
    }), 10, { fromCount: 3, toCount: 0, from: [], to: [] });
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("anchor moved");
  });

  it("an EMPTY pool is still a regression even when every departure is marked", () => {
    const r = C.compareCanary(GONZ, before(), inputs({
      rows: 0, anchor: null, protectedRows: 0, protectedIds: [], improveRekeyedAway: 13,
    }), 10, { fromCount: 13, toCount: 0, from: [], to: [] });
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("EMPTY");
  });
});

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

/**
 * DEFECT 5 -- A DEPARTURE CAN BELONG TO A WRITER THAT LEAVES NO FLEET MARKER.
 *
 * Wave 4 halted on slots 12 (run 33966963322) and 13 (run 33966972191). Both
 * failed the SAME canary with the SAME shortfall of exactly one row:
 *
 *   [derived] slot 14 2025 bowman-draft bdc-1 base
 *   hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto   floor 580, protected 6
 *
 *   slot 12  591 -> 587   "only 3 carry the re-key marker -- 1 unexplained"
 *   slot 13  591 -> 584   "only 6 carry the re-key marker -- 1 unexplained"
 *
 * READ OFF PROD. Six rows left that pool carrying
 * `rekeyedFrom[0].cardId = <the canary slug>` and no `baseEvictionEvidence`,
 * every one an IMPROVE re-key onto a parallel its own title states:
 *
 *   cardsight::08a6d97be0ea5344dd0c2ebd  $15.50  14:35:38Z  -> :x-fractor:
 *     "2025 Bowman Draft Eli Willits Chrome X-Fractor 1st Prospect #BDC-1"
 *   cardsight::7e17184d9df707eb68fd4954  $12.29  14:35:44Z  -> :refractor:
 *   cardsight::0a1d82d1be78104a4a445fe3  $4.25   14:35:44Z  -> :refractor:
 *   cardsight::2a2095d9e320ebb1683271d6  $22.50  14:43:20Z  -> :refractor:
 *   cardsight::6f9f63d4120c9c202c3ce1b6  $3.75   14:43:20Z  -> :refractor:
 *   tca-ebay::377268783190               $29.99  14:43:40Z  -> :x-fractor:
 *     "2025 BOWMAN DRAFT CHRONE ELI WILLITS 1ST X-FRACTOR #BDC-1"
 *
 * Three had landed by slot 12's after-read (14:37:29Z) and all six by slot
 * 13's (14:45:09Z) -- exactly the 3 and 6 the two logs reported. The marker
 * query is already run-agnostic, so the SIBLING-SHARD hypothesis is REFUTED:
 * slot 13 counted slot 12's moves without complaint.
 *
 * THE SEVENTH ROW WAS NEVER THE FLEET'S:
 *
 *   cardhedge::ch-daily::1787885457712x483187805134631000   $23.39
 *   "Eli Willits 2025 Bowman Chrome Draft Sapphire #BDC-1 1st RC - Raw"
 *   setName "2025 Bowman Draft Sapphire Baseball", parallel "Base"
 *   _ts 2026-09-05T13:18:13Z, rekeyedFrom UNDEFINED, rekeyedAt UNDEFINED
 *
 * The CardHedge daily ingest rewrote it at 13:18:13Z -- after both baselines
 * (12:47Z), before both after-reads -- recomputing its `hobbyiqCardId` to
 * `hiq:baseball:2025:bowman-draft-sapphire:bdc-1:base:no-auto`. A Sapphire
 * sale correctly stopped counting as Bowman Draft paper. The row never
 * vanished; it is still resident, at a new address, with no rematch marker
 * because the ingest is not the rematch.
 *
 * The old code had two categories -- "carries a fleet marker" or "damage" --
 * so a foreign re-address inside a TOUCHED pool could only read as damage.
 * The anchor never moved ($2.85 -> $2.85) and protected held (6 -> 6) in both
 * runs: nothing was harmed.
 */
describe("DEFECT 5 -- a foreign writer's departure is accounted for, not damage", () => {
  const BDC1 = { name: "[derived] slot 14 2025 bowman-draft bdc-1 base", slug: "hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto" };
  const PROT = "cardsight::1768677198934x586733556995573000::2026-07-16T01:10:00+00:00::8900@hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto";
  const CH_ROW = 'cardhedge::ch-daily::1787885457712x483187805134631000 -> hiq:baseball:2025:bowman-draft-sapphire:bdc-1:base:no-auto [cardhedge] $23.39 "Eli Willits 2025 Bowman Chrome Draft Sapphire #BDC-1 1st RC - Raw"';
  const before = () => inputs({ rows: 591, anchor: 2.85, protectedRows: 6, protectedIds: [PROT] });
  const touch = { fromCount: 3, toCount: 0, from: [], to: [] };

  it("the slot-12 shape: 591 -> 587, 3 marked + 1 foreign, PASS naming both writers", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 587, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 3, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, touch);
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.notes.join(" ")).toContain("all 4 accounted for");
    expect(r.notes.join(" ")).toContain("3 accounted for by the rekeyedFrom marker (an IMPROVE re-key)");
    expect(r.notes.join(" ")).toContain("1 to another writer");
    expect(r.regressions.join(" ")).not.toContain("1 unexplained");
  });

  it("the slot-13 shape: 591 -> 584, 6 marked + 1 foreign, PASS -- the sibling's moves count too", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 584, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 6, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, touch);
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.notes.join(" ")).toContain("all 7 accounted for");
  });

  it("the foreign row is NAMED in the verdict, so the reader can judge the move", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 587, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 3, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, touch);
    const notes = r.notes.join("\n");
    expect(notes).toContain("moved by another writer:");
    expect(notes).toContain("cardhedge::ch-daily::1787885457712x483187805134631000");
    expect(notes).toContain("bowman-draft-sapphire");
  });

  it("MUTATION PIN -- requiring the shard's OWN marker only (foreign ignored) goes RED", () => {
    // The mutation: drop foreignRekeyedAway from the accounting and the
    // wave-4 shape fails again with the exact sentence that halted it.
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 587, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 3, foreignRekeyedAway: 0, foreignRekeyedRows: [],
    }), 10, touch);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("1 unexplained");
  });

  it("MUTATION PIN -- a departure that is neither marked NOR resident still exits 5", () => {
    // A vanished sale matches no marker and resolves to no resident row, so
    // it lands here. This is the damage the gate exists to catch.
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 588, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 0, foreignRekeyedAway: 0, foreignRekeyedRows: [],
    }), 10, touch);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("pool LOST 3 row(s)");
  });

  it("MUTATION PIN -- a PARTIAL accounting still fails and counts BOTH writers", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 584, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 3, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, touch);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("3 unexplained");
    expect(r.regressions.join(" ")).toContain("3 by the re-key marker, 1 by another writer");
  });

  it("MUTATION PIN -- a PROTECTED row leaving is not excusable by a foreign departure", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 590, anchor: 2.85, protectedRows: 5, protectedIds: [],
      improveRekeyedAway: 0, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, touch);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("PROTECTED row left the pool");
  });

  it("MUTATION PIN -- an EMPTY pool fails even when every departure is foreign", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 0, anchor: null, protectedRows: 0, protectedIds: [],
      improveRekeyedAway: 0, foreignRekeyedAway: 591, foreignRekeyedRows: [],
    }), 10, touch);
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toContain("pool is EMPTY");
  });

  it("MUTATION PIN -- with NO ledger the gate stays strict and a foreign departure still fails", () => {
    // Degrade-closed: without attribution the checker cannot tell whose write
    // moved the row, so it must not hand out the pass.
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 590, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 0, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, null);
    expect(r.ok).toBe(false);
  });

  it("an UNTOUCHED pool still reads as other writers' work, not as an accounted departure", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 587, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 3, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, undefined);
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toContain("pool changed by other writers");
  });

  it("the anchor held at $2.85 in both runs -- no price damage to report", () => {
    const r = C.compareCanary(BDC1, before(), inputs({
      rows: 584, anchor: 2.85, protectedRows: 6, protectedIds: [PROT],
      improveRekeyedAway: 6, foreignRekeyedAway: 1, foreignRekeyedRows: [CH_ROW],
    }), 10, touch);
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).not.toContain("anchor moved");
  });
});

/**
 * THE RESIDENCY RULE IS THE SAFETY PROPERTY OF DEFECT 5, so it is pinned
 * against a fake container rather than through injected inputs.
 *
 * compareCanary only ever sees a COUNT of foreign departures, so a unit test
 * that hands it `foreignRekeyedAway: 1` cannot tell whether measure() earned
 * that number honestly. The whole reason the clause is safe is that measure()
 * counts a departed row as foreign ONLY when the row is still RESIDENT in the
 * container at a different address. Delete that check and a VANISHED sale --
 * the exact damage this gate exists to catch -- would be excused silently.
 * These pins fail if the residency check is removed.
 */
describe("DEFECT 5 -- measure() only excuses a departure that is still resident", () => {
  const SLUG = "hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto";
  const SAPPHIRE = "hiq:baseball:2025:bowman-draft-sapphire:bdc-1:base:no-auto";
  const CH_ID = "cardhedge::ch-daily::1787885457712x483187805134631000";

  /** A container stub: `docs` is every row that still exists. */
  const fakePool = (docs: Record<string, unknown>[]) => ({
    items: {
      query: (spec: { query: string; parameters?: { name: string; value: unknown }[] }) => {
        const q = spec.query;
        const param = (n: string) => spec.parameters?.find((x) => x.name === n)?.value;
        let out: unknown[] = [];
        if (q.includes("c.cardId = @s") && !q.includes("hobbyiqCardId")) {
          out = docs.filter((d) => d.cardId === param("@s"));
        } else if (q.includes("c.hobbyiqCardId = @s")) {
          out = docs.filter((d) => d.hobbyiqCardId === param("@s") && d.cardId !== param("@s"));
        } else if (q.includes("baseEvictionEvidence") && q.includes("COUNT")) {
          out = [0];
        } else if (q.includes("rekeyedFrom[0].cardId = @s")) {
          out = docs.filter((d) => Array.isArray(d.rekeyedFrom) &&
            (d.rekeyedFrom as { cardId?: string }[])[0]?.cardId === param("@s"));
        } else if (q.includes("c.id IN (")) {
          const wanted = new Set((spec.parameters ?? []).map((x) => x.value));
          out = docs.filter((d) => wanted.has(d.id));
        }
        let done = false;
        return { hasMoreResults: () => !done, fetchNext: async () => { done = true; return { resources: out }; } };
      },
    },
  });

  const inPool = (id: string) => ({ id, cardId: SLUG, hobbyiqCardId: SLUG, price: 5, soldAt: "2026-09-01T00:00:00Z", title: "t" });

  it("a departed row STILL RESIDENT at a new address counts as a foreign departure", async () => {
    // The wave-4 row: gone from the pool, alive in the container on the
    // Sapphire slug, carrying no rematch marker.
    const docs = [inPool("keep-1"), inPool("keep-2"),
      { id: CH_ID, cardId: SAPPHIRE, hobbyiqCardId: SAPPHIRE, price: 23.39, source: "cardhedge",
        title: "Eli Willits 2025 Bowman Chrome Draft Sapphire #BDC-1 1st RC - Raw" }];
    const m = await C.measure(fakePool(docs), SLUG, ["keep-1", "keep-2", CH_ID]);
    expect(m.rows).toBe(2);
    expect(m.foreignRekeyedAway).toBe(1);
    expect((m.foreignRekeyedRows ?? []).join(" ")).toContain(CH_ID);
    expect((m.foreignRekeyedRows ?? []).join(" ")).toContain("bowman-draft-sapphire");
  });

  it("MUTATION PIN -- a VANISHED row is NOT a foreign departure and stays damage", async () => {
    // Same baseline, but the third row no longer exists anywhere. It must
    // not be excused: nothing resolves it, so foreignRekeyedAway stays 0 and
    // compareCanary reports the loss.
    const docs = [inPool("keep-1"), inPool("keep-2")];
    const m = await C.measure(fakePool(docs), SLUG, ["keep-1", "keep-2", "deleted-row"]);
    expect(m.rows).toBe(2);
    expect(m.foreignRekeyedAway).toBe(0);
    const r = C.compareCanary({ name: "c", slug: SLUG },
      inputs({ rows: 3, protectedRows: 0, protectedIds: [] }),
      inputs({ rows: m.rows, protectedRows: 0, protectedIds: [], foreignRekeyedAway: 0 }),
      10, { fromCount: 1, toCount: 0, from: [], to: [] });
    expect(r.ok).toBe(false);
  });

  it("MUTATION PIN -- a row still addressed HERE is not a departure at all", async () => {
    // A stale read that still resolves to this slug must never be counted;
    // counting it would license a real loss elsewhere.
    const docs = [inPool("keep-1"), inPool("keep-2"), inPool("keep-3")];
    const m = await C.measure(fakePool(docs), SLUG, ["keep-1", "keep-2", "keep-3"]);
    expect(m.rows).toBe(3);
    expect(m.foreignRekeyedAway).toBe(0);
  });

  it("a row that left WITH the rematch marker is the fleet's, never counted as foreign", async () => {
    // The two populations must partition, not double-count: 1 marked + 0
    // foreign, so the same departure can never be excused twice.
    const docs = [inPool("keep-1"),
      { id: "moved-1", cardId: "hiq:baseball:2025:bowman-draft:bdc-1:refractor:no-auto",
        hobbyiqCardId: "hiq:baseball:2025:bowman-draft:bdc-1:refractor:no-auto", price: 12.29,
        rekeyedFrom: [{ cardId: SLUG }], title: "... Chrome Refractor ... #BDC-1" }];
    const m = await C.measure(fakePool(docs), SLUG, ["keep-1", "moved-1"]);
    expect(m.improveRekeyedAway).toBe(1);
    expect(m.foreignRekeyedAway).toBe(0);
  });

  it("the baseline records the pool's ids, which is what makes the resolve possible", async () => {
    const docs = [inPool("a"), inPool("b")];
    const m = await C.measure(fakePool(docs), SLUG);
    expect(m.ids).toEqual(["a", "b"]);
    // With no priorIds (the MODE=before path) nothing is resolved.
    expect(m.foreignRekeyedAway).toBe(0);
  });
});
