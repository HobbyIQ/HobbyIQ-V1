// playerIdentityKey -- the reduction that decides whether two catalog rows
// name the same card, pinned on the Pokemon names that broke the three copies
// it replaced.
//
// WHY THESE FIXTURES AND NOT INVENTED ONES. Every name below was read off a
// REPORT run of the English Pokemon re-key on 2026-09-07
// (rekey-product-setkey MODE=catalog, apply=false), so each assertion pins a
// pair the lane actually put in front of the survivor rule:
//
//   run 34074108822  pokemon/2003 skyridge -> ecard3   7 pairs REFUSED
//     "Miracle Sphere α" vs "Miracle Sphere Alpha", and the same shape for
//     β/Beta, γ/Gamma, and Mystery Plate α/β/γ/δ. Under the OLD reduction the
//     Greek letter was deleted outright, so α, β and γ all reduced to the one
//     key `miraclesphere` while their own English spellings reduced to
//     `miraclespherealpha` -- a card did not match itself, and three distinct
//     cards matched each other. Both arms scored 0 and all seven refused for a
//     purely orthographic reason.
//
//   run 34074070785  pokemon/2005 unseen-forces -> ex10
//     "Suicune ☆" vs "Unown" at #?115. The Pokemon Star is a distinct
//     secret rare; deleting the star reduces it to plain `suicune`.
//
// TWO DIRECTIONS, AND THE SECOND IS THE DANGEROUS ONE. A false SPLIT costs a
// refusal, which a human settles. A false MERGE means the survivor rule never
// sees a conflict at all and the ordinary ladder folds one card onto another
// silently -- one pool, two cards' sales, no record. So the split assertions
// below are not symmetry for its own sake: `Suicune ☆` != `Suicune` and
// `Nidoran♀` != `Nidoran♂` are the ones that matter most.
//
// THE LATIN BEHAVIOUR IS PINNED TOO. This reduction serves every sport, and
// the change is only ever additive at the character level -- characters move
// from "deleted" to "spelled out", never the other way. The Hockenson pair and
// the punctuation pairs assert that nothing about the football/baseball corpus
// moved.

import { describe, it, expect } from "vitest";
import { playerIdentityKey } from "../src/services/catalog/playerIdentityKey.js";

/** The reduction as it stood before playerIdentityKey.ts, kept here so the
 *  mutation test can state exactly what changed rather than describing it. */
const legacyKey = (s: unknown) =>
  String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

describe("playerIdentityKey -- Latin names are unchanged", () => {
  it.each([
    ["T.J. Hockenson", "TJ Hockenson"],
    ["Ronald Acuna Jr.", "Ronald Acuna Jr"],
    ["Ken Griffey, Jr.", "Ken Griffey Jr"],
  ])("%s == %s", (a, b) => {
    expect(playerIdentityKey(a)).toBe(playerIdentityKey(b));
    // and the key itself is byte-identical to what the old reduction produced,
    // so no stored comparison against a Latin name shifts under this change.
    expect(playerIdentityKey(a)).toBe(legacyKey(a));
  });

  it("distinct people stay distinct", () => {
    expect(playerIdentityKey("Aaron Judge")).not.toBe(playerIdentityKey("Aaron Nola"));
  });
});

describe("playerIdentityKey -- punctuation in Pokemon names is still noise", () => {
  it.each([
    ["Porygon-Z", "Porygon Z"],
    ["Farfetch'd", "Farfetchd"],
    ["Ho-Oh", "Ho Oh"],
    ["Type: Null", "Type Null"],
    ["Jangmo-o", "Jangmo o"],
    ["Mr. Mime", "Mr Mime"],
    ["Pikachu-V", "Pikachu V"],
    ["Charizard ex", "Charizard EX"],
  ])("%s == %s", (a, b) => {
    expect(playerIdentityKey(a)).toBe(playerIdentityKey(b));
  });
});

describe("playerIdentityKey -- accents fold to their base letter", () => {
  it.each([
    ["Flabébé", "Flabebe"],
    ["Pokémon Breeder", "Pokemon Breeder"],
  ])("%s == %s", (a, b) => {
    expect(playerIdentityKey(a)).toBe(playerIdentityKey(b));
  });

  it("Flabébé keeps its letters instead of losing them (was `flabb`)", () => {
    expect(playerIdentityKey("Flabébé")).toBe("flabebe");
    expect(legacyKey("Flabébé")).toBe("flabb");
  });
});

describe("playerIdentityKey -- the skyridge Greek suffixes (run 34074108822)", () => {
  it.each([
    ["Miracle Sphere α", "Miracle Sphere Alpha"],
    ["Miracle Sphere β", "Miracle Sphere Beta"],
    ["Miracle Sphere γ", "Miracle Sphere Gamma"],
    ["Mystery Plate α", "Mystery Plate Alpha"],
    ["Mystery Plate β", "Mystery Plate Beta"],
    ["Mystery Plate γ", "Mystery Plate Gamma"],
    ["Mystery Plate δ", "Mystery Plate Delta"],
  ])("a card matches its own English spelling: %s == %s", (a, b) => {
    expect(playerIdentityKey(a)).toBe(playerIdentityKey(b));
  });

  it("the three Greek suffixes are three DIFFERENT cards", () => {
    const a = playerIdentityKey("Miracle Sphere α");
    const b = playerIdentityKey("Miracle Sphere β");
    const g = playerIdentityKey("Miracle Sphere γ");
    expect(new Set([a, b, g]).size).toBe(3);
    // the defect: all three collapsed onto one key
    expect(new Set([
      legacyKey("Miracle Sphere α"),
      legacyKey("Miracle Sphere β"),
      legacyKey("Miracle Sphere γ"),
    ]).size).toBe(1);
  });

  it("a suffixed card is not the bare card", () => {
    expect(playerIdentityKey("Miracle Sphere α")).not.toBe(playerIdentityKey("Miracle Sphere"));
  });
});

describe("playerIdentityKey -- identity symbols are cards, not noise", () => {
  it("Suicune ☆ is not Suicune (run 34074070785, unseen-forces #?115)", () => {
    expect(playerIdentityKey("Suicune ☆")).not.toBe(playerIdentityKey("Suicune"));
    expect(playerIdentityKey("Suicune ☆")).toBe("suicunestar");
    // the defect: the star vanished and the Star card became the plain card
    expect(legacyKey("Suicune ☆")).toBe(legacyKey("Suicune"));
  });

  it("☆ and ★ are the same mark", () => {
    expect(playerIdentityKey("Suicune ☆")).toBe(playerIdentityKey("Suicune ★"));
  });

  it("Nidoran♀ and Nidoran♂ are two species, not one", () => {
    expect(playerIdentityKey("Nidoran♀")).not.toBe(playerIdentityKey("Nidoran♂"));
    // the defect: both reduced to `nidoran`
    expect(legacyKey("Nidoran♀")).toBe(legacyKey("Nidoran♂"));
  });

  it("the gender symbols match the market's own F/M spelling", () => {
    expect(playerIdentityKey("Nidoran♀")).toBe(playerIdentityKey("Nidoran F"));
    expect(playerIdentityKey("Nidoran♂")).toBe(playerIdentityKey("Nidoran M"));
  });
});

describe("playerIdentityKey -- a SUFFIX is a different card, and stays contended", () => {
  // These pairs came out of the same ten report runs and are deliberately NOT
  // merged here: whether the bare row is a truncated transcription of the EX
  // card or a genuinely different card at the same number is a checklist
  // question, and this function has no checklist. They stay contended and the
  // arms (or a human) settle them.
  it.each([
    ["Charizard", "Charizard ex"],
    ["M Venusaur", "M Venusaur EX"],
    ["M Charizard", "M Charizard EX"],
    ["M Blastoise", "M Blastoise EX"],
    ["Flying Pikachu", "Flying Pikachu V"],
    ["Surfing Pikachu", "Surfing Pikachu V"],
    ["Team Magma's Groudon", "Team Magma's Groudon EX"],
    ["Team Aqua's Kyogre", "Team Aqua's Kyogre EX"],
    ["Paldean Clodsire", "Paldean Clodsire ex"],
    ["Pikachu V", "Pikachu VMAX"],
  ])("%s != %s", (a, b) => {
    expect(playerIdentityKey(a)).not.toBe(playerIdentityKey(b));
  });

  it("a parenthesised gloss is still a different key (the arms decide it)", () => {
    // "Boss's Orders (Ghetsis)" vs "Boss's Orders" -- paldea-evolved #172/#265,
    // resolved by the sale-titles arm at 200 vs 0, not by this reduction.
    expect(playerIdentityKey("Boss's Orders (Ghetsis)"))
      .not.toBe(playerIdentityKey("Boss's Orders"));
  });
});

describe("playerIdentityKey -- empty and absent", () => {
  it.each([null, undefined, "", "   ", "☆", "♀"])("%s reduces to a non-identifying key", (v) => {
    // A name that is ONLY punctuation/symbol carries no player. `☆` alone
    // becomes "star", which is not a card either -- what matters is that none
    // of these can equal a real name.
    const k = playerIdentityKey(v);
    expect(k).not.toBe(playerIdentityKey("Suicune"));
    expect(k).not.toBe(playerIdentityKey("Aaron Judge"));
  });

  it("null and empty are the empty key, so `both sides must name someone` still fires", () => {
    expect(playerIdentityKey(null)).toBe("");
    expect(playerIdentityKey(undefined)).toBe("");
    expect(playerIdentityKey("  ")).toBe("");
  });
});

describe("playerIdentityKey -- MUTATION: the legacy reduction fails these", () => {
  // If someone reverts the transliteration, these are the assertions that go
  // red. Stated as one test so the failure names the whole class rather than
  // one example.
  it("every Pokemon-name fixture that the old expression got wrong", () => {
    const falseMerges: Array<[string, string]> = [
      ["Suicune ☆", "Suicune"],
      ["Nidoran♀", "Nidoran♂"],
      ["Miracle Sphere α", "Miracle Sphere β"],
    ];
    const falseSplits: Array<[string, string]> = [
      ["Miracle Sphere α", "Miracle Sphere Alpha"],
      ["Mystery Plate δ", "Mystery Plate Delta"],
      ["Flabébé", "Flabebe"],
      ["Nidoran♀", "Nidoran F"],
    ];
    for (const [a, b] of falseMerges) {
      expect(legacyKey(a), `legacy merged ${a}/${b}`).toBe(legacyKey(b));
      expect(playerIdentityKey(a), `fixed splits ${a}/${b}`).not.toBe(playerIdentityKey(b));
    }
    for (const [a, b] of falseSplits) {
      expect(legacyKey(a), `legacy split ${a}/${b}`).not.toBe(legacyKey(b));
      expect(playerIdentityKey(a), `fixed merges ${a}/${b}`).toBe(playerIdentityKey(b));
    }
  });
});
