// CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
//
// Drew's standing ruling (2026-09-01): a self-comp PUBLISHES **and is
// LABELED**. #1662's per-tier reprieve made owner rows survive into published
// results; #1670 made the ownership test the contributor. Both fixed the READ
// paths — canonical-fmv's response, the sell draft, the adapters.
//
// The holding never got the label. Verified read-only in prod 2026-09-03 after
// reprice run 33754471013: Verlander PSA 10 ($251, exact-pool-last-sale, the
// tier's only sale being Drew's own purchase) and Caglianone CPA-JC PSA 9
// ($450, 1 of 2 his own) persisted with `labels: []`. The writer stamped
// fmvRung, estimateBasis and pricingSourceMeta.{method,confidence} and stopped.
// So the portfolio list, the detail sheet, the web row and the iOS card all
// showed a self-anchored number as an ordinary market read.
//
// These pins hold three things:
//   1. the WRITER stamps the labels + the ratio onto the holding;
//   2. the WIRE carries them, byte-identical to the live canonical-fmv
//      response for the SAME holding — both driven from ONE fixture, so a
//      divergence is a test failure rather than a review miss;
//   3. an owner-excluded pool (others >= 3) persists NO self label.
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
import { toCanonicalFmvResponse } from "../src/services/compiq/oneValuationPathAdapters.js";
import { labelsForResult } from "../src/services/ebay/ebaySellDraft.service.js";
import { persistedLabelsForValuation } from "../src/services/compiq/valuationLabels.js";
import { observedHoldingWrite, fallbackRungHoldingWrite } from "../src/services/portfolioiq/holdingValuation.js";
import { composeHoldingWireShape } from "../src/services/portfolioiq/responseAssembly.js";
import { buildPricingEnvelope, resolvePricingConfidence } from "../src/services/portfolioiq/pricingEnvelope.builder.js";
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

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

// The Verlander shape (holding bba3b7ad, slug
// hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto), confirmed against prod
// 2026-09-03: the ONLY PSA 10 sale is the owner's $251, an `ebay-user-purchase`
// carrying contributorUserId = Drew.
const VERLANDER = [
  sale(251, 36, { c: "PSA", v: 10 }, OWNER),
  sale(20, 11, null),
  sale(30.68, 11, null),
  sale(199.99, 18, null),
  sale(15.5, 23, { c: "BGS", v: 7.5 }),
  sale(22.5, 23, { c: "BGS", v: 9 }),
];

/**
 * ONE fixture, driven to a Valuation — the SAME object the writer persists
 * from and the live canonical-fmv response is built from. That shared origin
 * is the point of the wire pin below: the two shapes cannot be compared
 * meaningfully if they came from two different computations.
 */
async function valuationFor(opts: {
  rows: Array<Record<string, unknown>>;
  grade: { company: string; value: number } | null;
  owner: string | null;
  confidence?: number;
}): Promise<Valuation> {
  h.rows = opts.rows;
  const u = await computeUnifiedPrice("hiq:fixture", {
    hobbyiqCardId: "hiq:fixture",
    grade: opts.grade,
    ...(opts.owner ? { excludeContributorUserId: opts.owner } : {}),
    perTierWindows: true,
  });
  const tierLabel = opts.grade ? `${opts.grade.company} ${opts.grade.value}` : "Raw";
  const tier = u.gradeCurve.find((e) => e.grade === tierLabel);
  const price = u.marketValue ?? u.predictedPrice ?? u.fmv;
  return {
    fairMarketValue: price,
    rungLabel: "exact-pool-last-sale",
    valueSource: "observed",
    reason: null,
    compsUsed: tier?.sampleCount ?? 0,
    confidence: opts.confidence ?? 0.2,
    basis: "fixture basis",
    identity: {
      slug: "hiq:fixture", requestedId: "hiq:fixture", pooledAs: "hiq:fixture",
      pooledVia: "hobbyiqCardId", parallel: "Base", setKey: null,
    },
    requestedTier: tierLabel,
    windowDays: 180,
    trend: { direction: "flat", pctPerWeek: null },
    predictedPrice: price,
    weightedMedian: null,
    sales: tier?.sales ?? [],
    ownerUserId: opts.owner,
    gradeCurve: [],
    totalSampleCount: u.totalSampleCount,
    unified: u,
    fallback: null,
    computedAt: new Date().toISOString(),
  } as unknown as Valuation;
}

const HOLDING: PortfolioHolding = {
  id: "bba3b7ad", userId: OWNER, quantity: 1,
  playerName: "Justin Verlander", cardYear: 2005,
  gradeCompany: "PSA", gradeValue: 10,
  hobbyiqCardId: "hiq:fixture",
} as unknown as PortfolioHolding;

type StampedMeta = {
  labels?: Array<{ code: string; text: string }>;
  selfAnchored?: { own: number; total: number } | null;
};

const metaOf = (v: Valuation): StampedMeta =>
  observedHoldingWrite(HOLDING, v, new Date().toISOString())
    .pricingSourceMeta as unknown as StampedMeta;

beforeEach(() => { h.rows = []; });

describe("the writer persists the label set the one path computes", () => {
  it("Verlander shape: labels ['self-anchored','low-confidence'], selfAnchored {own:1,total:1}", async () => {
    const v = await valuationFor({
      rows: VERLANDER, grade: { company: "PSA", value: 10 }, owner: OWNER,
    });
    expect(v.fairMarketValue).toBe(251);

    const written = observedHoldingWrite(HOLDING, v, new Date().toISOString());
    const meta = written.pricingSourceMeta as unknown as StampedMeta;

    // The pin Drew named: the codes, in the order labelsForResult emits them.
    expect((meta.labels ?? []).map((l) => l.code)).toEqual(["self-anchored", "low-confidence"]);
    // The tier's only sale is the owner's own purchase.
    expect(meta.selfAnchored).toEqual({ own: 1, total: 1 });
    // And it says so in the sell draft's words, not a paraphrase.
    expect(meta.labels![0].text).toContain(
      "Self-anchored: the only sale behind this estimate is your own purchase",
    );
    // The rung and the price it describes are unchanged by this PR.
    expect(written.fairMarketValue).toBe(251);
    expect(written.fmvRung).toBe("exact-pool-last-sale");
  });

  it("Caglianone shape (owner=1, others=1): partly self-anchored, 1 of 2", async () => {
    const v = await valuationFor({
      rows: [
        sale(450, 20, { c: "PSA", v: 9 }, OWNER),
        sale(430, 30, { c: "PSA", v: 9 }),
      ],
      grade: { company: "PSA", value: 9 },
      owner: OWNER,
    });
    const meta = metaOf(v);
    expect(meta.selfAnchored).toEqual({ own: 1, total: 2 });
    const self = (meta.labels ?? []).find((l) => l.code === "self-anchored");
    expect(self!.text).toContain("1 of 2");
    expect(self!.text).not.toContain("the only sale");
  });

  // CF-COMP-COUNT-IS-THE-POOL (Drew, 2026-09-02). `provenance.comps` is a
  // DISPLAY SAMPLE, truncated to 8 rows by the adapter. The ratio must be
  // stated against the engine's POOL total, or a deep pool reads "1 of 8"
  // when the truth is "1 of 12" — an overstatement of how self-anchored the
  // number is, which is the wrong direction to be wrong.
  //
  // The pool has to be BOTH deep enough to truncate AND thin enough on
  // independent sales that #1662's per-tier reprieve keeps the owner's row.
  // Two independent sales is below the 3-independent floor, so the owner's
  // sale is kept and labeled — and the denominator is the whole tier.
  it("a pool deeper than the display sample states the POOL as the denominator", async () => {
    const deep = [
      sale(500, 3, { c: "PSA", v: 9 }, OWNER),
      sale(480, 5, { c: "PSA", v: 9 }),
      sale(490, 7, { c: "PSA", v: 9 }),
      // Same tier, same owner: enough rows that the 8-row display sample
      // truncates while the independent count stays under the floor.
      ...Array.from({ length: 9 }, (_, i) => sale(495 + i, 9 + i, { c: "PSA", v: 9 }, OWNER)),
    ];
    const v = await valuationFor({
      rows: deep, grade: { company: "PSA", value: 9 }, owner: OWNER,
    });
    const meta = metaOf(v);

    // The pool genuinely exceeds the display sample — otherwise this pins
    // nothing about sample-vs-pool.
    expect(v.compsUsed).toBeGreaterThan(8);
    expect(meta.selfAnchored).not.toBeNull();
    // The denominator is the POOL, not the 8 rows the adapter published.
    expect(meta.selfAnchored!.total).toBe(v.compsUsed);
    const self = (meta.labels ?? []).find((l) => l.code === "self-anchored");
    expect(self!.text).toContain(`of ${v.compsUsed} sales`);
  });

  it("owner excluded (others >= 3): the row is gone, so NO self label persists", async () => {
    const v = await valuationFor({
      rows: [
        sale(9999, 5, null, OWNER),
        sale(100, 6, null), sale(102, 7, null),
        sale(101, 8, null), sale(99, 9, null),
      ],
      grade: null,
      owner: OWNER,
      confidence: 0.9,
    });
    const meta = metaOf(v);
    expect((meta.labels ?? []).some((l) => l.code === "self-anchored")).toBe(false);
    expect(meta.selfAnchored ?? null).toBeNull();
  });
});

describe("the wire carries exactly what the live response carries", () => {
  it("wire labels are byte-identical to the canonical-fmv response's, same fixture", async () => {
    const v = await valuationFor({
      rows: VERLANDER, grade: { company: "PSA", value: 10 }, owner: OWNER,
    });

    // The LIVE read path, for this holding: the same two functions
    // /api/compiq/canonical-fmv answers through.
    const live = labelsForResult(toCanonicalFmvResponse(v), v.ownerUserId);

    // The PERSIST path, for the same holding: writer -> store -> wire.
    const written = observedHoldingWrite(HOLDING, v, new Date().toISOString());
    const wire = composeHoldingWireShape(written);

    expect(wire.pricingLabels).toEqual(live.map((l) => ({ code: l.code, text: l.text })));
    // Not vacuous: this fixture genuinely produces labels.
    expect(wire.pricingLabels!.length).toBeGreaterThan(0);
    expect(wire.selfAnchored).toEqual({ own: 1, total: 1 });
  });

  it("the detail envelope agrees with the list row", async () => {
    const v = await valuationFor({
      rows: VERLANDER, grade: { company: "PSA", value: 10 }, owner: OWNER,
    });
    const written = observedHoldingWrite(HOLDING, v, new Date().toISOString());
    const wire = composeHoldingWireShape(written);
    const envelope = buildPricingEnvelope(written, {
      fmvPerUnit: 251,
      displayable: { value: 251, source: "observed" },
      quantity: 1,
      freshness: "Live",
    });
    expect(envelope.provenance.pricingLabels).toEqual(wire.pricingLabels);
    expect(envelope.provenance.selfAnchored).toEqual(wire.selfAnchored);
  });

  it("a holding written before this field wires an empty set, never a guess", () => {
    const legacy = {
      ...HOLDING,
      fairMarketValue: 100,
      fmvRung: "exact-pool-projection",
      pricingSourceMeta: { slug: "hiq:fixture", method: "exact-pool-projection", compsUsed: 9 },
    } as unknown as PortfolioHolding;
    const wire = composeHoldingWireShape(legacy);
    expect(wire.pricingLabels).toEqual([]);
    expect(wire.selfAnchored).toBeNull();
  });

  it("a malformed stamp is dropped, and a ratio that cannot be stated is not stated", () => {
    const junk = {
      ...HOLDING,
      pricingSourceMeta: {
        slug: "hiq:fixture", method: "exact-pool-projection", compsUsed: 1,
        labels: [{ code: "self-anchored", text: "ok" }, { code: 7 }, null, "nope"],
        // total < own is not a ratio anyone can read.
        selfAnchored: { own: 3, total: 1 },
      },
    } as unknown as PortfolioHolding;
    const wire = composeHoldingWireShape(junk);
    expect(wire.pricingLabels).toEqual([{ code: "self-anchored", text: "ok" }]);
    expect(wire.selfAnchored).toBeNull();
  });
});

describe("the derivation is the one derivation", () => {
  it("persistedLabelsForValuation equals labelsForResult of toCanonicalFmvResponse", async () => {
    for (const grade of [{ company: "PSA", value: 10 }, null]) {
      const v = await valuationFor({ rows: VERLANDER, grade, owner: OWNER });
      const direct = labelsForResult(toCanonicalFmvResponse(v), v.ownerUserId)
        .map((l) => ({ code: l.code, text: l.text }));
      expect(persistedLabelsForValuation(v).labels).toEqual(direct);
    }
  });
});

// CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03).
//
// The same class of defect as the labels above, one field over, found the same
// way: read-only in prod after reprice run 33801195439, `pricingSourceMeta.
// confidence` was ABSENT on 43 of Drew's 43 holdings — after TWO reprices.
//
// The engine had the number the whole time; Caglianone's own persisted label
// read "Low confidence (0.23)". What dropped it was the writer:
// holdingValuation.ts — the lane the reprice wave actually used — built its
// meta with slug, compsUsed and labels and never named confidence, while the
// sibling lane in portfolioStore stamped `confidence: u.confidence` correctly.
// Two write paths, one contract, and the type permitted the disagreement:
// `confidence?: number | null` on the helper's meta, and writeHoldingValuation
// (#1677) only emits the key when non-null, so an omission vanished silently.
//
// It is not cosmetic. #1672 made the pricing envelope and the sell window READ
// this field; null means "unknown-confidence" and the sell timing is withheld.
// A dropped field kept the sell-window feature dark for every unified row.
//
// So: the fixture goes through observedHoldingWrite and the persisted
// confidence must EQUAL the engine's, on the same 0..1 scale the consumer
// requires — pinned all the way to resolvePricingConfidence, because equality
// with the engine is only half the contract; the number must also survive the
// reader that #1672 gates the feature on.
describe("the writer persists the engine's pricing confidence", () => {
  it("observedHoldingWrite stamps pricingSourceMeta.confidence === the engine's value", async () => {
    const v = await valuationFor({
      rows: VERLANDER, grade: { company: "PSA", value: 10 }, owner: OWNER,
      confidence: 0.23,  // Caglianone's live figure
    });
    const written = observedHoldingWrite(HOLDING, v, new Date().toISOString());
    const meta = written.pricingSourceMeta as unknown as { confidence?: unknown };

    // MUTATION: drop `confidence: v.confidence` from observedHoldingWrite's
    // meta and this is `undefined` — exactly the live shape — and red.
    expect(meta.confidence).toBe(0.23);
    expect(meta.confidence).toBe(v.confidence);
    // Present as an OWN key, not merely undefined-equal: absence was the bug.
    expect(Object.keys(meta as object)).toContain("confidence");
  });

  it("fallbackRungHoldingWrite stamps it too — an estimate carries its confidence", async () => {
    const v = await valuationFor({
      rows: VERLANDER, grade: { company: "PSA", value: 10 }, owner: OWNER,
      confidence: 0.41,
    });
    const written = fallbackRungHoldingWrite(HOLDING, v, new Date().toISOString());
    const meta = written.pricingSourceMeta as unknown as { confidence?: unknown };
    expect(meta.confidence).toBe(0.41);
    expect(Object.keys(meta as object)).toContain("confidence");
  });

  it("the persisted number is the 0..1 quantity the #1672 consumer reads back", async () => {
    // The scale is load-bearing: resolvePricingConfidence rejects anything
    // outside 0..1 (unitOrNull) and returns null — which the sell window
    // reports as "unknown-confidence" and withholds timing for. Passing the
    // engine's value through scalePricingConfidence (the LEGACY 0..100 path's
    // converter) would make 0.23 into 0.0023; passing it raw is correct
    // because observedGradeCurve.computeConfidence already emits 0..1.
    const v = await valuationFor({
      rows: VERLANDER, grade: { company: "PSA", value: 10 }, owner: OWNER,
      confidence: 0.23,
    });
    const written = observedHoldingWrite(HOLDING, v, new Date().toISOString());
    expect(resolvePricingConfidence(written)).toBe(0.23);
    // And the envelope publishes it as the PRICING confidence.
    expect(buildPricingEnvelope(written, {
      fmvPerUnit: 251,
      displayable: { value: 251, source: "observed" },
      quantity: 1,
      freshness: "Live",
    }).confidence.pricing).toBe(0.23);
  });
});
