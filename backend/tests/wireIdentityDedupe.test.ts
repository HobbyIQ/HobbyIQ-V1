// CF-WIRE-IDENTITY-DEDUPE (Drew, 2026-07-13) — verifies the /search-hit
// composer's identity-field normalizers:
//   - strips leading YYYY from setName when structured year is populated
//     OR extractable from the set string itself, so iOS' header
//     "[year] {setName}" composer stops producing "2026 2026 Bowman…"
//   - strips "Auto"/"Autograph" tokens from parallel/variant so iOS'
//     "[variant] Auto" composer stops producing "…Refractor Auto Auto"
//   - extracts a year from setName when the structured year field is null,
//     so Cardsight-catalog rows (which carry year null + year-in-setName)
//     surface year to iOS

import { describe, expect, it } from "vitest";
import {
  extractYearFromSetText,
  stripLeadingYear,
  stripAutoFromVariant,
} from "../src/services/unifiedSearch/dispatcher.js";

describe("extractYearFromSetText", () => {
  it("pulls the year from a Cardsight-catalog set string", () => {
    expect(extractYearFromSetText("2026 Bowman Baseball")).toBe(2026);
    expect(extractYearFromSetText("1998 Leaf Rookies and Stars Baseball")).toBe(1998);
    expect(extractYearFromSetText("2024 Topps Chrome")).toBe(2024);
  });

  it("returns null when no 4-digit year is present", () => {
    expect(extractYearFromSetText("Bowman Baseball")).toBeNull();
    expect(extractYearFromSetText("")).toBeNull();
    expect(extractYearFromSetText(null)).toBeNull();
    expect(extractYearFromSetText(undefined)).toBeNull();
  });

  it("only accepts the 19xx/20xx range (guards against random 4-digit noise)", () => {
    expect(extractYearFromSetText("Set 1500 Vintage")).toBeNull();
    expect(extractYearFromSetText("Card #1234")).toBeNull();
  });
});

describe("stripLeadingYear", () => {
  it("removes a leading YYYY + whitespace from a set string", () => {
    expect(stripLeadingYear("2026 Bowman Baseball")).toBe("Bowman Baseball");
    expect(stripLeadingYear("1998 Leaf Rookies and Stars Baseball")).toBe(
      "Leaf Rookies and Stars Baseball",
    );
  });

  it("is idempotent — no leading year is a no-op", () => {
    expect(stripLeadingYear("Bowman Baseball")).toBe("Bowman Baseball");
    expect(stripLeadingYear("Bowman Chrome Prospects")).toBe(
      "Bowman Chrome Prospects",
    );
  });

  it("returns null on empty / null / undefined / whitespace-only inputs", () => {
    expect(stripLeadingYear(null)).toBeNull();
    expect(stripLeadingYear(undefined)).toBeNull();
    expect(stripLeadingYear("")).toBeNull();
    expect(stripLeadingYear("   ")).toBeNull();
  });

  it("only strips a year prefix, never a year embedded elsewhere in the name", () => {
    // "Topps Update 2024" style — year is not a prefix, so leave it.
    expect(stripLeadingYear("Topps Update 2024")).toBe("Topps Update 2024");
  });

  it("returns null when the string is ONLY a year (nothing meaningful left)", () => {
    expect(stripLeadingYear("2026")).toBeNull();
    expect(stripLeadingYear("  2026  ")).toBeNull();
  });
});

describe("stripAutoFromVariant", () => {
  it("removes standalone 'Auto' tokens", () => {
    expect(stripAutoFromVariant("True Blue Refractor Auto")).toBe(
      "True Blue Refractor",
    );
    expect(stripAutoFromVariant("Auto Speckle Refractor")).toBe(
      "Speckle Refractor",
    );
    expect(stripAutoFromVariant("Refractor Auto Prizm")).toBe(
      "Refractor Prizm",
    );
  });

  it("removes 'Autograph' and 'Autographed' variants case-insensitively", () => {
    expect(stripAutoFromVariant("Blue Refractor Autograph")).toBe(
      "Blue Refractor",
    );
    expect(stripAutoFromVariant("Gold AUTOGRAPHED Insert")).toBe(
      "Gold Insert",
    );
    expect(stripAutoFromVariant("silver auto")).toBe("silver");
  });

  it("preserves serial suffixes and non-auto tokens", () => {
    // "/150" is the serial — must NOT get stripped as an "auto" match.
    expect(stripAutoFromVariant("True Blue Refractor Auto /150")).toBe(
      "True Blue Refractor /150",
    );
  });

  it("does NOT touch substrings that merely contain 'auto' inside a word", () => {
    // "automatic" and "autobiography" would be word-broken by \b, so they
    // stay. This is a safeguard against overzealous stripping.
    expect(stripAutoFromVariant("Autobiography Signed")).toBe(
      "Autobiography Signed",
    );
  });

  it("returns null when the variant is nothing but auto tokens", () => {
    expect(stripAutoFromVariant("Auto")).toBeNull();
    expect(stripAutoFromVariant("  Autograph ")).toBeNull();
    expect(stripAutoFromVariant("Auto Autograph")).toBeNull();
  });

  it("returns null on empty / null / undefined", () => {
    expect(stripAutoFromVariant(null)).toBeNull();
    expect(stripAutoFromVariant(undefined)).toBeNull();
    expect(stripAutoFromVariant("")).toBeNull();
  });

  it("is idempotent — no auto token is a no-op", () => {
    expect(stripAutoFromVariant("True Blue Refractor")).toBe(
      "True Blue Refractor",
    );
    expect(stripAutoFromVariant("Speckle Refractor")).toBe("Speckle Refractor");
  });
});
