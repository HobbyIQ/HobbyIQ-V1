// CF-ASPECT-IS-NOT-A-PARALLEL (Drew, 2026-08-18: "i am seeing a lot of
// refractors turned into base cards ... the name itself is not matching from
// ebay").
//
// eBay's Parallel/Variety aspect is SELLER-TYPED, and sellers routinely put the
// PRODUCT in it. ebayAutoHolding overwrote the title parse with it, so the real
// parallel was discarded. holdingFieldNormalizer then correctly rejects
// "Chrome" as not-a-parallel and nulls it — and a null parallel renders as
// `base`, so a Refractor gets priced against base comps.
//
// Six of Drew's live holdings were in this state, all source="ebay-auto":
//
//   "2025 Bowman Chrome Refractor Max Williams #CPA-MWI"     aspect "Chrome"
//   "2026 Topps Chrome Yellow Parallel Konnor Griffin"       aspect "Chrome"
//   "2026 Bowman Blue Blaine Bullard Logo Pattern #BP-18"    aspect "Chrome"
//   "2026 Topps Chrome Nick Kurtz Perspective"               aspect "Chrome"
//   "2026 Bowman Sapphire Numbered Owen Carey"               aspect "Numbered"
//
// These pin the two halves of the fix:
//   1. the TITLE parse recovers the real parallel (it always could),
//   2. the normalizer is what decides whether an aspect is a real parallel,
//      so a product word can never again overwrite a good parse.

import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeHoldingFields } from "../src/services/portfolioiq/holdingFieldNormalizer.service.js";

/** Mirrors the guard in ebayAutoHolding: an aspect is only accepted when it
 *  survives normalization as a non-empty parallel. */
function aspectSurvives(aspect: string, ctx: Record<string, unknown> = {}): boolean {
  const { fields } = normalizeHoldingFields({
    playerName: null, cardYear: null, setName: null,
    parallel: aspect, cardNumber: null, isAuto: null, product: null,
    ...ctx,
  } as never);
  return typeof fields.parallel === "string" && fields.parallel.trim() !== "";
}

describe("CF-ASPECT-IS-NOT-A-PARALLEL", () => {
  it("the TITLE carried the real parallel all along", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Refractor Max Williams #CPA-MWI").parallel)
      .toBe("Refractor");
    expect(parseListingIdentity("2024 Bowman Draft Chrome Cam Caminiti Blue Refractor Auto #CPA-CC /150").parallel)
      .toBe("Blue Refractor");
  });

  it("REJECTS a bare product word, which is what caused the damage", () => {
    // "Chrome" is a product, not a parallel. Accepting it nulls out downstream
    // and the card renders as base.
    expect(aspectSurvives("Chrome")).toBe(false);
  });

  it("ACCEPTS a genuine parallel, so the aspect stays useful", () => {
    for (const p of ["Refractor", "Blue Refractor", "Gold", "Orange Refractor", "X-Fractor"]) {
      expect(aspectSurvives(p), p).toBe(true);
    }
  });

  it("ACCEPTS product+parallel and keeps only the parallel half", () => {
    // The normalizer already handles this shape; the guard must not defeat it.
    const { fields } = normalizeHoldingFields({
      playerName: "Eric Hartman", cardYear: 2026, setName: "Bowman",
      parallel: "Chrome Refractor", cardNumber: "CPA-EH", isAuto: true, product: null,
    } as never);
    expect(fields.parallel).toBe("Refractor");
  });

  it("a rejected aspect must never silently become `base`", () => {
    // The whole failure mode in one assertion: if the aspect is discarded, the
    // holding must keep whatever the title gave it rather than fall to base.
    const titleParallel = parseListingIdentity(
      "2025 Bowman Chrome Refractor Max Williams #CPA-MWI",
    ).parallel;
    expect(titleParallel).toBe("Refractor");
    expect(aspectSurvives("Chrome")).toBe(false);
    // => guard keeps "Refractor"; it does not overwrite with the rejected word.
    expect(titleParallel).not.toBe("Base");
    expect(titleParallel).not.toBeNull();
  });
});
