// CF-DEX-BRIDGE-ALL-GENERATIONS (Drew, 2026-09-02, gap-close verdict).
//
// The tcgdexja lane's species vocabulary used to be a 251-entry Gen 1-2 array
// embedded in scrape-tcgdex-ja.cjs, and `dex <= GEN12.length` was the ceiling
// that capped every modern ruled JA set — sv8a covered 84 of 238 traded numbers,
// s12a 94 of 230, with the remainder refused by OUR array rather than missing
// from tcgdex. Uncapped: sv8a 166/238, s12a 222/230.
//
// The vocabulary is now DERIVED from the tcgdex EN corpus into
// data/pokemon-dex-bridge.json by scripts/fetchPokemonDexBridge.cjs. These tests
// pin the two properties that make that safe: the Gen 1-2 rows are unchanged,
// and the generations beyond them actually resolve.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = JSON.parse(
  fs.readFileSync(path.join(here, "..", "data", "pokemon-dex-bridge.json"), "utf8"),
) as { species: Record<string, string>; maxDexId: number; resolved: number };
const legacyGen12 = (JSON.parse(
  fs.readFileSync(path.join(here, "..", "scripts", "lib", "gen12-legacy.json"), "utf8"),
) as { species: string[] }).species;

describe("CF-DEX-BRIDGE-ALL-GENERATIONS", () => {
  /**
   * THE REGRESSION. Extending a vocabulary must not restate it. Every one of
   * the 251 Gen 1-2 species the lane shipped with has to survive the switch to
   * the derived table byte for byte, or ja-exclusive vintage — the lane's
   * original and still largest scope — silently re-keys.
   */
  it("leaves Gen 1-2 exactly as the lane shipped it", () => {
    expect(legacyGen12).toHaveLength(251);
    const drift = legacyGen12
      .map((want, i) => ({ dex: i + 1, want, got: bridge.species[String(i + 1)] }))
      .filter((r) => r.got !== r.want);
    expect(drift, `Gen 1-2 drift: ${JSON.stringify(drift.slice(0, 10))}`).toEqual([]);
  });

  it("resolves a species from every generation, which is the whole point", () => {
    // One per generation boundary. Gen 3-9 is exactly what the old ceiling refused.
    const cases: Array<[number, string, string]> = [
      [25, "pikachu", "gen 1"],
      [251, "celebi", "gen 2 — the old ceiling's last row"],
      [252, "treecko", "gen 3 — the first row it refused"],
      [387, "turtwig", "gen 4"],
      [495, "snivy", "gen 5"],
      [650, "chespin", "gen 6"],
      [722, "rowlet", "gen 7"],
      [810, "grookey", "gen 8"],
      [906, "sprigatito", "gen 9"],
      [1025, "pecharunt", "gen 9 — the corpus's last row"],
    ];
    for (const [dex, want, why] of cases) {
      expect(bridge.species[String(dex)], `dex ${dex} (${why})`).toBe(want);
    }
  });

  /**
   * The extractor reduces a printed card name to its species, and the two ways
   * that goes wrong are both silent. A name ending in the LETTERS "ex" is not
   * an ex card (Calyrex, Toxapex) and an unanchored suffix strip truncated them
   * to `calyr` / `toxap`; a decorated name must still vote for the bare species.
   */
  it("keeps species whose names end in a mechanic token intact", () => {
    expect(bridge.species["898"]).toBe("calyrex");
    expect(bridge.species["748"]).toBe("toxapex");
    expect(bridge.species["233"]).toBe("porygon2");
    expect(bridge.species["474"]).toBe("porygon-z");
  });

  it("votes the bare species even when the decorated print is more common", () => {
    // dex 1025 prints "Pecharunt ex" more often than bare "Pecharunt"; dex 1017
    // prints ONLY masked Ogerpon forms. Both must land the species.
    expect(bridge.species["1025"]).toBe("pecharunt");
    expect(bridge.species["1017"]).toBe("ogerpon");
    expect(bridge.species["890"]).toBe("eternatus");
  });

  it("spans the whole corpus with no holes", () => {
    expect(bridge.maxDexId).toBeGreaterThanOrEqual(1025);
    for (let d = 1; d <= bridge.maxDexId; d++) {
      expect(bridge.species[String(d)], `dex ${d} unresolved`).toBeTruthy();
    }
    // Every value is a usable slug — the lane writes these into the player
    // column and a non-slug would land in the catalog verbatim.
    for (const [dex, name] of Object.entries(bridge.species)) {
      expect(name, `dex ${dex}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});
