// CF-MOBILE-HOLDING-CARD (Drew, 2026-09-04).
//
// The mobile holding card splits a card title in two — player + card number
// on one line, year + product + parallel on the next — so a phone-width
// clamp can never eat the two parts that NAME the card. That split is only
// safe if both halves come from ONE composition: `formatCardTitle` now
// delegates its product half to `formatCardContext`, and the phone renders
// that same helper directly.
//
// These tests pin the contract that makes the split legitimate:
//   1. the two cleanups Drew has already had fixed once (leading year,
//      trailing parallel) still apply — on BOTH entry points;
//   2. the title is exactly its context half plus the player and number, so
//      the phone shows the same words as the desktop row, only re-broken.

import { describe, it, expect } from "vitest";
import { formatCardTitle, formatCardContext } from "./format";

describe("formatCardContext", () => {
  it("joins year, product and parallel", () => {
    expect(
      formatCardContext({ cardYear: 2020, product: "Bowman Chrome", parallel: "Refractor" }),
    ).toBe("2020 Bowman Chrome Refractor");
  });

  it("drops a leading year on product that repeats cardYear", () => {
    expect(
      formatCardContext({ cardYear: 2026, product: "2026 Bowman Baseball", parallel: null }),
    ).toBe("2026 Bowman Baseball");
  });

  it("keeps a leading four-digit run that is NOT the card's year", () => {
    expect(
      formatCardContext({ cardYear: 2026, product: "1989 Topps Reprint", parallel: null }),
    ).toBe("2026 1989 Topps Reprint");
  });

  // CF-TITLE-DEDUP-PARALLEL (Drew, 2026-08-10) — the Owen Carey CPA-OC panel.
  it("strips a trailing parallel already carried by the product name", () => {
    expect(
      formatCardContext({
        cardYear: 2026,
        product: "Bowman - Chrome Prospect Autographs - Refractor",
        parallel: "Refractor",
      }),
    ).toBe("2026 Bowman - Chrome Prospect Autographs Refractor");
  });

  it("treats a 'Base' parallel as no parallel", () => {
    expect(
      formatCardContext({ cardYear: 1987, product: "Topps", parallel: "Base" }),
    ).toBe("1987 Topps");
  });

  it("survives every field being absent", () => {
    expect(formatCardContext({})).toBe("");
  });
});

describe("formatCardTitle", () => {
  it("is its context half plus the player and the card number", () => {
    const h = {
      cardYear: 2017,
      product: "Bowman Chrome Prospect Autographs",
      parallel: "Refractor",
      playerName: "Aaron Judge",
      cardNumber: "BCP-AJ",
    };
    expect(formatCardTitle(h)).toBe(
      `${formatCardContext(h)} Aaron Judge #BCP-AJ`,
    );
  });

  it("applies the same cleanups the context half does", () => {
    expect(
      formatCardTitle({
        cardYear: 2026,
        product: "2026 Bowman - Chrome Prospect Autographs - Refractor",
        parallel: "Refractor",
        playerName: "Owen Carey",
        cardNumber: "CPA-OC",
      }),
    ).toBe("2026 Bowman - Chrome Prospect Autographs Refractor Owen Carey #CPA-OC");
  });

  it("falls back to cardTitle when there is nothing to compose", () => {
    expect(formatCardTitle({ cardTitle: "A shoebox find" })).toBe("A shoebox find");
  });

  it("falls back to a placeholder when there is nothing at all", () => {
    expect(formatCardTitle({})).toBe("Untitled card");
  });
});
