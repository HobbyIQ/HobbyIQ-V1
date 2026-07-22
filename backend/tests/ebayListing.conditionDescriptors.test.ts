// CF-EBAY-CONDITION-DESCRIPTORS-TESTS (Drew, 2026-07-22). Pins the
// conditionDescriptors[] shape sent to eBay's Sell Inventory API. This
// arc has been through multiple wire-shape iterations (PRs #663, #676,
// #684); tests catch envelope regressions before they reach a live
// publish call that costs an eBay item revision cycle.

import { describe, it, expect } from "vitest";
import {
  buildConditionDescriptors,
  type HoldingListingInput,
} from "../src/services/ebay/ebayListing.service.js";

function makeGraded(overrides: Partial<HoldingListingInput> = {}): HoldingListingInput {
  return {
    holdingId: "h-1",
    playerName: "Ethan Conrad",
    cardTitle: "2025 Bowman Draft Chrome Prospect Autographs Ethan Conrad #CPA-EC",
    cardYear: 2025,
    brand: "Bowman",
    setName: "Bowman Draft Chrome Prospect Autographs",
    product: "Bowman Draft Chrome Prospect Autographs",
    sport: "baseball",
    cardNumber: "CPA-EC",
    isAuto: true,
    isPatch: false,
    isRookie: true,
    gradingCompany: "PSA",
    grade: "10",
    certNumber: "157815694",
    quantity: 1,
    listingPrice: 199.75,
    bestOfferEnabled: false,
    ...overrides,
  };
}

function makeRaw(overrides: Partial<HoldingListingInput> = {}): HoldingListingInput {
  return {
    holdingId: "h-2",
    playerName: "Aaron Judge",
    cardTitle: "2017 Topps Archives Baseball Base Aaron Judge #62",
    cardYear: 2017,
    brand: "Topps",
    setName: "Topps Archives Baseball",
    product: "Topps Archives Baseball",
    sport: "baseball",
    cardNumber: "62",
    isAuto: false,
    isPatch: false,
    isRookie: false,
    conditionEstimate: "Near Mint or Better",
    quantity: 1,
    listingPrice: 113.14,
    bestOfferEnabled: false,
    ...overrides,
  };
}

describe("buildConditionDescriptors — GRADED path", () => {
  it("emits Professional Grader + Grade descriptors with enum value IDs", () => {
    const descriptors = buildConditionDescriptors(makeGraded());
    const grader = descriptors.find(d => d.name === "27501");
    const grade = descriptors.find(d => d.name === "27502");
    expect(grader).toBeDefined();
    expect(grader!.values).toEqual(["275010"]); // PSA → 275010
    expect(grade).toBeDefined();
    expect(grade!.values).toEqual(["275020"]);  // 10 → 275020
  });

  it("CF-CERT-DESCRIPTOR-ADDITIONAL-INFO: cert# uses additionalInfo envelope (not values array)", () => {
    // This is the fix from PR #684. Free-text descriptors like 27503
    // must use `additionalInfo`; putting the cert string in `values`
    // makes eBay try enum resolution → treats as NULL → errorId 25066.
    const descriptors = buildConditionDescriptors(makeGraded({ certNumber: "157815694" }));
    const cert = descriptors.find(d => d.name === "27503");
    expect(cert).toBeDefined();
    expect(cert!.additionalInfo).toBe("157815694");
    expect(cert!.values).toBeUndefined();
  });

  it("truncates cert# at 30 chars per eBay spec", () => {
    const descriptors = buildConditionDescriptors(
      makeGraded({ certNumber: "A".repeat(50) }),
    );
    const cert = descriptors.find(d => d.name === "27503");
    expect(cert!.additionalInfo).toHaveLength(30);
  });

  it("omits cert# descriptor entirely when certNumber is absent", () => {
    const descriptors = buildConditionDescriptors(makeGraded({ certNumber: undefined }));
    expect(descriptors.find(d => d.name === "27503")).toBeUndefined();
  });

  it("maps every supported grader to its enum ID", () => {
    const mappings: Array<[string, string]> = [
      ["PSA", "275010"],
      ["BGS", "275013"],
      ["SGC", "275016"],
      ["CGC", "275015"],
      ["HGA", "275019"],
    ];
    for (const [grader, expected] of mappings) {
      const descriptors = buildConditionDescriptors(makeGraded({ gradingCompany: grader }));
      const g = descriptors.find(d => d.name === "27501");
      expect(g!.values![0], `${grader} → ${expected}`).toBe(expected);
    }
  });

  it("unknown grader falls back to Other (2750123)", () => {
    const descriptors = buildConditionDescriptors(makeGraded({ gradingCompany: "MADEUP" }));
    const g = descriptors.find(d => d.name === "27501");
    expect(g!.values).toEqual(["2750123"]);
  });

  it("maps grade values to their enum IDs (half-grades included)", () => {
    const mappings: Array<[string, string]> = [
      ["10", "275020"],
      ["9.5", "275021"],
      ["9", "275022"],
      ["8.5", "275023"],
      ["1", "2750218"],
      ["6", "275028"],
    ];
    for (const [grade, expected] of mappings) {
      const descriptors = buildConditionDescriptors(makeGraded({ grade }));
      const g = descriptors.find(d => d.name === "27502");
      expect(g!.values![0], `${grade} → ${expected}`).toBe(expected);
    }
  });

  it("does NOT emit Card Condition (40001) descriptor on the graded path", () => {
    const descriptors = buildConditionDescriptors(makeGraded());
    expect(descriptors.find(d => d.name === "40001")).toBeUndefined();
  });
});

describe("buildConditionDescriptors — RAW / UNGRADED path", () => {
  it("emits Card Condition descriptor with enum value ID for Near Mint or Better", () => {
    const descriptors = buildConditionDescriptors(makeRaw({ conditionEstimate: "Near Mint or Better" }));
    const cc = descriptors.find(d => d.name === "40001");
    expect(cc).toBeDefined();
    expect(cc!.values).toEqual(["400010"]);
  });

  it("maps each Card Condition tier to its enum ID", () => {
    const mappings: Array<[string, string]> = [
      ["Near Mint or Better", "400010"],
      ["Excellent",           "400011"],
      ["Very Good",           "400012"],
      ["Poor",                "400013"],
    ];
    for (const [tier, expected] of mappings) {
      const descriptors = buildConditionDescriptors(makeRaw({ conditionEstimate: tier }));
      const cc = descriptors.find(d => d.name === "40001");
      expect(cc!.values![0], `${tier} → ${expected}`).toBe(expected);
    }
  });

  it("defaults to Near Mint or Better when conditionEstimate is absent", () => {
    const descriptors = buildConditionDescriptors(makeRaw({ conditionEstimate: undefined }));
    const cc = descriptors.find(d => d.name === "40001");
    expect(cc!.values).toEqual(["400010"]);
  });

  it("fuzzy-matches common raw condition abbreviations to canonical tiers", () => {
    const nm = buildConditionDescriptors(makeRaw({ conditionEstimate: "NM-MT" }));
    expect(nm.find(d => d.name === "40001")!.values).toEqual(["400010"]);

    const ex = buildConditionDescriptors(makeRaw({ conditionEstimate: "EX" }));
    expect(ex.find(d => d.name === "40001")!.values).toEqual(["400011"]);

    const vg = buildConditionDescriptors(makeRaw({ conditionEstimate: "VG" }));
    expect(vg.find(d => d.name === "40001")!.values).toEqual(["400012"]);
  });

  it("does NOT emit Professional Grader / Grade / Cert descriptors on raw path", () => {
    const descriptors = buildConditionDescriptors(makeRaw({ conditionEstimate: "Excellent" }));
    expect(descriptors.find(d => d.name === "27501")).toBeUndefined();
    expect(descriptors.find(d => d.name === "27502")).toBeUndefined();
    expect(descriptors.find(d => d.name === "27503")).toBeUndefined();
  });
});

describe("buildConditionDescriptors — path selection", () => {
  it("uses raw path when gradingCompany is 'raw' string literal", () => {
    const descriptors = buildConditionDescriptors(makeGraded({ gradingCompany: "raw" }));
    // Should be raw path — Card Condition emitted, no graded descriptors
    expect(descriptors.find(d => d.name === "40001")).toBeDefined();
    expect(descriptors.find(d => d.name === "27501")).toBeUndefined();
  });

  it("uses raw path when grade is empty even with a grader set", () => {
    const descriptors = buildConditionDescriptors(makeGraded({ grade: undefined }));
    expect(descriptors.find(d => d.name === "40001")).toBeDefined();
    expect(descriptors.find(d => d.name === "27501")).toBeUndefined();
  });
});
