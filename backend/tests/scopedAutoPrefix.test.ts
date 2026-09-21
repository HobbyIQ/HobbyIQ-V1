/**
 * CF-SCOPED-AUTO-PREFIX (Drew, 2026-09-21). Re-measurement of #2091-adjacent
 * work: AC-/CRDA-/CHRU-/CLA- (2025 Topps Chrome Update Series), BSA2-/CCA2-/
 * WCDA-/FPA-/90AU-/90CAS- (2025 Topps), BMA-/RMA- (2026 Bowman Mega Box AND
 * 2026 Bowman Chrome Mega Box -- two DIFFERENT products, R75), IVA- (2026
 * Topps Chrome Black) are ALWAYS-AUTO product-years, confirmed by two
 * independent source-page reads plus a card_catalog source-tag split (every
 * no-auto row for these product-years traces to a known-defective source:
 * checklistinsider-2026-08-27/-29/-30, bccp, catalog-explode-actuals-
 * 2026-08-12 -- "the Insider layout mints autos unsigned"; every auto row
 * traces to checklistcenter-*, beckett-*, baseballcardpedia-*, or today's
 * checklistinsider-2026-09-21 re-scrape).
 *
 * The SAME letters recur as a DIFFERENT, genuinely-mixed product in other
 * years (2018-2024 "AC-" in topps-diamond-icons, base topps-chrome parallel
 * ladder for "CLA-" numbers, etc.) -- see #2091 blast-radius measurement
 * (2026-09-21): a global (unscoped) add false-positived 40-98% depending on
 * prefix. So the fix is a (sport, year, setKey) -> prefix table consulted
 * ADDITIVELY, never a widened global regex. Real titles here are pinned
 * verbatim from the sold_comps blast-radius sample -- these are the terse,
 * templated marketplace titles ("2025 Topps Baseball #BSA-SS Gold") that
 * carry NO player name or "Auto" word, which is why title text cannot
 * corroborate these products and the checklist/scope table has to carry the
 * signal instead.
 *
 * OMISSIONS CHECKED (review round 2): BSA-/CCAR-/PPA- are already on the
 * pre-existing GLOBAL list -- nothing to add. 90A- (bare, distinct from the
 * already-scoped 90AU-) is genuinely mixed even for 2025 topps -- real
 * non-defective no-auto rows exist (90A-JJ from cardhedge-graded, 90A-GSH/
 * 90A-BB from ingest-auto-seed) -- correctly left OUT of the table.
 */
import { describe, it, expect } from "vitest";
import {
  inferIsAuto,
  isCardNumberAutoSubset,
  parseListingIdentity,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { rederiveRow } from "../src/services/portfolioiq/slugRederivation.service.js";

describe("isCardNumberAutoSubset — scoped product-year prefixes (additive)", () => {
  it("unscoped call: unchanged from today (no scope arg at all)", () => {
    expect(isCardNumberAutoSubset("CRDA-IC")).toBe(false);
    expect(isCardNumberAutoSubset("CLA-SC")).toBe(false);
    expect(isCardNumberAutoSubset("BMA-MT")).toBe(false);
  });

  it("2025 Topps Chrome Update Series: AC-/CRDA-/CHRU-/CLA- resolve true only with scope", () => {
    const scope = { sport: "baseball", year: 2025, setKey: "topps-chrome-update-series" };
    for (const cn of ["AC-BI", "CRDA-IC", "CHRU-DB", "CLA-SC"]) {
      expect(isCardNumberAutoSubset(cn, null)).toBe(false);
      expect(isCardNumberAutoSubset(cn, scope)).toBe(true);
    }
  });

  it("2025 Topps (Series 1/2/Update fold into 'topps'): BSA2-/CCA2-/WCDA-/FPA-/90AU-/90CAS-", () => {
    const scope = { sport: "baseball", year: 2025, setKey: "topps" };
    for (const cn of ["BSA2-RS", "CCA2-AS", "WCDA-MW", "FPA-MIZ", "90AU-LA", "90CAS-FTH"]) {
      expect(isCardNumberAutoSubset(cn, scope)).toBe(true);
    }
  });

  it("2026 Bowman Mega Box (bare, no 'chrome' -- R75's `bowman-mega` key): BMA-/RMA-", () => {
    // The real 2026 product, resolved by real sold_comps titles like
    // "2026 Bowman Mega Box Baseball #BMA-KW Base" ->
    // hiq:baseball:2026:bowman-mega:bma-kw:base:no-auto. This carries the
    // overwhelming majority of 2026 BMA-/RMA- rows (1,777 / 242 catalog rows)
    // -- `bowman-chrome-mega-box` below is a SEPARATE, smaller product.
    const scope = { sport: "baseball", year: 2026, setKey: "bowman-mega" };
    expect(isCardNumberAutoSubset("BMA-KW", scope)).toBe(true);
    expect(isCardNumberAutoSubset("RMA-JC", scope)).toBe(true);
  });

  it("2026 Bowman CHROME Mega Box -- a distinct product, same BMA-/RMA- numbering (R75)", () => {
    const scope = { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" };
    expect(isCardNumberAutoSubset("BMA-KW", scope)).toBe(true);
    expect(isCardNumberAutoSubset("RMA-JC", scope)).toBe(true);
  });

  it("2026 Topps Chrome Black: IVA-", () => {
    const scope = { sport: "baseball", year: 2026, setKey: "topps-chrome-black" };
    expect(isCardNumberAutoSubset("IVA-CM", scope)).toBe(true);
  });

  it("case/hyphen-insensitive under scope, matching the global rule's own convention", () => {
    const scope = { sport: "baseball", year: 2025, setKey: "topps-chrome-update-series" };
    expect(isCardNumberAutoSubset("crda-ic", scope)).toBe(true);
    expect(isCardNumberAutoSubset("#CRDA-IC", scope)).toBe(true);
  });

  // THE PIN THE COORDINATOR ASKED FOR: same prefix, adjacent years, table has
  // no entry there -- falls back to whatever the global (title-driven only,
  // since these prefixes are not on the global list) rule already did.
  it("PINNED: the SAME prefixes in 2022-2024 stay unscoped / title-driven, not auto-by-prefix", () => {
    const years = [2022, 2023, 2024];
    const setKeys = ["topps-chrome-update-series", "topps-chrome", "topps"];
    // AC-/CLA-/CRDA-/CHRU-/BSA2-/CCA2-/WCDA-/FPA-/90AU-/90CAS-/BMA-/RMA-/IVA-
    // are NOT on the global list (BSA-/CCAR-/PPA- already are, unrelated to
    // this change, and would read true regardless of scope -- excluded here
    // on purpose). With no table entry for these (year, setKey) combos, they
    // must fall back to exactly today's false.
    for (const year of years) {
      for (const setKey of setKeys) {
        for (const cn of ["AC-EH", "CLA-JR", "CRDA-NY", "CHRU-CM", "BSA2-RS", "CCA2-AS", "WCDA-MW", "FPA-MIZ", "90AU-LA", "90CAS-FTH", "BMA-MT", "RMA-JC", "IVA-CM"]) {
          expect(isCardNumberAutoSubset(cn, { sport: "baseball", year, setKey })).toBe(false);
        }
      }
    }
  });

  it("a different sport/year/setKey combo not in the table never matches (no cross-scope leak)", () => {
    expect(isCardNumberAutoSubset("CRDA-IC", { sport: "football", year: 2025, setKey: "topps-chrome-update-series" })).toBe(false);
    expect(isCardNumberAutoSubset("CRDA-IC", { sport: "baseball", year: 2024, setKey: "topps-chrome-update-series" })).toBe(false);
    expect(isCardNumberAutoSubset("CRDA-IC", { sport: "baseball", year: 2025, setKey: "topps-chrome" })).toBe(false);
  });

  it("PINNED: BMA-/RMA- in OTHER 2026 products (not either Bowman Mega Box) stay unscoped", () => {
    // BMA-/RMA- also occur in topps-gypsy-queen and bowman-university-best --
    // genuinely different, non-auto-by-definition products sharing the
    // letters. No table entry for these (sport, year, setKey) triples.
    for (const setKey of ["topps-gypsy-queen", "bowman-university-best", "bowman", "bowman-chrome"]) {
      expect(isCardNumberAutoSubset("BMA-MT", { sport: "baseball", year: 2026, setKey })).toBe(false);
      expect(isCardNumberAutoSubset("RMA-JC", { sport: "baseball", year: 2026, setKey })).toBe(false);
    }
  });

  it("PINNED: the two 2026 Bowman Mega Box products do not leak into each other's OTHER prefixes", () => {
    // Both entries carry exactly BMA-/RMA- -- confirms the table key strings
    // ("bowman-mega" vs "bowman-chrome-mega-box") are truly distinct and
    // neither entry accidentally matches a prefix only the other product has.
    expect(isCardNumberAutoSubset("IVA-CM", { sport: "baseball", year: 2026, setKey: "bowman-mega" })).toBe(false);
    expect(isCardNumberAutoSubset("IVA-CM", { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" })).toBe(false);
  });

  describe("PINNED negative controls -- confusable prefixes NEVER read auto in these scopes", () => {
    // Explicitly requested by review round 2: CC-/CC2-/numeric CC-1..25 (a
    // non-auto City Connect relic set + "Companion Cards"), MLMD2- (unrelated
    // vocabulary), 90ASR- (the 90A- sibling insert, confirmed genuinely mixed
    // above), SMLB-/BST-/ES-/NT- (unrelated insert prefixes with no table
    // entry anywhere) must never read auto in the scopes this PR touches.
    const scopes = [
      { sport: "baseball", year: 2025, setKey: "topps-chrome-update-series" },
      { sport: "baseball", year: 2025, setKey: "topps" },
      { sport: "baseball", year: 2026, setKey: "bowman-mega" },
      { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" },
      { sport: "baseball", year: 2026, setKey: "topps-chrome-black" },
    ];
    const confusables = ["CC-1", "CC-25", "CC2-KW", "MLMD2-JC", "90ASR-JC", "SMLB-KW", "BST-MT", "ES-JC", "NT-KW"];
    for (const scope of scopes) {
      for (const cn of confusables) {
        it(`${cn} stays non-auto under ${scope.setKey}/${scope.year}`, () => {
          expect(isCardNumberAutoSubset(cn, scope)).toBe(false);
        });
      }
    }
  });

  it("missing scope fields (null/undefined sport, year, or setKey) never throw and read false", () => {
    expect(isCardNumberAutoSubset("CRDA-IC", {})).toBe(false);
    expect(isCardNumberAutoSubset("CRDA-IC", { sport: "baseball" })).toBe(false);
    expect(isCardNumberAutoSubset("CRDA-IC", { sport: "baseball", year: 2025 })).toBe(false);
    expect(isCardNumberAutoSubset(null, { sport: "baseball", year: 2025, setKey: "topps" })).toBe(false);
  });
});

describe("parseListingIdentity / inferIsAuto — real terse templated titles (no player name, no 'Auto' word)", () => {
  // Pinned verbatim from the 2026-09-21 blast-radius sold_comps sample.
  it("2025 Topps Chrome Update #AC-AH Aqua Wave Refractor — auto only when scoped", () => {
    const title = "2025 Topps Chrome Update Baseball #AC-AH Aqua Wave Refractor";
    const unscoped = parseListingIdentity(title);
    expect(unscoped.isAuto).toBe(false);
    const scoped = parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "topps-chrome-update-series" });
    expect(scoped.isAuto).toBe(true);
  });

  it("2025 Topps Chrome Update #CRDA-NY Base — auto only when scoped", () => {
    const title = "2025 Topps Chrome Update Baseball #CRDA-NY Base";
    expect(parseListingIdentity(title).isAuto).toBe(false);
    expect(
      parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "topps-chrome-update-series" }).isAuto,
    ).toBe(true);
  });

  it("2025 Topps Baseball #BSA2-RS Base — auto only when scoped to 'topps'", () => {
    const title = "2025 Topps Baseball #BSA2-RS Base";
    expect(parseListingIdentity(title).isAuto).toBe(false);
    expect(
      parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "topps" }).isAuto,
    ).toBe(true);
  });

  it("2026 Bowman Mega Box #RMA-JC Black & White Mojo Refractor — auto only when scoped to bowman-mega", () => {
    // Real title, real resolved setKey (R75: bare "Bowman Mega Box" with no
    // "chrome" -> bowman-mega, NOT bowman-chrome-mega-box).
    const title = "2026 Bowman Mega Box Baseball #RMA-JC Black & White Mojo Refractor";
    expect(parseListingIdentity(title).isAuto).toBe(false);
    expect(
      parseListingIdentity(title, undefined, { vertical: "baseball", year: 2026, setKey: "bowman-mega" }).isAuto,
    ).toBe(true);
    // The wrong scope (the sibling CHROME product) must not leak a positive.
    expect(
      parseListingIdentity("2026 Bowman Chrome Mega Box Baseball #RMA-JC Refractor", undefined, {
        vertical: "baseball", year: 2026, setKey: "bowman-chrome-mega-box",
      }).isAuto,
    ).toBe(true); // this one IS the chrome product's own table entry
  });

  it("2026 Topps Chrome Black #IVA-CM Base — auto only when scoped", () => {
    const title = "2026 Topps Chrome Black Baseball #IVA-CM Base";
    expect(parseListingIdentity(title).isAuto).toBe(false);
    expect(
      parseListingIdentity(title, undefined, { vertical: "baseball", year: 2026, setKey: "topps-chrome-black" }).isAuto,
    ).toBe(true);
  });

  it("inferIsAuto: scope threaded through resolves the same way as the service path", () => {
    expect(inferIsAuto({ sport: "baseball", cardNumber: "CRDA-IC", year: 2025, setKey: "topps-chrome-update-series" })).toBe(true);
    expect(inferIsAuto({ sport: "baseball", cardNumber: "CRDA-IC", year: 2024, setKey: "topps-chrome-update-series" })).toBe(false);
    expect(inferIsAuto({ sport: "baseball", cardNumber: "CRDA-IC" })).toBe(false);
  });

  it("a genuinely different 2024 product sharing the CLA- letters is untouched", () => {
    // 2024 topps-chrome CLA- numbers are a MIXED base/auto parallel ladder,
    // not the 2025/26 Chrome Update "Chrome Legends Autographs" insert --
    // no table entry, so title text alone still decides.
    const title = "2024 Topps Chrome Baseball #CLA-JR Black Refractor";
    expect(
      parseListingIdentity(title, undefined, { vertical: "baseball", year: 2024, setKey: "topps-chrome" }).isAuto,
    ).toBe(false);
  });
});

describe("END-TO-END through the write door: title -> written hobbyiqCardId ends ':auto...'", () => {
  // rederiveRow (slugRederivation.service.ts) is the pure, synchronous
  // function this PR wired scope into at ~line 293/346 -- it is also the
  // one identity-writing path in this PR that is unit-testable without a
  // live Cosmos client (persistVendorSalesToPool.test.ts's own header:
  // "mocking the CosmosClient here would double-implement the store's
  // guards" -- full Cosmos-integration tests for that path belong in a
  // downstream harness, not here). This proves the SAME scoped rule reaches
  // an actual written hobbyiqCardId, not just the parser's isAuto flag.
  it("2025 Topps Chrome Update #CRDA-IC Base: a malformed stored row is repaired to :auto by the title + scope", () => {
    const r = rederiveRow({
      // Deliberately fails the CURRENT-fields guard (sport null) so the
      // title-consult / re-derive branch runs -- the one this PR touched.
      sport: null,
      cardYear: 2025,
      setName: "Topps Chrome Update",
      cardNumber: "CRDA-IC",
      parallel: "Base",
      isAuto: false,
      title: "2025 Topps Chrome Update Baseball #CRDA-IC Base",
    });
    expect(r.action).toBe("rederived");
    expect(r.isAuto).toBe(true);
    expect(r.hobbyiqCardId).toMatch(/:auto(:|$)/);
    expect(r.hobbyiqCardId).not.toMatch(/:no-auto/);
  });

  it("2026 Bowman Mega Box #BMA-KW Base: repaired to :auto under the real bowman-mega scope", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2026,
      setName: "Bowman Mega Box",
      cardNumber: "BMA-KW",
      parallel: "Base",
      isAuto: false,
      title: "2026 Bowman Mega Box Baseball #BMA-KW Base",
    });
    expect(r.action).toBe("rederived");
    expect(r.isAuto).toBe(true);
    expect(r.hobbyiqCardId).toMatch(/:bowman-mega:/);
    expect(r.hobbyiqCardId).toMatch(/:auto(:|$)/);
  });

  it("2026 Topps Chrome Black #IVA-CM Base: repaired to :auto", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2026,
      setName: "Topps Chrome Black",
      cardNumber: "IVA-CM",
      parallel: "Base",
      isAuto: false,
      title: "2026 Topps Chrome Black Baseball #IVA-CM Base",
    });
    expect(r.action).toBe("rederived");
    expect(r.isAuto).toBe(true);
    expect(r.hobbyiqCardId).toMatch(/:auto(:|$)/);
  });

  it("a 2024 CLA- row (no table entry) is NOT force-flipped to auto by the write door", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2024,
      setName: "Topps Chrome",
      cardNumber: "CLA-JR",
      parallel: "Black Refractor",
      isAuto: false,
      title: "2024 Topps Chrome Baseball #CLA-JR Black Refractor",
    });
    expect(r.action).toBe("rederived");
    expect(r.isAuto).toBe(false);
    expect(r.hobbyiqCardId).toMatch(/:no-auto/);
  });

  it("negative controls stay non-auto through the write door too: CC-1, 90ASR-JC, SMLB-KW", () => {
    for (const [cardNumber, setName, cardYear] of [
      ["CC-1", "Topps", 2025],
      ["90ASR-JC", "Topps", 2025],
      ["SMLB-KW", "Topps Chrome Update", 2025],
    ] as const) {
      const r = rederiveRow({
        sport: null, cardYear, setName, cardNumber, parallel: "Base", isAuto: false,
        title: `${cardYear} ${setName} Baseball #${cardNumber} Base`,
      });
      expect(r.action, cardNumber).toBe("rederived");
      expect(r.isAuto, cardNumber).toBe(false);
    }
  });
});
