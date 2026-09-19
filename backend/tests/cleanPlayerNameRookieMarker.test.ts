/**
 * CF-A-ROOKIE-MARKER-IS-NOT-PART-OF-THE-NAME (2026-09-19; EXTENDED by RULING
 * R72, owner, 2026-09-19).
 *
 * Checklist sources write marker text INSIDE the player cell -- "Jonah Tong
 * RC" -- so playerSlugify mints `jonah-tong-rc` and the sibling row of the
 * SAME card number (a source that omits the marker) carries the clean slug:
 * one card split across two player identities. Measured >=33,000
 * card_catalog rows across ~40 product-years carry a playerSlug ending
 * `-rc`. The first pass stripped the RC family only; R72 extends it to RR
 * (Rated Rookie), DP (Draft Pick), TC (team card), UER (uncorrected error),
 * SP/SSP (short print) -- and a single tier letter immediately before an
 * RC-family marker ("Rich Hunter B RC" -> "Rich Hunter"). SP/SSP/UER can
 * still mark a genuinely DIFFERENT card (see cleanPlayerName's header and
 * playerIdentityKey.ts) -- that is a listing/review concern for the repair
 * lane and the fold guard, not something this string function can decide,
 * so it strips the token from the NAME (the person is the same person)
 * regardless.
 */
import { describe, expect, it } from "vitest";
import { cleanPlayerName, deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service";

describe("cleanPlayerName strips a trailing RC-family rookie marker", () => {
  it.each([
    ["Jonah Tong RC", "Jonah Tong"],
    ["Jonah Tong RC*", "Jonah Tong"],
    ["Jonah Tong (RC)", "Jonah Tong"],
    ["Mike Trout RC", "Mike Trout"],
    ["Shohei Ohtani  RC", "Shohei Ohtani"], // double space before the marker
  ])("%j -> %j", (raw, want) => {
    expect(cleanPlayerName(raw)).toBe(want);
  });

  it("is idempotent -- the clean spelling is a fixed point", () => {
    for (const n of ["Jonah Tong", "Mike Trout"]) {
      expect(cleanPlayerName(n)).toBe(n);
      expect(cleanPlayerName(cleanPlayerName(n))).toBe(n);
    }
  });

  it("converges: the marked and unmarked spellings of one player become ONE string", () => {
    expect(cleanPlayerName("Jonah Tong RC")).toBe(cleanPlayerName("Jonah Tong"));
  });

  it("strips a doubled marker in one call (repeated-safe)", () => {
    expect(cleanPlayerName("Jonah Tong RC RC")).toBe("Jonah Tong");
  });

  it("combines with the generational-suffix comma pass in the right order", () => {
    // "Bobby Witt, Jr. RC" -> comma pass fixes the suffix first -> "Bobby Witt Jr." ->
    // then the RC pass has nothing to strip (RC is not present) -- but a source
    // that puts RC after the raw comma-suffix spelling must still end up clean.
    expect(cleanPlayerName("Bobby Witt, Jr. RC")).toBe("Bobby Witt Jr.");
  });
});

describe("R72 -- RR, DP, TC, UER, SP, SSP and the tier-letter-before-RC are now stripped", () => {
  it("RR (Rated Rookie) is stripped, alone or stacked with RC in either order", () => {
    expect(cleanPlayerName("Al Leiter RR")).toBe("Al Leiter");
    expect(cleanPlayerName("Al Leiter RR RC")).toBe("Al Leiter");
  });

  it("DP (Draft Pick) is stripped, alone or stacked with RC", () => {
    expect(cleanPlayerName("Luis De Los Santos DP")).toBe("Luis De Los Santos");
    expect(cleanPlayerName("Luis De Los Santos DP RC")).toBe("Luis De Los Santos");
  });

  it("TC (team card) is stripped -- the TEAM is kept as the name", () => {
    expect(cleanPlayerName("New York Yankees TC")).toBe("New York Yankees");
  });

  it("UER (uncorrected error) is stripped", () => {
    expect(cleanPlayerName("Mike Trout UER")).toBe("Mike Trout");
  });

  it("SP / SSP (short print / super-short-print) are stripped", () => {
    expect(cleanPlayerName("Jonah Tong SP")).toBe("Jonah Tong");
    expect(cleanPlayerName("Jonah Tong SSP")).toBe("Jonah Tong");
  });

  it("a tier letter directly before an RC-family marker is stripped -- 1996 Topps Finest", () => {
    expect(cleanPlayerName("Rich Hunter B RC")).toBe("Rich Hunter");
    expect(cleanPlayerName("Livan Hernandez G RC")).toBe("Livan Hernandez");
    expect(cleanPlayerName("Mike Grace S RC")).toBe("Mike Grace");
  });

  it("a bare marker with no name at all reduces to empty, not to the marker text", () => {
    for (const marker of ["RC", "RC*", "(RC)", "RR", "DP", "TC", "UER", "SP", "SSP"]) {
      expect(cleanPlayerName(marker)).toBe("");
    }
  });
});

describe("what this pass still refuses to touch", () => {
  it("a name that merely ENDS in those letters without the marker's shape is untouched", () => {
    expect(cleanPlayerName("Marc")).toBe("Marc");
    expect(cleanPlayerName("DuPRC")).toBe("DuPRC");
    expect(cleanPlayerName("Roscoe")).toBe("Roscoe");
  });

  it("J.R. Richard is untouched -- the token must be exactly RC, not a single R", () => {
    expect(cleanPlayerName("J.R. Richard")).toBe("J.R. Richard");
  });

  it("case-sensitive: lowercase markers are not markers", () => {
    expect(cleanPlayerName("Jonah Tong rc")).toBe("Jonah Tong rc");
    expect(cleanPlayerName("Jonah Tong sp")).toBe("Jonah Tong sp");
    expect(cleanPlayerName("New York Yankees Tc")).toBe("New York Yankees Tc");
  });

  it("a bare tier letter with NO following RC-family marker is left alone -- never a bare initial strip", () => {
    expect(cleanPlayerName("Rich Hunter B")).toBe("Rich Hunter B");
    expect(cleanPlayerName("Livan Hernandez G")).toBe("Livan Hernandez G");
  });

  it("real names ending in the marker letters survive intact", () => {
    expect(cleanPlayerName("CC Sabathia")).toBe("CC Sabathia");
    expect(cleanPlayerName("J.P. Crawford")).toBe("J.P. Crawford");
    expect(cleanPlayerName("Chan Ho Park")).toBe("Chan Ho Park");
    expect(cleanPlayerName("Tommy La Stella")).toBe("Tommy La Stella");
    expect(cleanPlayerName("DJ LeMahieu")).toBe("DJ LeMahieu");
    expect(cleanPlayerName("A.J. Burnett")).toBe("A.J. Burnett");
    expect(cleanPlayerName("Warren Spahn")).toBe("Warren Spahn");
  });

  it("is null-safe and leaves an already-clean name alone", () => {
    expect(cleanPlayerName(null)).toBe("");
    expect(cleanPlayerName(undefined)).toBe("");
    expect(cleanPlayerName("Shohei Ohtani")).toBe("Shohei Ohtani");
  });
});

describe("the root cause closes at the ingest, not only in a repair script", () => {
  it("deriveCatalogEntry applies it, so no future ingest can mint a -rc playerSlug", () => {
    const e = deriveCatalogEntry({
      sport: "baseball", year: 2026, setKey: "topps", setName: "2026 Topps",
      cardNumber: "1", playerName: "Jonah Tong RC", parallel: "Base", printRun: null,
      source: "baseballcardpedia", isAuto: false, confidence: 0.9,
    } as Parameters<typeof deriveCatalogEntry>[0]);
    expect(e?.playerName).toBe("Jonah Tong");
    expect(e?.playerSlug).toBe("jonah-tong");
  });

  it("deriveCatalogEntry treats a cell that is ONLY a marker as no name -- refuses to mint", () => {
    const e = deriveCatalogEntry({
      sport: "baseball", year: 2026, setKey: "topps", setName: "2026 Topps",
      cardNumber: "1", playerName: "TC", parallel: "Base", printRun: null,
      source: "baseballcardpedia", isAuto: false, confidence: 0.9,
    } as Parameters<typeof deriveCatalogEntry>[0]);
    expect(e).toBeNull();
  });
});
