// CF-PARALLEL-LADDER (Drew, 2026-07-17). Pinning tests for the pure
// ladder math: bucket → median → multiplier vs Base, confidence
// tiering, print-run parse.

import { describe, it, expect } from "vitest";
import {
  computeParallelLadder,
  classifyConfidence,
  parsePrintRunFromVariant,
  BASE_VARIANT,
  MIN_BASE_N,
  MIN_BUCKET_N,
} from "../src/services/portfolioiq/parallelLadderCompute.service.js";
import type { LocalCompSale } from "../src/types/localComp.types.js";

function mk(overrides: Partial<LocalCompSale>): LocalCompSale {
  return {
    priceHistoryId: `p-${Math.random().toString(36).slice(2)}`,
    cardId: "card-1",
    saleDate: "2026-07-01T12:00:00Z",
    price: 100,
    grade: "Raw",
    grader: "Raw",
    variant: BASE_VARIANT,
    saleType: "BIN",
    imageUrl: "",
    listingUrl: "",
    description: "",
    ...overrides,
  };
}

describe("parsePrintRunFromVariant", () => {
  it("parses '/N' anchor", () => {
    expect(parsePrintRunFromVariant("Gold /50")).toBe(50);
    expect(parsePrintRunFromVariant("Speckle Refractor /299")).toBe(299);
    expect(parsePrintRunFromVariant("Blue /150")).toBe(150);
  });

  it("parses '#/N' anchor", () => {
    expect(parsePrintRunFromVariant("Bowman LogoFractor #/35")).toBe(35);
  });

  it("parses 1/1 superfractor", () => {
    expect(parsePrintRunFromVariant("Superfractor 1/1")).toBe(1);
  });

  it("returns null for unnumbered variants", () => {
    expect(parsePrintRunFromVariant("Refractor")).toBeNull();
    expect(parsePrintRunFromVariant("Base")).toBeNull();
    expect(parsePrintRunFromVariant("")).toBeNull();
  });

  it("returns null for oversized print runs", () => {
    // 6-digit number won't match /N regex (bounded 1-5 digits)
    expect(parsePrintRunFromVariant("Bogus /100000")).toBeNull();
  });
});

describe("classifyConfidence", () => {
  it("high requires baseN >= 30 AND >= 5 non-Base variants", () => {
    expect(classifyConfidence(30, 5)).toBe("high");
    expect(classifyConfidence(50, 8)).toBe("high");
    expect(classifyConfidence(29, 5)).toBe("medium");
    expect(classifyConfidence(30, 4)).toBe("medium");
  });

  it("medium requires baseN >= 15 AND >= 3 non-Base variants", () => {
    expect(classifyConfidence(15, 3)).toBe("medium");
    expect(classifyConfidence(20, 4)).toBe("medium");
    expect(classifyConfidence(14, 3)).toBe("low");
    expect(classifyConfidence(15, 2)).toBe("low");
  });

  it("floor is low", () => {
    expect(classifyConfidence(5, 0)).toBe("low");
    expect(classifyConfidence(10, 1)).toBe("low");
  });
});

describe("computeParallelLadder — suppress cases", () => {
  it("no sales → null ladder, no_sales reason", () => {
    const r = computeParallelLadder([]);
    expect(r.ladder).toBeNull();
    expect(r.suppressedReason).toBe("no_sales");
  });

  it("Base under MIN_BASE_N → null ladder, base_thin reason", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < MIN_BASE_N - 1; i++) sales.push(mk({ price: 40 }));
    for (let i = 0; i < 5; i++) sales.push(mk({ variant: "Refractor", price: 120 }));
    const r = computeParallelLadder(sales);
    expect(r.ladder).toBeNull();
    expect(r.suppressedReason).toBe("base_thin");
  });

  it("all Base zero-price → suppresses (median <= 0)", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < MIN_BASE_N + 5; i++) sales.push(mk({ price: 0 })); // invalid
    for (let i = 0; i < 5; i++) sales.push(mk({ variant: "Refractor", price: 120 }));
    const r = computeParallelLadder(sales);
    expect(r.ladder).toBeNull();
    expect(r.suppressedReason).toBe("base_thin");
  });
});

describe("computeParallelLadder — happy path", () => {
  it("emits Base 1.0× first, sorts non-Base ASC by multiplier", () => {
    const sales: LocalCompSale[] = [];
    // Base median → 40
    for (const p of [30, 35, 40, 45, 50, 40]) sales.push(mk({ price: p }));
    // Refractor median → 120 (3.0×)
    for (const p of [110, 120, 130]) sales.push(mk({ variant: "Refractor", price: p }));
    // Gold /50 median → 280 (7.0×)
    for (const p of [260, 280, 300]) sales.push(mk({ variant: "Gold /50", price: p }));

    const r = computeParallelLadder(sales);
    expect(r.ladder).not.toBeNull();
    const ladder = r.ladder!.ladder;
    expect(ladder[0].variant).toBe("Base");
    expect(ladder[0].multiplier).toBe(1);
    expect(ladder[1].variant).toBe("Refractor");
    expect(ladder[1].multiplier).toBe(3);
    expect(ladder[2].variant).toBe("Gold /50");
    expect(ladder[2].multiplier).toBe(7);
    expect(ladder[2].printRun).toBe(50);
  });

  it("skips variants below MIN_BUCKET_N", () => {
    const sales: LocalCompSale[] = [];
    for (const p of [40, 40, 40, 40, 40]) sales.push(mk({ price: p }));
    for (const p of [500]) sales.push(mk({ variant: "Superfractor", price: p })); // n=1 → skip
    for (const p of [110, 120, 130]) sales.push(mk({ variant: "Refractor", price: p }));

    const r = computeParallelLadder(sales);
    expect(r.ladder).not.toBeNull();
    const variants = r.ladder!.ladder.map((rung) => rung.variant);
    expect(variants).toEqual(["Base", "Refractor"]);
  });

  it("filters out non-positive prices before bucketing", () => {
    const sales: LocalCompSale[] = [];
    for (const p of [40, 40, 40, 40, 40]) sales.push(mk({ price: p }));
    // Refractor: two valid + two invalid → n=2 → suppressed
    for (const p of [120, 130, 0, -5]) sales.push(mk({ variant: "Refractor", price: p }));
    const r = computeParallelLadder(sales);
    expect(r.ladder!.ladder.map((x) => x.variant)).toEqual(["Base"]);
  });

  it("uses medians (robust to outliers)", () => {
    const sales: LocalCompSale[] = [];
    // Base median → 40 (7 sales)
    for (const p of [40, 40, 40, 40, 40, 40, 40]) sales.push(mk({ price: p }));
    // Refractor median → 100 despite the 999 outlier (5 sales)
    for (const p of [100, 100, 100, 100, 999]) {
      sales.push(mk({ variant: "Refractor", price: p }));
    }
    const r = computeParallelLadder(sales);
    const refractor = r.ladder!.ladder.find((x) => x.variant === "Refractor")!;
    expect(refractor.medianPrice).toBe(100); // NOT mean pulled by 999
    expect(refractor.multiplier).toBe(2.5); // 100/40
  });

  it("assigns high confidence at 30+ base and 5+ non-Base variants", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 30; i++) sales.push(mk({ price: 40 }));
    const nonBase = ["Refractor", "Blue", "Gold", "Green", "Red"];
    for (const v of nonBase) {
      for (let i = 0; i < MIN_BUCKET_N; i++) sales.push(mk({ variant: v, price: 100 }));
    }
    const r = computeParallelLadder(sales);
    expect(r.ladder!.confidence).toBe("high");
  });

  it("assigns medium confidence at 15+ base and 3+ non-Base variants", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 15; i++) sales.push(mk({ price: 40 }));
    for (const v of ["Refractor", "Blue", "Gold"]) {
      for (let i = 0; i < MIN_BUCKET_N; i++) sales.push(mk({ variant: v, price: 100 }));
    }
    const r = computeParallelLadder(sales);
    expect(r.ladder!.confidence).toBe("medium");
  });

  it("assigns low confidence when just above publish gate", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < MIN_BASE_N; i++) sales.push(mk({ price: 40 }));
    for (let i = 0; i < MIN_BUCKET_N; i++) sales.push(mk({ variant: "Refractor", price: 100 }));
    const r = computeParallelLadder(sales);
    expect(r.ladder!.confidence).toBe("low");
  });

  it("parses printRun on ladder rungs (Base always null)", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk({ price: 40 }));
    for (let i = 0; i < 3; i++) sales.push(mk({ variant: "Speckle Refractor /299", price: 200 }));
    for (let i = 0; i < 3; i++) sales.push(mk({ variant: "Bowman LogoFractor #/35", price: 900 }));
    const r = computeParallelLadder(sales);
    const rungs = r.ladder!.ladder;
    expect(rungs[0].variant).toBe("Base");
    expect(rungs[0].printRun).toBeNull();
    const speckle = rungs.find((x) => x.variant === "Speckle Refractor /299")!;
    expect(speckle.printRun).toBe(299);
    const logo = rungs.find((x) => x.variant === "Bowman LogoFractor #/35")!;
    expect(logo.printRun).toBe(35);
  });

  it("normalizes empty variant string to 'Base'", () => {
    // Some legacy rows may have variant="" — bucket them under Base so
    // the anchor doesn't silently vanish.
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk({ variant: "", price: 40 }));
    for (let i = 0; i < 3; i++) sales.push(mk({ variant: "Refractor", price: 120 }));
    const r = computeParallelLadder(sales);
    expect(r.ladder!.ladder[0].variant).toBe("Base");
    expect(r.ladder!.ladder[0].n).toBe(5);
  });
});

describe("computeParallelLadder — pinned constants", () => {
  it("MIN_BASE_N is 5", () => {
    expect(MIN_BASE_N).toBe(5);
  });
  it("MIN_BUCKET_N is 3", () => {
    expect(MIN_BUCKET_N).toBe(3);
  });
  it("BASE_VARIANT is 'Base'", () => {
    expect(BASE_VARIANT).toBe("Base");
  });
});
