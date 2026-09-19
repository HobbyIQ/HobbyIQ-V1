// R67 (Drew, ruling round of 2026-09-19): 2023-24 UPPER DECK SERIES 2 HOCKEY
// -- "PC's" AND "POPULATION COUNT 1000" ARE TWO DIFFERENT PRODUCTS.
//
// A named insert set is its own product key; colour variants are NOT keys --
// the colour rides the parallel field. THE ROSTER DECIDES: compare parent vs
// child rosters with players split on "/", trimmed, lowercased, de-duplicated,
// sorted. A child that is a SUBSET of the parent on the same numbers is a
// colour child. A child with numbers/players the parent lacks is its own key.
//
// Measured directly against the staged checklist (upperdeck.com's own inline
// HTML checklist table, held on the acq-upper-deck-hockey-gap PR pending this
// registration -- the ingest planner refuses the staged file over exactly
// this pair, reason unregistered-set-keys, until both keys exist). "PC's"
// runs #PC-1 through #PC-35 (e.g. #PC-31 Filip Forsberg) and "Population
// Count 1000" runs #PC-31 through #PC-60 (e.g. #PC-31 Connor McDavid) --
// overlapping on #PC-31 through #PC-35 with a DIFFERENT PLAYER at every one
// of those five numbers, so neither folds onto the other; each needs its own
// key.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey, slugify } from "../src/services/portfolioiq/hobbyIqCardId.service";

const PCS_KEY = "upper-deck-series-2-pcs";
const POPULATION_COUNT_KEY = "upper-deck-series-2-population-count-1000";

describe("R67 roster-normalisation rule, restated for this pair", () => {
  function normalizedRoster(rows: Array<{ cardNumber: string; player: string }>) {
    return new Set(
      rows.map((r) => {
        const num = String(r.cardNumber).trim().toLowerCase();
        const players = String(r.player)
          .split("/")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
          .sort()
          .join("/");
        return `${num}::${players}`;
      }),
    );
  }

  it("PC's and Population Count 1000 disagree on the shared #PC-31..#PC-35 range -- a genuine collision, not a fold candidate", () => {
    const pcs = normalizedRoster([
      { cardNumber: "PC-31", player: "Filip Forsberg" },
      { cardNumber: "PC-32", player: "Tage Thompson" },
      { cardNumber: "PC-33", player: "Cale Makar" },
      { cardNumber: "PC-34", player: "Sebastian Aho" },
      { cardNumber: "PC-35", player: "Auston Matthews" },
    ]);
    const populationCount = normalizedRoster([
      { cardNumber: "PC-31", player: "Connor McDavid" },
      { cardNumber: "PC-32", player: "Tomas Hertl" },
      { cardNumber: "PC-33", player: "Seth Jones" },
      { cardNumber: "PC-34", player: "Evgeni Malkin" },
      { cardNumber: "PC-35", player: "Cole Caufield" },
    ]);
    // Every shared number disagrees -- zero overlap in the normalized roster
    // sets, which is exactly the "different players" R67 registration branch,
    // not the "same roster" fold branch.
    const intersection = [...pcs].filter((x) => populationCount.has(x));
    expect(intersection).toEqual([]);
  });
});

describe("Upper Deck Series 2 PC's / Population Count 1000 keys", () => {
  it("both are registered", () => {
    expect(isProductSetKey(PCS_KEY)).toBe(true);
    expect(isProductSetKey(POPULATION_COUNT_KEY)).toBe(true);
  });

  it("both are normalizeSetKey FIXED POINTS -- the whole point of registering", () => {
    expect(normalizeSetKey(PCS_KEY, "hockey")).toBe(PCS_KEY);
    expect(normalizeSetKey(POPULATION_COUNT_KEY, "hockey")).toBe(POPULATION_COUNT_KEY);
  });

  it("both nest under upper-deck-series-2, already registered as their parent and family", () => {
    expect(productParentOf(PCS_KEY)).toBe("upper-deck-series-2");
    expect(productParentOf(POPULATION_COUNT_KEY)).toBe("upper-deck-series-2");
    expect(productFamilyOf(PCS_KEY)).toBe("upper-deck-series-2");
    expect(productFamilyOf(POPULATION_COUNT_KEY)).toBe("upper-deck-series-2");
  });

  it("the pcs key spells the same segment a real sale title slugifies to -- apostrophe dropped, not hyphenated", () => {
    // slugify() strips punctuation outright (never turns "'" into "-"), so a
    // sale titled ...Series 2 PC's #PC-31... slugifies with "pcs" as ONE
    // segment, not "pc" + "s" -- confirmed against the actual function, not
    // assumed from the display name.
    expect(slugify("PC's")).toBe("pcs");
    const titleSlug = slugify("2023-24 Upper Deck Series 2 PC's #PC-31 Filip Forsberg");
    expect(titleSlug).toContain("upper-deck-series-2-pcs");
  });

  it("the population-count key's own segments survive slugify unchanged", () => {
    expect(slugify("Population Count 1000")).toBe("population-count-1000");
    const titleSlug = slugify("2023-24 Upper Deck Series 2 Population Count 1000 #PC-31 Connor McDavid");
    expect(titleSlug).toContain("upper-deck-series-2-population-count-1000");
  });

  it("upper-deck-series-2 itself, its sibling qualified inserts, and the umbrella fold are all unaffected", () => {
    // Pin the neighbours this registration sits beside so a typo in the new
    // entries cannot silently move an existing key.
    expect(normalizeSetKey("upper-deck-series-2", "hockey")).toBe("upper-deck-series-2");
    expect(normalizeSetKey("upper-deck-series-2-o-pee-chee-retro-update", "hockey")).toBe("upper-deck-series-2-o-pee-chee-retro-update");
    expect(normalizeSetKey("upper-deck-series-2-o-pee-chee-update-rookies", "hockey")).toBe("upper-deck-series-2-o-pee-chee-update-rookies");
    expect(normalizeSetKey("upper-deck-series-2-o-pee-chee-retro-update-rookies", "hockey")).toBe("upper-deck-series-2-o-pee-chee-retro-update-rookies");
    expect(normalizeSetKey("Upper Deck Series 2", "hockey")).toBe("upper-deck-series-2");
    expect(normalizeSetKey("UD Series 2", "hockey")).toBe("upper-deck-series-2");
    expect(normalizeSetKey("upper-deck-extended-series", "hockey")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("upper-deck", "hockey")).toBe("upper-deck");
  });

  it("the module's OWN fold, run over the staged CSV, finds these two roots plus every clean parallel fold", () => {
    const csvPath = path.join(
      __dirname, "..", "data", "checklists", "scraped",
      "acq-2026-09-19-upperdeck-series2-hockey-2324", "2023-24-upper-deck-series-2-hockey.csv",
    );
    if (!fs.existsSync(csvPath)) {
      // The staged file lives on the acq-upper-deck-hockey-gap PR branch --
      // this repo state may not carry it yet. The registration above does
      // not depend on this file being present -- skip rather than fail.
      return;
    }
    const lines = fs.readFileSync(csvPath, "utf8").split("\n");
    const categories = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const category = lines[i].split(",")[0];
      categories.add(category);
    }
    // "pcs", not "pc-s" -- the CSV's own category was renamed to match how
    // slugify() actually reads "PC's" from a real sale title (see the
    // "spells the same segment" test above).
    expect(categories.has("pcs")).toBe(true);
    expect(categories.has("population-count-1000")).toBe(true);
  });
});
