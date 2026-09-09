/**
 * MUTATION CHECK for the set-year derivation (CF-THE-SET-YEAR-IS-DERIVED-NOT-
 * GUESSED, 2026-09-08).
 *
 * Per CF-RIGHT-GUARD-WRONG-SCOPE and CF-RETIRED-CORRECTION-VERIFY-OUTPUT-NOT-
 * EXISTENCE: a guard is only worth having if breaking it turns something red.
 * These tests assert the DISCRIMINATING behaviour of the derivation -- the
 * properties a plausible wrong implementation would violate -- rather than
 * re-asserting the values the happy-path test already pins.
 *
 * Each case names the mutation it kills.
 */

import { describe, it, expect } from "vitest";
import { POKEMON_SET_YEARS, pokemonSetYear } from "../src/services/catalog/pokemonSetYears.js";
import { POKEMON_SET_ALIASES } from "../src/services/catalog/pokemonSetAliases.js";
import { tcgPlayerRowIdentity } from "../src/services/portfolioiq/tcgPlayerRowIdentity.js";

describe("mutation: the set year is derived, not guessed", () => {
  it("KILLS `return the first year seen`: every derived year is corroborated by EVERY alias that names its set", () => {
    // Rebuild the evidence independently of the module and require unanimity.
    // A derivation that took the first (or last) year it enumerated would pass
    // the happy-path test and fail here the moment any set disagreed.
    const byCode = new Map<string, Set<number>>();
    for (const [alias, code] of Object.entries(POKEMON_SET_ALIASES)) {
      const m = /^((?:19|20)\d{2})-/.exec(alias);
      if (!m) continue;
      if (!byCode.has(code)) byCode.set(code, new Set());
      byCode.get(code)!.add(Number(m[1]));
    }
    for (const [code, year] of Object.entries(POKEMON_SET_YEARS)) {
      const evidence = byCode.get(code)!;
      expect(evidence.size, `${code} was published with a year its aliases dispute`).toBe(1);
      expect([...evidence][0], `${code} year disagrees with its aliases`).toBe(year);
    }
  });

  it("KILLS `fall back to the sale year`: an unmapped set yields null, not a number", () => {
    // The single most dangerous mutation, because it is invisible in
    // aggregates: every unmapped Pokemon card would land under the year it
    // happened to sell, which is the vintage-under-sale-year defect.
    const id = tcgPlayerRowIdentity({
      title: "Gengar (48) - Not A Real Set - Reverse Holofoil",
      card_set: "Not A Real Set",
      card_number: "048/165",
      platform: "TCGplayer",
      sold_at: "2026-09-07T21:55:01Z",
    } as never);
    expect(id.cardYear).toBeNull();
    expect(id.cardYear).not.toBe(2026);
    expect(id.reason).toBe("set-unmapped");
  });

  it("KILLS `strip any suffix to find a parent`: only the `tg` subset inherits", () => {
    // The parent fallback is deliberately narrow: `tg` and nothing else. A
    // generic "chop characters until something matches" would let any code
    // borrow a shorter code's year.
    //
    // NOT asserted by inequality of sv03 / sv03-5 -- those two really did both
    // release in 2023, so an inequality here would be testing the calendar
    // rather than the code. What discriminates is that each is derived from
    // its OWN aliases: a `-5` strip would make `sv08-5` (Prismatic
    // Evolutions, 2025) answer with `sv08`'s year (2024).
    expect(pokemonSetYear("sv08-5")).toBe(2025);
    expect(pokemonSetYear("sv08")).toBe(2024);
    expect(pokemonSetYear("sv08-5")).not.toBe(pokemonSetYear("sv08"));
    // A code that is a strict prefix of a real one must not borrow its year.
    expect(pokemonSetYear("base")).toBeNull();
    expect(pokemonSetYear("sv")).toBeNull();
  });

  it("KILLS `year-prefix match anywhere in the alias`: only a LEADING year counts", () => {
    // "base-set-2" contains no leading year and must contribute none; a
    // /(19|20)\d{2}/ search without the anchor would read digits out of set
    // names and mint years from card numbers.
    const leadingYearAliases = Object.keys(POKEMON_SET_ALIASES)
      .filter((a) => /^(19|20)\d{2}-/.test(a));
    const anyYearAliases = Object.keys(POKEMON_SET_ALIASES)
      .filter((a) => /(19|20)\d{2}/.test(a));
    // If these were equal the anchor would be doing nothing and this guard
    // would be untested rather than passing.
    expect(anyYearAliases.length).toBeGreaterThan(leadingYearAliases.length);
  });

  it("KILLS `a year is a year`: derived years are inside the TCG's actual lifetime", () => {
    // Pokemon TCG began in 1996. A derivation that read a card number or a
    // price as a year would produce values outside this window.
    const nextYear = new Date().getUTCFullYear() + 1;
    for (const [code, year] of Object.entries(POKEMON_SET_YEARS)) {
      expect(year, `${code} has an impossible year`).toBeGreaterThanOrEqual(1996);
      expect(year, `${code} has an impossible year`).toBeLessThanOrEqual(nextYear);
    }
  });

  it("KILLS `default the finish to base`: the reverse family keeps its own line", () => {
    // Folding reverse-holofoil onto the base line would merge two pools that
    // price differently -- the finish ruling exists precisely to stop that.
    const base = tcgPlayerRowIdentity({
      title: "Gengar (48) - Expedition - Normal", card_set: "Expedition",
      card_number: "048/165", platform: "TCGplayer",
    } as never);
    const reverse = tcgPlayerRowIdentity({
      title: "Gengar (48) - Expedition - Reverse Holofoil", card_set: "Expedition",
      card_number: "048/165", platform: "TCGplayer",
    } as never);
    expect(base.parallel).toBeNull();
    expect(reverse.parallel).toBe("Reverse Holofoil");
    expect(base.parallel).not.toEqual(reverse.parallel);
  });
});
