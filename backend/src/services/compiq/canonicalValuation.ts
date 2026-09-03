/**
 * CF-ONE-VALUATION-PATH — the canonical-shaped door into the one entry.
 *
 * THE GRAPH (established 2026-09-03, audit follow-up to #1679).
 * `computeCanonicalFmv` is NOT the inner computation `valueIdentity` wraps.
 * The two reach the comp pool through disjoint readers:
 *
 *   valueIdentity ──> priceHoldingFromExactPool (exactPoolSupremacy.ts)
 *                       └─> exactPoolReader ──> sold_comps
 *   computeCanonicalFmv ──> readCompsByCardId / readCompsByIdentity /
 *                           readCompsByHobbyIqCardId (soldCompsStore) ──> sold_comps
 *
 * Neither module imports the other's reader; canonicalFmv.service.ts names
 * neither `priceHoldingFromExactPool` nor `valueIdentity` anywhere in its
 * body. They are two engines over one container, and a direct call to the
 * second one skips, in full:
 *
 *   • owner exclusion        excludeContributorUserId never reaches it
 *   • adjudication filters   the resolver's CatalogRowResolution is not passed
 *   • the union guard        cross-product twins are not refused
 *   • rung-meta + labels     rungLabel/valueSource/identity/fmvReason
 *   • twin refusal           resolveValuationIdentity's identity-not-in-catalog
 *   • the swing alarm        logged on the one path only
 *
 * So every published number goes through `valueIdentity`. This module is the
 * adapter for the callers that must keep speaking `CanonicalFmvResult`: it
 * calls the ONE entry and renders the answer in the old wire shape via
 * toCanonicalFmvResponse. It adds no valuation logic of its own — the number
 * is byte-identical to what `valueIdentity` returned.
 */
import { valueIdentity } from "./oneValuationPath.service.js";
import { toCanonicalFmvResponse } from "./oneValuationPathAdapters.js";
import type { CanonicalFmvResult } from "./canonicalFmv.service.js";

/** The canonical-fmv input, unchanged, so call sites move by name only. */
export interface CanonicalValuationInput {
  cardId: string;
  parallel?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  cardYear?: number | null;
  product?: string | null;
  player?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  freshCompute?: boolean;
  /** Portfolio/sell surfaces: keep the owner's own purchases out of the pool. */
  excludeContributorUserId?: string | null;
}

export type CanonicalValuation = CanonicalFmvResult & {
  identity: Record<string, unknown>;
  valueSource: "observed" | "estimated" | "unavailable";
  fmvReason: string | null;
  compsUsed: number;
};

/**
 * Price through the one valuation path and answer in the canonical shape.
 *
 * `parallel` / `product` / `cardNumber` / `isAuto` are deliberately NOT
 * forwarded as pool selectors: the identity resolver reads them from the
 * catalog row itself, which is the whole point of the one path (a caller's
 * guess about a parallel cannot re-point the pool). They stay on the input
 * so call sites keep their existing object literals.
 */
export async function computeCanonicalValuation(
  input: CanonicalValuationInput,
): Promise<CanonicalValuation> {
  const v = await valueIdentity({
    id: String(input.cardId ?? "").trim(),
    grade: {
      company: input.gradeCompany ?? null,
      value: typeof input.gradeValue === "number" ? input.gradeValue : null,
    },
    printRun:
      typeof input.printRun === "number" && Number.isFinite(input.printRun) && input.printRun > 0
        ? input.printRun
        : null,
    playerName: input.player ?? null,
    excludeContributorUserId: input.excludeContributorUserId ?? null,
  });
  return toCanonicalFmvResponse(v);
}
