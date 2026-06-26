/**
 * CF-CH-THIN-COMP-PRIMARY (2026-06-26) commit 2/2 —
 * buildChLastSalePatch invariants.
 *
 * The persistence-side fix bypasses the autoPriceHolding fairValue<=0
 * abort AND the repriceHoldingsForUser confidence/compsUsed/fairValue
 * gate when buildChLastSalePatch returns a NON-EMPTY object. So the
 * helper IS the scope predicate: returning {} preserves every existing
 * gate exactly as before. Returning a populated patch persists
 * lastSaleSurface and bumps the repriced counter.
 *
 * THIS FILE PINS THE BYPASS SCOPE — every non-cardhedge-last-sale input
 * MUST return {} so that:
 *   - normal CS-sourced holdings persist with their existing shape
 *   - variant-mismatch / no-recent-comps / low-confidence skips behave
 *     exactly as today (no lastSaleSurface written, no spurious
 *     reprice count)
 *   - n>=2 CH-served holdings ("cardhedge") follow the normal FMV path,
 *     not the new bypass
 *   - even MALFORMED CH-last-sale estimates (missing price, NaN price,
 *     negative price) return {} so we never persist garbage
 *
 * Returning a populated patch is locked to: estimateSource ===
 * "cardhedge-last-sale" AND a finite positive numeric lastSale.price.
 */
import { describe, expect, it } from "vitest";
import { buildChLastSalePatch } from "../src/services/portfolioiq/portfolioStore.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// ADDITIVE INVARIANT — {} for every non-cardhedge-last-sale source
// ─────────────────────────────────────────────────────────────────────────────

describe("buildChLastSalePatch — ADDITIVE INVARIANT: returns {} for every non-CH-last-sale source", () => {
  it("estimateSource === undefined → {} (the pre-CF default — observed/no-data/legacy)", () => {
    expect(buildChLastSalePatch({})).toEqual({});
  });

  it("estimateSource === null → {}", () => {
    expect(buildChLastSalePatch({ estimateSource: null })).toEqual({});
  });

  it("estimateSource === 'observed' (the FMV success path) → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "observed",
        lastSale: { price: 1250, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("estimateSource === 'cardhedge' (legacy CH-thin n>=2) → {}", () => {
    // CRITICAL: the legacy CH source must NOT trigger the bypass. Only
    // the new "cardhedge-last-sale" source does.
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge",
        lastSale: { price: 450, soldDate: "2026-06-20" },
        chCompCount: 3,
      }),
    ).toEqual({});
  });

  it("estimateSource === 'trend-extrapolated' → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "trend-extrapolated",
        lastSale: { price: 100, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("estimateSource === 'last-sale' (non-CH lastSale fallback) → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "last-sale",
        lastSale: { price: 100, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("estimate === null → {}", () => {
    expect(buildChLastSalePatch(null)).toEqual({});
  });

  it("estimate === undefined → {}", () => {
    expect(buildChLastSalePatch(undefined)).toEqual({});
  });

  it("estimate is a non-object (string, number) → {}", () => {
    expect(buildChLastSalePatch("not an object")).toEqual({});
    expect(buildChLastSalePatch(42)).toEqual({});
  });

  it("attacker-supplied estimateSource (arbitrary string) → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "evil-bogus-source",
        lastSale: { price: 999999, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GARBAGE-OUT REJECTION — {} when CH-last-sale but the surface is degenerate
// ─────────────────────────────────────────────────────────────────────────────

describe("buildChLastSalePatch — GARBAGE-OUT: returns {} on degenerate CH-last-sale shapes", () => {
  it("CH-last-sale + no lastSale → {}", () => {
    expect(
      buildChLastSalePatch({ estimateSource: "cardhedge-last-sale" }),
    ).toEqual({});
  });

  it("CH-last-sale + lastSale=null → {}", () => {
    expect(
      buildChLastSalePatch({ estimateSource: "cardhedge-last-sale", lastSale: null }),
    ).toEqual({});
  });

  it("CH-last-sale + lastSale.price missing → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge-last-sale",
        lastSale: { soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("CH-last-sale + price is non-numeric string → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge-last-sale",
        lastSale: { price: "450", soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("CH-last-sale + price is NaN → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge-last-sale",
        lastSale: { price: NaN, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("CH-last-sale + price is Infinity → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge-last-sale",
        lastSale: { price: Infinity, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("CH-last-sale + price is zero → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge-last-sale",
        lastSale: { price: 0, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });

  it("CH-last-sale + price is negative → {}", () => {
    expect(
      buildChLastSalePatch({
        estimateSource: "cardhedge-last-sale",
        lastSale: { price: -50, soldDate: "2026-06-20" },
      }),
    ).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE PATH — populated patch on the canonical CH-last-sale shape
// ─────────────────────────────────────────────────────────────────────────────

describe("buildChLastSalePatch — populated patch on canonical CH-last-sale shape", () => {
  it("Hartman Blue X-Fractor /150 shape: returns lastSaleSurface with price/date/compCount", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-01" },
      chCompCount: 1,
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: "2026-06-01", compCount: 1 },
    });
  });

  it("missing chCompCount → defaults to 1 (the canonical n==1 case)", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-01" },
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: "2026-06-01", compCount: 1 },
    });
  });

  it("missing soldDate → date is null (preserved, not coerced to empty string)", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450 },
      chCompCount: 1,
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: null, compCount: 1 },
    });
  });

  it("empty-string soldDate → date is null (cleaned)", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "" },
      chCompCount: 1,
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: null, compCount: 1 },
    });
  });

  it("whitespace-only soldDate → date is null", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "   " },
      chCompCount: 1,
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: null, compCount: 1 },
    });
  });

  it("non-integer chCompCount → floored to integer", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-01" },
      chCompCount: 2.9,
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: "2026-06-01", compCount: 2 },
    });
  });
});
