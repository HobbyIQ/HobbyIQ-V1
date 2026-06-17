/**
 * CF-EBAY-TITLE-HONOR-AND-FALLBACK (2026-06-17): focused tests for
 * the public buildTitle() in ebayListing.service.ts.
 *
 * Covers:
 *   - HONOR path: non-empty cardTitle returned verbatim, trimmed,
 *     capped at 80 chars.
 *   - FALLBACK path: structured composition in the canonical
 *     [year] [set] [player] [parallel(+serial)] [Auto?] order.
 *   - Dedup: brand-vs-set overlap collapse ("Bowman Bowman Chrome"
 *     → "Bowman Chrome"); parallel-vs-serial double avoidance.
 *   - Empty-token skipping with no stray double spaces.
 *   - 80-char cap with ellipsis on both paths.
 *
 * No eBay HTTP traffic, no auth — pure pure-function unit tests.
 */

import { describe, it, expect } from "vitest";

import {
  buildTitle,
  type HoldingListingInput,
} from "../src/services/ebay/ebayListing.service.js";

// ---------------------------------------------------------------------------
// Fixture helper: minimal HoldingListingInput with sensible defaults that
// produce a clean composed title. Override fields per-test.
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<HoldingListingInput> = {}): HoldingListingInput {
  return {
    holdingId: "holding-uuid",
    playerName: "Eric Hartman",
    cardTitle: "",
    cardYear: 2026,
    brand: "Bowman",
    setName: "Bowman Chrome",
    product: "Bowman Chrome",
    isAuto: false,
    isPatch: false,
    isRookie: false,
    quantity: 1,
    listingPrice: 25,
    bestOfferEnabled: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HONOR path
// ---------------------------------------------------------------------------

describe("buildTitle — HONOR path (provided cardTitle)", () => {
  it("returns the provided cardTitle verbatim when non-empty", () => {
    const input = makeInput({
      cardTitle: "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150 Auto",
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150 Auto"
    );
  });

  it("trims surrounding whitespace from the provided cardTitle", () => {
    const input = makeInput({ cardTitle: "   Custom Title Here   " });
    expect(buildTitle(input)).toBe("Custom Title Here");
  });

  it("falls through to FALLBACK when cardTitle is empty string", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "Blue X-Fractor /150",
      isAuto: true,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150 Auto"
    );
  });

  it("falls through to FALLBACK when cardTitle is whitespace only", () => {
    const input = makeInput({
      cardTitle: "    \t   ",
      parallel: "Blue X-Fractor /150",
      isAuto: true,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150 Auto"
    );
  });

  it("caps the provided cardTitle at 80 chars with an ellipsis", () => {
    // 90-char title — should be truncated to 77 + "..." = 80 chars total.
    const longTitle =
      "2026 Bowman Chrome Eric Hartman Super Special Blue X-Fractor Refractor /150 Auto RC PSA 10";
    expect(longTitle.length).toBeGreaterThan(80);

    const input = makeInput({ cardTitle: longTitle });
    const result = buildTitle(input);
    expect(result.length).toBe(80);
    expect(result.endsWith("...")).toBe(true);
    expect(result).toBe(longTitle.substring(0, 77) + "...");
  });
});

// ---------------------------------------------------------------------------
// FALLBACK path — canonical composition
// ---------------------------------------------------------------------------

describe("buildTitle — FALLBACK path (compose from structured fields)", () => {
  it("composes the canonical Hartman example end-to-end", () => {
    // The exact assertion from the CF brief.
    const input = makeInput({
      cardTitle: "",
      cardYear: 2026,
      brand: "Bowman",
      product: "Bowman Chrome",
      playerName: "Eric Hartman",
      parallel: "Blue X-Fractor /150",
      isAuto: true,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150 Auto"
    );
  });

  it("omits the Auto suffix when isAuto is false", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "Blue X-Fractor /150",
      isAuto: false,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150"
    );
  });
});

// ---------------------------------------------------------------------------
// Dedup: brand-vs-set
// ---------------------------------------------------------------------------

describe("buildTitle — brand-vs-set dedup", () => {
  it("collapses 'Bowman' + 'Bowman Chrome' to 'Bowman Chrome'", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "Bowman",
      product: "Bowman Chrome",
      parallel: "",
      isAuto: false,
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Eric Hartman");
  });

  it("collapses 'Topps' + 'Topps Chrome' to 'Topps Chrome'", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "Topps",
      product: "Topps Chrome",
      parallel: "",
    });
    expect(buildTitle(input)).toBe("2026 Topps Chrome Eric Hartman");
  });

  it("prepends brand when set does not contain it", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "Topps",
      product: "Heritage",
      parallel: "",
    });
    expect(buildTitle(input)).toBe("2026 Topps Heritage Eric Hartman");
  });

  it("uses set alone when brand is empty", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "",
      product: "Bowman Chrome",
      parallel: "",
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Eric Hartman");
  });

  it("uses brand alone when set is empty", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "Bowman",
      product: "",
      setName: "",
      parallel: "",
    });
    expect(buildTitle(input)).toBe("2026 Bowman Eric Hartman");
  });

  it("falls back to setName when product is empty", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "Bowman",
      product: "",
      setName: "Bowman Chrome",
      parallel: "",
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Eric Hartman");
  });

  it("is case-insensitive on the brand match", () => {
    const input = makeInput({
      cardTitle: "",
      brand: "bowman",
      product: "Bowman Chrome",
      parallel: "",
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Eric Hartman");
  });
});

// ---------------------------------------------------------------------------
// Dedup: parallel-vs-serial
// ---------------------------------------------------------------------------

describe("buildTitle — parallel-vs-serial dedup", () => {
  it("does not double the /serial when parallel already encodes it", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "Blue X-Fractor /150",
      serialNumber: "150",
      printRun: 150,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Blue X-Fractor /150"
    );
  });

  it("appends serial to bare parallel when parallel has no /N", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "Refractor",
      printRun: 250,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Refractor /250"
    );
  });

  it("uses printRun over serialNumber when both are present", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "Refractor",
      serialNumber: "abc",
      printRun: 99,
    });
    expect(buildTitle(input)).toBe(
      "2026 Bowman Chrome Eric Hartman Refractor /99"
    );
  });

  it("emits /N alone when parallel is empty but a serial is present", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "",
      printRun: 100,
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Eric Hartman /100");
  });

  it("omits the parallel slot entirely when both parallel and serial are empty", () => {
    const input = makeInput({
      cardTitle: "",
      parallel: "",
      serialNumber: undefined,
      printRun: undefined,
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Eric Hartman");
  });
});

// ---------------------------------------------------------------------------
// Empty-token skipping + cap
// ---------------------------------------------------------------------------

describe("buildTitle — empty-token skipping + 80-char cap", () => {
  it("skips zero/undefined cardYear cleanly", () => {
    const input = makeInput({
      cardTitle: "",
      cardYear: 0,
      parallel: "",
    });
    expect(buildTitle(input)).toBe("Bowman Chrome Eric Hartman");
  });

  it("skips empty playerName cleanly", () => {
    const input = makeInput({
      cardTitle: "",
      playerName: "",
      parallel: "Refractor",
    });
    expect(buildTitle(input)).toBe("2026 Bowman Chrome Refractor");
  });

  it("never emits double spaces or trailing separators", () => {
    const input = makeInput({
      cardTitle: "",
      cardYear: 0,
      brand: "",
      product: "",
      setName: "",
      playerName: "Eric Hartman",
      parallel: "",
      isAuto: false,
    });
    expect(buildTitle(input)).toBe("Eric Hartman");
  });

  it("caps a composed title that exceeds 80 chars at 80 with ellipsis", () => {
    // Force a long composed title by stuffing the parallel field.
    const input = makeInput({
      cardTitle: "",
      cardYear: 2026,
      brand: "Bowman",
      product: "Bowman Chrome",
      playerName: "Eric Hartman",
      parallel:
        "Super Special Long Parallel Name With Refractor /150 1st Bowman",
      isAuto: true,
    });
    const result = buildTitle(input);
    expect(result.length).toBe(80);
    expect(result.endsWith("...")).toBe(true);
  });
});
