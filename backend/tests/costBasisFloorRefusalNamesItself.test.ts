/**
 * CF-A-REFUSED-PRICE-IS-STILL-A-DECISION (2026-09-04).
 *
 * `cost-basis-floor` was the one outcome of the one valuation path that
 * produced no holding, and its own doctrine comment said the caller should
 * "fall through". That fall-through is how a bare number with no
 * `pricingSourceMeta` reached prod — the exact shape #1674 and C-7 were
 * written to abolish, reintroduced by the one branch neither covered.
 *
 * The two live rows these pins are built from, read read-only from prod after
 * the sanctioned reprice (backfill-runner script=reprice-user-holdings
 * apply=true, run 33893507773, user user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4).
 * 41 of 43 holdings carried a `pricingSourceMeta.method`; these two did not,
 * and they are the only two:
 *
 *   9f082213-22c8-4c26-b488-55d3f9edb1b6
 *     "Bowman Chrome Black White Re… #CPA-VF Victor Figueroa, Black & White
 *     Red Ink, raw" — hobbyiqCardId
 *     hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto
 *     fairMarketValue 11, fmvRung null, valueSource "estimated",
 *     pricingSourceMeta {slug, compsUsed: 1} — no method, no confidence, no
 *     labels. Cost basis $278.60; the ladder proposed $8.70 under
 *     `exact-pool-projection` and the floor rejected it at 3.12%.
 *
 *   277b05a3-935f-451a-b5b7-97eb926a3542
 *     Cal Ripken, Jr. 1997 Metal Universe #8, PSA 8 —
 *     hiq:baseball:1997:metal-universe:8:base:no-auto
 *     fairMarketValue 49.99, fmvRung null, valueSource "estimated",
 *     pricingSourceMeta {compsUsed: 50} — no method. Cost basis $52.98; the
 *     ladder proposed $5.40 under `exact-pool-weighted-median`, rejected at
 *     10.19%.
 *
 * The floor was CORRECT in both cases and these pins do not relitigate it —
 * 9f082213's slug pool holds 57 rows of which exactly one ($270) is a Black &
 * White Red Ink sale, the other 56 being base Chrome prospect autos at $5-$20
 * mis-slugged onto the SSP row. Per Drew's 2026-08-30 ruling the Red Ink is a
 * distinct card with its own row, and that row exists and is `user-verified`;
 * it is the POOL that is contaminated, so $8.70 is the base auto's price and
 * refusing it is right.
 *
 * What these pins encode is that a correct refusal LEAVES A TRACE: the number
 * is kept, the row names `method: "withheld"` with the machine-readable
 * reason, and the refused number survives as evidence.
 *
 * MUTATION CHECK: delete the `withheld` block from
 * `costBasisFloorRefusalWrite`'s meta, or drop either call site, and these go
 * red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  costBasisFloorRefusalWrite,
  type CostBasisFloorRefusalFacts,
  type HoldingValuationOutcome,
} from "../src/services/portfolioiq/holdingValuation.js";
import { writeHoldingValuation } from "../src/services/portfolioiq/writeHoldingValuation.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const NOW = "2026-09-04T18:00:00.000Z";

/** Holding 9f082213 exactly as prod held it after run 33893507773. */
const FIGUEROA = {
  id: "9f082213-22c8-4c26-b488-55d3f9edb1b6",
  playerName: "Victor Figueroa",
  hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
  cardId: "1778815951741x825833864349468900",
  cardNumber: "CPA-VF",
  parallel: "Black & White Red Ink",
  isAuto: true,
  fairMarketValue: 11,
  fmvRung: null,
  valueSource: "estimated",
  pricingSourceMeta: {
    slug: "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
    compsUsed: 1,
  },
  purchasePrice: 278.6,
  totalCostBasis: 278.6,
  quantity: 1,
  isEstimate: true,
  valuationStatus: "estimated",
} as unknown as PortfolioHolding;

/** Holding 277b05a3 exactly as prod held it after the same run. */
const RIPKEN = {
  id: "277b05a3-935f-451a-b5b7-97eb926a3542",
  playerName: "Cal Ripken, Jr.",
  cardId: "1675907831540x230095593572250400",
  gradeCompany: "PSA",
  gradeValue: 8,
  fairMarketValue: 49.99,
  fmvRung: null,
  valueSource: "estimated",
  pricingSourceMeta: { compsUsed: 50 },
  purchasePrice: 52.98,
  totalCostBasis: 52.98,
  quantity: 1,
  isEstimate: true,
  valuationStatus: "estimated",
} as unknown as PortfolioHolding;

function floorOutcome(
  slug: string | null,
  rung: string,
  proposedUnit: number,
  costBasis: number,
  compsUsed: number,
): Extract<HoldingValuationOutcome, { outcome: "cost-basis-floor" }> {
  return {
    outcome: "cost-basis-floor",
    costBasis,
    proposedTotal: proposedUnit,
    valuation: {
      fairMarketValue: proposedUnit,
      rungLabel: rung,
      compsUsed,
      identity: { slug, pooledAs: slug, requestedId: slug, pooledVia: "hobbyiqCardId" },
    },
  } as unknown as Extract<HoldingValuationOutcome, { outcome: "cost-basis-floor" }>;
}

const FIGUEROA_FLOOR = floorOutcome(
  "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
  "exact-pool-projection",
  8.7,
  278.6,
  1,
);
const RIPKEN_FLOOR = floorOutcome(
  "hiq:baseball:1997:metal-universe:8:base:no-auto",
  "exact-pool-weighted-median",
  5.4,
  52.98,
  50,
);

describe("a cost-basis-floor refusal is persisted, never a silent fall-through", () => {
  it("9f082213 (Figueroa Red Ink) keeps its number and names method 'withheld'", () => {
    const { holding } = costBasisFloorRefusalWrite(FIGUEROA, FIGUEROA_FLOOR, NOW);
    const meta = holding.pricingSourceMeta as Record<string, unknown>;
    // The number the floor said nothing against is KEPT.
    expect(holding.fairMarketValue).toBe(11);
    // THE defect: this was `undefined` on the live row.
    expect(meta.method).toBe("withheld");
    expect(meta).toHaveProperty("withheld");
    expect((meta.withheld as Record<string, unknown>).reason).toBe("cost-basis-floor");
    // The refused number survives as evidence, never discarded.
    expect((meta.withheld as Record<string, unknown>).proposed).toBe(8.7);
  });

  it("277b05a3 (Ripken PSA 8) gets the identical treatment", () => {
    const { holding } = costBasisFloorRefusalWrite(RIPKEN, RIPKEN_FLOOR, NOW);
    const meta = holding.pricingSourceMeta as Record<string, unknown>;
    expect(holding.fairMarketValue).toBe(49.99);
    expect(meta.method).toBe("withheld");
    expect((meta.withheld as Record<string, unknown>).reason).toBe("cost-basis-floor");
    expect((meta.withheld as Record<string, unknown>).proposed).toBe(5.4);
  });

  it("the refusal records WHY on the row, and does not upgrade the claim", () => {
    const { holding, prose } = costBasisFloorRefusalWrite(FIGUEROA, FIGUEROA_FLOOR, NOW);
    expect(prose).toMatch(/cost-basis sanity floor/);
    // The rung that was refused is named, so the reason survives the log.
    expect(prose).toMatch(/exact-pool-projection/);
    expect((holding as Record<string, unknown>).fmvRetainedReason).toBe(prose);
    expect((holding as Record<string, unknown>).fmvRetainedAt).toBe(NOW);
    // A refusal verifies nothing, so it can never promote to "observed".
    expect(holding.valueSource).toBe("estimated");
  });

  it("never borrows the refused rung for the number it kept", () => {
    const { holding } = costBasisFloorRefusalWrite(FIGUEROA, FIGUEROA_FLOOR, NOW);
    // The prior pass named no rung, so the row says so — it does NOT claim the
    // kept $11 was priced under `exact-pool-projection`, which priced $8.70.
    expect(holding.fmvRung).toBeNull();
    expect((holding as Record<string, unknown>).fmvRungAbsentReason).toMatch(
      /cost-basis sanity floor/,
    );
  });

  it("a prior rung IS carried forward, because it still describes the kept number", () => {
    const withRung = {
      ...FIGUEROA,
      fmvRung: "exact-pool-last-sale",
      valueSource: "observed",
    } as unknown as PortfolioHolding;
    const { holding } = costBasisFloorRefusalWrite(withRung, FIGUEROA_FLOOR, NOW);
    expect(holding.fmvRung).toBe("exact-pool-last-sale");
    expect(holding.valueSource).toBe("observed");
    // Still a stated refusal.
    const meta = holding.pricingSourceMeta as Record<string, unknown>;
    expect(meta.method).toBe("exact-pool-last-sale");
    expect(meta.withheld).toBeDefined();
  });

  it("a prior confidence is carried, never fabricated", () => {
    const withConf = {
      ...FIGUEROA,
      pricingSourceMeta: { slug: "x", compsUsed: 4, confidence: 0.31 },
    } as unknown as PortfolioHolding;
    const { holding } = costBasisFloorRefusalWrite(withConf, FIGUEROA_FLOOR, NOW);
    expect((holding.pricingSourceMeta as Record<string, unknown>).confidence).toBe(0.31);
  });
});

describe("no meta may name an undefined method", () => {
  it("a {noRung} write with an ordinary meta still names a method", () => {
    // The prod shape: a lane refuses to name a rung, passes a plain meta, and
    // `method` fell out as `undefined` — invisible to every rung gate.
    const out = writeHoldingValuation(FIGUEROA, {
      fairMarketValue: 11,
      rung: { noRung: "the prior pass named no rung" },
      valueSource: "estimated",
      nowIso: NOW,
      meta: { slug: "hiq:x", compsUsed: 1, confidence: null },
    });
    const meta = out.pricingSourceMeta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.method).toBeDefined();
    expect(meta.method).toBe("unlabelled-carry");
  });

  it("a named rung is still the method, unchanged", () => {
    const out = writeHoldingValuation(FIGUEROA, {
      fairMarketValue: 270,
      rung: { rung: "exact-pool-last-sale" },
      valueSource: "observed",
      nowIso: NOW,
      meta: { slug: "hiq:x", compsUsed: 1, confidence: 0.4 },
    });
    expect((out.pricingSourceMeta as Record<string, unknown>).method).toBe("exact-pool-last-sale");
  });

  it("a withhold still wins the fallback, and is not relabelled", () => {
    const out = writeHoldingValuation(FIGUEROA, {
      fairMarketValue: null,
      rung: { noRung: "withheld" },
      valueSource: "estimated",
      nowIso: NOW,
      meta: {
        confidence: null,
        withheld: { reason: "cost-basis-floor", blockingId: null, blockingCount: 0, proposed: 8.7 },
      },
    });
    expect((out.pricingSourceMeta as Record<string, unknown>).method).toBe("withheld");
  });
});

const src = readFileSync(
  new URL("../src/services/portfolioiq/portfolioStore.service.ts", import.meta.url),
  "utf8",
);

describe("both one-entry call sites persist the refusal", () => {
  it("the batch reprice handles cost-basis-floor before falling through", () => {
    expect(src).toMatch(/bOneEntry\.outcome === "cost-basis-floor"/);
    // It must WRITE, not merely log.
    expect(src).toMatch(/doc\.holdings\[holding\.id\] = cbf\.holding/);
  });

  it("autoPriceHolding handles it too, so the paths cannot drift", () => {
    expect(src).toMatch(/oneEntry\.outcome === "cost-basis-floor"/);
  });

  it("every site uses the ONE shared write", () => {
    // Three floors, three call sites, ONE implementation. If a fourth floor
    // appears it must route here too — a second implementation of the refusal
    // write is the thing this number exists to refuse.
    const calls = src.match(/costBasisFloorRefusalWrite\(/g) ?? [];
    expect(calls.length).toBe(3);
  });
});

/**
 * CF-ONE-FLOOR-ONE-WRITE (2026-09-04). #1754 routed the two ONE-ENTRY floors
 * through the shared write and left a third standing: the our-pool lane of
 * `repriceHoldingsForUser`, which logged
 * `{event: "our_pool_reprice_rejected_cost_basis_floor", keepingPrior: true}`
 * and wrote NOTHING, leaving the holding's `pricingSourceMeta` as whatever the
 * previous pass happened to leave — precisely the shape the two named rows
 * above were found in, under a different event name.
 *
 * That lane never holds a `Valuation` (it holds an `OurPoolPricingResult`), so
 * the fixture here is shaped like the real two but refused through the narrow
 * facts the lane actually has: the rung, what it proposed, the pool it read,
 * the basis it failed.
 *
 * MUTATION CHECK: bypass the shared write at that lane — restore the bare
 * `console.warn(... keepingPrior: true)` with no `doc.holdings[...] =` — and
 * "the our-pool reprice lane persists its refusal" goes red, as does the
 * call-count pin above.
 */
describe("the our-pool reprice lane refuses through the SAME write", () => {
  const ourPoolFacts: CostBasisFloorRefusalFacts = {
    // The real shape of that lane's refusal: the Bobby Witt Jr. case the
    // guard's own comment names — a high-basis auto matched onto base-card
    // rows by a broad rung.
    rungLabel: "family-baseline",
    proposedUnit: 6.92,
    proposedTotal: 6.92,
    costBasis: 1260,
    pooledAs: "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
    compsUsed: 57,
  };

  it("keeps the prior number and names method 'withheld' with the reason", () => {
    const { holding } = costBasisFloorRefusalWrite(FIGUEROA, ourPoolFacts, NOW);
    const meta = holding.pricingSourceMeta as Record<string, unknown>;
    // The floor faults the NEW number; the old one is untouched.
    expect(holding.fairMarketValue).toBe(11);
    // THE defect this lane had: no method at all, because nothing was written.
    expect(meta.method).toBe("withheld");
    expect((meta.withheld as Record<string, unknown>).reason).toBe("cost-basis-floor");
  });

  it("preserves the refused number and the pool that produced it as evidence", () => {
    const { holding } = costBasisFloorRefusalWrite(FIGUEROA, ourPoolFacts, NOW);
    const withheld = (holding.pricingSourceMeta as Record<string, unknown>)
      .withheld as Record<string, unknown>;
    expect(withheld.proposed).toBe(6.92);
    expect(withheld.blockingId).toBe(ourPoolFacts.pooledAs);
    expect(withheld.blockingCount).toBe(57);
  });

  it("never borrows the refused rung for the number it kept", () => {
    const { holding, prose } = costBasisFloorRefusalWrite(FIGUEROA, ourPoolFacts, NOW);
    // `family-baseline` priced $6.92. The kept $11 was not priced by it, so the
    // row must NOT claim it was.
    expect(holding.fmvRung).toBeNull();
    expect(prose).toMatch(/family-baseline/);
    expect((holding as Record<string, unknown>).fmvRetainedReason).toBe(prose);
    expect((holding as Record<string, unknown>).fmvRetainedAt).toBe(NOW);
  });

  it("carries a prior rung when there is one, still stating the withhold", () => {
    const withRung = {
      ...FIGUEROA,
      fmvRung: "exact-pool-last-sale",
      valueSource: "observed",
    } as unknown as PortfolioHolding;
    const { holding } = costBasisFloorRefusalWrite(withRung, ourPoolFacts, NOW);
    expect(holding.fmvRung).toBe("exact-pool-last-sale");
    expect((holding.pricingSourceMeta as Record<string, unknown>).withheld).toBeDefined();
  });

  it("the two input shapes agree — one write, not two behaviours", () => {
    // The same refusal expressed as a one-entry outcome and as the narrow
    // facts must produce the same row, or the lanes have drifted after all.
    const viaFacts = costBasisFloorRefusalWrite(FIGUEROA, {
      rungLabel: "exact-pool-projection",
      proposedUnit: 8.7,
      proposedTotal: 8.7,
      costBasis: 278.6,
      pooledAs: "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
      compsUsed: 1,
    }, NOW);
    const viaOutcome = costBasisFloorRefusalWrite(FIGUEROA, FIGUEROA_FLOOR, NOW);
    expect(viaFacts.holding).toEqual(viaOutcome.holding);
    expect(viaFacts.prose).toBe(viaOutcome.prose);
    expect(viaFacts.summary).toBe(viaOutcome.summary);
  });

  it("the lane WRITES the refusal, and does not merely log it", () => {
    // The mutation guard: the old code was a lone console.warn carrying
    // `keepingPrior: true`. It must now persist through the shared write.
    expect(src).toMatch(/our_pool_reprice_rejected_cost_basis_floor/);
    // The lane body: from the floor's own `if` to the end of its log call.
    const laneStart = src.indexOf(
      'if (costBasis > 50 && (proposedTotal / costBasis) < 0.15) {',
    );
    expect(laneStart).toBeGreaterThan(0);
    const lane = src.slice(laneStart, src.indexOf("} else {", laneStart));
    expect(lane).toMatch(/our_pool_reprice_rejected_cost_basis_floor/);
    // It must WRITE, through the shared helper, not merely log.
    expect(lane).toMatch(/costBasisFloorRefusalWrite\(/);
    expect(lane).toMatch(/doc\.holdings\[holding\.id\] = cbf\.holding/);
    // The silent shape is gone: this lane may no longer claim `keepingPrior`
    // and write nothing.
    expect(lane).not.toMatch(/keepingPrior:\s*true/);
  });
});
