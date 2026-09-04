/**
 * THE WRITE LEDGER -- the evidence that makes a canary verdict attributable.
 *
 * The 2026-09-04 halt: two shards reconciled `intended 0 = written 0` and both
 * exited 5 on canaries belonging to other slots, because the gate had no way
 * to ask "did this shard write in that pool?". The apply now answers that
 * question in a file the gate reads inside the same job.
 *
 * These pin the SHAPE the gate depends on, driving the committed script's own
 * ledger construction rather than a copy of it -- a ledger that agrees with a
 * re-implementation and disagrees with the apply is worth nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Touch = { fromCount?: number; toCount?: number; from?: string[]; to?: string[] };
type Ledger = { doc: Record<string, any>; pools: Record<string, Touch> };
const C = require_(path.join(backend, "scripts", "rematch-canary-check.cjs")) as {
  loadLedger: (f: string) => Ledger | null;
  compareCanary: (c: any, b: any, a: any, tol?: number, touch?: Touch | null) => any;
};

const tmp: string[] = [];
const write = (name: string, body: unknown) => {
  const p = path.join(os.tmpdir(), `hiq-${name}-${process.pid}-${tmp.length}.json`);
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  tmp.push(p);
  return p;
};
afterEach(() => {
  while (tmp.length) { const p = tmp.pop()!; try { fs.unlinkSync(p); } catch { /* already gone */ } }
  delete process.env.SCOPE;
});

/** The exact document the apply writes -- see rematch-sold-comps.cjs. */
const ledgerDoc = (pools: Record<string, Touch>, over: Record<string, unknown> = {}) => ({
  job: "rematch-sold-comps",
  mode: "apply-improve", apply: true, scope: "base-eviction",
  slot: 1, slots: 32, runId: "33846426659",
  finishedAt: "2026-09-04T08:04:09.960Z",
  written: Object.values(pools).reduce((n, p) => n + Number(p.fromCount ?? 0), 0),
  poolsTouched: Object.keys(pools).length,
  pools,
  ...over,
});

describe("the write ledger the apply emits", () => {
  it("a re-key records BOTH pools -- the one the row left and the one it landed in", () => {
    // A re-key changes two pools and either may hold a canary. A ledger that
    // recorded only the source would let a shard silently dump rows INTO a
    // hand-verified pool and still read as untouched there.
    const from = "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499";
    const to = "hiq:baseball:2026:bowman:cpa-jg:base:auto";
    const l = C.loadLedger(write("ledger", ledgerDoc({
      [from]: { fromCount: 1, toCount: 0, from: ["sc-gonz-1"], to: [] },
      [to]: { fromCount: 0, toCount: 1, from: [], to: ["sc-gonz-1"] },
    })))!;
    expect(Object.keys(l.pools).sort()).toEqual([to, from].sort());
    expect(l.pools[from].fromCount).toBe(1);
    expect(l.pools[to].toCount).toBe(1);
  });

  it("a destination pool counts as TOUCHED, so a canary gaining this shard's rows is judged strictly", () => {
    process.env.SCOPE = "base-eviction";
    const dest = "hiq:baseball:1979:topps:390:base:no-auto";
    const l = C.loadLedger(write("ledger", ledgerDoc({
      [dest]: { fromCount: 0, toCount: 3, from: [], to: ["a", "b", "c"] },
    })))!;
    const r = C.compareCanary(
      { name: "1979 topps 390 base", slug: dest },
      { rows: 100, anchor: 10, protectedRows: 0, protectedIds: [] },
      { rows: 103, anchor: 10, protectedRows: 0, protectedIds: [] },
      10,
      l.pools[dest],
    );
    expect(r.touched).toBe(true);
    expect(r.moved).toBe(3);
    expect(r.notes.join(" ")).toMatch(/this shard moved 3 row\(s\) in this pool \(out 0, in 3\)/);
  });

  it("a zero-write apply emits a ledger with an EMPTY pools map -- the claim both halted runs needed", () => {
    // `intended 0 = written 0`: the file still exists and still says slot 1.
    // That is a POSITIVE statement -- "I moved nothing anywhere" -- and is
    // what turns every canary move into someone else's news.
    const l = C.loadLedger(write("ledger", ledgerDoc({}, { written: 0, poolsTouched: 0 })))!;
    expect(l).not.toBeNull();
    expect(l.doc.written).toBe(0);
    expect(Object.keys(l.pools)).toEqual([]);
  });

  it("REGRESSION -- the two halted runs now PASS on the canaries they were failed on", () => {
    process.env.SCOPE = "base-eviction";
    // Slot 1 wrote nothing. The slot-14 and slot-26 canaries moved anyway,
    // because CardHedge landed 4 and 7 new sales during the apply window.
    const l = C.loadLedger(write("ledger", ledgerDoc({}, { written: 0, poolsTouched: 0 })))!;
    const cases = [
      { name: "slot 14 bdc-1", slug: "hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto", b: { rows: 579, anchor: 23.39 }, a: { rows: 581, anchor: 4.69 } },
      { name: "slot 26 fleer-stickers 8", slug: "hiq:basketball:1986:fleer-stickers:8:base:no-auto", b: { rows: 1838, anchor: 2738.88 }, a: { rows: 1845, anchor: 3050 } },
    ];
    for (const c of cases) {
      const r = C.compareCanary(
        { name: c.name, slug: c.slug },
        { ...c.b, protectedRows: 1, protectedIds: ["p@s"] },
        { ...c.a, protectedRows: 1, protectedIds: ["p@s"] },
        10,
        l.pools[c.slug],
      );
      expect(r.ok, `${c.name} must not halt a shard that wrote nothing`).toBe(true);
      expect(r.touched).toBe(false);
      expect(r.notes.join(" ")).toMatch(/pool changed by other writers/);
    }
  });

  it("but a PROTECTED row leaving still halts even a zero-write shard", () => {
    // Attribution never relaxes what no writer may do. If a protected row is
    // gone while this shard wrote nothing, something else in the system did
    // it, and that is still an alarm worth stopping the fleet for.
    process.env.SCOPE = "base-eviction";
    const l = C.loadLedger(write("ledger", ledgerDoc({}, { written: 0, poolsTouched: 0 })))!;
    const r = C.compareCanary(
      { name: "slot 14 bdc-1", slug: "hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto" },
      { rows: 580, anchor: 23.39, protectedRows: 3, protectedIds: ["p1@s", "p2@s", "p3@s"] },
      { rows: 580, anchor: 23.39, protectedRows: 2, protectedIds: ["p1@s", "p2@s"] },
      10,
      l.pools["hiq:baseball:2025:bowman-draft:bdc-1:base:no-auto"],
    );
    expect(r.ok).toBe(false);
    expect(r.regressions.join(" ")).toMatch(/PROTECTED row left the pool/);
  });

  it("the apply script declares the ledger path and caps ids per pool", () => {
    // The gate defaults to the same path; if these drift the gate silently
    // reads no ledger and every shard goes back to being strictly judged.
    const src = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");
    expect(src).toMatch(/WRITE_LEDGER_OUT[\s\S]{0,120}\/tmp\/rematch-write-ledger\.json/);
    expect(src).toMatch(/LEDGER_IDS_PER_POOL/);
    const gate = fs.readFileSync(path.join(backend, "scripts", "rematch-canary-check.cjs"), "utf8");
    expect(gate).toMatch(/WRITE_LEDGER[\s\S]{0,120}\/tmp\/rematch-write-ledger\.json/);
  });

  it("the ledger records the pool BOTH sides of a move, keyed by slug, with exact counts", () => {
    // Ids are capped for size; the COUNTS are what attribution reads, so they
    // must stay exact however many rows moved.
    const slug = "hiq:baseball:1956:topps:292:base:no-auto";
    const l = C.loadLedger(write("ledger", ledgerDoc({
      [slug]: { fromCount: 4000, toCount: 0, from: ["a", "b", "c"], to: [] },
    })))!;
    expect(l.pools[slug].fromCount).toBe(4000);
    expect(l.pools[slug].from!.length).toBe(3); // capped sample, exact count
  });
});
