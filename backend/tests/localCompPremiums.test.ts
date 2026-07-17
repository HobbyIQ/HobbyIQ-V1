// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Pinning tests for grader
// + parallel premium curves.

import { describe, it, expect } from "vitest";
import {
  computeGraderPremiums,
  computeParallelPremiums,
  _MIN_BUCKET_N,
} from "../src/services/portfolioiq/localCompPremiums.service.js";
import type { LocalCompSale } from "../src/types/localComp.types.js";

function mk(overrides: Partial<LocalCompSale>): LocalCompSale {
  return {
    priceHistoryId: `p-${Math.random().toString(36).slice(2)}`,
    cardId: "card-1",
    saleDate: "2026-07-01T12:00:00Z",
    price: 100,
    grade: "Raw",
    grader: "Raw",
    variant: "Base",
    saleType: "BIN",
    imageUrl: "",
    listingUrl: "",
    description: "",
    ...overrides,
  };
}

describe("computeGraderPremiums", () => {
  it("returns empty object when only 1 grader present", () => {
    const sales = [mk({ price: 10 }), mk({ price: 12 }), mk({ price: 15 })];
    // baseline exists but no other buckets → still returns the baseline entry
    const p = computeGraderPremiums(sales);
    expect(p.Raw).toBeDefined();
    expect(p.Raw.multiplierVsBaseline).toBe(1);
  });

  it("skips buckets under MIN_BUCKET_N", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk({ price: 10 })); // Raw x5
    for (let i = 0; i < 2; i++) sales.push(mk({ grader: "PSA", grade: "PSA 10", price: 100 })); // only 2 — skip
    const p = computeGraderPremiums(sales);
    expect(p.Raw).toBeDefined();
    expect(p["PSA"]).toBeUndefined();
  });

  it("computes multiplier vs Raw baseline correctly", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk({ price: 10 })); // Raw mean=10
    for (let i = 0; i < 5; i++) sales.push(mk({ grader: "PSA", grade: "PSA 10", price: 40 })); // mean=40 → 4x
    for (let i = 0; i < 5; i++) sales.push(mk({ grader: "PSA", grade: "PSA 9", price: 20 })); // mean=20 → 2x
    const p = computeGraderPremiums(sales);
    expect(p.Raw.multiplierVsBaseline).toBe(1);
    expect(p["PSA"].multiplierVsBaseline).toBe(3); // (40+40+40+40+40+20+20+20+20+20)/10 = 30 → 3x
  });

  it("emits 0 multiplier when baseline (Raw) bucket is absent", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk({ grader: "PSA", grade: "PSA 10", price: 40 }));
    for (let i = 0; i < 5; i++) sales.push(mk({ grader: "BGS", grade: "BGS 9.5", price: 80 }));
    const p = computeGraderPremiums(sales);
    expect(p.Raw).toBeUndefined();
    expect(p["PSA"].multiplierVsBaseline).toBe(0);
    expect(p["BGS"].multiplierVsBaseline).toBe(0);
  });

  it("filters out non-positive prices", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk({ price: 10 })); // valid raw
    sales.push(mk({ grader: "PSA", grade: "PSA 10", price: 0 }));
    sales.push(mk({ grader: "PSA", grade: "PSA 10", price: -5 }));
    sales.push(mk({ grader: "PSA", grade: "PSA 10", price: 40 }));
    const p = computeGraderPremiums(sales);
    expect(p["PSA"]).toBeUndefined(); // only 1 valid PSA sale — below MIN_BUCKET_N
  });
});

describe("computeParallelPremiums", () => {
  it("computes variant multipliers vs Base", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 4; i++) sales.push(mk({ variant: "Base", price: 5 }));
    for (let i = 0; i < 4; i++) sales.push(mk({ variant: "Refractor", price: 25 }));
    for (let i = 0; i < 4; i++) sales.push(mk({ variant: "Gold", price: 100 }));
    const p = computeParallelPremiums(sales);
    expect(p.Base.multiplierVsBaseline).toBe(1);
    expect(p["Refractor"].multiplierVsBaseline).toBe(5);
    expect(p["Gold"].multiplierVsBaseline).toBe(20);
  });

  it("respects MIN_BUCKET_N", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 4; i++) sales.push(mk({ variant: "Base", price: 5 }));
    sales.push(mk({ variant: "Superfractor", price: 5000 })); // n=1
    const p = computeParallelPremiums(sales);
    expect(p["Superfractor"]).toBeUndefined();
    expect(p.Base).toBeDefined();
  });

  it("pinned MIN_BUCKET_N constant", () => {
    expect(_MIN_BUCKET_N).toBe(3);
  });
});
