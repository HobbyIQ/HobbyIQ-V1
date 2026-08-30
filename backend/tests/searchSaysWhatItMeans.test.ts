import { describe, it, expect } from "vitest";
import { scoreCatalogRow } from "../src/services/catalog/catalogSearch.service.js";

// CF-SEARCH-SAYS-WHAT-IT-MEANS (2026-08-29). The identity triangulation
// baseline found search landing on the same card only 30.5% of the time, and
// every miss was a row rewarded for words the query never said.
const tok = (q: string) => q.toLowerCase().replace(/[^a-z0-9#-]+/g, " ").replace(/#/g, "").trim().split(/\s+/).filter(Boolean);
const score = (q: string, row: Parameters<typeof scoreCatalogRow>[1]) => scoreCatalogRow(tok(q), row)?.score ?? -1;

describe("search says what it means", () => {
  it("#217 X-Fractor: the plain Topps Chrome X-Fractor beats Platinum Anniversary's Topps Refractor", () => {
    const q = "2024 Topps Chrome Baseball #217 X-Fractor";
    const right = { setKey: "topps-chrome", cardNumber: "217", year: 2024, parallel: "X-Fractor", parallelSlug: "x-fractor", playerName: "Some Player", searchTokens: ["2024", "topps", "chrome", "x-fractor", "217"] };
    const wrong = { setKey: "topps-chrome-platinum-anniversary", cardNumber: "217", year: 2024, parallel: "Topps Refractor", parallelSlug: "topps-refractor", playerName: "Some Player", searchTokens: ["2024", "topps", "chrome", "platinum", "anniversary", "topps", "refractor", "217"] };
    expect(score(q, right)).toBeGreaterThan(score(q, wrong));
  });
  it("#BD-143 Base: the Base row beats a 'base-cards' parallel", () => {
    const q = "2025 Bowman Draft Baseball #BD-143 Base";
    const base = { setKey: "bowman-draft", cardNumber: "BD-143", year: 2025, parallel: "Base", parallelSlug: "base", playerName: "A Prospect", searchTokens: ["2025", "bowman", "draft", "bd-143", "base"] };
    const baseCards = { setKey: "bowman-draft", cardNumber: "BD-143", year: 2025, parallel: "Base Cards", parallelSlug: "base-cards", playerName: "A Prospect", searchTokens: ["2025", "bowman", "draft", "bd-143", "base", "cards"] };
    expect(score(q, base)).toBeGreaterThan(score(q, baseCards));
  });
  it("#TCA-ARU: the card with that number beats a different card in a sister product", () => {
    const q = "2023 Topps Chrome Baseball #TCA-ARU Base";
    const right = { setKey: "topps-chrome", cardNumber: "TCA-ARU", year: 2023, parallel: "Base", parallelSlug: "base", playerName: "A Rookie", searchTokens: ["2023", "topps", "chrome", "tca-aru", "base"] };
    const wrong = { setKey: "topps-chrome-black", cardNumber: "CBA-MR", year: 2023, parallel: "Base", parallelSlug: "base", playerName: "Other Rookie", isAuto: true, searchTokens: ["2023", "topps", "chrome", "black", "cba-mr", "base", "auto"] };
    expect(score(q, right)).toBeGreaterThan(score(q, wrong));
  });
  it("a named finish still wins over Base when the query names it", () => {
    const q = "2022 Bowman Chrome George Kirby #34 Green Refractor";
    const green = { setKey: "bowman-chrome", cardNumber: "34", year: 2022, parallel: "Green Refractor", parallelSlug: "green-refractor", playerName: "George Kirby", searchTokens: ["2022", "bowman", "chrome", "george", "kirby", "34", "green", "refractor"] };
    const base = { setKey: "bowman-chrome", cardNumber: "34", year: 2022, parallel: "Base", parallelSlug: "base", playerName: "George Kirby", searchTokens: ["2022", "bowman", "chrome", "george", "kirby", "34", "base"] };
    expect(score(q, green)).toBeGreaterThan(score(q, base));
  });
});

// CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30). The edit-card search for "2025
// bowman refractor auto max williams" ranked Carson Williams Pearl Refractor
// above the Max Williams Refractor auto. Three scorer rules pinned here; the
// ranking itself is pinned in searchFullNameDominates.test.ts.
describe("search says what it means — a bare finish, auto, and the year", () => {
  it("a bare 'refractor' does not reward Pearl Refractor: Base >= Pearl, and the plain Refractor beats both", () => {
    const q = "2025 bowman refractor williams";
    const plain = { setKey: "bowman", cardNumber: "BWC-14", year: 2025, parallel: "Refractor", playerName: "Carson Williams", isAuto: false };
    const pearl = { setKey: "bowman", cardNumber: "BWC-14", year: 2025, parallel: "Pearl Refractor", playerName: "Carson Williams", isAuto: false };
    const base = { setKey: "bowman", cardNumber: "BWC-14", year: 2025, parallel: "Base", playerName: "Carson Williams", isAuto: false };
    expect(score(q, base)).toBeGreaterThanOrEqual(score(q, pearl));
    expect(score(q, plain)).toBeGreaterThan(score(q, pearl));
    expect(score(q, plain)).toBeGreaterThan(score(q, base));
  });

  it("'auto' in the query ranks the auto twin above the no-auto twin", () => {
    const q = "2025 bowman draft refractor auto max williams";
    const auto = { setKey: "bowman-draft", cardNumber: "CPA-MWI", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: true, printRun: 499 };
    const noAuto = { setKey: "bowman-draft", cardNumber: "BD-68", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: false };
    expect(score(q, auto)).toBeGreaterThan(score(q, noAuto));
  });

  it("with no 'auto' in the query, an auto row is not penalised", () => {
    // CF-SEARCH-CHECKLIST-OPTIONS: "show every auto option" — a query that is
    // silent on auto must not push the autos down the page.
    const q = "2025 bowman draft refractor max williams";
    const auto = { setKey: "bowman-draft", cardNumber: "CPA-MWI", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: true };
    const noAuto = { setKey: "bowman-draft", cardNumber: "CPA-MWI", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: false };
    expect(score(q, auto)).toBeCloseTo(score(q, noAuto), 9);
  });

  it("the query year is not a card number: #2025 earns no identifier bonus under a 2025 query", () => {
    // Live artefact: hockey "Savion Williams Freshman #2025" took the +1.0
    // exact-number bonus from the YEAR token and topped the page.
    const q = "2025 bowman refractor auto williams";
    const numberedByYear = { setKey: "bowman", cardNumber: "2025", year: 2025, parallel: "Base", playerName: "Savion Williams", isAuto: true };
    const numberedNormally = { setKey: "bowman", cardNumber: "SW-1", year: 2025, parallel: "Base", playerName: "Savion Williams", isAuto: true };
    expect(score(q, numberedByYear)).toBeCloseTo(score(q, numberedNormally), 9);
  });
});

// CF-SEARCH-FULL-NAME-DOMINATES refutation (2026-08-30). The first cut of
// the every-word rule made "refractor" a word the query had to say, so a
// bare colour no longer named its Refractor: "2023 topps chrome gold ohtani"
// went from Gold Refractor 0.550 > Base 0.500 to Base 0.500 > Gold Refractor
// 0.400 (measured), and three more bare-colour queries flipped the same way.
// Colour == Colour Refractor per card, the catalog keeping the long form, so
// the colour word names the parallel; only the finish SUFFIX is free. Both
// shapes pinned with the verbatim queries.
describe("search says what it means — a bare colour names its Refractor; a bare Refractor names no colour", () => {
  const row = (setKey: string, cardNumber: string, year: number, parallel: string, playerName: string) =>
    ({ setKey, cardNumber, year, parallel, playerName, isAuto: false });

  it("2023 topps chrome gold ohtani: Gold Refractor > Base > Refractor > Gold Wave Refractor", () => {
    const q = "2023 topps chrome gold ohtani";
    const gold = row("topps-chrome", "17", 2023, "Gold Refractor", "Shohei Ohtani");
    const base = row("topps-chrome", "17", 2023, "Base", "Shohei Ohtani");
    const plain = row("topps-chrome", "17", 2023, "Refractor", "Shohei Ohtani");
    const goldWave = row("topps-chrome", "17", 2023, "Gold Wave Refractor", "Shohei Ohtani");
    expect(score(q, gold)).toBeGreaterThan(score(q, base));
    expect(score(q, base)).toBeGreaterThan(score(q, plain));
    // A pattern is not a suffix: "gold" does not name Gold Wave.
    expect(score(q, gold)).toBeGreaterThan(score(q, goldWave));
    expect(score(q, base)).toBeGreaterThan(score(q, goldWave));
  });

  it("2024 bowman chrome blue leo de vries: Blue Refractor > Base", () => {
    const q = "2024 bowman chrome blue leo de vries";
    expect(score(q, row("bowman-chrome", "BCP-179", 2024, "Blue Refractor", "Leo De Vries")))
      .toBeGreaterThan(score(q, row("bowman-chrome", "BCP-179", 2024, "Base", "Leo De Vries")));
  });

  it("2022 bowman chrome green george kirby 34: Green Refractor > Base", () => {
    const q = "2022 bowman chrome green george kirby 34";
    expect(score(q, row("bowman-chrome", "34", 2022, "Green Refractor", "George Kirby")))
      .toBeGreaterThan(score(q, row("bowman-chrome", "34", 2022, "Base", "George Kirby")));
  });

  it("2024 topps chrome pink ohtani: Pink Refractor > Base", () => {
    const q = "2024 topps chrome pink ohtani";
    expect(score(q, row("topps-chrome", "1", 2024, "Pink Refractor", "Shohei Ohtani")))
      .toBeGreaterThan(score(q, row("topps-chrome", "1", 2024, "Base", "Shohei Ohtani")));
  });

  it("a bare colour names its Prizm the same way: 2024 select silver wembanyama", () => {
    const q = "2024 select silver wembanyama";
    expect(score(q, row("panini-select", "1", 2024, "Silver Prizm", "Victor Wembanyama")))
      .toBeGreaterThan(score(q, row("panini-select", "1", 2024, "Base", "Victor Wembanyama")));
  });

  it("2025 bowman refractor auto max williams: the Bowman Draft CPA-MWI Refractor auto is first, and Pearl Refractor earns nothing for a colour the query never said", () => {
    const q = "2025 bowman refractor auto max williams";
    const target = { setKey: "bowman-draft", setName: "Bowman Draft", cardNumber: "CPA-MWI", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: true, printRun: 499 };
    const carsonPearl = { setKey: "bowman", setName: "Bowman", cardNumber: "BTP-3", year: 2025, parallel: "Pearl Refractor", playerName: "Carson Williams", isAuto: false };
    const carsonRed = { setKey: "bowman", setName: "Bowman", cardNumber: "BTP-3", year: 2025, parallel: "Red Refractor", playerName: "Carson Williams", isAuto: false };
    const carsonOrange = { setKey: "bowman", setName: "Bowman", cardNumber: "BTP-3", year: 2025, parallel: "Orange Refractor", playerName: "Carson Williams", isAuto: false };
    const carsonPlain = { setKey: "bowman", setName: "Bowman", cardNumber: "BWC-14", year: 2025, parallel: "Refractor", playerName: "Carson Williams", isAuto: false };
    const carsonBase = { setKey: "bowman", setName: "Bowman", cardNumber: "BWC-14", year: 2025, parallel: "Base", playerName: "Carson Williams", isAuto: false };
    const jettGreen = { setKey: "bowman", setName: "Bowman", cardNumber: "BTP-58", year: 2025, parallel: "Green Refractor", playerName: "Jett Williams", isAuto: false };
    const t = score(q, target);
    for (const other of [carsonPearl, carsonRed, carsonOrange, carsonPlain, carsonBase, jettGreen]) {
      expect(t).toBeGreaterThan(score(q, other));
    }
    // The plain Refractor is what "refractor" names; the colours are not.
    expect(score(q, carsonPlain)).toBeGreaterThan(score(q, carsonPearl));
    expect(score(q, carsonBase)).toBeGreaterThanOrEqual(score(q, carsonPearl));
    expect(score(q, carsonBase)).toBeGreaterThanOrEqual(score(q, jettGreen));
  });
});

// The full-name bonus is fuzzy on 5+ letter words, keyed on the SHORTER word
// as fuzzyIncludes keys on the query token. Keyed on the row word, "williams"
// (8 letters, budget 2) accepted "willis", and a query for Max Willis paid
// Max Williams the +0.5 that decides the page.
describe("the full-name bonus does not reach a different surname", () => {
  const maxWilliams = { setKey: "bowman-draft", cardNumber: "BD-68", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: false };
  const maxWillis = { setKey: "bowman-draft", cardNumber: "BD-99", year: 2025, parallel: "Refractor", playerName: "Max Willis", isAuto: false };

  it("'max willis' does not earn Max Williams the full-name bonus; Max Willis outranks him by the bonus", () => {
    const q = "2025 bowman refractor max willis";
    expect(score(q, maxWillis) - score(q, maxWilliams)).toBeGreaterThan(0.5);
  });

  it("a real misspelling of the same length still earns it: 'max willaims'", () => {
    const misspelt = "2025 bowman refractor max willaims";
    const wrongMan = "2025 bowman refractor max willis";
    expect(score(misspelt, maxWilliams) - score(wrongMan, maxWilliams)).toBeGreaterThan(0.5);
  });
});

// CF-SEARCH-FULL-NAME-DOMINATES second refutation (2026-08-30). The suffix
// was excluded from the named-parallel BONUS but still charged -0.2 as an
// "unnamed" parallel word, so a colour row cleared Base only by the raw
// parallel-field token, 1.5/(3n), against +0.15 - 0.2: a margin of
// 0.5/n - 0.05 that is ZERO at ten query tokens and negative beyond. Measured
// on 526097cd: "2024 bowman chrome leo de vries blue bcp-179 padres rc" (10
// tokens) tied Blue Refractor with Base at 1.9833, and the tie broke on comps
// count, which favours Base. One rule now governs both halves: once the query
// names a colour or pattern word of the parallel, the finish suffix is not a
// word the query had to say -- no bonus requirement, no penalty. The margin
// is a flat +0.2 at every query length.
describe("the finish suffix is not an unnamed word once the colour is named", () => {
  const row = (parallel: string, playerName = "Leo De Vries", cardNumber = "BCP-179", setKey = "bowman-chrome", year = 2024) =>
    ({ setKey, cardNumber, year, parallel, playerName, isAuto: false });

  it("10 tokens: 'blue' still names Blue Refractor over Base (the measured tie)", () => {
    const q = "2024 bowman chrome leo de vries blue bcp-179 padres rc";
    expect(tok(q)).toHaveLength(10);
    expect(score(q, row("Blue Refractor")) - score(q, row("Base"))).toBeGreaterThan(0.1);
  });

  it("12+ tokens: the margin does not decay with query length", () => {
    const short = "2024 bowman chrome blue leo de vries";
    const long = "2024 bowman chrome leo de vries blue bcp-179 san diego padres rc prospect";
    expect(tok(long).length).toBeGreaterThanOrEqual(12);
    const marginLong = score(long, row("Blue Refractor")) - score(long, row("Base"));
    const marginShort = score(short, row("Blue Refractor")) - score(short, row("Base"));
    // Under the old rule the margin was 0.5/n - 0.05 and CROSSED ZERO at ten
    // tokens. Forgiving the suffix adds a flat +0.2 to the colour row, so the
    // 0.5/n term still decays but the sum no longer approaches zero: the
    // long-query margin stays a large fraction of the short-query one instead
    // of going negative.
    expect(marginLong).toBeGreaterThan(0.1);
    expect(marginLong).toBeGreaterThan(marginShort * 0.6);
  });

  it("the four bare-colour queries still put the colour first", () => {
    const cases: Array<[string, ReturnType<typeof row>, ReturnType<typeof row>]> = [
      ["2023 topps chrome gold ohtani", row("Gold Refractor", "Shohei Ohtani", "17", "topps-chrome", 2023), row("Base", "Shohei Ohtani", "17", "topps-chrome", 2023)],
      ["2024 bowman chrome blue leo de vries", row("Blue Refractor"), row("Base")],
      ["2022 bowman chrome green george kirby 34", row("Green Refractor", "George Kirby", "34", "bowman-chrome", 2022), row("Base", "George Kirby", "34", "bowman-chrome", 2022)],
      ["2024 topps chrome pink ohtani", row("Pink Refractor", "Shohei Ohtani", "1", "topps-chrome", 2024), row("Base", "Shohei Ohtani", "1", "topps-chrome", 2024)],
    ];
    for (const [q, colour, base] of cases) expect(score(q, colour)).toBeGreaterThan(score(q, base));
  });

  it("a bare 'refractor' still earns Pearl Refractor nothing: no colour is named, so 'pearl' is still unnamed", () => {
    // Max Williams' defect. The suffix is forgiven only once some OTHER word
    // of the parallel is named; under a bare "refractor" none is.
    const q = "2025 bowman refractor williams";
    const plain = row("Refractor", "Carson Williams", "BWC-14", "bowman", 2025);
    const pearl = row("Pearl Refractor", "Carson Williams", "BWC-14", "bowman", 2025);
    const base = row("Base", "Carson Williams", "BWC-14", "bowman", 2025);
    expect(score(q, plain)).toBeGreaterThan(score(q, base));
    expect(score(q, base)).toBeGreaterThan(score(q, pearl));
  });

  it("a pattern is still not a suffix: 'blue' does not name Blue Wave Refractor", () => {
    const q = "2024 bowman chrome leo de vries blue bcp-179 padres rc";
    expect(score(q, row("Blue Refractor"))).toBeGreaterThan(score(q, row("Blue Wave Refractor")));
  });

  it("Base still wins when the query names no finish at all", () => {
    const q = "2024 bowman chrome leo de vries bcp-179 padres rc";
    expect(score(q, row("Base"))).toBeGreaterThan(score(q, row("Refractor")));
    expect(score(q, row("Base"))).toBeGreaterThan(score(q, row("Blue Refractor")));
  });
});
