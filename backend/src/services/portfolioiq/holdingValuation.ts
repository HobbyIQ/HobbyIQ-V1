/**
 * CF-ONE-VALUATION-PATH (D17, 2026-08-30). The portfolio persist site prices
 * a holding through the ONE valuation entry — the same call the card page
 * answers from — so the number persisted on a holding IS the number every
 * pricing route serves for that holding's slug + grade. A holding priced at
 * $182.50 shows $182.50 on its card page, because both are one computation.
 *
 * Before D17 portfolioStore priced the exact pool three ways of its own:
 * the grade-curve tile rung (the legacy curve build on the majority vendor
 * cardId), the unified early exit (priceHoldingFromExactPool), and the
 * supremacy gate's re-price (priceHoldingFromExactPool again). Each read the
 * same pool through a different engine call, and the unified engine's
 * cross-grade rescale — another grade's pool × getGraderPremium's hardcoded
 * tables, rung `cross-grade-fallback` — could be persisted as "observed".
 *
 * This module is the persist site's adapter over the entry. It decides
 * nothing about the price; it decides what a valuation BECOMES on a holding:
 *
 *   observed       an exact-pool rung: the unified write (fairMarketValue,
 *                  fmvRung, predictedPrice, the labels), valuationStatus
 *                  "observed" — the shape the early exits always wrote;
 *   estimated      `grade-curve-estimate`: this identity's other tiers × the
 *                  empirical ratio — persisted as an ESTIMATE (isEstimate,
 *                  valuationStatus "estimated", the rung named), never as an
 *                  observed number; the seam that replaces cross-grade-
 *                  fallback (D4 PR 6's tables are not consulted);
 *   cost-basis-floor  the entry's number failed CF-COST-BASIS-SANITY-FLOOR
 *                  (< 15% of a > $50 cost basis is a slug mismatch, not a
 *                  market). The outcome carries no holding because the
 *                  DECISION is the caller's — but the caller must persist
 *                  that decision, never fall through silently: see
 *                  `costBasisFloorRefusalWrite` below and
 *                  CF-A-REFUSED-PRICE-IS-STILL-A-DECISION (2026-09-04), which
 *                  is the defect this comment used to describe as intended
 *                  behaviour ("nothing written, the caller falls through");
 *   unresolved     the catalog holds no identity for the holding (no slug
 *                  on a catalog row, a vendor id no slug maps to) — the
 *                  entry declines; the caller's legacy chain is the only
 *                  path, exactly as before D17;
 *   unpriced       the identity resolved but the entry has no exact-pool
 *                  number for the tier (the gated ladder's answer, if any,
 *                  is a cross-identity estimate and belongs to the caller's
 *                  gated estimate sites) — the caller's exact-pool re-reads
 *                  must NOT run: they could only produce the number the
 *                  entry declined to.
 *
 * Kept from #1462 / D4 PR 5: the identity order (slug alone, its twin, then
 * cardId ∪ slug — the entry takes `cardId`), the ≥ 1 sale rule, the
 * cost-basis floor, the fmvRung / pricingSource / pricingSourceMeta stamps
 * (every write that sets fairMarketValue sets fmvRung in the same literal).
 */
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { valueIdentity, type Valuation } from "../compiq/oneValuationPath.service.js";
import { isExactPoolRung, isPricingRung } from "../compiq/fmvRung.js";
import { identityBackingOf, mayPublishPrice, NO_CHECKLIST_MATCH } from "../catalog/identityBacking.js";
import { persistedLabelsForValuation } from "../compiq/valuationLabels.js";
import { writeHoldingValuation } from "./writeHoldingValuation.js";

export type HoldingValuationOutcome =
  | { outcome: "observed"; holding: PortfolioHolding; valuation: Valuation }
  | { outcome: "estimated"; holding: PortfolioHolding; valuation: Valuation }
  | { outcome: "cost-basis-floor"; valuation: Valuation; costBasis: number; proposedTotal: number }
  /**
   * CF-A-STALE-VALUE-IS-NOT-A-PRICE (Drew, 2026-09-04). The engine declined
   * for a reason that must be PERSISTED as a refusal rather than fallen
   * through: the catalog holds no identity for this holding, or the
   * identity's pool is still migrating, or the only catalog row for it is one
   * we minted from our own data. Distinguished from `unresolved` —
   * which lets the caller's legacy chain run — precisely because these two
   * must NOT be replaced by another lane's number. The caller writes the
   * refusal via `noBasisRefusalWrite` and stops.
   */
  | { outcome: "no-basis-refusal"; reason: NoBasisRefusalReason; valuation: Valuation | null }
  | { outcome: "unresolved"; valuation: Valuation | null }
  | { outcome: "unpriced"; valuation: Valuation };

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** The holding's grade for the entry: `{ company, value }`, or null for Raw. */
export function holdingGrade(holding: PortfolioHolding): { company: string; value: number | null } | null {
  const company = String((holding as { gradeCompany?: unknown }).gradeCompany ?? "").trim();
  if (!company) return null;
  const raw = (holding as { gradeValue?: unknown }).gradeValue;
  const value = typeof raw === "number" ? raw : (raw ? Number(raw) : null);
  return { company, value: value !== null && Number.isFinite(value) ? value : null };
}

/** The identities the entry is asked for: the slug as `id`, the cardId as
 *  the second identity. Null when the holding names none. */
export function holdingValuationIds(holding: PortfolioHolding): { id: string; cardId: string | null } | null {
  const slug = String((holding as { hobbyiqCardId?: unknown }).hobbyiqCardId ?? "").trim();
  const cardId = String(holding.cardId ?? "").trim();
  if (slug.startsWith("hiq:")) return { id: slug, cardId: cardId && cardId !== slug ? cardId : null };
  if (cardId) return { id: cardId, cardId: null };
  return null;
}

/**
 * CF-COST-BASIS-SANITY-FLOOR: a price under 15% of the cost basis is a slug
 * mismatch, not a market.
 *
 * CF-THE-FLOOR-IS-A-RATIO-NOT-A-DOLLAR-AMOUNT (Drew, 2026-09-04). The floor
 * used to read `costBasis > 50 && proposedTotal / costBasis < 0.15` — two
 * gates, of which only the second is the doctrine. The dollar gate was never
 * a statement about evidence; it was a guess that a small basis is not worth
 * defending, and it let the exact defect the floor exists to catch through
 * whenever the basis happened to be under fifty dollars.
 *
 * Measured in the 2026-09-04 audit of Drew's holdings: a raw 1997 Metal
 * Universe Chipper Jones #31 on a $29.45 basis published $2.00 — a 93%
 * haircut — UNREFUSED, because $29.45 is not > $50. The number came from a
 * weighted median on n=3 that mixed a PSA 9 at $40 (see the tier leak below),
 * the owner's own $20 raw sale, and three $2-$5 commons. A 93% haircut is the
 * same evidence failure at $29.45 as at $2,945; the basis size does not make
 * the pool any less contaminated, and a $29.45 holding is exactly the row a
 * user is least likely to notice going wrong.
 *
 * So the gate is the RATIO alone, at any basis. `costBasis > 0` remains — not
 * as a threshold but because a ratio against a zero or absent basis is not a
 * number, and a holding with no basis recorded makes no claim for the floor to
 * check. `proposedTotal > 0` likewise: a zero proposal is refused by the
 * unpriced path, never by the floor.
 */
export const COST_BASIS_FLOOR_RATIO = 0.15;

export function costBasisFloor(holding: PortfolioHolding, proposedUnit: number): { rejects: boolean; costBasis: number; proposedTotal: number } {
  const qty = Math.max(1, num(holding.quantity, 1));
  const costBasis = num(holding.totalCostBasis, num(holding.purchasePrice, 0) * qty);
  const proposedTotal = proposedUnit * qty;
  return {
    rejects: costBasis > 0 && proposedTotal > 0 && proposedTotal / costBasis < COST_BASIS_FLOOR_RATIO,
    costBasis,
    proposedTotal,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * CF-A-REFUSED-PRICE-IS-STILL-A-DECISION (2026-09-04).
 *
 * `cost-basis-floor` was the one outcome of the one valuation path that
 * produced NO holding. The doctrine block at the top of this file said so in
 * as many words — "nothing written, the caller falls through" — and the
 * fall-through is precisely how a bare number with no `pricingSourceMeta`
 * reached prod, the shape #1674 and C-7 were both written to abolish.
 *
 * Measured read-only after the sanctioned reprice (run 33893507773, user
 * user-199fcbc9): 41 of 43 holdings carry a `pricingSourceMeta.method` and
 * TWO do not. Both took this branch in that run, and they are the only two:
 *
 *   9f082213  Victor Figueroa CPA-VF Black & White Red Ink auto, raw, on a
 *             $278.60 basis. The ladder returned $8.70 under
 *             `exact-pool-projection`; the floor rejected it at 3.1% of
 *             basis. The row fell through to the confidence-gated retention
 *             branch, which re-stated the prior pass's pre-C-7 meta —
 *             `{slug, compsUsed: 1}`, no method, no confidence, no labels —
 *             and stamped a fresh `lastUpdated`. Live: fairMarketValue 11,
 *             fmvRung null, method undefined.
 *   277b05a3  Cal Ripken Jr. 1997 Metal Universe #8 PSA 8, $52.98 basis,
 *             proposed $5.40 under `exact-pool-weighted-median`. Identical
 *             shape, meta `{compsUsed: 50}`.
 *
 * The floor was RIGHT both times. 9f082213's slug pool holds 57 rows of which
 * exactly ONE ($270) is a Black & White Red Ink sale; the other 56 are plain
 * base Chrome prospect autos at $5-$20 mis-slugged onto the SSP row. Per
 * Drew's 2026-08-30 ruling the Red Ink is a distinct card with its own row,
 * and that row exists and is `user-verified` — it is the POOL that is
 * contaminated. $8.70 is the base auto's price, not this card's.
 *
 * So this helper does not second-guess the floor. It makes the refusal
 * VISIBLE:
 *
 *   - the number is KEPT. The floor's claim is that the NEW number is wrong,
 *     never that the old one is; erasing a value the floor said nothing about
 *     would be a second, unrelated decision.
 *   - `pricingSourceMeta.method` becomes `"withheld"` with reason
 *     `cost-basis-floor`, so the invariant auditor sees a stated refusal
 *     rather than a row that reads as never written.
 *   - the refused number is preserved as evidence under `withheld.proposed`
 *     rather than discarded (CF-A-WITHHOLD-DOES-NOT-DESTROY-EVIDENCE).
 *   - no confidence is invented: this branch priced nothing, so it carries
 *     the prior pass's confidence when there was one and an explicit `null`
 *     when there was not.
 *
 * Shared by EVERY cost-basis-floor refusal, so no two can drift.
 *
 * CF-ONE-FLOOR-ONE-WRITE (2026-09-04, follow-up). #1754 routed the two
 * one-entry lanes here and left a THIRD floor standing: the our-pool lane of
 * `repriceHoldingsForUser` (`our_pool_reprice_rejected_cost_basis_floor`),
 * which logged `keepingPrior: true`, wrote nothing, and fell through — the
 * identical defect under a different event name. That lane holds no
 * `Valuation`; it holds an `OurPoolPricingResult`. So the input is the narrow
 * facts a refusal actually needs — the rung refused, what it proposed, the
 * pool it read, the basis it failed against — and the one-entry outcome is
 * accepted as-is and normalized to them. A second implementation of this
 * write is the thing being prevented; a second SHAPE of caller is not.
 */

/** The facts a refusal needs, independent of which lane produced the price. */
export interface CostBasisFloorRefusalFacts {
  /** The rung that produced the refused number, in the closed vocabulary. */
  rungLabel: string;
  /** The refused number, per unit — kept as evidence, never published. */
  proposedUnit: number | null;
  /** The refused number × quantity, as compared against the basis. */
  proposedTotal: number;
  /** The cost basis it was compared against. */
  costBasis: number;
  /** The pool that produced it, for `withheld.blockingId`. */
  pooledAs: string | null;
  /** That pool's size, for `withheld.blockingCount`. */
  compsUsed: number;
}

function refusalFacts(
  entry: Extract<HoldingValuationOutcome, { outcome: "cost-basis-floor" }> | CostBasisFloorRefusalFacts,
): CostBasisFloorRefusalFacts {
  if (!("outcome" in entry)) return entry;
  return {
    rungLabel: entry.valuation.rungLabel,
    proposedUnit: entry.valuation.fairMarketValue ?? null,
    proposedTotal: entry.proposedTotal,
    costBasis: entry.costBasis,
    pooledAs: entry.valuation.identity.pooledAs ?? entry.valuation.identity.slug ?? null,
    compsUsed: entry.valuation.compsUsed ?? 0,
  };
}

/**
 * CF-A-WITHHELD-PRICE-NEVER-RETAINS-THE-NUMBER-IT-REFUSED (Drew, 2026-09-04).
 *
 * The refusal write above was built on one sentence — "the floor's claim is
 * that the NEW number is wrong, never that the old one is" — and that sentence
 * is true only when the old number is a DIFFERENT claim. Measured read-only on
 * Drew's portfolio after the #1776 reprice, it was not, on two of the three
 * rows the floor touched:
 *
 *   69eab153  Chipper Jones 1997 Metal Universe #31, raw, $29.45 basis. The
 *             floor refused $2.00 out of `exact-pool-weighted-median` on the
 *             contaminated n=3 pool — and the value RETAINED was $2.00, the
 *             number the PRE-#1776 engine had published from that same pool on
 *             an earlier pass. The refusal kept the number it refused. Worse,
 *             the retention carried the prior stamps forward verbatim:
 *             `valueSource: "observed"`, `fmvRung:
 *             "exact-pool-weighted-median"`, `pricingSourceMeta.method:
 *             "exact-pool-weighted-median"`, labels `["self-anchored"]`. To
 *             every reader — the web's `holdingProvenance()`, the report's
 *             `classifyProvenance()` (an exact-pool rung in the observed slot
 *             IS the `observed` class), the invariant auditor — that row reads
 *             as a CURRENT OBSERVED MARKET PRICE of $2.00. The `withheld` block
 *             sat beside it saying the opposite.
 *
 *   9f082213  Victor Figueroa CPA-VF Black & White Red Ink auto, $278.60 basis.
 *             The floor refused $8.68 off a 56-row pool; the retained $11 is
 *             3.9% of basis — itself a floor-failing publish from an earlier
 *             pass of the same contaminated pool. Refusing 3.1% and publishing
 *             3.9% is not a decision, it is the same number twice.
 *
 * Only 277b05a3 (Ripken, $49.99 kept against a $52.98 basis — 94.4%, from a
 * genuine 41-comp `exact-pool-weighted-median` read of a DIFFERENT, uncontested
 * pool on 2026-09-03) was a legitimate retention, and it is legitimate for
 * exactly the two reasons this function now checks.
 *
 * THE RULE. A refusal may retain a prior value only when that value is a claim
 * the refusal does not itself contradict. Two conditions, both required:
 *
 *   1. THE KEPT VALUE MUST ITSELF PASS THE FLOOR. Judged by the same
 *      `costBasisFloor` predicate against the same basis. A retained number
 *      below 15% of basis is the very shape the floor exists to refuse; keeping
 *      it because it arrived earlier is a statement that the floor applies to
 *      new numbers only, which is not the doctrine.
 *   2. THE KEPT VALUE MUST NOT BE THE REFUSED POOL'S OWN PRIOR PUBLISH. When
 *      the prior pass read the SAME pool (its meta's slug is the pool the floor
 *      just blocked) under an exact-pool rung, its number is the same evidence
 *      that just failed, one pass older. The floor's fault is with the POOL;
 *      a number drawn from that pool does not become sound by being stale.
 *
 * When either fails, NOTHING is retained as a price. `fairMarketValue` is
 * null, `estimatedValue` is cleared with it — leaving a stale estimate behind
 * would just move the same lie one field over, and `computeDisplayValue`
 * reads it before falling through — and the row falls to the cost-basis path
 * the engine already has for a holding with no publishable value:
 * `computeDisplayValue` returns `computeCostBasisTotal`, and the report's
 * `classifyProvenance` renders it `own-purchase` ("OWN PURCHASE — NOT A MARKET
 * VALUE"). No number is invented here; the display layer's existing cost proxy
 * is what a row with no defensible market value has always fallen to.
 *
 * AND THE STAMPS ARE ALWAYS REWRITTEN. `method`, `valueSource` and `fmvRung`
 * are rewritten on EVERY withheld write, retention or not — never carried from
 * the prior pass. That carry is the same defect #1776 fixed on the
 * confidence-gated branch, resurfacing here: a stamp that describes a
 * computation this pass did not perform. `method` is `"withheld"` (the
 * `withheld` block guarantees it in `writeHoldingValuation`), `fmvRung` is null
 * with the refusal prose as its stated reason, and `valueSource` is
 * `"estimated"` — never `"observed"`, because a withhold observed nothing.
 * A retained number's own history is not lost: `withheld.retainedRung` records
 * the rung it was priced under, as evidence rather than as a live claim.
 */

/** Why a prior value could not be retained, or the value that stood. */
export type RetentionVerdict =
  | { retained: true; value: number }
  | { retained: false; because: "no-prior-value" | "prior-fails-floor" | "prior-is-the-refused-pool" };

/**
 * Whether the prior value on a holding may stand through a refusal.
 *
 * CF-ONE-RETENTION-RULE (2026-09-05). The rule is stated once and every
 * refusal branch asks it — the floor, and now the no-basis refusals. It needs
 * exactly two things from the caller: the holding (for its prior value, its
 * basis and its prior stamps) and THE POOL THE REFUSAL FAULTS. It takes
 * `{ pooledAs }` rather than the floor's full `CostBasisFloorRefusalFacts`
 * precisely so the no-basis lane can ask it without inventing a proposed
 * number and a basis it never computed. `CostBasisFloorRefusalFacts` is
 * structurally assignable to it, so the floor's call is unchanged.
 *
 * Both conditions are meaningful on BOTH branches, though the second does the
 * work on the no-basis side. A `pool-migrating` refusal faults a pool that is
 * still arriving; a prior number this identity's own exact-pool read produced
 * from that same partial pool is the same partial evidence one pass older, and
 * that is the $240 Maddux exactly. Condition 1 still applies because a prior
 * number below 15% of basis is a shape the engine refuses whatever the branch.
 *
 * Exported so the pins can exercise the rule directly rather than only
 * through the persisted row.
 */
export function retentionThroughFloor(
  holding: PortfolioHolding,
  entry: { pooledAs: string | null },
): RetentionVerdict {
  const prior = typeof holding.fairMarketValue === "number" && Number.isFinite(holding.fairMarketValue)
    && holding.fairMarketValue > 0
    ? holding.fairMarketValue
    : null;
  if (prior === null) return { retained: false, because: "no-prior-value" };

  // 1. The kept number faces the SAME floor, against the SAME basis. Not a
  //    second predicate — `costBasisFloor` itself, so the two cannot drift.
  if (costBasisFloor(holding, prior).rejects) {
    return { retained: false, because: "prior-fails-floor" };
  }

  // 2. The kept number must not be the refused pool's own earlier answer.
  const priorMeta = (holding as { pricingSourceMeta?: Record<string, unknown> }).pricingSourceMeta;
  const priorSlug = typeof priorMeta?.slug === "string" ? (priorMeta.slug as string).trim() : "";
  const priorRung = typeof (holding as { fmvRung?: unknown }).fmvRung === "string"
    ? ((holding as { fmvRung: string }).fmvRung)
    : null;
  const priorMethod = typeof priorMeta?.method === "string" ? (priorMeta.method as string) : null;
  const refusedPool = (entry.pooledAs ?? "").trim();
  const samePool = refusedPool !== "" && priorSlug !== "" && priorSlug === refusedPool;
  // An exact-pool rung is a read OF the pool. A cross-identity rung (a sibling,
  // a family baseline, a vendor) reached a different body of evidence even when
  // the row is filed under this slug, so the floor's verdict on this pool says
  // nothing about it.
  const readTheSamePool = isExactPoolRung(priorRung) || isExactPoolRung(priorMethod);
  if (samePool && readTheSamePool) {
    return { retained: false, because: "prior-is-the-refused-pool" };
  }
  return { retained: true, value: prior };
}

export function costBasisFloorRefusalWrite(
  holding: PortfolioHolding,
  input: Extract<HoldingValuationOutcome, { outcome: "cost-basis-floor" }> | CostBasisFloorRefusalFacts,
  nowIso: string,
): { holding: PortfolioHolding; prose: string; summary: string } {
  const entry = refusalFacts(input);
  const verdict = retentionThroughFloor(holding, entry);
  const kept = verdict.retained ? verdict.value : null;
  const priorMeta = (holding as { pricingSourceMeta?: Record<string, unknown> }).pricingSourceMeta;
  const priorRung = typeof (holding as { fmvRung?: unknown }).fmvRung === "string"
    && (holding as { fmvRung?: string }).fmvRung
    ? ((holding as { fmvRung: string }).fmvRung)
    : null;
  const priorFmv = typeof holding.fairMarketValue === "number" && Number.isFinite(holding.fairMarketValue)
    ? holding.fairMarketValue
    : null;
  const qty = Math.max(1, num(holding.quantity, 1));
  const pct = entry.costBasis > 0 ? round2((entry.proposedTotal / entry.costBasis) * 100) : null;
  const keptPct = kept !== null && entry.costBasis > 0
    ? round2(((kept * qty) / entry.costBasis) * 100)
    : null;
  const summary =
    `proposed $${round2(entry.proposedTotal)} is ${pct}% of a $${round2(entry.costBasis)} basis `
    + `(rung=${entry.rungLabel}); ${verdict.retained
      ? `prior $${round2(kept as number)} retained (${keptPct}% of basis)`
      : `nothing retained (${verdict.because})`}`;
  const refusal =
    `price refused by the cost-basis sanity floor: the valuation path returned `
    + `$${round2(entry.proposedTotal)} under rung ${entry.rungLabel}, ${pct}% of a `
    + `$${round2(entry.costBasis)} cost basis (floor: `
    + `${round2(COST_BASIS_FLOOR_RATIO * 100)}%). A price this far under basis is a pool or `
    + `identity mismatch, not a market.`;
  // The retention clause states which of the two rules decided, in the row's
  // own prose, so "why is there no value here" is answerable off the document.
  const retention = verdict.retained
    ? ` The prior value of $${round2(kept as number)} (${keptPct}% of basis) is kept: it passes the`
      + ` same floor and was not drawn from the pool that was refused.`
    : verdict.because === "no-prior-value"
      ? ` No prior value was on the row, so none is retained; the holding falls to its cost basis.`
      : verdict.because === "prior-fails-floor"
        ? ` The prior value of $${round2(priorFmv ?? 0)} is NOT retained: it is itself below the`
          + ` floor against this basis, so retaining it would publish the very shape the floor`
          + ` refuses. The holding falls to its cost basis until a defensible price exists.`
        : ` The prior value of $${round2(priorFmv ?? 0)} is NOT retained: it was published from`
          + ` ${entry.pooledAs ?? "this same pool"} — the pool this refusal faults — so it is the`
          + ` same evidence one pass older, not an independent claim. The holding falls to its`
          + ` cost basis until a defensible price exists.`;
  const prose = refusal + retention;
  return {
    prose,
    summary,
    holding: writeHoldingValuation(holding, {
      fairMarketValue: kept,
      // ALWAYS rewritten, never carried. A withhold priced nothing, so it names
      // no rung — carrying the prior pass's rung is a claim that this row's
      // number was produced by a computation this pass did not perform, which
      // is the defect #1776 fixed on the confidence-gated branch and this one
      // reproduced. The rung a retained number WAS priced under survives as
      // evidence under `withheld.retainedRung`.
      rung: { noRung: prose },
      // ALWAYS rewritten. A withhold observed nothing, so it cannot stand
      // behind an "observed" claim — least of all one it inherited from the
      // very pool it just refused.
      valueSource: "estimated",
      nowIso,
      meta: {
        slug: typeof priorMeta?.slug === "string"
          ? (priorMeta.slug as string)
          : (entry.pooledAs ?? null),
        compsUsed: typeof priorMeta?.compsUsed === "number" ? (priorMeta.compsUsed as number) : null,
        confidence: typeof priorMeta?.confidence === "number" && Number.isFinite(priorMeta.confidence as number)
          ? (priorMeta.confidence as number)
          : null,
        ...(Array.isArray(priorMeta?.labels) ? { labels: priorMeta.labels as never } : {}),
        withheld: {
          reason: "cost-basis-floor",
          blockingId: entry.pooledAs,
          blockingCount: entry.compsUsed,
          proposed: entry.proposedUnit,
          // What the row now carries, and why — so the UI can say "market
          // shows $2, withheld: below 15% of your $29.45 basis" and a reader
          // can tell a legitimate retention from a dropped one.
          retained: kept,
          retentionRefused: verdict.retained ? null : verdict.because,
          // The rung the retained number was priced under, kept as EVIDENCE.
          // It is deliberately not `fmvRung`: it describes history, not the
          // claim this write is making.
          retainedRung: verdict.retained ? priorRung : null,
        },
      },
      fields: {
        // Recorded ON THE ROW, so "why is this stamped now and unchanged" is
        // answerable without reading a log that has rolled.
        fmvRetainedReason: prose,
        fmvRetainedAt: nowIso,
        // When nothing is retained, the estimate slot is cleared with it.
        // `computeDisplayValue` reads `estimatedValue` BEFORE falling through
        // to cost basis, so leaving a stale estimate standing would move the
        // same undefended number one field over and defeat the withhold.
        ...(kept === null
          ? { estimatedValue: null, isEstimate: false, valuationStatus: "pending" as const }
          : {}),
      },
    }),
  };
}


/**
 * CF-A-STALE-VALUE-IS-NOT-A-PRICE (Drew, 2026-09-04).
 *
 * The cost-basis floor was not the only refusal that wrote nothing. Two more
 * reach a holding and leave it carrying a bare number with a stale method:
 *
 *   identity-not-in-catalog   No slug, no pool, nothing to price. NOTE that
 *                             `valueHoldingThroughOneEntry` does NOT return
 *                             this outcome for that reason — it falls through
 *                             as `unresolved`, per
 *                             CF-LEGACY-SURVIVES-FOR-UNNAMEABLE-IDENTITIES,
 *                             because a slug the catalog cannot name but which
 *                             HAS sales is legitimately priced by the legacy
 *                             exact-pool read. So this branch is reached only
 *                             by a caller that has already exhausted that
 *                             chain. (The Bellingham Griffey cited here in the
 *                             2026-09-04 audit was, on inspection, NOT this
 *                             writer's row: its $1,850 is a legitimate legacy
 *                             publish carrying a withheld block a previous
 *                             pass left behind — see
 *                             CF-A-HOLDING-CARRIES-ONE-STAMP in
 *                             writeHoldingValuation.ts, which clears it.)
 *   pool-migrating            The identity resolved, but its sales are still
 *                             being re-keyed onto it. The number the engine
 *                             would produce is a partial-pool number, so it
 *                             produces none.
 *
 * Both are the SAME shape as the floor: the engine declined, the prior number
 * is not thereby wrong, and the row must SAY that no new price was published.
 * So they share the floor's contract rather than inventing a second one —
 *
 *   - the prior number may be kept — RULED by `retentionThroughFloor`, the
 *     shared rule, not kept unconditionally: see
 *     CF-A-HOLDING-CARRIES-ONE-STAMP below, which corrects the sentence this
 *     bullet used to make ("the prior number is KEPT; a refusal faults the new
 *     number, never the old") on the same grounds #1781 corrected it on the
 *     floor branch — an old number drawn from the very evidence being refused
 *     is not a different claim;
 *   - `pricingSourceMeta.method` is `"withheld"` with the machine-readable
 *     reason, so the invariant auditor sees a stated refusal instead of a row
 *     that reads as never written;
 *   - no confidence is invented: the prior pass's, or an explicit null;
 *   - the kept value is LABELLED — `fmvRetainedReason` / `fmvRetainedAt` on
 *     the row, so "why is this stamped now and unchanged" is answerable
 *     without a log that has rolled.
 *
 * It differs from the floor in one respect only: there is no refused number to
 * preserve, because nothing was computed. `withheld.proposed` is null and says
 * so, rather than borrowing a number from somewhere else.
 *
 * CF-A-HOLDING-CARRIES-ONE-STAMP (Drew, 2026-09-05).
 *
 * "Shares the floor's contract" was true of the withheld BLOCK and false of
 * everything around it. Two clauses above — "the prior number is KEPT"
 * unconditionally, and a rung carried forward from the prior pass — are the
 * two clauses #1781 removed from the floor branch, still standing here on a
 * different branch of the same function file. The result is a row that makes
 * two incompatible claims at once:
 *
 *     fairMarketValue   1850
 *     fmvRung           "exact-pool-last-sale"      <- a PUBLISHED stamp
 *     valueSource       "observed"                  <-
 *     pricingSourceMeta.method "exact-pool-last-sale"
 *     pricingSourceMeta.withheld { reason: "identity-not-in-catalog" }
 *                                                   <- a WITHHELD stamp
 *
 * Every reader that prefers `method` (the web's `holdingProvenance`, the
 * report's `classifyProvenance`) reads that as a current observed exact-pool
 * price; the auditor reading `withheld` reads a refusal. A row must carry
 * EXACTLY ONE of {published stamp, withheld stamp}. So this write now does
 * what the floor write does, through the same two functions rather than a
 * second copy of them:
 *
 *   THE STAMPS ARE ALWAYS REWRITTEN. `rung` is `{ noRung: prose }` — a
 *   withhold priced nothing and so names no rung, and `writeHoldingValuation`
 *   turns that into `fmvRung: null` with the refusal prose as
 *   `fmvRungAbsentReason` and `method: "withheld"`. `valueSource` is
 *   `"estimated"`, never carried: a refusal observed nothing, least of all
 *   through a pool it just declined to read. The retained number's own history
 *   survives as EVIDENCE under `withheld.retainedRung`.
 *
 *   THE RETENTION IS RULED, NOT AUTOMATIC. `retentionThroughFloor` — #1781's
 *   rule, called, not copied. A prior value stands only when it passes the
 *   cost-basis floor and was not the refused identity's own exact-pool
 *   publish. On `pool-migrating` that second condition is the doctrine's whole
 *   point: a number this identity's exact pool produced while the pool was
 *   partial is the partial pool's own answer, and keeping it publishes exactly
 *   the number the gate exists to withhold. A cross-identity rung (a sibling,
 *   a family baseline, a vendor) reached different evidence and survives.
 *
 * When nothing is retained the row falls to the cost-basis path the engine
 * already has — `estimatedValue` is cleared with `fairMarketValue`, because
 * `computeDisplayValue` reads the estimate slot BEFORE falling through and a
 * stale estimate left standing just moves the same undefended number one field
 * over. No number is invented here.
 */
/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04, in those words) joins this union rather than opening a
 * refusal branch of its own.
 *
 * It is the SAME event these two already name: the engine will not publish a
 * number, the reason is about the IDENTITY rather than the market, and a
 * caller must persist the refusal instead of letting another lane substitute a
 * number. `identity-not-in-catalog` says the catalog holds no row; this says
 * it holds one we MINTED — from our own sales, or from one user's own import —
 * which is not a card, and a price may not rest on it.
 *
 * Sharing the branch is what makes it compose with #1781 and #1785 by
 * construction rather than by a second implementation remembering to: one
 * stamp, `retentionThroughFloor` asked once, method / valueSource / fmvRung
 * rewritten on every withheld write.
 */
export type NoBasisRefusalReason = "identity-not-in-catalog" | "pool-migrating" | "no-checklist-match";

export function noBasisRefusalWrite(
  holding: PortfolioHolding,
  reason: NoBasisRefusalReason,
  v: Valuation | null,
  nowIso: string,
): { holding: PortfolioHolding; prose: string; summary: string } {
  const priorMeta = (holding as { pricingSourceMeta?: Record<string, unknown> }).pricingSourceMeta;
  const priorRung = typeof (holding as { fmvRung?: unknown }).fmvRung === "string"
    && (holding as { fmvRung?: string }).fmvRung
    ? ((holding as { fmvRung: string }).fmvRung)
    : null;
  const priorFmv = typeof holding.fairMarketValue === "number" && Number.isFinite(holding.fairMarketValue)
    ? holding.fairMarketValue
    : null;
  const slug = v?.identity.pooledAs ?? v?.identity.slug ?? v?.identity.requestedId ?? null;
  // CF-ONE-RETENTION-RULE: #1781's rule, ASKED — not a second copy of it. The
  // pool this refusal faults is the identity it was asked about; when the
  // engine named none (identity-not-in-catalog with no slug at all), the
  // holding's own slug is the identity that could not be named, and a prior
  // exact-pool publish filed under it is that same unnameable identity's own
  // answer.
  const refusedPool = slug
    ?? (typeof (holding as { hobbyiqCardId?: unknown }).hobbyiqCardId === "string"
      ? ((holding as { hobbyiqCardId: string }).hobbyiqCardId).trim() || null
      : null);
  const verdict = retentionThroughFloor(holding, { pooledAs: refusedPool });
  const kept = verdict.retained ? verdict.value : null;
  const retentionClause = verdict.retained
    ? `prior $${round2(kept as number)} retained`
    : `nothing retained (${verdict.because})`;
  const summary = reason === "identity-not-in-catalog"
    ? `the catalog holds no identity for ${slug ?? "this holding"} — nothing to price; ${retentionClause}`
    : reason === "no-checklist-match"
      ? `${slug ?? "this identity"} is not checklist-backed — the only catalog row for it was minted`
        + ` from our own data; ${retentionClause}`
      : `${slug ?? "this identity"} is still having its sales re-keyed — the pool is incomplete`
        + `; ${retentionClause}`;
  const refusal = reason === "identity-not-in-catalog"
    ? `no price was published: the catalog holds no identity for this holding`
      + `${slug ? ` (${slug})` : ""}, so there is no pool to price it from.`
    : reason === "no-checklist-match"
    // CF-WE-DONT-WANT-SELF-DERIVED. The prose names the ACQUISITION as the
    // remedy, because that is the work that unblocks this row — a reader who
    // is told only "no price" goes looking at the pool, which is not where
    // the problem is.
    ? `no price was published: this card's identity is not one a real checklist confirms.`
      + ` The catalog's only row for it was minted from our own sales data or from an import,`
      + ` and HobbyIQ prices a card only from a checklist-backed identity. Pricing resumes once`
      + ` this product's checklist is acquired and the card is matched to it.`
    : `no price was published: this card's identity was created recently and its sales are still`
      + ` being re-keyed onto it, so the pool is a partial view. Pricing resumes once the re-key for`
      + ` this identity has settled. No fallback number is published in the meantime — a partial pool`
      + ` prices a card off whichever sales arrived first.`;
  // The retention clause states which of the two rules decided, in the row's
  // own prose, so "why is there no value here" is answerable off the document.
  const retention = verdict.retained
    ? ` The prior value of $${round2(kept as number)} is kept and labelled — it is a previous pass's`
      + ` number, not a current one, and it stands only because it passes the cost-basis floor and was`
      + ` not drawn from the identity this refusal faults.`
    : verdict.because === "no-prior-value"
      ? ` No prior value was on the row, so none is retained; the holding falls to its cost basis.`
      : verdict.because === "prior-fails-floor"
        ? ` The prior value of $${round2(priorFmv ?? 0)} is NOT retained: it is itself below the`
          + ` cost-basis floor, so retaining it would publish the very shape the floor refuses. The`
          + ` holding falls to its cost basis until a defensible price exists.`
        : ` The prior value of $${round2(priorFmv ?? 0)} is NOT retained: it was published from`
          + ` ${refusedPool ?? "this same identity"}'s own exact pool — the identity this refusal`
          + ` faults — so it is the same evidence one pass older, not an independent claim. The`
          + ` holding falls to its cost basis until a defensible price exists.`;
  const prose = refusal + retention;
  return {
    prose,
    summary,
    holding: writeHoldingValuation(holding, {
      fairMarketValue: kept,
      // ALWAYS rewritten, never carried. CF-A-HOLDING-CARRIES-ONE-STAMP: a
      // withhold priced nothing, so it names no rung. Carrying the prior
      // pass's rung is what let the Griffey row read as an observed
      // exact-pool price and a refusal simultaneously. The rung a retained
      // number WAS priced under survives as evidence under
      // `withheld.retainedRung`.
      rung: { noRung: prose },
      // ALWAYS rewritten. A refusal observed nothing, so it cannot stand
      // behind an "observed" claim inherited from a pass it did not repeat.
      valueSource: "estimated",
      nowIso,
      meta: {
        slug: typeof priorMeta?.slug === "string" ? (priorMeta.slug as string) : slug,
        compsUsed: typeof priorMeta?.compsUsed === "number" ? (priorMeta.compsUsed as number) : null,
        confidence: typeof priorMeta?.confidence === "number" && Number.isFinite(priorMeta.confidence as number)
          ? (priorMeta.confidence as number)
          : null,
        ...(Array.isArray(priorMeta?.labels) ? { labels: priorMeta.labels as never } : {}),
        withheld: {
          reason,
          blockingId: slug,
          blockingCount: v?.compsUsed ?? 0,
          // Nothing was computed, so there is no refused number. Null SAYS
          // that, rather than borrowing one from another pass.
          proposed: null,
          // What the row now carries, and why — the same three evidence
          // fields the floor branch writes, so a reader tells a legitimate
          // retention from a dropped one without re-deriving the rule.
          retained: kept,
          retentionRefused: verdict.retained ? null : verdict.because,
          retainedRung: verdict.retained ? priorRung : null,
        },
      },
      fields: {
        fmvRetainedReason: prose,
        fmvRetainedAt: nowIso,
        // When nothing is retained the estimate slot is cleared with it:
        // `computeDisplayValue` reads `estimatedValue` BEFORE falling through
        // to cost basis, so leaving a stale estimate standing would move the
        // same undefended number one field over and defeat the withhold.
        ...(kept === null
          ? { estimatedValue: null, isEstimate: false, valuationStatus: "pending" as const }
          : {}),
      },
    }),
  };
}


/** The observed write: the exact-pool rung on the holding, in the shape the
 *  unified early exits and the supremacy gate always wrote. */
export function observedHoldingWrite(holding: PortfolioHolding, v: Valuation, nowIso: string): PortfolioHolding {
  const fmv = v.fairMarketValue as number;
  // CF-ONE-PERSIST-HELPER (C-7): even the one-entry path — which always did
  // stamp both fields — goes through the single helper, so "every persisted
  // value names its source" is enforced by the type at EVERY site rather than
  // being true here by good behaviour and false at eleven others.
  return writeHoldingValuation(holding, {
    fairMarketValue: fmv,
    rung: { rung: v.rungLabel },
    // C-7: the kind of evidence, alongside the ladder step. Observed = real
    // comps in the exact pool; this is the branch that requires them.
    valueSource: "observed",
    nowIso,
    meta: {
      slug: v.identity.pooledAs ?? v.identity.slug ?? v.identity.requestedId,
      compsUsed: v.compsUsed,
      // CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03): the engine's own pricing
      // confidence, already 0..1 (observedGradeCurve.computeConfidence emits
      // that scale), passed through unscaled — the same quantity and the same
      // way the sibling lane in portfolioStore stamps `u.confidence`. NOT
      // scalePricingConfidence: that converts the LEGACY estimate path's
      // 0..100 `pricingConfidence`, and putting a 0..1 value through it would
      // report 0.23 as 0.0023 and fail resolvePricingConfidence's unit check.
      confidence: v.confidence,
      // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the same
      // label set the live canonical-fmv response carries for this holding,
      // derived through the same two functions (valuationLabels.ts). A
      // self-anchored $251 must SAY so on the portfolio row, not only to a
      // reader who thinks to open the card page.
      ...persistedLabelsForValuation(v),
    },
    fields: {
    predictedPrice: v.predictedPrice ?? fmv,
    predictedPriceLow: null,
    predictedPriceHigh: null,
    predictedPriceMechanism: "unified-trend",
    predictedPriceUpdatedAt: nowIso,
    movementDirection: v.trend.direction === "up" ? "up" : v.trend.direction === "down" ? "down" : null,
    movementUpdatedAt: nowIso,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: null,
    estimateBasis: `${v.basis} id=${v.identity.pooledVia ?? "hobbyiqCardId"}`,
    isEstimate: false,
    valuationStatus: "observed",
    pricingSource: "unified-pricing",
    nearestGradedAnchor: undefined,
    verdict: "Observed",
    recommendation: holding.recommendation ?? "Hold",
    sourceVendor: "hobbyiq-pool" as unknown as PortfolioHolding["sourceVendor"],
    sourceVendorUpdatedAt: nowIso,
    },
  });
}

/**
 * The estimate write: any rung that is not the exact pool of this identity
 * at this tier, persisted as an ESTIMATE under ITS OWN rung name.
 *
 * CF-THE-LADDER-IS-THE-VOCABULARY (Drew, 2026-09-04). This used to hardcode
 * `grade-curve-estimate` in both the acceptance test and the written literal,
 * so it could only ever persist the one rung it was named after. The rung is
 * now `v.rungLabel` — whatever the ladder actually returned — because the
 * persist layer decides what a valuation BECOMES on a holding, never whether
 * the ladder was allowed to reach the rung it reached. A `player-index-
 * projection`, a `sibling-parallel`, a `family-baseline` all persist here,
 * each saying which one it is.
 *
 * `predictedPriceMechanism` carries the rung for the same reason: it was the
 * literal "grade-curve-estimate" on every write, which would mislabel every
 * other rung's prediction as a grade-curve fill.
 */
export function fallbackRungHoldingWrite(holding: PortfolioHolding, v: Valuation, nowIso: string): PortfolioHolding {
  const fmv = round2(v.fairMarketValue as number);
  return writeHoldingValuation(holding, {
    fairMarketValue: fmv,
    rung: { rung: v.rungLabel },
    // C-7: derived from something other than comps of THIS identity at THIS
    // tier — another tier, another identity, a player index, a family
    // baseline — so it can never claim "observed", whichever rung it is.
    valueSource: "estimated",
    nowIso,
    meta: {
      slug: v.identity.pooledAs ?? v.identity.slug ?? v.identity.requestedId,
      compsUsed: v.compsUsed,
      // CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03): an estimate carries its
      // confidence too — a fallback rung is exactly the population whose
      // confidence a reader most needs, and withholding the number is what
      // left the sell window dark. Same 0..1 engine scale, passed through.
      confidence: v.confidence,
      // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS: an estimate carries its
      // labels too — a fallback rung says which one it is, and a self-
      // anchored one says whose sale it stands on (Drew's ruling: a
      // self-comp PUBLISHES and is LABELED). #1674's stamps ride here,
      // derived by the same function the wire response uses.
      ...persistedLabelsForValuation(v),
    },
    fields: {
    predictedPrice: v.predictedPrice ?? fmv,
    predictedPriceLow: null,
    predictedPriceHigh: null,
    predictedPriceMechanism: v.rungLabel,
    predictedPriceUpdatedAt: nowIso,
    movementDirection: null,
    movementUpdatedAt: nowIso,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: "rough",
    estimateBasis: v.basis,
    isEstimate: true,
    valuationStatus: "estimated",
    pricingSource: "unified-pricing",
    nearestGradedAnchor: undefined,
    verdict: "Estimated",
    recommendation: holding.recommendation ?? "Hold",
    sourceVendor: "hobbyiq-pool" as unknown as PortfolioHolding["sourceVendor"],
    sourceVendorUpdatedAt: nowIso,
    },
  });
}

/**
 * Value a holding through the one entry and say what the valuation becomes.
 * Never throws on the entry's own errors: an entry failure is `unresolved`
 * (logged) so the caller's legacy chain still runs, as it did before D17.
 */
export async function valueHoldingThroughOneEntry(
  holding: PortfolioHolding,
  opts: { userId?: string | null; caller: string; nowIso?: string },
): Promise<HoldingValuationOutcome> {
  const ids = holdingValuationIds(holding);
  if (!ids) return { outcome: "unresolved", valuation: null };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  let v: Valuation;
  try {
    const printRunRaw = (holding as { printRun?: unknown }).printRun;
    const printRun = num(printRunRaw, 0);
    v = await valueIdentity({
      id: ids.id,
      cardId: ids.cardId,
      grade: holdingGrade(holding),
      printRun: printRun > 0 ? printRun : null,
      playerName: typeof holding.playerName === "string" ? holding.playerName : null,
      excludeContributorUserId: opts.userId ?? null,
    });
  } catch (err) {
    console.warn(JSON.stringify({
      event: "one_valuation_path_holding_error",
      source: "holdingValuation.valueHoldingThroughOneEntry",
      site: opts.caller,
      holdingId: holding.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return { outcome: "unresolved", valuation: null };
  }
  // CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04). `pool-migrating`
  // must NOT fall through, and this is the one refusal of which that is true
  // unconditionally: the whole point of the gate is that no other lane may
  // substitute a number while the pool is partial. A substitute is exactly
  // the $240 Maddux — the grade curve reading a half-arrived tier ladder.
  //
  // (`identity-not-in-catalog` is deliberately NOT handled here. It reaches
  // the caller as `unresolved`, because CF-LEGACY-SURVIVES-FOR-UNNAMEABLE-
  // IDENTITIES — pinned in oneValuationPath.contract.test.ts — says a slug the
  // catalog cannot name but which HAS sales under it is still legitimately
  // priced by the legacy exact-pool read. Withholding there would blank real
  // prices computed from real sales. The stale-value defect it causes is
  // therefore fixed at the END of the caller's chain, where "the legacy read
  // found nothing either" is finally known: see the `legacy-unpriced` withhold
  // in portfolioStore.)
  if (v.reason === "pool-migrating") {
    console.warn(JSON.stringify({
      event: "one_valuation_path_no_basis_refusal",
      source: "holdingValuation.valueHoldingThroughOneEntry",
      site: opts.caller,
      holdingId: holding.id,
      reason: v.reason,
      slug: v.identity.slug,
      requestedId: v.identity.requestedId,
      keptValue: holding.fairMarketValue ?? null,
    }));
    return { outcome: "no-basis-refusal", reason: v.reason, valuation: v };
  }
  if (!v.identity.slug) return { outcome: "unresolved", valuation: v };

  // CF-THE-LADDER-IS-THE-VOCABULARY (Drew, 2026-09-04). The persist layer
  // accepts WHATEVER RUNG THE LADDER RETURNS. It is not a second opinion on
  // the ladder's decision; the ladder is the one valuation path, and this
  // module's only job is to say what a valuation BECOMES on a holding.
  //
  // What it used to say, and the outage that followed:
  //
  //     const observed  = priced && valueSource === "observed" && isExactPoolRung(rungLabel);
  //     const estimated = priced && valueSource === "estimated" && rungLabel === "grade-curve-estimate";
  //     if (!observed && !estimated) return { outcome: "unpriced", valuation: v };
  //
  // Two rungs by name. `player-index-projection` shipped in #1647 on
  // 2026-09-02; the ladder started returning it and this `if` started
  // throwing those valuations away. Holding 0a9afe09 (Cam Caminiti 2024
  // Bowman Draft CPA-CC Blue Refractor /150 auto, Raw) valued LIVE at
  // $215.17 — rung player-index-projection, confidence 0.39, basis
  // "Projected from Cam Caminiti's market trend — last direct sale 12 weeks
  // ago at $200.00, carried forward by the player index ratio 1.076x over a
  // basket of 46 liquid Raw cards" — and showed the owner NO PRICE, because
  // the persist gate had never heard of the rung. Every fallback rung the
  // ladder can reach (sibling-parallel, family-baseline, rare-card-anchor,
  // graded-pool-inverse, cross-setkey, product-tier …) failed identically
  // and silently, and every rung added after this one would have too.
  //
  // So there is no list here any more. A REFUSAL is only what the ENGINE
  // itself refuses: no value, or `no-basis` — its own name for "I could not
  // price this". Anything the engine priced under a rung its vocabulary
  // names, persists under that rung.
  const priced = v.fairMarketValue !== null && Number.isFinite(v.fairMarketValue) && v.fairMarketValue > 0;
  const pricingRung = isPricingRung(v.rungLabel);
  if (!priced || !pricingRung) {
    if (priced && !pricingRung) {
      // A finite price under a rung the vocabulary does NOT name. This should
      // be unreachable (the type union forbids it) and is therefore worth
      // saying out loud rather than silently dropping: it means an engine
      // invented a rung name at runtime, and the fix is in the vocabulary,
      // not here.
      console.warn(JSON.stringify({
        event: "one_valuation_path_rung_not_in_vocabulary",
        source: "holdingValuation.valueHoldingThroughOneEntry",
        site: opts.caller,
        holdingId: holding.id,
        rung: v.rungLabel,
        fair_market_value: v.fairMarketValue,
      }));
    }
    return { outcome: "unpriced", valuation: v };
  }
  // CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
  // (Drew, 2026-09-04), and it is the FIRST question asked of a priced
  // valuation, ahead of the cost-basis floor.
  //
  // Order matters, and this order is the ruling rather than a preference. The
  // floor asks "is this number plausible for what the owner paid"; this asks
  // "is there a card here at all". A number refused for BOTH reasons must be
  // refused for this one, because `cost-basis-floor` tells a reader to go
  // look at the pool while `no-checklist-match` tells them to go acquire a
  // checklist — and the second is what actually unblocks the row. Holding
  // 9f082213 (Victor Figueroa CPA-VF Black & White Red Ink) is exactly that
  // row: its identity is `user-verified`, its pool is contaminated, and the
  // cost-basis floor has been catching the symptom.
  //
  // The gate reads the identity the ladder ACTUALLY PRICED (`sourceOfRow`),
  // not the holding's stored slug. A holding whose slug is self-derived but
  // which the resolver moved onto a checklist twin prices normally, which is
  // the whole point of preferring a checklist row over minting.
  const backing = identityBackingOf(
    v.identity.slug,
    v.identity.sourceOfRow === null ? [] : [{ source: v.identity.sourceOfRow }],
  );
  if (!mayPublishPrice(backing)) {
    console.warn(JSON.stringify({
      event: "one_valuation_path_withheld_no_checklist_match",
      source: "holdingValuation.valueHoldingThroughOneEntry",
      site: opts.caller,
      userId: opts.userId ?? null,
      holdingId: holding.id,
      slug: v.identity.slug,
      pricedId: v.identity.pooledAs,
      identitySource: v.identity.sourceOfRow,
      backing,
      rung: v.rungLabel,
      // The refused number is REPORTED, never published — a withhold does not
      // destroy evidence (CF-A-WITHHOLD-DOES-NOT-DESTROY-EVIDENCE).
      proposed: v.fairMarketValue,
      compsUsed: v.compsUsed,
    }));
    // The SAME refusal outcome the other two identity refusals use, so this
    // rides #1785's one-stamp write and #1781's retention rule by
    // construction rather than by a parallel implementation remembering to.
    return { outcome: "no-basis-refusal", reason: NO_CHECKLIST_MATCH, valuation: v };
  }

  // "Observed" keeps its EXISTING meaning, unchanged: comps of this exact
  // identity at this exact tier. Everything else the ladder priced is an
  // estimate — which is a statement about the evidence, not a reason to
  // withhold the number.
  const observed = v.valueSource === "observed" && isExactPoolRung(v.rungLabel);

  const floor = costBasisFloor(holding, v.fairMarketValue as number);
  if (floor.rejects) {
    console.warn(JSON.stringify({
      event: "one_valuation_path_rejected_cost_basis_floor",
      source: "holdingValuation.valueHoldingThroughOneEntry",
      site: opts.caller,
      holdingId: holding.id,
      slug: v.identity.slug,
      pricedId: v.identity.pooledAs,
      rung: v.rungLabel,
      proposedTotal: floor.proposedTotal,
      costBasis: floor.costBasis,
    }));
    return { outcome: "cost-basis-floor", valuation: v, costBasis: floor.costBasis, proposedTotal: floor.proposedTotal };
  }
  console.log(JSON.stringify({
    event: observed ? "one_valuation_path_holding_priced" : "one_valuation_path_holding_estimated",
    source: "holdingValuation.valueHoldingThroughOneEntry",
    site: opts.caller,
    userId: opts.userId ?? null,
    holdingId: holding.id,
    slug: v.identity.slug,
    pricedId: v.identity.pooledAs,
    identityAttempt: v.identity.pooledVia,
    tier: v.requestedTier,
    fair_market_value: v.fairMarketValue,
    rung: v.rungLabel,
    compsUsed: v.compsUsed,
    window_days: v.windowDays,
    trend_direction: v.trend.direction,
    trend_pct_per_week: v.trend.pctPerWeek,
  }));
  return observed
    ? { outcome: "observed", holding: observedHoldingWrite(holding, v, nowIso), valuation: v }
    : { outcome: "estimated", holding: fallbackRungHoldingWrite(holding, v, nowIso), valuation: v };
}
