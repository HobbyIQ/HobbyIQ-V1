// CF-CHROME-EDITION-IS-THE-PRODUCT (R64, Drew 2026-09-18).
//
// Drew's holding "2022 Topps Chrome Refractor Bobby Witt Jr. #221" (FMV
// $72.75) sat in a 15-row partition that pooled FOUR different cards. Every
// row's title named which one, but the title reader could not see two of the
// products: `inferSetKeyFromTitle` returned bare "Topps Chrome" for both Ben
// Baller and Sonic, because the line `if (/topps\s+chrome/) return "Topps
// Chrome"` answered first and never looked again.
//
// The slug layer was never the problem -- normalizeSetKey already knew both
// keys. The reader was.
//
//   MEASURED, the partition that started this:
//     1 row  Ben Baller   $97 raw
//     6 rows Sonic        $150-250 raw, PSA 8 $154.39, PSA 7 $150
//     6 rows Refractor    raw $224.75-250, PSA 10 $975.99 and $1,000
//     2 rows plain IV SP  PSA 10 $725 and $1,050   (PARKED, no checklist)
//
// Sonic raw clusters $150-250 against Refractor PSA 10s at $975+. One pool
// cannot price both.
//
// SONIC AND SONIC LITE ARE ONE PRODUCT -- verified, not assumed. Cardboard
// Connection's `2022-topps-chrome-sonic-baseball-cards` URL serves the LITE
// page ("Topps Chrome Sonic LITE bursts into hobby shops for the first time",
// 220-card base, SPs at 221-225); checklistcenter names it "2022 Topps Chrome
// Sonic Lite Baseball" with a 10-card Base Image Variation Set at 1:6399 --
// cards 35, 83, 113, 128, 133, 221, 222, 223, 224, 225 -- which is exactly
// BCP's "Gimmicks | 10 | - | 1:6399" from Ruling 23. And the catalog agrees:
// `topps-chrome-sonic-lite` holds 6,293 checklist-backed rows while
// `topps-chrome-sonic` holds ZERO.

import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";

const setKeyOf = (title: string, cardNumber: string | null = null): string =>
  normalizeSetKey(inferSetKeyFromTitle(title, cardNumber));

describe("R64: a Topps Chrome edition is the product, not a parallel", () => {
  it.each([
    // Every one of these is a REAL pool row title from the Witt #221
    // partition or the census that followed it.
    ["2022 Topps Chrome Ben Baller Bobby Witt Jr Rookie Card SP 221 Kansas City Royals", "topps-chrome-ben-baller"],
    ["ONeil Cruz 2022 Topps Chrome Ben Baller Black Rookie RC #128 SP PSA 10 GEM MINT", "topps-chrome-ben-baller"],
    ["2022 Topps Chrome Sonic - Image Variation #221 Bobby Witt Jr  Short Print RC - Raw 10", "topps-chrome-sonic-lite"],
    ["2022 TOPPS CHROME SONIC SP #221 BOBBY WITT JR ROOKIE RC PSA 8", "topps-chrome-sonic-lite"],
    ["Bobby Witt Jr 2022 Topps Chrome Sonic SP Rare PSA 7 NM Royals #221", "topps-chrome-sonic-lite"],
  ])("%s -> %s", (title, want) => {
    expect(setKeyOf(title)).toBe(want);
  });

  it("the Cruz title reaches Ben Baller, not Chrome Black", () => {
    // "Ben Baller Black" states the EDITION and then a parallel within it.
    // The edition rule sits above the Black rule for exactly this reason; if
    // the order ever flips, this row lands in the wrong product's pool.
    expect(setKeyOf("ONeil Cruz 2022 Topps Chrome Ben Baller Black Rookie RC #128 SP PSA 10 GEM MINT"))
      .toBe("topps-chrome-ben-baller");
  });

  it("MUTATION: the other Chrome editions and the flagship are unmoved", () => {
    // The new rules must be specialisations, not a hole. Every one of these
    // answered correctly before R64 and must still.
    expect(setKeyOf("2022 Topps Chrome Baseball #221 Base")).toBe("topps-chrome");
    expect(setKeyOf("2022 Topps Chrome Bobby Witt Jr. RC Refractor SP #221 Royals Rookie")).toBe("topps-chrome");
    expect(setKeyOf("2022 Topps Chrome MIKE TROUT Variation #200 Angels - Raw 10")).toBe("topps-chrome");
    expect(setKeyOf("2024 Topps Chrome Black #55 Base")).toBe("topps-chrome-black");
    expect(setKeyOf("2024 Topps Chrome Logofractor Baseball #55 Base")).toBe("topps-chrome-logofractor");
    expect(setKeyOf("2023 Topps Chrome Platinum Anniversary #1")).toBe("topps-chrome-platinum");
    expect(setKeyOf("2023 Topps Chrome Update Series #USC1")).toBe("topps-chrome-update-series");
  });
});

describe("R64: the two edition keys are registered products", () => {
  it("both are registered and are normalizeSetKey fixed points", () => {
    for (const k of ["topps-chrome-ben-baller", "topps-chrome-sonic-lite"]) {
      expect(isProductSetKey(k), `${k} registered`).toBe(true);
      expect(normalizeSetKey(k), `${k} fixed point`).toBe(k);
    }
  });

  it("each nests under Chrome so the matcher can still widen", () => {
    for (const k of ["topps-chrome-ben-baller", "topps-chrome-sonic-lite"]) {
      expect(productParentOf(k)).toBe("topps-chrome");
      expect(productFamilyOf(k)).toBe("topps-chrome");
    }
  });

  it("the `-edition` spelling folds into Ben Baller — one product, two spellings", () => {
    // Both spellings are fully checklist-backed over the SAME years from
    // DIFFERENT sources (7,301 checklistcenter vs 2,157 baseballcardpedia/
    // beckett). A source split is not a product split. Because the `-edition`
    // key is checklist-backed the census had made it a derived FIXED POINT, so
    // the fold is declared in RULED_ALIASES, where a decision outranks a
    // shape-derived verdict — the same shape as `bowman-sapphire-edition`.
    expect(normalizeSetKey("topps-chrome-ben-baller-edition")).toBe("topps-chrome-ben-baller");
    expect(setKeyOf("2022 Topps Chrome Ben Baller Edition #221")).toBe("topps-chrome-ben-baller");
  });

  it("the bare `sonic` spelling folds into Sonic Lite — there is no rival product", () => {
    // Not a collapse of a distinct release: `topps-chrome-sonic` holds ZERO
    // catalog rows, so there is nothing to collapse. Two published sources
    // describe one release under both names.
    expect(normalizeSetKey("topps-chrome-sonic")).toBe("topps-chrome-sonic-lite");
  });

  it("MUTATION: an unregistered Chrome key still collapses to the flagship", () => {
    expect(isProductSetKey("topps-chrome-nonesuch")).toBe(false);
    expect(normalizeSetKey("topps-chrome-nonesuch")).toBe("topps-chrome");
    // and the sapphire precedent this alias was modelled on is undisturbed
    expect(normalizeSetKey("bowman-sapphire-edition")).toBe("bowman-chrome-sapphire");
  });
});
