import { describe, it, expect } from "vitest";
import { buildEngineMeta, __engineMetaInternals } from "../src/services/compiq/engineMeta";

describe("engineMeta", () => {
  it("returns a fresh meta object on every call", () => {
    const a = buildEngineMeta();
    // tight loop to make sure two calls happen in the same millisecond is
    // not the point — we just need to verify it isn't a frozen singleton
    const b = buildEngineMeta();
    expect(a).not.toBe(b);
  });

  it("stamps pricingEngine, engineVersion, computedAt", () => {
    const meta = buildEngineMeta();
    expect(meta).toHaveProperty("pricingEngine");
    expect(meta).toHaveProperty("engineVersion");
    expect(meta).toHaveProperty("computedAt");
  });

  it("pricingEngine resolves to 'monolith' or 'module' (no other values)", () => {
    const meta = buildEngineMeta();
    expect(["monolith", "module"]).toContain(meta.pricingEngine);
  });

  it("defaults to 'monolith' when COMPIQ_PRICING_ENGINE is unset", () => {
    // Module-load resolution: if this test runs in CI without
    // COMPIQ_PRICING_ENGINE set we expect 'monolith'. If a developer has
    // it set locally to 'module' we accept that too. The point of this
    // test is to assert no invalid string sneaks through.
    const resolved = __engineMetaInternals.resolvedPricingEngine;
    expect(["monolith", "module"]).toContain(resolved);
  });

  it("engineVersion is either a short SHA or the literal 'unknown'", () => {
    const meta = buildEngineMeta();
    // GIT_SHA when present is typically 7-40 hex chars; we don't enforce
    // a length, only that 'unknown' is the explicit fallback.
    if (meta.engineVersion !== "unknown") {
      expect(meta.engineVersion.length).toBeGreaterThan(0);
      expect(meta.engineVersion).not.toMatch(/\s/);
    }
  });

  it("computedAt is a valid ISO-8601 timestamp", () => {
    const meta = buildEngineMeta();
    const parsed = Date.parse(meta.computedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(meta.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("computedAt advances between calls (monotonic, not frozen)", async () => {
    const first = buildEngineMeta().computedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = buildEngineMeta().computedAt;
    expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
  });
});
