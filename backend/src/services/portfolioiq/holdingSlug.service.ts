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
  const sport = inferSportFromContext(holding.setName ?? holding.product ?? null, holding.cardTitle ?? null, year);
  if (!sport) return null;

  const rawParallel = String(holding.parallel ?? "").trim() || "Base";
  const isAuto = holding.isAuto === true;
  const printRun = extractPrintRunFromTitle(holding.cardTitle ?? null);

  // CF-BARE-COLOR-TITLE-REFRACTOR-UPGRADE (Drew, 2026-07-28). User-
  // typed / eBay-imported holdings often carry a bare color word
  // ("Blue", "Green", "Orange") in the parallel field even when the
  // card is the "<Color> Refractor" market variant — the title carries
  // "Refractor" or "True". Without an upgrade, deriveHoldingSlug emits
  // :blue:auto while every CH/CS ingest of the same physical card
  // emits :blue-refractor:auto, forking the comp pool.
  //
  // Rule: if parallel is a single-token color word AND the title
  // contains "Refractor" OR "True <same color>", upgrade parallel to
  // "<Color> Refractor" so the slug generator's existing "-refractor"
  // suffix rule fires. Conservative: only fires for canonical refractor
  // colors, only when the title explicitly signals refractor semantics.
  const parallel = upgradeBareColorFromTitle(rawParallel, holding.cardTitle ?? null);

  try {
    return computeHobbyIqCardId({
      sport, year, setKey, cardNumber, parallel, isAuto, printRun,
    });
  } catch {
    return null;
  }
}

const REFRACTOR_COLORS = new Set([
  "blue", "red", "green", "orange", "yellow", "purple", "gold",
  "black", "aqua", "teal", "pink",
]);

function upgradeBareColorFromTitle(parallel: string, title: string | null): string {
  const lc = parallel.trim().toLowerCase();
  if (!REFRACTOR_COLORS.has(lc)) return parallel;
  if (!title) return parallel;
  const t = title.toLowerCase();
  // Title carries the refractor signal in either form:
  //   - "Refractor" anywhere in the title (Chrome-set marker)
  //   - "True <color>" adjacent to the color (market synonym)
  const refractorSignal = /\brefractor(s)?\b/.test(t);
  const trueColorSignal = new RegExp(`\\btrue\\s+${lc}\\b`).test(t);
  if (refractorSignal || trueColorSignal) {
    return `${parallel} Refractor`;
  }
  return parallel;
}

/** True when the holding carries a canonical `hiq:` slug -- a PIN, whatever
 *  wrote it (the card page the user added from, a catalog match, the import). */
export function hasPinnedSlug(holding: { hobbyiqCardId?: string | null }): boolean {
  return String(holding.hobbyiqCardId ?? "").trim().startsWith("hiq:");
}

/**
 * Fill an ABSENT hobbyiqCardId from the holding's own text -- but only with a
 * slug the catalog holds. Mutation-free: a copy when it fills, the same
 * object when it does not.
 *
 * CF-A-MINTED-SLUG-NEVER-REPLACES-A-PIN (2026-08-29, checklist D12a). This
 * replaces withDerivedSlug, which RECOMPUTED on every write and overwrote
 * whatever was there. What it recomputed from is free text: the sport is
 * inferred from the title, the print run is regex'd out of the title, a bare
 * colour becomes a Refractor on a heuristic, and computeHobbyIqCardId never
 * reads the catalog. So a holding whose identity had been resolved against a
 * checklist row -- added from its own card page, pinned by the import at
 * >= 0.9, picked in the review sheet -- had that identity replaced by a
 * guess every time the user touched a note, and priceFromOurPool priced the
 * guess. A guess the catalog does not hold is not an identity at all.
 *
 * Two rules:
 *   1. a slug the holding already carries is kept (fill-only);
 *   2. a derived slug is adopted only when catalogSlugIfExists says the
 *      catalog holds it -- the id itself or its un-numbered twin, and the
 *      catalog's form is what is written; otherwise the holding stays
 *      without a slug and the miss is logged. Fails closed on an outage.
 * A filled slug says how it was chosen: hobbyiqCardIdSource "derived".
 * Identity edits propagate through the catalog resolve on update, never
 * through a recompute here.
 */
export async function fillDerivedSlugFromCatalog<T extends PortfolioHolding>(
  holding: T,
  ctx: { source: string } = { source: "holdingSlug.fillDerivedSlugFromCatalog" },
): Promise<T> {
  if (hasPinnedSlug(holding)) return holding;
  const derived = deriveHoldingSlug(holding);
  if (derived === null) return holding;
  let found: string | null = null;
  try {
    const { catalogSlugIfExists } = await import("../catalog/catalogMatcher.service.js");
    found = await catalogSlugIfExists(derived);
  } catch {
    found = null;
  }
  if (!found) {
    console.log(JSON.stringify({
      event: "derived_slug_not_in_catalog",
      source: ctx.source,
      holdingId: holding.id ?? null,
      derivedSlug: derived,
      detail: "a slug minted from the holding's text is not an identity until the catalog holds it; left unset",
    }));
    return holding;
  }
  return { ...holding, hobbyiqCardId: found, hobbyiqCardIdSource: "derived" };
}
