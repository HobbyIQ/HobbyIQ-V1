// CF-SLOPE-VALUATION (Drew, 2026-07-13, PR #418) — pins the linear-
// regression market value math to Drew's walk-through examples so a
// future refactor can't silently drift the semantics.

import { describe, expect, it, vi, afterEach } from "vitest";
import { priceByCardsightUuid } from "../src/services/compiq/cardsightUuidPriceRouter.js";
import * as slim from "../src/services/compiq/cardsightSlim.client.js";

const HARTMAN_DETAIL = {
  id: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
  name: "Eric Hartman",
  number: "CPA-EHA",
  releaseName: "Bowman",
  setName: "Chrome Prospects Autographs",
  year: 2026,
  parallels: [],
};

/** Anchor NOW so all test math is deterministic. */
const NOW = Date.parse("2026-08-01T00:00:00Z");
const dateAgo = (days: number) =>
  new Date(NOW - days * 86_400_000).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Market Value + Predicted from linear regression", () => {
  it("Drew's walk-through: 175/176/204/208 chronologically → Market Value ~$208, Predicted ~$241, direction up", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    // 4 sales over 30 days at 175, 176, 204, 208 (chronological)
    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: {
        count: 4,
        records: [
          { price: 175, date: dateAgo(30) },
          { price: 176, date: dateAgo(20) },
          { price: 204, date: dateAgo(10) },
          { price: 208, date: dateAgo(0) },
        ],
      },
      graded: [],
      meta: { total_records: 4, last_sale_date: dateAgo(0) },
    } as any);

    const r = await priceByCardsightUuid({
      cardId: HARTMAN_DETAIL.id,
      parallelId: null,
      gradeCompany: null,
      gradeValue: null,
    });

    // Market Value = regression fit at the LAST sale's date (today).
    // OLS on x=[0,10,20,30], y=[175,176,204,208]:
    //   slope     = 1.27 dollars/day
    //   intercept = 171.70 at t=firstT (day 0)
    //   value at day 30 = 171.70 + 1.27 × 30 = $209.80
    expect(r.marketValue).toBeGreaterThanOrEqual(207);
    expect(r.marketValue).toBeLessThanOrEqual(212);

    // Predicted = regression at now + 30d.
    //   value at day 60 = 171.70 + 1.27 × 60 = $247.90
    expect(r.predictedPrice).toBeGreaterThanOrEqual(240);
    expect(r.predictedPrice).toBeLessThanOrEqual(255);

    expect(r.predictedPriceAttribution.method).toBe("linear-regression");
    expect(r.predictedPriceAttribution.direction).toBe("up");
    expect(r.predictedPriceAttribution.n).toBe(4);
  });

  it("Flat sales all near $200 → direction 'static', Market Value ~= last sale", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: {
        count: 4,
        records: [
          { price: 199, date: dateAgo(30) },
          { price: 201, date: dateAgo(20) },
          { price: 200, date: dateAgo(10) },
          { price: 202, date: dateAgo(0) },
        ],
      },
      graded: [],
      meta: { total_records: 4, last_sale_date: dateAgo(0) },
    } as any);

    const r = await priceByCardsightUuid({
      cardId: HARTMAN_DETAIL.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });

    expect(r.predictedPriceAttribution.direction).toBe("static");
    expect(r.marketValue).toBeGreaterThanOrEqual(198);
    expect(r.marketValue).toBeLessThanOrEqual(204);
  });

  it("Downtrend 300 → 220 → direction 'down', Market Value drops to trend line at last date", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: {
        count: 4,
        records: [
          { price: 300, date: dateAgo(30) },
          { price: 285, date: dateAgo(20) },
          { price: 250, date: dateAgo(10) },
          { price: 220, date: dateAgo(0) },
        ],
      },
      graded: [],
      meta: { total_records: 4, last_sale_date: dateAgo(0) },
    } as any);

    const r = await priceByCardsightUuid({
      cardId: HARTMAN_DETAIL.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });

    expect(r.predictedPriceAttribution.direction).toBe("down");
    // Market Value should land near the last sale (~$220), not the median.
    expect(r.marketValue).toBeGreaterThanOrEqual(215);
    expect(r.marketValue).toBeLessThanOrEqual(230);
  });

  it("Falls back to full-pool median + null predicted when the slope can't compute (single record)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: { count: 1, records: [{ price: 150, date: dateAgo(5) }] },
      graded: [],
      meta: { total_records: 1, last_sale_date: dateAgo(5) },
    } as any);

    const r = await priceByCardsightUuid({
      cardId: HARTMAN_DETAIL.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });

    expect(r.marketValue).toBe(150);
    expect(r.predictedPrice).toBeNull();
    expect(r.predictedPriceAttribution).toBeNull();
  });

  it("Same-day sales (no time spread) → slope can't compute, fall back to median", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: {
        count: 3,
        records: [
          { price: 100, date: dateAgo(0) },
          { price: 110, date: dateAgo(0) },
          { price: 120, date: dateAgo(0) },
        ],
      },
      graded: [],
      meta: { total_records: 3, last_sale_date: dateAgo(0) },
    } as any);

    const r = await priceByCardsightUuid({
      cardId: HARTMAN_DETAIL.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });

    expect(r.marketValue).toBe(110);   // median of 100/110/120
    expect(r.predictedPrice).toBeNull();
  });
});
