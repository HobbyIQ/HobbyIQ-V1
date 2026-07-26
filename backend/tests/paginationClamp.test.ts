// CF-PAGINATION-CLAMP-P1 (Drew, 2026-07-26). Pins the shared clamp
// helper: defaults, min/max bounds, non-numeric handling, decimal floor.

import { describe, expect, it } from "vitest";
import { clampLimit } from "../src/middleware/paginationClamp.js";

describe("clampLimit", () => {
  it("returns default on undefined / null / empty string", () => {
    expect(clampLimit(undefined, { default: 20, max: 100 })).toBe(20);
    expect(clampLimit(null, { default: 20, max: 100 })).toBe(20);
    expect(clampLimit("", { default: 20, max: 100 })).toBe(20);
    expect(clampLimit("   ", { default: 20, max: 100 })).toBe(20);
  });

  it("returns default on non-numeric string", () => {
    expect(clampLimit("abc", { default: 25, max: 100 })).toBe(25);
    expect(clampLimit("1.2.3", { default: 25, max: 100 })).toBe(25);
  });

  it("returns default on arrays / objects (query-string weirdness)", () => {
    expect(clampLimit(["1", "2"], { default: 15, max: 100 })).toBe(15);
    expect(clampLimit({ nested: 5 }, { default: 15, max: 100 })).toBe(15);
  });

  it("returns default on <= 0 inputs", () => {
    expect(clampLimit("0", { default: 10, max: 100 })).toBe(10);
    expect(clampLimit("-5", { default: 10, max: 100 })).toBe(10);
    expect(clampLimit(-1, { default: 10, max: 100 })).toBe(10);
  });

  it("returns default on Infinity / -Infinity / NaN (all non-finite)", () => {
    expect(clampLimit(Infinity, { default: 30, max: 100 })).toBe(30);
    expect(clampLimit(-Infinity, { default: 30, max: 100 })).toBe(30);
    expect(clampLimit(NaN, { default: 30, max: 100 })).toBe(30);
  });

  it("clamps large values down to max", () => {
    expect(clampLimit("99999999", { default: 20, max: 100 })).toBe(100);
    expect(clampLimit(500, { default: 20, max: 100 })).toBe(100);
  });

  it("clamps below-min values up to min", () => {
    expect(clampLimit("1", { default: 20, min: 5, max: 100 })).toBe(5);
  });

  it("passes valid input through unchanged", () => {
    expect(clampLimit("42", { default: 20, max: 100 })).toBe(42);
    expect(clampLimit(42, { default: 20, max: 100 })).toBe(42);
  });

  it("floors decimal input (query strings can carry floats)", () => {
    expect(clampLimit("42.9", { default: 20, max: 100 })).toBe(42);
    expect(clampLimit(15.7, { default: 20, max: 100 })).toBe(15);
  });

  it("also clamps the default itself when the default sits outside [min,max]", () => {
    expect(clampLimit(undefined, { default: 999, max: 100 })).toBe(100);
    expect(clampLimit(undefined, { default: 1, min: 10, max: 100 })).toBe(10);
  });

  it("throws if min > max (misconfiguration)", () => {
    expect(() => clampLimit(5, { default: 5, min: 100, max: 10 })).toThrow(/min.*max/);
  });
});
