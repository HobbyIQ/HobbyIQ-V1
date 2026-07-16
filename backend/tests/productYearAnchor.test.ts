// CF-PHASE5-V2-ZERO-COMP-ANCHOR (2026-07-10, Drew). Invariants for the
// product-year cross-player anchor: env-flag gate, empty-input guards,
// graceful null on Cosmos/CH errors, and correct trend-projected next-
// sale math (CF-NO-MEDIAN-FMV, PR #480 — was median pre-fix).

import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchCompsByPlayerMock = vi.fn();

vi.mock("../src/services/compiq/compsByPlayer.service.js", () => ({
  fetchCompsByPlayer: (...args: unknown[]) =>
    fetchCompsByPlayerMock(...args),
}));

async function load() {
  return await import("../src/services/compiq/productYearAnchor");
}

// CF-NO-MEDIAN-FMV: `date` matches CompByPlayer's real shape (see
// compsByPlayer.service.ts). Distinct dates keep projectNextSaleFromComps
// on the regression branch so tests measure projected next-sale math,
// not the arbitrary-anchor same-date fallback.
const comp = (price: number, cardId = "abc", date = "2026-01-01") => ({
  price,
  cardId,
  date,
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

  it("computes trend-projected next-sale anchor across the returned comps", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    // Distinct dates → regression fires. Flat pool (5, 10, 50, 100, 500)
    // spanning 20 days with a rising trend → projection ≥ newest sale.
    fetchCompsByPlayerMock.mockResolvedValue({
      comps: [
        comp(5, "abc", "2026-01-01"),
        comp(10, "abc", "2026-01-05"),
        comp(50, "abc", "2026-01-10"),
        comp(100, "abc", "2026-01-15"),
        comp(500, "abc", "2026-01-20"),
      ],
    });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman Chrome", 2025);
    expect(res).not.toBeNull();
    // CF-NO-MEDIAN-FMV (PR #480): retired the median (50). Trend-
    // projected value on a strongly rising pool must be > any single
    // comp price except the newest, and non-null. The `median` field
    // name is preserved for structural call-site parity.
    expect(typeof res!.median).toBe("number");
    expect(res!.median).toBeGreaterThan(0);
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

  it("filters out zero/negative/non-finite prices before projecting", async () => {
    process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED = "true";
    fetchCompsByPlayerMock.mockResolvedValue({
      comps: [
        comp(10, "abc", "2026-01-01"),
        comp(0, "abc", "2026-01-05"),
        comp(-5, "abc", "2026-01-10"),
        { price: NaN, cardId: "x", date: "2026-01-15" },
        comp(30, "abc", "2026-01-20"),
      ],
    });
    const { fetchProductYearMedianAnchor } = await load();
    const res = await fetchProductYearMedianAnchor("Bowman", 2025);
    // CF-NO-MEDIAN-FMV (PR #480): 10 and 30 survive filters; anchor is
    // the trend-projected next sale, not the median (30). Two dated
    // survivors with distinct dates → regression fits.
    expect(res!.compCount).toBe(2);
    expect(typeof res!.median).toBe("number");
    expect(res!.median).toBeGreaterThan(0);
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
