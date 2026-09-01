/**
 * Found via 2019 Bowman Chrome #BNR-VGJ (Drew, 2026-08-31). Sellers and
 * CardHedge both print CPA-BR as CPABR. sameCardNumber() has always called
 * those the same card (CF-THE-ID-CARRIES-THE-PRODUCT, D23 ruling d), but
 * isCardNumberAutoSubset() matched on the hyphen alone -- so the folded
 * spelling was tagged no-auto and split from its own hyphenated pool. The
 * auto flag must agree with identity.
 *
 * The guard that matters: only prefixes of 3+ characters fold. Folding the
 * 2-letter ones (BA/PA/RA/FA/TA/AA/AP) would make PARK, RARE, BASE and BATS
 * all read as autographs.
 */
import { describe, expect, it } from "vitest";
import { isCardNumberAutoSubset } from "../src/services/portfolioiq/parseTitleIdentity.service";
import { sameCardNumber } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("isCardNumberAutoSubset -- hyphen-insensitive, like every other card-number comparison", () => {
  const pairs: Array<[string, string]> = [
    ["CPABR", "CPA-BR"],
    ["CDAMV", "CDA-MV"],
    ["CDARG", "CDA-RG"],
    ["DCAJI", "DCA-JI"],
    ["FFARP", "FFA-RP"],
    ["GQASO", "GQA-SO"],
    ["BCPALGA", "BCPA-LGA"],
    ["CPAYA", "CPA-YA"],
  ];

  it.each(pairs)("%s is auto, exactly as %s is", (folded, hyphenated) => {
    expect(isCardNumberAutoSubset(hyphenated)).toBe(true);
    expect(isCardNumberAutoSubset(folded)).toBe(true);
  });

  it("the flag never disagrees with identity", () => {
    for (const [folded, hyphenated] of pairs) {
      expect(sameCardNumber(folded, hyphenated)).toBe(true);
      expect(isCardNumberAutoSubset(folded)).toBe(isCardNumberAutoSubset(hyphenated));
    }
  });

  // The reason the folded branch stops at 3-character prefixes.
  it.each(["PARK", "RARE", "BASE", "BATS", "TALL", "AARON", "APEX", "FAST", "PATCH"])(
    "%s is a word, not an autograph",
    (word) => {
      expect(isCardNumberAutoSubset(word)).toBe(false);
    },
  );

  // Real prod card numbers that are genuinely not autos.
  it.each(["RPSO", "NSSO", "HTSO", "VG", "SO", "NNO", "GOLD", "RC", "BNRVGJ", "BNR-VGJ"])(
    "%s stays no-auto",
    (cn) => {
      expect(isCardNumberAutoSubset(cn)).toBe(false);
    },
  );

  it("hyphenated non-auto prefixes are untouched", () => {
    for (const cn of ["IA-SO", "SF-SO", "PP-SO", "PZ-SO", "NC-SO", "RP-RA", "PP-SB"]) {
      expect(isCardNumberAutoSubset(cn)).toBe(false);
    }
  });
});
