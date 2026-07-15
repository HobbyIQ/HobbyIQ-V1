// CF-CS-STRUCTURED-BRIDGE (Drew, 2026-07-15) — pins the CS-side
// structured bridge that bypasses the fuzzy candidate-explode when we
// have exact identity fields. Symmetric with cardHedgeStructuredBridge.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  CardsightCardSummary,
  CardsightPricingResponse,
} from "../src/services/compiq/cardsightSlim.client.js";

vi.mock("../src/services/compiq/cardsightSlim.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardsightSlim.client.js")>(
    "../src/services/compiq/cardsightSlim.client.js",
  );
  return {
    ...actual,
    getCatalogCards: vi.fn(),
    getPricing: vi.fn(),
    isCardsightConfigured: vi.fn(),
  };
});

import {
  getCatalogCards,
  getPricing,
  isCardsightConfigured,
} from "../src/services/compiq/cardsightSlim.client.js";
import { tryCardsightStructuredBridge } from "../src/services/compiq/cardsightStructuredBridge.js";

const mockedCatalog = vi.mocked(getCatalogCards);
const mockedPricing = vi.mocked(getPricing);
const mockedConfigured = vi.mocked(isCardsightConfigured);

const ORIGINAL_FLAG = process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED;

function cardSummary(overrides: Partial<CardsightCardSummary> = {}): CardsightCardSummary {
  return {
    id: "cs-parent-uuid-1",
    name: "Eric Hartman",
    number: "CPA-EHA",
    setName: "Bowman Chrome Prospects Autographs",
    setId: "set-uuid",
    releaseName: "2026 Bowman Chrome",
    releaseId: "release-uuid",
    releaseYear: "2026",
    parallels: [
      { id: "par-base", name: "Base" },
      { id: "par-blue-refractor", name: "Blue Refractor" },
      { id: "par-blue-x-fractor", name: "Blue X-Fractor" },
    ],
    ...overrides,
  } as CardsightCardSummary;
}

function pricingWith(rawRecords: Array<{ price: number; date: string; title?: string; listing_type?: string; image_url?: string }>): CardsightPricingResponse {
  return {
    raw: { count: rawRecords.length, records: rawRecords },
    graded: [],
    meta: { total_records: rawRecords.length, last_sale_date: rawRecords[rawRecords.length - 1]?.date ?? null },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedConfigured.mockReturnValue(true);
  process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED = "true";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED;
  else process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED = ORIGINAL_FLAG;
});

describe("tryCardsightStructuredBridge — env gate", () => {
  it("returns null when env flag is unset (default off)", async () => {
    delete process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED;
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA" },
      "Raw",
    );
    expect(r).toBeNull();
    expect(mockedCatalog).not.toHaveBeenCalled();
  });

  it("returns null when CS not configured", async () => {
    mockedConfigured.mockReturnValue(false);
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA" },
      "Raw",
    );
    expect(r).toBeNull();
  });
});

describe("tryCardsightStructuredBridge — precondition guards", () => {
  it("returns null without playerName", async () => {
    const r = await tryCardsightStructuredBridge({ playerName: "", number: "CPA-EHA" }, "Raw");
    expect(r).toBeNull();
  });

  it("returns null without cardNumber (nothing to disambiguate)", async () => {
    const r = await tryCardsightStructuredBridge({ playerName: "Eric Hartman" }, "Raw");
    expect(r).toBeNull();
  });
});

describe("tryCardsightStructuredBridge — happy path", () => {
  it("returns RoutedResult with parallel-scoped cardId and CS-sourced sales", async () => {
    mockedCatalog.mockResolvedValue([cardSummary()]);
    mockedPricing.mockResolvedValue(pricingWith([
      { price: 1899.99, date: "2026-07-13T00:00:00Z", title: "Blue Refractor Auto /150" },
    ]));
    const r = await tryCardsightStructuredBridge(
      {
        playerName: "Eric Hartman",
        cardYear: 2026,
        number: "CPA-EHA",
        parallel: "Blue Refractor",
      },
      "Raw",
    );
    expect(r).not.toBeNull();
    expect(r!.card?.card_id).toBe("cardsight:cs-parent-uuid-1::par-blue-refractor");
    expect(r!.card?.variant).toBe("Blue Refractor");
    expect(r!.sales).toHaveLength(1);
    expect(r!.sales[0].source).toBe("cardsight");
    expect(r!.sales[0].price).toBe(1899.99);
    // Verifies we searched by (name + number + year)
    expect(mockedCatalog).toHaveBeenCalledWith({
      name: "Eric Hartman",
      number: "CPA-EHA",
      year: 2026,
      take: 30,
    });
    expect(mockedPricing).toHaveBeenCalledWith("cs-parent-uuid-1", { parallelId: "par-blue-refractor" });
  });

  it("case-insensitive cardNumber match (cpa-eha vs CPA-EHA)", async () => {
    mockedCatalog.mockResolvedValue([cardSummary({ number: "cpa-eha" })]);
    mockedPricing.mockResolvedValue(pricingWith([{ price: 100, date: "2026-07-10T00:00:00Z" }]));
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA", parallel: "Blue Refractor" },
      "Raw",
    );
    expect(r).not.toBeNull();
  });

  it("narrows by year when multiple number matches", async () => {
    mockedCatalog.mockResolvedValue([
      cardSummary({ id: "cs-2025", releaseYear: "2025" }),
      cardSummary({ id: "cs-2026", releaseYear: "2026" }),
    ]);
    mockedPricing.mockResolvedValue(pricingWith([{ price: 500, date: "2026-07-10T00:00:00Z" }]));
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", cardYear: 2026, number: "CPA-EHA", parallel: "Blue Refractor" },
      "Raw",
    );
    expect(r!.card?.card_id).toContain("cs-2026");
  });

  it("falls back to base pricing (no parallelId) when identity has no parallel", async () => {
    mockedCatalog.mockResolvedValue([cardSummary()]);
    mockedPricing.mockResolvedValue(pricingWith([{ price: 25, date: "2026-07-10T00:00:00Z" }]));
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA" },  // no parallel
      "Raw",
    );
    expect(r).not.toBeNull();
    expect(r!.card?.card_id).toBe("cardsight:cs-parent-uuid-1");  // no ::par suffix
    // pricing called WITHOUT parallelId
    expect(mockedPricing).toHaveBeenCalledWith("cs-parent-uuid-1", {});
  });

  it("returns null when identity.parallel doesn't match any tree parallel (wrong-variant protection)", async () => {
    mockedCatalog.mockResolvedValue([cardSummary()]);
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA", parallel: "Rainbow Foilfractor" },
      "Raw",
    );
    expect(r).toBeNull();
    expect(mockedPricing).not.toHaveBeenCalled();
  });

  it("prefers exact parallel match over partial", async () => {
    mockedCatalog.mockResolvedValue([cardSummary({
      parallels: [
        { id: "par-blue", name: "Blue" },
        { id: "par-blue-refractor", name: "Blue Refractor" },
      ],
    })]);
    mockedPricing.mockResolvedValue(pricingWith([{ price: 100, date: "2026-07-10T00:00:00Z" }]));
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA", parallel: "Blue Refractor" },
      "Raw",
    );
    expect(mockedPricing).toHaveBeenCalledWith("cs-parent-uuid-1", { parallelId: "par-blue-refractor" });
    expect(r!.card?.variant).toBe("Blue Refractor");
  });
});

describe("tryCardsightStructuredBridge — grade selection", () => {
  it("selects graded records for PSA 10", async () => {
    mockedCatalog.mockResolvedValue([cardSummary()]);
    mockedPricing.mockResolvedValue({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", count: 2, records: [
              { price: 2500, date: "2026-07-11T00:00:00Z" },
              { price: 2600, date: "2026-07-09T00:00:00Z" },
            ] },
          ],
        },
      ],
      meta: { total_records: 2, last_sale_date: "2026-07-11T00:00:00Z" },
    });
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA", parallel: "Blue Refractor" },
      "PSA 10",
    );
    expect(r!.sales).toHaveLength(2);
    expect(r!.sales.every((s) => s.grade === "PSA 10")).toBe(true);
  });
});

describe("tryCardsightStructuredBridge — error resilience", () => {
  it("returns null when catalog search throws", async () => {
    mockedCatalog.mockRejectedValue(new Error("network"));
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA" },
      "Raw",
    );
    expect(r).toBeNull();
  });

  it("returns null on empty pricing response", async () => {
    mockedCatalog.mockResolvedValue([cardSummary()]);
    mockedPricing.mockResolvedValue(pricingWith([]));
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA", parallel: "Blue Refractor" },
      "Raw",
    );
    expect(r).toBeNull();
  });

  it("returns null when catalog returns zero cards", async () => {
    mockedCatalog.mockResolvedValue([]);
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA" },
      "Raw",
    );
    expect(r).toBeNull();
  });

  it("returns null when cardNumber doesn't match any candidate", async () => {
    mockedCatalog.mockResolvedValue([cardSummary({ number: "DIFFERENT-NUM" })]);
    const r = await tryCardsightStructuredBridge(
      { playerName: "Eric Hartman", number: "CPA-EHA" },
      "Raw",
    );
    expect(r).toBeNull();
  });
});
