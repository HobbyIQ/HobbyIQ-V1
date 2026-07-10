// CF-PHASE5-V2-ZERO-COMP-ANCHOR (2026-07-10, Drew). Invariants for the
// product-year cross-player median anchor: env-flag gate, empty-input
// guards, graceful null on Cosmos/CH errors, and correct median math.

import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchCompsByPlayerMock = vi.fn();

vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: (...args: unknown[]) =>
    fetchCompsByPlayerMock(...args),
}));

async function load() {
  return await import("../src/services/compiq/productYearAnchor");
}

const comp = (price: number, cardId = "abc") => ({
  price,
  cardId,
  saleDate: "2026-01-01",
});

describe("fetchProductYearMedianAnchor", () => {
  beforeEach(() => {
    fetchCompsByPlayerMock.mockReset();
    delete process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED;
  });

  it("returns null when env flag is off (no CH call at all)", async () => {
    fetchCompsByPlayerMock.mockResolvedValue({ comps: [comp(100)] });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman Chrome", 2025);
    expect(res).toBeNull();
    expect(fetchCompsByPlayerMock).not.toHaveBeenCalled();
  });

  it("returns null on incomplete inputs", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    const { fetchProductYearMedianAnchor } = await load();
    expect(await fetchProductYearMedianAnchor(null, 2025)).toBeNull();
    expect(await fetchProductYearMedianAnchor("Bowman", null)).toBeNull();
    expect(await fetchProductYearMedianAnchor("", 2025)).toBeNull();
    expect(await fetchProductYearMedianAnchor("   ", 2025)).toBeNull();
    expect(fetchCompsByPlayerMock).not.toHaveBeenCalled();
  });

  it("passes empty playerName to fetchCompsByPlayer (drops player filter)", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockResolvedValue({ comps: [comp(10)] });
    const { fetchProductYearMedianAnchor } = await load();
    await fetchProductYearMedianAnchor("Bowman Chrome", 2025);
    expect(fetchCompsByPlayerMock).toHaveBeenCalledWith({
      playerName: "",
      product: "Bowman Chrome",
      cardYear: 2025,
    });
  });

  it("computes median across the returned comps", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockResolvedValue({
      comps: [comp(5), comp(10), comp(50), comp(100), comp(500)],
    });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman Chrome", 2025);
    expect(res).not.toBeNull();
    expect(res!.median).toBe(50); // sorted: 5, 10, 50, 100, 500 → mid=50
    expect(res!.compCount).toBe(5);
    expect(res!.source).toBe("product-year-anchor");
  });

  it("counts distinct cardIds for dispersion signal", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockResolvedValue({
      comps: [
        comp(10, "card-a"),
        comp(20, "card-a"),
        comp(30, "card-b"),
        comp(40, "card-c"),
      ],
    });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman", 2025);
    expect(res!.compCount).toBe(4);
    expect(res!.distinctCardIds).toBe(3);
  });

  it("filters out zero/negative/non-finite prices before median", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockResolvedValue({
      comps: [
        comp(10),
        comp(0),
        comp(-5),
        { price: NaN, cardId: "x", saleDate: "2026-01-01" },
        comp(30),
      ],
    });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman", 2025);
    // Only 10, 30 survive → sorted: 10, 30 → median at index 1 = 30
    expect(res!.compCount).toBe(2);
    expect(res!.median).toBe(30);
  });

  it("returns null when CH returns no valid comps", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockResolvedValue({ comps: [] });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman", 2025);
    expect(res).toBeNull();
  });

  it("returns null on CH error without throwing", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockRejectedValue(new Error("CH timeout"));
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman", 2025);
    expect(res).toBeNull();
  });
});
