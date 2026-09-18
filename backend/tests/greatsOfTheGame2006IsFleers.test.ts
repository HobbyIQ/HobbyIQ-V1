// R51 AMENDED (Drew, 2026-09-18): THE 2006 "GREATS OF THE GAME" IS FLEER'S.
//
// The product prints NO MAKER: 4,796 of its 4,797 checklist-backed catalog rows
// spell the setName "2006 Greats of the Game" — no Fleer, no Upper Deck. That
// is why R51's original attribution to Upper Deck was sent back for a recheck:
// the 2006 `upper-deck` pool holds ZERO rows titled Greats of the Game, so the
// evidence pointed away from it. Drew's amendment keys it to
// `fleer-greats-of-the-game`, the key #2232 registered for 2000-2004.
//
// THE YEAR GATE IS LOAD-BEARING, and a glance would miss why. The bare key is
// NOT 2006-only: `greats-of-the-game` carries 4,801 catalog rows — the 4,797
// from 2006, plus ONE each in 2000, 2001, 2002 and 2004. Those four are
// `bccp-product-structure` stubs (no player, no card number, no hiq id; ids of
// the form `product-structure:2001-greats-of-the-game`) standing in for
// products whose own checklists are still an open acquisition. Folding them
// into a 2006 ruling would attribute four other years' products on no evidence.

import { describe, it, expect } from "vitest";
import {
  spellForEra,
  isProductSetKey,
  GREATS_OF_THE_GAME_FLEER_YEAR,
} from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("R51 amended: the 2006 Greats of the Game is Fleer's", () => {
  it("2006 spells the bare key as Fleer's", () => {
    expect(spellForEra("greats-of-the-game", 2006)).toBe("fleer-greats-of-the-game");
    expect(GREATS_OF_THE_GAME_FLEER_YEAR).toBe(2006);
  });

  it.each([2000, 2001, 2002, 2004, 2005, 2007, 1999])(
    "%i does NOT — the rule is gated to the one year Drew ruled on",
    (year) => {
      expect(spellForEra("greats-of-the-game", year)).toBe("greats-of-the-game");
    },
  );

  it("an absent year decides nothing", () => {
    // The same refusal the Fleer-Tiffany and Metal-Universe era tables make:
    // a year we do not have cannot pick an era.
    expect(spellForEra("greats-of-the-game", null)).toBe("greats-of-the-game");
    expect(spellForEra("greats-of-the-game", undefined)).toBe("greats-of-the-game");
    expect(spellForEra("greats-of-the-game", 0)).toBe("greats-of-the-game");
    expect(spellForEra("greats-of-the-game", Number.NaN)).toBe("greats-of-the-game");
  });

  it("the destination is a registered product and a fixed point", () => {
    expect(isProductSetKey("fleer-greats-of-the-game")).toBe(true);
    expect(normalizeSetKey("fleer-greats-of-the-game")).toBe("fleer-greats-of-the-game");
    // and it is idempotent: re-spelling the destination never moves it again
    expect(spellForEra("fleer-greats-of-the-game", 2006)).toBe("fleer-greats-of-the-game");
    expect(spellForEra("fleer-greats-of-the-game", 2001)).toBe("fleer-greats-of-the-game");
  });

  it("MUTATION: the other Greats products are untouched in every year", () => {
    // Both are registered fixed points from #2232 and must never be swallowed
    // by a rule about a differently-named release.
    for (const year of [1999, 2005, 2006, 2007, null]) {
      expect(spellForEra("donruss-greats", year as number | null)).toBe("donruss-greats");
      expect(spellForEra("sports-illustrated-greats-of-the-game", year as number | null))
        .toBe("sports-illustrated-greats-of-the-game");
    }
    expect(normalizeSetKey("donruss-greats")).toBe("donruss-greats");
    expect(normalizeSetKey("sports-illustrated-greats-of-the-game"))
      .toBe("sports-illustrated-greats-of-the-game");
  });

  it("MUTATION: the era tables this one sits beside still work", () => {
    // Same function, same shape — a regression here would mean the new branch
    // was inserted somewhere it shadows an existing one.
    expect(spellForEra("skybox-metal-universe", 1996)).toBe("metal-universe");
    expect(spellForEra("skybox-metal-universe", 2021)).toBe("skybox-metal-universe");
  });
});
