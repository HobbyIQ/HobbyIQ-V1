// CF-SLUG-REFUSE-FALLBACKS (Drew, 2026-08-14).
//
// Cases are drawn from rows actually in sold_comps on 2026-08-14, not
// invented. Each one currently produces a syntactically valid slug that
// means nothing.

import { describe, it, expect } from "vitest";
import {
  normalizeSportStrict,
  isValidCardYear,
  isRawVendorSetKey,
  guardSlugInputs,
  CANONICAL_SPORTS,
} from "../src/services/portfolioiq/slugGuard.service.js";

describe("normalizeSportStrict", () => {
  it("passes canonical sports through", () => {
    for (const s of ["baseball", "basketball", "football", "hockey", "soccer", "pokemon"]) {
      expect(normalizeSportStrict(s)).toBe(s);
    }
  });

  it("collapses the spelling drift found in the pool", () => {
    // Live counts 2026-08-14: "ice hockey" 182 vs "hockey" 32,650;
    // "non-sport" 10,765 vs "non-sports" 15 vs "non sport" 1.
    expect(normalizeSportStrict("ice hockey")).toBe("hockey");
    expect(normalizeSportStrict("ice-hockey")).toBe("hockey");
    expect(normalizeSportStrict("non-sports")).toBe("non-sport");
    expect(normalizeSportStrict("non sport")).toBe("non-sport");
    expect(normalizeSportStrict("mixed martial arts (mma)")).toBe("mma");
    expect(normalizeSportStrict("auto racing")).toBe("racing");
    expect(normalizeSportStrict("motor racing")).toBe("racing");
    expect(normalizeSportStrict("nascar")).toBe("racing");
  });

  it("maps league abbreviations", () => {
    expect(normalizeSportStrict("NFL")).toBe("football");
    expect(normalizeSportStrict("nba")).toBe("basketball");
    expect(normalizeSportStrict("MLB")).toBe("baseball");
    expect(normalizeSportStrict("nhl")).toBe("hockey");
  });

  it("REJECTS multi-value tag dumps rather than picking a token", () => {
    // Splitting these would assign a namespace on a coin flip.
    expect(normalizeSportStrict("football, baseball")).toBeNull();
    expect(normalizeSportStrict("basketball, karate")).toBeNull();
    expect(normalizeSportStrict("baseball, basketball, football, soccer")).toBeNull();
    expect(normalizeSportStrict("basketball,collabs-eligible,single")).toBeNull();
    expect(normalizeSportStrict("boxing/wrestling cards/mma")).toBeNull();
  });

  it("rejects compound junk and unknown vendor strings", () => {
    expect(normalizeSportStrict("basketball-football")).toBeNull();
    expect(normalizeSportStrict("basketball-basketball")).toBeNull();
    expect(normalizeSportStrict("soccer-basketball")).toBeNull();
    expect(normalizeSportStrict("movies-tv")).toBeNull();
    expect(normalizeSportStrict("snowboarding")).toBeNull();
    expect(normalizeSportStrict("")).toBeNull();
    expect(normalizeSportStrict(null)).toBeNull();
    expect(normalizeSportStrict(undefined)).toBeNull();
  });

  it("only ever returns a canonical value", () => {
    const probes = ["ice hockey", "NFL", "nascar", "non sports", "ufc", "calcio"];
    for (const p of probes) {
      const out = normalizeSportStrict(p);
      expect(out).not.toBeNull();
      expect(CANONICAL_SPORTS.has(out as string)).toBe(true);
    }
  });
});

describe("isValidCardYear", () => {
  it("rejects the truncated years present in the pool", () => {
    // Live row: Rich Gossage, cardYear 197, title "1978 Kellogg's ...".
    expect(isValidCardYear(197, 2026)).toBe(false);
    expect(isValidCardYear(0, 2026)).toBe(false);
    expect(isValidCardYear(19, 2026)).toBe(false);
  });

  it("accepts real card years", () => {
    expect(isValidCardYear(1978, 2026)).toBe(true);
    expect(isValidCardYear(1952, 2026)).toBe(true);
    expect(isValidCardYear(2026, 2026)).toBe(true);
  });

  it("allows next season but not far-future parse artifacts", () => {
    expect(isValidCardYear(2028, 2026)).toBe(true);
    expect(isValidCardYear(2029, 2026)).toBe(false);
    expect(isValidCardYear(9999, 2026)).toBe(false);
  });

  it("rejects non-integers and non-numbers", () => {
    expect(isValidCardYear(2024.5, 2026)).toBe(false);
    expect(isValidCardYear(NaN, 2026)).toBe(false);
    expect(isValidCardYear("2024" as unknown, 2026)).toBe(false);
    expect(isValidCardYear(null, 2026)).toBe(false);
  });
});

describe("isRawVendorSetKey", () => {
  it("flags un-normalized vendor product strings", () => {
    // These are real setKeys in sold_comps slugs today. A catalog keyed
    // on `panini-majestic` can never match them.
    expect(isRawVendorSetKey("2018-panini-majestic-football")).toBe(true);
    expect(isRawVendorSetKey("2021-panini-impeccable-football")).toBe(true);
    expect(isRawVendorSetKey("1992-classic-draft-picks-baseball")).toBe(true);
  });

  it("does NOT flag legitimate setKeys outside the controlled vocabulary", () => {
    // Pokemon sets resolve at 92.9% and must survive the guard — absence
    // from the vocabulary is not evidence of junk.
    expect(isRawVendorSetKey("swsh09-brilliant-stars")).toBe(false);
    expect(isRawVendorSetKey("swsh09-brilliant-stars-trainer-gallery")).toBe(false);
    expect(isRawVendorSetKey("o-pee-chee")).toBe(false);
    expect(isRawVendorSetKey("upper-deck")).toBe(false);
    expect(isRawVendorSetKey("bowman-chrome")).toBe(false);
    expect(isRawVendorSetKey("topps-chrome-platinum")).toBe(false);
    expect(isRawVendorSetKey("")).toBe(false);
  });
});

describe("guardSlugInputs", () => {
  const good = {
    sport: "baseball", year: 2025,
    normalizedSetKey: "bowman-chrome", cardNumber: "CPA-EHA",
  };

  it("accepts a well-formed row and returns the canonical sport", () => {
    const r = guardSlugInputs(good);
    expect(r.ok).toBe(true);
    expect(r.sport).toBe("baseball");
    expect(r.reasons).toEqual([]);
  });

  it("canonicalizes the sport it returns", () => {
    const r = guardSlugInputs({ ...good, sport: "ice hockey" });
    expect(r.ok).toBe(true);
    expect(r.sport).toBe("hockey");
  });

  it("refuses the real Rich Gossage row, reporting BOTH defects", () => {
    // sport=hockey on a baseball card, year 197 truncated from 1978.
    // The current code emits hiq:hockey:197:bowman:8:base:no-auto.
    const r = guardSlugInputs({
      sport: "hockey", year: 197, normalizedSetKey: "bowman", cardNumber: "8",
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("year-invalid");
    expect(r.sport).toBeNull();
  });

  it("reports every failing reason, not just the first", () => {
    const r = guardSlugInputs({
      sport: "football, baseball", year: 197,
      normalizedSetKey: "2018-panini-majestic-football", cardNumber: "",
    });
    expect(r.ok).toBe(false);
    // CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). The cardNumber reason
    // is now `cardnumber-unparsed` rather than `cardnumber-missing`: a BLANK
    // cardNumber is a parse failure, and that is a different fact from "no
    // number and no player either". Both still REFUSE — the refusal is what
    // this case has always been about — and the name is what changed.
    expect(r.reasons).toEqual(expect.arrayContaining([
      "sport-uncanonical", "year-invalid",
      "setkey-raw-vendor-string", "cardnumber-unparsed",
    ]));
  });

  it("refuses a literal 'null' cardNumber", () => {
    // Live slug: hiq:baseball:2020:bowman-chrome:null:base:auto
    // A stringified null is a feed writing nothing, not a source saying the
    // card has no number — so it is UNPARSED (CF-UNPARSED-IS-NOT-UNNUMBERED).
    const r = guardSlugInputs({ ...good, cardNumber: "null" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("cardnumber-unparsed");
  });

  it("an ASSERTED unnumbered card with no player is still `cardnumber-missing`", () => {
    // The other half of the split: `nno` IS an answer, and the refusal here is
    // that nothing identifies the row — not that the number was unreadable.
    const r = guardSlugInputs({ ...good, cardNumber: "nno" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("cardnumber-missing");
  });

  it("refuses a missing setKey", () => {
    const r = guardSlugInputs({ ...good, normalizedSetKey: "" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("setkey-missing");
  });

  it("keeps Pokemon rows flowing", () => {
    const r = guardSlugInputs({
      sport: "pokemon", year: 2022,
      normalizedSetKey: "swsh09-brilliant-stars", cardNumber: "154",
    });
    expect(r.ok).toBe(true);
    expect(r.sport).toBe("pokemon");
  });
});
