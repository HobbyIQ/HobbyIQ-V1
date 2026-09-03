/**
 * CF-ONE-PERSIST-HELPER (C-7, 2026-09-03).
 *
 * ONE way a value reaches a holding document.
 *
 * The problem this closes was not that a writer forgot a field. It is that
 * there were ELEVEN writers, each hand-assembling a ~25-field object literal,
 * and the pricing labels were a convention rather than a contract. #1674 added
 * `labels` to six of those literals; the sixth-and-a-half never got it, and
 * `valueSource` — the field that says whether a number is a market observation
 * or a derivation — reached NONE of them. Measured read-only against prod on
 * 2026-09-03: `valueSource` absent on 129 of 129 live holdings, `fmvRung` key
 * absent on 53 of them, 73 holdings carrying a value with one or both missing.
 *
 * Two live shapes show why that matters more than tidiness:
 *
 *   60a7cfcc  Devin Taylor CPA-DT Black auto. Written by autoPriceHolding's
 *             legacy priceSurface persist at 15:53Z on 2026-09-03 with
 *             fairMarketValue $31.50 sitting beside its OWN estimateBasis
 *             "Projected: $1176" and estimatedValue 1176 — on a $650 cost
 *             basis. `pricingSourceMeta.method` said "rare-card-anchor" and
 *             the flat `fmvRung` key was ABSENT, because that site writes
 *             `fmvRung: priceSurfaceRung` and the rung had been dropped on the
 *             way. The rung existed and never reached the field the gates read.
 *
 *   afbebf9c  Gavin Fien CPA-GF Sparkle PSA 10, the sibling-estimate writer:
 *             $68.68 on a $440 basis, no rung key, no valueSource, and no
 *             pricingSourceMeta at all.
 *
 * A holding in that state is not merely unlabelled — it is INVISIBLE to every
 * rung gate and to the invariant auditor, because "the writer never named its
 * rung" was the auditor's own blind spot. An unlabelled writer cannot be found
 * by a detector that skips unlabelled rows.
 *
 * THE CONTRACT. `writeHoldingValuation` is the only function in this codebase
 * that may set `fairMarketValue` (or `estimatedValue`) on a holding document.
 * It REQUIRES, as ordinary required TypeScript parameters:
 *
 *   fmvRung      a rung label from the closed vocabulary, or an explicit
 *                `{ noRung: <reason> }` refusal. A lane that genuinely cannot
 *                name a rung (the resolver fallback, the grade ladder, the
 *                legacy confidence-gated reprice) says so IN THE TYPE and the
 *                reason is persisted. Absence is no longer expressible.
 *   valueSource  "observed" (comps of THIS identity and tier) or "estimated"
 *                (anything derived — another tier, another identity, a vendor,
 *                a sibling). There is no third option and no default.
 *
 * Because both are required positional fields on a required argument object, a
 * write that omits either does not COMPILE. That is the enforcement: not a
 * lint rule, not a review checklist, not a runtime warning that fires in a log
 * nobody reads — the build fails.
 *
 * `pricingSourceMeta` is composed here too, so the #1674 labels are preserved
 * by construction on every path rather than remembered at eleven call sites.
 */
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { PersistedPricingLabels } from "../compiq/valuationLabels.js";

/**
 * The rung a write names, or its explicit refusal to name one.
 *
 * The union is the point. `{ noRung: reason }` is a STATEMENT — the lane looked
 * and has no rung to give — and it persists `fmvRung: null` alongside the
 * reason, which is materially different from a key that was never written. The
 * auditor treats the two differently and must be able to.
 */
export type RungDeclaration =
  | { rung: string }
  | { noRung: string };

/** "observed" = comps of this identity AND this tier. Everything else is
 *  "estimated". No default: the writer states which kind of number it has. */
export type ValueSourceDeclaration = "observed" | "estimated";

export interface HoldingValuationWrite {
  /** The per-unit fair market value. `null` erases the field (an explicit
   *  withhold), and is legitimate — a withhold still names its rung. */
  fairMarketValue: number | null;
  /** REQUIRED. A rung label, or an explicit refusal carrying its reason. */
  rung: RungDeclaration;
  /** REQUIRED. What KIND of evidence produced the number. */
  valueSource: ValueSourceDeclaration;
  /** ISO timestamp for lastUpdated and the *UpdatedAt stamps. */
  nowIso: string;
  /** Everything else the site sets — estimate band, basis, verdict, vendor,
   *  identity patch, prediction layer. Merged UNDER the valuation fields, so
   *  no caller can overwrite the rung/valueSource contract by spreading. */
  fields?: Partial<PortfolioHolding> & Record<string, unknown>;
  /** pricingSourceMeta parts. The #1674 labels ride here and are preserved. */
  meta?: {
    slug?: string | null;
    compsUsed?: number | null;
    confidence?: number | null;
    unionRefused?: string | null;
  } & Partial<PersistedPricingLabels>;
  /** When false, no pricingSourceMeta is written (the lanes that deliberately
   *  clear it — the withhold path). Defaults to true when `meta` is given. */
  writeMeta?: boolean;
}

/** The rung string a declaration carries, or null for an explicit refusal. */
export function rungLabelOf(d: RungDeclaration): string | null {
  return "rung" in d ? d.rung : null;
}

/** The refusal reason, or null when a rung was named. */
export function noRungReasonOf(d: RungDeclaration): string | null {
  return "noRung" in d ? d.noRung : null;
}

/**
 * THE persist shape. Returns the holding to store; it does not touch `doc`,
 * append price history, or fire alerts — those stay at the call sites, which
 * differ legitimately in ordering and in what they consider a "previous"
 * holding for alert evaluation.
 *
 * Field order is deliberate: `...holding` then `...fields` then the valuation
 * contract LAST, so a caller's spread can never silently drop the rung or the
 * valueSource it was required to supply.
 */
export function writeHoldingValuation(
  holding: PortfolioHolding,
  w: HoldingValuationWrite,
): PortfolioHolding {
  const rung = rungLabelOf(w.rung);
  const noRungReason = noRungReasonOf(w.rung);
  const shouldWriteMeta = w.writeMeta ?? (w.meta !== undefined);

  const meta = shouldWriteMeta && w.meta
    ? {
        ...(w.meta.slug != null ? { slug: w.meta.slug } : {}),
        // The rung, never a method vocabulary. CF-RUNG-LABEL: the web's
        // holdingProvenance() prefers `pricingSourceMeta.method` over the flat
        // `fmvRung`, and rung.ts only knows the closed FmvRungLabel set —
        // writing a HobbyIqFmvMethod here rendered `unknown rung "direct-slug"`
        // on genuine exact-pool prices. One vocabulary in both fields.
        method: rung ?? undefined,
        ...(w.meta.compsUsed != null ? { compsUsed: w.meta.compsUsed } : {}),
        ...(w.meta.confidence != null ? { confidence: w.meta.confidence } : {}),
        ...(w.meta.unionRefused ? { unionRefused: w.meta.unionRefused } : {}),
        // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (#1674) — preserved by
        // construction on EVERY path that reaches this helper.
        ...(w.meta.labels ? { labels: w.meta.labels } : {}),
        ...(w.meta.selfAnchored !== undefined ? { selfAnchored: w.meta.selfAnchored } : {}),
      }
    : undefined;

  return {
    ...holding,
    ...(w.fields ?? {}),
    // ── The contract. Written LAST; nothing above may override it. ──────────
    fairMarketValue: w.fairMarketValue as PortfolioHolding["fairMarketValue"],
    fmvRung: rung,
    valueSource: w.valueSource,
    // An explicit refusal persists its REASON, so "no rung" is a readable
    // statement rather than a null anyone has to guess the meaning of.
    ...(noRungReason ? { fmvRungAbsentReason: noRungReason } : { fmvRungAbsentReason: null }),
    ...(shouldWriteMeta ? { pricingSourceMeta: meta } : {}),
    lastUpdated: w.nowIso,
  } as PortfolioHolding;
}
