// CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06, on hobby-iq.com,
// search "2023 mike trout" -> the card page):
//
//   2023 2023 Topps Heritage Mike Trout #74PB-1
//
// The catalog stores set names WITH their year on purpose. The defect was that
// the pricing wire handed a client that year-prefixed string beside a separate
// `year` field and left every client to remember to strip one. Four clients
// grew four private strips; the card page grew none.
//
// These pin the ONE strip and the ONE composer that replaced them. The most
// load-bearing assertion here is the mutation one at the bottom: it fails if
// the strip is deleted, which is what makes the rest of the file worth having.

import { describe, expect, it } from "vitest";
import { stripLeadingSetYear, composeCardTitle } from "../src/services/catalog/setNameYear.js";

describe("stripLeadingSetYear", () => {
  it("drops the year the catalog wrote into setName — Drew's row", () => {
    expect(stripLeadingSetYear("2023 Topps Heritage", 2023)).toBe("Topps Heritage");
    expect(stripLeadingSetYear("2020 Bowman Draft Baseball", 2020)).toBe("Bowman Draft Baseball");
    expect(stripLeadingSetYear("1952 Bowman Baseball", 1952)).toBe("Bowman Baseball");
  });

  it("drops a SEASON prefix too — basketball and hockey are season-dated", () => {
    // The shape none of the four earlier copies handled: a four-digit-only
    // strip leaves "2023 2023-24 Panini Prizm", the same defect with a hyphen.
    expect(stripLeadingSetYear("2023-24 Panini Prizm", 2023)).toBe("Panini Prizm");
    expect(stripLeadingSetYear("2023-2024 Panini Prizm", 2023)).toBe("Panini Prizm");
    expect(stripLeadingSetYear("2019-20 Panini Mosaic Basketball", 2019)).toBe("Panini Mosaic Basketball");
  });

  it("leaves a DIFFERENT leading year visible — the row disagrees with itself", () => {
    // Not a duplicate: the row's own year field says 2021 while its name says
    // 1952. Rendering "2021 1952 Topps" shows the disagreement, which is how it
    // gets found. Silently dropping the 1952 would launder a data defect.
    expect(stripLeadingSetYear("1952 Topps", 2021)).toBe("1952 Topps");
    expect(stripLeadingSetYear("2022-23 Panini Prizm", 2023)).toBe("2022-23 Panini Prizm");
  });

  it("only strips a LEADING year, never one embedded in the name", () => {
    expect(stripLeadingSetYear("Topps 1952 Redux", 2021)).toBe("Topps 1952 Redux");
    expect(stripLeadingSetYear("Topps Update 2024", 2024)).toBe("Topps Update 2024");
  });

  it("strips at most ONE year, so an already-doubled name still shows one", () => {
    expect(stripLeadingSetYear("2023 2023 Topps Heritage", 2023)).toBe("2023 Topps Heritage");
  });

  it("is idempotent — a name with no year is untouched", () => {
    expect(stripLeadingSetYear("Topps Heritage", 2023)).toBe("Topps Heritage");
    expect(stripLeadingSetYear(stripLeadingSetYear("2023 Topps Heritage", 2023), 2023)).toBe("Topps Heritage");
  });

  it("does nothing without a usable year, and survives empty input", () => {
    expect(stripLeadingSetYear("2023 Topps Heritage", null)).toBe("2023 Topps Heritage");
    expect(stripLeadingSetYear("2023 Topps Heritage", undefined)).toBe("2023 Topps Heritage");
    expect(stripLeadingSetYear("2023 Topps Heritage", "")).toBe("2023 Topps Heritage");
    expect(stripLeadingSetYear(null, 2023)).toBe("");
    expect(stripLeadingSetYear("   ", 2023)).toBe("");
  });

  it("accepts the year as a string, because wires carry both", () => {
    expect(stripLeadingSetYear("2023 Topps Heritage", "2023")).toBe("Topps Heritage");
  });
});

describe("composeCardTitle", () => {
  it("builds Drew's exact row with the year ONCE", () => {
    expect(
      composeCardTitle({
        year: 2023,
        setName: "2023 Topps Heritage",
        playerName: "Mike Trout",
        cardNumber: "74PB-1",
      }),
    ).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("prepends the year exactly once when setName does NOT carry one", () => {
    expect(
      composeCardTitle({
        year: 2023,
        setName: "Topps Heritage",
        playerName: "Mike Trout",
        cardNumber: "74PB-1",
      }),
    ).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("does not repeat the year on a split-year season product", () => {
    expect(
      composeCardTitle({
        year: 2023,
        setName: "2023-24 Panini Prizm",
        playerName: "Victor Wembanyama",
        cardNumber: "136",
      }),
    ).toBe("2023 Panini Prizm Victor Wembanyama #136");
  });

  it("carries the parallel, the auto flag and the print run", () => {
    expect(
      composeCardTitle({
        year: 2024,
        setName: "2024 Bowman Draft",
        playerName: "Theo Gillen",
        cardNumber: "CPA-TG",
        parallel: "Blue Refractor",
        isAuto: true,
        printRun: 150,
      }),
    ).toBe("2024 Bowman Draft Theo Gillen #CPA-TG Blue Refractor Auto /150");
  });

  it("treats 'Base' as no parallel — the absence of one says it", () => {
    expect(
      composeCardTitle({ year: 1987, setName: "1987 Topps", playerName: "Barry Bonds", cardNumber: "320", parallel: "Base" }),
    ).toBe("1987 Topps Barry Bonds #320");
  });

  it("omits every absent segment rather than printing it empty", () => {
    expect(composeCardTitle({ year: 2023, setName: "2023 Topps Heritage" })).toBe("2023 Topps Heritage");
    expect(composeCardTitle({ playerName: "Mike Trout" })).toBe("Mike Trout");
    expect(composeCardTitle({})).toBe("");
    // A zero print run is "no print run", not "/0".
    expect(composeCardTitle({ year: 2023, setName: "Topps", printRun: 0 })).toBe("2023 Topps");
  });

  // THE MUTATION TEST. If stripLeadingSetYear stops stripping — deleted,
  // short-circuited, or its regex de-escaped the way three earlier copies of
  // this fix were — this is the assertion that goes red. Every other test here
  // would still pass against a composer that simply never strips, because they
  // read as "the right answer" rather than "the wrong one is impossible".
  it("MUTATION: a composer that does not strip produces Drew's bug", () => {
    const unstripped = [2023, "2023 Topps Heritage", "Mike Trout", "#74PB-1"].join(" ");
    expect(unstripped).toBe("2023 2023 Topps Heritage Mike Trout #74PB-1");
    expect(
      composeCardTitle({
        year: 2023,
        setName: "2023 Topps Heritage",
        playerName: "Mike Trout",
        cardNumber: "74PB-1",
      }),
    ).not.toBe(unstripped);
  });
});
