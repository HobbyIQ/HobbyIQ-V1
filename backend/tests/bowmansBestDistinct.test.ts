// CF-BOWMANS-BEST-DISTINCT (Drew, 2026-08-17).
//
// Bowman's Best is a premium product line with its own checklist, not a Bowman
// variant, and normalizeSetKey had no rule for it — so it fell to the generic
// /bowman/ catch-all.
//
// Measured 2026-08-17: 130,273 sold_comps rows whose own setName says Bowman's
// Best sit on the bare `bowman` key, while card_catalog already carries 80,193
// rows under `bowmans-best`. The sales and the checklist for the same product
// were filed under different keys, so the pool could never meet its own catalog.
//
// Part of a wider audit: 627,093 sales sit on bare-manufacturer setKeys that
// their own setName contradicts. This is the largest single product in it.

import { describe, it, expect } from "vitest";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CF-BOWMANS-BEST-DISTINCT — Bowman's Best is its own product", () => {
  it("routes every observed spelling to the catalog's `bowmans-best` key", () => {
    // slugify folds the apostrophe, so one pattern covers both spellings.
    for (const name of [
      "Bowman's Best",
      "Bowmans Best",
      "2024 Bowman's Best Baseball",
      "2025 Bowman's Best Baseball",
    ]) {
      expect(normalizeSetKey(name)).toBe("bowmans-best");
    }
  });

  it("keeps Bowman Best University separate — it has its own catalog rows", () => {
    // 158 catalog rows carry bowman-best-university. The general rule would
    // swallow it, so the university pattern is ordered first.
    expect(normalizeSetKey("Bowman Best University")).toBe("bowman-best-university");
    expect(normalizeSetKey("Bowman's Best University")).toBe("bowman-best-university");
  });

  it("leaves every other Bowman product line exactly where it was", () => {
    expect(normalizeSetKey("Bowman")).toBe("bowman");
    expect(normalizeSetKey("2026 Bowman Baseball")).toBe("bowman");
    expect(normalizeSetKey("Bowman Chrome")).toBe("bowman-chrome");
    expect(normalizeSetKey("Bowman Draft")).toBe("bowman-draft");
    expect(normalizeSetKey("Bowman Chrome Sapphire")).toBe("bowman-chrome-sapphire");
    expect(normalizeSetKey("Bowman Draft Sapphire Chrome")).toBe("bowman-draft-sapphire");
    expect(normalizeSetKey("Bowman Mega Box")).toBe("bowman-chrome-mega-box");
  });

  it("puts Bowman's Best on a DIFFERENT slug from base Bowman at one number", () => {
    const base = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "2024 Bowman Baseball",
      cardNumber: "50", parallel: "Base", isAuto: false,
    });
    const best = computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "2024 Bowman's Best Baseball",
      cardNumber: "50", parallel: "Base", isAuto: false,
    });
    expect(base).not.toBe(best);
    expect(base.split(":")[3]).toBe("bowman");
    expect(best.split(":")[3]).toBe("bowmans-best");
  });
});
