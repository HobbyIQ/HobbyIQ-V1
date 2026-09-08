// CF-TCG-SPORTS-COLLIDING-SETS-NEED-A-MARKER (#2006 follow-up, 2026-09-08).
//
// #2006 pointed the daily TCA feed at TCGplayer. Over the first 12,000 live
// TCGplayer rows (2026-09-07 window), the vertical resolver sent 8,102 to
// pokemon and SKIPPED 3,898 -- 32.5% -- as no-vertical. Under
// CF-NO-DEFAULT-SPORT an unresolved vertical means no slug first segment,
// which means no address, which means the sale never enters a pool at all.
//
// The skipped rows were not a bug in the omission list. They were the omission
// list working as designed: "Expedition", "Base Set", "Platinum", "Diamond and
// Pearl" and the EX-era names were deliberately excluded because they collide
// with sports products, and a false positive pulls a REAL sports sale out of
// pricing. Plus 3,499 rows of the 2025 Mega Evolution era, which postdates
// every list in the module.
//
// The fix is a marker gate, not a deletion. "Is 'Expedition' a Pokemon word?"
// is ambiguous. "Is 'Expedition' a Pokemon word on a row whose platform is
// TCGplayer?" is not -- TCGplayer sells no sports cards. So the colliding
// names resolve ONLY when something else on the row already proved the
// vertical, and stay unresolved otherwise. Blank still means unknown.

import { describe, expect, it } from "vitest";
import { classifyTcg } from "../src/services/portfolioiq/tcgVertical.service.js";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service.js";

/** Real titles from the 2026-09-07 TCGplayer window that were being skipped. */
const MEASURED_SKIPPED_TITLES: readonly string[] = [
  "Gastly - Expedition - Normal",
  "Furret - Aquapolis - Normal",
  "Floatzel - Diamond and Pearl - Normal",
  "Flygon - 15/97 - EX Dragon - Normal",
  "Fire Energy - Black and White - Normal",
  "Fraxure (14) - Dragon Vault - Holofoil",
  "Forest Guardian - Aquapolis - Normal",
  "Flaaffy - EX Dragon - Normal",
];

describe("a TCGplayer row is never a sports card", () => {
  it("resolves the measured skipped titles to pokemon when platform is TCGplayer", () => {
    for (const title of MEASURED_SKIPPED_TITLES) {
      const r = resolveVertical({ title, platform: "TCGplayer", category: "tcg" });
      expect(r.vertical, title).toBe("pokemon");
      expect(r.confident, title).toBe(true);
    }
  });

  it("resolves the Mega Evolution era, which no set list could have enumerated", () => {
    // 3,499 of the 3,898 skipped rows. "ME05: Pitch Black" postdates every
    // name in POKEMON_SET_NAMES, so enumerating known sets could never have
    // caught it -- only the platform can.
    for (const setName of ["ME: Ascended Heroes", "ME05: Pitch Black", "ME01: Mega Evolution",
                           "ME04: Chaos Rising", "MEE: Mega Evolution Energies"]) {
      const r = resolveVertical({ title: `Charcadet - ${setName} - Normal`, platform: "TCGplayer" });
      expect(r.vertical, setName).toBe("pokemon");
      expect(r.confident, setName).toBe(true);
    }
  });

  it("resolves a TCGplayer row that carries NO recognisable set name at all", () => {
    // The platform alone is sufficient evidence. This is the residual the
    // set-name approach can never close, because it is unbounded.
    const r = resolveVertical({ title: "Some Product We Have Never Heard Of - Normal", platform: "TCGplayer" });
    expect(r.vertical).toBe("pokemon");
    expect(r.confident).toBe(true);
  });

  it("accepts the vendor category as the marker when platform is absent", () => {
    // TCA stamps category="tcg" on 100% of TCGplayer rows (4,000/4,000
    // measured). Cross-sport rule: the PRODUCT vertical decides.
    const r = resolveVertical({ title: "Gastly - Expedition - Normal", category: "tcg" });
    expect(r.vertical).toBe("pokemon");
  });

  it("stamps a reason that says WHICH evidence decided it", () => {
    expect(classifyTcg({ title: "Gastly - Expedition - Normal", platform: "TCGplayer" }).reason)
      .toBe("marked-set-name");
    expect(classifyTcg({ title: "Nothing Recognisable Here", platform: "TCGplayer" }).reason)
      .toBe("tcg-platform");
    // A self-sufficient signal still wins and keeps its own reason.
    expect(classifyTcg({ title: "Charizard VMAX", platform: "TCGplayer" }).reason)
      .toBe("title-pattern");
  });
});

describe("the sports-collision guard still holds without a marker", () => {
  // This is the half that must NOT regress. Every one of these carries a word
  // from the colliding list and NO Pokemon marker, so it must stay unresolved
  // (or resolve to its real sport) rather than being read as Pokemon.
  const SPORTS_TITLES_CARRYING_A_COLLIDING_WORD: readonly string[] = [
    "2021 Bowman Platinum #45 Wander Franco",
    "2022 Panini Prizm Base Set #12 Ja Morant",
    "2019 Topps Diamond and Pearl Parallel #55",
    "1998 Upper Deck Expedition #30 Michael Jordan",
    "2020 Panini Black and White #7 Joe Burrow",
  ];

  it("does NOT read a colliding set word as Pokemon on an unmarked row", () => {
    for (const title of SPORTS_TITLES_CARRYING_A_COLLIDING_WORD) {
      const c = classifyTcg({ title });
      expect(c.isTcg, title).toBe(false);
    }
  });

  it("keeps a real sports row on its own sport even when it names a colliding set", () => {
    const r = resolveVertical({ title: "2021 Bowman Platinum Baseball #45 Wander Franco" });
    expect(r.vertical).toBe("baseball");
    expect(r.confident).toBe(true);
  });

  it("still refuses to guess when nothing at all identifies the row", () => {
    // CF-NO-DEFAULT-SPORT is untouched: blank means unknown, never a guess.
    const r = resolveVertical({ title: "2019 some completely unidentifiable card" });
    expect(r.vertical).toBe("");
    expect(r.confident).toBe(false);
  });

  it("an eBay row naming a colliding set is NOT unlocked by its platform", () => {
    // eBay sells both, so the platform proves nothing there. Only a TCG-only
    // platform is evidence.
    const c = classifyTcg({ title: "2021 Bowman Platinum #45", platform: "eBay" });
    expect(c.isTcg).toBe(false);
  });
});

describe("MUTATION CHECK -- the marker gate is load-bearing", () => {
  // The gate is the entire safety property. If a future edit drops it and
  // reads the colliding names unconditionally, THIS is the test that fails.
  //
  // Verified by asking for the same colliding titles with and without a
  // marker: the ungated implementation returns isTcg=true for both, which is
  // precisely the harm (a Bowman Platinum sale leaving the baseball pool).
  it("colliding names WITHOUT a marker must not classify, WITH one must", () => {
    const colliding = ["Gastly - Expedition - Normal", "Mewtwo2 - Base Set - Something",
                       "Floatzel2 - Diamond and Pearl - Normal", "ME05: Pitch Black"];
    for (const title of colliding) {
      const unmarked = classifyTcg({ title });
      const marked = classifyTcg({ title, platform: "TCGplayer" });
      // Removing the gate collapses these two into the same answer.
      expect(marked.isTcg, `marked: ${title}`).toBe(true);
      expect(unmarked.isTcg, `unmarked (gate removed?): ${title}`).toBe(false);
      expect(unmarked.isTcg, title).not.toBe(marked.isTcg);
    }
  });

  it("a title-borne marker unlocks the same names with no platform field", () => {
    // Proves the gate is about EVIDENCE, not about one vendor field.
    expect(classifyTcg({ title: "Gastly - Expedition - Holo Rare" }).isTcg).toBe(true);
    expect(classifyTcg({ title: "Team Aqua Grunt - Expedition - Trainer Card" }).isTcg).toBe(true);
    // NOT an energy phrase: "<Type> Energy" is the one marker a colliding row
    // can carry on its own, so it would self-mark and unlock "Expedition" with
    // no evidence from outside the title. It must still decline -- these rows
    // resolve on platform=TCGplayer instead, which is real evidence.
    expect(classifyTcg({ title: "Water Energy - Expedition" }).isTcg).toBe(false);
    expect(classifyTcg({ title: "Fighting Energy - Expedition - Normal" }).isTcg).toBe(false);
    expect(classifyTcg({ title: "Fighting Energy - Expedition - Normal", platform: "TCGplayer" }).isTcg).toBe(true);
    // Same set word, no marker -> still refused.
    expect(classifyTcg({ title: "1998 Upper Deck Expedition #30" }).isTcg).toBe(false);
  });
});

describe("a TCG-only platform must not relabel the OTHER games", () => {
  // The platform fallback names `pokemon`, so every non-Pokemon game has to
  // resolve on its own evidence BEFORE reaching it. Found while checking this:
  // the haystack flattens hyphens, so "Yu-Gi-Oh" arrives as "Yu Gi Oh" and the
  // old /yu-?gi-?oh/ (optional HYPHEN, not space) missed it. Harmless
  // while an unmatched row merely fell through to isTcg:false -- but with the
  // fallback in place it would have been labelled pokemon, which is a wrong
  // vertical, not a missing one.
  it("keeps Yu-Gi-Oh, One Piece and Lorcana on their own patterns", () => {
    for (const title of ["Blue-Eyes White Dragon - Yu-Gi-Oh",
                         "Dark Magician - Yu-Gi-Oh! - 1st Edition",
                         "Monkey D. Luffy - One Piece OP01",
                         "Elsa - Lorcana - Foil"]) {
      const c = classifyTcg({ title, platform: "TCGplayer" });
      expect(c.isTcg, title).toBe(true);
      // Its OWN pattern decided it, not the platform fallback.
      expect(c.reason, title).toBe("title-pattern");
      expect(c.vertical, title).not.toBe("pokemon");
    }
  });

  it("matches Yu-Gi-Oh through the slug, where hyphens are already flattened", () => {
    // The slug form is the one that exercises the flattening.
    const c = classifyTcg({ title: "", hobbyiqCardId: "hiq:yugioh:2002:yu-gi-oh:1:base:no-auto" });
    expect(c.isTcg).toBe(true);
  });
});
