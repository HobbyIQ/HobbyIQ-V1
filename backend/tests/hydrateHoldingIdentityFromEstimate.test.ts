// CF-IDENTITY-HYDRATION (2026-06-18): unit tests for
// hydrateHoldingIdentityFromEstimate, the pure helper that backfills
// identity fields on a holding from the engine's resolved Cardsight
// catalog identity.
//
// Live shape reference (probed against the deployed dist at 2026-06-18):
//   estimate.cardIdentity = {
//     card_id, title, player, set (subset name, e.g. "Base Set"),
//     release (product line, e.g. "Topps Update"), year (number),
//     number, variant
//   }

import { describe, it, expect } from "vitest";
import { hydrateHoldingIdentityFromEstimate } from "../src/services/portfolioiq/portfolioStore.service.js";

const TROUT_PINNED_ID = "fda530ab-e925-460e-ab88-63199ef975e9";
const HARTMAN_PINNED_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";

// Real shapes captured from live engine probe.
const TROUT_CARDIDENTITY = {
  card_id: TROUT_PINNED_ID,
  title: "Mike Trout",
  player: "Mike Trout",
  set: "Base Set",
  release: "Topps Update",
  year: 2011,
  number: "US175",
  variant: null,
};

const HARTMAN_CARDIDENTITY = {
  card_id: HARTMAN_PINNED_ID,
  title: "Eric Hartman",
  player: "Eric Hartman",
  set: "Chrome Prospects Autographs",
  release: "Bowman",
  year: 2026,
  number: "CPA-EHA",
  variant: null,
};

describe("hydrateHoldingIdentityFromEstimate", () => {
  // ── Test 1 — Trout sparse case ────────────────────────────────────────────
  it("Trout-sparse pinned holding → fills cardYear/setName/product/cardNumber + isAuto:false", () => {
    // Real Drew's Trout shape from Cosmos (2026-06-18 canary read).
    const holding: any = {
      id: "d3b35b59-7d0d-493b-a837-2bc56524ff30",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
      quantity: 1,
      fairMarketValue: 331,
      // ALL identity fields undefined.
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);

    expect(patch).toEqual({
      cardYear: 2011,
      setName: "Base Set",
      product: "Topps Update",
      cardNumber: "US175",
      isAuto: false, // catalog signals no auto (base subset, US- prefix)
    });
  });

  // ── Test 2 — Hartman sparse + manual parallel ─────────────────────────────
  it("Hartman-sparse pinned holding with manual parallel → fills 5 identity fields; parallel/parallelId untouched", () => {
    // Real Drew's Hartman shape from Cosmos.
    const holding: any = {
      id: "d0e61670-1234-5678-9abc-def012345678",
      playerName: "Eric Hartman",
      cardsightCardId: HARTMAN_PINNED_ID,
      parallel: "Blue X-Fractor /150",                              // user-entered
      parallelId: "b83de312-609d-4d58-af41-c8766a81835f",           // system-set
      quantity: 1,
      // ALL other identity fields undefined.
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, HARTMAN_CARDIDENTITY);

    expect(patch).toEqual({
      cardYear: 2026,
      setName: "Chrome Prospects Autographs",
      product: "Bowman",                                            // LITERAL release
      cardNumber: "CPA-EHA",
      isAuto: true,                                                 // "Autographs" in setName triggers heuristic
    });
    // Critically: parallel + parallelId NOT in the patch — preserved verbatim.
    expect(patch).not.toHaveProperty("parallel");
    expect(patch).not.toHaveProperty("parallelId");
  });

  // ── Test 3 — manual override is preserved ─────────────────────────────────
  it("manually-set cardYear is preserved (fill-if-empty: filled fields are not overwritten)", () => {
    const holding: any = {
      id: "h-manual",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
      cardYear: 2010,                                               // INTENTIONALLY wrong by user (manual override)
      setName: "Custom Hand-Cut",                                   // also manual
      // product / cardNumber undefined
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);

    expect(patch).not.toHaveProperty("cardYear");                   // user value preserved
    expect(patch).not.toHaveProperty("setName");                    // user value preserved
    expect(patch.product).toBe("Topps Update");                     // empty field filled
    expect(patch.cardNumber).toBe("US175");                         // empty field filled
    expect(patch.isAuto).toBe(false);
  });

  // ── Test 4 — unpinned holding ─────────────────────────────────────────────
  it("unpinned holding (no cardsightCardId) → helper no-op even with rich cardIdentity", () => {
    const holding: any = {
      id: "h-unpinned",
      playerName: "Paul Skenes",
      cardYear: 2024,
      // NO cardsightCardId
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);
    expect(patch).toEqual({});
  });

  it("pinned holding but engine's resolved card_id mismatches → no-op (vendor flap protection)", () => {
    const holding: any = {
      id: "h-flap",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
    };
    // Engine resolved a DIFFERENT card_id (the consistency guard at
    // compiqEstimate.service.ts:1310 usually catches this with a stub
    // identity, but defense-in-depth in the helper).
    const flappedIdentity = { ...HARTMAN_CARDIDENTITY };
    const patch = hydrateHoldingIdentityFromEstimate(holding, flappedIdentity);
    expect(patch).toEqual({});
  });

  it("null / missing cardIdentity → no-op", () => {
    const holding: any = {
      id: "h-x",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
    };
    expect(hydrateHoldingIdentityFromEstimate(holding, null)).toEqual({});
    expect(hydrateHoldingIdentityFromEstimate(holding, undefined)).toEqual({});
  });

  // ── Test 5 — isAuto: false user-set → never flipped to true ───────────────
  it("isAuto:false on holding → SKIP (never flipped to true even if catalog suggests auto)", () => {
    const holding: any = {
      id: "h-false-auto",
      playerName: "Eric Hartman",
      cardsightCardId: HARTMAN_PINNED_ID,
      isAuto: false,                                                // user-set false (deliberate or default)
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, HARTMAN_CARDIDENTITY);
    expect(patch).not.toHaveProperty("isAuto");                     // even though set "Autographs" → catalog screams auto
    // Other empty fields still filled.
    expect(patch.cardYear).toBe(2026);
    expect(patch.setName).toBe("Chrome Prospects Autographs");
  });

  // ── Test 6 — isAuto: undefined → heuristic fill ───────────────────────────
  it("isAuto:undefined on Hartman → set to true via 'Autographs' word match", () => {
    const holding: any = {
      id: "h-undef-auto",
      playerName: "Eric Hartman",
      cardsightCardId: HARTMAN_PINNED_ID,
      // isAuto undefined
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, HARTMAN_CARDIDENTITY);
    expect(patch.isAuto).toBe(true);
  });

  it("isAuto:undefined on Trout → set to false (no catalog auto signal)", () => {
    const holding: any = {
      id: "h-undef-base",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);
    expect(patch.isAuto).toBe(false);
  });

  it("isAuto:undefined with auto-prefix card number (CPA-) but no auto-word in set → true via prefix regex", () => {
    const holding: any = {
      id: "h-prefix-only",
      cardsightCardId: HARTMAN_PINNED_ID,
    };
    // Synthetic case: clean set name ("Base Set") but autograph-prefixed
    // card number. Real Cardsight rarely produces this combination, but
    // belt-and-suspenders.
    const synthetic = {
      ...HARTMAN_CARDIDENTITY,
      set: "Base Set",                                              // no auto word
      number: "CPA-XYZ",                                            // auto-prefix
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, synthetic);
    expect(patch.isAuto).toBe(true);
  });

  // ── Edge: legacy-shape holding ────────────────────────────────────────────
  it("legacy `year` (string, no cardYear) → still fills cardYear from catalog", () => {
    const holding: any = {
      id: "h-legacy",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
      // cardYear undefined; year (legacy field) also undefined
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);
    expect(patch.cardYear).toBe(2011);
  });

  it("legacy `year: 2010` (string) present → does NOT fill cardYear (legacy field protection)", () => {
    const holding: any = {
      id: "h-legacy-year",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
      // cardYear undefined but legacy year is set (rare; pre-migration)
      year: "2010",
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);
    expect(patch).not.toHaveProperty("cardYear");
  });

  // ── Edge: empty-string fields treated as empty ───────────────────────────
  it("empty-string identity field treated as empty and filled", () => {
    const holding: any = {
      id: "h-empty-string",
      playerName: "Mike Trout",
      cardsightCardId: TROUT_PINNED_ID,
      setName: "   ",                                               // whitespace-only
      product: "",
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, TROUT_CARDIDENTITY);
    expect(patch.setName).toBe("Base Set");
    expect(patch.product).toBe("Topps Update");
  });

  // ── Edge: catalog identity with null/missing fields ──────────────────────
  it("catalog identity with null `year` → cardYear NOT filled (don't synthesize)", () => {
    const holding: any = {
      id: "h-null-year",
      cardsightCardId: TROUT_PINNED_ID,
    };
    const patch = hydrateHoldingIdentityFromEstimate(holding, {
      ...TROUT_CARDIDENTITY,
      year: null,
    });
    expect(patch).not.toHaveProperty("cardYear");
    // Other fields still fill.
    expect(patch.setName).toBe("Base Set");
  });
});
