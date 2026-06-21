// CF-DECOUPLE-2 (2026-06-21) — cardsightSetName → BowmanFamilySubset
// normalizer unit tests.
//
// Locks the locked behavior from the CF spec:
//   - Clean 1:1 mappings (Cardsight plural "Prospects" → engine singular
//     "Prospect" being the canonical case).
//   - Ambiguous mappings return null (don't guess) — "Base Set" is the
//     named example.
//   - Unmappable setNames return null (no curated subset exists for them).
//   - Null/undefined/empty input returns null.
//   - Case-insensitive matching (Cardsight casing varies in the wild).
//
// All consumers (the 5 compiqEstimate sites + CF-CAT-ENGINE later) gate
// on null-or-not, so the test surface is the boolean classification + the
// specific BowmanFamilySubset value returned.

import { describe, it, expect } from "vitest";
import { normalizeCardsightSetName } from "../src/services/compiq/cardsightSubsetNormalizer.js";

describe("CF-DECOUPLE-2 — normalizeCardsightSetName: clean 1:1 mappings", () => {
  it("'Chrome Prospects Autographs' (Cardsight plural) → 'Chrome Prospect Autographs' (engine singular)", () => {
    // The canonical case CF-X explicitly flagged as out-of-scope.
    expect(normalizeCardsightSetName("Chrome Prospects Autographs")).toBe("Chrome Prospect Autographs");
  });

  it("'Chrome Rookie Autographs' → identical (already singular)", () => {
    expect(normalizeCardsightSetName("Chrome Rookie Autographs")).toBe("Chrome Rookie Autographs");
  });

  it("'Chrome Prospects' → 'Chrome Prospects' (non-auto sister set)", () => {
    expect(normalizeCardsightSetName("Chrome Prospects")).toBe("Chrome Prospects");
  });

  it("'Chrome Base' → 'Chrome Base'", () => {
    expect(normalizeCardsightSetName("Chrome Base")).toBe("Chrome Base");
  });

  it("'Inserts' → 'Inserts'", () => {
    expect(normalizeCardsightSetName("Inserts")).toBe("Inserts");
  });

  it("'Invicta Inserts' → 'Invicta Inserts'", () => {
    expect(normalizeCardsightSetName("Invicta Inserts")).toBe("Invicta Inserts");
  });

  it("'Paper Base + Paper Prospects' → identical", () => {
    expect(normalizeCardsightSetName("Paper Base + Paper Prospects")).toBe("Paper Base + Paper Prospects");
  });
});

describe("CF-DECOUPLE-2 — case-insensitive matching", () => {
  it("'chrome prospects autographs' (lowercase) → 'Chrome Prospect Autographs'", () => {
    expect(normalizeCardsightSetName("chrome prospects autographs")).toBe("Chrome Prospect Autographs");
  });

  it("'CHROME PROSPECTS AUTOGRAPHS' (uppercase) → 'Chrome Prospect Autographs'", () => {
    expect(normalizeCardsightSetName("CHROME PROSPECTS AUTOGRAPHS")).toBe("Chrome Prospect Autographs");
  });

  it("mixed-case + whitespace handled", () => {
    expect(normalizeCardsightSetName("  Chrome Prospects Autographs  ")).toBe("Chrome Prospect Autographs");
  });
});

describe("CF-DECOUPLE-2 — ambiguous setNames return null (don't guess)", () => {
  it("'Base Set' → null (could be Chrome Base, Paper Base+Prospects, or out-of-scope Topps)", () => {
    expect(normalizeCardsightSetName("Base Set")).toBeNull();
  });

  it("'base set' (lowercase ambiguous) → null", () => {
    expect(normalizeCardsightSetName("base set")).toBeNull();
  });
});

describe("CF-DECOUPLE-2 — unmappable setNames return null (no curated subset)", () => {
  it("'Bowman Sterling' → null (different product line)", () => {
    expect(normalizeCardsightSetName("Bowman Sterling")).toBeNull();
  });

  it("'Bowman Sterling Autographs' → null", () => {
    expect(normalizeCardsightSetName("Bowman Sterling Autographs")).toBeNull();
  });

  it("'Anime' → null", () => {
    expect(normalizeCardsightSetName("Anime")).toBeNull();
  });

  it("'Bowman Scouts Top 100' → null", () => {
    expect(normalizeCardsightSetName("Bowman Scouts Top 100")).toBeNull();
  });

  it("'Chrome Prospects Mojo' → null (parallel sister set, not a curated subset)", () => {
    expect(normalizeCardsightSetName("Chrome Prospects Mojo")).toBeNull();
  });

  it("'All America Game Autographs' → null", () => {
    expect(normalizeCardsightSetName("All America Game Autographs")).toBeNull();
  });

  it("arbitrary unknown setName → null", () => {
    expect(normalizeCardsightSetName("Some Set Cardsight Invented Tomorrow")).toBeNull();
  });
});

describe("CF-DECOUPLE-2 — null/undefined/empty input", () => {
  it("null → null", () => {
    expect(normalizeCardsightSetName(null)).toBeNull();
  });

  it("undefined → null", () => {
    expect(normalizeCardsightSetName(undefined)).toBeNull();
  });

  it("empty string → null", () => {
    expect(normalizeCardsightSetName("")).toBeNull();
  });

  it("whitespace-only → null", () => {
    expect(normalizeCardsightSetName("   ")).toBeNull();
  });
});
