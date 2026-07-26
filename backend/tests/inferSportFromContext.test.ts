import { describe, it, expect } from "vitest";
import { inferSportFromContext } from "../src/services/portfolioiq/soldCompsStore.service.js";

describe("inferSportFromContext", () => {
  it("returns baseball on explicit substring", () => {
    expect(inferSportFromContext("2020 Bowman Chrome Baseball", null)).toBe("baseball");
    expect(inferSportFromContext(null, "2026 Topps Baseball Autograph")).toBe("baseball");
  });

  it("returns football on explicit substring", () => {
    expect(inferSportFromContext("2024 Panini Prizm Football", null)).toBe("football");
    expect(inferSportFromContext(null, "NFL Rookie Auto")).toBe("football");
  });

  it("returns basketball on explicit substring", () => {
    expect(inferSportFromContext("2020 Panini Prizm Basketball", null)).toBe("basketball");
    expect(inferSportFromContext(null, "NBA Rookie")).toBe("basketball");
  });

  it("returns baseball on Bowman heuristic (Bowman is single-sport)", () => {
    expect(inferSportFromContext("2020 Bowman Chrome Prospects", null)).toBe("baseball");
    expect(inferSportFromContext("2026 Bowman", null)).toBe("baseball");
  });

  it("returns null when input is truly ambiguous", () => {
    expect(inferSportFromContext(null, null)).toBeNull();
    expect(inferSportFromContext("", "")).toBeNull();
    // Panini Prizm alone spans multiple sports — refuse to guess
    expect(inferSportFromContext("2024 Donruss Optic", null)).toBeNull();
  });

  it("does not misclassify Topps Chrome F1 or UFC as baseball", () => {
    expect(inferSportFromContext("2023 Topps Chrome F1", null)).not.toBe("baseball");
    expect(inferSportFromContext("2024 Topps Chrome UFC", null)).not.toBe("baseball");
  });

  // CF-INFERSPORT-VINTAGE-P1 (Drew, 2026-07-26). Vintage flagship rule.
  describe("vintage flagship (pre-1986) → baseball", () => {
    it("defaults bare vintage Topps to baseball (ceiling 1980)", () => {
      expect(inferSportFromContext("Topps", null, 1970)).toBe("baseball");
      expect(inferSportFromContext("Topps", null, 1980)).toBe("baseball");
    });

    it("defaults bare vintage Fleer to baseball (ceiling 1985)", () => {
      expect(inferSportFromContext("Fleer", null, 1963)).toBe("baseball");
      expect(inferSportFromContext("Fleer", null, 1985)).toBe("baseball");
    });

    it("defaults bare vintage Donruss to baseball (ceiling 1987)", () => {
      expect(inferSportFromContext("Donruss", null, 1981)).toBe("baseball");
      expect(inferSportFromContext("Donruss", null, 1987)).toBe("baseball");
    });

    it("defaults bare vintage Upper Deck to baseball (ceiling 1990)", () => {
      expect(inferSportFromContext("Upper Deck", null, 1989)).toBe("baseball");
      expect(inferSportFromContext("Upper Deck", null, 1990)).toBe("baseball");
    });

    it("still respects an explicit other-sport substring even with vintage brand + year", () => {
      // A 1980 Topps Football box exists — don't override an explicit signal.
      expect(inferSportFromContext("Topps Football", null, 1980)).toBe("football");
      expect(inferSportFromContext("Topps", "NBA All-Star", 1980)).toBe("basketball");
    });

    it("does NOT fire above the per-brand ceiling", () => {
      // Topps basketball came back 1981 → 1981 Topps ambiguous → null.
      expect(inferSportFromContext("Topps", null, 1981)).toBeNull();
      // Fleer basketball inaugural 1986 → 1986 Fleer ambiguous.
      expect(inferSportFromContext("Fleer", null, 1986)).toBeNull();
      // Donruss basketball 1988.
      expect(inferSportFromContext("Donruss", null, 1988)).toBeNull();
      // Upper Deck basketball 1991.
      expect(inferSportFromContext("Upper Deck", null, 1991)).toBeNull();
      // Modern Topps — completely ambiguous.
      expect(inferSportFromContext("Topps", null, 2010)).toBeNull();
    });

    it("does NOT fire without a year (undefined stays null)", () => {
      expect(inferSportFromContext("Topps", null)).toBeNull();
      expect(inferSportFromContext("Fleer", null, null)).toBeNull();
      expect(inferSportFromContext("Donruss", null, undefined)).toBeNull();
    });

    it("does NOT fire on non-flagship vintage brands", () => {
      // Not in the vintage-baseball whitelist — stay null.
      expect(inferSportFromContext("Kellogg's", null, 1975)).toBeNull();
    });

    it("year=0 / negative years are ignored (defensive)", () => {
      expect(inferSportFromContext("Topps", null, 0)).toBeNull();
      expect(inferSportFromContext("Topps", null, -1)).toBeNull();
    });
  });
});
