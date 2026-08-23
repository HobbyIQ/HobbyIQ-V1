/**
 * CF-SLUG-IS-THE-IDENTITY (2026-08-23).
 *
 * A hobbyiqCardId slug names the parallel and the auto. readCompsByCardId
 * matches it EXACTLY, so every row it returns is already that one card. Any
 * further parallel/isAuto filtering cannot narrow a one-card set — it can only
 * wrongly empty it.
 *
 * It did. The card page sends `parallel={initialParallel ?? ""}` on every
 * request, so a page opened without a parallel in hand sends "", which the
 * filter reads as "base only" via BASE_ALIASES. For
 *
 *   hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150
 *
 * that discards the card's only real comp — the $729 auto — on a card we price
 * correctly at $729.
 *
 * These drive the REAL readCompsByCardId. The store builds its own CosmosClient
 * rather than taking one from a container module, so the mock has to be on
 * @azure/cosmos itself — mocking the wrong seam is why the first version of
 * this file failed against working code.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const SLUG = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";

/** The single sale genuinely attached to that slug. */
const THE_AUTO = {
  id: "sale-1",
  cardId: "cardhedge::abc",
  hobbyiqCardId: SLUG,
  price: 729,
  soldAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  source: "tca-ebay",
  parallel: "Blue Refractor",
  isAuto: true,
  title: "2024 Bowman Draft #CPA-TG Theo Gillen 1st Chrome True Blue Auto /150 TB Rays",
};

const { rowsRef, ctorMock } = vi.hoisted(() => {
  const rowsRef: { current: unknown[] } = { current: [] };
  const containerMock = {
    items: {
      query: () => ({ fetchAll: async () => ({ resources: rowsRef.current }) }),
      upsert: async (d: unknown) => ({ resource: d }),
    },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  };
  // getContainer() bootstraps via databases.createIfNotExists ->
  // containers.createIfNotExists, and swallows any throw by returning null.
  // A mock missing those methods therefore yields an empty result that looks
  // exactly like "the filter removed everything" — which is how the first
  // version of this file reported a failure that was entirely its own.
  const databaseMock = {
    containers: { createIfNotExists: async () => ({ container: containerMock }) },
    container: () => containerMock,
  };
  const ctorMock = vi.fn(function (this: Record<string, unknown>) {
    this.databases = { createIfNotExists: async () => ({ database: databaseMock }) };
    this.database = () => databaseMock;
  });
  return { rowsRef, ctorMock };
});
vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

const FROM = new Date(Date.now() - 180 * 86_400_000).toISOString();

async function read(input: Record<string, unknown>) {
  const store = await import("../src/services/portfolioiq/soldCompsStore.service.js");
  return await (store as unknown as {
    readCompsByCardId: (i: unknown) => Promise<Array<{ price: number }>>;
  }).readCompsByCardId(input);
}

beforeEach(() => {
  rowsRef.current = [];
});

describe("readCompsByCardId — the slug IS the identity", () => {
  it('keeps the auto comp when the card page sends parallel=""', async () => {
    rowsRef.current = [THE_AUTO];
    const out = await read({ cardId: SLUG, fromDate: FROM, parallel: "" });
    // Before the fix this was [] — "" meant "base only", so the Blue Refractor
    // auto was filtered off its own card page.
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(729);
  });

  it("keeps the auto comp when the caller contradicts the slug with isAuto=false", async () => {
    rowsRef.current = [THE_AUTO];
    const out = await read({ cardId: SLUG, fromDate: FROM, isAuto: false });
    // The slug says :auto:. A caller cannot un-auto the card it just asked for.
    expect(out).toHaveLength(1);
  });

  it("STILL filters by parallel for a vendor cardId, where one id holds many cards", async () => {
    // The case the filter exists for: CH mixes base rookies and auto variants
    // under one id. Dropping the filter there would dilute the pool, so the fix
    // has to be scoped to slugs only.
    rowsRef.current = [
      { ...THE_AUTO, id: "a", hobbyiqCardId: null, parallel: "Blue Refractor" },
      { ...THE_AUTO, id: "b", hobbyiqCardId: null, parallel: "Gold Refractor", price: 40 },
    ];
    const out = await read({ cardId: "cardhedge::abc", fromDate: FROM, parallel: "Blue Refractor" });
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(729);
  });

  it("STILL filters by isAuto for a vendor cardId", async () => {
    rowsRef.current = [
      { ...THE_AUTO, id: "a", hobbyiqCardId: null, isAuto: true },
      { ...THE_AUTO, id: "b", hobbyiqCardId: null, isAuto: false, price: 12 },
    ];
    const out = await read({ cardId: "cardhedge::abc", fromDate: FROM, isAuto: true });
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(729);
  });
});
