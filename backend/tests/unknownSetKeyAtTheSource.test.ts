/**
 * CF-THE-VENDOR-STATES-THE-VERTICAL + CF-NO-CROSS-VERTICAL-FALLBACK at the
 * call sites that had the sport and dropped it. (2026-09-07, #1927 follow-on.)
 *
 * The `unknown` setKey census measured 664,810 sold_comps rows pooled under a
 * product that names nothing — 415,649 of them (62.5%) Pokemon, and 410,787
 * (61.8%) from CardHedge. The census called it "an ingest-side defect in two
 * vendor lanes". These are the two defects it was pointing at, both proven
 * against the real derivers rather than described.
 *
 * DEFECT 1 — the vendor states the vertical and the mapper discards it.
 * `ch_daily_sales` carries `group: "Pokemon"` on 1,525,994 rows (23.2% of the
 * container, measured by GROUP BY on 2026-09-07). `normSport` knew five sports
 * and returned `null` for it. `null` reaches `deriveHobbyIqSlug`, which falls
 * back to `inferSportFromContext` — a bare substring test for the word
 * "pokemon" over setName+title — so a row whose card_set is the set's own name
 * ("Prismatic Evolutions") resolved NO sport and was refused outright on
 * `sport-uncanonical`. The sport is also what gates the ruled Pokemon setKey
 * vocabulary, so no such row could ever reach it.
 *
 * DEFECT 2 — normalizeSetKey answers with the wrong vocabulary when the caller
 * knows the sport but does not pass it. 187 of its 188 product patterns are
 * unanchored, so the SPORTS vocabulary happily claims Pokemon set names:
 * "Obsidian Flames" -> `panini-obsidian`, "Crown Zenith" -> `panini-zenith`.
 * That is the damage CF-NO-CROSS-VERTICAL-FALLBACK measured at 59,748 rows on
 * 2026-08-17 and fixed inside `resolveSetKeyForSlug` — but `buildComponents`,
 * which `recordSoldComp` reaches through `canonicalize` on every vendor row,
 * was outside the net.
 *
 * NO VOCABULARY IS ADDED BY EITHER FIX. Both hand an existing, already-ruled
 * vocabulary the argument that decides its jurisdiction. `unknown` remains the
 * answer wherever the vocabulary genuinely has no rule.
 */
import { describe, it, expect } from "vitest";
import { normSport } from "../src/services/portfolioiq/chRowToSoldComp.js";
import { deriveHobbyIqSlug } from "../src/services/portfolioiq/soldCompsStore.service.js";
import { buildComponents } from "../src/services/catalog/catalogMatcher.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CF-THE-VENDOR-STATES-THE-VERTICAL — CH `group` is the sport", () => {
  it("maps the Pokemon group CardHedge actually sends", () => {
    // The live values are Capitalised; normSport lowercases first.
    expect(normSport("Pokemon")).toBe("pokemon");
    expect(normSport("pokemon")).toBe("pokemon");
    expect(normSport("Pokémon")).toBe("pokemon");
    expect(normSport("  POKEMON  ")).toBe("pokemon");
  });

  it("still maps the five sports, unchanged", () => {
    expect(normSport("Baseball")).toBe("baseball");
    expect(normSport("Basketball")).toBe("basketball");
    expect(normSport("Football")).toBe("football");
    expect(normSport("Hockey")).toBe("hockey");
    expect(normSport("Soccer")).toBe("soccer");
  });

  it("still returns null for a group we do not carry — absent beats wrong", () => {
    // The caller decides whether that is a skip. Only `pokemon` was added, and
    // only because the container measurably carries it.
    expect(normSport("Wrestling")).toBeNull();
    expect(normSport("")).toBeNull();
    expect(normSport(null)).toBeNull();
    expect(normSport(undefined)).toBeNull();
  });
});

describe("a CH Pokemon row gets an identity instead of being refused", () => {
  // The exact shape that was failing: CH states the vertical in `group`, and
  // `card_set` is the set's own name with no "pokemon" word anywhere.
  const CASES: Array<{ cardSet: string; year: number; expectKey: string }> = [
    { cardSet: "Prismatic Evolutions", year: 2025, expectKey: "sv08-5" },
    { cardSet: "Obsidian Flames", year: 2023, expectKey: "sv03" },
    { cardSet: "Crown Zenith", year: 2023, expectKey: "swsh12-5" },
    { cardSet: "Paldea Evolved", year: 2023, expectKey: "sv02" },
  ];

  for (const c of CASES) {
    it(`derives ${c.expectKey} for "${c.cardSet}" rather than refusing`, () => {
      const sport = normSport("Pokemon");
      expect(sport).toBe("pokemon");
      const derived = deriveHobbyIqSlug({
        sport,
        setName: c.cardSet,
        title: `${c.year} ${c.cardSet} #119 Holo`,   // deliberately no "Pokemon"
        cardYear: c.year,
        cardNumber: "119",
        parallel: "Base",
        isAuto: false,
        playerName: "Pikachu",
      } as Parameters<typeof deriveHobbyIqSlug>[0]);

      expect(derived.guard.ok).toBe(true);
      expect(derived.slug).toBe(`hiq:pokemon:${c.year}:${c.expectKey}:119:base:no-auto`);
      // And specifically NOT the two failure modes this fix closes.
      expect(derived.slug).not.toContain(":unknown:");
      expect(derived.slug).not.toContain("panini-");
    });
  }

  it("is the sport that unlocks it: the same row with a null sport is refused", () => {
    // The pre-fix behaviour, pinned so the mechanism cannot be mistaken for a
    // vocabulary change. Nothing about the set name changed — only the sport.
    const derived = deriveHobbyIqSlug({
      sport: null,
      setName: "Prismatic Evolutions",
      title: "2025 Prismatic Evolutions #119 Holo",
      cardYear: 2025,
      cardNumber: "119",
      parallel: "Base",
      isAuto: false,
      playerName: "Pikachu",
    } as Parameters<typeof deriveHobbyIqSlug>[0]);

    expect(derived.guard.ok).toBe(false);
    expect(derived.guard.reasons).toContain("sport-uncanonical");
    expect(derived.slug).toBeNull();
  });
});

describe("CF-NO-CROSS-VERTICAL-FALLBACK — buildComponents passes the sport", () => {
  const PANINI_KEYS = [
    "panini-obsidian", "panini-zenith", "panini-origins", "panini-prizm",
    "panini-select", "panini-donruss", "panini-optic", "donruss-optic", "leaf", "ultra",
  ];

  it("never returns a Panini/sports key for a Pokemon row", () => {
    for (const setName of [
      "Obsidian Flames",
      "Crown Zenith",
      "XY Ancient Origins",
      "EX FireRed & LeafGreen",
      "Sun & Moon Ultra Prism",
    ]) {
      const got = buildComponents({
        sport: "pokemon", year: 2023, setName, cardNumber: "125",
        parallel: null, isAuto: false, player: "Charizard",
      } as Parameters<typeof buildComponents>[0]).setKey;
      expect(PANINI_KEYS, `"${setName}" leaked to ${got}`).not.toContain(got);
    }
  });

  it("resolves the ruled English set code the vendor path already resolves", () => {
    // The two derivers must agree: this is the same answer
    // resolveSetKeyForSlug gives, which is what makes the pool one pool.
    const key = (setName: string, year: number) => buildComponents({
      sport: "pokemon", year, setName, cardNumber: "125",
      parallel: null, isAuto: false, player: "Charizard",
    } as Parameters<typeof buildComponents>[0]).setKey;

    expect(key("Obsidian Flames", 2023)).toBe("sv03");
    expect(key("Crown Zenith", 2023)).toBe("swsh12-5");
    expect(key("Prismatic Evolutions", 2025)).toBe("sv08-5");
  });

  it("is the identity function for the sports it always handled", () => {
    // The fix must not move a single non-Pokemon row. `151` is the reason the
    // Pokemon table is gated at all: it is also an ordinary sports set name.
    const sportsKey = (sport: string, setName: string, year: number) => buildComponents({
      sport, year, setName, cardNumber: "150",
      parallel: null, isAuto: false, player: "X",
    } as Parameters<typeof buildComponents>[0]).setKey;

    for (const [sport, setName, year] of [
      ["baseball", "Topps Chrome", 2024],
      ["baseball", "Bowman Chrome", 2024],
      ["basketball", "Panini Prizm", 2024],
      ["football", "Panini Donruss Optic", 2024],
      ["hockey", "Upper Deck", 2024],
      ["baseball", "151", 2024],
    ] as Array<[string, string, number]>) {
      expect(sportsKey(sport, setName, year)).toBe(normalizeSetKey(setName));
    }
  });

  it("keeps the sport on the components it returns", () => {
    const c = buildComponents({
      sport: "Pokemon", year: 2023, setName: "Obsidian Flames", cardNumber: "125",
      parallel: null, isAuto: false, player: "Charizard",
    } as Parameters<typeof buildComponents>[0]);
    expect(c.sport).toBe("pokemon");
    expect(c.setKey).toBe("sv03");
  });
});
