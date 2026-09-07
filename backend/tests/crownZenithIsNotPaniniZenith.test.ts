// CF-A-TCG-TITLE-NEED-NOT-SAY-POKEMON (2026-09-06).
//
// The last of the three gaps in CF-THE-ENGLISH-SET-CODE-IS-THE-KEY. The two
// earlier halves made the Pokemon vocabulary reachable and put it AHEAD of the
// sports rules, but both were gated on a title that says a vertical word out
// loud. The largest single source of Pokemon sales in the pool does not say
// one: TCGplayer writes `<card> - <ERA>: <set> - <finish>`, which names the
// era, the set and the card's mechanic and never the word "Pokemon".
//
//   "Eevee V - SWSH: Crown Zenith - Holofoil"        -> Panini Zenith
//   "Charizard ex - SV: Obsidian Flames - Holofoil"  -> Panini Obsidian
//
// A wrong key is worse than no key: it passes the slug guard and fuses a
// Pokemon sale into a Panini pool (CF-ONE-CARD-ONE-ROW-ONE-POOL).
//
// MEASURED, 2026-09-06, read-only against prod. card_catalog holds 422 rows
// under sport=pokemon / setKey=panini-zenith; sold_comps holds 585 live rows
// addressed panini-zenith under sport pokemon, and 584 of them carry this
// title shape. Against those 585 real titles this file's rules resolve
// 390 -> swsh12-5 and 195 -> swsh12-5gg, with none left on a Panini key.
//
// THE BOUNDARY IS THE POINT. Panini Zenith is a real, live SPORTS product; the
// 2,400-title sports sample this change was diffed against (baseball/football/
// basketball across six products, read-only from the pool) produced ZERO key
// changes. Both facts are pinned below.
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const key = (title: string): string => normalizeSetKey(inferSetKeyFromTitle(title));

/** The TCGplayer title shape, as it actually reaches us through tca-ebay. */
const CROWN_ZENITH: ReadonlyArray<readonly [string, string]> = [
  ["Eevee V - SWSH: Crown Zenith - Holofoil", "swsh12-5"],
  ["Charizard VSTAR - SWSH: Crown Zenith - Holofoil", "swsh12-5"],
  ["Poke Ball - SWSH: Crown Zenith - Reverse Holofoil", "swsh12-5"],
  ["Mewtwo VSTAR - SWSH: Crown Zenith Galarian Gallery - Holofoil", "swsh12-5gg"],
  // No era prefix and no "Pokemon" — the product name has to stand alone.
  ["Radiant Charizard Crown Zenith 020/159 Holo PSA 9 English (2023)", "swsh12-5"],
  ["Pikachu GG30/GG70 Crown Zenith Galarian Gallery Holo Ultra Rare English 2023", "swsh12-5gg"],
  ["Mew GG10/GG70 - Crown Zenith: Galarian Gallery - Full Art Holo NM", "swsh12-5gg"],
];

/** The sports product that keeps the key. Every one of these is a real title
 *  shape from the football/basketball/baseball pools. */
const PANINI_ZENITH: readonly string[] = [
  "2024 Panini Zenith Football Caleb Williams RC Auto",
  "2023 Panini Zenith Baseball #10",
  "2022 Zenith Aidan Hutchinson Rookie",
  "2022 Panini Zenith Basketball Rookie V Series",
];

describe("CF-A-TCG-TITLE-NEED-NOT-SAY-POKEMON", () => {
  it.each(CROWN_ZENITH)("%s -> %s", (title, expected) => {
    expect(key(title)).toBe(expected);
  });

  it.each(PANINI_ZENITH)("the SPORTS product keeps its key: %s", (title) => {
    expect(key(title)).toBe("panini-zenith");
  });

  it("the two products never share a key", () => {
    const pokemon = new Set(CROWN_ZENITH.map(([t]) => key(t)));
    const sports = new Set(PANINI_ZENITH.map((t) => key(t)));
    expect([...pokemon]).not.toContain("panini-zenith");
    expect([...sports]).toEqual(["panini-zenith"]);
  });

  it("CF-AN-ERA-IS-NOT-A-SET — the era never outranks the set inside it", () => {
    // `sword-shield` and `crown-zenith` are both 12 characters, so
    // longest-first left the winner to sort stability and this title resolved
    // to swsh1 — the 2020 base set, three years and one checklist from the
    // card sold. Measured on main before this change: a standing defect this
    // ruling makes reachable for many more titles, not one it introduces.
    expect(key("2023 Sword & Shield Series - Crown Zenith - Hisuian Samurott V")).toBe("swsh12-5");
    expect(key("2023 Pokemon Sword Shield Crown Zenith Charizard VSTAR")).toBe("swsh12-5");
    // The era is still reachable when the title names no set within it. (A
    // title that DOES name one - "Base Set" is base1 - correctly prefers it;
    // that is the containment rule working, not the era being unreachable.)
    expect(key("2020 Pokemon Sword & Shield Zacian V Holo")).toBe("swsh1");
  });

  it("CF-NO-CROSS-VERTICAL-FALLBACK — another TCG is never read as Pokemon", () => {
    // The resolver's gate is POKEMON evidence, not the general TCG gate: the
    // general one admits Yu-Gi-Oh and MTG, and scoring those against 1,497
    // Pokemon aliases resolved "Rage of the Abyss" to `ex3`.
    expect(key("2024 Yu-Gi-Oh! Rage of the Abyss Blue-Eyes White Dragon")).toBe("unknown");
    expect(key("2023 Magic The Gathering Lord of the Rings One Ring")).toBe("unknown");
  });

  it("MUTATION PIN — a sports title must not be diverted to the TCG branch", () => {
    // The gate's alternatives are era prefixes in their COLON form and Pokemon
    // mechanics. A bare `sv`, a bare `zenith`, a bare `gallery` or `ex` would
    // each pull real sports slabs into "Unknown"; none of them is admitted.
    const sports = [
      "1952 Topps #311 Mickey Mantle SGC EX/NM 80",
      "Michael Jordan 1986 Fleer #57 PSA 8 EX MT",
      "2024 Topps Chrome Update Sword Series SV Jersey #12/70",
      "2019 Topps Heritage #12 SV Special",
      "2021 Panini Prizm Basketball #1 LaMelo Ball Silver",
    ];
    for (const t of sports) expect(key(t)).not.toBe("unknown");
  });
});
