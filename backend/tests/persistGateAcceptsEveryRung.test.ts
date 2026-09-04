// CF-THE-LADDER-IS-THE-VOCABULARY (Drew, 2026-09-04).
//
// The persist layer accepts WHATEVER RUNG THE LADDER RETURNS.
//
// The defect these pins close, in full. `holdingValuation.ts` — the portfolio
// persist site, the adapter over the one valuation path — decided what to
// persist like this:
//
//     const observed  = priced && valueSource === "observed" && isExactPoolRung(rungLabel);
//     const estimated = priced && valueSource === "estimated" && rungLabel === "grade-curve-estimate";
//     if (!observed && !estimated) return { outcome: "unpriced", valuation: v };
//
// Two rungs, by name. It type-checked perfectly — every member of a subset is
// a member of the union — so nothing caught it when `player-index-projection`
// shipped in #1647 on 2026-09-02 and the ladder began returning a rung that
// literal comparison had never heard of.
//
// Holding 0a9afe09 — Cam Caminiti, 2024 Bowman Draft CPA-CC Blue Refractor
// /150 auto, Raw — valued LIVE at $215.17: rung player-index-projection,
// valueSource estimated, confidence 0.39, basis "Projected from Cam
// Caminiti's market trend — last direct sale 12 weeks ago at $200.00, carried
// forward by the player index ratio 1.076x over a basket of 46 liquid Raw
// cards". Identical for the owner path and the public path. The owner saw NO
// PRICE, because the persist gate dropped the valuation on the floor.
//
// The reprice then walked on to the legacy chain, where
// gateEstimateAgainstExactPool saw ONE in-window exact sale — Drew's own
// $200 purchase — and wrote the sentence "1 exact sale ... that the engine
// could not price". The engine had priced it. Nobody had asked.
//
// So these pins hold the DOCTRINE, not the one rung:
//
//   1. THE CAMINITI FIXTURE. player-index-projection, the owner's purchase
//      the only anchor, persists $215.17 as an ESTIMATE carrying its rung,
//      its confidence and its labels — self-anchored among them, per Drew's
//      standing ruling that a self-comp publishes AND is labeled.
//   2. THE WHOLE VOCABULARY. A table test over every rung fmvRung.ts names:
//      each one persists. The mutation — restore the two-rung whitelist —
//      turns this suite red, which is what makes it a guard rather than a
//      description.
//   3. `no-basis` IS in the vocabulary and must NOT persist: it is the
//      engine's own name for "I could not price this", and a refusal is only
//      ever what the engine itself refuses.
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

import { FMV_RUNG_LABELS, isPricingRung, isExactPoolRung, type FmvRungLabel } from "../src/services/compiq/fmvRung.js";
import { fallbackRungHoldingWrite, observedHoldingWrite } from "../src/services/portfolioiq/holdingValuation.js";
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OWNER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

// ─── The Caminiti holding, as it stands in prod ────────────────────────────
const CAMINITI_HOLDING: PortfolioHolding = {
  id: "0a9afe09",
  userId: OWNER,
  quantity: 1,
  playerName: "Cam Caminiti",
  cardYear: 2024,
  setName: "Bowman Draft",
  cardNumber: "CPA-CC",
  parallel: "Blue Refractor",
  printRun: 150,
  gradeCompany: null,
  gradeValue: null,
  hobbyiqCardId: "hiq:baseball:2024:bowman-draft:cpa-cc:blue-refractor:auto",
  purchasePrice: 200,
  totalCostBasis: 200,
} as unknown as PortfolioHolding;

/**
 * The Caminiti valuation as the live one path returns it — the exact shape
 * measured read-only on 2026-09-04. The owner's own $200 purchase is the ONLY
 * sale behind it, which is what makes the self-anchored label load-bearing:
 * the number published IS Drew's own purchase carried forward.
 */
function caminitiValuation(): Valuation {
  return {
    fairMarketValue: 215.17,
    rungLabel: "player-index-projection",
    valueSource: "estimated",
    reason: null,
    compsUsed: 1,
    confidence: 0.39,
    basis:
      "Projected from Cam Caminiti's market trend — last direct sale 12 weeks ago at $200.00, "
      + "carried forward by the player index ratio 1.076x over a basket of 46 liquid Raw cards",
    identity: {
      slug: CAMINITI_HOLDING.hobbyiqCardId,
      requestedId: CAMINITI_HOLDING.hobbyiqCardId,
      pooledAs: CAMINITI_HOLDING.hobbyiqCardId,
      pooledVia: "hobbyiqCardId",
      parallel: "Blue Refractor",
      setKey: "bowman-draft",
      printRun: 150,
      isAuto: true,
      playerName: "Cam Caminiti",
    },
    requestedTier: "Raw",
    windowDays: 180,
    trend: { direction: "up", pctPerWeek: 0.6 },
    predictedPrice: 215.17,
    weightedMedian: 200,
    // The single anchor: the owner's own purchase.
    sales: [{ price: 200, soldAt: daysAgo(84), source: "ebay-user-purchase", contributorUserId: OWNER }],
    ownerUserId: OWNER,
    gradeCurve: [],
    totalSampleCount: 1,
    unified: null,
    fallback: null,
    computedAt: new Date().toISOString(),
  } as unknown as Valuation;
}

/** A minimal Valuation carrying an arbitrary rung, for the table test. */
function valuationWithRung(rung: FmvRungLabel, value: number): Valuation {
  const v = caminitiValuation() as unknown as Record<string, unknown>;
  return { ...v, rungLabel: rung, fairMarketValue: value, predictedPrice: value } as unknown as Valuation;
}

type Meta = {
  method?: string;
  confidence?: number;
  labels?: Array<{ code: string; text: string }>;
  selfAnchored?: { own: number; total: number } | null;
};

beforeEach(() => { h.rows = []; });

// ─── 1. The Caminiti fixture ───────────────────────────────────────────────
describe("CF-THE-LADDER-IS-THE-VOCABULARY — the Caminiti holding persists", () => {
  it("player-index-projection $215.17 persists as an estimate under its OWN rung", () => {
    const v = caminitiValuation();
    const written = fallbackRungHoldingWrite(CAMINITI_HOLDING, v, new Date().toISOString());

    // The number reaches the holding at all — the whole point.
    expect(written.fairMarketValue).toBe(215.17);
    // Under the rung the ladder actually returned, NOT folded into
    // "grade-curve-estimate", which would have named the wrong mechanism.
    expect(written.fmvRung).toBe("player-index-projection");
    expect(written.valueSource).toBe("estimated");
    // A player index is a proxy over other cards' sales: never "observed".
    expect(isExactPoolRung(written.fmvRung)).toBe(false);
    expect(written.valuationStatus).toBe("estimated");
    expect(written.isEstimate).toBe(true);
    // The engine's own prose survives to the holding, unrewritten.
    expect(written.estimateBasis).toBe(v.basis);
    // No refusal was written: fmvRungAbsentReason is for a write with no rung.
    expect(written.fmvRungAbsentReason).toBeNull();
  });

  it("it carries the labels the one path emits — self-anchored among them (Drew's ruling)", () => {
    const v = caminitiValuation();
    const meta = fallbackRungHoldingWrite(CAMINITI_HOLDING, v, new Date().toISOString())
      .pricingSourceMeta as unknown as Meta;

    // The rung, in the meta the web's holdingProvenance() prefers.
    expect(meta.method).toBe("player-index-projection");
    // CF-CONFIDENCE-IS-NOT-OPTIONAL: the engine's 0..1 confidence, unscaled.
    expect(meta.confidence).toBe(0.39);

    const codes = (meta.labels ?? []).map((l) => l.code);
    // The single anchor behind this number is the owner's own purchase, so
    // Drew's standing ruling applies: it publishes AND it says so.
    expect(codes).toContain("self-anchored");
    expect(meta.selfAnchored).toEqual({ own: 1, total: 1 });
    // A 12-week-old anchor carried on a player index is speculation, and the
    // rung's own doctrine says the label must state it in those words.
    expect(codes).toContain("speculative");
    // Whatever else the one path emits rides along untouched — this pin does
    // not re-implement labelsForResult, it asserts the labels ARRIVED.
    expect(codes.length).toBeGreaterThanOrEqual(2);
  });

  it("the prediction names the rung, not a hardcoded 'grade-curve-estimate'", () => {
    const written = fallbackRungHoldingWrite(CAMINITI_HOLDING, caminitiValuation(), new Date().toISOString());
    expect(written.predictedPriceMechanism).toBe("player-index-projection");
    expect(written.predictedPrice).toBe(215.17);
  });
});

// ─── 2. The whole vocabulary ───────────────────────────────────────────────
describe("every rung the ladder can name persists (table over the vocabulary)", () => {
  const PRICING_RUNGS = FMV_RUNG_LABELS.filter((r) => r !== "no-basis");

  it("the vocabulary is not empty and covers more than the old whitelist", () => {
    // If this ever shrinks to two, the defect has returned in a new shape.
    expect(PRICING_RUNGS.length).toBeGreaterThan(15);
    expect(PRICING_RUNGS).toContain("player-index-projection");
    expect(PRICING_RUNGS).toContain("sibling-parallel");
    expect(PRICING_RUNGS).toContain("family-baseline");
    expect(PRICING_RUNGS).toContain("rare-card-anchor");
    expect(PRICING_RUNGS).toContain("cross-grade-fallback");
    expect(PRICING_RUNGS).toContain("graded-pool-inverse");
    expect(PRICING_RUNGS).toContain("product-tier");
  });

  it.each(PRICING_RUNGS)("%s: a finite positive value persists under this rung", (rung) => {
    // The predicate the persist gate consults. If this is false for a rung
    // the ladder can return, that rung's holdings show NO PRICE.
    expect(isPricingRung(rung)).toBe(true);

    const v = valuationWithRung(rung as FmvRungLabel, 123.45);
    const exact = isExactPoolRung(rung);
    const written = exact
      ? observedHoldingWrite(CAMINITI_HOLDING, { ...v, valueSource: "observed" } as Valuation, new Date().toISOString())
      : fallbackRungHoldingWrite(CAMINITI_HOLDING, v, new Date().toISOString());

    expect(written.fairMarketValue).toBe(123.45);
    expect(written.fmvRung).toBe(rung);
    // Observed iff the rung read the exact pool — the ONE rule that survives.
    expect(written.valueSource).toBe(exact ? "observed" : "estimated");
    // Every persisted price names its source in the meta too (#1674 / C-7).
    expect((written.pricingSourceMeta as unknown as Meta).method).toBe(rung);
  });

  it("`no-basis` is IN the vocabulary and is NOT a pricing rung", () => {
    // It is the engine's own refusal. A persist gate must exclude it by name
    // rather than by forgetting it — forgetting is how the last one broke.
    expect(FMV_RUNG_LABELS).toContain("no-basis");
    expect(isPricingRung("no-basis")).toBe(false);
  });

  it("a rung nobody has defined is not a pricing rung either", () => {
    expect(isPricingRung("whatever-the-next-engine-invents")).toBe(false);
    expect(isPricingRung(null)).toBe(false);
    expect(isPricingRung(undefined)).toBe(false);
    expect(isPricingRung("")).toBe(false);
  });
});

// ─── 2b. The gate itself, behaviourally ────────────────────────────────────
//
// The table above exercises the WRITERS. This block exercises the DECISION —
// `valueHoldingThroughOneEntry`'s acceptance test, the exact `if` that
// discarded Caminiti — by stubbing the one valuation path and asking what
// outcome each rung produces. A source pin can be edited around; this cannot.
describe("valueHoldingThroughOneEntry — the acceptance decision itself", () => {
  it("a priced valuation on ANY vocabulary rung is persisted, never 'unpriced'", async () => {
    const { valueHoldingThroughOneEntry } = await import("../src/services/portfolioiq/holdingValuation.js");
    const entry = await import("../src/services/compiq/oneValuationPath.service.js");

    for (const rung of FMV_RUNG_LABELS.filter((r) => r !== "no-basis")) {
      const v = valuationWithRung(rung as FmvRungLabel, 123.45);
      const exact = isExactPoolRung(rung);
      const spy = vi.spyOn(entry, "valueIdentity").mockResolvedValue(
        (exact ? { ...v, valueSource: "observed" } : v) as Valuation,
      );
      const out = await valueHoldingThroughOneEntry(CAMINITI_HOLDING, { userId: OWNER, caller: "test" });
      spy.mockRestore();

      // The assertion Caminiti needed and did not get.
      expect(out.outcome, `rung ${rung} must persist`).not.toBe("unpriced");
      expect(out.outcome, `rung ${rung}`).toBe(exact ? "observed" : "estimated");
      if (out.outcome === "observed" || out.outcome === "estimated") {
        expect(out.holding.fairMarketValue, `rung ${rung}`).toBe(123.45);
        expect(out.holding.fmvRung, `rung ${rung}`).toBe(rung);
      }
    }
  });

  it("a refusal is ONLY what the engine itself refuses: no-basis, or no value", async () => {
    const { valueHoldingThroughOneEntry } = await import("../src/services/portfolioiq/holdingValuation.js");
    const entry = await import("../src/services/compiq/oneValuationPath.service.js");

    // The engine's own refusal rung.
    const noBasis = { ...valuationWithRung("player-index-projection", 100), rungLabel: "no-basis", fairMarketValue: null, valueSource: "unavailable", reason: "no-exact-pool" } as unknown as Valuation;
    let spy = vi.spyOn(entry, "valueIdentity").mockResolvedValue(noBasis);
    expect((await valueHoldingThroughOneEntry(CAMINITI_HOLDING, { userId: OWNER, caller: "test" })).outcome).toBe("unpriced");
    spy.mockRestore();

    // A null value under a real rung is still nothing to publish.
    const nullValue = { ...valuationWithRung("player-index-projection", 100), fairMarketValue: null } as unknown as Valuation;
    spy = vi.spyOn(entry, "valueIdentity").mockResolvedValue(nullValue);
    expect((await valueHoldingThroughOneEntry(CAMINITI_HOLDING, { userId: OWNER, caller: "test" })).outcome).toBe("unpriced");
    spy.mockRestore();

    // Zero and negative are not prices either.
    for (const bad of [0, -5]) {
      const v = valuationWithRung("player-index-projection", bad);
      spy = vi.spyOn(entry, "valueIdentity").mockResolvedValue(v);
      expect((await valueHoldingThroughOneEntry(CAMINITI_HOLDING, { userId: OWNER, caller: "test" })).outcome).toBe("unpriced");
      spy.mockRestore();
    }
  });
});

// ─── 3. The mutation guard ─────────────────────────────────────────────────
describe("MUTATION: restoring the two-rung whitelist must turn this suite red", () => {
  const src = read("src/services/portfolioiq/holdingValuation.ts");

  it("the acceptance test asks the vocabulary, never a literal rung name", () => {
    // The shape that must exist.
    expect(src).toMatch(/const pricingRung = isPricingRung\(v\.rungLabel\);/);
    // The shape that must NOT come back. This is the literal line that was
    // deleted; if a future edit reinstates it, this pin fails immediately.
    expect(src).not.toMatch(/const estimated = priced && v\.valueSource === "estimated" && v\.rungLabel === "grade-curve-estimate"/);
    expect(src).not.toMatch(/v\.rungLabel === "grade-curve-estimate"/);
  });

  it("the estimate write persists v.rungLabel, not a hardcoded literal", () => {
    expect(src).toMatch(/rung: \{ rung: v\.rungLabel \}/);
    // The old literal in the write is gone from the estimate lane.
    expect(src).not.toMatch(/rung: \{ rung: "grade-curve-estimate" \}/);
  });

  it("the vocabulary array cannot silently fall behind the type", () => {
    // fmvRung.ts carries a compile-time exhaustiveness assertion; this pin
    // states the intent in the suite so a reader deleting the assertion sees
    // what it was for.
    const rungSrc = read("src/services/compiq/fmvRung.ts");
    expect(rungSrc).toMatch(/satisfies ReadonlyArray<FmvRungLabel>/);
    expect(rungSrc).toMatch(/type _EveryRungIsListed = FmvRungLabel extends \(typeof FMV_RUNG_LABELS\)\[number\] \? true : never;/);
  });
});

// ─── 4. The refusal states what actually happened ──────────────────────────
describe("CF-A-REFUSAL-STATES-WHAT-ACTUALLY-HAPPENED — the withhold prose", () => {
  const src = read("src/services/portfolioiq/portfolioStore.service.ts");

  it("no withhold branch claims the engine could not price", () => {
    // The sentence that was written on EVERY withhold, including the ones
    // where the engine HAD priced the card and a whitelist upstream threw the
    // answer away. It exists nowhere in the file except in the comment
    // explaining why it was removed.
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/the engine could not price/);
  });

  it("the reason is an argument the caller supplies from the outcome it observed", () => {
    expect(src).toMatch(/type WithholdReason =/);
    expect(src).toMatch(/kind: "entry-unpriced"; engineReason: string \| null/);
    expect(src).toMatch(/kind: "identity-unresolved"/);
    expect(src).toMatch(/kind: "legacy-unpriced"/);
    expect(src).toMatch(/kind: "cost-basis-floor"/);
    // The entry's OWN outcome decides it — the gate never guesses.
    expect(src).toMatch(/entry\.outcome === "unpriced" \? \{ kind: "entry-unpriced", engineReason: entry\.valuation\.reason \}/);
  });

  it("a withhold writes pricingSourceMeta so the auditor can see it", () => {
    // The old shape: writeMeta:true with NO meta, which wrote `undefined`.
    // #1674's own finding was that a row with no meta is invisible to the
    // invariant auditor — and a refusal is the event it most needs to see.
    expect(src).toMatch(/withheld: \{ reason: withholdReasonCode\(reason\), blockingId: verdict\.blockingId, blockingCount: verdict\.blockingCount, proposed \}/);
    const writer = read("src/services/portfolioiq/writeHoldingValuation.ts");
    // CF-EVERY-META-NAMES-A-METHOD (2026-09-04). This used to pin the literal
    // `: undefined` tail, which pinned the very hole it was written to close:
    // a `{ noRung }` write with an ORDINARY meta (no `withheld`) still fell
    // through to `method: undefined`. Two live rows reached prod that way —
    // 9f082213 (Figueroa Red Ink) and 277b05a3 (Ripken PSA 8), both
    // cost-basis-floor refusals in run 33893507773. The property this pin
    // actually cares about is that a withhold names its method AND that no
    // branch of the expression can yield `undefined`.
    expect(writer).toMatch(/method: rung \?\? \(w\.meta\.withheld \? "withheld" : "[a-z-]+"\)/);
    expect(writer).not.toMatch(/method: rung \?\? \(w\.meta\.withheld \? "withheld" : undefined\)/);
  });

  it("a withhold does not destroy the evidence the one path produced", () => {
    // estimatedValue used to be nulled alongside fairMarketValue, erasing the
    // number the ladder computed. A withhold declines to PUBLISH a value; it
    // is not a licence to delete what was computed.
    expect(src).toMatch(/estimatedValue: proposed,/);
    expect(src).not.toMatch(/estimateBasis: `estimate withheld: \$\{n\} exact sale/);
  });
});
