/**
 * CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
 *
 * Drew's standing ruling (2026-09-01): a self-comp PUBLISHES **and is
 * LABELED**. #1662 made the thin-pool reprieve per-tier and #1670 made the
 * ownership test the contributor rather than `verifiedByUser`, so the label
 * finally reached the READ paths — canonical-fmv's response, the sell draft,
 * the one-valuation-path adapters.
 *
 * It never reached the HOLDING. Verified read-only in prod 2026-09-03 after
 * reprice run 33754471013: Drew's Verlander PSA 10 ($251, rung
 * exact-pool-last-sale, the tier's only sale being his own purchase) and
 * Caglianone CPA-JC PSA 9 ($450, 1 of 2 sales his own) persist with
 * `labels: []`. The writer stamped `fmvRung`, `estimateBasis` and
 * `pricingSourceMeta.{method,confidence}` and nothing else, so the portfolio
 * list, the holding detail, the web row and the iOS card all showed a
 * self-anchored number with no hint that the only evidence behind it was the
 * owner's own purchase. The label existed for anyone who asked the card page
 * and for nobody looking at their own portfolio.
 *
 * This module is the ONE derivation. It does not re-implement the label
 * rules: it routes the Valuation through the SAME two functions the live
 * canonical-fmv response goes through —
 *
 *     Valuation → toCanonicalFmvResponse → labelsForResult
 *
 * — so a persisted label set is byte-identical to the one the live response
 * carries for the same holding, by construction rather than by review. A
 * rule added to `labelsForResult` (a new rung, a new caveat) reaches the
 * holding on the next reprice with no change here; a divergence between the
 * wire and the holding is not possible without editing that one function.
 *
 * `selfAnchored` rides alongside as the machine-readable ratio, because
 * "1 of 2" is a fact a client may want to render its own way (a chip, a
 * count, an accessibility string) and re-parsing it out of the sentence
 * would be a second implementation of the same rule.
 */
import type { Valuation } from "./oneValuationPath.service.js";
import { toCanonicalFmvResponse } from "./oneValuationPathAdapters.js";
import { labelsForResult, type SellDraftLabel } from "../ebay/ebaySellDraft.service.js";

/** The label set persisted on a holding, in the shape the wire carries. */
export interface PersistedPricingLabel {
  code: SellDraftLabel["code"];
  text: string;
}

/** How much of the evidence behind a persisted price is the owner's own.
 *  `own === total` is the fully self-anchored case Drew's Verlander shows. */
export interface PersistedSelfAnchored {
  /** Sales in the published evidence that the owner contributed. */
  own: number;
  /** The evidence pool total the ratio is stated against (compCount, not
   *  the truncated display sample — CF-COMP-COUNT-IS-THE-POOL). */
  total: number;
}

export interface PersistedPricingLabels {
  labels: PersistedPricingLabel[];
  /** Present only when at least one published sale is the owner's. */
  selfAnchored: PersistedSelfAnchored | null;
}

/**
 * The labels a valuation must carry onto the holding it prices.
 *
 * `v.ownerUserId` is the reader the valuation was computed for — the
 * portfolio, reprice and sell-draft paths all name one, and it is null on
 * the public routes, where nothing can be "yours" and no self label can
 * fire. Pure: no engine call, no pool read.
 */
export function persistedLabelsForValuation(v: Valuation): PersistedPricingLabels {
  const result = toCanonicalFmvResponse(v);
  const owner = v.ownerUserId ?? null;
  const labels = labelsForResult(result, owner).map((l) => ({ code: l.code, text: l.text }));

  // CF-A-GATE-THAT-FIRES-ABOVE-EVERY-RUNG-IS-NOT-A-RUNG-GATE (#1811). A price
  // published while this identity's pool was still migrating carries the fact
  // as a caveat. It can only be a PUBLISHED price that reaches here — the gate
  // withholds every own-pool rung — so the sentence says the true thing: the
  // number comes from other cards, and one from this card's own sales may
  // replace it shortly.
  //
  // It is stamped here rather than in `labelsForResult` because `poolMigrating`
  // is a property of the IDENTITY's freshness, which the CanonicalFmvResult
  // wire shape does not carry; routing it through there would mean widening
  // that shape for a field no client reads.
  //
  // The code is spelled as a literal rather than imported from
  // `poolMigrationGate`, whose module graph pulls in `@azure/cosmos` for the
  // settle-marker read — a runtime dependency this pure, Cosmos-free
  // derivation should not acquire for one string. `POOL_MIGRATING_LABEL_CODE`
  // remains the named authority and a pin in persistedPricingLabels.test.ts
  // asserts the two never drift.
  if (v.poolMigrating && v.fairMarketValue !== null) {
    const age = typeof v.poolMigrating.ageHours === "number"
      ? `${v.poolMigrating.ageHours.toFixed(1)}h ago`
      : "recently";
    labels.push({
      code: "pool-migrating",
      text:
        `Pool still filling: this card's identity was created ${age} and its own sales ` +
        "are still being matched onto it, so this estimate comes from related cards. " +
        "A price from this card's own sales may follow shortly.",
    });
  }
  const comps = result.provenance?.comps ?? [];
  const own = comps.filter((c) => c.verifiedByUser === true).length;
  // The denominator is the engine's pool total, exactly as the sentence
  // states it. `comps` is truncated to 8 rows by the adapter, so counting
  // it here would understate a deep pool's denominator and disagree with
  // the label text sitting beside it.
  const total = typeof result.provenance?.compCount === "number"
    ? Math.max(own, Math.floor(result.provenance.compCount))
    : comps.length;
  return { labels, selfAnchored: own > 0 ? { own, total } : null };
}

/**
 * The same labels, for the LEGACY unified write sites.
 *
 * portfolioStore's pre-D17 exact-pool writers (autoPriceHolding's early
 * exit, its supremacy gate, and the batch reprice's two) hold a
 * `UnifiedPriceResult` rather than a Valuation. They run only when the
 * catalog cannot name the holding's identity — the one-entry path decides
 * first — but they DO persist prices, and a price persisted there must
 * carry its caveats too or the gap simply moves.
 *
 * Rather than a second implementation, this lifts the tier the write is
 * about into the minimal Valuation the derivation reads (`sales`,
 * `ownerUserId`, `rungLabel`, `confidence`, `compsUsed`) and hands it to
 * the one function above. Fields the label rules never touch are left at
 * their empty values; `toCanonicalFmvResponse` reads only what is set here.
 */
export function persistedLabelsForUnifiedTier(input: {
  /** The tier's sales, carrying each row's contributor. */
  sales: ReadonlyArray<{ price: number; soldAt: string; source: string | null; contributorUserId: string | null }> | undefined;
  /** The tier's pool size — the denominator the ratio is stated against. */
  compsUsed: number;
  rungLabel: string;
  confidence: number;
  /** The owner this write is for. Null → nothing can be "yours". */
  ownerUserId: string | null;
}): PersistedPricingLabels {
  const v = {
    fairMarketValue: null,
    rungLabel: input.rungLabel,
    valueSource: "observed",
    reason: null,
    compsUsed: input.compsUsed,
    confidence: input.confidence,
    basis: "",
    identity: { parallel: null, setKey: null },
    requestedTier: "",
    windowDays: null,
    trend: { direction: "flat", pctPerWeek: null },
    predictedPrice: null,
    weightedMedian: null,
    sales: input.sales ?? [],
    ownerUserId: input.ownerUserId,
    gradeCurve: [],
    totalSampleCount: input.compsUsed,
    unified: null,
    fallback: null,
    computedAt: "",
  } as unknown as Valuation;
  return persistedLabelsForValuation(v);
}

/**
 * The labels for a `UnifiedPriceResult`'s REQUESTED tier.
 *
 * The tier matters: `u.gradeCurve` holds every grade the pool has, and the
 * self-anchored ratio is a statement about the sales behind THIS number.
 * A PSA 10 priced from the owner's only PSA 10 sale is self-anchored even
 * when the raw tier has forty independent sales — #1662's reprieve is
 * per-tier for exactly that reason, and the label must be too.
 *
 * `tierLabel` is the engine's own form ("PSA 10", "Raw"). A tier the curve
 * does not hold yields no labels rather than borrowing another tier's.
 */
export function persistedLabelsForUnifiedResult(
  u: {
    gradeCurve: ReadonlyArray<{
      grade: string;
      sampleCount: number;
      rungLabel?: string;
      confidence: number;
      sales?: Array<{ price: number; soldAt: string; source: string | null; contributorUserId: string | null }>;
    }>;
    rungLabel: string;
    confidence: number;
    totalSampleCount: number;
  },
  tierLabel: string,
  ownerUserId: string | null,
): PersistedPricingLabels {
  const tier = u.gradeCurve.find((e) => e.grade === tierLabel) ?? null;
  return persistedLabelsForUnifiedTier({
    sales: tier?.sales,
    compsUsed: tier?.sampleCount ?? u.totalSampleCount,
    rungLabel: u.rungLabel,
    confidence: u.confidence,
    ownerUserId,
  });
}
