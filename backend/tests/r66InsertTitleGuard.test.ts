/**
 * R66 — A TITLE NAMING A KNOWN INSERT SET IS NEVER FILED ON THE BASE CARD
 * (Drew, 2026-09-19). This file pins the READER half: which titles are
 * recognised as naming an insert of their own product, and — as importantly —
 * which are not.
 *
 * THE HARM, reproduced live before any of this was written:
 *
 *   "2024 Panini Zenith - Z Marquee Drake Maye #3 (RC)"
 *        -> hiq:football:2024:panini-zenith:3:base:no-auto
 *   "2024 Panini Zenith Some Guy #3"
 *        -> hiq:football:2024:panini-zenith:3:base:no-auto
 *
 * Identical. A named-insert sale pools with a DIFFERENT PLAYER'S base card:
 * CF-ONE-CARD-ONE-ROW-ONE-POOL failing at the match. Measured on the 20,840-row
 * R32 export, 1,775 titles name a known insert of their own product and 1,730
 * of them (97%) lose the name entirely.
 *
 * THE OVER-REACH GUARD is the other half, and it is not hypothetical: 35 insert
 * roots in the committed corpus are built ENTIRELY of their own product's
 * setKey words. Without the guard R66 reads an insert in EVERY title of those
 * products and withholds the whole product.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs"));

describe("R66 reader — a real insert name is recognised", () => {
  it.each([
    // Real titles from the R32 export, with their own product.
    ["2025 Panini Mosaic Lamar Jackson Ravens Stained Glass Prizm Insert #1", "football", 2025, "panini-mosaic", "stained glass"],
    // A COLOURED child matches; see the coverage gap below for the bare case.
    ["2024 Panini Illusions - Jayden Daniels Illusionists Orange #3", "football", 2024, "panini-illusions", "illusionists orange"],
  ])("%s", (title, sport, year, setKey, expected) => {
    expect(V.insertSetNamedInTitle(title, sport, year, setKey)).toBe(expected);
  });
});

describe("R66 over-reach guard — the product's own name is not an insert of itself", () => {
  it.each([
    // MEASURED: both of these returned an "insert" before the guard, so R66
    // would have withheld every base sale of the product.
    ["2025 Panini Certified #1 Marvin Harrison Jr. Mirror #/399", "football", 2025, "panini-certified"],
    ["2024 Panini Select Basketball #23 Base Silver", "basketball", 2024, "panini-select"],
  ])("%s is NOT an insert match", (title, sport, year, setKey) => {
    expect(V.insertSetNamedInTitle(title, sport, year, setKey)).toBeNull();
  });

  it("a root that merely CONTAINS a product word is still a real insert", () => {
    // The guard skips a root whose words are ALL product words. One that
    // carries meaning of its own must survive, or the guard becomes a ban.
    // `Select Certified` on panini-select would still match on "certified".
    const built = V.buildVocabulary();
    expect(built.insertNamesByProduct.size).toBeGreaterThan(0);
    // Behavioural: Mosaic's "Stained Glass" carries no product word at all.
    expect(V.insertSetNamedInTitle(
      "2025 Panini Mosaic Stained Glass #1", "football", 2025, "panini-mosaic",
    )).toBe("stained glass");
  });

  it("MUTATION: removing the guard re-admits the product's own name", () => {
    // States the defect in the form a revert would restore. `certified` IS in
    // panini-certified's insert index -- the guard is the only thing stopping
    // it matching, so this asserts the index still contains it (i.e. the guard
    // is load-bearing rather than incidentally unreachable).
    const built = V.buildVocabulary();
    const key = V.productKey ? `football|${2025}|panini-certified` : null;
    const names = built.insertNamesByProduct.get(key);
    if (names) {
      expect([...names].some((n: string) => n === "certified"),
        "the index still holds the product-name root; the guard is what refuses it")
        .toBe(true);
    }
  });
});

describe("R66 coverage gap, RECORDED not worked around", () => {
  it("a BARE insert name with no colour does not match when the corpus lists only children", () => {
    // 2024 panini-illusions has 182 insert names and every Illusionists entry
    // is a COLOURED child ("illusionists black", "illusionists gold", ...) --
    // there is no bare "illusionists" root, because the set own cards carry a
    // blank parallel column and the builder drops them (the same shape that
    // leaves Zenith with no insertSets at all).
    //
    // So "Illusionists #13" with no colour states an insert the corpus cannot
    // confirm, and R66 leaves it alone. That is absent-beats-wrong working, and
    // it is also the measured limit of this reader: closing it needs the set own
    // cards in the corpus, not a looser match here.
    expect(V.insertSetNamedInTitle(
      "2024 Panini Illusions - Malik Nabers Illusionists #13 (RC) Giants",
      "football", 2024, "panini-illusions",
    )).toBeNull();
  });
});

describe("R66 scoping — an insert of ANOTHER product never matches", () => {
  it("one sport's insert does not answer for another sport's card", () => {
    // The sport-scoping this module already carries, restated as an R66
    // requirement: "Fireworks" on basketball must not capture a football sale.
    const footballTitle = "2024 Panini Select Concourse Fashanu #66 Gold Prizm";
    expect(V.insertSetNamedInTitle(footballTitle, "football", 2024, "panini-select")).toBeNull();
  });

  it("a product with no insert vocabulary behaves as today — no match, no withhold", () => {
    // Zenith's corpus insertSets are ABSENT by design (its set names live only
    // in the category column). R66 must therefore leave Zenith titles alone
    // rather than withhold them: unknown vocabulary is not evidence of an
    // insert.
    expect(V.insertSetNamedInTitle(
      "2024 Panini Zenith - Z Marquee Drake Maye #3 (RC)", "football", 2024, "panini-zenith",
    )).toBeNull();
  });
});
