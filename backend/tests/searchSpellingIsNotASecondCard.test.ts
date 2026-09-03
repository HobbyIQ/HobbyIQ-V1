import { describe, it, expect } from "vitest";
import { scoreCatalogRow } from "../src/services/catalog/catalogSearch.service.js";

// CF-A-SPELLING-IS-NOT-A-SECOND-CARD, applied to RANKING (2026-09-03).
//
// `foldSpelling` (D31) already answered "are these two strings the same rung
// spelled by two scrapers?", but only the dedup lane asked. Search scored the
// raw string, so the scraper spelling that repeats the finish outranked the
// canonical row by carrying the word twice. Both pairs below are real
// identity-triangulation misses, and both fold to ONE key -- so neither is a
// different card, and the query named the rung either way.
const tok = (q: string) => q.toLowerCase().replace(/[^a-z0-9#-]+/g, " ").replace(/#/g, "").trim().split(/\s+/).filter(Boolean);
const score = (q: string, row: Parameters<typeof scoreCatalogRow>[1]) => scoreCatalogRow(tok(q), row)?.score ?? -1;

describe("a spelling is not a second card", () => {
  it("the section-plural spelling does not outrank the checklist row", () => {
    const q = "Jarren Duran 2022 Bowman Chrome #16 Yellow Refractor Rookie RC 74/75";
    const canonical = { setKey: "bowman-chrome", cardNumber: "16", year: 2022, parallel: "Yellow Refractor", parallelSlug: "yellow-refractor", playerName: "Jarren Duran", searchTokens: ["2022", "bowman", "chrome", "16", "yellow", "refractor", "jarren", "duran"] };
    const doubled = { setKey: "bowman-chrome", cardNumber: "16", year: 2022, parallel: "Yellow Refractors Refractor", parallelSlug: "yellow-refractors-refractor", playerName: "Jarren Duran", searchTokens: ["2022", "bowman", "chrome", "16", "yellow", "refractors", "refractor", "jarren", "duran"] };
    expect(score(q, canonical)).toBeGreaterThanOrEqual(score(q, doubled));
  });

  it("a genuinely different parallel is still ranked apart", () => {
    // The fold must not turn every refractor into the same rung: "pearl" is a
    // colour the query never said, and it still pays for it.
    const q = "Jarren Duran 2022 Bowman Chrome #16 Yellow Refractor";
    const yellow = { setKey: "bowman-chrome", cardNumber: "16", year: 2022, parallel: "Yellow Refractor", parallelSlug: "yellow-refractor", playerName: "Jarren Duran" };
    const pearl = { setKey: "bowman-chrome", cardNumber: "16", year: 2022, parallel: "Pearl Refractor", parallelSlug: "pearl-refractor", playerName: "Jarren Duran" };
    expect(score(q, yellow)).toBeGreaterThan(score(q, pearl));
  });

  it("Base is untouched by the fold", () => {
    // isBaseRow reads the raw parallel, so the Base bonus and the "query
    // names no finish" rule behave exactly as before.
    const q = "2025 Bowman Draft Baseball #BD-143 Base";
    const base = { setKey: "bowman-draft", cardNumber: "BD-143", year: 2025, parallel: "Base", parallelSlug: "base", playerName: "A Prospect", searchTokens: ["2025", "bowman", "draft", "bd-143", "base"] };
    const colour = { setKey: "bowman-draft", cardNumber: "BD-143", year: 2025, parallel: "Blue Refractor", parallelSlug: "blue-refractor", playerName: "A Prospect", searchTokens: ["2025", "bowman", "draft", "bd-143", "blue", "refractor"] };
    expect(score(q, base)).toBeGreaterThan(score(q, colour));
  });
});
