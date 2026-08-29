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
