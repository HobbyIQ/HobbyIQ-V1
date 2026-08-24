import { describe, it, expect } from "vitest";
import { canonicalCardName, canonicalSetName, subsetFromCardNumber } from "../src/services/catalog/canonicalCardName.js";

/**
 * CF-ONE-NAME-FORMAT-FOR-EVERY-CARD (Drew, 2026-08-24).
 *
 *   "we want the SAME consistent format FOR all of our catalog"
 *   "going forward we want ALL format for ALL cards"
 *   "the eli willits should have autograph in it too, it is chrome prospect
 *    Autograph coming from CPA"
 *
 * The catalog held three formats for the same idea — "Base Set", "Bowman", and
 * "1952 Bowman Baseball" — because each ingest wrote names its own way. This
 * pins one.
 */
describe("canonical card name", () => {
  it("names Drew's card exactly, subset and print run included", () => {
    expect(canonicalCardName({
      year: 2025, setName: "Bowman Draft", setKey: "bowman-draft", sport: "baseball",
      cardNumber: "CPA-EW", playerName: "Eli Willits", parallel: "Yellow Refractor", printRun: 75,
    })).toBe("2025 Bowman Draft Baseball Chrome Prospect Autographs #CPA-EW Eli Willits Yellow Refractor /75");
  });

  it("omits the print run when there isn't one", () => {
    const n = canonicalCardName({
      year: 1949, setName: "1949 Bowman Baseball", setKey: "bowman", sport: "baseball",
      cardNumber: "77", playerName: "Ernie Bonham", parallel: "Base",
    });
    expect(n).toBe("1949 Bowman Baseball #77 Ernie Bonham Base");
    expect(n).not.toContain("/");
  });

  it("derives the subset from the card number when none is stored", () => {
    // CPA is Chrome Prospect Autograph. The card number always said so; nothing
    // read it. Longest prefix wins so BSPA is not read as BA.
    expect(subsetFromCardNumber("CPA-EW")).toBe("Chrome Prospect Autographs");
    expect(subsetFromCardNumber("BSPA-12")).toBe("Bowman Sterling Prospect Autographs");
    expect(subsetFromCardNumber("DPPA-3")).toBe("Draft Picks & Prospects Autographs");
    expect(subsetFromCardNumber("77")).toBeNull();
    expect(subsetFromCardNumber("BDC-72")).toBeNull();
  });

  it("prefers a stored subset over the derived one", () => {
    expect(canonicalCardName({
      year: 2025, setName: "2025 Bowman Draft", setKey: "bowman-draft", sport: "baseball",
      cardNumber: "CPA-EW", playerName: "Eli Willits", parallel: "Base",
      subsetName: "Chrome Prospect Autographs Gold Ink",
    })).toContain("Chrome Prospect Autographs Gold Ink");
  });

  it("NORMALISES a set name rather than merely defaulting it", () => {
    // These three shapes all existed in the catalog at once.
    expect(canonicalSetName({ year: 1952, setName: "1952 Bowman Baseball", setKey: "bowman", sport: "baseball" }))
      .toBe("1952 Bowman Baseball");                       // already good, kept verbatim
    expect(canonicalSetName({ year: 1951, setName: "Bowman", setKey: "bowman", sport: "baseball" }))
      .toBe("1951 Bowman Baseball");                       // year and sport added
    expect(canonicalSetName({ year: 1949, setName: "Base Set", setKey: "bowman", sport: "baseball" }))
      .toBe("1949 Bowman Baseball");                       // placeholder rebuilt
  });

  it("unifies parallel casing", () => {
    const lower = canonicalCardName({ year: 1951, setName: "1951 Bowman Baseball", cardNumber: "245", playerName: "John Berardino", parallel: "base" });
    const upper = canonicalCardName({ year: 1951, setName: "1951 Bowman Baseball", cardNumber: "245", playerName: "John Berardino", parallel: "Base" });
    expect(lower).toBe(upper);
  });

  it("does not stutter when the product name already contains the subset", () => {
    const n = canonicalCardName({
      year: 2025, setName: "2025 Bowman Chrome Prospect Autographs", setKey: "bowman-chrome",
      sport: "baseball", cardNumber: "CPA-EW", playerName: "Eli Willits", parallel: "Base",
    });
    expect(n.match(/Chrome Prospect Autographs/g)).toHaveLength(1);
  });

  it("degrades cleanly when fields are missing", () => {
    expect(canonicalCardName({ year: 1960, setKey: "topps", sport: "baseball", cardNumber: "1" }))
      .toBe("1960 Topps Baseball #1");
    expect(canonicalCardName({})).toBe("");
  });
});
