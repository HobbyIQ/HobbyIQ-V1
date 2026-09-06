// CF-A-MAKER-LESS-CATCH-ALL-IS-NOT-A-PRODUCT (Drew, 2026-09-05).
//
// The pins for the refusal, and — the point of the file — the MUTATION CHECKS
// that turn red if the refusal is removed. Deleting the guard line in
// slugGuard or the throw in computeHobbyIqCardId re-mints `draft`, which is
// exactly the defect Drew ruled on, so each one has a test that fails on its
// absence rather than only tests that pass on its presence.
import { describe, it, expect } from "vitest";
import {
  isMakerlessCatchAllSetKey,
  makerlessCatchAllMessage,
  MAKERLESS_CATCH_ALL_KEYS,
} from "../src/services/catalog/makerlessCatchAll.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const ok = {
  sport: "baseball",
  year: 2025,
  cardNumber: "CPA-DT",
  playerName: "Devin Taylor",
};

describe("the maker-less catch-all vocabulary", () => {
  it("names exactly the four measured keys", () => {
    // Enumerated by measurement on 2026-09-05: each had ZERO checklist-backed
    // rows in card_catalog. Changing this set is a ruling, so it is pinned.
    expect([...MAKERLESS_CATCH_ALL_KEYS].sort()).toEqual([
      "chrome", "draft", "flagship", "prospects",
    ]);
  });

  it("refuses the bare word", () => {
    for (const k of ["draft", "flagship", "chrome", "prospects"]) {
      expect(isMakerlessCatchAllSetKey(k)).toBe(true);
    }
  });

  it("is EXACT-TOKEN — a maker-qualified product is untouched", () => {
    // The whole reason the check is a Set lookup and not a substring test.
    // Every one of these is a real product with a real checklist.
    for (const k of [
      "bowman-draft", "bowman-chrome-draft", "topps-chrome", "bowman-chrome",
      "bowman-chrome-prospects", "panini-prizm-draft-picks", "topps-pro-debut",
    ]) {
      expect(isMakerlessCatchAllSetKey(k)).toBe(false);
    }
  });

  it("does NOT refuse `select` or `base` — both are real products", () => {
    // `select` is 45,850 catalog rows, 99% checklist-scraped
    // (baseballcardpedia, setNames "2021 Select"). `base` is Pokemon Base Set.
    // Refusing either would park checklist-backed cards, which is the opposite
    // of the ruling. Pinned as NEGATIVES so a later "this word reads generic"
    // edit has to argue with a test.
    expect(isMakerlessCatchAllSetKey("select")).toBe(false);
    expect(isMakerlessCatchAllSetKey("base")).toBe(false);
  });

  it("treats blank and null as not-a-catch-all (the empty key has its own reason)", () => {
    for (const k of [null, undefined, "", "   "]) {
      expect(isMakerlessCatchAllSetKey(k)).toBe(false);
    }
  });

  it("trims and lower-cases, because callers hold keys from mixed sources", () => {
    expect(isMakerlessCatchAllSetKey("  Draft ")).toBe(true);
    expect(isMakerlessCatchAllSetKey("FLAGSHIP")).toBe(true);
  });

  it("names the missing thing in its message", () => {
    const m = makerlessCatchAllMessage("draft");
    expect(m).toContain("names no maker");
    expect(m).toContain("identityUnverified");
  });
});

describe("normalizeSetKey still produces the catch-all (the refusal is downstream)", () => {
  // Documents the SOURCE of the defect rather than hiding it: normalizeSetKey
  // is a total function and still falls through to the slugified word. That is
  // fine — the refusal is the guard's job, and pinning this means a future
  // change to the fall-through cannot silently make these tests vacuous.
  it("maps the bare title word to the bare key", () => {
    expect(normalizeSetKey("Draft")).toBe("draft");
    expect(normalizeSetKey("Flagship")).toBe("flagship");
  });

  it("but a maker-qualified name resolves to a real product", () => {
    expect(normalizeSetKey("Bowman Draft")).toBe("bowman-draft");
  });
});

describe("MUTATION CHECK — slugGuard refuses a maker-less catch-all", () => {
  // Removing the `isMakerlessCatchAllSetKey` branch in guardSlugInputs makes
  // this red: the guard would return ok:true and the row would mint `draft`.
  it("refuses `draft` with the named reason", () => {
    const r = guardSlugInputs({ ...ok, normalizedSetKey: "draft" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("setkey-makerless-catchall");
  });

  it("refuses `flagship`", () => {
    const r = guardSlugInputs({ ...ok, sport: "hockey", year: 1966, cardNumber: "69", normalizedSetKey: "flagship" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("setkey-makerless-catchall");
  });

  it("admits the same row once a maker is read", () => {
    // The refusal is a PARK, not a rejection of the sale: read a maker and the
    // identical row derives normally.
    const r = guardSlugInputs({ ...ok, normalizedSetKey: "bowman-draft" });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("does not park a checklist-backed `select` row", () => {
    const r = guardSlugInputs({ ...ok, cardNumber: "7", playerName: "Brennen Davis", normalizedSetKey: "select" });
    expect(r.ok).toBe(true);
  });
});

describe("MUTATION CHECK — computeHobbyIqCardId refuses rather than mints", () => {
  // Removing the throw in computeHobbyIqCardId makes this red: it would return
  // the well-formed, meaningless `hiq:baseball:2025:draft:cpa-dt:base:no-auto`.
  it("throws UNDERIVABLE for a bare `draft`", () => {
    expect(() => computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "draft",
      cardNumber: "CPA-DT", playerName: "Devin Taylor",
      parallel: null, isAuto: true,
    } as never)).toThrow(/UNDERIVABLE/);
  });

  it("throws UNDERIVABLE for a bare `flagship`", () => {
    expect(() => computeHobbyIqCardId({
      sport: "hockey", year: 1966, setKey: "flagship",
      cardNumber: "69", playerName: "Ted Harris",
      parallel: null, isAuto: false,
    } as never)).toThrow(/UNDERIVABLE/);
  });

  it("mints normally once the maker is read", () => {
    const id = computeHobbyIqCardId({
      sport: "hockey", year: 1966, setKey: "topps",
      cardNumber: "69", playerName: "Ted Harris",
      parallel: null, isAuto: false,
    } as never);
    expect(id).toContain(":topps:");
    expect(id).not.toContain(":flagship:");
  });

  it("never mints a slug carrying a bare catch-all segment", () => {
    // The invariant stated directly: whatever else changes, no id this module
    // produces may name a catch-all as its product.
    const id = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "bowman-draft",
      cardNumber: "BD-152", playerName: "Devin Taylor",
      parallel: null, isAuto: false,
    } as never);
    for (const k of MAKERLESS_CATCH_ALL_KEYS) {
      expect(id).not.toContain(`:${k}:`);
    }
  });
});
