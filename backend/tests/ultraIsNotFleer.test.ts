// CF-ULTRA-IS-NOT-FLEER (Drew, 2026-08-17).
//
// normalizeSetKey had no `ultra` rule, so "1995-96 Fleer Ultra" fell through to
// the bare-fleer catch-all and every Ultra card filed as Fleer. Measured against
// live data: 55,373 of 352,825 sold_comps rows on a `fleer` setKey (15.7%)
// carry "Ultra" in their own title or setName, and card_catalog held ZERO rows
// under any ultra setKey for 1995 basketball.
//
// This is not a cosmetic brand blur. 1995-96 Fleer and 1995-96 Ultra Gold
// Medallion share the #1-200 range but agree on the player only 41 times in 197
// (20.8%) — each orders its own checklist alphabetically by team. #25 is
// Michael Jordan in Ultra and Will Perdue in Fleer, so collapsing them pools
// comps across cards that are not the same card.

import { describe, it, expect } from "vitest";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CF-ULTRA-IS-NOT-FLEER — Ultra resolves to its own setKey", () => {
  it("routes every observed Ultra name form to `ultra`", () => {
    for (const name of [
      "Ultra",
      "Fleer Ultra",
      "1995-96 Fleer Ultra",
      "1995-96 Ultra",
      "Ultra Gold Medallion",
      "1995-96 Fleer Ultra Gold Medallion",
    ]) {
      expect(normalizeSetKey(name)).toBe("ultra");
    }
  });

  it("leaves plain Fleer — and the other Fleer product lines — alone", () => {
    expect(normalizeSetKey("Fleer")).toBe("fleer");
    expect(normalizeSetKey("1995-96 Fleer")).toBe("fleer");
    expect(normalizeSetKey("Fleer Metal Universe")).toBe("fleer-metal-universe");
    expect(normalizeSetKey("Fleer Stickers")).toBe("fleer-stickers");
    expect(normalizeSetKey("Flair")).toBe("flair");
  });

  it("matches `ultra` only as a whole segment", () => {
    // Must not fire on a word that merely starts with the letters.
    expect(normalizeSetKey("Ultraviolet")).not.toBe("ultra");
  });

  it("keeps Fleer and Ultra on DIFFERENT slugs at the same card number", () => {
    // The failure this rule exists to prevent: #25 is Michael Jordan in Ultra
    // and Will Perdue in Fleer. One slug for both pools unrelated sales.
    const fleer = computeHobbyIqCardId({
      sport: "basketball", year: 1995, setKey: "1995-96 Fleer",
      cardNumber: "25", parallel: "Base", isAuto: false,
    });
    const ultra = computeHobbyIqCardId({
      sport: "basketball", year: 1995, setKey: "1995-96 Fleer Ultra",
      cardNumber: "25", parallel: "Base", isAuto: false,
    });
    expect(fleer).not.toBe(ultra);
    expect(fleer.split(":")[3]).toBe("fleer");
    expect(ultra.split(":")[3]).toBe("ultra");
  });
});
