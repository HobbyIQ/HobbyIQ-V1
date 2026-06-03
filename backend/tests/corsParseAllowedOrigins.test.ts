// CF-FINALIZE (2026-06-03): pure-function tests for the CORS env parser.
//
// Locks the signal layer the cors() middleware reads:
//   false       → reject all (no Access-Control-Allow-Origin header)
//   "*"         → wildcard
//   string[]    → explicit allow-list
//
// Integration-side: the only thing app.ts does with this value is pass
// it straight to cors({ origin }); the cors lib's contract for `false`
// is "do not emit ACAO". Verified empirically against prod once
// deployed; here we lock the parser shape.

import { describe, expect, it } from "vitest";
import { parseCorsAllowedOrigins } from "../src/config/env.js";

describe("parseCorsAllowedOrigins", () => {
  it("undefined → false (reject all)", () => {
    expect(parseCorsAllowedOrigins(undefined)).toBe(false);
  });

  it("empty string → false", () => {
    expect(parseCorsAllowedOrigins("")).toBe(false);
  });

  it("whitespace only → false", () => {
    expect(parseCorsAllowedOrigins("   ")).toBe(false);
  });

  it('literal "false" → false (legacy App Setting value)', () => {
    expect(parseCorsAllowedOrigins("false")).toBe(false);
  });

  it('literal "FALSE" → false (case-insensitive)', () => {
    expect(parseCorsAllowedOrigins("FALSE")).toBe(false);
  });

  it('literal "none" → false (preferred descriptive form)', () => {
    expect(parseCorsAllowedOrigins("none")).toBe(false);
  });

  it('literal "*" → "*" (wildcard)', () => {
    expect(parseCorsAllowedOrigins("*")).toBe("*");
  });

  it("single domain → array of one", () => {
    expect(parseCorsAllowedOrigins("https://hobbyiq.app")).toEqual([
      "https://hobbyiq.app",
    ]);
  });

  it("comma-separated → array of trimmed entries", () => {
    expect(
      parseCorsAllowedOrigins("https://a.com, https://b.com,  https://c.com"),
    ).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });

  it("comma-separated with empty entries → array drops empties", () => {
    expect(parseCorsAllowedOrigins("https://a.com,,https://b.com,")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});
