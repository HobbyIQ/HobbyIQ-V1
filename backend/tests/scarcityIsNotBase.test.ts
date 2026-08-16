// CF-SCARCITY-IS-NOT-BASE (Drew, 2026-08-16, on "2018 Topps Ohtani Warm-Up
// Shirt SSP": "are we handling SSP of players? ... we need to add these things
// to the catalog and find others in the data like that. We need to fix it").
//
// We were not. A super-short-print photo variation parsed to parallel="Base"
// and therefore produced the SAME SLUG as the common base card, so an SSP that
// trades at a large multiple averaged into the base pool — inflating base FMV
// and deflating its own simultaneously.
//
// Measured across sold_comps on 2026-08-16, filed as parallel="Base":
//
//     SSP           48,034 of 75,822      SHORT PRINT   6,355 of 7,475
//     CASE HIT      27,915 of 33,900      PHOTO VAR.      826 of 1,465
//     IMAGE VAR.        10 of 11,839  (already handled)

import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const par = (t: string) => parseListingIdentity(t).parallel;

describe("CF-SCARCITY-IS-NOT-BASE — short prints do not pool with base", () => {
  it("Drew's card: the Warm-Up Shirt SSP is not the base card", () => {
    expect(par("2018 Topps Shohei Ohtani Warm-Up Shirt SSP #150")).toBe("SSP");
    expect(par("2018 Topps Shohei Ohtani #150 Base")).toBe("Base");
  });

  it("separates the other scarcity classes discovery turned up", () => {
    expect(par("2023 Panini Prizm Kaboom Case Hit Victor Wembanyama")).toBe("Case Hit");
    expect(par("2024 Topps Heritage Short Print #401 Mike Trout")).toBe("Short Print");
    expect(par("2022 Topps Photo Variation Julio Rodriguez #659")).toBe("Photo Variation");
  });

  // THE GUARD THAT MATTERS. Discovery over 20,000 Base-filed titles returned
  // "upper deck sp" as the single most common descriptor preceding an SP
  // marker (1,857) — ahead of every genuine scarcity term. "SP Authentic"
  // (11,146 rows) and "Upper Deck SP" (10,808) are PRODUCT LINES, not short
  // prints. Treating a bare "SP" as scarcity would have mislabelled ~22,000
  // sales into a tier that does not exist.
  it("SP as a BRAND is never mistaken for a short print", () => {
    expect(par("2001 SP Authentic Albert Pujols Rookie #123")).toBe("Base");
    expect(par("1994 Upper Deck SP Derek Jeter Foil #15")).toBe("Base");
    expect(par("2003 SP Legendary Cuts Babe Ruth #12")).toBe("Base");
    expect(par("2005 SP Game Used Patch Tom Brady")).toBe("Base");
  });

  // Scarcity and colour are different axes. Every colour/pattern rule runs
  // ABOVE this fallback, so a colour parallel that is also short-printed stays
  // the colour parallel — only cards with no parallel of their own, which is
  // exactly the set that was collapsing into Base, are re-tiered.
  it("a colour parallel is not overwritten by a scarcity word", () => {
    expect(par("2026 Bowman Chrome Eric Hartman Blue Refractor SSP #CPA-EHA")).toBe("Blue Refractor");
    expect(par("2023 Topps Chrome Gold Refractor Case Hit /50")).toBe("Gold Refractor");
  });

  it("Image Variation keeps its existing, more specific label", () => {
    expect(par("2023 Topps Chrome Corbin Carroll SSP Image Variation")).toBe("Image Variation");
  });

  it("a plain card with none of these words is still Base", () => {
    expect(par("2024 Topps Series 1 Aaron Judge #200")).toBe("Base");
  });
});
