// #1954. The cleanliness canary's fragmentation axis, pinned.
//
// The axis was chronically red at 6.64% (run 34123049882, 2026-09-07) on rows
// that were RIGHT: it grouped by `(cardYear, setName, cardNumber)` — no
// parallel, no auto flag, no print run — so a card's parallels read as one
// identity written several ways. These tests pin the two directions that
// matters in: a distinct card is never fragmentation, and a spelling that a
// fold lane WOULD merge always is.

import { describe, it, expect } from "vitest";
import {
  fragmentationKey,
  scoreFragmentation,
  canonicalParallelToken,
} from "../src/services/portfolioiq/slugFragmentation";

/** Two slugs agree iff a fold lane would merge them. */
function merges(a: string, b: string, playerA = "Ada Lovelace", playerB = playerA): boolean {
  const ka = fragmentationKey({ hobbyiqCardId: a, playerName: playerA });
  const kb = fragmentationKey({ hobbyiqCardId: b, playerName: playerB });
  return ka !== null && ka === kb;
}

describe("a distinct card is never fragmentation", () => {
  // THE ROWS THAT MADE THE CANARY RED. Verbatim from the failing run's own
  // sample output — a named parallel is a distinct card, and Master Ball,
  // Poke Ball and the ordinary card are three cards at three prices.
  const base = "hiq:pokemon:2025:sv08-5:21:base:no-auto";
  const masterBall = "hiq:pokemon:2025:sv08-5:21:master-ball:no-auto";
  const pokeBall = "hiq:pokemon:2025:sv08-5:21:poke-ball:no-auto";

  it("Master Ball and Poke Ball are two cards, not one card fragmented", () => {
    expect(merges(masterBall, pokeBall)).toBe(false);
  });

  it("a named parallel is not a fragment of the card it parallels", () => {
    expect(merges(masterBall, base)).toBe(false);
    expect(merges(pokeBall, base)).toBe(false);
  });

  it("all three together score ZERO fragmentation", () => {
    const rows = [
      { hobbyiqCardId: base, playerName: "Charizard" },
      { hobbyiqCardId: masterBall, playerName: "Charizard" },
      { hobbyiqCardId: pokeBall, playerName: "Charizard" },
    ];
    const scored = scoreFragmentation(rows);
    expect(scored.considered).toBe(3);
    expect(scored.fragmentedRows).toBe(0);
    expect(scored.groups).toHaveLength(0);
  });

  it("the other two shapes from the red run are distinct too", () => {
    // X-Fractor vs Image Variation: two parallels of one card number.
    expect(merges(
      "hiq:baseball:2026:topps-chrome:274:x-fractor:no-auto",
      "hiq:baseball:2026:topps-chrome:274:image-variation:no-auto",
    )).toBe(false);
    // A finish IS a card line (#1935), so holofoil is not a fragment of base.
    expect(merges(
      "hiq:pokemon:2026:me05:85:base:no-auto",
      "hiq:pokemon:2026:me05:85:holofoil:no-auto",
    )).toBe(false);
  });

  it("print run is identity — a /499 is not a fragment of a /150", () => {
    expect(merges(
      "hiq:baseball:2023:bowman-draft:cda-ce:refractor:auto:num-499",
      "hiq:baseball:2023:bowman-draft:cda-ce:refractor:auto:num-150",
    )).toBe(false);
  });

  it("the auto flag is identity — an auto is not a fragment of its base", () => {
    expect(merges(
      "hiq:football:2022:donruss-optic:56:base:auto",
      "hiq:football:2022:donruss-optic:56:base:no-auto",
    )).toBe(false);
  });

  it("a grade tier is a pricing dimension with its own row, not a second address", () => {
    // CF-CARD-IDENTITY-VS-GRADE: the grade explode mints one row per (card,
    // grade) deliberately. A BGS 10 beside its raw parent is that design
    // working; no fold lane would merge them.
    expect(merges(
      "hiq:baseball:2021:topps:11:base:no-auto:bgs-10",
      "hiq:baseball:2021:topps:11:base:no-auto",
    )).toBe(false);
  });

  it("two different sports at one year+set+number are two cards", () => {
    // 1957 Topps #88 is Frank Gifford in football and Harvey Kuenn in baseball.
    expect(merges(
      "hiq:football:1957:topps:88:base:no-auto",
      "hiq:baseball:1957:topps:88:base:no-auto",
      "Frank Gifford", "Harvey Kuenn",
    )).toBe(false);
  });

  it("two different players at one address are not one card", () => {
    expect(merges(
      "hiq:baseball:2026:bowman:cpa-ag:base:auto",
      "hiq:baseball:2026:bowman:cpa-ag:base:auto",
      "Adrian Gil", "Angeibel Gomez",
    )).toBe(false);
  });
});

describe("a spelling a fold lane would merge IS fragmentation", () => {
  it("holo and holofoil are one Pokemon card (the #1937 fold)", () => {
    expect(merges(
      "hiq:pokemon:2026:me05:85:holo:no-auto",
      "hiq:pokemon:2026:me05:85:holofoil:no-auto",
    )).toBe(true);
  });

  it("every reverse spelling reaches reverse-holofoil", () => {
    for (const spelling of ["reverse", "reverse-holo", "reverse-foil", "reverse-holofoils"]) {
      expect(merges(
        `hiq:pokemon:2015:xy07:67:${spelling}:no-auto`,
        "hiq:pokemon:2015:xy07:67:reverse-holofoil:no-auto",
      )).toBe(true);
    }
  });

  it("reverse NEVER folds onto holo — that would be a corpus-wide FMV corruption", () => {
    expect(merges(
      "hiq:pokemon:2015:xy07:67:reverse-holofoil:no-auto",
      "hiq:pokemon:2015:xy07:67:holofoil:no-auto",
    )).toBe(false);
  });

  it("the Pokemon finish fold is gated on sport — a sports Foil is its own card", () => {
    // "Foil" is a real Skybox finish and "Holo" is Panini Optic's word. Folding
    // them on a baseball card would merge two real pools.
    expect(merges(
      "hiq:baseball:2018:topps:350:foil:no-auto",
      "hiq:baseball:2018:topps:350:holofoil:no-auto",
    )).toBe(false);
    expect(canonicalParallelToken("foil", "pokemon")).toBe("holofoil");
    expect(canonicalParallelToken("foil", "baseball")).toBe("foil");
  });

  it("α and Alpha are one card (#1930's player fold)", () => {
    const slug = "hiq:pokemon:2003:ecard3:H12:base:no-auto";
    expect(merges(slug, slug, "Miracle Sphere α", "Miracle Sphere Alpha")).toBe(true);
  });

  it("a cross-source spelling of one rung folds (D31)", () => {
    expect(merges(
      "hiq:baseball:2021:bowman-chrome:cpa-am:refractors-refractor:auto:num-499",
      "hiq:baseball:2021:bowman-chrome:cpa-am:refractor:auto:num-499",
    )).toBe(true);
  });

  it("the ingest spelling rules fold (raywave, xfractor)", () => {
    expect(merges(
      "hiq:baseball:2024:topps-chrome:66:raywave:no-auto",
      "hiq:baseball:2024:topps-chrome:66:ray-wave:no-auto",
    )).toBe(true);
  });

  it("a fragmented pair scores as fragmentation, and names both addresses", () => {
    const a = "hiq:pokemon:2026:me05:85:holo:no-auto";
    const b = "hiq:pokemon:2026:me05:85:holofoil:no-auto";
    const scored = scoreFragmentation([
      { hobbyiqCardId: a, playerName: "Pikachu" },
      { hobbyiqCardId: a, playerName: "Pikachu" },
      { hobbyiqCardId: b, playerName: "Pikachu" },
    ]);
    expect(scored.groups).toHaveLength(1);
    expect(scored.fragmentedRows).toBe(3);
    expect(new Set(scored.groups[0].slugs)).toEqual(new Set([a, b]));
  });
});

describe("the axis refuses to guess", () => {
  it("a row with no slug is not judged at all", () => {
    expect(fragmentationKey({ hobbyiqCardId: "", playerName: "x" })).toBeNull();
    expect(fragmentationKey({ hobbyiqCardId: null, playerName: "x" })).toBeNull();
  });

  it("an unparseable slug is excluded from BOTH numerator and denominator", () => {
    const scored = scoreFragmentation([
      { hobbyiqCardId: "not-a-hiq-slug", playerName: "x" },
      { hobbyiqCardId: "hiq:baseball:2024:topps:1:base:no-auto", playerName: "x" },
    ]);
    expect(scored.considered).toBe(1);
    expect(scored.fragmentedRows).toBe(0);
  });

  it("a card NUMBER that looks like a grade is not read as one", () => {
    // `psa-th2` lives in the card-number segment; a blind tail match would
    // wreck it. The slug parses whole, so nothing is stripped.
    const key = fragmentationKey({
      hobbyiqCardId: "hiq:football:2024:bowman:psa-th2:sky-blue:no-auto:num-499",
      playerName: "x",
    });
    expect(key).not.toBeNull();
    expect(key).toContain("psa-th2");
  });

  it("a tier is only stripped when what remains still parses", () => {
    // The parse is what confirms the tail was a tier. A bare `…:psa-10` with
    // nothing parseable in front of it is not a graded child of anything.
    expect(fragmentationKey({ hobbyiqCardId: "hiq:psa-10", playerName: "x" })).toBeNull();
    // And a real graded child keeps its tier in the key rather than losing it.
    const graded = fragmentationKey({
      hobbyiqCardId: "hiq:baseball:2021:topps:11:base:no-auto:bgs-10",
      playerName: "x",
    });
    expect(graded).toContain("bgs-10");
  });

  it("one slug with many rows is a card with sales, not a fragment", () => {
    const rows = Array.from({ length: 50 }, () => ({
      hobbyiqCardId: "hiq:baseball:2024:topps:1:base:no-auto",
      playerName: "Ada Lovelace",
    }));
    const scored = scoreFragmentation(rows);
    expect(scored.considered).toBe(50);
    expect(scored.fragmentedRows).toBe(0);
  });
});
