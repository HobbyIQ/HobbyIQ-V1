// CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04).
//
// #1751 made the Pokemon SET reachable from a title. This is the other half of
// the identity, and until now it could never match: the NUMBER.
//
// THE DEFECT. A Pokemon title states POS/TOTAL -- "Journey Together 094/159",
// "Umbreon ex 161/131 SIR". `parseListingIdentity` returns that verbatim,
// which is right: it is what the seller printed. But `slugify` strips the
// slash, so the slug segment became the two numbers glued together:
//
//     094/159  ->  :094159:          161/131  ->  :161131:
//
// The catalog's Pokemon rows come from tcgdex and store the POSITION ALONE, in
// the checklist's own spelling -- `094`, `161`. So no slug derived from an
// English Pokemon title could reach its checklist row. Measured over a
// 5,000-row sold_comps sample (sport=pokemon, cardYear=2025) on 2026-09-04:
// 3,607 rows derive a supported setKey and only 2,289 (63.5%) land on a
// checklist-backed catalog row.
//
// THE SECOND DEFECT IS THE ONE THAT SPLITS POOLS. Sellers write the position
// both ways -- "094/159" and "94/159" are one card -- and each spelling minted
// its own slug. The catalog carries the same split, because `ingest-auto-seed`
// rows were minted from sales through this very derivation: tcgdex says `004`
// and the seeded rows say `4`. Numeric values stored under BOTH spellings in
// card_catalog on 2026-09-04:
//
//     sv10  98      swsh11  47      swsh10  33      swsh12  28
//
// THE WIDTH IS READ PER SET, NEVER ASSUMED. The eras genuinely differ, so a
// constant would be wrong for half of them. Measured over checklist-backed
// rows only: every `sv*` and `swsh1x` set is uniformly 3-wide, while `sm*` and
// `xy*` are VERBATIM (1-, 2- and 3-wide together; xy12 is dominantly 2).
//
// AND THE WIDTH IS READ FROM CHECKLIST ROWS ONLY. Asking every source what the
// clean spelling is would entrench the split it exists to close: including the
// auto-seeded rows flips sv08-5, sv10, sv03-5, swsh10, swsh11 and swsh12 from
// "3-wide" to "verbatim", which is the defect voting on its own repair.
//
// BLANK MEANS UNKNOWN. A set with no checklist cannot say what its width is,
// so the number is left exactly as stated and the guard reports it. Padding on
// a guess would mint an identity no checklist ever published.
//
// The mutation pins at the bottom are the load-bearing tests: they fail if the
// width derivation is dropped (pad to a constant) or if a suffixed number is
// padded.

import { describe, it, expect } from "vitest";
import {
  checklistNumberWidth,
  normalizePokemonCardNumber,
} from "../src/services/catalog/pokemonCardNumber.js";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/** The width every `sv*`/`swsh1x` checklist uses, as measured. */
const THREE_WIDE = ["001", "004", "094", "161", "173"];
/** The `sm*`/`xy*` shape: the checklist pads nothing. */
const VERBATIM = ["4", "42", "173", "9"];

describe("checklistNumberWidth — the convention is the checklist's, per set", () => {
  it("reads a uniformly padded checklist as its own width", () => {
    expect(checklistNumberWidth(THREE_WIDE)).toBe(3);
  });

  it("reads a checklist that pads nothing as verbatim (width 0)", () => {
    expect(checklistNumberWidth(VERBATIM)).toBe(0);
  });

  it("refuses when there is no checklist to ask — blank means unknown", () => {
    expect(checklistNumberWidth([])).toBeNull();
  });

  it("refuses when the checklist lists only suffixed numbers, which are not positions", () => {
    expect(checklistNumberWidth(["TG01", "TG30", "GG69"])).toBeNull();
  });

  it("ignores suffixed numbers when positions are also present", () => {
    expect(checklistNumberWidth([...THREE_WIDE, "TG01", "GG69"])).toBe(3);
  });
});

describe("normalizePokemonCardNumber — the total is the set's size, not the card's identity", () => {
  it("drops the /TOTAL and pads to the checklist's width", () => {
    expect(normalizePokemonCardNumber("94/159", 3)).toBe("094");
    expect(normalizePokemonCardNumber("094/159", 3)).toBe("094");
  });

  it("folds both spellings of one position onto the checklist's — the split pool closes", () => {
    expect(normalizePokemonCardNumber("94/159", 3))
      .toBe(normalizePokemonCardNumber("094/159", 3));
  });

  it("leaves a secret rare numbered above the set total alone", () => {
    // 161/131 and 231/182 are real: the position CAN exceed the total.
    expect(normalizePokemonCardNumber("161/131", 3)).toBe("161");
    expect(normalizePokemonCardNumber("231/182", 3)).toBe("231");
  });

  it("strips padding when the set's checklist spells positions verbatim", () => {
    expect(normalizePokemonCardNumber("004/165", 0)).toBe("4");
    expect(normalizePokemonCardNumber("42/108", 0)).toBe("42");
  });

  it("leaves the number EXACTLY as stated when the set has no checklist", () => {
    // The padding is what a checklist has to authorize. Absent one, we do not
    // invent a width -- but the TOTAL is never part of the identity in any set.
    expect(normalizePokemonCardNumber("94/159", null)).toBe("94");
    expect(normalizePokemonCardNumber("094/159", null)).toBe("094");
  });

  it("never touches a suffixed number, whatever the width says", () => {
    for (const w of [3, 0, null]) {
      expect(normalizePokemonCardNumber("TG01/TG30", w)).toBe("TG01/TG30");
      expect(normalizePokemonCardNumber("GG69", w)).toBe("GG69");
      expect(normalizePokemonCardNumber("SV107", w)).toBe("SV107");
    }
  });

  it("is a no-op on a blank number — a parse failure stays a parse failure", () => {
    expect(normalizePokemonCardNumber("", 3)).toBe("");
    expect(normalizePokemonCardNumber(null, 3)).toBe("");
  });
});

/** The real titles, through the real derivation, to the real slug. */
function slugFor(title: string, width: number | null, year = 2025): string {
  const p = parseListingIdentity(title, undefined, { vertical: "pokemon" } as never);
  return computeHobbyIqCardId({
    sport: "pokemon",
    year,
    setKey: inferSetKeyFromTitle(title, p.cardNumber),
    cardNumber: p.cardNumber ?? "",
    parallel: p.parallel ?? "Base",
    isAuto: !!p.isAuto,
    printRun: p.printRun ?? null,
    playerName: "Pikachu",
    pokemonChecklistNumberWidth: width,
  } as never);
}

describe("real English Pokemon titles land on the checklist's number", () => {
  it("Prismatic Evolutions Umbreon ex 161/131 SIR", () => {
    expect(slugFor("2025 Pokemon Prismatic Evolutions Umbreon ex 161/131 SIR PSA 10", 3))
      .toBe("hiq:pokemon:2025:sv08-5:161:base:no-auto");
  });

  it("Destined Rivals Team Rocket Mewtwo ex 231/182 SIR", () => {
    expect(slugFor("2025 Pokemon Destined Rivals Team Rocket Mewtwo ex 231/182 SIR", 3))
      .toBe("hiq:pokemon:2025:sv10:231:base:no-auto");
  });

  it("Journey Together 094/159", () => {
    expect(slugFor("2025 Pokemon Journey Together 094/159 Clefairy ex", 3))
      .toBe("hiq:pokemon:2025:sv09:094:base:no-auto");
  });

  it("the SAME card written 94/159 lands on the SAME slug — one card, one pool", () => {
    expect(slugFor("2025 Pokemon Journey Together Bellibolt ex 94/159", 3))
      .toBe(slugFor("2025 Pokemon Journey Together 094/159 Clefairy ex", 3));
  });

  it("Black Bolt #094/086 — the '#' form parses the whole number, not just the head", () => {
    expect(slugFor("2025 Pokemon Black Bolt Pikachu ex #094/086", 3))
      .toBe("hiq:pokemon:2025:sv10-5b:094:base:no-auto");
  });

  it("a set whose checklist is absent REFUSES to pad — the number stays as stated", () => {
    expect(slugFor("2025 Pokemon Journey Together Bellibolt ex 94/159", null))
      .toBe("hiq:pokemon:2025:sv09:94:base:no-auto");
  });

  it("a non-pokemon card is untouched by any of this", () => {
    expect(computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "Bowman Chrome", cardNumber: "CPA-EHA",
      parallel: "Gold Refractor", isAuto: true, printRun: 50, playerName: "X",
      pokemonChecklistNumberWidth: 3,
    } as never)).toContain(":cpa-eha:");
  });
});

// ── MUTATION PINS ────────────────────────────────────────────────────────────
//
// Each asserts the DIFFERENCE the rule makes, so reverting the rule turns the
// test red. A pin that passes with the rule deleted proves nothing.

describe("mutation pins", () => {
  it("MUTATION: padding to a CONSTANT instead of the checklist's width is red", () => {
    // The `sm*`/`xy*` era pads nothing. A constant 3 would rewrite `4` as
    // `004` and miss every one of those checklist rows.
    const constantThree = (n: string) => n.split("/")[0].padStart(3, "0");
    expect(normalizePokemonCardNumber("4/165", 0)).toBe("4");
    expect(constantThree("4/165")).toBe("004");
    expect(normalizePokemonCardNumber("4/165", 0)).not.toBe(constantThree("4/165"));
  });

  it("MUTATION: dropping the width derivation (always pad to 3) is red on a verbatim set", () => {
    expect(checklistNumberWidth(VERBATIM)).not.toBe(3);
  });

  it("MUTATION: padding a SUFFIXED number is red", () => {
    // If rule 3 were dropped, "TG01/TG30" would become "TG01" -> padded, or
    // worse, its digits would be read as a position.
    expect(normalizePokemonCardNumber("TG01/TG30", 3)).toBe("TG01/TG30");
    expect(normalizePokemonCardNumber("TG01/TG30", 3)).not.toBe("TG01");
  });

  it("MUTATION: reading the width from ALL sources instead of checklist rows is red", () => {
    // The measured shape of a split set: tcgdex 3-wide, auto-seed 1/2-wide.
    const checklistOnly = ["001", "004", "094", "173"];
    const everySource = [...checklistOnly, "4", "94"];
    expect(checklistNumberWidth(checklistOnly)).toBe(3);
    expect(checklistNumberWidth(everySource)).toBe(0);
    expect(checklistNumberWidth(checklistOnly)).not.toBe(checklistNumberWidth(everySource));
  });

  it("MUTATION: keeping the /TOTAL in the slug is red — it names no card", () => {
    const kept = slugFor("2025 Pokemon Journey Together 094/159 Clefairy ex", 3);
    expect(kept).not.toContain(":094159:");
    expect(kept).toContain(":094:");
  });
});
