// CF-AN-ERA-PREFIX-IS-USUALLY-NUMBERED (Drew, 2026-09-07), and its companion
// CF-ONE-VOCABULARY-DECIDES-ONE-VERTICAL.
//
// THE DEFECT. `TCG_ERA_OR_MECHANIC_TITLE` — the gate that keeps the forty-odd
// SPORTS product rules off a TCG title — admitted the era prefix only in its
// BARE colon form (`\b(?:swsh|sv|sm|xy)\s*:`). TCGplayer writes the era with
// its ORDINAL far more often, and `\bsv\b` cannot match `sv03`: there is no
// word boundary between a letter and a digit. So every numbered spelling was
// invisible to the gate, and a title that never says "Pokemon" fell through to
// the sports vocabulary, whose bare colour/theme words claimed it:
//
//   "SV03: Obsidian Flames Charizard ex 200/197"  -> Panini Obsidian
//   "XY7: Ancient Origins Charizard 17/98"        -> Panini Origins
//
// That is the harm CF-ONE-CARD-ONE-ROW-ONE-POOL names: a confident WRONG key
// that passes the slug guard and fuses a Pokemon sale into a Panini pool.
//
// THE SECOND HALF. `isPokemonVertical` — which gates the Pokemon CARD NUMBER
// rules — demanded the literal word "Pokemon", so it disagreed with the setKey
// path about the same title. A row could resolve a Pokemon setKey and then
// have its number read by the sports reader, which returns null for the subset
// shapes:
//
//   "Machamp V - SWSH9: Brilliant Stars - TG01/TG30"  -> setKey swsh9, number NULL
//
// Both gates now read the ONE constant, so a title cannot be Pokemon for one
// leg and not the other.
//
// MEASURED, read-only, over 6,000 live sold_comps rows under the
// `hiq:pokemon:` slug prefix (2026-09-07), re-derived through the built parser
// before and after: unknown setKey 2,524 -> 2,375 (149 recovered), ZERO rows
// regressed, and zero card numbers changed. The numbered era prefix appears in
// 541 of 24,000 sampled Pokemon rows (2.3%), 343 of which never say "Pokemon".
import { describe, it, expect } from "vitest";
import {
  inferSetKeyFromTitle,
  parseListingIdentity,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const sk = (title: string): string => inferSetKeyFromTitle(title, num(title));
const num = (title: string): string | null =>
  parseListingIdentity(title, undefined, { vertical: "pokemon" }).cardNumber;
/** The number as a caller with NO vertical hint gets it — the rematch's case. */
const blindNum = (title: string): string | null =>
  parseListingIdentity(title).cardNumber;

describe("CF-AN-ERA-PREFIX-IS-USUALLY-NUMBERED — the numbered era reaches the Pokemon vocabulary", () => {
  // Every era prefix shape a seller writes, with no "Pokemon" anywhere in the
  // title. Each must resolve to the tcgdex code, never a sports brand.
  const ERA_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ["SV03: Obsidian Flames Charizard ex 125/197", "sv03"],
    ["SV04: Paradox Rift Roaring Moon ex 124/182", "sv04"],
    ["SV07: Stellar Crown Terapagos ex 170/142", "sv07"],
    ["SWSH12: Silver Tempest Lugia V 186/195", "swsh12"],
    ["SWSH11: Lost Origin Giratina VSTAR 186/196", "swsh11"],
    ["SWSH09: Brilliant Stars Charizard V 154/172", "swsh9"],
    ["SM7: Celestial Storm Rayquaza 177/168", "sm7"],
    ["XY7: Ancient Origins Charizard 17/98", "xy7"],
    ["XY12: Evolutions Charizard 11/108", "xy12"],
    ["SWSH04: Vivid Voltage Phanpy 065/185", "swsh4"],
    ["SWSH03: Darkness Ablaze Flaaffy 083/189", "swsh3"],
  ];

  for (const [title, expected] of ERA_SHAPES) {
    it(`reads "${title.slice(0, 34)}" as ${expected}`, () => {
      expect(sk(title)).toBe(expected);
    });
  }

  it("resolves the dotted sub-set spelling (SV08.5 is Prismatic Evolutions)", () => {
    expect(sk("SV08.5: Prismatic Evolutions Umbreon ex SV001/SV122")).toBe("sv08-5");
  });

  it("an era prefix does not override a set NAME the title also states", () => {
    // "SWSH01: Sword & Shield Base Set" answers `base1`, because the alias
    // table maps the words "base set" there and the NAME is consulted before
    // the code. That is UNCHANGED by this ruling — verified against the built
    // parser on main, which answers `base1` for this title too — and it is
    // pinned here so the era prefix is never mistaken for a new authority
    // that outranks the name table. Whether `base-set` should win over the
    // Sword & Shield base set is a VOCABULARY question for a ruling, not
    // something this gate decides.
    expect(sk("SWSH01: Sword & Shield Base Set Shellder 041/202")).toBe("base1");
  });

  // THE BRAND COLLISIONS. These five set names are also Panini product words,
  // and each was measured resolving to the sports brand before this change.
  // Every OTHER word the task listed (Prizm, Select, Mosaic, Chronicles,
  // Immaculate, Flawless, Absolute, Phoenix, Illusions, Spectra, Unparalleled,
  // Contenders, Certified, Legacy, Elite) appears in NO tcgdex English set
  // name — verified against POKEMON_SET_ALIASES — so there is nothing to pin
  // for them and nothing that could collide.
  const BRAND_COLLISIONS: ReadonlyArray<readonly [string, string, string]> = [
    ["Obsidian", "SV03: Obsidian Flames Charizard ex 125/197", "sv03"],
    ["Zenith", "SWSH12: Crown Zenith Giratina VSTAR GG01/GG70", "swsh12-5"],
    ["Origins", "XY7: Ancient Origins Charizard 17/98", "xy7"],
    ["Stellar", "SV07: Stellar Crown Terapagos ex 170/142", "sv07"],
    ["Paradox", "SV04: Paradox Rift Roaring Moon ex 124/182", "sv04"],
  ];

  for (const [word, title, expected] of BRAND_COLLISIONS) {
    it(`"${word}" in a Pokemon title is the Pokemon set, not the Panini brand`, () => {
      expect(sk(title)).toBe(expected);
      expect(sk(title)).not.toMatch(/panini|leaf/i);
    });
  }

  // THE NEGATIVES, which are the whole risk. A real sports title carrying the
  // same brand word must be untouched by every change here.
  const SPORTS_NEGATIVES: ReadonlyArray<readonly [string, string]> = [
    ["2023 Panini Obsidian Justin Jefferson #12 Green /25", "Panini Obsidian"],
    ["2023 Panini Zenith Bijan Robinson #101", "Panini Zenith"],
    ["2015 Panini Origins Todd Gurley RC #4", "Panini Origins"],
  ];

  for (const [title, expected] of SPORTS_NEGATIVES) {
    it(`sports title keeps its brand: "${title.slice(0, 30)}"`, () => {
      expect(sk(title)).toBe(expected);
    });
  }

  it("a bare SV03 with NO colon is still a card number, never a set address", () => {
    // CF-TCG-ERA-PREFIX-COLLISION: `SV03` unqualified is a Topps Chrome
    // Sapphire card number. The colon is what makes it a set address, and
    // removing it must return the title to the sports vocabulary.
    expect(sk("2023 Topps Chrome Sapphire Edition SV03 Corbin Carroll")).not.toMatch(/^sv03$/);
  });
});

describe("CF-ONE-VOCABULARY-DECIDES-ONE-VERTICAL — one title, one vertical, both legs", () => {
  // The subset shapes. Each is read ONLY by the Pokemon rules; before the gate
  // agreed with the setKey path, a title with no "Pokemon" word returned null.
  const SUBSET_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ["Machamp V - SWSH9: Brilliant Stars - TG01/TG30", "TG01"],
    ["Pikachu - SWSH12: Crown Zenith - GG01/GG70", "GG01"],
    ["Eevee ex - SV08.5: Prismatic Evolutions - SV001/SV122", "SV001"],
    ["Rayquaza - SWSH9: Brilliant Stars - TG20/TG30", "TG20"],
    ["Giratina VSTAR - SWSH12: Crown Zenith - GG69/GG70", "GG69"],
  ];

  for (const [title, expected] of SUBSET_SHAPES) {
    it(`reads the subset position ${expected} with no "Pokemon" in the title`, () => {
      expect(blindNum(title)).toBe(expected);
    });
  }

  it("the setKey and the cardNumber leg agree about the same title", () => {
    const t = "Machamp V - SWSH9: Brilliant Stars - TG01/TG30";
    expect(sk(t)).toBe("swsh9");
    expect(blindNum(t)).toBe("TG01");
  });

  it("a caller-stated NON-pokemon TCG vertical still refuses the Pokemon rules", () => {
    // The era gate can never override an explicit vertical: a Yu-Gi-Oh row
    // must not be read by the Pokemon number rules.
    const t = "Dark Magician - SWSH9: Brilliant Stars - TG01/TG30";
    expect(parseListingIdentity(t, undefined, { vertical: "yugioh" }).cardNumber).not.toBe("TG01");
  });
});

describe("N/M is a position over a set size — never the concatenation", () => {
  // >=15 number shapes, each with the position the checklist publishes.
  const NUMBER_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ["2023 Pokemon Obsidian Flames Charizard ex 200/197", "200/197"],
    ["2025 Pokemon Journey Together Iono 163/159", "163/159"],
    ["2025 Pokemon Prismatic Evolutions Umbreon ex 161/131", "161/131"],
    ["2024 Pokemon Surging Sparks Pikachu ex 094/191", "094/191"],
    ["2023 Pokemon Paldea Evolved Chien-Pao ex 61/193", "61/193"],
    ["Pokemon Astral Radiance TG01/TG30 Machamp V", "TG01"],
    ["Pokemon Astral Radiance TG30/TG30 Palkia", "TG30"],
    ["Pokemon Crown Zenith GG01/GG70 Pikachu", "GG01"],
    ["Pokemon Crown Zenith GG70/GG70 Mew", "GG70"],
    ["Pokemon Prismatic Evolutions SV001/SV122 Eevee", "SV001"],
    ["Pokemon Prismatic Evolutions SV122/SV122 Sylveon", "SV122"],
    ["2022 Pokemon SWSH Black Star Promo SWSH180 Charizard", "SWSH180"],
    ["2018 Pokemon SM Black Star Promo SM211 Pikachu", "SM211"],
    ["2016 Pokemon XY Black Star Promo XY112 Jirachi", "XY112"],
    ["2023 Pokemon Obsidian Flames Charizard SV107 secret", "SV107"],
    ["Pokemon Japanese Base Set No. 141 Charizard", "141"],
  ];

  for (const [title, expected] of NUMBER_SHAPES) {
    it(`"${title.slice(0, 40)}" -> ${expected}`, () => {
      expect(num(title)).toBe(expected);
    });
  }

  it("never returns the two halves glued together", () => {
    for (const [title] of NUMBER_SHAPES) {
      const n = String(num(title) ?? "");
      expect(n).not.toBe("200197");
      expect(n).not.toBe("163159");
      expect(n).not.toBe("161131");
    }
  });

  // THE SPORTS NEGATIVES for the number leg. A serial is NOT a card number —
  // CF-SERIAL-IS-NOT-A-CARDNUMBER, ~6,500 slugs and ~32,000 stuck sales the
  // last time this was got wrong.
  it("a sports 1/1 stays a print run, not a card number", () => {
    const p = parseListingIdentity("2025 Topps Chrome Shohei Ohtani #150 Refractor 1/1");
    expect(p.cardNumber).toBe("150");
    expect(p.printRun).toBe(1);
  });

  it("a sports #5/25 keeps the number and the /25 print run", () => {
    const p = parseListingIdentity("2024 Panini Prizm Caitlin Clark #5/25 Gold");
    expect(p.cardNumber).toBe("5");
    expect(p.printRun).toBe(25);
  });

  it("a sports serial does not become a Pokemon position", () => {
    const p = parseListingIdentity("2023 Bowman Chrome Jackson Holliday #BCP-50 Orange 17/25");
    expect(p.printRun).toBe(25);
    expect(String(p.cardNumber ?? "")).not.toBe("1725");
  });
});

describe("CF-THE-APOSTROPHE-IS-A-SEGMENT — Champion's Path is swsh3-5", () => {
  // tcgdex renders the possessive as its own segment (`champion-s-path`);
  // `slugify` dropped the apostrophe (`champions-path`), so the alias was
  // unreachable from any title a seller writes.
  const SPELLINGS = [
    "2020 Pokemon Champion's Path Charizard VMAX #074 PSA 10",
    "2020 Pokemon Champion’s Path Charizard VMAX #074",
    "POKEMON CHARIZARD VMAX 2020 SWORD & SHIELD CHAMPION'S PATH SECRET #074",
  ];

  for (const title of SPELLINGS) {
    it(`resolves "${title.slice(0, 38)}"`, () => {
      expect(sk(title)).toBe("swsh3-5");
    });
  }

  it("the rewrite merges no two distinct alias keys", async () => {
    const { POKEMON_SET_ALIASES } = await import(
      "../src/services/catalog/pokemonSetAliases.js"
    );
    const collapsed = new Map<string, Set<string>>();
    for (const [alias, code] of Object.entries(POKEMON_SET_ALIASES)) {
      const k = alias.replace(/s-/g, "-s-").replace(/-+/g, "-");
      if (!collapsed.has(k)) collapsed.set(k, new Set());
      collapsed.get(k)!.add(String(code));
    }
    const collisions = [...collapsed.entries()].filter(([, codes]) => codes.size > 1);
    expect(collisions).toEqual([]);
  });
});

describe("mutation pins — the gates cannot silently narrow again", () => {
  it("the NUMBERED era prefix is what makes the difference (not the bare one)", () => {
    // If the numbered alternative is removed from TCG_ERA_OR_MECHANIC_TITLE,
    // this title falls to the sports rules and becomes "Panini Obsidian".
    // The bare-form title below keeps working either way, which is why the
    // numbered case has to be pinned separately.
    expect(sk("SV03: Obsidian Flames Charizard ex 125/197")).toBe("sv03");
    expect(sk("Charizard ex - SV: Obsidian Flames - Holofoil")).toBe("sv03");
  });

  it("the number gate cannot go back to demanding the word Pokemon", () => {
    // Delete the POKEMON_TITLE_EVIDENCE line in isPokemonVertical and this
    // returns null.
    expect(blindNum("Machamp V - SWSH9: Brilliant Stars - TG01/TG30")).toBe("TG01");
  });
});
