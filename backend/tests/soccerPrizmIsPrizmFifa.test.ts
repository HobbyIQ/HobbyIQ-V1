/**
 * CF-SOCCER-PRIZM-IS-PRIZM-FIFA (Drew, 2026-09-05) -- pinned.
 *
 * The ruling: soccer 2025 sales keyed `panini-prizm` belong to
 * `panini-prizm-fifa`, where checklistinsider holds 30,773 strict rows. It is
 * a SPORT-SCOPED and YEAR-SCOPED resolution, NEVER a global alias --
 * `panini-prizm` is the correct, fixed-point key for FOOTBALL and BASKETBALL
 * Prizm, and a flat alias would move every NFL and NBA Prizm sale into a
 * soccer product.
 *
 * Each property below names the MUTATION that must turn it red, because a pin
 * that cannot fail is a comment.
 */
import { describe, expect, it } from "vitest";
import {
  spellForSport, spellForEra, isPrizmFifaCell, titleNamesOtherCompetition,
  PRIZM_FIFA_KEY, productParentOf, productFamilyOf, isProductSetKey,
} from "../src/services/catalog/productSetKeys";
import { resolveSetKeyForSlug, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("1. soccer 2025 Prizm resolves to Prizm FIFA", () => {
  it("a FIFA-stated soccer title resolves to panini-prizm-fifa", () => {
    expect(resolveSetKeyForSlug("soccer", "2025-26 Panini Prizm FIFA", 2025)).toBe(PRIZM_FIFA_KEY);
    expect(resolveSetKeyForSlug("soccer", "Panini Prizm FIFA Soccer", 2025)).toBe(PRIZM_FIFA_KEY);
  });

  it("a BARE soccer Prizm title in 2025 resolves there too -- Drew ruled the bare case", () => {
    // 98.8% of the pool is FIFA by title and Panini published no other
    // bare-Prizm soccer release that year.
    expect(resolveSetKeyForSlug("soccer", "2025-26 Panini Prizm Soccer", 2025)).toBe(PRIZM_FIFA_KEY);
    expect(resolveSetKeyForSlug("soccer", "Panini Prizm", 2025)).toBe(PRIZM_FIFA_KEY);
  });

  it("the destination is a declared product with the flagship as its parent", () => {
    expect(isProductSetKey(PRIZM_FIFA_KEY)).toBe(true);
    expect(productParentOf(PRIZM_FIFA_KEY)).toBe("panini-prizm");
    // Its OWN family: a FIFA card must not price off an NFL Prizm comp.
    expect(productFamilyOf(PRIZM_FIFA_KEY)).toBe(PRIZM_FIFA_KEY);
  });
});

describe("2. THE SPORT GATE -- football and basketball are untouched", () => {
  /** MUTATION: delete the sport check in spellForSport (make isPrizmFifaCell
   *  return true for any sport) and every expectation here goes red. */
  it("football 2025 Prizm stays panini-prizm", () => {
    expect(resolveSetKeyForSlug("football", "2025 Panini Prizm", 2025)).toBe("panini-prizm");
    expect(resolveSetKeyForSlug("football", "2025 Panini Prizm Football", 2025)).toBe("panini-prizm");
    expect(spellForSport("panini-prizm", "football", 2025)).toBe("panini-prizm");
  });

  it("basketball 2025 Prizm stays panini-prizm", () => {
    expect(resolveSetKeyForSlug("basketball", "2025 Panini Prizm", 2025)).toBe("panini-prizm");
    expect(resolveSetKeyForSlug("basketball", "2025-26 Panini Prizm Basketball", 2025)).toBe("panini-prizm");
    expect(spellForSport("panini-prizm", "basketball", 2025)).toBe("panini-prizm");
  });

  it("EVERY other sport is untouched in the ruled year", () => {
    for (const sport of ["football", "basketball", "baseball", "hockey", "wrestling", "racing"]) {
      expect(spellForSport("panini-prizm", sport, 2025), `${sport} must not move`).toBe("panini-prizm");
      expect(isPrizmFifaCell(sport, 2025)).toBe(false);
    }
  });
});

describe("3. THE YEAR GATE -- other soccer years are untouched", () => {
  /** MUTATION: widen PRIZM_FIFA_YEARS to every year (or drop the year check)
   *  and these go red. */
  it("soccer Prizm outside 2025 stays panini-prizm", () => {
    for (const y of [2021, 2022, 2023, 2024, 2026]) {
      expect(spellForSport("panini-prizm", "soccer", y), `soccer ${y}`).toBe("panini-prizm");
      expect(isPrizmFifaCell("soccer", y)).toBe(false);
    }
  });

  it("an absent or malformed year cannot decide, so it leaves the key alone", () => {
    expect(spellForSport("panini-prizm", "soccer", null)).toBe("panini-prizm");
    expect(spellForSport("panini-prizm", "soccer", undefined)).toBe("panini-prizm");
    expect(spellForSport("panini-prizm", "soccer", NaN)).toBe("panini-prizm");
  });
});

describe("4. the rule is NOT a global alias -- the vocabulary is unchanged", () => {
  /** MUTATION: add `panini-prizm -> panini-prizm-fifa` to the normalizeSetKey
   *  vocabulary (or to RULED_ALIASES) and this goes red -- which is exactly
   *  the wreckage Drew's constraint forbids. */
  it("normalizeSetKey is sport-blind and unchanged: the BARE key still spells the flagship", () => {
    // THE BARE CASE IS THE WHOLE GAP. A title that says only "Panini Prizm"
    // carries no qualifier, so the sport-blind vocabulary can only give the
    // flagship -- correct for FB/BK, wrong for soccer 2025. Only the deriver,
    // which knows the sport, can tell those apart, which is why the rule lives
    // there and NOT in normalizeSetKey.
    expect(normalizeSetKey("2025 Panini Prizm")).toBe("panini-prizm");
    expect(normalizeSetKey("panini-prizm")).toBe("panini-prizm");
  });

  it("an EXPLICIT FIFA title already resolved before this change -- and still does", () => {
    // Measured on the baseline 2026-09-05: `panini-prizm-fifa` is a RECONCILED
    // FIXED POINT (reconcileSetKey returns final:true), so it short-circuits
    // ahead of the unanchored /panini-prizm/ pattern that would otherwise
    // swallow the qualifier. This pin exists so a future reconciliation edit
    // that drops the fixed point is caught here rather than in a census.
    expect(normalizeSetKey("2025 Panini Prizm FIFA")).toBe("panini-prizm-fifa");
    expect(normalizeSetKey("panini-prizm-fifa")).toBe("panini-prizm-fifa");
    // Another competition's product likewise keeps its own spelling.
    expect(normalizeSetKey("2025 Panini Prizm Premier League")).toBe("panini-prizm-premier-league");
  });

  it("the SIBLING Prizm products keep their own keys in every sport", () => {
    expect(resolveSetKeyForSlug("basketball", "2025 Panini Prizm WNBA", 2025)).toBe("panini-prizm-wnba");
    expect(resolveSetKeyForSlug("football", "2025 Panini Prizm Draft Picks", 2025)).toBe("panini-prizm-draft-picks");
    // ...including inside the ruled cell: the rule only ever rewrites the
    // FLAGSHIP key, never a specialization that already resolved.
    expect(spellForSport("panini-prizm-draft-picks", "soccer", 2025)).toBe("panini-prizm-draft-picks");
    expect(spellForSport("panini-prizm-wnba", "soccer", 2025)).toBe("panini-prizm-wnba");
  });

  it("the era rules are untouched and still compose", () => {
    expect(spellForEra("panini-donruss", 1987)).toBe("donruss");
    expect(spellForEra("panini-score", 2025)).toBe("score");
    // A non-Prizm key is never touched by the sport rule, in any cell.
    for (const k of ["topps", "topps-chrome", "panini-select", "score", "donruss"]) {
      expect(spellForSport(k, "soccer", 2025), k).toBe(k);
    }
  });
});

describe("5. ABSENT BEATS WRONG -- another competition's product parks", () => {
  it("a title naming ANOTHER competition's product parks", () => {
    for (const t of [
      "2025-26 Topps UEFA Club Competitions - Quim Junyent #93 Purple Prizm /75",
      "2025-26 Panini Prizm Premier League Cole Palmer #12",
      "2024-25 Prizm La Liga Vinicius Jr #7",
      "2025 Panini Premier League Erling Haaland #9",
    ]) expect(titleNamesOtherCompetition(t), t).toBe(true);
  });

  /** THE MEASURED TRAP. Six pool titles read "Panini Prizm FIFA ... Real
   *  Madrid La Liga" -- a FIFA card whose title names the player's CLUB
   *  competition. MUTATION: make the predicate match a bare competition word
   *  anywhere (drop the adjacency to the product word, or drop the
   *  FIFA-wins-outright check) and these go red, parking genuine FIFA cards. */
  it("a league word describing the PLAYER'S CLUB does NOT park a FIFA card", () => {
    for (const t of [
      "2025-26 Panini Prizm FIFA Antoine Griezmann #2 Atletico Madrid La Liga SSP!",
      "Panini Prizm FIFA 2025-26 Jude Bellingham #186 Real Madrid La Liga Prizm",
      "Panini 2025-26 Prizm FIFA Sebastian Santos RC #211 /65 Club Leon Liga MX",
      "Panini Prizm FIFA 2025-26 Pedri FC Barcelona La Liga Soccer Ball SSP #244",
    ]) expect(titleNamesOtherCompetition(t), t).toBe(false);
  });

  /**
   * THE SIBLING-RELEASE TRAP, and the biggest thing the measurement caught.
   *
   * The id stem `hiq:soccer:2025:panini-prizm:` carries THREE products:
   * 30,773 catalog rows spelled `panini-prizm-fifa`, 18,230 spelled
   * `panini-prizm-fifa-club-world-cup`, and 4,111 spelled
   * `panini-prizm-k-league`. 496 of the 2,383 pool rows are Club World Cup by
   * title -- and those titles SAY "FIFA", so a predicate that stopped at the
   * FIFA word would fold two real products into one pool.
   *
   * MUTATION: remove the RX_SIBLING_FIFA_RELEASE check (or move it AFTER the
   * FIFA test, where the FIFA word short-circuits it) and this goes red.
   */
  it("a SIBLING FIFA-branded release parks, even though its title says FIFA", () => {
    for (const t of [
      "Panini 2025 Prizm FIFA Club World Cup Endrick Real Madrid #159 Gold Pulsar /199",
      "2025 Panini Prizm Club World Cup Wesley #109 purple pulsar /75",
      "2025 Panini Prizm FIFA Club World Cup Renan Lodi Signatures Auto #2 PSA 10",
      "2025 PANINI PRIZM CLUB WORLD CUP LEGENDARY TALENTS GIANLUIGI BUFFON #10",
      "2025 Panini Prizm K-League Jeon Jin-woo #44",
      "2025 Panini Prizm KLeague Silver #12",
    ]) expect(titleNamesOtherCompetition(t), t).toBe(true);
  });

  it("a title that says NOTHING contradicting does not park -- absent is not wrong", () => {
    for (const t of [
      "2025-26 Panini Prizm Soccer MIKE MAIGNAN /149 Red Prizm AC Milan #22",
      "2025-26 Panini Prizm Hugo Sanchez Penmanship Auto Real Madrid #2",
      "", null, undefined,
    ]) expect(titleNamesOtherCompetition(t as string), String(t)).toBe(false);
  });
});
