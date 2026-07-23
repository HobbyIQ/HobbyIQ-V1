// CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706). Pins the slug
// generator against every normalization edge case + real-world card
// examples. Determinism (same input → same output) is the load-bearing
// property — this file is the enforcement.

import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  parseHobbyIqCardId,
  slugify,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("slugify", () => {
  it("lowercases + hyphens spaces", () => {
    expect(slugify("Gold Refractor")).toBe("gold-refractor");
    expect(slugify("Orange Shimmer Refractor")).toBe("orange-shimmer-refractor");
  });

  it("strips punctuation", () => {
    expect(slugify("Black & White")).toBe("black-white");
    expect(slugify("Allen & Ginter's")).toBe("allen-ginters");
    expect(slugify("X-Fractor")).toBe("x-fractor");
  });

  it("collapses repeated hyphens", () => {
    expect(slugify("  Gold   Refractor  ")).toBe("gold-refractor");
    expect(slugify("Blue---Refractor")).toBe("blue-refractor");
  });

  it("handles empty / null-like inputs deterministically", () => {
    expect(slugify("")).toBe("");
    // slugify accepts any input coerced via String() — matches production behavior
    expect(slugify(null as unknown as string)).toBe("");
    expect(slugify(undefined as unknown as string)).toBe("");
  });

  it("normalizes unicode variants", () => {
    // NFKD decomposition strips diacritics
    expect(slugify("Pokémon")).toBe("pokemon");
    expect(slugify("Naïve")).toBe("naive");
  });

  it("preserves internal hyphens (cardNumbers)", () => {
    expect(slugify("CPA-EHA")).toBe("cpa-eha");
    expect(slugify("BCP-102")).toBe("bcp-102");
    expect(slugify("BDCA-JM")).toBe("bdca-jm");
  });
});

describe("computeHobbyIqCardId — canonical shape", () => {
  it("Drew's Hartman Gold Refractor /50 (the motivating case)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "CPA-EHA",
      parallel: "Gold Refractor",
      isAuto: true,
      printRun: 50,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50");
  });

  it("Hartman Orange Shimmer Refractor auto (unnumbered → no print-run suffix)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "CPA-EHA",
      parallel: "Orange Shimmer Refractor",
      isAuto: true,
      printRun: null,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman:cpa-eha:orange-shimmer-refractor:auto");
  });

  it("base non-auto (Base parallel + no printRun)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "BCP-102",
      parallel: "Base",
      isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman:bcp-102:base:no-auto");
  });

  it("basketball Prizm /99", () => {
    const slug = computeHobbyIqCardId({
      sport: "basketball",
      year: 2024,
      setKey: "Panini Prizm",
      cardNumber: "1",
      parallel: "Silver Prizm",
      isAuto: false,
      printRun: 99,
    });
    expect(slug).toBe("hiq:basketball:2024:panini-prizm:1:silver-prizm:no-auto:num-99");
  });

  it("football Bowman Chrome auto", () => {
    const slug = computeHobbyIqCardId({
      sport: "football",
      year: 2023,
      setKey: "Bowman Chrome",
      cardNumber: "BCPA-JJ",
      parallel: "Refractor",
      isAuto: true,
    });
    expect(slug).toBe("hiq:football:2023:bowman-chrome:bcpa-jj:refractor:auto");
  });

  it("Pokemon card", () => {
    const slug = computeHobbyIqCardId({
      sport: "pokemon",
      year: 2023,
      setKey: "SV1",
      cardNumber: "151",
      parallel: "Full Art",
      isAuto: false,
    });
    expect(slug).toBe("hiq:pokemon:2023:sv1:151:full-art:no-auto");
  });
});

describe("computeHobbyIqCardId — determinism", () => {
  it("same inputs → same slug (100 iterations)", () => {
    const components = {
      sport: "baseball",
      year: 2026,
      setKey: "Bowman Chrome",
      cardNumber: "CPA-EH",
      parallel: "Orange Shimmer Refractor",
      isAuto: true,
      printRun: null,
    };
    const first = computeHobbyIqCardId(components);
    for (let i = 0; i < 100; i++) {
      expect(computeHobbyIqCardId(components)).toBe(first);
    }
  });

  it("case-insensitive on inputs", () => {
    const upper = computeHobbyIqCardId({
      sport: "BASEBALL", year: 2026, setKey: "BOWMAN CHROME",
      cardNumber: "CPA-EHA", parallel: "GOLD REFRACTOR",
      isAuto: true, printRun: 50,
    });
    const mixed = computeHobbyIqCardId({
      sport: "Baseball", year: 2026, setKey: "Bowman Chrome",
      cardNumber: "cpa-eha", parallel: "Gold Refractor",
      isAuto: true, printRun: 50,
    });
    const lower = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "bowman chrome",
      cardNumber: "cpa-eha", parallel: "gold refractor",
      isAuto: true, printRun: 50,
    });
    expect(upper).toBe(mixed);
    expect(mixed).toBe(lower);
  });

  it("whitespace + punctuation variations produce the same slug", () => {
    const a = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman Chrome",
      cardNumber: "CPA-EHA", parallel: "Gold Refractor",
      isAuto: true, printRun: 50,
    });
    const b = computeHobbyIqCardId({
      sport: "  baseball  ", year: 2026, setKey: "Bowman  Chrome",
      cardNumber: " CPA-EHA ", parallel: "  Gold   Refractor  ",
      isAuto: true, printRun: 50,
    });
    expect(a).toBe(b);
  });
});

describe("computeHobbyIqCardId — sport alias normalization", () => {
  it("NFL → football", () => {
    const nfl = computeHobbyIqCardId({ sport: "NFL", year: 2024, setKey: "Prizm", cardNumber: "1", parallel: "Base", isAuto: false });
    const football = computeHobbyIqCardId({ sport: "football", year: 2024, setKey: "Prizm", cardNumber: "1", parallel: "Base", isAuto: false });
    expect(nfl).toBe(football);
  });

  it("NBA → basketball", () => {
    const nba = computeHobbyIqCardId({ sport: "NBA", year: 2024, setKey: "Prizm", cardNumber: "1", parallel: "Base", isAuto: false });
    const basketball = computeHobbyIqCardId({ sport: "basketball", year: 2024, setKey: "Prizm", cardNumber: "1", parallel: "Base", isAuto: false });
    expect(nba).toBe(basketball);
  });

  it("MLB → baseball", () => {
    const mlb = computeHobbyIqCardId({ sport: "MLB", year: 2024, setKey: "Bowman", cardNumber: "1", parallel: "Base", isAuto: false });
    const baseball = computeHobbyIqCardId({ sport: "baseball", year: 2024, setKey: "Bowman", cardNumber: "1", parallel: "Base", isAuto: false });
    expect(mlb).toBe(baseball);
  });
});

describe("computeHobbyIqCardId — set key controlled vocabulary", () => {
  it("Bowman Chrome Prospects → bowman-chrome (family key)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "2026 Bowman Chrome Prospects Baseball",
      cardNumber: "BCP-102", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":bowman-chrome:");
  });

  it("Topps Chrome Update → topps-chrome-update (specific)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "2024 Topps Chrome Update Series",
      cardNumber: "US1", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":topps-chrome-update:");
  });

  it("Panini Prizm collapses to panini-prizm", () => {
    const s1 = computeHobbyIqCardId({ sport: "basketball", year: 2024, setKey: "Panini Prizm", cardNumber: "1", parallel: "Base", isAuto: false });
    const s2 = computeHobbyIqCardId({ sport: "basketball", year: 2024, setKey: "Prizm", cardNumber: "1", parallel: "Base", isAuto: false });
    expect(s1).toBe(s2);
    expect(s1).toContain(":panini-prizm:");
  });

  it("unknown set falls back to slugified full name", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Totally Made Up Brand",
      cardNumber: "1", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":totally-made-up-brand:");
  });
});

describe("computeHobbyIqCardId — parallel normalization", () => {
  it("base variants collapse to base", () => {
    for (const par of ["Base", "base", "", null, undefined, "none", "no parallel"]) {
      const slug = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman",
        cardNumber: "1", parallel: par as string, isAuto: false,
      });
      expect(slug).toContain(":base:");
    }
  });

  it("preserves specific parallel names", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EH", parallel: "True Blue Refractor", isAuto: true,
    });
    expect(s).toContain(":true-blue-refractor:");
  });
});

describe("computeHobbyIqCardId — print run", () => {
  it("valid positive integer → suffix", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "1", parallel: "Gold Refractor", isAuto: true, printRun: 50,
    });
    expect(s.endsWith(":num-50")).toBe(true);
  });

  it("null / undefined / zero / negative / non-integer → no suffix", () => {
    for (const pr of [null, undefined, 0, -1, 1.5, NaN, Infinity]) {
      const s = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman",
        cardNumber: "1", parallel: "Gold", isAuto: true, printRun: pr as number,
      });
      expect(s.split(":num-").length).toBe(1);
    }
  });
});

describe("parseHobbyIqCardId — round-trip", () => {
  it("round-trips a canonical slug back to normalized components", () => {
    const slug = "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50";
    const parsed = parseHobbyIqCardId(slug);
    expect(parsed).not.toBeNull();
    expect(parsed!.sport).toBe("baseball");
    expect(parsed!.year).toBe(2026);
    expect(parsed!.setKey).toBe("bowman");
    expect(parsed!.cardNumber).toBe("cpa-eha");
    expect(parsed!.parallel).toBe("gold-refractor");
    expect(parsed!.isAuto).toBe(true);
    expect(parsed!.printRun).toBe(50);
  });

  it("round-trips a slug without print run", () => {
    const slug = "hiq:baseball:2026:bowman:bcp-102:base:no-auto";
    const parsed = parseHobbyIqCardId(slug);
    expect(parsed).not.toBeNull();
    expect(parsed!.printRun).toBeNull();
    expect(parsed!.isAuto).toBe(false);
  });

  it("returns null on invalid inputs", () => {
    expect(parseHobbyIqCardId("")).toBeNull();
    expect(parseHobbyIqCardId("not-a-slug")).toBeNull();
    expect(parseHobbyIqCardId("hiq:baseball")).toBeNull();  // too few parts
    expect(parseHobbyIqCardId("hiq:baseball:2026:bowman:1:base:maybe")).toBeNull();  // bad autoFlag
    expect(parseHobbyIqCardId("hiq:baseball:2026:bowman:1:base:auto:num-abc")).toBeNull();  // bad print run
    expect(parseHobbyIqCardId("hiq:baseball:bad:bowman:1:base:auto")).toBeNull();  // bad year
    expect(parseHobbyIqCardId(null as unknown as string)).toBeNull();
    expect(parseHobbyIqCardId(undefined as unknown as string)).toBeNull();
  });

  it("compute → parse → compute is idempotent (except for canonical vocab collapse)", () => {
    const input = {
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Gold Refractor",
      isAuto: true, printRun: 50,
    };
    const slug1 = computeHobbyIqCardId(input);
    const parsed = parseHobbyIqCardId(slug1);
    expect(parsed).not.toBeNull();
    const slug2 = computeHobbyIqCardId(parsed!);
    expect(slug1).toBe(slug2);
  });
});
