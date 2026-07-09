// CF-SET-NAME-SYNONYMS (2026-07-08) — hobby shorthand expansion for
// product/set names so users typing "BDC" find Bowman Draft Chrome.

import { describe, it, expect } from "vitest";
import { normalizeSetName } from "../src/services/compiq/normalizationDictionary.service.js";

describe("CF-SET-NAME-SYNONYMS — normalizeSetName", () => {
  it("expands common Bowman shorthand", () => {
    expect(normalizeSetName("BDC")).toBe("bowman draft chrome");
    expect(normalizeSetName("BCP")).toBe("bowman chrome prospects");
    expect(normalizeSetName("BC")).toBe("bowman chrome");
    expect(normalizeSetName("BDS")).toBe("bowman draft sapphire");
    expect(normalizeSetName("BD")).toBe("bowman draft");
    expect(normalizeSetName("BB")).toBe("bowmans best");
  });

  it("expands common Topps shorthand", () => {
    expect(normalizeSetName("TC")).toBe("topps chrome");
    expect(normalizeSetName("TCU")).toBe("topps chrome update");
    expect(normalizeSetName("TF")).toBe("topps finest");
    expect(normalizeSetName("TT")).toBe("topps tribute");
    expect(normalizeSetName("TH")).toBe("topps heritage");
    expect(normalizeSetName("TSC")).toBe("topps stadium club");
  });

  it("expands common Panini shorthand", () => {
    expect(normalizeSetName("PP")).toBe("panini prizm");
    expect(normalizeSetName("PS")).toBe("panini select");
    expect(normalizeSetName("PM")).toBe("panini mosaic");
    expect(normalizeSetName("prizm")).toBe("panini prizm");
    expect(normalizeSetName("select")).toBe("panini select");
    expect(normalizeSetName("mosaic")).toBe("panini mosaic");
    expect(normalizeSetName("optic")).toBe("donruss optic");
  });

  it("is case-insensitive", () => {
    expect(normalizeSetName("bdc")).toBe("bowman draft chrome");
    expect(normalizeSetName("Bdc")).toBe("bowman draft chrome");
    expect(normalizeSetName("BDC ")).toBe("bowman draft chrome");
  });

  it("returns raw input verbatim when no alias matches", () => {
    expect(normalizeSetName("Bowman Draft Chrome")).toBe("bowman draft chrome");
    expect(normalizeSetName("Unknown Product Xyz")).toBe("Unknown Product Xyz");
    expect(normalizeSetName("  spaced input ")).toBe("spaced input");
  });

  it("handles missing/empty input gracefully", () => {
    expect(normalizeSetName(undefined)).toBeUndefined();
    expect(normalizeSetName("")).toBeUndefined();
    expect(normalizeSetName("   ")).toBeUndefined();
  });

  it("expands full canonical names too (idempotent for expected inputs)", () => {
    expect(normalizeSetName("Bowman's Best")).toBe("bowmans best");
    expect(normalizeSetName("Panini Prizm")).toBe("panini prizm");
    expect(normalizeSetName("Topps Chrome Update")).toBe("topps chrome update");
  });
});
