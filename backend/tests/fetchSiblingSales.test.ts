/**
 * Unit tests for fetchSiblingSales — CF-CARDSIGHT-SIBLING-DISCOVERY Approach A.
 *
 * The function wraps fetchCompsByPlayer + exact-card-id exclusion. These tests
 * mock fetchCompsByPlayer directly so behavior is deterministic and never
 * touches the network. fetchCompsByPlayer's own coverage lives in
 * tests/compsByPlayer.service.test.ts.
 *
 * Investigation + design: docs/phase0/cardsight_sibling_discovery_investigation.md
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: vi.fn(),
}));

import { fetchCompsByPlayer } from "../src/services/compiq/compsByPlayer.service.js";
import { fetchSiblingSales } from "../src/services/compiq/compiqEstimate.service.js";

const mockedFetchCompsByPlayer = fetchCompsByPlayer as unknown as ReturnType<
  typeof vi.fn
>;

function makeCard(overrides: Partial<{
  card_id: string;
  player: string | null;
  set: string | null;
  year: number | string | null;
  title: string | null;
  number: string | null;
  variant: string | null;
}> = {}) {
  // Spread (not ??) so explicit null overrides survive — tests need to
  // verify the early-return gates that trip on null player/set fields.
  const defaults = {
    card_id: "exact-card-uuid",
    title: "Sample card" as string | null,
    player: "Shohei Ohtani" as string | null,
    set: "Bowman Chrome" as string | null,
    year: 2018 as number | string | null,
    number: "1" as string | null,
    variant: null as string | null,
  };
  return { ...defaults, ...overrides };
}

function mockResponse(
  cardIds: string[],
  comps: Array<{ cardId: string; price: number; date: string; title?: string }>,
  options: Partial<{ cached: boolean; warnings: string[] }> = {},
) {
  return {
    player: "Shohei Ohtani",
    product: "Bowman Chrome",
    cardYear: 2018,
    cardIds,
    comps: comps.map((c) => ({
      cardId: c.cardId,
      price: c.price,
      date: c.date,
      title: c.title ?? `Comp ${c.cardId}`,
      source: "cardsight" as const,
    })),
    cached: options.cached ?? false,
    warnings: options.warnings ?? [],
  };
}

beforeEach(() => {
  mockedFetchCompsByPlayer.mockReset();
});

describe("fetchSiblingSales — Approach A wrap behavior", () => {
  it("returns the fetchCompsByPlayer pool with the exact card excluded", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(
      mockResponse(
        ["exact-card-uuid", "sib-a", "sib-b"],
        [
          { cardId: "exact-card-uuid", price: 1000, date: "2026-05-20T00:00:00Z" },
          { cardId: "sib-a", price: 110, date: "2026-05-15T00:00:00Z" },
          { cardId: "sib-b", price: 105, date: "2026-05-10T00:00:00Z" },
          { cardId: "sib-a", price: 120, date: "2026-05-05T00:00:00Z" },
        ],
      ),
    );

    const result = await fetchSiblingSales(makeCard(), "Raw");

    expect(result.siblingCardIds).toEqual(["sib-a", "sib-b"]);
    expect(result.sales).toHaveLength(3);
    expect(result.sales.every((s) => s.price > 0)).toBe(true);
    expect(
      result.sales.map((s) => s.price).sort((a, b) => a - b),
    ).toEqual([105, 110, 120]);
  });

  it("returns empty pool when fetchCompsByPlayer returns no siblings", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    const result = await fetchSiblingSales(makeCard(), "Raw");
    expect(result.siblingCardIds).toEqual([]);
    expect(result.sales).toEqual([]);
  });

  it("returns empty pool when only the exact card is in the result", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(
      mockResponse(
        ["exact-card-uuid"],
        [{ cardId: "exact-card-uuid", price: 100, date: "2026-05-20T00:00:00Z" }],
      ),
    );
    const result = await fetchSiblingSales(makeCard(), "Raw");
    expect(result.siblingCardIds).toEqual([]);
    expect(result.sales).toEqual([]);
  });
});

describe("fetchSiblingSales — early-return gates", () => {
  // CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS (2026-05-25): the parsedQuery
  // fallback parameter was retired. cardIdentity is now the true source
  // of truth (populated by findCompsViaCardsight's getCardDetail
  // augmentation). If cardIdentity lacks player or set, the function
  // gracefully returns an empty pool and logs a diagnostic note that
  // the augmentation may be degrading.
  it("returns empty pool when player is missing on cardIdentity", async () => {
    const result = await fetchSiblingSales(
      makeCard({ player: null }),
      "Raw",
    );
    expect(result.siblingCardIds).toEqual([]);
    expect(result.sales).toEqual([]);
    expect(mockedFetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("returns empty pool when set/product is missing on cardIdentity", async () => {
    const result = await fetchSiblingSales(
      makeCard({ set: null }),
      "Raw",
    );
    expect(result.siblingCardIds).toEqual([]);
    expect(result.sales).toEqual([]);
    expect(mockedFetchCompsByPlayer).not.toHaveBeenCalled();
  });

  it("passes cardIdentity fields directly to fetchCompsByPlayer (no fallback indirection)", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(
      mockResponse(["sib-a"], [
        { cardId: "sib-a", price: 100, date: "2026-05-15T00:00:00Z" },
      ]),
    );
    const result = await fetchSiblingSales(
      makeCard({ player: "Shohei Ohtani", set: "Bowman Chrome", year: 2018 }),
      "Raw",
    );
    expect(result.siblingCardIds).toEqual(["sib-a"]);
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        playerName: "Shohei Ohtani",
        product: "Bowman Chrome",
        cardYear: 2018,
      }),
    );
  });
});

describe("fetchSiblingSales — failure isolation", () => {
  it("returns empty pool when fetchCompsByPlayer throws", async () => {
    mockedFetchCompsByPlayer.mockRejectedValue(new Error("upstream timeout"));
    const result = await fetchSiblingSales(makeCard(), "Raw");
    expect(result.siblingCardIds).toEqual([]);
    expect(result.sales).toEqual([]);
  });

  it("filters out sales with invalid dates", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(
      mockResponse(["sib-a"], [
        { cardId: "sib-a", price: 100, date: "" },
        { cardId: "sib-a", price: 105, date: "not-a-date" },
        { cardId: "sib-a", price: 110, date: "2026-05-15T00:00:00Z" },
      ]),
    );
    const result = await fetchSiblingSales(makeCard(), "Raw");
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].price).toBe(110);
  });

  it("filters out sales with non-positive prices", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(
      mockResponse(["sib-a"], [
        { cardId: "sib-a", price: 0, date: "2026-05-15T00:00:00Z" },
        { cardId: "sib-a", price: -10, date: "2026-05-15T00:00:00Z" },
        { cardId: "sib-a", price: 100, date: "2026-05-15T00:00:00Z" },
      ]),
    );
    const result = await fetchSiblingSales(makeCard(), "Raw");
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].price).toBe(100);
  });
});

describe("fetchSiblingSales — grade string parsing", () => {
  it("passes parsed PSA 10 grade through to fetchCompsByPlayer", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    await fetchSiblingSales(makeCard(), "PSA 10");
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        gradeCompany: "PSA",
        gradeValue: "10",
      }),
    );
  });

  it("passes parsed BGS 9.5 grade through", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    await fetchSiblingSales(makeCard(), "BGS 9.5");
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        gradeCompany: "BGS",
        gradeValue: "9.5",
      }),
    );
  });

  it("passes Raw as undefined grade (pools all grades)", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    await fetchSiblingSales(makeCard(), "Raw");
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        gradeCompany: undefined,
        gradeValue: undefined,
      }),
    );
  });

  it("passes empty/garbage grade as undefined (degrades gracefully)", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    await fetchSiblingSales(makeCard(), "garbage-grade-string");
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        gradeCompany: undefined,
        gradeValue: undefined,
      }),
    );
  });
});

describe("fetchSiblingSales — cardYear coercion", () => {
  it("coerces string year to number when fetchCompsByPlayer is called", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    await fetchSiblingSales(makeCard({ year: "2018" }), "Raw");
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ cardYear: 2018 }),
    );
  });

  it("passes undefined cardYear when year is non-numeric", async () => {
    mockedFetchCompsByPlayer.mockResolvedValue(mockResponse([], []));
    await fetchSiblingSales(makeCard({ year: "not-a-year" }), "Raw");
    expect(mockedFetchCompsByPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ cardYear: undefined }),
    );
  });
});
