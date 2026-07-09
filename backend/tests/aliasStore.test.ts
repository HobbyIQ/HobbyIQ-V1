// CF-ALIAS-STORE (2026-07-08) — in-memory alias index + Cosmos fallback.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/repositories/searchAliases.repository.js", () => ({
  listAllActiveAliases: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CF-ALIAS-STORE — aliasStore.service", () => {
  it("loads from Cosmos when repository returns entries", async () => {
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

    const { _resetAliasStoreForTesting, lookupAlias, getAliasIndex } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();

    const idx = await getAliasIndex();
    expect(idx.source).toBe("cosmos");
    expect(idx.byAlias.size).toBeGreaterThanOrEqual(4); // canonical + 3 aliases

    const hit = await lookupAlias("bubblegum");
    expect(hit?.canonical).toBe("gum ball");
    expect(hit?.category).toBe("parallel");
  });

  it("falls back to static seed when Cosmos returns empty", async () => {
    const { listAllActiveAliases } = await import(
      "../src/repositories/searchAliases.repository.js"
    );
    vi.mocked(listAllActiveAliases).mockResolvedValue([]);

    const { _resetAliasStoreForTesting, getAliasIndex, lookupAlias } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();

    const idx = await getAliasIndex();
    expect(idx.source).toBe("static-fallback");
    // The static seed includes PARALLEL_SYNONYMS which includes
    // Gum Ball (added in PR #317).
    const bubblegum = await lookupAlias("bubblegum");
    expect(bubblegum?.category).toBe("parallel");
  });

  it("filters by category when caller specifies one", async () => {
    const { listAllActiveAliases } = await import(
      "../src/repositories/searchAliases.repository.js"
    );
    vi.mocked(listAllActiveAliases).mockResolvedValue([
      {
        category: "parallel",
        canonical: "silver",
        aliases: ["silver prizm"],
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: new Date().toISOString(),
      },
      {
        category: "grader",
        canonical: "PSA",
        aliases: ["psa"],
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: new Date().toISOString(),
      },
    ]);

    const { _resetAliasStoreForTesting, lookupAlias } = await import(
      "../src/services/search/aliasStore.service.js"
    );
    _resetAliasStoreForTesting();

    // Ask specifically for parallel category — grader "psa" shouldn't match
    const hit = await lookupAlias("silver", "parallel");
    expect(hit?.canonical).toBe("silver");

    const psaAsGrader = await lookupAlias("psa", "grader");
    expect(psaAsGrader?.canonical).toBe("PSA");

    const psaAsParallel = await lookupAlias("psa", "parallel");
    expect(psaAsParallel).toBeUndefined();
  });
});
