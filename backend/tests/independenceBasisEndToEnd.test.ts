// CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04) — end to end.
//
// The unit pins (sellerIndependenceBasis.test.ts) hold the rule in
// isolation. These drive the REAL engine + adapter + label composer, so a
// regression anywhere on that path — the pool reader dropping the seller
// from its projection, the adapter forgetting to thread it, the composer
// deciding an unverifiable pool is "independent" — turns this red.
import { describe, it, expect, vi } from "vitest";

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
import { toCanonicalFmvResponse } from "../src/services/compiq/oneValuationPathAdapters.js";
import { labelsForResult } from "../src/services/ebay/ebaySellDraft.service.js";
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const sale = (price: number, d: number, sellerHandle: string | null) => ({
  price,
  soldAt: daysAgo(d),
  gradeCompany: "PSA",
  gradeValue: 10,
  source: "tca-ebay",
  ...(sellerHandle ? { sellerHandle } : {}),
});

async function publish(rows: Array<Record<string, unknown>>) {
  h.rows = rows;
  const u = await computeUnifiedPrice("hiq:fixture", {
    hobbyiqCardId: "hiq:fixture",
    grade: { company: "PSA", value: 10 },
    perTierWindows: true,
  });
  const tier = u.gradeCurve.find((e) => e.grade === "PSA 10");
  const price = u.marketValue ?? u.predictedPrice ?? u.fmv;
  const v = {
    fairMarketValue: price,
    rungLabel: "exact-pool-last-sale",
    valueSource: "observed",
    reason: null,
    compsUsed: tier?.sampleCount ?? 0,
    confidence: 0.9,
    basis: "fixture",
    identity: { parallel: null, setKey: null },
    requestedTier: "PSA 10",
    windowDays: 180,
    trend: { direction: "flat", pctPerWeek: null },
    predictedPrice: price,
    weightedMedian: null,
    sales: tier?.sales ?? [],
    ownerUserId: null,
    gradeCurve: [],
    totalSampleCount: u.totalSampleCount,
    unified: null,
    fallback: null,
    computedAt: new Date().toISOString(),
  } as unknown as Valuation;
  const result = toCanonicalFmvResponse(v);
  return { result, labels: labelsForResult(result, null) };
}

describe("the seller reaches the wire, and the label states the basis", () => {
  it("PRODUCTION SHAPE: vendor rows carry no seller -> independence-unverified", async () => {
    // 4,492,670 cardhedge + 2,116,858 tca-ebay rows in the last 90 days
    // carry no seller. This is what almost every real result looks like.
    const { result, labels } = await publish([
      sale(300, 5, null), sale(310, 12, null), sale(295, 20, null), sale(305, 30, null),
    ]);
    // The seller field survives the reader's projection and the adapter.
    expect(result.provenance?.comps?.length).toBeGreaterThan(0);
    for (const c of result.provenance!.comps!) {
      expect(c).toHaveProperty("sellerHandle");
      expect(c.sellerHandle).toBeNull();
    }
    const codes = labels.map((l) => l.code);
    expect(codes).toContain("independence-unverified");
    const text = labels.find((l) => l.code === "independence-unverified")!.text;
    // It must not claim the threshold is met, and must say WHY it cannot.
    expect(text).toMatch(/do not tell us who sold them/i);
    // It states the threshold it CANNOT confirm, never that it is met, and
    // never speaks a seller COUNT it did not observe.
    expect(text).toMatch(/cannot confirm 3 independent sellers/i);
    expect(text).not.toMatch(/only \d+ independent seller/i);
  });

  it("three DIFFERENT sellers -> no unverified label; the claim is earned", async () => {
    const { result, labels } = await publish([
      sale(300, 5, "dcsports87"),
      sale(310, 12, "comc_consignment"),
      sale(295, 20, "old_cards_crib"),
    ]);
    expect(result.provenance!.comps!.map((c) => c.sellerHandle).sort())
      .toEqual(["comc_consignment", "dcsports87", "old_cards_crib"]);
    expect(labels.map((l) => l.code)).not.toContain("independence-unverified");
  });

  it("THE DEFECT: three rows from ONE seller no longer read as independent", async () => {
    // Under the old row-count rule this pool was indistinguishable from the
    // three-seller pool above. Now it is labeled a thin seller base.
    const { labels } = await publish([
      sale(300, 5, "probstein123"),
      sale(310, 12, "probstein123"),
      sale(295, 20, "probstein123"),
    ]);
    const l = labels.find((x) => x.code === "independence-unverified");
    expect(l).toBeDefined();
    expect(l!.text).toMatch(/only 1 independent seller\b/i);
  });
});
