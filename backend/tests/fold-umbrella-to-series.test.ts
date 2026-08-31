/**
 * D39 CF-THE-UMBRELLA-FOLDS-ONTO-ITS-SERIES (Drew, 2026-08-31).
 *
 * The pure halves of the fold: which series product a TITLE names, and the
 * setKey-segment surgery that moves the row. The catalog gate is the script's
 * second gate and is exercised against live Cosmos, not here -- but the cases
 * that gate exists FOR (the OPC-Glossy sales whose numbers live in Series 2)
 * are pinned here as title verdicts, so a later widening of the title rules
 * cannot quietly start moving them on title evidence alone.
 */
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UMBRELLA_FOLDS, foldsFor, seriesFromTitle, identityParts, withSetKeySegment } =
  require("../scripts/fold-umbrella-to-series.cjs");

const UD = UMBRELLA_FOLDS["upper-deck"];
const name = (title: string) => seriesFromTitle(title, UD);

describe("foldsFor -- a fold is a ruling, not a guess", () => {
  it("knows the hockey umbrella Drew ruled on", () => {
    expect(foldsFor("upper-deck")?.map((r: any) => r.setKey)).toEqual([
      "o-pee-chee", "upper-deck-series-1", "upper-deck-series-2", "upper-deck-extended-series",
    ]);
  });

  it("refuses an umbrella nobody ruled on", () => {
    expect(foldsFor("topps")).toBeNull();
    expect(foldsFor("")).toBeNull();
    expect(foldsFor(null)).toBeNull();
  });
});

describe("seriesFromTitle -- the title names the product", () => {
  it("reads Series 1 and Series One, real pool titles", () => {
    expect(name("2024-25 Upper Deck Series 1 Quinn Hughes & Luke Hughes #199 Checklist 1-100"))
      .toMatchObject({ ok: true, setKey: "upper-deck-series-1" });
    expect(name("Lane Hutson Young Guns 2024-25 Upper Deck Series 1 Hockey 10/50"))
      .toMatchObject({ ok: true, setKey: "upper-deck-series-1" });
    expect(name("2024-25 Upper Deck Series One Hockey Connor Bedard"))
      .toMatchObject({ ok: true, setKey: "upper-deck-series-1" });
  });

  it("reads Series 2 and Series Two, real pool titles", () => {
    expect(name("2024-25 UPPER DECK SERIES 2 YOUNG GUNS RC #500 MACKLIN CELEBRINI/MICHKOV B337"))
      .toMatchObject({ ok: true, setKey: "upper-deck-series-2" });
    expect(name("2024 Upper Deck Series 2 Population Count 1000 /1000 Alex Ovechkin #PC-35 1ro1"))
      .toMatchObject({ ok: true, setKey: "upper-deck-series-2" });
  });

  it("reads Extended Series as its OWN product, never as Series 1 or 2", () => {
    const v = name("2024-25 Upper Deck Extended Series - Beehive Macklin Celebrini #BH-24 (RC)");
    expect(v).toMatchObject({ ok: true, setKey: "upper-deck-extended-series" });
    // The word "Series" is inside it; it must not also register as 1 or 2.
    expect(v.matched).toEqual(["upper-deck-extended-series"]);
  });

  it("reads O-Pee-Chee in its spellings", () => {
    expect(name("2024-25 O-Pee-Chee Connor Bedard #201")).toMatchObject({ ok: true, setKey: "o-pee-chee" });
    expect(name("2024-25 OPee Chee Hockey Sidney Crosby")).toMatchObject({ ok: true, setKey: "o-pee-chee" });
  });

  it("does NOT read 'Series 10' as Series 1", () => {
    // \b1\b: the boundary is why a two-digit number cannot match the one-digit rule.
    const v = name("2024-25 Upper Deck Series 10 Something #5");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("no-title-evidence");
  });

  it("refuses a title naming two products", () => {
    const v = name("2024-25 Upper Deck Series 1 & Series 2 Combo Lot");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("ambiguous-title");
    expect(v.matched).toEqual(["upper-deck-series-1", "upper-deck-series-2"]);
  });

  it("names no product for the other Upper Deck products in the umbrella", () => {
    // Measured 2026-08-31: 919 of 1,368 rows are these -- their own products,
    // which this fold must never touch.
    for (const t of [
      "2024-25 Upper Deck Synergy Red Mavrik Bourque Rookie Dallas Stars #102",
      "2024 Upper Deck Credentials Connor Bedard #98 Blue 049/299 TAG 10",
      "2024-25 Upper Deck MVP #88 Sidney Crosby",
      "Matthew Tkachuk 2024 Upper Deck Young Guns Renewed PSA 10 Exclusives /100",
      "2024 25 Upper Deck Mitch Marner Young Guns Achievement #YGA-12 Leafs",
      "2024 UPPER DECK AIMBOT SPECKLE #AB-22 SIDNEY CROSBY PENGUINS",
    ]) {
      expect(name(t)).toMatchObject({ ok: false, reason: "no-title-evidence" });
    }
  });

  it("a missing or empty title is no evidence, never a move", () => {
    expect(name("")).toMatchObject({ ok: false, reason: "no-title-evidence" });
    expect(seriesFromTitle(null, UD)).toMatchObject({ ok: false, reason: "no-title-evidence" });
    expect(seriesFromTitle(undefined, UD)).toMatchObject({ ok: false, reason: "no-title-evidence" });
  });

  it("the OPC-Glossy sales READ as o-pee-chee on the title alone -- which is why the catalog gate exists", () => {
    // Measured 2026-08-31: these `OPC-` numbers are listed by the checklist
    // under upper-deck-series-2, NOT under o-pee-chee. The title rule says
    // o-pee-chee; gate 2 then finds no o-pee-chee catalog row at that number
    // and the row stays put, counted ambiguous. This test pins the hazard so
    // the two-gate design is never collapsed into one.
    expect(name("2024-25 Upper Deck OPC Glossy Macklin Celebrini #OPC-34 Rookie RC PSA 10"))
      .toMatchObject({ ok: true, setKey: "o-pee-chee" });
  });
});

describe("identityParts / withSetKeySegment -- surgery, not a recompute", () => {
  it("parses a 7-segment identity row and an 8-segment print-run row", () => {
    expect(identityParts("hiq:hockey:2024:upper-deck:199:base:no-auto")).toHaveLength(7);
    expect(identityParts("hiq:hockey:2024:upper-deck:507:high-gloss:no-auto:num-10")).toHaveLength(8);
  });

  it("refuses anything that is not an identity row", () => {
    expect(identityParts("hiq:hockey:2024:upper-deck:199:base:no-auto:psa-10")).toBeNull(); // graded child
    expect(identityParts("hiq:hockey:2024:upper-deck:199:base")).toBeNull();                // short
    expect(identityParts("ch:12345")).toBeNull();                                            // vendor id
    expect(identityParts("")).toBeNull();
    expect(identityParts(null)).toBeNull();
  });

  it("replaces ONLY the setKey segment, leaving number, parallel, auto and print run", () => {
    expect(withSetKeySegment("hiq:hockey:2024:upper-deck:199:base:no-auto", "upper-deck-series-1"))
      .toBe("hiq:hockey:2024:upper-deck-series-1:199:base:no-auto");
    // The print run rides along untouched -- a fold is not a re-pricing.
    expect(withSetKeySegment("hiq:hockey:2024:upper-deck:507:high-gloss:no-auto:num-10", "upper-deck-extended-series"))
      .toBe("hiq:hockey:2024:upper-deck-extended-series:507:high-gloss:no-auto:num-10");
    // An auto stays an auto.
    expect(withSetKeySegment("hiq:hockey:2024:upper-deck:bh-24:base:auto", "upper-deck-extended-series"))
      .toBe("hiq:hockey:2024:upper-deck-extended-series:bh-24:base:auto");
  });

  it("returns null rather than corrupting a non-identity id", () => {
    expect(withSetKeySegment("ch:12345", "upper-deck-series-1")).toBeNull();
    expect(withSetKeySegment("hiq:hockey:2024:upper-deck:199:base:no-auto:psa-10", "upper-deck-series-1")).toBeNull();
  });
});
