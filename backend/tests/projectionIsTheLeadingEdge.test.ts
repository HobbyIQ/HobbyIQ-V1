// CF-THE-PROJECTION-IS-THE-LEADING-EDGE + CF-ONE-SALE-WINDOW-POLICY (D22,
// Drew 2026-08-30). Two measured defects, pinned through the ONE entry
// (valueIdentity) with the real engine over the mocked exactPoolReader.
//
// A. Holding deced7d3 — 2025 Bowman Draft Max Williams CPA-MWI Refractor
//    auto, raw. Raw sales by week (Drew's read of the pool): May-w2 n=2
//    $16.99; May-w3 n=4 $10.94–$25; Jun-w5 $10.51; Jul-w1 $11.99; Jul-w2 $15;
//    Aug-w1 $30; Aug-w2 n=2 $19.50–$21; Aug-w3 n=10 $25–$38 (median $30, last
//    sale 08-21 $38). Persisted: $18.74 exact-pool-projection, "window=60d
//    n=29 median=$14 trend=up 12.1%/wk" — the OLS line's level was the
//    window's centroid, so the number sat below every one of the last ten
//    sales. Now: anchored on the leading edge, the projection lands inside
//    the last ten sales' range, near their $30 median.
//
// B. Holding afd40fed — Theo Gillen 2024 Bowman Draft CPA-TG Blue Refractor
//    /150, raw. Five sales: $125, $161.50, $192.51, $250 (2025) and $729 on
//    2026-08-20. The 60d/90d windows hold one sale; the 180d window two, and
//    the $729 carries >99.9% of its recency weight → the card read $729 under
//    a weighted-median label. Drew ruled (2026-08-30 19:50Z): "Keep — the
//    latest sale is the market." So the DEFAULT policy is last-sale: $729
//    stands, under a label that says one sale carried it, and the basis
//    prints what the named alternative (widen: the 180d leading edge,
//    $489.50) would have said. widen is the constant Drew can flip on.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds?: readonly string[] | null; windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the entry asks the resolver
// directly; the fixture catalog answers through the real pure rule.
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return { ...actual, resolveIdentityToCatalogRow: vi.fn(async (slug: string) => actual.pickCatalogRow(slug, [...h.catalog.keys()])) };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => {
      if (h.catalog.has(slug)) return slug;
      const twin = slug.replace(/:num-\d+$/, "");
      return twin !== slug && h.catalog.has(twin) ? twin : null;
    }),
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => null),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : null)) };
});
delete process.env.COSMOS_CONNECTION_STRING;
delete process.env.ONE_SALE_WINDOW_POLICY;

import { valueIdentity } from "../src/services/compiq/oneValuationPath.service.js";
import { projectFromLeadingEdge } from "../src/services/compiq/nextSaleProjection.service.js";
import {
  ONE_SALE_AGREEMENT_PCT,
  ONE_SALE_WEIGHT_SHARE,
  ONE_SALE_WINDOW_POLICY_DEFAULT,
  oneSaleWindowPolicy,
} from "../src/services/compiq/unifiedPricing.service.js";

// "Now" is 2026-08-30 in Drew's read; the engine reads Date.now(), so every
// sale is placed by its age relative to that day.
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000 + 3_600_000).toISOString();

const MW = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MW_TWIN = `${MW}:num-499`;
const TG = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";

const row = (slug: string, price: number, d: number) => ({
  cardId: "ch-vendor-row", hobbyiqCardId: slug, price, soldAt: daysAgo(d),
  gradeCompany: null, gradeValue: null, source: "cardhedge",
});

/** Max Williams, raw, by Drew's weeks (ages from 2026-08-30). The pool holds
 *  the un-numbered id and its :num-499 twin until the fold lands; the entry
 *  reads the twin on attempt 2, and this fixture keeps every sale on one id
 *  so the count is the count. */
//  (The engine dedupes same-price same-day rows — CH writes one sale twice —
//  so the ten Aug-w3 sales carry the distinct cents the real pool has.)
const maxWilliams = (slug: string) => [
  row(slug, 16.99, 111), row(slug, 16.5, 111),                        // May-w2
  row(slug, 10.94, 107), row(slug, 16.99, 105), row(slug, 20, 104), row(slug, 25, 102), // May-w3
  row(slug, 10.51, 62),                                               // Jun-w5
  row(slug, 11.99, 56),                                               // Jul-w1
  row(slug, 15, 52),                                                  // Jul-w2
  row(slug, 30, 29),                                                  // Aug-w1
  row(slug, 19.5, 20), row(slug, 21, 20),                             // Aug-w2
  row(slug, 25, 15),                                                  // Aug-w3 (08-15)
  row(slug, 27.99, 14), row(slug, 28, 14), row(slug, 28.5, 14), row(slug, 29.99, 14), row(slug, 31.99, 14), // 08-16
  row(slug, 30, 9), row(slug, 30.5, 9), row(slug, 32, 9), row(slug, 38, 9), // 08-21, last $38
];
const LAST_TEN = [25, 27.99, 28, 28.5, 29.99, 31.99, 30, 30.5, 32, 38];

const gillen = () => [
  row(TG, 161.5, 470), row(TG, 192.51, 459), row(TG, 125, 380),  // 2025 — outside 180d
  row(TG, 250, 148),                                             // 2026-04-04
  row(TG, 729, 10),                                              // 2026-08-20
];

const catalogRow = (over: Record<string, unknown>) => ({
  playerName: "Test Player", year: 2025, setKey: "bowman-draft", setName: "2025 Bowman Draft",
  cardNumber: "CPA-MWI", parallel: "Refractor", isAuto: true, sport: "baseball", printRun: null, imageUrl: null,
  ...over,
});

beforeEach(() => { h.rows = []; h.catalog = new Map(); delete process.env.ONE_SALE_WINDOW_POLICY; });
afterEach(() => { delete process.env.ONE_SALE_WINDOW_POLICY; });

describe("A. the projection is anchored on the leading edge (Max Williams CPA-MWI)", () => {
  it("lands inside the last ten sales' range, near their $30 median — not below every one of them", async () => {
    h.catalog.set(MW, catalogRow({}));
    h.rows = maxWilliams(MW);
    const v = await valueIdentity({ id: MW });
    expect(v.rungLabel).toBe("exact-pool-projection");
    expect(v.windowDays).toBe(60);
    expect(v.compsUsed).toBe(15);
    const fmv = v.fairMarketValue as number;
    const lo = Math.min(...LAST_TEN), hi = Math.max(...LAST_TEN);
    // eslint-disable-next-line no-console
    console.log(`Max Williams: FMV $${fmv} (was $18.74) predicted+7d $${v.predictedPrice} trend ${v.trend.pctPerWeek}%/wk\n  basis: ${v.basis}`);
    expect(fmv).toBeGreaterThanOrEqual(lo);
    expect(fmv).toBeLessThanOrEqual(hi);
    // "≈$30": within a quarter of the last ten sales' median.
    expect(Math.abs(fmv - 30) / 30).toBeLessThanOrEqual(0.25);
    // The defect's number is gone: above every sale of the newest week's floor.
    expect(fmv).toBeGreaterThan(18.74);
    // The basis states the window choice, the anchor, and what the rung did.
    expect(v.basis).toMatch(/window=60d \[60d n=15\]/);
    expect(v.basis).toMatch(/anchor=\$\d+/);
    expect(v.basis).toMatch(/anchored on the leading edge: recency-weighted level \$\d+(\.\d+)? sitting \d+(\.\d+)?d back/);
    expect(v.basis).toMatch(/rung=exact-pool-projection/);
  });

  it("the twin attempt prices the same way when the sales sit under :num-499", async () => {
    h.catalog.set(MW, catalogRow({}));
    h.rows = maxWilliams(MW_TWIN);
    const v = await valueIdentity({ id: MW, printRun: 499 });
    expect(v.identity.pooledAs).toBe(MW_TWIN);
    expect(v.rungLabel).toBe("exact-pool-projection");
    expect(v.fairMarketValue as number).toBeGreaterThanOrEqual(25);
    expect(v.fairMarketValue as number).toBeLessThanOrEqual(38);
  });

  it("projectFromLeadingEdge: the level is the newest sales' and the slope moves it forward from THEIR time, never from the window's centroid", () => {
    const comps = maxWilliams(MW).map((r) => ({ price: r.price, soldDate: r.soldAt }))
      .filter((c) => Date.parse(c.soldDate) >= NOW - 60 * 86_400_000);
    const p = projectFromLeadingEdge(comps, { nowMs: NOW })!;
    expect(p.n).toBe(15);
    // The anchor sits in the newest week (recency-weighted), well under 3 weeks back.
    expect(p.anchorPrice).toBeGreaterThanOrEqual(28);
    expect(p.anchorPrice).toBeLessThanOrEqual(32);
    expect(p.anchorAgeDays).toBeLessThan(21);
    // A rising window: the slope is positive and the value is anchor + slope × age.
    expect(p.slopePerDay).toBeGreaterThan(0);
    expect(p.nextSaleValue).toBeCloseTo(Math.min(p.anchorPrice + p.slopePerDay * p.anchorAgeDays, 38 * 1.25), 2);
    expect(p.newestPrice).toBe(38);
    // A flat, dense pool projects its own level.
    const flat = Array.from({ length: 10 }, (_, i) => ({ price: 100, soldDate: daysAgo(i * 5) }));
    expect(projectFromLeadingEdge(flat, { nowMs: NOW })!.nextSaleValue).toBe(100);
    // No sales → null, never a number.
    expect(projectFromLeadingEdge([], { nowMs: NOW })).toBeNull();
  });

  it("the newest-sale band still holds: a runaway slope cannot leave ±25% of the last real transaction", () => {
    // Old cheap cluster, then a steep run-up: the OLS slope is huge, the band caps it.
    const comps = [
      ...Array.from({ length: 6 }, (_, i) => ({ price: 10, soldDate: daysAgo(50 + i) })),
      { price: 60, soldDate: daysAgo(3) }, { price: 62, soldDate: daysAgo(2) }, { price: 64, soldDate: daysAgo(1) },
    ];
    const p = projectFromLeadingEdge(comps, { nowMs: NOW })!;
    expect(p.nextSaleValue).toBeLessThanOrEqual(64 * 1.25);
    expect(p.nextSaleValue).toBeGreaterThanOrEqual(64 * 0.75);
  });
});

describe("B. a one-sale window does not win on its own (Gillen CPA-TG Blue /150)", () => {
  it("the default policy is `last-sale` (Drew's ruling), and the constants are named", () => {
    expect(ONE_SALE_WINDOW_POLICY_DEFAULT).toBe("last-sale");
    expect(oneSaleWindowPolicy()).toBe("last-sale");
    expect(ONE_SALE_WEIGHT_SHARE).toBe(0.75);
    expect(ONE_SALE_AGREEMENT_PCT).toBe(0.25);
  });

  it("last-sale (default, Drew's ruling): the latest sale IS the market — $729 under exact-pool-last-sale, with widen's number printed beside it", async () => {
    h.catalog.set(TG, catalogRow({ year: 2024, setName: "2024 Bowman Draft", cardNumber: "CPA-TG", parallel: "Blue Refractor", printRun: 150 }));
    h.rows = gillen();
    const v = await valueIdentity({ id: TG });
    // eslint-disable-next-line no-console
    console.log(`Gillen (last-sale, default): FMV $${v.fairMarketValue} rung ${v.rungLabel}\n  basis: ${v.basis}`);
    expect(v.windowDays).toBe(180);
    expect(v.compsUsed).toBe(2);
    expect(v.fairMarketValue).toBe(729);
    expect(v.rungLabel).toBe("exact-pool-last-sale");
    expect(v.valueSource).toBe("observed");
    expect(v.basis).toMatch(/window=180d \[60d n=1, 90d n=1, 180d n=2, 180d with all 2\]/);
    expect(v.basis).toMatch(/carries >99\.9% of the window's recency weight/);
    expect(v.basis).toMatch(/ONE_SALE_WINDOW_POLICY=last-sale/);
    expect(v.basis).toMatch(/widen would say \$489\.5/);
  });

  it("widen (the named alternative, off): a one-sale window does not win on its own — the 180d leading edge $489.50 under its own label, with $729 printed beside it", async () => {
    process.env.ONE_SALE_WINDOW_POLICY = "widen";
    h.catalog.set(TG, catalogRow({ year: 2024, setName: "2024 Bowman Draft", cardNumber: "CPA-TG", parallel: "Blue Refractor", printRun: 150 }));
    h.rows = gillen();
    const v = await valueIdentity({ id: TG });
    // eslint-disable-next-line no-console
    console.log(`Gillen (widen, alternative): FMV $${v.fairMarketValue} rung ${v.rungLabel}`);
    expect(v.fairMarketValue).toBe(489.5);
    expect(v.rungLabel).toBe("exact-pool-leading-edge");
    expect(v.basis).toMatch(/ONE_SALE_WINDOW_POLICY=widen/);
    expect(v.basis).toMatch(/last-sale would say \$729/);
  });

  it("a carrying sale that AGREES with the leading edge leaves the weighted median standing (the D16 thin fixture)", async () => {
    h.catalog.set(TG, catalogRow({ year: 2024, cardNumber: "CPA-TG", parallel: "Blue Refractor", printRun: 150 }));
    h.rows = [row(TG, 50, 3), row(TG, 60, 30)];
    const v = await valueIdentity({ id: TG });
    expect(v.rungLabel).toBe("exact-pool-weighted-median");
    expect(v.fairMarketValue).toBe(50);
    expect(v.basis).toMatch(/agrees with the leading edge/);
  });

  it("exactly one sale in the widest window: nothing to widen to — the sale stands under exact-pool-last-sale", async () => {
    h.catalog.set(TG, catalogRow({ year: 2024, cardNumber: "CPA-TG", parallel: "Blue Refractor", printRun: 150 }));
    h.rows = [row(TG, 729, 10)];
    const v = await valueIdentity({ id: TG });
    expect(v.fairMarketValue).toBe(729);
    expect(v.rungLabel).toBe("exact-pool-last-sale");
    expect(v.compsUsed).toBe(1);
    expect(v.basis).toMatch(/nothing wider to widen to/);
  });

  it("a thin window no single sale carries is the plain recency-weighted median", async () => {
    h.catalog.set(TG, catalogRow({ year: 2024, cardNumber: "CPA-TG", parallel: "Blue Refractor", printRun: 150 }));
    h.rows = [row(TG, 100, 5), row(TG, 120, 8), row(TG, 90, 12)];
    const v = await valueIdentity({ id: TG });
    expect(v.rungLabel).toBe("exact-pool-weighted-median");
    expect(v.basis).toMatch(/the newest carries \d+% of the weight/);
  });
});
