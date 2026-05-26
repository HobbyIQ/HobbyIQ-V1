// CF-AUTOPRICE-FIELD-NAME-SHIM — verifies the ?? fallback semantics that
// normalize iOS's phantom field names (year/setName/cardName) to the
// canonical names (cardYear/product/cardTitle) that pricing code reads.
//
// Background: iOS POST /api/portfolio/holdings writes holdings via
// schemaless ...rest spread (addHolding accepts any req.body). iOS has
// historically sent {year, setName, cardName} instead of the TS-typed
// {cardYear, product, cardTitle}. ~13/24 production holdings have
// data under the phantom names. This shim makes the pricing read path
// accept either set. Once CF-IOS-FIELD-CONTRACT-FIX + CF-PORTFOLIO-
// METADATA-BACKFILL ship, these helpers + this test get deleted.

import { describe, it, expect } from "vitest";

import {
  shimmedCardYear,
  shimmedProduct,
  shimmedCardTitle,
} from "../src/services/portfolioiq/portfolioStore.service.js";

import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

// Build a minimal holding stub. Test sites add or omit only the fields
// under test; cast through `as any` for the phantom fields not in the
// TS type.
function h(over: Partial<PortfolioHolding> & Record<string, unknown>): PortfolioHolding {
  return { id: "test", ...over } as PortfolioHolding;
}

describe("CF-AUTOPRICE-FIELD-NAME-SHIM — shimmedCardYear", () => {
  it("returns canonical cardYear when only canonical is populated", () => {
    expect(shimmedCardYear(h({ cardYear: 2024 }))).toBe(2024);
  });

  it("falls back to phantom 'year' when canonical cardYear is undefined", () => {
    expect(shimmedCardYear(h({ year: 2024 }))).toBe(2024);
  });

  it("falls back to phantom 'year' when canonical cardYear is null", () => {
    expect(shimmedCardYear(h({ cardYear: null as unknown as number, year: 2024 }))).toBe(2024);
  });

  it("canonical cardYear takes precedence when both populated", () => {
    expect(shimmedCardYear(h({ cardYear: 2023, year: 2024 }))).toBe(2023);
  });

  it("returns undefined when neither populated", () => {
    expect(shimmedCardYear(h({}))).toBeUndefined();
  });

  it("returns undefined when canonical is 0 (toNumber || undefined idiom)", () => {
    // 0 is falsy in the || guard — preserves the existing helper's
    // semantics that 0 means "no year".
    expect(shimmedCardYear(h({ cardYear: 0 }))).toBeUndefined();
  });
});

describe("CF-AUTOPRICE-FIELD-NAME-SHIM — shimmedProduct", () => {
  it("returns canonical product when only canonical is populated", () => {
    expect(shimmedProduct(h({ product: "Bowman Chrome" }))).toBe("Bowman Chrome");
  });

  it("falls back to setName when canonical product is undefined", () => {
    expect(shimmedProduct(h({ setName: "Bowman Chrome" }))).toBe("Bowman Chrome");
  });

  it("canonical product takes precedence when both populated", () => {
    expect(shimmedProduct(h({ product: "Topps Chrome", setName: "Bowman Chrome" }))).toBe("Topps Chrome");
  });

  it("falls back to setName when canonical product is empty string", () => {
    // Empty string is nullish-coalescing-falsy: only null/undefined fall
    // through ??. But the trim+|| chain produces undefined for empty,
    // which then makes the OUTER ?? chain matter. Empty-string product
    // is treated like missing.
    expect(shimmedProduct(h({ product: "", setName: "Bowman Chrome" }))).toBe("Bowman Chrome");
  });

  it("returns undefined when neither populated", () => {
    expect(shimmedProduct(h({}))).toBeUndefined();
  });

  it("trims whitespace from result", () => {
    expect(shimmedProduct(h({ product: "  Bowman Chrome  " }))).toBe("Bowman Chrome");
  });
});

describe("CF-AUTOPRICE-FIELD-NAME-SHIM — shimmedCardTitle", () => {
  it("returns canonical cardTitle when only canonical is populated", () => {
    expect(shimmedCardTitle(h({ cardTitle: "2024 Bowman Chrome Auto" }))).toBe("2024 Bowman Chrome Auto");
  });

  it("falls back to cardName when canonical cardTitle is undefined", () => {
    expect(shimmedCardTitle(h({ cardName: "2024 Bowman Chrome Blue" }))).toBe("2024 Bowman Chrome Blue");
  });

  it("canonical cardTitle takes precedence when both populated", () => {
    expect(shimmedCardTitle(h({ cardTitle: "canonical", cardName: "phantom" }))).toBe("canonical");
  });

  it("returns empty string when neither populated", () => {
    expect(shimmedCardTitle(h({}))).toBe("");
  });
});

describe("CF-AUTOPRICE-FIELD-NAME-SHIM — production cohort scenarios", () => {
  // Scenarios drawn from the actual Cosmos investigation 2026-05-26.
  // These are realistic shapes the shim must handle.

  it("iOS-real holding (year + setName populated, canonical absent)", () => {
    const ohtani = h({
      playerName: "Caleb Bonemer",
      year: 2024,
      setName: "Bowman Chrome",
      cardName: "2024 Bowman Chrome Blue",
      parallel: "Blue",
    });
    expect(shimmedCardYear(ohtani)).toBe(2024);
    expect(shimmedProduct(ohtani)).toBe("Bowman Chrome");
    expect(shimmedCardTitle(ohtani)).toBe("2024 Bowman Chrome Blue");
  });

  it("test fixture (cardTitle only, no year/product)", () => {
    const testHolding = h({
      playerName: "Paul Skenes",
      cardTitle: "2024 Bowman Chrome Auto",
    });
    expect(shimmedCardYear(testHolding)).toBeUndefined();
    expect(shimmedProduct(testHolding)).toBeUndefined();
    expect(shimmedCardTitle(testHolding)).toBe("2024 Bowman Chrome Auto");
  });

  it("legacy/clean holding (all canonical names populated)", () => {
    const clean = h({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Bowman Chrome",
      cardTitle: "2018 Bowman Chrome Shohei Ohtani",
    });
    expect(shimmedCardYear(clean)).toBe(2018);
    expect(shimmedProduct(clean)).toBe("Bowman Chrome");
    expect(shimmedCardTitle(clean)).toBe("2018 Bowman Chrome Shohei Ohtani");
  });
});
