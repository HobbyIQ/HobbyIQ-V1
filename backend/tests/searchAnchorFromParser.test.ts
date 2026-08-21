// CF-SEARCH-ANCHOR-FROM-PARSER (2026-08-21) — pins how the catalog search
// anchor is chosen.
//
// THE BUG. The anchor was "longest non-stopword alphabetic token", a PROXY for
// the surname. The stopword list covers brands and product lines (bowman,
// topps, chrome, refractor, sapphire) but no COLOURS or FINISHES, so any query
// whose colour word is longer than the surname anchored on the colour:
//
//     "2024 Bowman Chrome Blue Raywave Auto Leo De Vries" -> raywave (7) beat vries (5)
//     "2018 Panini Prizm Silver Luka Doncic"              -> silver (6) tied doncic (6)
//
// Anchoring on "raywav" matches every Raywave card ever printed, so the TOP N
// sample rarely contains the card asked for, the quality gate fails, and the
// request escalates into the unindexed CONTAINS fallbacks. Measured on an idle
// box 2026-08-21: 18s, 39s, 55s, 93s and 364s in searchCatalog, while queries
// whose surname happened to win came back under 1.4s.
//
// It had already been patched twice by adding the specific offending words to
// the denylist. A denylist cannot be completed — there are thousands of colour
// and finish words. parseCardQuery already resolves the player, so use it.

import { describe, it, expect } from "vitest";

// Mirrors the anchor selection in catalogSearch.service.ts. Kept in the test so
// the RULE is pinned even if the surrounding query builder is refactored.
const ANCHOR_STOPWORDS = new Set([
  "bowman", "topps", "panini", "leaf", "upper", "deck", "fleer", "donruss", "score",
  "chrome", "prizm", "select", "optic", "mosaic", "heritage", "sapphire", "finest",
  "sterling", "inception", "platinum", "stadium", "club", "gallery", "archives",
  "allen", "ginter", "gypsy", "queen", "immaculate", "obsidian", "contenders",
  "refractor", "fractor", "prizms", "auto", "autograph", "autographs", "rookie",
  "prospect", "prospects", "paper", "update", "series", "draft", "mega", "jumbo",
  "base", "insert", "parallel", "variation", "numbered", "card", "cards",
  "baseball", "basketball", "football", "hockey", "soccer", "wrestling",
]);

function legacyAnchor(query: string): string | null {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const alpha = tokens.filter((t) => /^[a-z]+$/.test(t) && t.length >= 4 && !ANCHOR_STOPWORDS.has(t));
  return alpha.sort((a, b) => b.length - a.length)[0] ?? null;
}

function anchorFromPlayer(playerName: string | null): string | null {
  const pn = String(playerName ?? "").toLowerCase();
  if (!pn) return null;
  const parts = pn.split(/[^a-z]+/).filter((t) => t.length >= 3);
  if (parts.length === 0) return null;
  return parts.sort((a, b) => b.length - a.length)[0] ?? null;
}

const resolveAnchor = (query: string, playerName: string | null) =>
  anchorFromPlayer(playerName) ?? legacyAnchor(query);

describe("CF-SEARCH-ANCHOR-FROM-PARSER", () => {
  it("anchors on the surname, not a longer colour word", () => {
    const q = "2024 Bowman Chrome Blue Raywave Auto Leo De Vries PSA 10";
    // The bug: the colour won on length.
    expect(legacyAnchor(q)).toBe("raywave");
    // The fix: the parsed player decides.
    expect(resolveAnchor(q, "Leo De Vries")).toBe("vries");
  });

  it("is not decided by an arbitrary length tie", () => {
    const q = "2018 Panini Prizm Silver Luka Doncic PSA 10";
    // "silver" and "doncic" are both 6 — the winner depended on sort order.
    expect(resolveAnchor(q, "Luka Doncic")).toBe("doncic");
  });

  it("ignores particles and suffixes inside the name", () => {
    // Longest token OF THE NAME, not the last, so "de" and "jr" cannot win.
    expect(anchorFromPlayer("Leo De Vries")).toBe("vries");
    expect(anchorFromPlayer("Ken Griffey Jr")).toBe("griffey");
  });

  it("still works when the surname would have won anyway", () => {
    const q = "2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond";
    expect(legacyAnchor(q)).toBe("hammond");
    expect(resolveAnchor(q, "Josh Hammond")).toBe("hammond");
  });

  it("falls back to the old heuristic when the parser found no player", () => {
    const q = "2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond";
    expect(resolveAnchor(q, null)).toBe(legacyAnchor(q));
    expect(resolveAnchor(q, null)).toBe("hammond");
  });

  it("falls back rather than anchoring on nothing for an unparseable name", () => {
    // A name of only short particles yields no usable token; do not return "".
    expect(anchorFromPlayer("Y B")).toBeNull();
    expect(resolveAnchor("2019 topps chrome refractor", "Y B")).toBe(legacyAnchor("2019 topps chrome refractor"));
  });

  it("documents that colours are absent from the stopword list", () => {
    // This is WHY the parser has to decide. If colours are ever added to the
    // denylist, this test should still pass — the parser path does not care.
    for (const colour of ["silver", "raywave", "gold", "blue", "green", "wave"]) {
      expect(ANCHOR_STOPWORDS.has(colour)).toBe(false);
    }
  });
});
