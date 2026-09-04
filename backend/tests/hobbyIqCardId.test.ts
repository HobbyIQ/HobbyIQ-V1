// CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706). Pins the slug
// generator against every normalization edge case + real-world card
// examples. Determinism (same input → same output) is the load-bearing
// property — this file is the enforcement.

import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  parseHobbyIqCardId,
  slugify,
  matchKnownProductLine,
  normalizeSetKey,
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
    // CF-CHROME-PREFIX-OVERRIDE-NARROW (2026-08-10). setKey="Bowman"
    // + cardNumber="CPA-EHA" now upgrades to bowman-chrome (was the
    // 24k-row misslug source). Prior expectation was the bug we
    // shipped a mass reslug for.
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:gold-refractor:auto:num-50");
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
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:orange-shimmer-refractor:auto");
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
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome:bcp-102:base:no-auto");
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

  // CF-CHROME-PROSPECTS-IS-BOWMAN-CHROME (Drew, 2026-07-29). CH tags
  // BCP/CPA rows with a bare setName="Chrome Prospects" (no "Bowman"
  // prefix). Without a dedicated rule, normalizeSetKey slugifies to
  // "chrome-prospects" which fragments the FMV pool. These MUST unify
  // with bowman-chrome.
  it("bare 'Chrome Prospects' setName → bowman-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Chrome Prospects",
      cardNumber: "BCP-102", parallel: "Refractor", isAuto: false,
    });
    expect(slug).toContain(":bowman-chrome:");
  });
  it("bare 'Chrome Prospects Autographs' setName → bowman-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Chrome Prospects Autographs",
      cardNumber: "CPA-EHA", parallel: "Base", isAuto: true,
    });
    expect(slug).toContain(":bowman-chrome:");
  });

  it("Topps Chrome Update → topps-chrome-update-series (D23 supersedes CF-CHROME-SUBSET-COLLAPSE)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "2024 Topps Chrome Update Series",
      cardNumber: "US1", parallel: "Base", isAuto: false,
    });
    // CF-THE-ID-CARRIES-THE-PRODUCT (Drew, 2026-08-30): the id carries the
    // product as the checklist names it. Update Series is its own key; the
    // topps-chrome FAMILY (productSetKeys) is what pricing may cross into.
    expect(slug).toContain(":topps-chrome-update-series:");
    expect(slug).not.toContain(":topps-chrome:");
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

// CF-CHROME-PREFIX-OVERRIDE-NARROW (Drew, 2026-08-10). When vendor
// setName is bare "Bowman" or "Topps" but the cardNumber is an
// unambiguous chrome prefix (BCP-, CPA-, BDC-, TCPA-, CRA-), the
// slug must upgrade to the chrome family. Prior state: 84,890+
// sold_comps rows misslugged this way. See slug-frag-findings.json.
describe("computeHobbyIqCardId — cardNumber-prefix override (bare→chrome)", () => {
  it("bowman + BCP- → bowman-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "BCP-102", parallel: "Refractor", isAuto: false,
    });
    expect(slug).toContain(":bowman-chrome:");
    expect(slug).not.toMatch(/:bowman:bcp-/);
  });

  it("bowman + BCP150 (no dash, pre-2020 shape) → bowman-chrome", () => {
    // 2018 Vladimir Guerrero Jr. rookie BCP150. Prior /^bcp-/ regex
    // missed no-dash variants entirely, breaking data population for
    // Vlad + every other 2018-and-earlier BCP card (found via user
    // report 2026-08-10).
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2018, setKey: "Bowman",
      cardNumber: "BCP150", parallel: "Base", isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:2018:bowman-chrome:bcp150:base:no-auto");
  });

  it("bowman + CPA- → bowman-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-OC", parallel: "Refractor", isAuto: true, printRun: 499,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome:cpa-oc:refractor:auto:num-499");
  });

  it("bowman + BDC- → bowman-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "BDC-1", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":bowman-chrome:");
  });

  // CF-DRAFT-IS-ITS-OWN-PRODUCT (Drew, 2026-08-16: "it shuld fold into Draft
  // since it is draft"). This test previously pinned BDC- to bowman-chrome.
  // That was wrong on the data: bowman-draft carries 277,616 CHECKLIST-backed
  // catalog rows, bowman-draft-chrome carries ZERO (23,892 of its 23,899 rows
  // are cardhedge-graded, an excluded source). Draft is its own product with
  // its own checklist, and 123,012 comps were re-slugged onto it.
  it("bowman-draft + BDC- → bowman-draft (Draft is its own product)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman Draft",
      cardNumber: "BDC-48", parallel: "Mojo Refractor", isAuto: false, printRun: 75,
    });
    expect(slug).toContain(":bowman-draft:");
    expect(slug).not.toContain(":bowman-chrome:");
  });

  it("topps + TCPA- → topps-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "Topps",
      cardNumber: "TCPA-CB", parallel: "Refractor", isAuto: true,
    });
    expect(slug).toContain(":topps-chrome:");
  });

  it("topps + CRA- → topps-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Topps",
      cardNumber: "CRA-CB", parallel: "Base", isAuto: true,
    });
    expect(slug).toContain(":topps-chrome:");
  });

  it("does NOT touch panini + CPA (bare) — override is prefix-only, not substring", () => {
    // 'cpa' without dash isn't a real cardNumber pattern, but assert we
    // don't accidentally match numeric card numbers that start with "cpa".
    const slug = computeHobbyIqCardId({
      sport: "basketball", year: 2024, setKey: "Panini Prizm",
      cardNumber: "1", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":panini-prizm:");
  });

  it("does NOT touch bowman when cardNumber is bare numeric (paper flagship)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1991, setKey: "Bowman",
      cardNumber: "246", parallel: "Base", isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:1991:bowman:246:base:no-auto");
  });

  it("does NOT touch topps when cardNumber is bare numeric", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1991, setKey: "Topps",
      cardNumber: "392", parallel: "Base", isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:1991:topps:392:base:no-auto");
  });

  // CF-BASE-IS-NOT-A-REFRACTOR (Drew, 2026-08-23: "base is a refractor is
  // wrong"). These four cases previously asserted the OPPOSITE — that a "Base"
  // parallel on a CPA-/TCPA-/CRA- auto was upgraded to "refractor" so the /499
  // pool would not "split in half".
  //
  // That rule (CF-CHROME-AUTO-BASE-IS-REFRACTOR, 2026-08-10) is removed. Its
  // own comment cited Drew's words — "a base does not equal a refractor" — and
  // then merged them anyway; the rationale was inverted when it was written.
  //
  // Measured on 2025 Bowman Draft CPA-MWI, the card that surfaced it: 42 sales
  // on :refractor:auto and 20 on :base:auto. Those 20 are Base autographs and
  // pooling them drags the Refractor toward a different card's price. A smaller
  // correct pool beats a larger wrong one.
  it("CPA- auto + Base parallel STAYS base — base is not a refractor", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-OC", parallel: "Base", isAuto: true, printRun: 499,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome:cpa-oc:base:auto:num-499");
  });

  it("TCPA- auto + Base stays base on topps-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "Topps",
      cardNumber: "TCPA-CB", parallel: "Base", isAuto: true,
    });
    expect(slug).toContain(":topps-chrome:tcpa-cb:base:auto");
  });

  it("CRA- auto + Base stays base on topps-chrome", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Topps",
      cardNumber: "CRA-JD", parallel: "Base", isAuto: true,
    });
    expect(slug).toContain(":topps-chrome:cra-jd:base:auto");
  });

  it("a Base auto and a Refractor auto are DIFFERENT slugs", () => {
    // The point of the removal, stated directly: these two must never collapse.
    const base = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-OC", parallel: "Base", isAuto: true, printRun: 499,
    });
    const refractor = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-OC", parallel: "Refractor", isAuto: true, printRun: 499,
    });
    expect(base).not.toBe(refractor);
  });

  it("CPA- with vendor isAuto=false is force-corrected to :auto (CF-AUTO-ONLY-FORCE)", () => {
    // Prior behavior tested by this suite: honored vendor isAuto=false
    // and produced :no-auto. That was the bug — CPA- is auto-only by
    // product definition, so the pool was fragmenting between :auto
    // (correct) and :no-auto (bad vendor label) for the same sale.
    //
    // The isAuto force still stands. What changed is the parallel: the
    // Base→Refractor upgrade no longer fires, so Base stays base.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-OC", parallel: "Base", isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome:cpa-oc:base:auto");
  });

  it("BCP- auto + Base stays Base (rule scoped to CPA/TCPA/CRA only)", () => {
    // BCP is a non-auto insert subset; the base-is-refractor rule only
    // applies to auto subsets (CPA/TCPA/CRA).
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "BCP-102", parallel: "Base", isAuto: true, printRun: 499,
    });
    expect(slug).toContain(":bowman-chrome:bcp-102:base:auto");
  });

  // Expanded prefix rules 2026-08-10 — Drew: "if we know it for a fact, we should clean it"
  it("bowman + CDA- → bowman-chrome (Chrome Draft Autographs)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2023, setKey: "Bowman",
      cardNumber: "CDA-HWA", parallel: "Refractor", isAuto: true,
    });
    expect(slug).toContain(":bowman-chrome:cda-hwa:");
  });

  it("bowman + BCPA- → bowman-chrome (older Chrome Prospect Auto shape)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2015, setKey: "Bowman",
      cardNumber: "BCPA-CB", parallel: "Refractor", isAuto: true,
    });
    expect(slug).toContain(":bowman-chrome:bcpa-cb:");
  });

  it("bowman + BDCPA- → bowman-chrome (Bowman Draft Chrome Prospect Auto)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2023, setKey: "Bowman",
      cardNumber: "BDCPA-JJ", parallel: "Refractor", isAuto: true,
    });
    expect(slug).toContain(":bowman-chrome:bdcpa-jj:");
  });

  it("bowman + BSPA- → bowman-chrome-sapphire (Bowman Sapphire Prospect Auto)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "Bowman",
      cardNumber: "BSPA-VG", parallel: "Refractor", isAuto: true,
    });
    expect(slug).toContain(":bowman-chrome-sapphire:bspa-vg:");
  });

  it("bowman + BP- → bowman-paper (Bowman Prospects paper)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2023, setKey: "Bowman",
      cardNumber: "BP-1", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":bowman-paper:bp-1:");
  });

  it("bowman + BPA- → bowman-paper (Bowman Paper Auto)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2023, setKey: "Bowman",
      cardNumber: "BPA-JJ", parallel: "Base", isAuto: true,
    });
    expect(slug).toContain(":bowman-paper:bpa-jj:");
  });

  // BDA- now routes to bowman-draft, not bowman-draft-paper. The paper key
  // held only 18 catalog rows — too thin to be a product, and it stranded
  // Draft autos away from the Draft checklist that actually describes them.
  // CF-PANINI-PRODUCTS-MISSING-FROM-VOCAB (Drew, 2026-08-16: "fix it all").
  // With no rule, normalizeSetKey fell through to slugify and emitted a
  // year-prefixed one-off ("2025-panini-rookies-stars-football"), duplicating
  // the year into a segment the slug already carries and fragmenting one
  // product across every spelling a seller used.
  it("Panini products resolve to a stable key, never a year-prefixed one-off", () => {
    const cases: Array<[string, string]> = [
      ["2025 Panini Certified Football", "panini-certified"],
      ["2024 Panini Crusade Baseball", "panini-crusade"],
      ["2016 Panini Hoops Basketball", "panini-hoops"],
      ["2025 Panini Prestige Football", "panini-prestige"],
      ["2025 Panini Elite Extra Edition", "panini-elite-extra-edition"],
    ];
    for (const [input, want] of cases) {
      expect(normalizeSetKey(input)).toBe(want);
      expect(normalizeSetKey(input)).not.toMatch(/^(19|20)\d{2}-/);
    }
  });

  // The rule for this product ALREADY existed and never fired: slugify drops
  // "&", so "Rookies & Stars" becomes "rookies-stars" and the vocabulary was
  // written against "rookies-and-stars". Both spellings are pinned so the
  // ampersand form cannot regress.
  it("Rookies & Stars matches despite slugify dropping the ampersand", () => {
    expect(normalizeSetKey("2025 Panini Rookies & Stars Football")).toBe("panini-rookies-and-stars");
    expect(normalizeSetKey("Panini Rookies and Stars")).toBe("panini-rookies-and-stars");
  });

  // Totally Certified is its own product and must win over the certified rule.
  // "Select Certified" is pinned too, and a careless bare-"certified" rule
  // would still steal it — but it lands on ITSELF, not on score-select.
  //
  // CF-A-RULED-KEY-IS-A-FIXED-POINT (2026-09-03). This assertion used to read
  // `.toBe("score-select")`, and that was a pool fusion the census caught.
  // Measured read-only against prod: `select-certified` holds 1,376 checklist
  // rows (baseballcardpedia, 1995-1996) and `score-select` holds ZERO. The
  // pool says the same thing louder — the two names never share a year:
  //
  //   1995/1996 Select Certified  baseball 1,246 + 1,447, football 962 + 37
  //   1993/1994/2007 Score Select baseball   956 +    51, football   6 +  5
  //
  // Two products, disjoint eras, one destination: that is a fused pool, and a
  // fused pool prices both cards wrong. Count by source, not row count — the
  // checklist-backed spelling is the key.
  it("certified variants do not collide", () => {
    expect(normalizeSetKey("Panini Totally Certified")).toBe("panini-totally-certified");
    expect(normalizeSetKey("2025 Panini Certified Football")).toBe("panini-certified");
    expect(normalizeSetKey("Select Certified")).toBe("select-certified");
    // and the neighbour it must not be confused with keeps its own key
    expect(normalizeSetKey("1993 Score Select Baseball")).toBe("score-select");
  });

  // CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009 (Drew, 2026-08-16: "see if we have
  // them if not get them"). Panini acquired Donruss in 2009; stamping its name
  // on a 1987 card split 150,695 vintage comps away from the donruss checklist
  // that already described them. 2008/2009 are pinned because the acquisition
  // year IS the rule — an off-by-one here silently re-splits the pool.
  it("pre-2009 Donruss drops the panini- prefix (brand predates the owner)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 1987, setKey: "Donruss",
      cardNumber: "101", parallel: "Base", isAuto: false,
    });
    expect(s).toContain(":donruss:");
    expect(s).not.toContain(":panini-donruss:");
  });

  it("2008 is still Donruss, 2009 is Panini Donruss (acquisition boundary)", () => {
    const at = (year: number) => computeHobbyIqCardId({
      sport: "baseball", year, setKey: "Donruss",
      cardNumber: "101", parallel: "Base", isAuto: false,
    });
    expect(at(2008)).toContain(":donruss:");
    expect(at(2008)).not.toContain(":panini-donruss:");
    expect(at(2009)).toContain(":panini-donruss:");
  });

  // The gate is scoped to Donruss alone. Prizm is a Panini original with no
  // pre-2009 life, so a blanket "strip panini- before 2009" would invent a
  // product that never shipped.
  it("the pre-2009 gate does NOT touch Panini-original brands", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "Panini Prizm",
      cardNumber: "101", parallel: "Base", isAuto: false,
    });
    expect(s).toContain(":panini-prizm:");
  });

  it("bowman + BDA- → bowman-draft (paper key was 18 rows, not a product)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2023, setKey: "Bowman",
      cardNumber: "BDA-EH", parallel: "Base", isAuto: true,
    });
    expect(slug).toContain(":bowman-draft:bda-eh:");
  });

  it("BDP- stays ambiguous — no auto-upgrade (Verlander BDP129 is chrome, others paper)", () => {
    // BDP is intentionally NOT in the override table because it exists
    // in both paper and chrome for the same year (2005 BDP129 had both
    // paper and chrome variants). Only setName can disambiguate.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2005, setKey: "Bowman",
      cardNumber: "BDP129", parallel: "Base", isAuto: false,
    });
    expect(slug).toContain(":bowman:bdp129:"); // stays bare bowman
  });

  // CF-UD-INSERT-LINES (Drew 2026-08-10). Late-90s UD insert products
  // are distinct comp pools.
  it("1999 Upper Deck Black Diamond → upper-deck-black-diamond (not upper-deck)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1999, setKey: "1999 Upper Deck Black Diamond",
      cardNumber: "76", parallel: "Double", isAuto: false, printRun: 3000,
    });
    expect(slug).toBe("hiq:baseball:1999:upper-deck-black-diamond:76:double:no-auto:num-3000");
  });

  it("1999 Black Diamond (bare) → upper-deck-black-diamond", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1999, setKey: "Black Diamond",
      cardNumber: "D24", parallel: "Base", isAuto: false, printRun: 1500,
    });
    expect(slug).toContain(":upper-deck-black-diamond:d24:");
  });

  it("1998 SPx Finite → spx-finite (not upper-deck)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1998, setKey: "1998 Upper Deck SPx Finite",
      cardNumber: "50", parallel: "Radiance", isAuto: false, printRun: 1000,
    });
    expect(slug).toBe("hiq:baseball:1998:spx-finite:50:radiance:no-auto:num-1000");
  });

  it("1999 Upper Deck Retro → upper-deck-retro", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1999, setKey: "1999 Upper Deck Retro",
      cardNumber: "S1", parallel: "Base", isAuto: false, printRun: 1000,
    });
    expect(slug).toBe("hiq:baseball:1999:upper-deck-retro:s1:base:no-auto:num-1000");
  });

  it("skips ambiguous prefix FCA- (Topps Finest / not covered)", () => {
    // FCA- was the ambiguity that killed the prior blanket override.
    // Keep it out of our override table; setName should resolve it.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "Topps",
      cardNumber: "FCA-1", parallel: "Base", isAuto: true,
    });
    // Stays under bare topps because FCA- isn't in the override table.
    expect(slug).toContain(":topps:");
    expect(slug).not.toContain(":topps-chrome:");
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

  it("preserves specific parallel names (Orange Shimmer stays distinct)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EH", parallel: "Orange Shimmer Refractor", isAuto: true,
    });
    expect(s).toContain(":orange-shimmer-refractor:");
  });
});

describe("computeHobbyIqCardId — market vocabulary aliases", () => {
  it("True Green Refractor === Green Refractor (market synonym)", () => {
    const trueGreen = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "True Green Refractor",
      isAuto: true, printRun: 99,
    });
    const green = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Green Refractor",
      isAuto: true, printRun: 99,
    });
    // "True Green Refractor" says Refractor itself; stripping "True" is a
    // spelling fix, not a vocabulary rule — still the same slug.
    expect(trueGreen).toBe(green);
    // CF-CHROME-PREFIX-OVERRIDE-NARROW (2026-08-10). CPA- with
    // setKey="Bowman" upgrades to bowman-chrome.
    expect(trueGreen).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:green-refractor:auto:num-99");
  });

  it("True Blue Refractor === Blue Refractor (market synonym)", () => {
    const trueBlue = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "True Blue Refractor",
      isAuto: true, printRun: 150,
    });
    const blue = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Blue Refractor",
      isAuto: true, printRun: 150,
    });
    expect(trueBlue).toBe(blue);
  });

  it("True Blue (no explicit Refractor) is Blue — the catalog decides the refractor, not the generator (CF-COLOUR-FOLLOWS-THE-CHECKLIST)", () => {
    // 2026-07-28 (CF-TRUE-COLOR-IMPLIES-REFRACTOR) forced "-refractor" after a
    // stripped "True". Drew, 2026-08-30: "color does not always mean
    // refractor … remove rules, and follow it to the checklist or catalog".
    // Measured that night: Topps Tribute's checklists name 19,099 bare-colour
    // parallels with no refractor form; Finest lists "Uncommon" AND "Uncommon
    // Refractor" as two cards. The generator writes what was said; the
    // catalog resolver (unique long-form candidate) maps "Blue" onto "Blue
    // Refractor" only when that is the one blue row the card has.
    const trueBlue = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Draft",
      cardNumber: "CPA-JHA", parallel: "True Blue",
      isAuto: true, printRun: null,
    });
    const blueRefractor = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Draft",
      cardNumber: "CPA-JHA", parallel: "Blue Refractor",
      isAuto: true, printRun: null,
    });
    expect(trueBlue).not.toBe(blueRefractor);
    expect(trueBlue).toBe("hiq:baseball:2025:bowman-draft:cpa-jha:blue:auto");
  });

  it("a bare colour on Topps Tribute stays the colour the checklist names (CF-COLOUR-FOLLOWS-THE-CHECKLIST)", () => {
    // 2025 Topps Tribute #56 is stored as :blue: from the checklist ("Blue");
    // the removed product-level rule slugged every sale titled "Blue" as
    // :blue-refractor:, a twin the checklist never had.
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Topps Tribute",
      cardNumber: "56", parallel: "Blue", isAuto: false, printRun: null,
    });
    expect(s).toBe("hiq:baseball:2025:topps-tribute:56:blue:no-auto");
  });

  it("does NOT collapse Green Shimmer / Green Lava into base green", () => {
    // These are distinct variants with different premiums; they must
    // stay distinct even though they share the "green" root color.
    const greenShimmer = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Green Shimmer Refractor",
      isAuto: true, printRun: 99,
    });
    const greenLava = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Green Lava Refractor",
      isAuto: true, printRun: 99,
    });
    const trueGreen = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "True Green Refractor",
      isAuto: true, printRun: 99,
    });
    // All three are distinct
    expect(greenShimmer).not.toBe(greenLava);
    expect(greenShimmer).not.toBe(trueGreen);
    expect(greenLava).not.toBe(trueGreen);
    expect(greenShimmer).toContain("green-shimmer-refractor");
    expect(greenLava).toContain("green-lava-refractor");
    expect(trueGreen).toContain("green-refractor");
  });

  it("does NOT strip 'true' from the MIDDLE of a variant name", () => {
    // Hypothetical variant using "true" as an internal word — the
    // regex must only strip leading "true " with whitespace after.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "1", parallel: "Silver True Metal",
      isAuto: false,
    });
    // Should keep "true" mid-string
    expect(slug).toContain("silver-true-metal");
  });

  it("case-insensitive True prefix (TRUE / true / True)", () => {
    const upper = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "1",
      parallel: "TRUE BLUE REFRACTOR", isAuto: true, printRun: 150,
    });
    const mixed = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "1",
      parallel: "True Blue Refractor", isAuto: true, printRun: 150,
    });
    const lower = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "1",
      parallel: "true blue refractor", isAuto: true, printRun: 150,
    });
    expect(upper).toBe(mixed);
    expect(mixed).toBe(lower);
  });

  it("True Refractor (numbered /499) === Refractor /499", () => {
    // "True Refractor" without a color is the purist's shorthand for the
    // base silver refractor auto (numbered /499 in modern Bowman/Topps
    // Chrome). Same physical card either way.
    const trueVariant = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "CPA-EHA",
      parallel: "True Refractor", isAuto: true, printRun: 499,
    });
    const bareVariant = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "CPA-EHA",
      parallel: "Refractor", isAuto: true, printRun: 499,
    });
    expect(trueVariant).toBe(bareVariant);
    expect(trueVariant).toContain(":refractor:");
    expect(trueVariant.endsWith(":num-499")).toBe(true);
  });
});

describe("computeHobbyIqCardId — compound-variant unification", () => {
  it("Ray Wave === Raywave (space vs no-space)", () => {
    // Cardsight and CH sometimes emit "Ray Wave", sometimes "Raywave".
    // Same physical variant — must slug to the same canonical form.
    const spaced = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Ray Wave Refractor",
      isAuto: true, printRun: 99,
    });
    const unspaced = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Raywave Refractor",
      isAuto: true, printRun: 99,
    });
    expect(spaced).toBe(unspaced);
    expect(spaced).toContain("ray-wave-refractor");
  });

  it("Green Ray Wave === Green Raywave (with color prefix)", () => {
    const spaced = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Green Ray Wave Refractor",
      isAuto: true, printRun: 99,
    });
    const unspaced = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman",
      cardNumber: "CPA-EHA", parallel: "Green Raywave Refractor",
      isAuto: true, printRun: 99,
    });
    expect(spaced).toBe(unspaced);
    expect(spaced).toContain("green-ray-wave-refractor");
  });

  it("X-Fractor === Xfractor (hyphen vs no-hyphen)", () => {
    // Topps Chrome X-Fractor. Same variant, two spellings in the wild.
    const hyphenated = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Topps Chrome",
      cardNumber: "1", parallel: "X-Fractor",
      isAuto: false, printRun: 199,
    });
    const solid = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Topps Chrome",
      cardNumber: "1", parallel: "Xfractor",
      isAuto: false, printRun: 199,
    });
    expect(hyphenated).toBe(solid);
    expect(hyphenated).toContain("x-fractor");
  });

  it("Blue X-Fractor === Blue Xfractor (with color prefix)", () => {
    const hyphenated = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Topps Chrome",
      cardNumber: "1", parallel: "Blue X-Fractor",
      isAuto: false, printRun: 150,
    });
    const solid = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Topps Chrome",
      cardNumber: "1", parallel: "Blue Xfractor",
      isAuto: false, printRun: 150,
    });
    expect(hyphenated).toBe(solid);
    expect(hyphenated).toContain("blue-x-fractor");
  });
});

describe("computeHobbyIqCardId — Sapphire is a distinct product line", () => {
  it("Bowman Chrome Sapphire !== Bowman Chrome", () => {
    // Sapphire is its own product line (glossy blue-tinted chrome finish),
    // NOT a parallel of the flagship. Must map to a distinct setKey.
    const sapphire = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "2026 Bowman Chrome Sapphire",
      cardNumber: "BCP-102", parallel: "Base",
      isAuto: false, printRun: null,
    });
    const flagship = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "2026 Bowman Chrome",
      cardNumber: "BCP-102", parallel: "Base",
      isAuto: false, printRun: null,
    });
    expect(sapphire).not.toBe(flagship);
    expect(sapphire).toContain(":bowman-chrome-sapphire:");
    expect(flagship).toContain(":bowman-chrome:");
  });

  it("Topps Chrome Sapphire !== Topps Chrome", () => {
    const sapphire = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "2024 Topps Chrome Sapphire",
      cardNumber: "1", parallel: "Base",
      isAuto: false, printRun: null,
    });
    const flagship = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "2024 Topps Chrome",
      cardNumber: "1", parallel: "Base",
      isAuto: false, printRun: null,
    });
    expect(sapphire).not.toBe(flagship);
    expect(sapphire).toContain(":topps-chrome-sapphire:");
    expect(flagship).toContain(":topps-chrome:");
  });

  it("Bowman Sapphire (abbrev) collapses to bowman-chrome-sapphire", () => {
    // Vendors occasionally write "Bowman Sapphire" as shorthand for
    // the full "Bowman Chrome Sapphire" product line.
    const abbrev = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "2026 Bowman Sapphire",
      cardNumber: "BCP-102", parallel: "Base",
      isAuto: false, printRun: null,
    });
    expect(abbrev).toContain(":bowman-chrome-sapphire:");
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

// CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Regressions.
describe("matchKnownProductLine — strict product-line detection", () => {
  it("returns panini-playoff for a Panini Playoff title (was falling through to slugify)", () => {
    expect(matchKnownProductLine("2020 Panini Playoff Justin Herbert RC Call to Arms Gold Prizm 3/10 PSA 10"))
      .toBe("panini-playoff");
  });
  it("returns panini-prizm for a Panini Prizm title", () => {
    expect(matchKnownProductLine("2020 Panini Prizm Silver Ja Morant Rookie"))
      .toBe("panini-prizm");
  });
  it("returns panini-select for a Panini Select title", () => {
    expect(matchKnownProductLine("2020 Panini Select Justin Herbert #244 Club Level Blue Prizm"))
      .toBe("panini-select");
  });
  it("returns topps-chrome for a Topps Chrome title", () => {
    expect(matchKnownProductLine("2024 Topps Chrome Refractor Aaron Judge"))
      .toBe("topps-chrome");
  });
  it("returns bowman-chrome-sapphire (edition specificity preserved)", () => {
    expect(matchKnownProductLine("2020 BOWMAN CHROME SAPPHIRE Bobby Witt Jr Auto"))
      .toBe("bowman-chrome-sapphire");
  });
  it("returns bowman-chrome for a Bowman Chrome title", () => {
    expect(matchKnownProductLine("2024 Bowman Chrome Eric Hartman CPA-EHA"))
      .toBe("bowman-chrome");
  });
  it("returns null when NO known product-line pattern matches (strict — no fall-through)", () => {
    expect(matchKnownProductLine("just some random text about cards"))
      .toBeNull();
    expect(matchKnownProductLine(""))
      .toBeNull();
  });
  it("returns panini-classics on a football classics title (previously missing rule)", () => {
    expect(matchKnownProductLine("2020 Panini Classics Justin Herbert RC #201"))
      .toBe("panini-classics");
  });
  it("longest-match-first: 'Bowman Chrome Prospects' → bowman-chrome (not chrome-prospects fallback)", () => {
    expect(matchKnownProductLine("2024 Bowman Chrome Prospects CPA-EHA Eric Hartman"))
      .toBe("bowman-chrome");
  });

  // CF-PRODUCT-LINES-V3-EXPANSION (Drew, 2026-07-30). Vocab v3 additions
  // — fixes the ~5-6K raw-slugified rows the setKey audit found.
  it("Flair title → flair", () => {
    expect(matchKnownProductLine("2003 Flair Baseball #2 Base")).toBe("flair");
  });
  it("Flair Showcase → flair (both variants pool)", () => {
    expect(matchKnownProductLine("1998 Flair Showcase Row 2 Ken Griffey Jr")).toBe("flair");
  });
  it("Goudey vintage → goudey", () => {
    expect(matchKnownProductLine("1933 R319 Goudey Baseball #53 Babe Ruth")).toBe("goudey");
  });
  it("Pinnacle Aficionado → pinnacle-aficionado (specific wins over generic)", () => {
    expect(matchKnownProductLine("1996 Pinnacle Aficionado Baseball #4 Base")).toBe("pinnacle-aficionado");
  });
  it("Pinnacle (bare) → pinnacle", () => {
    expect(matchKnownProductLine("1993 Pinnacle Baseball #100 Barry Bonds")).toBe("pinnacle");
  });
  it("SP Prospects → sp-prospects", () => {
    expect(matchKnownProductLine("2004 SP Prospects Baseball #140 Base")).toBe("sp-prospects");
  });
  it("SP Authentic → sp-authentic", () => {
    expect(matchKnownProductLine("2001 SP Authentic Chirography Ken Griffey Jr")).toBe("sp-authentic");
  });
});

// CF-CHROME-STOCK-REDUNDANT-PREFIX regression suite (Drew, 2026-08-11).
// Cleanliness canary flagged 8.28% slug-fragmentation rate on 2026-08-11
// driven partly by CH's habit of labeling Bowman Chrome parallels with a
// redundant "Chrome" stock prefix ("Chrome Sky Blue Refractor" vs the
// collector-standard "Sky Blue Refractor"). Both spellings must produce
// the same slug on chrome-family setKeys.
describe("computeHobbyIqCardId — chrome stock prefix strip", () => {
  it("bowman-chrome: 'Chrome Sky Blue Refractor' === 'Sky Blue Refractor'", () => {
    const withChrome = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-185", parallel: "Chrome Sky Blue Refractor", isAuto: false,
    });
    const bare = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-185", parallel: "Sky Blue Refractor", isAuto: false,
    });
    expect(withChrome).toBe(bare);
    expect(withChrome).toContain(":sky-blue-refractor:");
    expect(withChrome).not.toContain(":chrome-sky-blue-refractor:");
  });

  it("bowman-chrome: 'Chrome Sparkle Refractor' → 'sparkle-refractor'", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-1", parallel: "Chrome Sparkle Refractor", isAuto: false,
    });
    expect(s).toContain(":sparkle-refractor:");
  });

  it("bowman-chrome: 'Chrome Refractor' → 'refractor' (base refractor)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-185", parallel: "Chrome Refractor", isAuto: false,
    });
    expect(s).toContain(":refractor:");
    expect(s).not.toContain(":chrome-refractor:");
  });

  it("bowman-chrome: bare 'Chrome' collapses to base (redundant with stock)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-185", parallel: "Chrome", isAuto: false,
    });
    expect(s).toContain(":base:");
  });

  // "Bowman Draft Chrome" is a vendor spelling, not a product a checklist
  // names. It resolves to bowman-draft — the product Topps published.
  it("BDC- routes to bowman-draft even when vendor sends 'Bowman Draft Chrome'", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Draft Chrome",
      cardNumber: "BDC-185", parallel: "Sky Blue Refractor", isAuto: false,
    });
    expect(s).toContain(":bowman-draft:");
    expect(s).not.toContain(":bowman-chrome:");
  });

  it("topps-heritage: 'Chrome Refractor' is PRESERVED (legit insert-set parallel)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Topps Heritage",
      cardNumber: "150", parallel: "Chrome Refractor", isAuto: false,
    });
    // Heritage isn't chrome-family — the "Chrome" prefix identifies the
    // chrome INSERT within Heritage and must be preserved as a distinct
    // slug from bare "Refractor" or "Base".
    expect(s).toContain(":topps-heritage:");
    expect(s).toContain(":chrome-refractor:");
  });

  it("bowman-chrome: non-chrome-prefixed parallels are unaffected", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-1", parallel: "Blue Refractor", isAuto: false, printRun: 150,
    });
    expect(s).toContain(":blue-refractor:");
  });
});

// PANINI-STOCK-IMPLIES-PRIZM regression suite REMOVED (Drew, 2026-08-11):
// Drafted an analog "Silver → Silver Prizm" rule after seeing near-parity
// in cross-parallel-ratios (n=369, ratio=1.00). Drew corrected in-turn:
// bare "Silver" and "Silver Prizm" are DISTINCT parallels on Panini
// flagship; the near-parity price is coincidence, not identity. Kept
// this note so a future test-first pass does not resurrect the wrong
// rule. Only add unification rules when the collector taxonomy is
// confirmed, not when the ratio looks close.
// CF-NO-DOUBLE-FRACTOR regression (Drew, 2026-08-11). X-Fractor,
// FoilFractor, FrozenFractor etc. ARE refractor variants — appending
// "-refractor" produces `x-fractor-refractor` which fragmented against
// bare `x-fractor` (n=581 in the 2026-08-11 cleanliness canary).
describe("computeHobbyIqCardId — no double -fractor on chrome stock", () => {
  it("X-Fractor stays x-fractor (no double refractor suffix)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Topps Chrome",
      cardNumber: "1", parallel: "X-Fractor", isAuto: false,
    });
    expect(s).toContain(":x-fractor:");
    expect(s).not.toContain(":x-fractor-refractor:");
  });
  it("Xfractor (compact spelling) unifies to x-fractor, no double suffix", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Topps Chrome",
      cardNumber: "1", parallel: "Xfractor", isAuto: false,
    });
    expect(s).toContain(":x-fractor:");
    expect(s).not.toContain(":x-fractor-refractor:");
  });
  it("SuperFractor stays superfractor", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-1", parallel: "SuperFractor", isAuto: false, printRun: 1,
    });
    expect(s).toContain(":superfractor:");
    expect(s).not.toContain(":superfractor-refractor:");
  });
  it("Blue Refractor unchanged (already carries -refractor)", () => {
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-1", parallel: "Blue Refractor", isAuto: false, printRun: 150,
    });
    expect(s).toContain(":blue-refractor:");
  });
  it("bare 'Blue' stays :blue: — the product-level append is gone (CF-COLOUR-FOLLOWS-THE-CHECKLIST, Drew 2026-08-30)", () => {
    // The catalog resolver maps it onto :blue-refractor: only when that is the
    // one blue row the card has; the generator no longer assumes it.
    const s = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman Chrome",
      cardNumber: "BDC-1", parallel: "Blue", isAuto: false,
    });
    expect(s).toContain(":blue:");
    expect(s).not.toContain(":blue-refractor:");
  });
});

// CF-AUTO-ONLY-PREFIXES regression suite (Drew, 2026-08-11).
// CPA-/BCPA-/BDCPA-/CDA-/TCPA-/CRA-/BSPA-/BPA-/BDA- cardNumbers are
// auto-only by product definition. Vendors sometimes ship these
// sales with isAuto=false (raw title parsing, short CH titles); prior
// slug generator honored that and produced :no-auto slugs alongside
// the correct :auto slugs, doubling the pool. Force isAuto=true.
describe("computeHobbyIqCardId — auto-only prefix forces isAuto=true", () => {
  it("CPA-EHA with vendor isAuto=false still produces :auto slug", () => {
    const withFalse = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman Chrome",
      cardNumber: "CPA-EHA", parallel: "Orange Shimmer Refractor",
      isAuto: false, printRun: 25,
    });
    const withTrue = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "Bowman Chrome",
      cardNumber: "CPA-EHA", parallel: "Orange Shimmer Refractor",
      isAuto: true, printRun: 25,
    });
    expect(withFalse).toBe(withTrue);
    expect(withFalse).toContain(":auto:num-25");
    expect(withFalse).not.toContain(":no-auto");
  });

  it("BCPA-, BDCPA-, CDA-, TCPA-, CRA-, BSPA-, BPA-, BDA- all force auto", () => {
    for (const prefix of ["BCPA-JR", "BDCPA-EH", "CDA-EH", "TCPA-SO", "CRA-BW", "BSPA-EH", "BPA-EH", "BDA-EH"]) {
      const s = computeHobbyIqCardId({
        sport: "baseball", year: 2025, setKey: "Bowman",
        cardNumber: prefix, parallel: "Base", isAuto: false,
      });
      expect(s, `${prefix} should force :auto`).toContain(":auto");
      expect(s).not.toContain(":no-auto");
    }
  });

  it("Non-auto prefix (BCP-, plain number) still respects vendor isAuto=false", () => {
    // BCP- is Chrome Prospect (not-auto insert). Should NOT force auto.
    const bcp = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman",
      cardNumber: "BCP-102", parallel: "Base", isAuto: false,
    });
    expect(bcp).toContain(":no-auto");
    // Plain number (100) is a flagship card — no auto forcing.
    const plain = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Topps",
      cardNumber: "150", parallel: "Base", isAuto: false,
    });
    expect(plain).toContain(":no-auto");
  });
});

describe("computeHobbyIqCardId — panini Silver vs Silver Prizm (must stay distinct)", () => {
  it("'Silver' and 'Silver Prizm' produce DIFFERENT slugs on Panini Prizm", () => {
    const bare = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Panini Prizm",
      cardNumber: "50", parallel: "Silver", isAuto: false,
    });
    const withPrizm = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Panini Prizm",
      cardNumber: "50", parallel: "Silver Prizm", isAuto: false,
    });
    expect(bare).not.toBe(withPrizm);
    expect(bare).toContain(":silver:");
    expect(withPrizm).toContain(":silver-prizm:");
  });
});
