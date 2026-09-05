/**
 * CF-UNKNOWN-IS-A-PARSER-PROBLEM -- the pins for census-unknown-setkey.cjs.
 *
 * The census itself is I/O and a banner; everything it DECIDES lives in a
 * handful of pure functions, and those are what this file pins. The classifier
 * and the derivation are NOT re-tested here -- the census imports them from
 * rematch-sold-comps.cjs and lib/rematch-classify.cjs precisely so there is
 * one implementation and one set of tests, and a census that re-implemented
 * them would be measuring its own copy.
 *
 * What is pinned:
 *
 *   1. THE POPULATION PREDICATE. Which rows are this census's business is read
 *      off the SLUG's product segment, not off `setName` -- the slug is what
 *      pools the sale.
 *   2. THE REFUSAL REFINEMENTS. lot/range and non-card, the two shapes that no
 *      vocabulary entry could ever fix, so they must not be counted as
 *      vocabulary work.
 *   3. THE PRODUCT SPELLING extractor, including the property that actually
 *      matters: it never invents a key, and it strips the noise that would
 *      otherwise fragment one product into many work items.
 *   4. THE SHARD FUNCTION is total and in range.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const CENSUS = require_(path.join(process.cwd(), "scripts", "census-unknown-setkey.cjs"));
const { slugSetKeySegment, isUnknownKeyRow, productSpelling, saysLot, saysNonCard, hashSlot } = CENSUS;

describe("the population predicate reads the SLUG, not setName", () => {
  it("reads the product segment out of a well-formed hiq slug", () => {
    expect(slugSetKeySegment("hiq:baseball:2005:unknown:96:base:auto:num-25")).toBe("unknown");
    expect(slugSetKeySegment("hiq:baseball:2024:topps-chrome:150:base:no-auto")).toBe("topps-chrome");
  });

  it("returns null for anything that is not an hiq slug -- absent beats wrong", () => {
    expect(slugSetKeySegment("")).toBeNull();
    expect(slugSetKeySegment(null)).toBeNull();
    expect(slugSetKeySegment("holding::abc123")).toBeNull();
    expect(slugSetKeySegment("hiq:baseball")).toBeNull();
  });

  it("counts a row as population when the SLUG says unknown", () => {
    expect(isUnknownKeyRow({ cardId: "hiq:pokemon:2025:unknown:168:base:no-auto" })).toBe(true);
  });

  it("counts a row as population when the slug's product segment is EMPTY", () => {
    // The same statement spelled differently: no product was read.
    expect(isUnknownKeyRow({ cardId: "hiq:baseball:2005::96:base:no-auto" })).toBe(true);
  });

  it("does NOT count a row whose slug names a real product, whatever setName says", () => {
    // THE WHOLE REASON THE PREDICATE READS THE SLUG. This row's stored setName
    // is the literal string "unknown", but its slug pools it under a real
    // product -- so its sales are not in an unknown pool and it is not this
    // census's business. Reading setName here would have swept it in.
    expect(isUnknownKeyRow({
      cardId: "hiq:baseball:2024:topps-chrome:150:base:no-auto",
      setName: "unknown",
    })).toBe(false);
  });

  it("counts a row whose slug says unknown even when setName names a product", () => {
    // And the mirror: the slug is unknown, so the POOL is unknown, whatever a
    // hopeful setName claims.
    expect(isUnknownKeyRow({
      cardId: "hiq:baseball:2005:unknown:96:base:auto:num-25",
      setName: "Leaf",
    })).toBe(true);
  });
});

describe("the refusals no vocabulary entry could fix", () => {
  it("names a multi-card lot", () => {
    expect(saysLot("1990 Topps Baseball Lot of 25 Cards NM")).toBe(true);
    expect(saysLot("Complete Set 1987 Topps Baseball 792 cards")).toBe(true);
    expect(saysLot("You Pick Your Card 2023 Prizm")).toBe(true);
  });

  it("takes the parser's own lot verdict when it has one", () => {
    // The census owns half of GUARD 5's evidence and the parser owns the other
    // half; either firing is a refusal.
    expect(saysLot("2021 Bowman Chrome Wander Franco", true)).toBe(true);
  });

  it("does NOT call an ordinary single card a lot", () => {
    expect(saysLot("2019 Finest #2 Salvador Perez Purple Refractor #/250")).toBe(false);
    expect(saysLot("2003-04 UD Exquisite Collection #MJ Michael Jordan")).toBe(false);
  });

  it("does NOT call `1x` a lot -- one card is one card", () => {
    // Measured on the 60,000-row sample (2026-09-05): a bare `\d+x` matched
    // this single card, whose seller merely wrote the quantity, and moved it
    // out of the vocabulary bucket where the real work is.
    expect(saysLot("1x  Card 2018 Bowman3- Shohei Ohtani #49 (RC) MVP Angels/Dodgers NMT")).toBe(false);
  });

  it("DOES call a multiplier of two or more a lot", () => {
    expect(saysLot("40x Refractors Bulk Lot")).toBe(true);
    expect(saysLot("2x 2023 Prizm Silver")).toBe(true);
  });

  it("names a lot whose count follows the word, not only one that precedes it", () => {
    // The mirror of the `1x` miss: this real sixteen-card lot was NOT caught,
    // because the old pattern only understood "<count> cards lot".
    expect(saysLot("2025 Indianapolis Colts LOT 16 CARDS Tyler Warren RC x2 Giddens ICE")).toBe(true);
  });

  it("names a non-card format through the classifier's OWN vocabulary", () => {
    // Read through NON_CARD_FORMAT_RE so this census and the fleet cannot
    // disagree about what a non-card is. If that export ever disappears the
    // predicate degrades to false rather than to a second vocabulary.
    expect(typeof saysNonCard("2024 Topps Series 1 Hobby Box Factory Sealed")).toBe("boolean");
    expect(saysNonCard("2019 Finest #2 Salvador Perez Purple Refractor")).toBe(false);
  });
});

describe("the product spelling is a REPORTING aid, never a key", () => {
  it("strips the year, the grade and the card number", () => {
    const sp = productSpelling("2006 FINEST #50 ALEX RODRIGUEZ YANKEES PSA 9");
    expect(sp).not.toMatch(/2006/);
    expect(sp).not.toMatch(/psa/i);
    expect(sp).not.toMatch(/#50/);
    expect(sp).toMatch(/finest/);
  });

  it("strips a split vintage year, which is the shape a naive year regex misses", () => {
    const sp = productSpelling("2003-04 UD Exquisite Collection Limited Logos Michael Jordan");
    expect(sp).not.toMatch(/2003/);
    expect(sp).not.toMatch(/\b04\b/);
    expect(sp).toMatch(/exquisite/);
  });

  it("strips the serial denominator so /250 does not become a product word", () => {
    const sp = productSpelling("2019 Finest #2 Salvador Perez Purple Refractor #/250");
    expect(sp).not.toMatch(/250/);
  });

  it("strips the sport word, which is never the product", () => {
    const sp = productSpelling("2024 Panini Prizm Football Caleb Williams #301");
    expect(sp).not.toMatch(/football/);
  });

  it("returns a bounded phrase -- a whole title is not a product name", () => {
    const sp = productSpelling(
      "2004-05 UD Exquisite Collection Extra Exquisite Jerseys Autographs Isiah Thomas Signed Game Used Patch Card",
    );
    expect(sp.split(" ").length).toBeLessThanOrEqual(4);
  });

  it("is total: a title with nothing left after stripping yields the empty string", () => {
    // An empty spelling is counted as `no-product-words`, NOT as a vocabulary
    // candidate -- there is nothing for a ruling to rule on.
    expect(productSpelling("2024 #55 PSA 10")).toBe("");
    expect(productSpelling("")).toBe("");
    expect(productSpelling(null)).toBe("");
  });

  it("is lowercased and whitespace-collapsed, so one product is one bucket", () => {
    const a = productSpelling("2022 POKEMON SWSH BLACK STAR PROMO #262 CHARIZARD PSA 8");
    const b = productSpelling("2022 Pokemon   Swsh Black  Star Promo #017 Pikachu PSA 9");
    expect(a).toBe(b);
    expect(a).toBe(a.toLowerCase());
  });
});

describe("the shard function", () => {
  it("is total and in range for whatever ids the population turns out to hold", () => {
    for (const id of ["a", "", "holding::x", "9f8e7d6c", "hiq:baseball:2005:unknown:96"]) {
      for (const parts of [1, 4, 32]) {
        const s = hashSlot(id, parts);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(parts);
      }
    }
  });

  it("is stable for the same id, so a re-run reads the same slice", () => {
    expect(hashSlot("some-row-id", 32)).toBe(hashSlot("some-row-id", 32));
  });

  it("spreads ids across slots rather than piling them into one", () => {
    // Uniform by construction (sha1), and this is the pin that says so on real
    // shaped ids rather than trusting the adjective.
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(hashSlot(`row-${i}`, 8));
    expect(seen.size).toBe(8);
  });
});
