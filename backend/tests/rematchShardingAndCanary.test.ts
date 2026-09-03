/**
 * THE SHARD AXIS AND THE CANARY GATE.
 *
 * FLEET DISCIPLINE says the shard axis is GUARANTEED AND MEASURED before a
 * fleet runs, not assumed -- a slice that is not a slice runs the same rows
 * twice, and an unbalanced one leaves a runner working 6x as long as its
 * siblings while the budget marker fires on the wrong one.
 *
 * So this file asserts the two properties that make the axis real:
 *   PARTITION  every slot's units are disjoint, and together they cover the
 *              whole pool. A row belongs to exactly one slot.
 *   BALANCE    the measured spread stays tight, and no single unit is larger
 *              than an even share (which is what forced the sport and hash
 *              sub-axes in the first place).
 *
 * And the canary gate's own arithmetic: a pool that LOSES rows or loses a
 * PROTECTED row is a regression that stops the fleet; a pool that GAINS rows
 * is a mis-filed sale coming home, and passes.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Unit = { key: string; year: number | null; sportClass: string | null; hashPart: number | null; hashParts: number | null; rows: number };
type Table = {
  measuredAt: string; totalRows: number; evenShare: number; spread: string;
  minSlotRows: number; maxSlotRows: number; sportClasses: string[];
  slots: { slot: number; rows: number; units: Unit[] }[];
};
const table = JSON.parse(fs.readFileSync(path.join(backend, "data", "rematch-shard-table.json"), "utf8")) as Table;

type Fleet = {
  unitsForSlot: (slot: number, table?: Table) => Unit[];
  rowInSlot: (row: Record<string, unknown>, units: Unit[]) => boolean;
  slotQuery: (units: Unit[], years?: number[]) => { query: string; parameters: { name: string; value: unknown }[]; units: Unit[] } | null;
  hashPartOf: (id: string, parts: number) => number;
  SPORT_CLASSES: string[];
};
const fleet = require_(path.join(backend, "scripts", "rematch-sold-comps.cjs")) as Fleet;

type Canary = {
  poolInputs: (rows: Record<string, unknown>[]) => {
    rows: number; anchor: number | null; protectedRows: number; protectedIds: string[];
    newestAt: string | null; newestPrice: number | null;
  };
  compareCanary: (
    canary: Record<string, unknown>,
    before: ReturnType<Canary["poolInputs"]>,
    after: ReturnType<Canary["poolInputs"]>,
    tol?: number,
  ) => { ok: boolean; regressions: string[]; notes: string[] };
  median: (xs: number[]) => number | null;
};
const canary = require_(path.join(backend, "scripts", "rematch-canary-check.cjs")) as Canary;

describe("the shard axis is measured, and it is a real partition", () => {
  it("covers 16.3M rows across 32 slots", () => {
    expect(table.slots).toHaveLength(32);
    expect(table.totalRows).toBeGreaterThan(16_000_000);
    const summed = table.slots.reduce((a, s) => a + s.units.reduce((x, u) => x + u.rows, 0), 0);
    expect(summed).toBe(table.totalRows);
  });

  it("is BALANCED -- no slot works multiples of another's shift", () => {
    const rows = table.slots.map((s) => s.units.reduce((a, u) => a + u.rows, 0));
    const spread = Math.max(...rows) / Math.min(...rows);
    // Year alone gave 6.6x. The composite axis has to stay near 1.
    expect(spread).toBeLessThan(1.25);
  });

  it("no unit exceeds an even share -- that is WHY the sport and hash sub-axes exist", () => {
    const units = table.slots.flatMap((s) => s.units);
    // A little headroom: packing is on measured rows, and a hash part is an
    // estimate of a third of its unit.
    for (const u of units) expect(u.rows).toBeLessThanOrEqual(table.evenShare * 1.1);
  });

  it("the four heavy years carry a sport sub-axis, and 2025 baseball also a hash one", () => {
    const units = table.slots.flatMap((s) => s.units);
    for (const y of [2024, 2025, 2023, 2026]) {
      const forYear = units.filter((u) => u.year === y);
      expect(forYear.length).toBeGreaterThan(1);
      expect(forYear.every((u) => u.sportClass !== null)).toBe(true);
    }
    const bb2025 = units.filter((u) => u.year === 2025 && u.sportClass === "baseball");
    expect(bb2025.length).toBeGreaterThan(1);
    expect(bb2025.every((u) => (u.hashParts ?? 1) > 1)).toBe(true);
  });

  it("every row lands in EXACTLY ONE slot -- disjoint and total", () => {
    const allUnits = table.slots.map((_, i) => fleet.unitsForSlot(i, table));
    const rows = [
      { id: "a1", cardYear: 2025, sport: "baseball" },
      { id: "a2", cardYear: 2025, sport: "baseball" },
      { id: "a3", cardYear: 2025, sport: "baseball" },
      { id: "b1", cardYear: 2024, sport: "football" },
      { id: "c1", cardYear: 2026, sport: "pokemon" },
      { id: "d1", cardYear: 2023, sport: "hockey" },      // -> the "other" class
      { id: "e1", cardYear: 1993, sport: "basketball" },  // a light year rides whole
      { id: "f1", cardYear: 1971, sport: "baseball" },
      { id: "g1", cardYear: null, sport: "baseball" },    // explicit null -- 4,017 rows
      { id: "g2", sport: "baseball" },                    // no cardYear field -- 49 rows
      { id: "h1", cardYear: 2022, sport: "baseball" },
      { id: "i1", cardYear: 2024, sport: "baseball" },
      { id: "j1", cardYear: 2026, sport: "soccer" },
    ];
    for (const row of rows) {
      const hits = allUnits.filter((units) => fleet.rowInSlot(row, units));
      expect({ id: row.id, slots: hits.length }).toEqual({ id: row.id, slots: 1 });
    }
  });

  it("the two null-ish year populations are DISTINCT units, or two slots claim the same rows", () => {
    // Measured 2026-09-01: 49 rows carry no cardYear field at all, 4,017 carry
    // it as an explicit null. Cosmos needs two different predicates for them
    // (NOT IS_DEFINED vs IS_NULL). The first build of this table collapsed both
    // to `year: null` and TWO slots then matched the same rows -- caught by the
    // disjointness test above, which is why that test exists.
    const nullish = table.slots.flatMap((s) => s.units).filter((u) => u.year === null);
    expect(nullish).toHaveLength(2);
    expect(nullish.map((u) => (u as Unit & { yearKind: string }).yearKind).sort()).toEqual(["absent", "null"]);

    const absentUnits = nullish.filter((u) => (u as Unit & { yearKind: string }).yearKind === "absent");
    const nullUnits = nullish.filter((u) => (u as Unit & { yearKind: string }).yearKind === "null");
    // A row with no field belongs to `absent` and to nothing else...
    expect(fleet.rowInSlot({ id: "x" }, absentUnits)).toBe(true);
    expect(fleet.rowInSlot({ id: "x" }, nullUnits)).toBe(false);
    // ...and a row with an explicit null belongs to `null` and to nothing else.
    expect(fleet.rowInSlot({ id: "x", cardYear: null }, nullUnits)).toBe(true);
    expect(fleet.rowInSlot({ id: "x", cardYear: null }, absentUnits)).toBe(false);
  });

  it("a null year never coerces into the real `cardYear: 0` unit", () => {
    // `Number(null) === 0`, and the pool genuinely holds a y=0 unit (2 rows).
    // Without an explicit null/undefined check ahead of the numeric compare, a
    // null-year row matches y=0 as well as its own unit -- the second overlap
    // the disjointness test caught.
    const zero = table.slots.flatMap((s) => s.units).filter((u) => u.year === 0 && (u as Unit & { yearKind: string }).yearKind === "value");
    expect(zero).toHaveLength(1);
    expect(fleet.rowInSlot({ id: "x", cardYear: 0 }, zero)).toBe(true);
    expect(fleet.rowInSlot({ id: "x", cardYear: null }, zero)).toBe(false);
    expect(fleet.rowInSlot({ id: "x" }, zero)).toBe(false);
  });

  it("a heavy year's 'other' class takes the sports the named classes do not", () => {
    const units = table.slots.flatMap((s) => s.units).filter((u) => u.year === 2024 && u.sportClass === "other");
    expect(units.length).toBe(1);
    expect(fleet.rowInSlot({ id: "x", cardYear: 2024, sport: "hockey" }, units)).toBe(true);
    expect(fleet.rowInSlot({ id: "x", cardYear: 2024, sport: "baseball" }, units)).toBe(false);
    expect(fleet.rowInSlot({ id: "x", cardYear: 2024, sport: "football" }, units)).toBe(false);
  });

  it("the hash sub-axis splits a unit into disjoint, non-empty parts", () => {
    const parts = 3;
    const seen = new Map<number, number>();
    for (let i = 0; i < 900; i++) {
      const p = fleet.hashPartOf(`row-${i}`, parts);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(parts);
      seen.set(p, (seen.get(p) ?? 0) + 1);
    }
    expect(seen.size).toBe(parts);
    for (const n of seen.values()) expect(n).toBeGreaterThan(200); // roughly uniform
  });

  it("the slot query is parameterised and scopes to the slot's own units", () => {
    const units = fleet.unitsForSlot(0, table);
    const q = fleet.slotQuery(units, []);
    expect(q).not.toBeNull();
    expect(q!.query).toMatch(/^SELECT \* FROM c WHERE /);
    // No year is ever interpolated into the SQL text.
    expect(q!.query).not.toMatch(/cardYear = \d/);
    expect(q!.parameters.length).toBeGreaterThan(0);
  });

  it("a YEARS filter narrows the slot without reaching outside it", () => {
    const units = fleet.unitsForSlot(0, table);
    const year = units[0].year!;
    const q = fleet.slotQuery(units, [year]);
    expect(q!.units.every((u) => u.year === year)).toBe(true);
    // A year this slot does not own yields nothing at all -- a slot never
    // widens to cover another's rows.
    expect(fleet.slotQuery(units, [1854])).toBeNull();
  });
});

describe("the runner contract", () => {
  const runner = fs.readFileSync(path.resolve(backend, "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
  const script = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");

  it("both scripts are on the choice whitelist -- the two gates are two gates", () => {
    expect(runner).toContain("          - rematch-sold-comps");
    expect(runner).toContain("          - rematch-canary-check");
  });

  it("adds NO new workflow_dispatch inputs -- mode is the polymorphic selector", () => {
    const block = runner.slice(runner.indexOf("  workflow_dispatch:"), runner.indexOf("\npermissions:"));
    const inputs = block.match(/^ {6}[a-z_]+:$/gm) ?? [];
    // 24 of the 25 GitHub allows were already spent before this round.
    expect(inputs).toHaveLength(24);
    expect(block).toContain("      mode:");
  });

  it("the relaunch is gated on the BUDGET marker, and a LIMIT stop is not one", () => {
    // A killed job cannot report, so the script prints the marker under its own
    // clock -- and the relaunch greps for exactly that. A run that stopped
    // because the operator capped it with LIMIT has NOT run out of budget and
    // must not re-dispatch itself forever.
    const re = /stopped at the .*budget/;
    expect(re.test("stopped at the 140-minute budget")).toBe(true);
    expect(re.test("stopped at the LIMIT of 400 rows")).toBe(false);
    expect(script).toContain("stopped at the ${RUN_MINUTES}-minute budget");
    expect(runner).toContain('if grep -aqE "stopped at the .*budget" /tmp/backfill.log; then');
  });

  it("the relaunch forwards mode verbatim, and NEVER forwards apply=true", () => {
    const step = runner.slice(runner.indexOf("Self-relaunch rematch-sold-comps"));
    const dispatch = step.slice(0, step.indexOf("\n      - name:") + 1);
    expect(dispatch).toContain('-f mode="${{ inputs.mode }}"');
    expect(dispatch).toContain('-f slot="${{ inputs.slot }}"');
    expect(dispatch).toContain('-f slots="${{ inputs.slots }}"');

    // AMENDED 2026-09-03 (audit finding 5). `apply` used to be forwarded
    // verbatim, so an apply that stopped at its 140-minute budget re-dispatched
    // itself as ANOTHER APPLY -- onto a fresh runner with a fresh /tmp, where
    // the canary baseline captured by the first run no longer exists. The
    // continuation then wrote with no before-state and no gate. The gate was
    // skippable by being slow.
    //
    // The relaunch is now always a REPORT. A report relaunch still finishes
    // the shard's census (#1578); the apply is re-dispatched by hand, which
    // brings the before/apply/after triple back with it.
    expect(dispatch).toContain("-f apply=false");
    expect(dispatch).not.toContain('-f apply="${{ inputs.apply }}"');
  });

  it("the relaunch survives a banner that never says the re-key phrase (CF-CENSUS-THROUGHPUT)", () => {
    // MEASURED 2026-09-03. Every wave-1 census run stopped at its budget and
    // then FAILED to relaunch -- not because the marker was missing, but
    // because the line that reads the count out of the banner exited 1:
    //
    //   N=$(grep -aoE "(re-keyed|would re-key) +[0-9,]+" ... | tail -1)
    //
    // A census banner (MODE=census, READ ONLY) re-keys nothing and never
    // prints that phrase, so grep found no match and returned 1. GitHub runs
    // `shell: bash` as `bash -e -o pipefail`, so the step aborted on the
    // assignment and the dispatch below it never ran. The relaunch was dead
    // for exactly the mode that needs it most.
    //
    // N is a COURTESY NUMBER in a ::notice:: line. It must never be able to
    // decide whether the relaunch happens.
    const step = runner.slice(runner.indexOf("Self-relaunch rematch-sold-comps"));
    const body = step.slice(0, step.indexOf("\n      - name:") + 1);
    const assignment = body.split("\n").find((l) => l.trim().startsWith("N=$("));
    expect(assignment).toBeTruthy();
    expect(assignment).toContain("|| true");
    // and the value is still defaulted where it is read, so an empty N prints
    // as 0 rather than as nothing.
    expect(body).toContain("${N:-0}");
  });

  it("NO extraction pipeline in the runner can abort its own step", () => {
    // The same shape appears at every self-relaunch step in this workflow, and
    // every one of them is a step that MUST still dispatch when its phrase is
    // absent -- a report banner, a dry run, a job that changed nothing. One
    // unguarded pipeline is one silently dead relaunch, which is how this was
    // found in the first place.
    const unguarded = runner
      .split("\n")
      .map((l, i) => ({ l, n: i + 1 }))
      .filter((x) => /^\s*[A-Z_]+=\$\(grep /.test(x.l) && !x.l.includes("|| true"));
    expect(unguarded).toEqual([]);
  });

  it("MODE is required and has no default -- a defaulted mode is a silent census or a silent write", () => {
    expect(script).toContain('const MODE = String(process.env.MODE || "").trim();');
    expect(script).toMatch(/MODE is required and has no default/);
  });

  it("the census has no write path at all -- not even behind APPLY", () => {
    // mode=census returns before the apply block is ever reached.
    const censusReturn = script.indexOf('if (MODE === "census")');
    const relocate = script.indexOf("await relocateSoldComp(");
    expect(censusReturn).toBeGreaterThan(0);
    expect(relocate).toBeGreaterThan(censusReturn);
  });
});

describe("the canary gate", () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: "s1", cardId: "hiq:x", source: "cardhedge", price: 100, soldAt: "2026-08-01T00:00:00.000Z", ...over });
  const inputs = (rows: Record<string, unknown>[]) => canary.poolInputs(rows);
  const c = { name: "test", slug: "hiq:x" };

  it("the anchor is the leading edge -- the median of the NEWEST 3, not of the pool", () => {
    const rows = [
      row({ id: "n1", price: 300, soldAt: "2026-08-30T00:00:00.000Z" }),
      row({ id: "n2", price: 200, soldAt: "2026-08-29T00:00:00.000Z" }),
      row({ id: "n3", price: 250, soldAt: "2026-08-28T00:00:00.000Z" }),
      row({ id: "o1", price: 5, soldAt: "2026-01-01T00:00:00.000Z" }),
      row({ id: "o2", price: 5, soldAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const m = inputs(rows);
    expect(m.anchor).toBe(250);            // median(300, 200, 250)
    expect(m.newestPrice).toBe(300);
    expect(m.rows).toBe(5);
  });

  it("a pool that LOSES rows is a regression", () => {
    const before = inputs([row({ id: "a" }), row({ id: "b" })]);
    const after = inputs([row({ id: "a" })]);
    const v = canary.compareCanary(c, before, after);
    expect(v.ok).toBe(false);
    expect(v.regressions.join(" ")).toMatch(/LOST 1 row/);
  });

  it("a pool that GAINS rows PASSES -- a mis-filed sale coming home is the point", () => {
    const before = inputs([row({ id: "a" })]);
    const after = inputs([row({ id: "a" }), row({ id: "b", soldAt: "2026-08-01T00:00:00.000Z", price: 100 })]);
    const v = canary.compareCanary(c, before, after);
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toMatch(/gained 1 row/);
  });

  it("an EMPTIED pool is a regression -- three canaries hold a single sale", () => {
    const v = canary.compareCanary(c, inputs([row({ id: "a" })]), inputs([]));
    expect(v.ok).toBe(false);
    expect(v.regressions.join(" ")).toMatch(/EMPTY/);
  });

  it("a PROTECTED row leaving the pool is a regression, and it is named", () => {
    const prot = row({ id: "u1", source: "ebay-user-purchase" });
    const before = inputs([row({ id: "a" }), prot]);
    const after = inputs([row({ id: "a" }), row({ id: "filler" })]); // same count, protected gone
    const v = canary.compareCanary(c, before, after);
    expect(v.ok).toBe(false);
    expect(v.regressions.join(" ")).toMatch(/PROTECTED row left the pool/);
    expect(v.regressions.join(" ")).toContain("u1@hiq:x");
  });

  it("an anchor that jumps past tolerance is a regression; a small move is not", () => {
    const before = inputs([row({ id: "a", price: 100, soldAt: "2026-08-30T00:00:00.000Z" })]);
    const near = inputs([row({ id: "a", price: 105, soldAt: "2026-08-30T00:00:00.000Z" })]);
    const far = inputs([row({ id: "a", price: 400, soldAt: "2026-08-30T00:00:00.000Z" })]);
    expect(canary.compareCanary(c, before, near, 10).ok).toBe(true);
    const v = canary.compareCanary(c, before, far, 10);
    expect(v.ok).toBe(false);
    expect(v.regressions.join(" ")).toMatch(/anchor moved/);
  });
});

describe("the canary set itself", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(backend, "data", "rematch-canaries.json"), "utf8")) as {
    canaries: { name: string; holdingId?: string; slug: string; poolRows: number; verifiedMarketDirection: string; derivedFrom?: string; shardSlot?: number | null }[];
    _shardCoverage?: { of: number; covered: number; uncovered: number[] };
  };
  /** Drew's own, as distinct from the ones derive-rematch-canaries.cjs added. */
  const hand = doc.canaries.filter((c) => !c.derivedFrom);

  it("carries all seven hand-verified holdings with a slug and a verified direction", () => {
    // AMENDED 2026-09-03 (audit finding 6). The file used to hold exactly the
    // seven, and the gate is per-shard -- so the other 25 shards had nothing
    // that could regress and passed by construction. Slot 29, the 30/30-wrong
    // Tiffany shard, was one of them.
    //
    // The seven are still the seven, and this still pins every one of their
    // properties. What changed is that they are no longer the whole file.
    expect(hand).toHaveLength(7);
    for (const c of hand) {
      expect(c.slug).toMatch(/^hiq:/);
      expect(c.holdingId).toBeTruthy();
      expect(["exact-pool", "graded-from-raw"]).toContain(c.verifiedMarketDirection);
      expect(c.poolRows).toBeGreaterThan(0);
    }
  });

  it("gives EVERY shard a canary, so no shard passes the gate by construction", () => {
    const slots = new Set(doc.canaries.map((c) => c.shardSlot).filter((s) => s !== null && s !== undefined));
    for (let s = 0; s < 32; s++) expect(slots.has(s)).toBe(true);
    expect(doc._shardCoverage?.uncovered ?? []).toEqual([]);
  });

  it("labels every derived canary, so none is ever quoted as hand-verified", () => {
    for (const c of doc.canaries.filter((x) => x.derivedFrom)) {
      expect(["provenance", "largest-pool"]).toContain(c.derivedFrom);
      expect(c.poolRows).toBeGreaterThan(0);
      expect(c.slug).toMatch(/^hiq:/);
    }
  });

  it("includes the shapes the classifier tests pin", () => {
    const slugs = doc.canaries.map((c) => c.slug);
    expect(slugs).toContain("hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto");      // Verlander
    expect(slugs).toContain("hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499");   // Gonzalez
    expect(slugs).toContain("hiq:basketball:1993:topps-finest:99:refractor:no-auto");    // Shaq
  });
});
