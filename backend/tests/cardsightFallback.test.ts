// CF-CARDSIGHT-FALLBACK-REVIVAL (Drew, 2026-07-14) — pins the Cardsight
// fallback for the free-text findCompsRouted path when CH has no bridge.
//
// Coverage:
//   - CS unconfigured / query empty → null (no cost)
//   - Zero candidates → null
//   - Candidates present but no player-match → null (won't return unrelated)
//   - Happy path: best-score candidate → getPricing → RoutedResult with
//     source="cardsight" sales
//   - Grade filter: raw vs graded selection
//   - Vendor label propagation: sales carry source="cardsight"
//   - CS-native fields (listing_type, image_url) preserved for downstream
//
// Mocks: cardsightUuidSource.fetchCardsightUuidNativeCandidates +
// cardsightSlim.client.getPricing / isCardsightConfigured. No live CS calls.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CardIdentity } from "../src/types/cardIdentity.js";
import type { CardsightPricingResponse } from "../src/services/compiq/cardsightSlim.client.js";

vi.mock("../src/services/compiq/cardsightUuidSource.js", () => ({
  fetchCardsightUuidNativeCandidates: vi.fn(),
}));
vi.mock("../src/services/compiq/cardsightSlim.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardsightSlim.client.js")>(
    "../src/services/compiq/cardsightSlim.client.js",
  );
  return {
    ...actual,
    getPricing: vi.fn(),
    isCardsightConfigured: vi.fn(),
  };
});

import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import { getPricing, isCardsightConfigured } from "../src/services/compiq/cardsightSlim.client.js";
import { tryCardsightFallback } from "../src/services/compiq/cardsightFallback.js";

const mockedFetch = vi.mocked(fetchCardsightUuidNativeCandidates);
const mockedPricing = vi.mocked(getPricing);
const mockedConfigured = vi.mocked(isCardsightConfigured);

// Small helper to build a CardIdentity that matches what
// fetchCardsightUuidNativeCandidates emits (per-parallel exploded row).
function csCandidate(overrides: Partial<CardIdentity> = {}): CardIdentity {
  return {
    candidateId: `cardsight:parent-uuid-1::par-blue-refractor`,
    source: "catalog",
    attribution: "ranked",
    confidence: 0.85,
    player: "Eric Hartman",
    year: 2026,
    brand: null,
    setName: "Bowman Chrome",
    cardNumber: "CPA-EHA",
    parallel: "Blue Refractor",
    variation: null,
    isAuto: true,
    serialNumber: null,
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,
    title: "Eric Hartman 2026 Bowman Chrome Blue Refractor",
    imageUrl: null,
    parallels: [],
    raw: {},
    ...overrides,
  } as CardIdentity;
}

function makePricing(rawRecords: Array<{ price: number; date: string; title?: string; listing_type?: string; image_url?: string }>): CardsightPricingResponse {
  return {
    raw: { count: rawRecords.length, records: rawRecords },
    graded: [],
    meta: { total_records: rawRecords.length, last_sale_date: rawRecords[rawRecords.length - 1]?.date ?? null },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedConfigured.mockReturnValue(true);
});

describe("tryCardsightFallback — early exits (no cost paths)", () => {
  it("returns null when CS not configured", async () => {
    mockedConfigured.mockReturnValue(false);
    const r = await tryCardsightFallback("anything", { playerName: "Eric Hartman" }, "Raw");
    expect(r).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns null on empty query", async () => {
    const r = await tryCardsightFallback("   ", { playerName: "Eric Hartman" }, "Raw");
    expect(r).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns null when catalog search yields zero candidates", async () => {
    mockedFetch.mockResolvedValue([]);
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman" }, "Raw");
    expect(r).toBeNull();
    expect(mockedPricing).not.toHaveBeenCalled();
  });

  it("returns null when candidates present but none match the requested player", async () => {
    // Full override — no Eric Hartman tokens anywhere (player, title, setName)
    // so neither exact-match nor surname-fallback match triggers.
    mockedFetch.mockResolvedValue([
      csCandidate({
        player: "Different Player",
        title: "Different Player 2026 Bowman Chrome Base",
        setName: "Bowman Chrome",
      }),
    ]);
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman" }, "Raw");
    expect(r).toBeNull();
    expect(mockedPricing).not.toHaveBeenCalled();
  });

  it("returns null when year mismatch (guardrail on wrong-year matches)", async () => {
    mockedFetch.mockResolvedValue([csCandidate({ year: 2024 })]);
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).toBeNull();
  });

  it("returns null when pricing returns zero records after filter", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockResolvedValue(makePricing([]));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).toBeNull();
  });
});

describe("tryCardsightFallback — CS year-type quirk (regression pin)", () => {
  it("matches when candidate.year is a string ('2026') and identity.cardYear is a number (2026)", async () => {
    // Live evidence (2026-07-15, post-#454 probe): CS emits year as a
    // string on exploded-per-parallel rows even though the type declares
    // number. Strict !== rejected the match; coerce both to numbers.
    mockedFetch.mockResolvedValue([
      csCandidate({ year: "2026" as unknown as number }),  // CS's actual wire shape
    ]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z" },
    ]));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).not.toBeNull();
    expect(r!.sales).toHaveLength(1);
  });

  it("still rejects on real year mismatch even with string type ('2024' vs 2026)", async () => {
    mockedFetch.mockResolvedValue([
      csCandidate({ year: "2024" as unknown as number }),
    ]);
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).toBeNull();
  });
});

describe("tryCardsightFallback — widened player matching (CS name-format quirks)", () => {
  it("matches when CS returns 'Last, First' formatting via surname fallback", async () => {
    mockedFetch.mockResolvedValue([
      csCandidate({ player: "Hartman, Eric", title: "Hartman, Eric 2026 BC Blue Refractor" }),
    ]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z" },
    ]));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).not.toBeNull();
    expect(r!.sales).toHaveLength(1);
  });

  it("matches when candidate.player is null but title contains player tokens", async () => {
    mockedFetch.mockResolvedValue([
      csCandidate({ player: null as any, title: "Eric Hartman 2026 Bowman Chrome Blue Refractor" }),
    ]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z" },
    ]));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).not.toBeNull();
  });

  it("does NOT match on short surname tokens (guards against noise)", async () => {
    // Surname "Wu" is 2 chars, below the length>=4 gate — should NOT match
    // via surname fallback alone, must require full name.
    mockedFetch.mockResolvedValue([
      csCandidate({ player: "Jane Smith", title: "2026 Bowman Chrome Wu-style Blue", setName: "Bowman Chrome" }),
    ]);
    const r = await tryCardsightFallback("q", { playerName: "Eric Wu", cardYear: 2026 }, "Raw");
    expect(r).toBeNull();
  });
});

describe("tryCardsightFallback — happy path (CS fills CH gap)", () => {
  it("returns RoutedResult with vendor='cardsight' sales when best candidate has pricing", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z", title: "Hartman auto sale", listing_type: "auction", image_url: "https://i.ebay/x.jpg" },
      { price: 1750, date: "2026-07-08T00:00:00Z", title: "Hartman auto sale 2" },
    ]));

    const r = await tryCardsightFallback(
      "2026 Bowman Chrome Eric Hartman Auto Blue",
      { playerName: "Eric Hartman", cardYear: 2026, parallel: "Blue Refractor" },
      "Raw",
    );

    expect(r).not.toBeNull();
    expect(r!.sales).toHaveLength(2);
    expect(r!.sales.every((s) => s.source === "cardsight")).toBe(true);
    expect(r!.sales[0].price).toBe(1800);
    expect(r!.card?.card_id).toBe("cardsight:parent-uuid-1::par-blue-refractor");
    expect(r!.card?.variant).toBe("Blue Refractor");
  });

  it("preserves listing_type + image_url so the RawComp mapper picks them up", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z", listing_type: "fixed", image_url: "https://i.ebay/y.jpg" },
    ]));
    const r = await tryCardsightFallback(
      "q",
      { playerName: "Eric Hartman", cardYear: 2026 },
      "Raw",
    );
    const sale = r!.sales[0] as { listing_type?: string; image_url?: string };
    expect(sale.listing_type).toBe("fixed");
    expect(sale.image_url).toBe("https://i.ebay/y.jpg");
  });

  it("filters out invalid rows (non-positive price, missing date)", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z" },
      { price: 0, date: "2026-07-09T00:00:00Z" },
      { price: 1600, date: "" },
    ]));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r!.sales).toHaveLength(1);
    expect(r!.sales[0].price).toBe(1800);
  });

  it("picks the highest-scoring candidate when multiple match", async () => {
    // Both are Eric Hartman 2026, but only one matches the requested parallel
    mockedFetch.mockResolvedValue([
      csCandidate({ candidateId: "cardsight:parent-1::par-base", parallel: "Base" }),
      csCandidate({ candidateId: "cardsight:parent-1::par-blue", parallel: "Blue Refractor" }),
      csCandidate({ candidateId: "cardsight:parent-1::par-red", parallel: "Red Refractor" }),
    ]);
    mockedPricing.mockResolvedValue(makePricing([
      { price: 1800, date: "2026-07-10T00:00:00Z" },
    ]));
    const r = await tryCardsightFallback(
      "q",
      { playerName: "Eric Hartman", cardYear: 2026, parallel: "Blue Refractor" },
      "Raw",
    );
    expect(r!.card?.card_id).toBe("cardsight:parent-1::par-blue");
    // The pricing call should have used the winning parallelId
    expect(mockedPricing).toHaveBeenCalledWith("parent-1", { parallelId: "par-blue" });
  });
});

describe("tryCardsightFallback — grade selection", () => {
  it("selects graded records matching 'PSA 10' when requested", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockResolvedValue({
      raw: { count: 1, records: [{ price: 100, date: "2026-07-10T00:00:00Z" }] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              count: 2,
              records: [
                { price: 2500, date: "2026-07-11T00:00:00Z" },
                { price: 2600, date: "2026-07-09T00:00:00Z" },
              ],
            },
            {
              grade_value: "9",
              count: 1,
              records: [{ price: 900, date: "2026-07-08T00:00:00Z" }],
            },
          ],
        },
      ],
      meta: { total_records: 4, last_sale_date: "2026-07-11T00:00:00Z" },
    });
    const r = await tryCardsightFallback(
      "q",
      { playerName: "Eric Hartman", cardYear: 2026 },
      "PSA 10",
    );
    expect(r!.sales).toHaveLength(2);
    expect(r!.sales.map((s) => s.price).sort((a, b) => a - b)).toEqual([2500, 2600]);
    expect(r!.sales.every((s) => s.grade === "PSA 10")).toBe(true);
  });

  it("returns null when requested grade not present in graded arrays", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockResolvedValue({
      raw: { count: 0, records: [] },
      graded: [
        { company_name: "PSA", grades: [{ grade_value: "9", count: 1, records: [{ price: 900, date: "2026-07-08T00:00:00Z" }] }] },
      ],
      meta: { total_records: 1, last_sale_date: "2026-07-08T00:00:00Z" },
    });
    const r = await tryCardsightFallback(
      "q",
      { playerName: "Eric Hartman", cardYear: 2026 },
      "BGS 9.5",
    );
    expect(r).toBeNull();
  });
});

describe("tryCardsightFallback — error resilience", () => {
  it("returns null when search throws", async () => {
    mockedFetch.mockRejectedValue(new Error("network"));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman" }, "Raw");
    expect(r).toBeNull();
  });

  it("returns null when pricing throws", async () => {
    mockedFetch.mockResolvedValue([csCandidate()]);
    mockedPricing.mockRejectedValue(new Error("network"));
    const r = await tryCardsightFallback("q", { playerName: "Eric Hartman", cardYear: 2026 }, "Raw");
    expect(r).toBeNull();
  });
});
