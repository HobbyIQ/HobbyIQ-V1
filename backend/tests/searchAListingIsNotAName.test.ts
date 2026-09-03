import { describe, it, expect } from "vitest";
import { scoreCatalogRow, nameCandidateTokens } from "../src/services/catalog/catalogSearch.service.js";

// CF-SEARCH-A-LISTING-IS-NOT-A-NAME (2026-09-03). The identity-triangulation
// re-run put search -> same card at 42.0%, and TEN of its misses were
// "(no hit)" on cards whose catalog row exists, carries a full searchTokens
// array, and scores fine once it is fetched.
//
// The cause was never the scorer: `nameTokens` falls back to every alphabetic
// token when the caller passes no parsed playerName (the harness, and every
// raw-eBay-title caller), and the exact arm ANDs one ARRAY_CONTAINS per
// token. Measured read-only against card_catalog for the real miss
// "Freddie Freeman 2025 Bowman Chrome #33 Los Angeles Dodgers FREE SHIPPING":
//
//   freddie AND freeman                34,215 rows
//   freddie AND freeman AND dodgers        20 rows
//   freddie AND freeman AND shipping        1 row   -> and not this card
//
// so the arm returned nothing, the fuzzy arm ANDs the same prefixes and also
// returned nothing, and the search answered "no such card". Dropping the
// trailing " Los Angeles Dodgers FREE SHIPPING" from the same query returned
// the card as the top hit.
//
// These tests pin the SCORING half of the contract: listing noise must not
// change which row wins. The SQL half is pinned by the token-builder tests.
const tok = (q: string) => q.toLowerCase().replace(/[^a-z0-9#-]+/g, " ").replace(/#/g, "").trim().split(/\s+/).filter(Boolean);
const score = (q: string, row: Parameters<typeof scoreCatalogRow>[1]) => scoreCatalogRow(tok(q), row)?.score ?? -1;

const freeman = {
  setKey: "bowman-chrome", setName: "Bowman Chrome", cardNumber: "33", year: 2025,
  parallel: "Base", parallelSlug: "base", playerName: "Freddie Freeman",
  searchTokens: ["freddie", "freeman", "bowman", "chrome", "33", "2025", "base"],
};

describe("a listing is not a name", () => {
  it("the real miss still scores when the marketplace boilerplate is present", () => {
    // Not a ranking claim -- a survival claim. The row must not be rejected
    // by the hitFields floor just because the seller padded the title.
    const q = "Freddie Freeman 2025 Bowman Chrome #33 Los Angeles Dodgers FREE SHIPPING";
    expect(scoreCatalogRow(tok(q), freeman)).not.toBeNull();
  });

  it("a team name the checklist row does not carry must not beat the right card", () => {
    // The Dodgers row here is a DIFFERENT card that happens to carry the team
    // token. Freeman's own row says neither "los" nor "dodgers", and must
    // still win on the strength of the name and the number.
    const q = "Freddie Freeman 2025 Bowman Chrome #33 Los Angeles Dodgers FREE SHIPPING";
    const teamRow = {
      setKey: "bowman-chrome", setName: "Bowman Chrome", cardNumber: "140", year: 2025,
      parallel: "Base", parallelSlug: "base", playerName: "Team Card",
      searchTokens: ["los", "angeles", "dodgers", "bowman", "chrome", "140", "2025", "base"],
    };
    expect(score(q, freeman)).toBeGreaterThan(score(q, teamRow));
  });

  it("noise does not change the winner: same ranking with and without the boilerplate", () => {
    const clean = "Freddie Freeman 2025 Bowman Chrome #33";
    const noisy = "Freddie Freeman 2025 Bowman Chrome #33 Los Angeles Dodgers FREE SHIPPING";
    const other = {
      setKey: "bowman-chrome", setName: "Bowman Chrome", cardNumber: "34", year: 2025,
      parallel: "Base", parallelSlug: "base", playerName: "Freddie Freeman",
      searchTokens: ["freddie", "freeman", "bowman", "chrome", "34", "2025", "base"],
    };
    expect(score(clean, freeman)).toBeGreaterThan(score(clean, other));
    expect(score(noisy, freeman)).toBeGreaterThan(score(noisy, other));
  });
});

// The half that actually fixes the miss. These tokens are ANDed into Cosmos
// one ARRAY_CONTAINS apiece, so a word here that the catalog does not put on
// the card removes every row that IS the card -- a failure the scorer can
// never see, because it never receives those rows.
describe("a listing is not a name — the tokens that reach SQL", () => {
  it("marketplace boilerplate and team words are not name tokens", () => {
    const t = nameCandidateTokens(tok("Freddie Freeman 2025 Bowman Chrome #33 Los Angeles Dodgers FREE SHIPPING"));
    expect(t).toContain("freddie");
    expect(t).toContain("freeman");
    for (const noise of ["dodgers", "angeles", "free", "shipping"]) expect(t).not.toContain(noise);
  });

  it("a team word that is also a real name survives", () => {
    // The list is exact-match and deliberately omits every word that is a
    // person in card_catalog. Losing these would trade one empty page for
    // another, so each is pinned by name.
    expect(nameCandidateTokens(tok("Jalen Royals 2025 Panini Prizm #12"))).toContain("royals");
    expect(nameCandidateTokens(tok("Nick Yorke 2024 Bowman Chrome #BCP-40"))).toContain("yorke");
    expect(nameCandidateTokens(tok("Francisco Lindor 2024 Topps #55"))).toContain("francisco");
    expect(nameCandidateTokens(tok("Diego Cartaya 2023 Bowman #BCP-12"))).toContain("diego");
    expect(nameCandidateTokens(tok("Aliyah Boston 2023 Prizm #5"))).toContain("boston");
    expect(nameCandidateTokens(tok("Louis Oliver 2025 Score #88"))).toContain("louis");
  });

  it("noise is matched exactly, never by edit distance", () => {
    // The fuzzy tolerance that lets "bowmen" read as "bowman" must not reach
    // this list: at distance 1 "rays" swallows the Homestead "Grays" and
    // "ship" swallows the surname "Shipp".
    expect(nameCandidateTokens(tok("Homestead Grays 1993 Negro Leagues #12"))).toContain("grays");
    expect(nameCandidateTokens(tok("Bradley Shipp 2024 Bowman #BD-5"))).toContain("shipp");
  });

  it("the brand tolerance it must not disturb still holds", () => {
    // CF-SEARCH-ANCHOR-SELECTS-THE-CANDIDATES: a misspelled brand is still a
    // brand, so "bowmen" must not become the anchor over "carey".
    expect(nameCandidateTokens(tok("2026 bowmen owen carey"))).toEqual(["owen", "carey"]);
  });
});
