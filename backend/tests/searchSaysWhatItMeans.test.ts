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
