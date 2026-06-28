// CF-CH-PARALLEL-FILTER-BYPASS (2026-06-27) — pins the post-Cardsight
// behavior of filterRecordsByParallel.
//
// PRIOR-CF GAP: filters.ts was lifted to a "neutral, dependency-free"
// home in CF-FILTER-CONSOLIDATION (2026-06-10) with Cardsight's per-record
// `parallel_id` UUID assumed. The Cardsight removal sweeps (Wave 1-3)
// never updated the filter's semantics. Result: every CardHedge sale
// (which lacks parallel_id; CardHedge uses one card_id per parallel)
// failed the strict equality `undefined === "<uuid>"` → 0-comp
// fall-through → engine forced into Build B base × multiplier math
// even when 6+ direct parallel comps existed. Observable on Hartman
// Speckle Refractor /299 returning $22 (= base × 1.94×) when 6 real
// Speckle Refractor comps existed.
//
// THIS FILE PINS:
//   1. Cardsight-shape data still filters by strict UUID equality
//      (defensive — Cardsight is gone but the contract is unchanged).
//   2. CardHedge-shape data (no record has parallel_id) returns as-is
//      when a parallelId is requested — the records are already
//      cardId-scoped upstream.
//   3. Base-scope (parallelId absent) still keeps only base records.
//   4. Mixed input (some records with parallel_id, some without):
//      preserves the strict filter (cross-parallel bleed stays sealed).

import { describe, expect, it } from "vitest";
import { filterRecordsByParallel } from "../src/services/compiq/filters.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cardsight legacy shape — parallel_id UUID per record
// ─────────────────────────────────────────────────────────────────────────────

describe("filterRecordsByParallel — Cardsight legacy shape (parallel_id UUID per record)", () => {
  const uuidA = "11111111-1111-1111-1111-111111111111";
  const uuidB = "22222222-2222-2222-2222-222222222222";

  it("parallelId=uuidA → keep only records with parallel_id === uuidA", () => {
    const records = [
      { parallel_id: uuidA, price: 10 },
      { parallel_id: uuidB, price: 20 },
      { parallel_id: uuidA, price: 30 },
      { parallel_id: null, price: 40 },
    ];
    expect(filterRecordsByParallel(records, uuidA)).toEqual([
      { parallel_id: uuidA, price: 10 },
      { parallel_id: uuidA, price: 30 },
    ]);
  });

  it("parallelId=null → keep only records WITHOUT parallel_id (base only)", () => {
    const records = [
      { parallel_id: uuidA, price: 10 },
      { parallel_id: null, price: 40 },
      { parallel_id: undefined, price: 50 },
    ];
    expect(filterRecordsByParallel(records, null)).toEqual([
      { parallel_id: null, price: 40 },
      { parallel_id: undefined, price: 50 },
    ]);
  });

  it("parallelId=undefined behaves like null (base only)", () => {
    const records = [
      { parallel_id: uuidA, price: 10 },
      { parallel_id: null, price: 40 },
    ];
    expect(filterRecordsByParallel(records, undefined)).toEqual([
      { parallel_id: null, price: 40 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CardHedge shape — NO record carries parallel_id (THE BUG-FIX PATH)
// ─────────────────────────────────────────────────────────────────────────────

describe("filterRecordsByParallel — CardHedge shape (no record has parallel_id)", () => {
  const someUuid = "speckle-refractor-uuid-here";

  it("parallelId provided + records have no parallel_id → return ALL records (CardHedge bypass)", () => {
    // CardHedge sales: title + price + soldDate, no parallel_id field.
    // The 6-comp Hartman Speckle Refractor /299 case: every record lacks
    // parallel_id, the filter must pass them all through so the engine
    // can price on them directly instead of falling to Build B.
    const records = [
      { title: "Hartman Speckle Refractor Auto /299", price: 45 },
      { title: "Hartman Speckle Refractor Auto /299", price: 52 },
      { title: "Hartman Speckle Refractor Auto /299", price: 48 },
      { title: "Hartman Speckle Refractor Auto /299", price: 55 },
      { title: "Hartman Speckle Refractor Auto /299", price: 50 },
      { title: "Hartman Speckle Refractor Auto /299", price: 47 },
    ];
    const result = filterRecordsByParallel(
      records as Array<{ parallel_id?: string | null; title: string; price: number }>,
      someUuid,
    );
    expect(result).toHaveLength(6);
    expect(result.map((r) => r.price).sort()).toEqual([45, 47, 48, 50, 52, 55]);
  });

  it("parallelId provided + empty records → empty result (no records, no synthesis)", () => {
    expect(filterRecordsByParallel([], someUuid)).toEqual([]);
  });

  it("parallelId NOT provided + records have no parallel_id → return ALL records (base scope, CH bypass)", () => {
    // Base-scope query on CardHedge: filter keeps records where parallel_id
    // is null/undefined. Since no record has parallel_id, all pass.
    const records = [
      { title: "Hartman 2026 Bowman Chrome Auto", price: 11 },
      { title: "Hartman 2026 Bowman Chrome Auto", price: 12 },
    ];
    const result = filterRecordsByParallel(
      records as Array<{ parallel_id?: string | null; title: string; price: number }>,
      null,
    );
    expect(result).toEqual(records);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Mixed shape (paranoid invariant — both Cardsight and CH records)
// ─────────────────────────────────────────────────────────────────────────────

describe("filterRecordsByParallel — mixed shape (defensive: some records have parallel_id)", () => {
  const uuidA = "11111111-1111-1111-1111-111111111111";

  it("ANY record having parallel_id → strict filter applies (cross-parallel bleed stays sealed)", () => {
    // Even one record with parallel_id is enough to switch back to
    // strict-filter mode; we don't want a mostly-CH pool with one stray
    // Cardsight-tagged record to silently lose its scoping.
    const records = [
      { parallel_id: uuidA, price: 100 },
      { price: 999 } as { parallel_id?: string | null; price: number }, // CH-shape
    ];
    expect(filterRecordsByParallel(records, uuidA)).toEqual([
      { parallel_id: uuidA, price: 100 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Immutability invariant — function never mutates input
// ─────────────────────────────────────────────────────────────────────────────

describe("filterRecordsByParallel — input immutability", () => {
  it("CardHedge bypass returns a NEW array (not the input reference)", () => {
    const records = [
      { title: "comp1", price: 10 },
      { title: "comp2", price: 20 },
    ] as Array<{ parallel_id?: string | null; title: string; price: number }>;
    const result = filterRecordsByParallel(records, "some-uuid");
    expect(result).toEqual(records);
    expect(result).not.toBe(records); // distinct array reference
  });
});
