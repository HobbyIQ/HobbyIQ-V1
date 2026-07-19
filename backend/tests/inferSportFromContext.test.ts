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
});
