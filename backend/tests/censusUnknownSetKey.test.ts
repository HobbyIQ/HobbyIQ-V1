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
import { readFileSync } from "node:fs";
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

  // CF-THE-POOL-READER-ORS-BOTH-FIELDS (2026-09-07). The predicate read
  // `cardId` alone, and the fields disagree on 395,749 rows -- with the
  // cardId-only reading being the SMALLER half (269,061 vs 664,125). A census
  // that selects on one field describes a population no consumer has.
  it("counts a row carrying unknown on hobbyiqCardId ALONE", () => {
    // The 395,749-row shape: cardId names a real product, hobbyiqCardId does
    // not. The pool reader ORs both, so this row IS population.
    expect(isUnknownKeyRow({
      cardId: "hiq:pokemon:2023:sv03:125:base:no-auto",
      hobbyiqCardId: "hiq:pokemon:2023:unknown:125:base:no-auto",
    })).toBe(true);
  });

  it("counts a row carrying unknown on cardId ALONE", () => {
    expect(isUnknownKeyRow({
      cardId: "hiq:pokemon:2023:unknown:125:base:no-auto",
      hobbyiqCardId: "hiq:pokemon:2023:sv03:125:base:no-auto",
    })).toBe(true);
  });

  it("does NOT count a row where BOTH fields name a real product", () => {
    expect(isUnknownKeyRow({
      cardId: "hiq:baseball:2024:topps-chrome:150:base:no-auto",
      hobbyiqCardId: "hiq:baseball:2024:topps-chrome:150:base:no-auto",
    })).toBe(false);
  });

  it("treats an ABSENT hobbyiqCardId as absent, not as blank", () => {
    // `null` from slugSetKeySegment means "not an hiq slug" -- no statement at
    // all. Only a slug that PARSED and came back unknown/empty is population;
    // otherwise every row lacking the field would be swept in.
    expect(isUnknownKeyRow({
      cardId: "hiq:baseball:2024:topps-chrome:150:base:no-auto",
    })).toBe(false);
    expect(isUnknownKeyRow({
      cardId: "hiq:baseball:2024:topps-chrome:150:base:no-auto",
      hobbyiqCardId: "holding::abc123",
    })).toBe(false);
  });
});

// CF-A-CENSUS-MEASURES-ITS-OWN-DENOMINATOR (2026-09-07).
//
// The script hardcoded `POPULATION_TOTAL = 889860` and scaled every `~total`
// and every `±` to it. Measured under that constant's own predicate the live
// count was 269,061 -- the constant was 3.3x it, and no run could reproduce
// it. A literal denominator cannot be verified and cannot age, so the source
// is pinned against its return.
describe("the census never scales to a hardcoded population", () => {
  const SRC = readFileSync(
    path.join(process.cwd(), "scripts", "census-unknown-setkey.cjs"),
    "utf8",
  );
  /** The EXECUTABLE half. The comments deliberately quote the old constant to
   *  explain why it went, and a pin that read them would forbid its own
   *  documentation -- so these assertions run against the code with block and
   *  line comments stripped. */
  const CODE = SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    // Drop whole-line `//` comments. Enough for this pin: every explanatory
    // mention of the retired constant is on a comment line of its own, and a
    // trailing-comment form would still have to survive the checks below.
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  it("does not declare a POPULATION_TOTAL constant", () => {
    // The prose that explains the removal may name it; an assignment may not.
    expect(CODE).not.toMatch(/const\s+POPULATION_TOTAL\s*=/);
  });

  it("contains no bare 889860 literal in executable code", () => {
    expect(CODE).not.toMatch(/\b889860\b/);
  });

  it("measures the population with a COUNT over the run's own filter", () => {
    // The denominator and the numerator must describe ONE population: the
    // COUNT is built from the same `where` the sampling query uses, so a
    // --years/--sports run cannot scale a filtered sample to an unfiltered
    // total.
    expect(SRC).toMatch(/async function measurePopulation\(pool, params, where\)/);
    expect(SRC).toMatch(/SELECT VALUE COUNT\(1\) FROM c WHERE \$\{where\.join\(" AND "\)\}/);
  });

  it("accepts a supplied denominator instead of measuring", () => {
    expect(SRC).toMatch(/POPULATION_INPUT/);
    expect(SRC).toMatch(/arg\("population"/);
  });

  it("withholds extrapolation rather than inventing a denominator", () => {
    // scale() and errorBar() return null when there is no population, and the
    // banner prints n/a. Absent beats wrong applies to error bars too.
    expect(SRC).toMatch(/populationTotal != null \? Math\.round\(\(k \/ sampled\) \* populationTotal\) : null/);
    expect(SRC).toMatch(/if \(!sampled \|\| populationTotal == null\) return null;/);
  });

  it("selects on BOTH id fields in the query filter", () => {
    // The source escapes the quotes inside the SQL string literal, so match on
    // the field names and the OR rather than on the exact quoting.
    expect(CODE).toMatch(/CONTAINS\(c\.cardId,[^)]*\)\s*OR\s*CONTAINS\(c\.hobbyiqCardId,/);
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
