/**
 * CF-A-FINISH-TOKEN-IS-ONE-TOKEN (Drew, 2026-09-07).
 *
 * #1935 ruled that a Pokemon finish is a distinct card line, and its whole-pool
 * census found the market spelling ONE physical finish several ways:
 *
 *     reverse-holo   215,231      holofoil   3,915
 *     reverse-foil    71,094      holo         280
 *     reverse         12,712
 *
 * Five slug tokens for TWO cards. This PR folds them in the ONE slug seam --
 * `computeHobbyIqCardId`, where the deriver holds both the normalized parallel
 * and the row's sport -- gated on sport=pokemon.
 *
 * WHAT THESE TESTS PIN, and why each is here rather than left to review:
 *
 *   1. THE TABLE IS THE MINT LANE'S TABLE. `scripts/lib/pokemon-finish-vocab.cjs`
 *      is what `mint-attested-finish-rows` writes new catalog rows at. The slug
 *      seam is `src/` TypeScript and cannot import a `scripts/` .cjs, so the two
 *      tables are pinned EQUAL here. A mirror nothing compares is a second
 *      source of truth; a mirror a test compares is a cache. Drift in either
 *      direction turns this test red.
 *
 *   2. REVERSE NEVER FOLDS ONTO HOLO. The single most damaging thing this fold
 *      could do -- 215,231 reverse sales in a holo pool is a silent
 *      corpus-wide FMV corruption. Asserted as a FAMILY-WIDE property over the
 *      whole table, not as a spot check.
 *
 *   3. SPORTS ARE UNTOUCHED. "Gold Foil" is a real 1990s sports parallel and
 *      "Foil"/"Holo" are real sports finishes. The negatives are the reason the
 *      gate exists, so they are asserted through the LIVE slug builder on real
 *      sports identities -- not against the table, which a sports row never
 *      reaches.
 *
 *   4. A CANONICAL TOKEN IS A FIXED POINT. Re-deriving an already-folded slug
 *      must never move it again, or the rematch would chase its own tail.
 *
 *   5. THE PLURAL HEAD COVERS `holofoil`. Without it "Holofoils" slugs to
 *      `holofoils`, which is a sixth pool the fold table would have to carry
 *      and which every OTHER finish word in that regex already avoids.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  computeHobbyIqCardId,
  normalizeParallel,
  foldPokemonFinishToken,
  POKEMON_FINISH_TOKEN_FOLD_TABLE,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const require = createRequire(import.meta.url);
const VOCAB = require("../scripts/lib/pokemon-finish-vocab.cjs") as {
  FINISH_TOKENS: Record<string, string>;
  FINISH_DISPLAY: Record<string, string>;
};

/** The parallel segment of a slug: the one immediately before the auto flag. */
function parallelSegment(slug: string): string {
  const p = slug.split(":");
  for (let i = p.length - 1; i >= 2; i--) {
    if (p[i] === "auto" || p[i] === "no-auto") return p[i - 1]!;
  }
  throw new Error(`no auto flag in slug: ${slug}`);
}

const pokemon = (parallel: string) =>
  parallelSegment(computeHobbyIqCardId({
    sport: "pokemon", year: 2023, setKey: "sv03-5",
    cardNumber: "199", parallel, isAuto: false,
  }));

describe("CF-A-FINISH-TOKEN-IS-ONE-TOKEN -- the table is the mint lane's", () => {
  it("is EQUAL to scripts/lib/pokemon-finish-vocab.cjs, key for key", () => {
    // Not a subset in either direction. The mint lane writes rows at
    // FINISH_TOKENS' values and the pool addresses them through this table;
    // a key in one and not the other is a row minted at an address the pool
    // never derives, or a pool token nothing ever mints.
    expect(Object.keys(POKEMON_FINISH_TOKEN_FOLD_TABLE).sort())
      .toEqual(Object.keys(VOCAB.FINISH_TOKENS).sort());
    for (const [spelling, canonical] of Object.entries(VOCAB.FINISH_TOKENS)) {
      expect(POKEMON_FINISH_TOKEN_FOLD_TABLE[spelling], `${spelling} disagrees`).toBe(canonical);
    }
  });

  it("names holofoil and reverse-holofoil as THE canonical tokens", () => {
    // Chosen by the mint-lane vocabulary, NOT by pool row count: folding onto
    // the bigger pool token (reverse-holo, 215,231) would address every newly
    // minted row at a token the mint lane never writes.
    expect(foldPokemonFinishToken("holo")).toBe("holofoil");
    expect(foldPokemonFinishToken("reverse-holo")).toBe("reverse-holofoil");
    expect(new Set(Object.values(POKEMON_FINISH_TOKEN_FOLD_TABLE)))
      .toEqual(new Set(["holofoil", "reverse-holofoil", "cosmos-holo", "cracked-ice", "normal"]));
  });

  it("every canonical token is a FIXED POINT of the fold", () => {
    for (const canonical of new Set(Object.values(POKEMON_FINISH_TOKEN_FOLD_TABLE))) {
      expect(foldPokemonFinishToken(canonical), `${canonical} must not move`).toBe(canonical);
    }
  });

  it("every FINISH_DISPLAY name slugs to its own token THROUGH the live builder", () => {
    // The mint lane writes `parallel: "Reverse Holofoil"`; the pool must derive
    // `:reverse-holofoil:` from it or the row is minted at one address and
    // looked up at another.
    for (const [token, display] of Object.entries(VOCAB.FINISH_DISPLAY)) {
      expect(pokemon(display), `"${display}" must address ${token}`).toBe(token);
    }
  });
});

describe("REVERSE NEVER FOLDS ONTO HOLO -- a family-wide property", () => {
  it("maps every reverse-* spelling to a reverse-* token and to nothing else", () => {
    const reverse = Object.entries(POKEMON_FINISH_TOKEN_FOLD_TABLE)
      .filter(([k]) => k.startsWith("reverse"));
    expect(reverse.length).toBeGreaterThanOrEqual(7);
    for (const [k, v] of reverse) {
      expect(v, `${k} escaped the reverse family`).toBe("reverse-holofoil");
    }
  });

  it("maps no non-reverse spelling INTO the reverse family", () => {
    for (const [k, v] of Object.entries(POKEMON_FINISH_TOKEN_FOLD_TABLE)) {
      if (!k.startsWith("reverse")) {
        expect(v, `${k} leaked into the reverse family`).not.toBe("reverse-holofoil");
      }
    }
  });

  it("keeps the two pools apart through the live builder", () => {
    const holo = ["Holofoil", "Holo", "Holos", "Holo Rare", "Foil", "Foils"].map(pokemon);
    const rev = ["Reverse Holofoil", "Reverse Holo", "Reverse Foil", "Reverse", "Reverse Foils"].map(pokemon);
    expect(new Set(holo)).toEqual(new Set(["holofoil"]));
    expect(new Set(rev)).toEqual(new Set(["reverse-holofoil"]));
  });
});

describe("SPORTS KEEP EVERY TOKEN -- the gate is the point", () => {
  const sports = (sport: string, year: number, setKey: string, parallel: string) =>
    parallelSegment(computeHobbyIqCardId({
      sport, year, setKey, cardNumber: "12", parallel, isAuto: false,
    }));

  it("leaves a 1990s sports Gold Foil parallel exactly where it is", () => {
    // 1994 Topps Gold, Fleer Gold Foil. Folding this to `gold-holofoil` would
    // invent a card; folding it to `holofoil` would merge two products.
    expect(sports("baseball", 1994, "topps", "Gold Foil")).toBe("gold-foil");
    expect(sports("basketball", 1996, "fleer", "Foil")).toBe("foil");
  });

  it("leaves a sports Holo untouched -- Panini Optic's own word", () => {
    expect(sports("basketball", 2020, "donruss-optic", "Holo")).toBe("holo");
    expect(sports("football", 2021, "panini-prizm", "Reverse")).toBe("reverse");
  });

  it("folds the SAME words on a pokemon row and on no other vertical", () => {
    for (const sport of ["baseball", "basketball", "football", "hockey", "soccer", "yugioh"]) {
      expect(sports(sport, 2023, "topps", "Reverse Holo"), `${sport} must not fold`).toBe("reverse-holo");
      expect(sports(sport, 2023, "topps", "Holo"), `${sport} must not fold`).toBe("holo");
    }
    expect(pokemon("Reverse Holo")).toBe("reverse-holofoil");
    expect(pokemon("Holo")).toBe("holofoil");
  });
});

describe("the plural head covers holofoil", () => {
  it("slugs Holofoils to holofoil, not holofoils", () => {
    // Without `holofoil` in PLURAL_PARALLEL_HEAD this is a SIXTH pool.
    expect(normalizeParallel("Holofoils")).toBe("holofoil");
    expect(normalizeParallel("Reverse Holofoils")).toBe("reverse-holofoil");
  });

  it("does not fold a name whose singular is a different card", () => {
    // The closed-vocabulary guarantee this regex carries: "Stars" is not the
    // plural of a "Star" parallel.
    expect(normalizeParallel("Stars")).toBe("stars");
    expect(normalizeParallel("Rockets")).toBe("rockets");
  });
});
