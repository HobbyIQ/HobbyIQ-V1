// CF-PORTFOLIO-DETAIL-SLUG (Drew, 2026-07-26). Derive the canonical
// hobbyiqCardId slug for a PortfolioHolding.
//
// Called at every holding write site (addHolding, autoPriceHolding
// writeback) so the field is populated at rest. Also called defensively
// on every read for legacy holdings that predate this CF so iOS never
// has to see a null slug on a card that's identifiable.
//
// Returns null when the holding lacks the fields needed to compute a
// canonical slug (year / setName / cardNumber / inferable sport). Those
// holdings simply don't participate in the /card-detail flow yet; iOS
// falls back to its legacy tap behavior.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { computeHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { extractPrintRunFromTitle, inferSportFromContext } from "./soldCompsStore.service.js";

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Compute the canonical hobbyiqCardId for a holding. Returns null when
 *  identity is insufficient — leaves iOS on the legacy path. */
export function deriveHoldingSlug(holding: PortfolioHolding): string | null {
  const year = toNum(holding.cardYear);
  const setKey = String(holding.setName ?? holding.product ?? "").trim();
  const cardNumber = String(holding.cardNumber ?? "").trim();
  if (!year || !setKey || !cardNumber) return null;

  // Sport isn't a first-class field on PortfolioHolding — infer from
  // setName + cardTitle context (same helper used by soldCompsStore).
  const sport = inferSportFromContext(holding.setName ?? holding.product ?? null, holding.cardTitle ?? null);
  if (!sport) return null;

  const parallel = String(holding.parallel ?? "").trim() || "Base";
  const isAuto = holding.isAuto === true;
  const printRun = extractPrintRunFromTitle(holding.cardTitle ?? null);

  try {
    return computeHobbyIqCardId({
      sport, year, setKey, cardNumber, parallel, isAuto, printRun,
    });
  } catch {
    return null;
  }
}

/** Mutation-free: return a copy of the holding with hobbyiqCardId
 *  populated if computable. When holding already carries a slug, we
 *  RECOMPUTE and overwrite — cheap, and lets identity edits (fixed
 *  parallel, corrected cardNumber) propagate to the slug automatically. */
export function withDerivedSlug<T extends PortfolioHolding>(holding: T): T {
  const slug = deriveHoldingSlug(holding);
  if (slug === null && !holding.hobbyiqCardId) return holding;
  return { ...holding, hobbyiqCardId: slug };
}
