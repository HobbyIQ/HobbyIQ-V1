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
 *   confidence   (on `meta`, when a meta is written) the engine's PRICING
 *                confidence 0..1, or an explicit `null`. Added 2026-09-03
 *                after the same class of defect recurred one field over: see
 *                the field's own note below.
 *
 * Because all three are required fields on a required argument object, a write
 * that omits any of them does not COMPILE. That is the enforcement: not a lint
 * rule, not a review checklist, not a runtime warning that fires in a log
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
 *  "estimated". No default: the writer states which kind of number it has.
 *
 *  There is deliberately NO third member for a refusal. #1781/#1785 rule that
 *  a withhold writes `valueSource: "estimated"` — a refusal observed nothing,
 *  so it cannot stand behind an "observed" claim, and inventing an
 *  "unavailable" member would give the refusal branches a second vocabulary
 *  for the fact `withheld.retained` already states precisely. */
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
    /**
     * REQUIRED whenever a meta is written (CF-CONFIDENCE-IS-NOT-OPTIONAL,
     * 2026-09-03). The engine's PRICING confidence, 0..1 — the quantity
     * `resolvePricingConfidence` reads and `#1672`'s sell-window gate needs.
     *
     * This was `confidence?: number | null` and that optionality is exactly
     * how it went missing: `holdingValuation.ts` — the lane the 2026-09-03
     * reprice wave actually used — built its meta with slug, compsUsed and
     * labels, never named confidence, and COMPILED. Measured read-only after
     * two reprices: `pricingSourceMeta.confidence` absent on 43 of Drew's 43
     * holdings, while the sibling lane in portfolioStore stamped it fine. The
     * engine had the number the whole time (a label read "Low confidence
     * (0.23)"); only the writer dropped it, and the sell-window feature went
     * dark for every unified row ("unknown-confidence", timing withheld).
     *
     * So it is required and explicitly nullable, exactly like `fmvRung` and
     * `valueSource`: a lane with no confidence to give writes `null` and SAYS
     * so. Absence is no longer expressible, so a lane cannot silently drop it
     * again — the build fails instead.
     */
    confidence: number | null;
    unionRefused?: string | null;
    /**
     * CF-A-WITHHOLD-IS-VISIBLE-TO-THE-AUDITOR (2026-09-04). A withhold
     * publishes no number and so names no rung, which meant it wrote
     * `pricingSourceMeta: undefined` — absent — and #1674's own finding was
     * that a row with no meta is INVISIBLE to every rung gate and to the
     * invariant auditor. A refusal is exactly the event an auditor needs to
     * see. When this is set the meta names `method: "withheld"` and carries
     * the machine-readable reason, the blocking pool, and the number that
     * was refused.
     */
    withheld?: {
      reason: string;
      blockingId: string | null;
      /** The blocking pool's size. Null when the refusal is not about a pool
       *  at all — an identity refused for having no checklist behind it
       *  blocks on provenance, and inventing a 0 there would read as "the
       *  pool was empty", which is a different and false claim. */
      blockingCount: number | null;
      /** The estimate that was NOT published — kept, never erased. */
      proposed: number | null;
      /**
       * CF-A-WITHHELD-PRICE-NEVER-RETAINS-THE-NUMBER-IT-REFUSED (2026-09-04).
       * What the row actually carries after the withhold, and why. A refusal
       * that keeps a prior number and one that keeps nothing are DIFFERENT
       * decisions, and a reader (the UI's "market shows $2, withheld: below
       * 15% of your $29.45 basis", the invariant auditor) must be able to tell
       * them apart without re-deriving the rule. Absent on refusals that make
       * no retention decision at all.
       */
      retained?: number | null;
      /** The rule that refused the retention, or null when one stood. */
      retentionRefused?: string | null;
      /**
       * The rung a RETAINED number was originally priced under, as evidence.
       * Deliberately not `fmvRung`: it describes the number's history, never
       * the claim the withheld write is making, which names no rung at all.
       */
      retainedRung?: string | null;
    };
  } & Partial<PersistedPricingLabels>;
  /** When false, no pricingSourceMeta is written (the lanes that deliberately
   *  clear it — the withhold path). Defaults to true when `meta` is given. */
  writeMeta?: boolean;
}

/**
 * The one method string that means "this row is a refusal, not a price".
 *
 * Named here rather than spelled inline because THREE places now depend on the
 * same literal agreeing: the meta builder that stamps it, the stale-withhold
 * clear that must not mistake it for a publish, and the corpus auditor's I1
 * (`corpus-invariants.cjs` exports its own `WITHHELD_METHOD` and reads
 * `pricingSourceMeta.method` off the stored row). A drift between the writer's
 * string and the auditor's is a defect that reports itself as clean.
 */
export const WITHHELD_METHOD = "withheld";

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
        // CF-A-WITHHOLD-IS-VISIBLE-TO-THE-AUDITOR: a refusal has no rung, so
        // it names its KIND instead of leaving `method` undefined — an
        // auditor filtering on `method` sees the withhold rather than
        // skipping a row that looks like it was never written.
        //
        // CF-EVERY-META-NAMES-A-METHOD (2026-09-04). The clause above closed
        // the case where a lane passed `withheld`, and left open the one that
        // actually reached prod: a `{ noRung }` write with an ORDINARY meta.
        // `rung` is null and `w.meta.withheld` is undefined, so `method` was
        // `undefined` — the exact absence #1674 was written to abolish, now
        // reintroduced by the very helper that abolished it.
        //
        // Measured read-only against prod on 2026-09-04 after the sanctioned
        // reprice (run 33893507773, user user-199fcbc9): 41 of Drew's 43
        // holdings carry a method and TWO do not —
        //
        //   9f082213  Victor Figueroa CPA-VF Black & White Red Ink auto, raw.
        //             $11 on a $278.60 basis. The ladder priced it at $8.70
        //             (exact-pool-projection) and CF-COST-BASIS-SANITY-FLOOR
        //             REJECTED that number — correctly; the slug's pool is
        //             contaminated with 56 base-auto sales. The rejection
        //             wrote nothing, the row fell through to the retention
        //             branch, and the retention faithfully re-stated a
        //             pre-C-7 meta of `{slug, compsUsed}` under `{ noRung }`.
        //   277b05a3  Cal Ripken Jr. 1997 Metal Universe #8, PSA 8. $49.99 on
        //             a $52.98 basis, proposed $5.40, same floor, same fall-
        //             through, meta `{compsUsed: 50}`.
        //
        // Both rows therefore carry a bare number with `method` undefined —
        // INVISIBLE to every rung gate and to the invariant auditor, which is
        // the precise failure mode #1674 named. There are twelve `{ noRung }`
        // sites in portfolioStore and every one of them could reach this.
        //
        // So the fallback is total: a meta that names no rung and no withhold
        // still names its KIND. `unlabelled-carry` is that kind — a number
        // this write did not derive and whose origin pass named no rung. It is
        // deliberately NOT a rung name (fmvRung.ts does not know it), so no
        // reader mistakes it for a pricing decision; it is the auditor's
        // handle on a row that would otherwise have none.
        // The literal, deliberately, not `WITHHELD_METHOD`: the pin in
        // persistGateAcceptsEveryRung.test.ts matches this expression as
        // SOURCE TEXT to prove no branch of it can yield `undefined`. A
        // constant here would read identically at runtime and blind that pin.
        method: rung ?? (w.meta.withheld ? "withheld" : "unlabelled-carry"),
        ...(w.meta.withheld ? { withheld: w.meta.withheld } : {}),
        ...(w.meta.compsUsed != null ? { compsUsed: w.meta.compsUsed } : {}),
        // CF-CONFIDENCE-IS-NOT-OPTIONAL, the persisted half (2026-09-04).
        //
        // The TYPE made `confidence` required-and-nullable so a lane could not
        // silently omit it — and this line then dropped the very `null` the
        // type forces a lane to write. `!= null` spreads nothing for an
        // explicit null, so "I measured nothing and say so" persisted as
        // IDENTICALLY ABSENT to "I forgot", which is the exact distinction
        // that required-nullable exists to preserve. A refusal lane
        // (identityUnverifiedRefusalWrite, and the floor lane when it has no
        // prior confidence) has no confidence to give; its `null` is a
        // statement and must survive to the row.
        //
        // Only `undefined` — which the type no longer permits — is omitted.
        ...(w.meta.confidence !== undefined ? { confidence: w.meta.confidence } : {}),
        ...(w.meta.unionRefused ? { unionRefused: w.meta.unionRefused } : {}),
        // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (#1674) — preserved by
        // construction on EVERY path that reaches this helper.
        ...(w.meta.labels ? { labels: w.meta.labels } : {}),
        ...(w.meta.selfAnchored !== undefined ? { selfAnchored: w.meta.selfAnchored } : {}),
      }
    : undefined;

  // CF-A-HOLDING-CARRIES-ONE-STAMP (Drew, 2026-09-05). A row carries EXACTLY
  // ONE of {published stamp, withheld stamp} — never both.
  //
  // The withheld stamp had no way to come OFF. `writeHoldingValuation` builds
  // its meta fresh, so a publish that writes a meta already drops a prior
  // `withheld` by construction; but the SIX sites that pass `writeMeta: false`
  // publish a value and never touch `pricingSourceMeta` at all, so the prior
  // meta — `withheld` block and all — rides through on the `...holding`
  // spread. The resolver-fallback rescue (portfolioStore ~10918) and the
  // legacy confidence-gated persist (~11487) both set a real
  // `fairMarketValue` that way.
  //
  // That is the Bellingham Griffey (c8949bb0), measured in the 2026-09-04
  // audit: `fairMarketValue` 1850, `method` "exact-pool-last-sale",
  // `valueSource` "observed", confidence 1 — a legitimate PUBLISH, because
  // CF-LEGACY-SURVIVES-FOR-UNNAMEABLE-IDENTITIES says a slug the catalog
  // cannot name but which HAS sales is priced by the legacy exact-pool read —
  // standing beside `withheld { reason: "identity-not-in-catalog",
  // blockingCount: 39, proposed: null }` left over from an earlier pass that
  // DID refuse. Nothing in the publish path cleared it. Every reader that
  // prefers `method` sees a current observed price; the auditor reading
  // `withheld` sees a refusal; both are reading the same row.
  //
  // So the clear happens HERE, at the one choke point every write already
  // passes through, rather than as a new obligation at fourteen call sites
  // (which is the shape C-7 abolished, and which the writer-count pins
  // forbid). A write that does not DECLARE a withhold is a publish, and a
  // publish leaves no withheld stamp behind it.
  const carriedMeta = (holding as { pricingSourceMeta?: Record<string, unknown> }).pricingSourceMeta;
  // CF-A-CLEAR-IS-FOR-PUBLISHES-ONLY (2026-09-06). The clause above reads "a
  // write that does not DECLARE a withhold is a publish" — and that is true of
  // the six `writeMeta: false` sites it was written for, every one of which
  // sets a real `fairMarketValue` from a lane that priced something. It is
  // FALSE of the site #1833 added at portfolioStore ~11404, which is the
  // second half of a refusal: `noBasisRefusalWrite` stamps the withheld meta,
  // and this call then carries the lane's identity patch and verdict onto that
  // same row with `writeMeta: false` to leave the stamp alone. The clear read
  // that continuation as a publish and stripped the very block the line above
  // it had just written — leaving `method: "withheld"` (which lives in the
  // carried meta, not in the dropped key) standing with no reason beside it.
  //
  // That is the exact I1 `withheld-method-without-block` shape, and it is not
  // theoretical: the 2026-09-06 07:21Z corpus audit found TEN of them across
  // five users, every one stamped in that morning's 04:22-06:40Z reprice —
  //
  //   8b38c810 / c8dfad0d   method "withheld", compsUsed 6, confidence 0.598,
  //                         NO withheld block. fmvRungAbsentReason carries the
  //                         prose ("the catalog holds no identity for this
  //                         holding ... the prior value of $1.99 is NOT
  //                         retained"), so the REASON was computed and written
  //                         to a prose field and then dropped from the one
  //                         machine-readable place a client can read it.
  //   user-199fcbc9 / ca7a150b, user-5e1a90ea / 60a7cfcc, and seven more.
  //
  // The refusal survived as a sentence and died as a fact, which is precisely
  // what #1815 ("a refusal is a fact the client is entitled to") forbids: the
  // pricing envelope builds `withheldReason` off `pricingSourceMeta.withheld`,
  // so every one of those rows went out to the client as a null price with no
  // machine-readable reason attached.
  //
  // So the clear now asks whether the row it is clearing is a PUBLISH. A
  // carried meta whose own `method` is "withheld" is not stale residue behind
  // a new price — it IS the withheld stamp, intact and current, and a write
  // that states no meta of its own has said nothing that contradicts it. The
  // Griffey case the clear exists for is untouched: its carried method is
  // "exact-pool-last-sale", a published stamp, and the block beside it really
  // is the leftover this branch was built to drop.
  const carriedMethod = carriedMeta && typeof carriedMeta === "object"
    ? (carriedMeta as { method?: unknown }).method
    : undefined;
  const carriedIsWithheldStamp = carriedMethod === WITHHELD_METHOD;
  const clearsStaleWithhold = !w.meta?.withheld
    && !carriedIsWithheldStamp
    && !!carriedMeta
    && typeof carriedMeta === "object"
    && "withheld" in carriedMeta;
  // Only the `withheld` key is dropped. The rest of the carried meta (slug,
  // compsUsed, confidence, labels) is the prior pass's and is NOT this
  // write's to erase — a `writeMeta: false` site is saying precisely that it
  // has no meta of its own to state.
  const carriedWithoutWithhold = clearsStaleWithhold
    ? (() => { const { withheld: _dropped, ...rest } = carriedMeta as Record<string, unknown>; return rest; })()
    : null;

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
    ...(shouldWriteMeta
      ? { pricingSourceMeta: meta }
      : clearsStaleWithhold
        ? { pricingSourceMeta: carriedWithoutWithhold as PortfolioHolding["pricingSourceMeta"] }
        : {}),
    lastUpdated: w.nowIso,
  } as PortfolioHolding;
}
