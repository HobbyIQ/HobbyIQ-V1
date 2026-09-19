// CF-POKEMON-CHECKLISTS (Drew, 2026-08-16: "let's find the pokemon set lists
// somewhere to fill in gaps ... let's fix it and get the checklists to match.
// Do this right").
//
// 766,677 sold_comps rows carry a `hiq:pokemon:` slug and 564,103 of them
// (73.6%) had `setKey: unknown` — a well-formed slug that can never join a
// catalog row. The rest fragmented across every spelling of a set name and
// embedded the year that the slug already carries in its own segment:
//
//     hiq:pokemon:1999:1999-pokemon-base-set:...
//     hiq:pokemon:2023:2023-pokemon-scarlet-violet-151:...
//
// The fix maps every observed name form onto the stable TCG set id, which is
// the convention hobbyIqCardId.service documents at the top of the file. What
// these tests pin is the property that actually matters: a comp and a checklist
// row for the same card must land on the SAME slug, however the seller spelled
// the set.

import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { POKEMON_SET_ALIASES } from "../src/services/catalog/pokemonSetAliases.js";

const slugFor = (setKey: string, opts: { sport?: string; year?: number; cardNumber?: string } = {}) =>
  computeHobbyIqCardId({
    sport: opts.sport ?? "pokemon",
    year: opts.year ?? 1999,
    setKey,
    cardNumber: opts.cardNumber ?? "4",
    parallel: "Base",
    isAuto: false,
    printRun: null,
  });

describe("CF-POKEMON-CHECKLISTS — set-name aliases converge on the TCG set id", () => {
  it("every spelling of Base Set resolves to the same card", () => {
    const want = "hiq:pokemon:1999:base1:4:base:no-auto";
    expect(slugFor("1999 Pokemon Base Set")).toBe(want);
    expect(slugFor("Pokemon Base Set")).toBe(want);
    expect(slugFor("Base Set")).toBe(want);
  });

  it("the year is NOT duplicated into the setKey segment", () => {
    // The bug this replaces produced hiq:pokemon:1999:1999-pokemon-base-set:...
    const slug = slugFor("1999 Pokemon Base Set");
    expect(slug.split(":")[3]).toBe("base1");
    expect(slug).not.toContain("1999-pokemon");
  });

  it("a modern set resolves through its series name too", () => {
    const want = "hiq:pokemon:2023:sv03-5:199:base:no-auto";
    const opts = { year: 2023, cardNumber: "199" };
    expect(slugFor("2023 Pokemon Scarlet & Violet 151", opts)).toBe(want);
    expect(slugFor("151", opts)).toBe(want);
  });

  it("Jungle resolves to base2, not to a name slug", () => {
    expect(slugFor("Jungle", { cardNumber: "1" })).toBe("hiq:pokemon:1999:base2:1:base:no-auto");
  });

  // THE GUARD THAT MATTERS. The alias table contains keys like "151" that would
  // be actively dangerous applied to a sports set name, so the lookup is gated
  // on sport. A non-Pokemon card must never reach it.
  it("aliases do NOT leak into other sports", () => {
    expect(slugFor("151", { sport: "baseball", year: 2023, cardNumber: "199" }))
      .toBe("hiq:baseball:2023:151:199:base:no-auto");
    expect(slugFor("Base Set", { sport: "basketball", year: 1999 }))
      .toBe("hiq:basketball:1999:base-set:4:base:no-auto");
  });

  it("an unknown Pokemon set still produces a usable slug, not a crash", () => {
    const slug = slugFor("Some Set We Have Never Indexed", { year: 2030, cardNumber: "7" });
    expect(slug.startsWith("hiq:pokemon:2030:")).toBe(true);
  });

  it("the generated table is non-trivial and maps onto id-shaped keys", () => {
    const entries = Object.entries(POKEMON_SET_ALIASES);
    expect(entries.length).toBeGreaterThan(500);
    // Values are TCG set ids: short, slug-safe, never year-prefixed.
    for (const [, id] of entries) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(id).not.toMatch(/^(?:19|20)\d{2}-/);
    }
  });
});

// CF-A-VENDOR-CAN-DROP-THE-CODE-A-CHECKLIST-NEVER-DROPS (2026-09-19).
//
// CardHedge's setName for a Black Star Promos product drops the era code that
// every tcgdex set name embeds ("SVP Black Star Promos"), so its own spelling
// ("2023 Pokemon Scarlet & Violet Black Star Promos") never resolved through
// the generated table and those sales sat on `hiq:pokemon:2023:unknown:*`.
// setkey-reconciliation.json shows 38,652 real pool rows at exactly that
// address. This block pins the fix and its boundaries.
describe("CF-A-VENDOR-CAN-DROP-THE-CODE-A-CHECKLIST-NEVER-DROPS — codeless promo spellings", () => {
  it("the CardHedge Scarlet & Violet Black Star Promos spelling resolves to svp", () => {
    expect(resolveSetKeyForSlug("pokemon", "2023 Pokemon Scarlet & Violet Black Star Promos", 2023))
      .toBe("svp");
    // Prior years CardHedge emits under the same codeless spelling (measured:
    // 2024 and 2025 in setkey-reconciliation.json) must resolve identically.
    expect(resolveSetKeyForSlug("pokemon", "2024 Pokemon Scarlet & Violet Black Star Promos", 2024))
      .toBe("svp");
    expect(resolveSetKeyForSlug("pokemon", "2025 Pokemon Scarlet & Violet Black Star Promos", 2025))
      .toBe("svp");
  });

  it("the Sword & Shield sibling of the same shape resolves to swshp", () => {
    expect(resolveSetKeyForSlug("pokemon", "2019 Pokemon Sword & Shield Black Star Promos", 2019))
      .toBe("swshp");
  });

  it("a Japanese title never lands on the English promo code", () => {
    // "Japanese" in the setName routes through the JA vocabulary before this
    // table is ever consulted (CF-THE-JAPANESE-CODE-IS-THE-KEY) — a Japanese
    // promo sale must never resolve to the English svp/swshp code merely
    // because it shares the "Black Star Promos" words.
    expect(resolveSetKeyForSlug("pokemon", "2023 Pokemon Japanese Scarlet & Violet Black Star Promos", 2023))
      .not.toBe("svp");
    expect(resolveSetKeyForSlug("pokemon", "2019 Pokemon Japanese Sword & Shield Black Star Promos", 2019))
      .not.toBe("swshp");
  });

  it("an unresolved name still returns unknown rather than a guessed code", () => {
    // The ambiguous BARE "Black Star Promos" spelling (no series word) is
    // deliberately not in the table — every promo-era set shares that name —
    // so it must fall through to a slug, never silently pick one era's code.
    const slug = resolveSetKeyForSlug("pokemon", "2023 Pokemon Black Star Promos", 2023);
    expect(slug).not.toBe("svp");
    expect(["svp", "swshp", "bwp", "smp", "dpp", "hgssp", "np", "basep", "mep", "xyp"])
      .not.toContain(slug === "black-star-promos" ? "__never__" : slug);
  });

  it("the four unproven codeless promo siblings are still absent (documented, not guessed)", () => {
    // Same mechanical gap as svp/swshp — proven code and series name — but no
    // committed sighting of the exact vendor spelling, so left unadded.
    expect(POKEMON_SET_ALIASES["diamond-pearl-black-star-promos"]).toBeUndefined();
    expect(POKEMON_SET_ALIASES["heartgold-soulsilver-black-star-promos"]).toBeUndefined();
    expect(POKEMON_SET_ALIASES["black-white-black-star-promos"]).toBeUndefined();
    expect(POKEMON_SET_ALIASES["sun-moon-black-star-promos"]).toBeUndefined();
  });
});
