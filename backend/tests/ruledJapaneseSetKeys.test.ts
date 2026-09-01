import { describe, it, expect } from "vitest";
import {
  normalizeSetKey,
  canonicalRuledSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { JAPANESE_POKEMON_SET_ALIASES } from "../src/services/catalog/japanesePokemonAliases.js";

// CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, rulings R1 + R2).
//
// The canonical setKey of a modern Japanese Pokemon set is its BARE OFFICIAL
// CODE. Two wrong spellings reached the pool and both are pinned here, along
// with the English products that must NOT be caught by the fix.
describe("ruled Japanese Pokemon setKeys (R2): the bare code is the key", () => {
  it("maps the three ruled japanese-<code> keys onto the bare code", () => {
    expect(normalizeSetKey("japanese-sv2a")).toBe("sv2a");
    expect(normalizeSetKey("japanese-sv8a")).toBe("sv8a");
    expect(normalizeSetKey("japanese-s12a")).toBe("s12a");
  });

  it("maps swsh12a — our own mistaken form — onto the real JA code s12a", () => {
    expect(normalizeSetKey("swsh12a")).toBe("s12a");
  });

  // THE NEGATIVE PINS. These are the reason the map is exact-token: a
  // startsWith/substring rule for swsh12a would swallow every one of them.
  it("leaves EN Silver Tempest (swsh12) alone — a DIFFERENT product", () => {
    expect(normalizeSetKey("swsh12")).toBe("swsh12");
  });

  it("leaves the EN Silver Tempest Trainer Gallery (swsh12tg) alone", () => {
    expect(normalizeSetKey("swsh12tg")).toBe("swsh12tg");
  });

  it("leaves sv3pt5 and base4 alone", () => {
    expect(normalizeSetKey("sv3pt5")).toBe("sv3pt5");
    expect(normalizeSetKey("base4")).toBe("base4");
  });

  it("does NOT blanket-strip a japanese- prefix: only the three ruled products move", () => {
    // R1's key keeps its NAME — no ruled rewrite touches it. (The leading
    // "1997-" is removed by the pre-existing stripYearAndSport rule, which is
    // orthogonal to R2: the slug carries the year in its own segment. What
    // matters here is that "japanese" survives and the key is not rewritten
    // onto some bare code.)
    expect(normalizeSetKey("1997-pokemon-japanese-rocket-gang"))
      .toBe("pokemon-japanese-rocket-gang");
    expect(canonicalRuledSetKey("1997-pokemon-japanese-rocket-gang"))
      .toBe("1997-pokemon-japanese-rocket-gang");
    expect(normalizeSetKey("japanese-rocket-gang")).toBe("japanese-rocket-gang");
    expect(canonicalRuledSetKey("japanese-rocket-gang")).toBe("japanese-rocket-gang");
  });

  it("is idempotent — a key already canonical passes through", () => {
    for (const k of ["sv2a", "sv8a", "s12a"]) expect(normalizeSetKey(k)).toBe(k);
  });

  it("canonicalRuledSetKey is exact-token and case/space tolerant", () => {
    expect(canonicalRuledSetKey("SWSH12A")).toBe("s12a");
    expect(canonicalRuledSetKey(" japanese-sv2a ")).toBe("sv2a");
    // near-misses stay put
    expect(canonicalRuledSetKey("swsh12")).toBe("swsh12");
    expect(canonicalRuledSetKey("swsh12tg")).toBe("swsh12tg");
    expect(canonicalRuledSetKey("swsh12a-promo")).toBe("swsh12a-promo");
    expect(canonicalRuledSetKey("")).toBe("");
    expect(canonicalRuledSetKey(null)).toBe("");
  });
});

// The alias table is what MINTS a key at ingest, so the rulings have to hold
// there too — otherwise the re-key is undone by the next Japanese sale.
describe("the alias table mints the ruled keys (R1 + R2 + R3)", () => {
  it("Paradigm Trigger mints the bare JA code s12, never the EN Silver Tempest key", () => {
    // R3. This one line pooled 22,585 rows of two different products: the JA
    // Paradigm Trigger set and the EN Silver Tempest set both answered swsh12.
    expect(JAPANESE_POKEMON_SET_ALIASES["paradigm-trigger"]).toBe("s12");
    expect(JAPANESE_POKEMON_SET_ALIASES["paradigm-trigger"]).not.toBe("swsh12");
  });

  it("VSTAR Universe mints s12a, never the invented swsh12a", () => {
    expect(JAPANESE_POKEMON_SET_ALIASES["vstar-universe"]).toBe("s12a");
  });

  it("Rocket Gang mints the JA key, never the EN Base Set 2 code", () => {
    // This one line minted 43,724 Japanese sales onto the English key.
    expect(JAPANESE_POKEMON_SET_ALIASES["rocket-gang"]).toBe("japanese-rocket-gang");
    expect(JAPANESE_POKEMON_SET_ALIASES["rocket-gang"]).not.toBe("base4");
  });

  it("no alias still points at the invented swsh12a code", () => {
    expect(Object.values(JAPANESE_POKEMON_SET_ALIASES)).not.toContain("swsh12a");
  });

  it("base4 is reachable only as the ENGLISH Base Set 2", () => {
    // The JA table must not name base4 at all any more.
    expect(Object.values(JAPANESE_POKEMON_SET_ALIASES)).not.toContain("base4");
  });
});

// End to end through the real mint path: a Japanese vendor title must land on
// the canonical code, and the English set of the same era must not move.
describe("resolveSetKeyForSlug lands Japanese sales on the ruled keys", () => {
  it("a JA VSTAR Universe title resolves to s12a", () => {
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Japanese Sword & Shield VSTAR Universe", 2022))
      .toBe("s12a");
  });

  it("a JA Rocket Gang title no longer resolves to the EN base4", () => {
    const got = resolveSetKeyForSlug("pokemon", "1997 Pokemon Japanese Rocket Gang", 1997);
    expect(got).not.toBe("base4");
    expect(got).toBe("japanese-rocket-gang");
  });

  it("the ENGLISH Silver Tempest is untouched by the swsh12a ruling", () => {
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Sword & Shield Silver Tempest", 2022))
      .toBe("swsh12");
  });

  it("the ENGLISH Base Set 2 still resolves to base4", () => {
    expect(resolveSetKeyForSlug("pokemon", "2000 Pokemon Base Set 2", 2000)).toBe("base4");
  });
});

// CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, ruling R3): the JA
// Paradigm Trigger set keys to the bare official code `s12`.
//
// R3 is the same doctrine as R2 but NOT the same repair, and the tests below
// are what hold the difference in place. R1/R2 rewrote keys nothing else
// owned (base4 was wrong for a JA set, swsh12a was never real). R3's wrong
// answer was `swsh12`, which is a LIVE, CORRECT key — it is EN Silver
// Tempest. So the fix moves the alias at the mint and adds NOTHING to
// RULED_SET_KEY_REWRITES; a rewrite of swsh12 would drag the English product
// onto the Japanese one. The negatives here are the proof of that restraint.
describe("ruled JA Paradigm Trigger (R3): the bare code s12 is the key", () => {
  it("a JA Paradigm Trigger title resolves to s12, not the EN Silver Tempest key", () => {
    const got = resolveSetKeyForSlug("pokemon", "2022 Pokemon Japanese Sword & Shield Paradigm Trigger", 2022);
    expect(got).toBe("s12");
    expect(got).not.toBe("swsh12");
  });

  it("covers the vendor spellings too — one alias entry, every variant", () => {
    for (const title of [
      "Pokemon Japanese Paradigm Trigger",
      "2022 Pokemon Japanese Paradigm Trigger",
      "2022 Pokemon Japanese Sword & Shield Paradigm Trigger",
    ]) {
      expect(resolveSetKeyForSlug("pokemon", title, 2022)).toBe("s12");
    }
  });

  // THE THREE NEGATIVE PINS Drew called out. R3 must be invisible to all of
  // them: swsh12 and swsh12tg are the ENGLISH Silver Tempest product and its
  // Trainer Gallery, and s12a is R2's Japanese VSTAR Universe — a different
  // set from s12 despite the one-character difference.
  it("leaves EN Silver Tempest (swsh12) alone — a DIFFERENT product", () => {
    expect(normalizeSetKey("swsh12")).toBe("swsh12");
    expect(canonicalRuledSetKey("swsh12")).toBe("swsh12");
    // and the English title itself must still mint it
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Sword & Shield Silver Tempest", 2022))
      .toBe("swsh12");
  });

  it("leaves the EN Silver Tempest Trainer Gallery (swsh12tg) alone", () => {
    expect(normalizeSetKey("swsh12tg")).toBe("swsh12tg");
    expect(canonicalRuledSetKey("swsh12tg")).toBe("swsh12tg");
  });

  it("leaves R2's s12a (JA VSTAR Universe) alone — s12 and s12a are two sets", () => {
    expect(normalizeSetKey("s12a")).toBe("s12a");
    expect(canonicalRuledSetKey("s12a")).toBe("s12a");
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Japanese Sword & Shield VSTAR Universe", 2022))
      .toBe("s12a");
  });

  it("s12 is a bare code and passes through the vocabulary untouched", () => {
    // No unanchored sports pattern may capture it, and no ruled rewrite moves
    // it: s12 is already canonical.
    expect(normalizeSetKey("s12")).toBe("s12");
    expect(canonicalRuledSetKey("s12")).toBe("s12");
  });

  it("R3 adds no swsh12 rewrite — the EN key is reachable and unmoved", () => {
    // If anyone ever adds "swsh12": ... to RULED_SET_KEY_REWRITES, this fails.
    expect(canonicalRuledSetKey("swsh12")).toBe("swsh12");
    expect(normalizeSetKey("swsh12")).toBe("swsh12");
  });
});
