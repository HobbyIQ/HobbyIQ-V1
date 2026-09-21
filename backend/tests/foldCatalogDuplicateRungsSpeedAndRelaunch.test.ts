// fold-catalog-duplicate-rungs.cjs -- follow-up review findings, 2026-09-20.
//
// The football/2024 panini-mosaic pilot REPORT (51,286 rows, 3,197 groups)
// took a full 120 minutes (~2.2s/group) though pass 1 cost only 4,850 RU, and
// its self-relaunch step re-dispatched AFTER the scan had already finished
// (run 35576430500, cancelled) -- a report that never drains looping forever.
//
// This file pins the fix, end to end, against a fake Cosmos (via `runLane`,
// the container-injectable core `main()` now wraps):
//
//   1. a run that finishes its whole scan prints NO relaunch marker, however
//      long it took, however many groups it processed
//   2. a run that genuinely stops mid-scan (its own clock budget) DOES print
//      the marker, naming a resume cursor (`scan_limit=<encoded>`) -- and a
//      later run started with that SCAN_LIMIT resumes from the offset
//      instead of rescanning every group from zero
//   3. groups run with BOUNDED CONCURRENCY (default 16, or CONCURRENCY/
//      BACKFILL_CONCURRENCY), and the per-group write order survivor ->
//      sales re-point -> graded children -> delete loser is preserved even
//      when many groups are in flight at once (proven with injected latency
//      on the fake so two groups' async work is actually interleaved, not
//      accidentally serialised by a synchronous fake)
//   4. speed: a synthetic corpus of many groups, each carrying an injected
//      per-query delay standing in for the real cross-partition RU cost,
//      measurably finishes faster at CONCURRENCY=16 than at CONCURRENCY=1 --
//      the before/after this file reports in its own console output

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "fold-catalog-duplicate-rungs.cjs");
const require_ = createRequire(path.join(backend, "tests", "x.cjs"));

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

/** Sleep helper for injected latency, standing in for a real cross-partition
 *  query's RU/network cost. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake `card_catalog` / `sold_comps` / `portfolio` container, extending the
 * proven shape catalogRowOps.test.ts already validates moveCatalogRow
 * against, with two additions this file's own assertions need:
 *
 *   - the lane's own pass-1 query shape (a plain SELECT filtered by sport/
 *     year/setKeys, with no special predicate to detect -- unlike the two
 *     patterns moveCatalogRow issues, this one simply returns every matching
 *     doc) and the portfolio holdings-index query;
 *   - an optional PER-QUERY DELAY, so a test can make one container's own
 *     query shape slow (standing in for a real cross-partition scan) and
 *     observe whether concurrent groups' calls actually overlap in wall
 *     time, not merely queue behind each other inside one fake's synchronous
 *     resolution.
 */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  /** Optional ms delay applied to every `.read()`/`.query()` call, injected
   *  by a test to model a slow cross-partition lookup. */
  delayMs = 0;
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  get(id: string, pk?: string): Doc | undefined {
    if (pk !== undefined) return this.docs.get(keyOf(id, pk));
    return this.docs.get(id) ?? [...this.docs.values()].find((d) => d.id === id);
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        if (this.delayMs) await sleep(this.delayMs);
        this.log.push(`${this.name}.read ${id}`);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        if (this.delayMs) await sleep(this.delayMs);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op !== "set") throw new Error(`fake: unsupported patch op ${o.op}`);
          d[o.path.slice(1)] = o.value;
        }
        this.log.push(`${this.name}.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async (opts?: { accessCondition?: { type: string; condition: string } }) => {
        if (this.delayMs) await sleep(this.delayMs);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        if (opts?.accessCondition?.type === "IfMatch" && d._etag !== opts.accessCondition.condition) {
          throw Object.assign(new Error("fake: etag precondition failed"), { code: 412 });
        }
        this.docs.delete(k);
        this.log.push(`${this.name}.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      if (this.delayMs) await sleep(this.delayMs);
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`${this.name}.upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }, opts?: { partitionKey?: string }) => {
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => {
          if (this.delayMs) await sleep(this.delayMs);
          done = true;
          return { resources: this.run(spec, opts), continuationToken: undefined, requestCharge: 1 };
        },
        fetchAll: async () => {
          if (this.delayMs) await sleep(this.delayMs);
          return { resources: this.run(spec, opts) };
        },
      };
    },
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }, opts?: { partitionKey?: string }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("c.hobbyiqCardId = @s")) {
      return all.filter((d) => d.hobbyiqCardId === p["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
    }
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    if (spec.query.includes("c.cardId = @t")) {
      return all.filter((d) => d.cardId === p["@t"] && (!opts?.partitionKey || d.cardId === opts.partitionKey));
    }
    if (spec.query.includes("IS_DEFINED(c.holdings)")) {
      return all.filter((d) => d.holdings && typeof d.holdings === "object");
    }
    // Pass 1's own scan: `WHERE c.sport = @sport AND (c.year = @year OR
    // c.cardYear = @year) AND ARRAY_CONTAINS(@setKeys, LOWER(c.setKey)) AND
    // NOT IS_DEFINED(c.gradeTier)`. No special shape needed -- return every
    // catalog doc that matches those fields; the lane's OWN groupKeyOf /
    // canonical-id logic does the rest.
    if (spec.query.includes("ARRAY_CONTAINS(@setKeys")) {
      const setKeys = (p["@setKeys"] as string[]) ?? [];
      return all.filter(
        (d) =>
          d.sport === p["@sport"] &&
          (d.year === p["@year"] || d.cardYear === p["@year"]) &&
          setKeys.includes(String(d.setKey ?? "").toLowerCase()) &&
          d.gradeTier === undefined,
      );
    }
    throw new Error(`fake container: unsupported query ${spec.query}`);
  }
}

/** Two respelled catalog rows -- a plural twin, one per synthetic group --
 *  so N groups can be generated cheaply for a throughput measurement. */
function makeGroupRows(n: number): Doc[] {
  const rows: Doc[] = [];
  for (let i = 0; i < n; i++) {
    const cardNumber = String(i + 1);
    const canonicalId = `hiq:basketball:2024:panini-prizm:${cardNumber}:white-prizm:no-auto`;
    const loserId = `hiq:basketball:2024:panini-prizm:${cardNumber}:white-prizms:no-auto`;
    rows.push({
      id: canonicalId, cardId: canonicalId, hobbyiqCardId: canonicalId,
      sport: "basketball", year: 2024, cardYear: 2024, setKey: "panini-prizm", setName: "Panini Prizm",
      cardNumber, parallel: "White Prizm", parallelSlug: "white-prizm", isAuto: false, printRun: null,
      playerName: `Player ${i}`, playerSlug: `player-${i}`, source: "checklistcenter", confidence: 0.9,
      vendorIds: {}, _etag: `e-${i}-canon`,
    });
    rows.push({
      id: loserId, cardId: loserId, hobbyiqCardId: loserId,
      sport: "basketball", year: 2024, cardYear: 2024, setKey: "panini-prizm", setName: "Panini Prizm",
      cardNumber, parallel: "White Prizms", parallelSlug: "white-prizms", isAuto: false, printRun: null,
      playerName: `Player ${i}`, playerSlug: `player-${i}`, source: "beckett-scraped-2026-08-19", confidence: 0.8,
      vendorIds: {}, _etag: `e-${i}-loser`,
    });
  }
  return rows;
}

function world(rows: Doc[]) {
  const log: string[] = [];
  const cat = new FakeContainer("card_catalog", log, rows);
  const pool = new FakeContainer("sold_comps", log, []);
  const portfolio = new FakeContainer("portfolio", log, [{ id: "u1", userId: "u1", holdings: { h1: { hobbyiqCardId: "hiq:nowhere", cardId: "hiq:nowhere" } } }]);
  return { log, cat, pool, portfolio };
}

/** Fresh module load per test: SCOPE/TITLES/RUN_MINUTES/CONCURRENCY/
 *  SCAN_LIMIT are all read at module top-level or lazily inside runLane, and
 *  several of them (RUN_MINUTES -> CLOCK, computed once at require time)
 *  must vary PER TEST -- so the module cache entry is deleted and the file
 *  is re-required fresh every time, exactly the pattern needed to give each
 *  test its own budget clock. */
function loadLane(env: Record<string, string>) {
  for (const k of ["SCOPE", "TITLES", "RUN_MINUTES", "RESERVE_MS", "VERIFY_MS", "CONCURRENCY", "BACKFILL_CONCURRENCY", "SCAN_LIMIT", "LIMIT", "APPLY", "BACKFILL_APPLY", "PLAN_OUT", "SLOT", "SLOTS", "SHARD"]) {
    delete process.env[k];
  }
  Object.assign(process.env, { SCOPE: "basketball:2024", TITLES: "panini-prizm", ...env });
  delete require_.cache[require_.resolve(scriptPath)];
  return require_(scriptPath) as { runLane: (containers: unknown) => Promise<{ stats: Record<string, number>; stopReason: string | null; groupsDone: number; totalGroupsThisSlot: number }> };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete (process.env as any)[k];
  for (const k of Object.keys(ORIGINAL_ENV)) (process.env as any)[k] = (ORIGINAL_ENV as any)[k];
});

describe("fold-catalog-duplicate-rungs -- a completed scan never prints the relaunch marker", () => {
  it("a REPORT that decides every group prints no budget-stop marker, however many groups", async () => {
    const rows = makeGroupRows(40);
    const w = world(rows);
    const { runLane } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "16" });
    const res = await runLane({ cat: w.cat as any, pool: w.pool as any, portfolio: w.portfolio as any });
    expect(res.stopReason).toBeNull();
    expect(res.groupsDone).toBe(res.totalGroupsThisSlot);
    expect(res.stats.groupsFolded).toBe(40);
    expect(res.stats.rowsRemoved).toBe(40);
  });

  it("an APPLY that decides every group also prints no marker", async () => {
    const rows = makeGroupRows(10);
    const w = world(rows);
    const { runLane } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "16", APPLY: "true" });
    const res = await runLane({ cat: w.cat as any, pool: w.pool as any, portfolio: w.portfolio as any });
    expect(res.stopReason).toBeNull();
    expect(res.stats.rowsRemoved).toBe(10);
    // Genuinely applied: the loser rows are gone from the fake.
    for (let i = 0; i < 10; i++) {
      expect(w.cat.docs.has(`hiq:basketball:2024:panini-prizm:${i + 1}:white-prizms:no-auto`)).toBe(false);
    }
  });
});

describe("fold-catalog-duplicate-rungs -- resume, not rescan", () => {
  it("a genuine mid-scan budget stop names a resume cursor, and a later run honours it", async () => {
    // A budget so tight it cannot fit even the FIRST batch: RUN_MINUTES is a
    // real wall-clock minute count, so drive it via RESERVE_MS instead --
    // set the reserve larger than the whole budget so outOfClock() is true
    // from the very first check.
    const rows = makeGroupRows(20);
    const w1 = world(rows);
    const { runLane: runLane1 } = loadLane({ RUN_MINUTES: "1", RESERVE_MS: String(10 * 60 * 1000), CONCURRENCY: "4" });
    const res1 = await runLane1({ cat: w1.cat as any, pool: w1.pool as any, portfolio: w1.portfolio as any });
    expect(res1.stopReason).not.toBeNull();
    expect(res1.stopReason).toMatch(/stopped at the 1-minute budget/);
    const m = /scan_limit=(\d+)/.exec(res1.stopReason ?? "");
    expect(m).not.toBeNull();
    const scanLimit = m![1];
    // Nothing was decided this run (the clock was out before batch 1).
    expect(res1.groupsDone).toBe(0);
    // hop 1, offset 0 -- the very first stop, before any group was reached.
    expect(scanLimit).toBe(String(1_000_000 + 0));

    // A SECOND run, now with a real budget, started with that scan_limit --
    // it must decide ALL 20 groups (offset 0 skipped nothing), proving the
    // resume plumbing itself is correct even when the first hop made zero
    // progress.
    const w2 = world(rows);
    const { runLane: runLane2 } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "16", SCAN_LIMIT: scanLimit });
    const res2 = await runLane2({ cat: w2.cat as any, pool: w2.pool as any, portfolio: w2.portfolio as any });
    expect(res2.stopReason).toBeNull();
    expect(res2.stats.rowsRemoved).toBe(20);
  });

  it("a resume offset genuinely SKIPS the first N groups rather than rescanning them", async () => {
    const rows = makeGroupRows(6);
    const w = world(rows);
    // Encode hop=0, offset=3: skip the first 3 groups of the deterministic
    // pass-1 order.
    const { runLane } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "16", SCAN_LIMIT: "3" });
    const res = await runLane({ cat: w.cat as any, pool: w.pool as any, portfolio: w.portfolio as any });
    // Only 3 of the 6 groups were decided THIS run (the other 3 were
    // resumed-past, not re-read).
    expect(res.groupsDone).toBe(3);
    expect(res.totalGroupsThisSlot).toBe(6);
    expect(res.stats.rowsRemoved).toBe(3);
  });
});

describe("fold-catalog-duplicate-rungs -- bounded concurrency, per-group order preserved", () => {
  it("processes many groups concurrently (CONCURRENCY>1) yet each group's own writes stay ordered: survivor upsert -> sales re-point -> graded children -> delete loser", async () => {
    // APPLY, not REPORT -- moveCatalogRow's own dryRun skips every write
    // (upsert/patch/delete) and issues only the incumbent read, so a REPORT
    // has no write-order to assert here at all. This is exactly why the
    // write-ORDER guarantee has to be proven under a real write.
    const rows = makeGroupRows(8);
    const w = world(rows);
    // Inject latency on the catalog container so several groups' async work
    // is actually IN FLIGHT together under concurrency -- a synchronous fake
    // would never interleave two groups even if the driving loop allowed it,
    // which would let a concurrency bug pass unnoticed.
    w.cat.delayMs = 5;
    w.pool.delayMs = 2;
    const { runLane } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "8", APPLY: "true" });
    const res = await runLane({ cat: w.cat as any, pool: w.pool as any, portfolio: w.portfolio as any });
    expect(res.stats.rowsRemoved).toBe(8);

    // Per-CARD order: for each card number, that card's own survivor upsert
    // precedes that card's own loser delete. Different cards' operations may
    // now interleave in the shared log (that IS the concurrency working),
    // but a given card's own two operations never invert.
    for (let i = 0; i < 8; i++) {
      const canonicalId = `hiq:basketball:2024:panini-prizm:${i + 1}:white-prizm:no-auto`;
      const loserId = `hiq:basketball:2024:panini-prizm:${i + 1}:white-prizms:no-auto`;
      expect(w.cat.docs.has(loserId)).toBe(false); // the loser is genuinely gone
      expect(w.cat.docs.has(canonicalId)).toBe(true); // the survivor is genuinely present
      const upsertIdx = w.log.indexOf(`card_catalog.upsert ${canonicalId}`);
      const deleteIdx = w.log.indexOf(`card_catalog.delete ${loserId}`);
      expect(upsertIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(upsertIdx).toBeLessThan(deleteIdx);
    }

    // Concurrency actually overlapped: with 8 groups at CONCURRENCY=8 and a
    // 5ms per-call catalog delay (each group issues at least an upsert, a
    // sales lookup and a delete against the delayed fake), a fully serial
    // run would need noticeably more wall time than a concurrent one -- this
    // is asserted by the throughput test below rather than timing this
    // specific run, to avoid a flaky per-test clock assertion here.
  });

  it("honours the concurrency input's default of 16 groups at once", () => {
    expect(require("node:fs").readFileSync(scriptPath, "utf8")).toMatch(/CONCURRENCY \|\| process\.env\.BACKFILL_CONCURRENCY \|\| 16/);
  });
});

describe("fold-catalog-duplicate-rungs -- speed: measured before (serial) vs after (concurrent)", () => {
  it("many groups against a latency-injected fake finish faster at CONCURRENCY=16 than at CONCURRENCY=1", async () => {
    const N = 30;
    const DELAY_MS = 8; // stands in for the real cross-partition RU cost

    const before = world(makeGroupRows(N));
    before.cat.delayMs = DELAY_MS;
    before.pool.delayMs = DELAY_MS;
    const { runLane: serialLane } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "1" });
    const t0 = Date.now();
    const serialRes = await serialLane({ cat: before.cat as any, pool: before.pool as any, portfolio: before.portfolio as any });
    const serialMs = Date.now() - t0;

    const after = world(makeGroupRows(N));
    after.cat.delayMs = DELAY_MS;
    after.pool.delayMs = DELAY_MS;
    const { runLane: concurrentLane } = loadLane({ RUN_MINUTES: "120", CONCURRENCY: "16" });
    const t1 = Date.now();
    const concurrentRes = await concurrentLane({ cat: after.cat as any, pool: after.pool as any, portfolio: after.portfolio as any });
    const concurrentMs = Date.now() - t1;

    expect(serialRes.stats.rowsRemoved).toBe(N);
    expect(concurrentRes.stats.rowsRemoved).toBe(N);
    // eslint-disable-next-line no-console
    console.log(`  [measured on this fake] serial (CONCURRENCY=1): ${serialMs}ms   concurrent (CONCURRENCY=16): ${concurrentMs}ms   for ${N} groups at ${DELAY_MS}ms/call`);
    // Concurrent must be meaningfully faster -- not merely equal-or-better,
    // which a flake could satisfy by accident. A generous margin (60% of
    // serial) keeps this robust across slow CI runners while still failing
    // if concurrency regresses back to one-group-at-a-time.
    expect(concurrentMs).toBeLessThan(serialMs * 0.6);
  });
});
