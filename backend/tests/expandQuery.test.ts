// CF-QUERY-ALIAS-EXPANSION (2026-07-08) — query expansion against
// the alias index. Locks the "Gum Ball" ↔ "bubblegum" case.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/repositories/searchAliases.repository.js", () => ({
  listAllActiveAliases: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CF-QUERY-ALIAS-EXPANSION — expandQueryWithAliases", () => {
  it("expands 'Josiah Hartshorn Bubblegum' to include 'Gum Ball' variant", async () => {
    const { listAllActiveAliases } = await import(
      "../src/repositories/searchAliases.repository.js"
    );
    vi.mocked(listAllActiveAliases).mockResolvedValue([
      {
        category: "parallel",
        canonical: "gum ball",
        aliases: ["bubblegum", "bubble gum", "snackpack"],
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: new Date().toISOString(),
      },
    ]);

    const { _resetAliasStoreForTesting } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();

    const { expandQueryWithAliases } = await import(
      "../src/services/search/expandQuery.service.js"
    );
    const variants = await expandQueryWithAliases("Josiah Hartshorn Bubblegum Auto");
    expect(variants.length).toBeGreaterThanOrEqual(2);

    // Original always ranked highest
    expect(variants[0].query).toBe("Josiah Hartshorn Bubblegum Auto");
    expect(variants[0].rankBoost).toBe(1.0);

    // Gum Ball variant must appear as one of the substitutions
    const gumBallVariant = variants.find((v) => v.query.toLowerCase().includes("gum ball"));
    expect(gumBallVariant).toBeDefined();
    expect(gumBallVariant?.rankBoost).toBe(0.5);
    expect(gumBallVariant?.substitutions[0].to.toLowerCase()).toBe("gum ball");
  });

  it("expands canonical → alias direction too (Gum Ball → Bubblegum)", async () => {
    const { listAllActiveAliases } = await import(
      "../src/repositories/searchAliases.repository.js"
    );
    vi.mocked(listAllActiveAliases).mockResolvedValue([
      {
        category: "parallel",
        canonical: "gum ball",
        aliases: ["bubblegum", "bubble gum", "snackpack"],
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: new Date().toISOString(),
      },
    ]);
    const { _resetAliasStoreForTesting } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();
    const { expandQueryWithAliases } = await import(
      "../src/services/search/expandQuery.service.js"
    );
    const variants = await expandQueryWithAliases("Hartshorn Gum Ball Auto");
    const spellings = variants.map((v) => v.query.toLowerCase());
    expect(spellings.some((s) => s.includes("bubblegum"))).toBe(true);
    expect(spellings.some((s) => s.includes("bubble gum"))).toBe(true);
  });

  it("handles set-name aliases (BDC → Bowman Draft Chrome)", async () => {
    const { listAllActiveAliases } = await import(
      "../src/repositories/searchAliases.repository.js"
    );
    vi.mocked(listAllActiveAliases).mockResolvedValue([
      {
        category: "set",
        canonical: "bowman draft chrome",
        aliases: ["bdc"],
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: new Date().toISOString(),
      },
    ]);
    const { _resetAliasStoreForTesting } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();
    const { expandQueryWithAliases } = await import(
      "../src/services/search/expandQuery.service.js"
    );
    const variants = await expandQueryWithAliases("Willits BDC Orange");
    const variantSpellings = variants.map((v) => v.query.toLowerCase());
    expect(variantSpellings.some((s) => s.includes("bowman draft chrome"))).toBe(true);
  });

  it("preserves ordering: original first, alias variants ranked by rankBoost desc", async () => {
    const { listAllActiveAliases } = await import(
      "../src/repositories/searchAliases.repository.js"
    );
    vi.mocked(listAllActiveAliases).mockResolvedValue([
      {
        category: "parallel",
        canonical: "gum ball",
        aliases: ["bubblegum"],
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: new Date().toISOString(),
      },
    ]);
    const { _resetAliasStoreForTesting } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();
    const { expandQueryWithAliases } = await import(
      "../src/services/search/expandQuery.service.js"
    );
    const variants = await expandQueryWithAliases("bubblegum auto");
    expect(variants[0].rankBoost).toBe(1.0);
    expect(variants[0].query).toBe("bubblegum auto");
    for (let i = 1; i < variants.length; i++) {
      expect(variants[i].rankBoost).toBeLessThan(variants[0].rankBoost);
    }
  });

  it("returns empty on empty input", async () => {
    const { _resetAliasStoreForTesting } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();
    const { expandQueryWithAliases } = await import(
      "../src/services/search/expandQuery.service.js"
    );
    expect(await expandQueryWithAliases("")).toEqual([]);
    expect(await expandQueryWithAliases("   ")).toEqual([]);
  });
});
