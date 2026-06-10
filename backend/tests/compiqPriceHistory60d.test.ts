// CF-PRICEHISTORY-60D (2026-06-10): regression + positive coverage for the
// 60-day priceHistory[] series added to /api/compiq/price-by-id's response
// for the comp-page chart.
//
// HARD GATE (Drew's brief): adding priceHistory must NOT shift the value
// path by a cent. The first describe block locks `fairMarketValue`,
// `recentComps[]`, and the compQuality histogram from a default-fixture
// run; if a refactor leaks into the value path, the lock fails.
//
// Drew also asked us to lock `excludedComps[]` "free insurance against an
// unexpected coupling through the shared pool." excludedComps is built in
// marketRead.service.ts which the route layer calls AFTER computeEstimate;
// at the service-level it does not surface directly. Locking the
// `compQuality.{usedComps,excluded,reasons}` counters that DO flow through
// the service return is the equivalent insurance — they're derived from
// the same applyCompQualityFilter pass marketRead's excludedComps draws
// from, so any drift in the shared filter shows up here.
//
// The second block exercises the new path positively: a 21-60d sale must
// land in priceHistory, a 61-80d sale must NOT, raw listing_type carries
// through unchanged, and a planted keyword-junk row is filtered out.
//
// The third block unit-tests evenlyDownsample in isolation so we never
// silently truncate to the most-recent N on dense 60d pools.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: vi.fn(),
  };
});

import {
  computeEstimate,
  evenlyDownsample,
} from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardSight from "../src/services/compiq/cardsight.client.js";

const TROUT_PINNED_ID = "fda530ab-e925-460e-ab88-63199ef975e9";

// ───────────────────────────────────────────────────────────────────────────
// Fixture builder — extended (not replaced) from
// compiqEstimatePricingCardSchema.test.ts. Default path is byte-identical
// to the legacy fixture (rawCount param, same `i % 5` date spread, same
// price ladder) so the existing schema tests keep passing. New flags:
//
//   spread80d    — spread N records over 0-80d at 3d steps so the test
//                  has sales inside the 21d window, inside the 21-60d
//                  gap, AND beyond 60d in a single run.
//   withJunk     — append a keyword-junk row ("Lot of 50 cards") at the
//                  given dayOffset so we can assert the priceHistory
//                  keyword filter drops it at full strength.
//   typedRow     — append a single record with explicit listing_type
//                  ("auction" or "fixed") so we can assert the raw
//                  listingType carries through priceHistory unchanged.
// ───────────────────────────────────────────────────────────────────────────

interface FixtureOpts {
  rawCount?: number;
  spread80d?: boolean;
  withJunk?: { dayOffset: number };
  typedRow?: { dayOffset: number; listingType: "fixed" | "auction"; price?: number };
}

function makeTroutPricingFixture(opts: FixtureOpts = {}) {
  const today = new Date();
  const isoDaysAgo = (n: number) =>
    new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
  const rawCount = opts.rawCount ?? 12;
  const records: Array<Record<string, unknown>> = [];

  if (opts.spread80d) {
    // 30 records, 3d step → covers 0..87d, giving 7 in [0,21), 13 in
    // [21,60), 10 in [60,87]. Stable price ladder so the value path
    // (when run on the 21d subset) yields a deterministic FMV.
    for (let i = 0; i < 30; i++) {
      records.push({
        title: `2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample ${i})`,
        price: 200 + i * 10,
        date: isoDaysAgo(i * 3),
        source: "ebay",
        url: null,
      });
    }
  } else {
    for (let i = 0; i < rawCount; i++) {
      records.push({
        title: `2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample ${i})`,
        price: 200 + i * 10,
        date: isoDaysAgo(i % 5),
        source: "ebay",
        url: null,
      });
    }
  }

  if (opts.withJunk) {
    records.push({
      title: `Lot of 50 2011 Topps Update Mike Trout #US175 — see desc (sample junk)`,
      price: 250,
      date: isoDaysAgo(opts.withJunk.dayOffset),
      source: "ebay",
      url: null,
    });
  }
  if (opts.typedRow) {
    records.push({
      title: `2011 Topps Update Mike Trout RC Rookie #US175 Angels (typed marker)`,
      price: opts.typedRow.price ?? 270,
      date: isoDaysAgo(opts.typedRow.dayOffset),
      source: "ebay",
      url: null,
      listing_type: opts.typedRow.listingType,
    });
  }

  return {
    card: {
      card_id: TROUT_PINNED_ID,
      name: "Mike Trout",
      number: "US175",
      set: {
        set_id: "9d4173f3-09af-49c2-a719-ba11824fd207",
        name: "Base Set",
        year: "2011",
        release: "Topps Update",
      },
    },
    raw: { count: records.length, records },
    graded: [],
    meta: {
      total_records: records.length,
      last_sale_date: (records[0] as { date: string }).date,
    },
  } as any;
}

// ───────────────────────────────────────────────────────────────────────────
// Block A — HARD GATE: value path byte-identical pre/post.
// ───────────────────────────────────────────────────────────────────────────

describe("CF-PRICEHISTORY-60D — value path unchanged (hard gate)", () => {
  beforeAll(() => {
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fairMarketValue + recentComps[] + compQuality counters are stable on the legacy 12-record fixture", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTroutPricingFixture({ rawCount: 12 }),
    );

    const result = (await computeEstimate(
      { playerName: TROUT_PINNED_ID, cardsightCardId: TROUT_PINNED_ID } as any,
      testCallContext,
    )) as Record<string, unknown>;

    // The hard gate: snapshot the value-path outputs. Any change to
    // applyRecencyFilter / tier ladder / quality filter that leaks
    // into the value path will move at least one of these fingerprints.
    // Updates require explicit human ack via vitest --update.
    //
    // soldDate is converted to "days ago" so the snapshot is time-stable
    // (the fixture builder uses Date.now() too, so the same offset
    // collapses to the same integer bucket across runs).
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recentCompsFingerprint = (result.recentComps as Array<Record<string, unknown>>).map(
      (c) => ({
        price: c.price,
        title: c.title,
        soldDateDaysAgo: Math.floor((now - Date.parse(c.soldDate as string)) / DAY_MS),
        grade: c.grade,
        saleType: c.saleType ?? null,
        imageUrl: c.imageUrl ?? null,
        belowMarket: c.belowMarket ?? null,
      }),
    );

    const valuePathFingerprint = {
      compsUsed: result.compsUsed,
      compsAvailable: result.compsAvailable,
      fmvRounded: typeof result.fairMarketValue === "number"
        ? Math.round((result.fairMarketValue as number) * 100) / 100
        : result.fairMarketValue,
      recentCompsCount: recentCompsFingerprint.length,
      recentComps: recentCompsFingerprint,
      compQualityUsed: (result.compQuality as any)?.usedComps,
      compQualityExcluded: (result.compQuality as any)?.excluded,
      compQualityReasons: (result.compQuality as any)?.reasons,
    };

    // Inline snapshot — drift here means the priceHistory factoring
    // bled into the value path and the CF needs to HALT.
    expect(valuePathFingerprint).toMatchInlineSnapshot(`
      {
        "compQualityExcluded": 0,
        "compQualityReasons": {},
        "compQualityUsed": 12,
        "compsAvailable": 12,
        "compsUsed": 12,
        "fmvRounded": 278,
        "recentComps": [
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 200,
            "saleType": null,
            "soldDateDaysAgo": 0,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 0)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 250,
            "saleType": null,
            "soldDateDaysAgo": 0,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 5)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 300,
            "saleType": null,
            "soldDateDaysAgo": 0,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 10)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 210,
            "saleType": null,
            "soldDateDaysAgo": 1,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 1)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 260,
            "saleType": null,
            "soldDateDaysAgo": 1,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 6)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 310,
            "saleType": null,
            "soldDateDaysAgo": 1,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 11)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 220,
            "saleType": null,
            "soldDateDaysAgo": 2,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 2)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 270,
            "saleType": null,
            "soldDateDaysAgo": 2,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 7)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 230,
            "saleType": null,
            "soldDateDaysAgo": 3,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 3)",
          },
          {
            "belowMarket": null,
            "grade": "Raw",
            "imageUrl": null,
            "price": 280,
            "saleType": null,
            "soldDateDaysAgo": 3,
            "title": "2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample 8)",
          },
        ],
        "recentCompsCount": 10,
      }
    `);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Block B — positive priceHistory[] behavior on the 0-80d spread fixture.
// ───────────────────────────────────────────────────────────────────────────

describe("CF-PRICEHISTORY-60D — positive coverage", () => {
  beforeAll(() => {
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes 21-60d sales, excludes 61d+ sales, carries raw listingType, filters keyword junk", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTroutPricingFixture({
        spread80d: true,
        withJunk: { dayOffset: 30 },
        typedRow: { dayOffset: 25, listingType: "auction", price: 280 },
      }),
    );

    const result = (await computeEstimate(
      { playerName: TROUT_PINNED_ID, cardsightCardId: TROUT_PINNED_ID } as any,
      testCallContext,
    )) as Record<string, unknown>;

    const priceHistory = result.priceHistory as Array<{
      soldDate: string;
      price: number;
      listingType: "fixed" | "auction" | null;
    }>;

    expect(Array.isArray(priceHistory)).toBe(true);
    expect(priceHistory.length).toBeGreaterThan(0);

    // Sorted ascending by soldDate.
    for (let i = 1; i < priceHistory.length; i++) {
      const a = Date.parse(priceHistory[i - 1].soldDate);
      const b = Date.parse(priceHistory[i].soldDate);
      expect(a).toBeLessThanOrEqual(b);
    }

    const ageDays = (iso: string) =>
      Math.floor((Date.now() - Date.parse(iso)) / (24 * 3600 * 1000));

    const ages = priceHistory.map((p) => ageDays(p.soldDate));

    // Every age must fall inside the 60d window.
    for (const d of ages) expect(d).toBeLessThanOrEqual(60);

    // A 21-60d sale (the `i=10` synthetic at 30 days) must be present.
    const has21To60 = ages.some((d) => d >= 21 && d <= 60);
    expect(has21To60).toBe(true);

    // The 61d+ synthetics (`i=21..29` at 63..87 days) must NOT be present.
    const has61Plus = ages.some((d) => d > 60);
    expect(has61Plus).toBe(false);

    // Raw listingType for the typed-marker row carries through.
    const typedPresent = priceHistory.some(
      (p) => p.listingType === "auction" && p.price === 280,
    );
    expect(typedPresent).toBe(true);

    // Clean rows without a listing_type field land as null (not undefined,
    // not "fixed" inferred — Drew's brief: "carry RAW listingType").
    const nullTypedCount = priceHistory.filter((p) => p.listingType === null).length;
    expect(nullTypedCount).toBeGreaterThan(0);

    // Keyword-junk row ("Lot of 50") must NOT have leaked through.
    // Identity check: junk price is 250; we'd see it ONLY if the filter
    // failed. Use the synthetic dayOffset 30 as the discriminator.
    const junkPresent = priceHistory.some((p) => {
      const d = ageDays(p.soldDate);
      return d >= 29 && d <= 31 && p.price === 250;
    });
    expect(junkPresent).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Block C — evenlyDownsample unit. Exercised in isolation so the
// 150-cap behavior is testable without spinning up the full pipeline.
// ───────────────────────────────────────────────────────────────────────────

describe("CF-PRICEHISTORY-60D — evenlyDownsample", () => {
  it("returns items unchanged when n <= target", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = evenlyDownsample(items, 150);
    expect(out).toEqual(items);
  });

  it("downsamples 300 → 150 with preserved endpoints and even spread", () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const out = evenlyDownsample(items, 150);
    expect(out.length).toBe(150);
    // Endpoints preserved.
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(299);
    // Strictly increasing (deduped + sorted by source index).
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
    // Even spread: no gap should exceed ~2× the average gap. Average
    // gap on 300→150 is 299/149 ≈ 2.007, so a gap >5 indicates a bug.
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBeLessThanOrEqual(5);
    }
  });

  it("returns empty array when target is 0", () => {
    expect(evenlyDownsample([1, 2, 3], 0)).toEqual([]);
  });

  it("handles target == 1 without crashing (picks first element)", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = evenlyDownsample(items, 1);
    expect(out).toEqual([0]);
  });
});
