/**
 * CF-A-TCGPLAYER-ROW-STATES-ITS-OWN-IDENTITY (2026-09-08).
 *
 * The defect these pin: run 34262947046 pulled 26,000 TCGplayer sales for
 * 2026-09-07 and wrote NINE. Every other row died at persistVendorSalesToPool's
 * `if (!cardYear) skip` / `if (!playerName) skip` gates, because TCA sends
 * player=null and year=null on every TCGplayer row and nothing filled them in.
 *
 * These tests pin the mapper output for BOTH vendor shapes, so a change that
 * fixes one by breaking the other goes red.
 */

import { describe, it, expect } from "vitest";
import {
  tcgPlayerRowIdentity,
  tcgPlayerSetKey,
  tcgPlayerCharacterName,
  isTcgPlayerRow,
} from "../src/services/portfolioiq/tcgPlayerRowIdentity.js";
import { pokemonSetYear, POKEMON_SET_YEARS } from "../src/services/catalog/pokemonSetYears.js";

/** Real rows, copied verbatim from TCA's 2026-09-07 window. */
const TCG_ROW = {
  id: "tcgplayer-85673-2026-09-07T21:55:01.587+00:00-_qFGRh7ZqhQ1-2",
  title: "Gengar (48) - Expedition - Reverse Holofoil",
  card_set: "Expedition",
  card_number: "048/165",
  platform: "TCGplayer",
  category: "tcg",
  price: 229.99,
  sold_at: "2026-09-07T21:55:01Z",
  sale_date: "2026-09-07",
  player: null,
  year: null,
  sport: null,
};

const EBAY_ROW = {
  id: "278326560390",
  title: "MATT MURRAY 2023-24 UPPER DECK SERIES 2 YOUNG GUNS ROOKIE RC",
  card_set: null,
  card_number: null,
  platform: "eBay",
  category: null,
  price: 15.25,
  sold_at: "2026-09-07T00:06:00Z",
  sale_date: "2026-09-07",
  player: null,
  year: null,
  sport: null,
};

describe("a TCGplayer row states its own identity", () => {
  it("reads the full Pokemon address off a real TCGplayer row", () => {
    expect(tcgPlayerRowIdentity(TCG_ROW)).toEqual({
      playerName: "Gengar",
      cardYear: 2002,
      cardNumber: "048",
      setKey: "ecard1",
      parallel: "Reverse Holofoil",
      sport: "pokemon",
      reason: null,
    });
  });

  it("a TCGplayer row with a real price is NOT skipped", () => {
    // The defect in one assertion: this row has a price, a sale date and an
    // address, and the old pipeline dropped it anyway.
    const id = tcgPlayerRowIdentity(TCG_ROW);
    expect(id.reason).toBeNull();
    expect(id.cardYear).toBeTruthy();
    expect(id.playerName).toBeTruthy();
    expect(TCG_ROW.price).toBeGreaterThan(0);
  });

  it("the year is the SET's year, never the sale's", () => {
    // A 2026 sale of a 2002 card is a 2002 card. Filing it under the sale year
    // is CF-VINTAGE-SALES-UNDER-SALE-YEAR-SLUGS, a ~180k-row defect elsewhere.
    const id = tcgPlayerRowIdentity(TCG_ROW);
    expect(id.cardYear).toBe(2002);
    expect(id.cardYear).not.toBe(2026);
    expect(TCG_ROW.sold_at.slice(0, 4)).toBe("2026");
  });

  it("prefers TCA's structured card_number and drops the set total", () => {
    // "048/165" -- 165 is the set size, not part of the card's number.
    expect(tcgPlayerRowIdentity(TCG_ROW).cardNumber).toBe("048");
  });

  it("folds the finish per the finish ruling, and Normal carries no parallel", () => {
    const rev = tcgPlayerRowIdentity({ ...TCG_ROW, title: "Gengar (48) - Expedition - Reverse Holo" });
    expect(rev.parallel).toBe("Reverse Holofoil");
    const holo = tcgPlayerRowIdentity({ ...TCG_ROW, title: "Gengar (48) - Expedition - Holo" });
    expect(holo.parallel).toBe("Holofoil");
    const normal = tcgPlayerRowIdentity({ ...TCG_ROW, title: "Gengar (48) - Expedition - Normal" });
    expect(normal.parallel).toBeNull();
  });

  it("keeps rarity suffixes on the character -- they are separate card lines", () => {
    // "Charizard ex" is not "Charizard": different print run, different price.
    expect(tcgPlayerCharacterName("Charizard ex (223) - Obsidian Flames - Holofoil")).toBe("Charizard ex");
    expect(tcgPlayerCharacterName("Pikachu VMAX (044) - Vivid Voltage - Holofoil")).toBe("Pikachu VMAX");
  });

  it("resolves the set to the tcgdex code, never to a sports pool", () => {
    // inferSetKeyFromTitle reads "Obsidian Flames" as the SPORTS product
    // "Panini Obsidian" (measured). CF-NO-CROSS-VERTICAL-FALLBACK forbids it.
    expect(tcgPlayerSetKey("Obsidian Flames")).toBe("sv03");
    expect(tcgPlayerSetKey("Expedition")).toBe("ecard1");
    expect(tcgPlayerSetKey("SV: Scarlet & Violet 151")).toBe("sv03-5");
    expect(tcgPlayerSetKey("Diamond and Pearl")).toBeTruthy();
  });

  it("an unmapped set is a counted skip with no address, never a guessed year", () => {
    const id = tcgPlayerRowIdentity({ ...TCG_ROW, card_set: "Miscellaneous Cards & Products" });
    expect(id.reason).toBe("set-unmapped");
    expect(id.cardYear).toBeNull();
    expect(id.setKey).toBeNull();
    expect(id.playerName).toBeNull();
  });

  it("leaves eBay rows alone", () => {
    // The whole eBay path must be untouched: this reader must not claim a
    // sports row, whatever its title says.
    expect(isTcgPlayerRow(EBAY_ROW)).toBe(false);
    expect(isTcgPlayerRow(TCG_ROW)).toBe(true);
    expect(isTcgPlayerRow({ ...EBAY_ROW, category: "sports" })).toBe(false);
  });

  it("claims a TCG row by category even when the platform is not TCGplayer", () => {
    expect(isTcgPlayerRow({ platform: "eBay", category: "tcg" })).toBe(true);
  });
});

describe("the set year is derived, not guessed", () => {
  it("derives years for the overwhelming majority of English sets", () => {
    // 214 of 218 codes carry exactly one year across their aliases; the 4 gaps
    // are Trainer Gallery subsets, resolved via their parent below.
    expect(Object.keys(POKEMON_SET_YEARS).length).toBeGreaterThanOrEqual(210);
  });

  it("resolves Trainer Gallery subsets through their parent set", () => {
    expect(pokemonSetYear("swsh10tg")).toBe(pokemonSetYear("swsh10"));
    expect(pokemonSetYear("swsh10tg")).toBe(2022);
  });

  it("returns null rather than a year it cannot justify", () => {
    expect(pokemonSetYear("no-such-set-code")).toBeNull();
    expect(pokemonSetYear(null)).toBeNull();
    expect(pokemonSetYear("")).toBeNull();
  });

  it("pins a spread of known set years", () => {
    expect(pokemonSetYear("base1")).toBe(1999);
    expect(pokemonSetYear("ecard1")).toBe(2002);
    expect(pokemonSetYear("sv03")).toBe(2023);
  });
});
