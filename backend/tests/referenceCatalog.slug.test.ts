// CF-REFERENCE-CATALOG (2026-07-10, Drew) — shared slug + sha1Id
// invariants. Every doc id in the reference-catalog container depends
// on these being stable across runs; a change here would require a
// full re-ingest to reconcile old ids to new.

import { describe, it, expect } from "vitest";
import { slug, sha1Id } from "../src/shared/slug";

describe("slug — canonical string → url-safe stable slug", () => {
  it("lowercases + hyphenates spaces", () => {
    expect(slug("Bowman Chrome")).toBe("bowman-chrome");
    expect(slug("Chrome Prospect Autographs")).toBe("chrome-prospect-autographs");
  });

  it("collapses non-alnum runs into a single hyphen", () => {
    expect(slug("Bowman's Best")).toBe("bowmans-best");
    expect(slug("Blue X-Fractor /150 Auto")).toBe("blue-x-fractor-150-auto");
    expect(slug("Padparadscha Sapphire")).toBe("padparadscha-sapphire");
  });

  it("trims leading + trailing hyphens", () => {
    expect(slug("  Bowman  ")).toBe("bowman");
    expect(slug("--Bowman--")).toBe("bowman");
    expect(slug("///Chrome///")).toBe("chrome");
  });

  it("returns empty for null / undefined / empty input", () => {
    expect(slug(null)).toBe("");
    expect(slug(undefined)).toBe("");
    expect(slug("")).toBe("");
    expect(slug("   ")).toBe("");
    // A string that's ONLY punctuation slugs to empty (all runs collapse
    // to hyphens then trim).
    expect(slug("///")).toBe("");
  });

  it("handles unicode by stripping combining marks (NFKD)", () => {
    // Padparadscha appears in the reference workbook without diacritics,
    // but users might paste from Wikipedia which uses "Padparadschá" etc.
    expect(slug("Padparadschá")).toBe("padparadscha");
    expect(slug("naïve")).toBe("naive");
  });

  it("is stable across runs (same input → same output)", () => {
    const inputs = [
      "Bowman Chrome",
      "Chrome Prospect Autographs",
      "Blue Refractor",
      "Padparadscha Sapphire",
      "Bowman's Best",
    ];
    for (const s of inputs) {
      expect(slug(s)).toBe(slug(s));
      // And running the slug through slug() again is a no-op.
      expect(slug(slug(s))).toBe(slug(s));
    }
  });
});

describe("sha1Id — deterministic Cosmos document id", () => {
  it("same tuple → same id (idempotent upsert)", () => {
    expect(sha1Id(2026, "bowman-chrome", "chrome-prospect-autographs", "gold-refractor"))
      .toBe(sha1Id(2026, "bowman-chrome", "chrome-prospect-autographs", "gold-refractor"));
  });

  it("different fields → different ids (no accidental collision)", () => {
    const a = sha1Id(2026, "bowman-chrome", "chrome-prospect-autographs", "gold-refractor");
    const b = sha1Id(2025, "bowman-chrome", "chrome-prospect-autographs", "gold-refractor");
    const c = sha1Id(2026, "bowman-draft", "chrome-prospect-autographs", "gold-refractor");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("| delimiter avoids concatenation collisions", () => {
    // If we joined without a delimiter, sha1('ab' + 'c') === sha1('a' + 'bc')
    // by pre-image. The pipe delimiter disambiguates.
    const a = sha1Id("ab", "c");
    const b = sha1Id("a", "bc");
    expect(a).not.toBe(b);
  });

  it("nullish parts are treated as empty strings", () => {
    expect(sha1Id(2026, "bowman-chrome", null, "gold-refractor"))
      .toBe(sha1Id(2026, "bowman-chrome", "", "gold-refractor"));
    expect(sha1Id(2026, "bowman-chrome", undefined, "gold-refractor"))
      .toBe(sha1Id(2026, "bowman-chrome", "", "gold-refractor"));
  });

  it("returns a 40-char hex string (sha1 standard)", () => {
    const id = sha1Id(2026, "bowman-chrome", "chrome-prospect-autographs", "gold-refractor");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });
});
