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
  // CF-CH-THIN-COMP-FMV-CLEAR (2026-06-26): the canonical CH-last-sale
  // patch shape. lastSaleSurface PLUS the FMV-class clear fields PLUS
  // the model-signal clears (CF-CH-LAST-SALE-MODEL-EXPECTATION
  // 2026-06-26 — modelExpectation/modelSignal always set in the patch
  // so the writeback CLEARS any stale value from a prior reprice;
  // populated with validated values when the engine emitted them, null
  // when not). All positive-path tests assert the full shape with
  // toEqual — if any future change drops a clear field, these fail.
  const CANONICAL_CLEAR_FIELDS = {
    fairMarketValue: null,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateBasis: null,
    isEstimate: false,
    modelExpectation: null,
    modelSignal: null,
  };

  it("Hartman Blue X-Fractor /150 shape: returns lastSaleSurface with price/date/compCount + FMV-class clears", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-01" },
      chCompCount: 1,
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: "2026-06-01", compCount: 1 },
      ...CANONICAL_CLEAR_FIELDS,
    });
  });

  it("missing chCompCount → defaults to 1 (the canonical n==1 case)", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-01" },
    });
    expect(patch).toEqual({
      lastSaleSurface: { price: 450, date: "2026-06-01", compCount: 1 },
      ...CANONICAL_CLEAR_FIELDS,
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
      ...CANONICAL_CLEAR_FIELDS,
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
      ...CANONICAL_CLEAR_FIELDS,
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
      ...CANONICAL_CLEAR_FIELDS,
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
      ...CANONICAL_CLEAR_FIELDS,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-THIN-COMP-FMV-CLEAR — writeback semantics: the spread MUST clear
// a stale FMV that's already on the holding
// ─────────────────────────────────────────────────────────────────────────────

describe("buildChLastSalePatch — writeback semantics (CF-CH-THIN-COMP-FMV-CLEAR)", () => {
  it("THE PROD RESIDUE CASE: holding has fairMarketValue=8.5 from a prior sibling-rescue write; cardhedge-last-sale patch SPREAD clears it to null", () => {
    // This is the EXACT shape from 2026-06-26 19:03:34Z Cosmos: the
    // cardhedge-last-sale write surfaced lastSaleSurface correctly but
    // left fairMarketValue=8.5 residue from the 18:38Z sibling-pool
    // rescue write. iOS LIST view kept showing $8.50.
    const staleHolding = {
      id: "f6dccf27-8b17-4b73-8df4-bec96d90e2c6",
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: "b83de312-609d-4d58-af41-c8766a81835f",
      cardsightCardId: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
      isAuto: true,
      fairMarketValue: 8.5,            // ← the residue
      estimatedValue: null,
      estimateLow: null,
      estimateHigh: null,
      lastUpdated: "2026-06-26T18:38:55.000Z",
    };

    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
    });

    // The spread is what BOTH writeback sites do (autoPriceHolding's
    // fairValue<=0 abort + repriceHoldingsForUser's CH-last-sale branch):
    //   { ...holding, ...identityPatch, ...chLastSalePatch, lastUpdated }
    const merged = { ...staleHolding, ...patch };

    // POST-FIX: fairMarketValue is null (cleared). PRE-FIX: would still be 8.5.
    expect(merged.fairMarketValue).toBeNull();
    expect(merged.lastSaleSurface).toEqual({
      price: 450,
      date: "2026-06-19",
      compCount: 1,
    });
    // All FMV-class fields cleared:
    expect(merged.estimatedValue).toBeNull();
    expect(merged.estimateLow).toBeNull();
    expect(merged.estimateHigh).toBeNull();
    expect(merged.estimateBasis).toBeNull();
    expect(merged.isEstimate).toBe(false);
    // Identity fields preserved (the patch only touches FMV-class):
    expect(merged.cardsightCardId).toBe("befe9bcc-e7e8-458c-9cd8-ce831848b9a1");
    expect(merged.parallelId).toBe("b83de312-609d-4d58-af41-c8766a81835f");
    expect(merged.playerName).toBe("Eric Hartman");
  });

  it("ADDITIVE INVARIANT REASSERT: non-CH-last-sale holding with a real observed FMV → patch is {}, FMV untouched after spread", () => {
    // The load-bearing scope invariant: every other source returns {}
    // from buildChLastSalePatch. The spread is a no-op; the holding's
    // existing fairMarketValue stays intact. If the FMV-clear ever
    // bled to non-CH-last-sale sources, this test would fail.
    const observedHolding = {
      id: "test-observed-holding",
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      cardsightCardId: "fda530ab-e925-460e-ab88-63199ef975e9",
      fairMarketValue: 1250.5,
      valuationStatus: "observed" as const,
    };

    // Estimate has the OBSERVED FMV source, not cardhedge-last-sale.
    const patch = buildChLastSalePatch({
      estimateSource: "observed",
      lastSale: { price: 1240, soldDate: "2026-06-20" },
      chCompCount: null,
    });

    expect(patch).toEqual({});
    const merged = { ...observedHolding, ...patch };
    // FMV intact — the additive invariant holds. Spread of {} is no-op.
    expect(merged.fairMarketValue).toBe(1250.5);
    expect(merged.valuationStatus).toBe("observed");
    expect("lastSaleSurface" in merged).toBe(false);
  });

  it("ADDITIVE INVARIANT REASSERT: 'cardhedge' n>=2 (the legacy CH-thin source) → patch is {}, FMV untouched", () => {
    // CRITICAL SCOPE: the prior n>=2 CH source MUST NOT trigger the clear.
    // It takes the FMV success path (median of CH sales) — clearing FMV
    // here would null out the legitimate CH-served FMV.
    const chN2Holding = {
      id: "test-ch-n2-holding",
      playerName: "Eric Hartman",
      cardsightCardId: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
      fairMarketValue: 450,
      valuationStatus: "observed" as const,
    };

    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge",  // ← legacy n>=2 path, NOT cardhedge-last-sale
      lastSale: { price: 450, soldDate: "2026-06-20" },
      chCompCount: 3,
    });

    expect(patch).toEqual({});
    const merged = { ...chN2Holding, ...patch };
    expect(merged.fairMarketValue).toBe(450);  // ← legacy CH FMV intact
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26) — modelExpectation + modelSignal
// persistence + stale-clear semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("buildChLastSalePatch — modelExpectation + modelSignal persistence", () => {
  const validExpectation = {
    value: 266,
    range: [254, 278] as [number, number],
    multiplier: 2.974,
    multiplierRange: [2.214, 3.795] as [number, number],
    basis: "base_anchored_off_sample_paired_premium",
    n: 9,
    baseAutoMedian: 85.5,
    baseAutoCount: 20,
  };
  const validSignal = {
    lean: "sell" as const,
    deltaPct: 69.2,
    expectation: 266,
    effectiveMultiplier: 5.263,
  };

  it("engine response with valid modelExpectation + modelSignal → patch carries both verbatim", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
      modelExpectation: validExpectation,
      modelSignal: validSignal,
    });
    expect(patch.modelExpectation).toEqual(validExpectation);
    expect(patch.modelSignal).toEqual(validSignal);
    // Sanity: lastSaleSurface + clears still present.
    expect(patch.lastSaleSurface).toEqual({ price: 450, date: "2026-06-19", compCount: 1 });
    expect(patch.fairMarketValue).toBeNull();
  });

  it("STALE CLEAR — holding has prior modelExpectation/Signal; new patch with engine emitting nothing → patch SETS both to null (writeback clears)", () => {
    // Prior reprice landed modelSignal.lean="sell" on the holding. A
    // subsequent reprice (e.g. CH data updated, signal no longer computes)
    // emits estimateSource="cardhedge-last-sale" but WITHOUT model fields.
    // The patch must SET both to null so the spread CLEARS the stale
    // values — same pattern as the FMV-clear from CF-CH-THIN-COMP-FMV-CLEAR.
    const staleHolding = {
      id: "test-stale-model",
      cardsightCardId: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
      lastSaleSurface: { price: 380, date: "2026-06-10", compCount: 1 },
      modelExpectation: validExpectation,  // ← stale
      modelSignal: validSignal,            // ← stale
    };

    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
      // modelExpectation + modelSignal NOT present
    });

    // Patch explicitly sets BOTH to null.
    expect(patch.modelExpectation).toBeNull();
    expect(patch.modelSignal).toBeNull();

    // After the spread: stale values cleared.
    const merged = { ...staleHolding, ...patch };
    expect(merged.modelExpectation).toBeNull();
    expect(merged.modelSignal).toBeNull();
  });

  it("MALFORMED modelExpectation (missing required field) → null in patch (garbage rejected, stale cleared)", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
      modelExpectation: {
        value: 266,
        // range missing
        multiplier: 2.974,
      },
      modelSignal: validSignal,
    });
    expect(patch.modelExpectation).toBeNull();
    // Sibling field validated independently — signal still flows through.
    expect(patch.modelSignal).toEqual(validSignal);
  });

  it("MALFORMED modelSignal (invalid lean enum) → null in patch", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
      modelExpectation: validExpectation,
      modelSignal: { ...validSignal, lean: "moon" },  // ← invalid
    });
    expect(patch.modelExpectation).toEqual(validExpectation);
    expect(patch.modelSignal).toBeNull();
  });

  it("MALFORMED — NaN values rejected → null", () => {
    const patch = buildChLastSalePatch({
      estimateSource: "cardhedge-last-sale",
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
      modelExpectation: { ...validExpectation, value: NaN },
      modelSignal: { ...validSignal, deltaPct: NaN },
    });
    expect(patch.modelExpectation).toBeNull();
    expect(patch.modelSignal).toBeNull();
  });

  it("ADDITIVE INVARIANT REASSERT — non-CH-last-sale source with model fields in estimate → patch is {} (model fields IGNORED for non-CH-last-sale)", () => {
    // CRITICAL SCOPE GUARD: the early-return at estimateSource gate still
    // returns {} for every other source even if the engine response
    // somehow carried model fields. The model persistence is SCOPED to
    // cardhedge-last-sale only.
    const patch = buildChLastSalePatch({
      estimateSource: "observed",  // ← NOT cardhedge-last-sale
      lastSale: { price: 450, soldDate: "2026-06-19" },
      chCompCount: 1,
      modelExpectation: validExpectation,
      modelSignal: validSignal,
    });
    expect(patch).toEqual({});
  });
});
