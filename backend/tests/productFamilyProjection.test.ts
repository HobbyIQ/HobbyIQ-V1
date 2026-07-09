// CF-PRODUCT-FAMILY-PROJECTION (2026-07-09, Drew — Owen Carey 2026 Bowman
// Black Sapphire) unit tests for detectProductFamily.

import { describe, it, expect } from "vitest";
import { detectProductFamily } from "../src/services/compiq/productFamilyProjection";

describe("detectProductFamily — Sapphire family gap detection", () => {
  it("rewrites '2026 Bowman Sapphire' to '2026 Bowman Chrome Prospects'", () => {
    const r = detectProductFamily("2026 Bowman Sapphire");
    expect(r).not.toBeNull();
    expect(r!.familyName).toBe("Sapphire");
    expect(r!.parentProduct).toBe("2026 Bowman Chrome Prospects");
    expect(r!.familyMultiplier).toBe(2.5);
  });

  it("rewrites '2026 Bowman Chrome Sapphire' to '2026 Bowman Chrome Prospects'", () => {
    const r = detectProductFamily("2026 Bowman Chrome Sapphire");
    expect(r).not.toBeNull();
    expect(r!.parentProduct).toBe("2026 Bowman Chrome Prospects");
  });

  it("rewrites '2025 Bowman Draft Sapphire' to '2025 Bowman Draft Chrome'", () => {
    const r = detectProductFamily("2025 Bowman Draft Sapphire");
    expect(r).not.toBeNull();
    expect(r!.parentProduct).toBe("2025 Bowman Draft Chrome");
  });

  it("returns null when the product has no known family marker", () => {
    expect(detectProductFamily("2026 Bowman Chrome Prospects")).toBeNull();
    expect(detectProductFamily("2026 Topps Chrome")).toBeNull();
    expect(detectProductFamily("Topps Heritage")).toBeNull();
  });

  it("returns null on empty / null / whitespace inputs", () => {
    expect(detectProductFamily("")).toBeNull();
    expect(detectProductFamily(null)).toBeNull();
    expect(detectProductFamily(undefined)).toBeNull();
    expect(detectProductFamily("   ")).toBeNull();
  });

  it("is case-insensitive on the sapphire match", () => {
    const r = detectProductFamily("2026 bowman sapphire baseball");
    expect(r).not.toBeNull();
    expect(r!.familyName).toBe("Sapphire");
  });

  it("carries a human-readable attribution string for iOS to render", () => {
    const r = detectProductFamily("2026 Bowman Sapphire");
    expect(r!.attribution).toContain("Sapphire");
    expect(r!.attribution).toContain("Estimated");
  });

  it("never returns a rewrite equal to the input (loop guard)", () => {
    // If a rule matched but its rewrite produced the same string, the
    // guard should return null so downstream doesn't infinite-loop.
    const r = detectProductFamily("2026 Bowman Sapphire");
    if (r) {
      expect(r.parentProduct.toLowerCase()).not.toBe("2026 bowman sapphire");
    }
  });
});
