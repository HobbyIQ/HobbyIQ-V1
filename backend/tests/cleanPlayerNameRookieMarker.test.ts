/**
 * CF-A-ROOKIE-MARKER-IS-NOT-PART-OF-THE-NAME (2026-09-19).
 *
 * Checklist sources write the rookie marker INSIDE the player cell --
 * "Jonah Tong RC" -- so playerSlugify mints `jonah-tong-rc` and the sibling
 * row of the SAME card number (a source that omits the marker) carries the
 * clean slug: one card split across two player identities. Measured
 * >=33,000 card_catalog rows across ~40 product-years carry a playerSlug
 * ending `-rc`. This pass strips the RC family only -- " RC", " RC*",
 * " (RC)" -- and deliberately leaves every other suffix shape (TC, UER,
 * SP/SSP, RR, DP, tier letters) for a follow-up ruling.
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

describe("what this pass refuses to touch", () => {
  it("a name that merely ENDS in those letters without the marker's shape is untouched", () => {
    expect(cleanPlayerName("Marc")).toBe("Marc");
    expect(cleanPlayerName("DuPRC")).toBe("DuPRC");
    expect(cleanPlayerName("Roscoe")).toBe("Roscoe");
  });

  it("J.R. Richard is untouched -- the token must be exactly RC, not a single R", () => {
    expect(cleanPlayerName("J.R. Richard")).toBe("J.R. Richard");
  });

  it("case-sensitive: lowercase 'rc' is not the marker", () => {
    expect(cleanPlayerName("Jonah Tong rc")).toBe("Jonah Tong rc");
  });

  it("team cards (TC) are left alone -- not a person, and not this defect", () => {
    expect(cleanPlayerName("New York Yankees TC")).toBe("New York Yankees TC");
  });

  it("UER (error card fact) is left alone", () => {
    expect(cleanPlayerName("Mike Trout UER")).toBe("Mike Trout UER");
  });

  it("SP / SSP are left alone -- may carry identity", () => {
    expect(cleanPlayerName("Jonah Tong SP")).toBe("Jonah Tong SP");
    expect(cleanPlayerName("Jonah Tong SSP")).toBe("Jonah Tong SSP");
  });

  it("RR (Rated Rookie) is left alone -- no existing code recognises it, follow-up needed", () => {
    expect(cleanPlayerName("Al Leiter RR")).toBe("Al Leiter RR");
    // Al Leiter RR RC -- only the RC family is stripped in this pass.
    expect(cleanPlayerName("Al Leiter RR RC")).toBe("Al Leiter RR");
  });

  it("DP (Draft Pick) is left alone -- follow-up needed", () => {
    expect(cleanPlayerName("Luis De Los Santos DP")).toBe("Luis De Los Santos DP");
    expect(cleanPlayerName("Luis De Los Santos DP RC")).toBe("Luis De Los Santos DP");
  });

  it("a bare tier letter before RC is left alone -- follow-up needed", () => {
    expect(cleanPlayerName("Rich Hunter B RC")).toBe("Rich Hunter B");
    expect(cleanPlayerName("Livan Hernandez G RC")).toBe("Livan Hernandez G");
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
});
