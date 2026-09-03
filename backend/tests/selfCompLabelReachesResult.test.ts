// CF-SELF-COMP-LABEL-REACHES-THE-RESULT (Drew, 2026-09-03).
//
// Drew's standing ruling (2026-09-01): a self-comp PUBLISHES **and is
// LABELED**. #1662 made the thin-pool reprieve per-tier, so an owner's own
// sale now SURVIVES into a published result whenever it is the tier's only
// evidence. That turned a latent bug into a live violation of the ruling:
// the number published, the label did not.
//
// Two things blocked it, and neither was the reprieve:
//
//   1. `oneValuationPathAdapters.toCanonicalFmvResponse` stamped
//      `verifiedByUser: false` on EVERY comp, unconditionally. The engine
//      knew whose sale it was; the wire threw it away.
//
//   2. The only ownership test downstream (ebaySellDraft `isSelfComp`) asked
//      `verifiedByUser === true || source.startsWith("holding::")`. Drew's
//      kept rows carry `source: "ebay-user-purchase"` — neither half matched.
//
// `verifiedByUser` was never the ownership field. It means ATTESTED:
// ebayImportRematch writes `ebay-user-purchase` with `contributorUserId` set
// and this flag FALSE, because the matcher found the identity and the user
// never confirmed it. Measured in prod 2026-09-03 across the whole
// user-contributed pool: 128 `ebay-user-purchase` rows, 104 carrying a
// contributor, only 56 carrying the flag. Ownership is the CONTRIBUTOR.
//
// Verlander (owner=1, others=0, source ebay-user-purchase) and Caglianone
// CPA-JC PSA 9 (owner=1, others=1) came back labeled low-confidence only.
// These pins hold both halves: the engine keeps and prices the owner's row,
// AND the result says whose sale it is.
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
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";
import type { CanonicalFmvResult } from "../src/services/compiq/canonicalFmv.service.js";

const OWNER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const STRANGER = "user-00000000-0000-0000-0000-000000000000";
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** A pool row in the shape `exactPoolReader` selects it. Drew's own rows
 *  carry `ebay-user-purchase` + a contributor — NOT `holding::`. */
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
// hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto). Confirmed against
// prod 2026-09-03: the ONLY PSA 10 sale is the owner's $251, written as
// `ebay-user-purchase` with contributorUserId = Drew.
const VERLANDER = [
  sale(251, 36, { c: "PSA", v: 10 }, OWNER),
  sale(20, 11, null),
  sale(30.68, 11, null),
  sale(199.99, 18, null),
  sale(15.5, 23, { c: "BGS", v: 7.5 }),
  sale(22.5, 23, { c: "BGS", v: 9 }),
];

/** Drive the engine, then build the wire shape the way valueIdentity does:
 *  the requested tier's sales become `Valuation.sales`, and the owner the
 *  caller named becomes `ownerUserId`. This is the seam the bug lived in —
 *  the adapter is pure, so a fixture Valuation exercises it honestly. */
async function priceAndPublish(opts: {
  rows: Array<Record<string, unknown>>;
  grade: { company: string; value: number } | null;
  owner: string | null;
}): Promise<{ price: number | null; result: CanonicalFmvResult }> {
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
  const v = {
    fairMarketValue: price,
    rungLabel: "exact-pool-last-sale",
    valueSource: "observed",
    reason: null,
    compsUsed: tier?.sampleCount ?? 0,
    confidence: 0.5,
    basis: "fixture",
    identity: { parallel: null, setKey: null } as Valuation["identity"],
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
  return { price, result: toCanonicalFmvResponse(v) };
}

const selfLabel = (r: CanonicalFmvResult, owner: string | null) =>
  labelsForResult(r, owner).find((l) => l.code === "self-anchored");

beforeEach(() => { h.rows = []; });

describe("a published self-comp reaches the result LABELED", () => {
  it("Verlander shape (owner=1, others=0, ebay-user-purchase): $251 AND self-anchored", async () => {
    const { price, result } = await priceAndPublish({
      rows: VERLANDER,
      grade: { company: "PSA", value: 10 },
      owner: OWNER,
    });

    // Half one: #1662's reprieve keeps the tier's only sale and prices it.
    expect(price).toBe(251);

    // Half two — the half that was missing. The comp reaches the wire
    // carrying its contributor, and marked as the reader's own.
    expect(result.provenance.comps).toHaveLength(1);
    expect(result.provenance.comps[0].contributorUserId).toBe(OWNER);
    expect(result.provenance.comps[0].verifiedByUser).toBe(true);

    const self = selfLabel(result, OWNER);
    expect(self).toBeDefined();
    expect(self!.text).toContain("your own purchase");
  });

  it("owner=1, others=1 (Caglianone CPA-JC PSA 9 shape): self-anchored, ratio 1 of 2", async () => {
    const { price, result } = await priceAndPublish({
      rows: [
        sale(450, 20, { c: "PSA", v: 9 }, OWNER),
        sale(430, 30, { c: "PSA", v: 9 }),
      ],
      grade: { company: "PSA", value: 9 },
      owner: OWNER,
    });

    // One other sale is below the 3-independent floor, so the owner's row
    // is KEPT — and therefore must be labeled.
    expect(price).not.toBeNull();
    expect(result.provenance.compCount).toBe(2);

    const self = selfLabel(result, OWNER);
    expect(self).toBeDefined();
    expect(self!.text).toContain("1 of 2");
    // Not "the only sale" — one independent sale does support it.
    expect(self!.text).not.toContain("the only sale");
  });

  it("a legacy holding:: source is still recognized as the owner's", () => {
    const result = {
      fmv: 500,
      method: "direct-comp",
      rungLabel: "exact-pool-last-sale",
      confidence: 0.8,
      provenance: {
        summary: "legacy",
        compCount: 1,
        // Pre-dates the contributor stamp: no contributorUserId at all.
        comps: [{
          price: 500,
          soldAt: daysAgo(10),
          source: "holding::abc-123",
          parallel: null,
          verifiedByUser: false,
        }],
        trendPctPerMonth: null,
        multipliers: {},
      },
      computedAt: new Date().toISOString(),
      gradeLadder: null,
      recentRange: null,
    } as unknown as CanonicalFmvResult;

    expect(selfLabel(result, OWNER)).toBeDefined();
  });

  it("owner excluded (others >= 3): the owner's row is gone, so NO label", async () => {
    const { price, result } = await priceAndPublish({
      rows: [
        sale(9999, 5, null, OWNER),
        sale(100, 6, null),
        sale(102, 7, null),
        sale(101, 8, null),
        sale(99, 9, null),
      ],
      grade: null,
      owner: OWNER,
    });

    // The tier prices itself without the owner — CF-EXCLUDE-SELF-COMPS as
    // designed. The outlier is gone from the number...
    expect(price).not.toBeNull();
    expect(price!).toBeLessThan(200);
    // ...and gone from the published comps, so nothing claims to be "yours".
    expect(result.provenance.comps.some((c) => c.contributorUserId === OWNER)).toBe(false);
    expect(result.provenance.comps.every((c) => c.verifiedByUser === false)).toBe(true);
    expect(selfLabel(result, OWNER)).toBeUndefined();
  });

  it("a stranger reading the same pool is never told the sale is theirs", async () => {
    const { result } = await priceAndPublish({
      rows: VERLANDER,
      grade: { company: "PSA", value: 10 },
      owner: OWNER,
    });
    // The row IS the owner's, and the wire says so — but the label is
    // computed against the READER, and this reader is somebody else.
    expect(result.provenance.comps[0].contributorUserId).toBe(OWNER);
    expect(selfLabel(result, STRANGER)).toBeUndefined();
    // The public route names no user at all: nothing is "yours".
    expect(selfLabel(result, null)).toBeUndefined();
  });

  it("the public route stamps no ownership on anyone's comps", async () => {
    // No owner passed — every row survives (unchanged), and none is marked.
    const { result } = await priceAndPublish({
      rows: VERLANDER,
      grade: { company: "PSA", value: 10 },
      owner: null,
    });
    expect(result.provenance.comps.every((c) => c.verifiedByUser === false)).toBe(true);
    expect(selfLabel(result, null)).toBeUndefined();
  });
});
