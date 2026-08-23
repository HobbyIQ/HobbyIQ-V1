/**
 * CF-MATCH-SETKEY-INVARIANT (2026-08-22).
 *
 * A match may not hand back a card from a DIFFERENT product than the one that
 * was asked for. The parallel segment has been guarded since #1180; the setKey
 * segment had no such check.
 *
 * It needed one because catalog rows disagree with themselves. A row is
 * FILTERED on its `setKey` field but the matcher returns its `id`, and those
 * do not always encode the same product. Measured on 2024 bowman-draft plus
 * bowman-chrome alone, 125,044 rows:
 *
 *   id-slug agrees with the setKey field   94,788
 *   id-slug DISAGREES                       8,412
 *   id is not a canonical slug             21,844
 *
 *   e.g. id says "bowman-draft-chrome" while the setKey field says
 *        "bowman-draft"
 *
 * Live consequence: a Theo Gillen Blue Refractor /150 added from its
 * bowman-draft card page became a bowman-chrome holding, priced against a pool
 * containing none of its comps — so its only sale looked like it had vanished
 * from the inventory.
 *
 * family-fallback is exempt: crossing to a related product is that rung's job
 * and it says so in matchedBy. These pin the silent crossings only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { readMock, queryMock, ctorMock } = vi.hoisted(() => {
  const readMock = vi.fn();
  const queryMock = vi.fn(() => ({ fetchAll: async () => ({ resources: [] }) }));
  const containerMock = {
    item: vi.fn((id: string) => ({ read: () => readMock(id) })),
    items: { query: queryMock, upsert: vi.fn() },
  };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { readMock, queryMock, ctorMock };
});
vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

import {
  canonicalize,
  clearCatalogMatchCache,
} from "../src/services/catalog/catalogMatcher.service.js";

/** The Theo Gillen shape: asked for Bowman Draft. */
const ASK = {
  sport: "baseball",
  year: 2024,
  setName: "Bowman Draft",
  cardNumber: "CPA-TG",
  parallel: "Blue Refractor",
  isAuto: true,
  player: "Theo Gillen",
  source: "unknown" as const,
};

beforeEach(() => {
  clearCatalogMatchCache();
  readMock.mockReset();
  queryMock.mockReset();
  queryMock.mockReturnValue({ fetchAll: async () => ({ resources: [] }) });
});

describe("canonicalize — a match must be the product that was asked for", () => {
  it("rejects a row whose id encodes a DIFFERENT product than the query", async () => {
    // Step 1 returns the slug it COMPUTED from the input, so a mismatch can
    // never surface there. The disagreement escapes through the fuzzy-parallel
    // step, which returns the row's own `id` — and that is precisely the row
    // whose id and setKey field disagree. So: miss step 1, then serve a
    // matching-parallel row filed under another product.
    readMock.mockImplementation(async () => ({ resource: undefined }));
    queryMock.mockReturnValue({
      fetchAll: async () => ({
        resources: [{
          id: "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto:num-150",
          parallelSlug: "blue-refractor",
          parallel: "Blue Refractor",
        }],
      }),
    });
    const r = await canonicalize({ ...ASK });
    expect(r.found).toBe(false);
    expect(r.matchedBy).toBe("not-found");
    // And the slug it falls back to must be the product that WAS asked for.
    expect(r.slug).toContain(":bowman-draft:");
  });

  it("accepts a row from the SAME product", async () => {
    readMock.mockImplementation(async (id: string) => ({ resource: { id } }));
    const r = await canonicalize({ ...ASK });
    expect(r.found).toBe(true);
    expect(r.slug).toContain(":bowman-draft:");
  });

  it("leaves non-canonical vendor ids alone — they carry no product segment", async () => {
    readMock.mockImplementation(async () => ({ resource: { id: "cardhedge::1234567890" } }));
    const r = await canonicalize({ ...ASK });
    // Nothing to compare, so the setKey guard must not reject it. Whatever the
    // other rungs decide stands.
    expect(r.matchedBy).not.toBe("not-found");
  });

  it("does not fire when the caller gave no setName to compare against", async () => {
    readMock.mockImplementation(async () => ({
      resource: { id: "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto:num-150" },
    }));
    const r = await canonicalize({ ...ASK, setName: "" });
    // No asked-for product means no violation is knowable; rejecting here
    // would break every caller that prices by number alone.
    expect(r.found).toBe(true);
  });
});
