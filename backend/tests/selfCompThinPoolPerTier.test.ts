// CF-SELF-COMP-THIN-POOL-IS-PER-TIER (Drew, 2026-09-02).
//
// Drew's portfolio showed $96.34 on a Justin Verlander 2005 Bowman Chrome
// BDP129 PSA 10 while /canonical-fmv served $251 for the same slug at the
// same moment. Both numbers came from ONE computation (valueIdentity) — the
// one-valuation-path doctrine was not violated. They differed on ONE
// argument: the persist path passes `excludeContributorUserId` (the owner),
// the public routes pass none.
//
// The self-comp thin-pool reprieve (SELF_COMP_MIN_OTHER_SAMPLES) then
// measured the wrong pool. It asked "does this CARD have >= 3 other sales?"
// — Verlander's card had 5, all Raw/BGS — and so dropped the single PSA 10
// sale in existence, which happened to be Drew's own purchase. The PSA 10
// tier went empty and the holding fell to `grade-curve-estimate`.
//
// The reprieve is now measured PER TIER, because a tier is what gets priced.
// These pins hold that shape: a tier whose only evidence is the owner's
// purchase keeps it; a tier with a real market of its own still excludes the
// owner. Re-introduce the whole-card count and the first two go red.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            query: (spec: { parameters?: Array<{ name: string; value: unknown }> }) => ({
              fetchAll: async () => {
                const cutoff = spec?.parameters?.find((p) => p.name === "@cutoff")?.value;
                const rows = typeof cutoff === "string"
                  ? h.rows.filter((r) => String(r.soldAt) >= cutoff)
                  : h.rows;
                return { resources: rows };
              },
            }),
          },
        }),
      };
    }
  }
  return { CosmosClient };
});
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";

import { computeUnifiedPrice } from "../src/services/compiq/unifiedPricing.service.js";

const OWNER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sale = (
  price: number,
  d: number,
  grade: { c: string; v: number } | null,
  contributorUserId: string | null = null,
) => ({
  price,
  soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null,
  gradeValue: grade?.v ?? null,
  source: contributorUserId ? "ebay-user-purchase" : "tca-ebay",
  ...(contributorUserId ? { contributorUserId } : {}),
});

// The Verlander shape, measured 2026-09-02 (holding bba3b7ad, slug
// hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto): the ONLY PSA 10 sale
// is the owner's $251; the card also carries 5 Raw/BGS sales that can say
// nothing about a PSA 10.
const VERLANDER = [
  sale(251, 36, { c: "PSA", v: 10 }, OWNER),
  sale(20, 11, null),
  sale(30.68, 11, null),
  sale(199.99, 18, null),
  sale(15.5, 23, { c: "BGS", v: 7.5 }),
  sale(22.5, 23, { c: "BGS", v: 9 }),
];

const tierOf = (u: { gradeCurve: Array<{ grade: string }> }, g: string) =>
  u.gradeCurve.find((e) => e.grade === g);

beforeEach(() => { h.rows = []; });

describe("self-comp thin-pool reprieve is measured per tier", () => {
  it("PSA-10-in-fields shape: the tier's only sale is the owner's, so it is kept and priced", async () => {
    h.rows = VERLANDER;
    const u = await computeUnifiedPrice("hiq:verlander", {
      hobbyiqCardId: "hiq:verlander",
      grade: { company: "PSA", value: 10 },
      excludeContributorUserId: OWNER,
      perTierWindows: true,
    });
    const psa10 = tierOf(u, "PSA 10");
    // Before the fix: the 5 other-tier rows satisfied the card-wide count,
    // the owner's row was dropped, and PSA 10 had no pool at all.
    expect(psa10).toBeDefined();
    expect(psa10!.sampleCount).toBe(1);
    expect(u.marketValue ?? u.predictedPrice ?? u.fmv).toBe(251);
  });

  it("the number the owner is served equals the number the public route is served", async () => {
    h.rows = VERLANDER;
    const asOwner = await computeUnifiedPrice("hiq:verlander", {
      hobbyiqCardId: "hiq:verlander",
      grade: { company: "PSA", value: 10 },
      excludeContributorUserId: OWNER,
      perTierWindows: true,
    });
    const asPublic = await computeUnifiedPrice("hiq:verlander", {
      hobbyiqCardId: "hiq:verlander",
      grade: { company: "PSA", value: 10 },
      perTierWindows: true,
    });
    const n = (u: typeof asOwner) => u.marketValue ?? u.predictedPrice ?? u.fmv;
    expect(n(asOwner)).toBe(n(asPublic));
  });

  it("a tier with its own market still excludes the owner's sale from it", async () => {
    // Raw has 4 other sales — over the floor — so the owner's outlier Raw
    // purchase is excluded from the Raw tier, exactly as CF-EXCLUDE-SELF-COMPS
    // intends. This is the RA-JC shape (18 others), and it must NOT regress.
    h.rows = [
      sale(9999, 5, null, OWNER),
      sale(100, 6, null),
      sale(102, 7, null),
      sale(101, 8, null),
      sale(99, 9, null),
    ];
    const u = await computeUnifiedPrice("hiq:rajc", {
      hobbyiqCardId: "hiq:rajc",
      grade: null,
      excludeContributorUserId: OWNER,
      perTierWindows: true,
    });
    const raw = tierOf(u, "Raw")!;
    expect(raw.sampleCount).toBe(4);
    const v = u.marketValue ?? u.predictedPrice ?? u.fmv;
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(200);
  });

  it("policy shape: one tier keeps its self-comp while another sheds its own, in one read", async () => {
    // PSA 10: owner-only -> kept. Raw: 4 others -> owner's Raw row dropped.
    h.rows = [
      sale(251, 30, { c: "PSA", v: 10 }, OWNER),
      sale(5000, 5, null, OWNER),
      sale(100, 6, null),
      sale(102, 7, null),
      sale(101, 8, null),
      sale(99, 9, null),
    ];
    const u = await computeUnifiedPrice("hiq:mixed", {
      hobbyiqCardId: "hiq:mixed",
      grade: { company: "PSA", value: 10 },
      excludeContributorUserId: OWNER,
      perTierWindows: true,
    });
    expect(tierOf(u, "PSA 10")!.sampleCount).toBe(1);
    expect(tierOf(u, "Raw")!.sampleCount).toBe(4);
  });

  it("no owner passed (the public route) is unchanged — every row survives", async () => {
    h.rows = VERLANDER;
    const u = await computeUnifiedPrice("hiq:verlander", {
      hobbyiqCardId: "hiq:verlander",
      grade: { company: "PSA", value: 10 },
      perTierWindows: true,
    });
    expect(tierOf(u, "PSA 10")!.sampleCount).toBe(1);
    expect(u.totalSampleCount).toBe(6);
  });
});
