// CF-EBAY-AUTO-HOLDING (2026-07-12, Drew — scope 3 followup).
//
// Bridge from parsed eBay listing title → real PortfolioHolding row on the
// user doc. Pure mutator: caller (import route OR backfill route) passes
// the user doc + a purchase entry, we parse the purchase.notes (which the
// import service stored as the listing title), and if parseConfidence
// ≥ 0.70 we mutate the doc:
//   1. Create a new PortfolioHolding row
//   2. Append the holding's id to the parent purchase's holdingIds[]
//
// The caller is responsible for writeUserDoc() after batching. Never
// creates a holding if the purchase already has holdingIds populated
// (idempotent — safe to re-run after a partial write).
//
// The generated holding carries:
//   source: "ebay-auto"          (distinguishes from manual holdings)
//   sourcePurchaseId: purchase.id (back-reference for cost-basis audit)
//   parseConfidence: number      (0.70-1.00; iOS renders a badge for <0.90)
//   needsReview: boolean         (true when confidence < 0.90)
//
// All three fields are ADDITIVE — existing consumers see them via
// (h as any).sourcePurchaseId etc. and don't need type changes to
// keep working.

import { randomUUID } from "node:crypto";
import type {
  PortfolioHolding,
} from "../../types/portfolioiq.types.js";
import {
  parseListingTitle,
  type ParsedListingTitle,
} from "./ebayTitleParser.service.js";
import type {
  PortfolioPurchaseEntry,
} from "./portfolioStore.service.js";
import type { EbayItemDetails } from "../ebay/ebayItemDetails.service.js";
// CF-ASPECT-IS-NOT-A-PARALLEL: the normalizer is the single place that knows
// which strings are real parallels, so the aspect is vetted through it rather
// than against a second, drifting list here.
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";
import { valueHoldingThroughOneEntry, noBasisRefusalWrite, costBasisFloorRefusalWrite } from "./holdingValuation.js";

/**
 * Threshold at which we auto-create a holding from a purchase.
 * Confidence must be ≥ this value; below it we either flag needsAttribution
 * (0.40-0.69) or skip entirely (<0.40).
 */
export const AUTO_CREATE_CONFIDENCE_THRESHOLD = 0.7;
/** Below this the parse is too uncertain to even flag. */
export const NEEDS_ATTRIBUTION_MIN = 0.4;
/** Confidence below this on an auto-created holding triggers iOS's "review" badge. */
export const NEEDS_REVIEW_MAX = 0.9;

export type AutoHoldingResult =
  | { status: "created"; holding: PortfolioHolding; parsed: ParsedListingTitle; enriched: boolean }
  | { status: "needs-attribution"; parsed: ParsedListingTitle }
  | { status: "skipped-low-confidence"; parsed: ParsedListingTitle }
  | { status: "skipped-already-linked"; parsed: ParsedListingTitle }
  | { status: "skipped-sealed-or-break"; parsed: ParsedListingTitle };

/** Object with a mutable holdings map + purchases array. Kept loose so this
 *  service doesn't depend on the private UserDoc type in portfolioStore. */
export interface AutoHoldingDocShape {
  holdings: Record<string, PortfolioHolding>;
  purchases?: PortfolioPurchaseEntry[];
  /** C-7 (2026-09-03): the owner, so the import's valuation can exclude this
   *  user's OWN comps from the pool that prices their new card. The real
   *  UserDoc always carries it; optional here only so the narrow test shapes
   *  that construct this by hand keep compiling. A missing userId excludes
   *  nothing, which is the pre-existing behaviour, never a wrong price. */
  userId?: string;
}

/**
 * Try to auto-create a holding for a single purchase. Mutates `doc` in place
 * when it does (or when it links to an existing holding). NEVER writes to
 * Cosmos itself — caller batches and writes once.
 *
 * When `details` is provided (from a Browse API prefetch), Browse-side data
 * is merged AUTHORITATIVELY over the title-parse for grader/grade/aspects/
 * images. Absent `details` → title-parse only (current-day behavior).
 */
// Async since CF-EBAY-MATCH-CATALOG-AT-INGEST: the catalog match is a Cosmos
// read, so matching at import time makes this awaitable. Sole caller is
// ebayBuyerHistory.service, already inside an async loop.
export async function autoCreateHoldingForPurchase(
  doc: AutoHoldingDocShape,
  purchase: PortfolioPurchaseEntry,
  details?: EbayItemDetails | null,
): Promise<AutoHoldingResult> {
  if (purchase.holdingIds.length > 0) {
    return {
      status: "skipped-already-linked",
      parsed: parseListingTitle(purchase.notes ?? ""),
    };
  }
  // CF-DEDUP-SOURCE-PURCHASE (Drew, 2026-08-03). Belt-and-suspenders
  // against duplicate holdings: even if purchase.holdingIds is empty,
  // scan doc.holdings for one already tagged sourcePurchaseId ===
  // purchase.id. That case happens when a prior batch created the
  // holding but the purchase.holdingIds write was lost to a partial
  // update. Re-linking the existing holding is idempotent; creating a
  // second one would double-book cost.
  for (const h of Object.values(doc.holdings ?? {})) {
    if ((h as { sourcePurchaseId?: string }).sourcePurchaseId === purchase.id) {
      purchase.holdingIds = [...new Set([...purchase.holdingIds, (h as { id: string }).id])];
      return {
        status: "skipped-already-linked",
        parsed: parseListingTitle(purchase.notes ?? ""),
      };
    }
  }
  const parsed = parseListingTitle(purchase.notes ?? "");

  // CF-CARDS-ONLY-FILTER (Drew, 2026-08-03). Portfolio holdings are
  // CARDS only — reject sealed products, box breaks, memorabilia,
  // apparel, and supplies. Two-part filter:
  //   1. No playerName parsed → not a card (breaks and sealed boxes)
  //   2. Title matches a non-card word list → apparel/supplies/memorabilia
  //      (even if a player name got parsed, e.g. "Aaron Judge signed hat")
  // User still has the purchase record for cost tracking; nothing lands
  // in inventory. Extend the regex when we see a new non-card pattern
  // slip through — cheaper to be aggressive here than to clean up
  // orphan holdings later.
  const title = String(purchase.notes ?? "").toLowerCase();
  const isSealedOrBreak =
    /\bbreak\b|\brandom\s+(team|div|hit|slot|player)|\bteam\s+(spot|slot|break)|\bhobby\s+box|\bjumbo\s+box|\bmega\s+box|\bblaster|\bhanger\s+box|\bretail\s+box|\bpyt\b|\bpick\s+your\s+team|\bteam\s+random|\(b\d+\)|\bbox\s+break|\bcase\s+break|\bpersonal\s+break|\bhobby\s+case|\bfactory\s+sealed\s+box|\bwax\s+box|\bcello\s+pack|\bfat\s+pack|\bvalue\s+pack/i.test(title);
  const isMemorabiliaOrSupply =
    /\b(hat|cap|jersey|jerseys|t\s?-?\s?shirt|hoodie|sweatshirt|sweater|pants|shorts|shoe|shoes|sneaker|sneakers|helmet|glove|gloves|bat|ball(?!\s+(rookie|card))|puck|photo\s+print|poster|banner|flag|mug|cup|coin|patch|pin\b|button|bobblehead|figure|figurine|statue|replica|ring|chain|necklace|pendant|watch|bag|backpack|wallet|mask|towel|blanket|pillow|magnet(?!ic)|sticker|decal|keychain|keyring|lanyard|autographed\s+(jersey|hat|cap|bat|ball|helmet|photo|poster|puck))\b/i.test(title);
  const isSupply =
    /\b(top\s?-?loader|toploader|penny\s+sleeve|penny\s+sleeves|team\s+bag|team\s+bags|semi\s?-?rigid|semirigid|magnetic\s+(holder|case)|one\s?-?touch|screwdown|screw\s+down|card\s+saver|card\s+savers|binder|album|storage\s+box|monster\s+box|card\s+sleeve|card\s+sleeves|ultra\s+pro|ultrapro|display\s+case|display\s+stand|graded\s+slab\s+case|grading\s+kit|deck\s+box)\b/i.test(title);
  if (!parsed.playerName || isSealedOrBreak || isMemorabiliaOrSupply || isSupply) {
    return { status: "skipped-sealed-or-break", parsed };
  }

  // CF-EBAY-IMPORT-FORCE-REVIEW (Drew, 2026-08-03). "We need to do
  // matches before going into inventory" — when
  // EBAY_IMPORT_FORCE_REVIEW=true, every purchase with confidence
  // >= NEEDS_ATTRIBUTION_MIN gets a holding CREATED with
  // cardStatus="pending-review" (the existing review-queue lane).
  // The user confirms via POST /erp/holdings/:id/confirm before it
  // becomes active. The AUTO_CREATE_CONFIDENCE_THRESHOLD gate is
  // bypassed so lower-confidence-but-parseable rows also become
  // pending-review holdings for the user to correct.
  const forceReview = process.env.EBAY_IMPORT_FORCE_REVIEW === "true";
  const effectiveThreshold = forceReview
    ? NEEDS_ATTRIBUTION_MIN
    : AUTO_CREATE_CONFIDENCE_THRESHOLD;
  if (parsed.parseConfidence < effectiveThreshold) {
    if (parsed.parseConfidence >= NEEDS_ATTRIBUTION_MIN) {
      return { status: "needs-attribution", parsed };
    }
    return { status: "skipped-low-confidence", parsed };
  }

  const holding = buildHoldingFromParse(purchase, parsed);
  if (details) applyBrowseEnrichment(holding, details);

  // CF-ONE-IMPORT-ONE-IDENTITY (Drew, 2026-08-29, checklist D9: "We need to
  // fix the whole eBay import to holdings process, because it seems broken").
  //
  // Drew's own import of "2026 Bowman Marconi German Chrome Auto Gold
  // Refractor 1st #/50 Nationals" came out with THREE identities and none of
  // them the checklist row:
  //
  //   catalogMatchSlug   hiq:...:bowman-chrome::refractor:auto   (EMPTY number)
  //   cardId             ...:cpa-mg:refractor:auto               (suggester)
  //   hobbyiqCardId      ...:cpa-mg:gold-refractor:auto          (no /50)
  //
  // and a NEW catalog row minted at the third one -- the checklist row's
  // un-numbered twin -- with the sale filed under it. Each defect was one
  // writer deriving identity its own way: the matcher was asked with the
  // title's parse before any card number existed and without the print run it
  // had parsed; hobbyiqCardId was never set here and was later re-derived by a
  // PATCH from a holding that carried no printRun; the suggester's pick became
  // cardId at confirm because nothing had pinned one.
  //
  // Now identity is derived ONCE, here, and every field that names the card
  // is written from that one answer: cardId, hobbyiqCardId, catalogVerifiedSlug
  // and the sale's slug. The holding carries printRun so a later re-derivation
  // keeps the :num-N segment, and the card title is rebuilt from the RESOLVED
  // identity so it can never drop the finish or the /N again.
  await resolveImportIdentity(holding);
  await recordImportSale(holding, purchase, doc);

  // CF-THE-SECOND-WRITER-NAMES-ITS-RUNG-TOO (C-7, 2026-09-03). This is the
  // "second, older writer" the one-valuation-path work never scoped, and it is
  // the one that produced EVERY key-absent holding in prod: measured 2026-09-03,
  // all 52 holdings with no `fmvRung` key at all are `source: "ebay-auto"` /
  // `cardStatus: "pending-review"` — created right here, and never priced.
  //
  // Nothing else on the import path prices them either: confirmHoldingReview
  // promotes cardStatus to "active" without calling autoPriceHolding, so an
  // imported card could go live carrying no value, no rung and no valueSource.
  // Downstream that is indistinguishable from a holding the engine looked at
  // and declined to price, which is exactly what made the 53 invisible to
  // every rung gate.
  //
  // Route it through the SAME one entry every other writer uses. Not throwing
  // and not blocking the import is deliberate: the identity was just resolved
  // above and the pool may legitimately hold nothing for it, so an unpriced
  // outcome leaves the holding exactly as it was (no value written) — but a
  // priced one now carries fairMarketValue, fmvRung AND valueSource together,
  // written by the one path rather than by this file's own hand.
  // CF-AN-IMPORT-REFUSAL-IS-A-WITHHOLD-NOT-A-SHRUG (Drew, 2026-09-06, #1869).
  //
  // The two lines this replaced kept `valued.holding` on a priced outcome and
  // THREW AWAY every refusal:
  //
  //     const priced = valued.outcome === "observed" || valued.outcome === "estimated"
  //       ? valued.holding
  //       : holding;
  //
  // `holding` is the pre-valuation row. So when the one entry ran its #1784
  // identity gate and returned `no-basis-refusal` — "there is no checklist-backed
  // card here, publish nothing" — the import discarded that answer and stored the
  // unwithheld row instead. The refusal was computed, logged, and dropped on the
  // floor. Same for the cost-basis floor.
  //
  // That is how 925ccfe7 / 4e70af40 came to carry $14.79 with no `withheld` block
  // at all. Their slug
  // `hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499` has 95 real
  // sales in the pool but NO card_catalog row (verified read-only 2026-09-06:
  // 0 rows for that id, and 0 for the suggester's `…:base:auto` twin). A pool can
  // hold sales under a slug the catalog cannot name — that is precisely the state
  // #1784 refuses to price, and precisely the state this line hid.
  //
  // Now the refusal is PERSISTED through the same `noBasisRefusalWrite` every
  // other lane uses (portfolioStore's autoPriceHolding and the reprice loop), so
  // the import cannot drift from them: `fairMarketValue` null, `estimatedValue`
  // cleared with it, `method: "withheld"`, `fmvRung` null with the refusal prose
  // as its stated reason, and the machine-readable reason on
  // `pricingSourceMeta.withheld`. ABSENT BEATS WRONG: a withheld price is null
  // plus a reason, and a number for a card we cannot name is worse than a blank.
  //
  // `unresolved` and `unpriced` keep their existing meaning — the engine reached
  // no verdict worth persisting, and the row is stored as built with no value —
  // so an import of a card with a genuinely empty pool is unchanged.
  const valued = await valueHoldingThroughOneEntry(holding, {
    userId: doc.userId ?? null,
    caller: "ebayAutoHolding.import",
  });
  let priced: PortfolioHolding = holding;
  if (valued.outcome === "observed" || valued.outcome === "estimated") {
    priced = valued.holding;
  } else if (valued.outcome === "no-basis-refusal") {
    const nb = noBasisRefusalWrite(holding, valued.reason, valued.valuation, new Date().toISOString());
    priced = nb.holding;
    console.warn(JSON.stringify({
      event: "no_basis_refusal_persisted",
      source: "ebayAutoHolding.import",
      holdingId: holding.id,
      reason: valued.reason,
      summary: nb.summary,
    }));
  } else if (valued.outcome === "cost-basis-floor") {
    const cbf = costBasisFloorRefusalWrite(holding, valued, new Date().toISOString());
    priced = cbf.holding;
    console.warn(JSON.stringify({
      event: "cost_basis_floor_refusal_persisted",
      source: "ebayAutoHolding.import",
      holdingId: holding.id,
      summary: cbf.summary,
    }));
  }

  doc.holdings[holding.id] = priced;
  // Idempotent Set-union merge, symmetric with PATCH /link-holdings.
  const merged = new Set([...purchase.holdingIds, holding.id]);
  purchase.holdingIds = [...merged];

  // CF-ONLY-CHECKLISTS-MINT (Drew, 2026-08-29; catalog rebuild D5). This used
  // to upsert a card_catalog row at "ebay-browse:<sha256>" from eBay's
  // item-specifics (CF-EBAY-BROWSE-CATALOG-SEED, 2026-08-03). eBay Browse is a
  // vendor feed; vendor feeds never mint identity (#1362), and a hash id is
  // not an hiq slug, so those rows were unreachable by every reader anyway.
  // The purchase's SALE is written to the pool above (recordSoldComp), and a
  // user-owned card seeds through the one canonical path in soldCompsStore
  // (USER_SEED_SOURCES -> ensureCatalogRow -> upsertCatalogEntry).

  // The caller gets the holding that was actually STORED, values and all.
  return { status: "created", holding: priced, parsed, enriched: !!details };
}

// ─── Identity resolution ───────────────────────────────────────────────────

const str = (v: unknown): string => String(v ?? "").trim();

/**
 * Derive the holding's identity ONCE from its final fields: normalize them,
 * resolve a missing card number from the catalog, canonicalize with the
 * title's parallel AND print run, and pin every identity field from the one
 * answer. Never throws — a matcher failure leaves the holding for review,
 * exactly as before.
 */
async function resolveImportIdentity(holding: PortfolioHolding & Record<string, unknown>): Promise<void> {
  const h = holding as Record<string, unknown>;

  // The one cleaning standard, applied to the values we are about to match
  // and store -- not to one branch of them. "Marconi German," came out of this
  // path with its comma because the normalizer only ever saw the parallel.
  const { fields: clean } = normalizeHoldingFields({
    playerName: str(h.playerName) || null,
    cardYear: typeof h.cardYear === "number" ? h.cardYear : null,
    setName: str(h.setName) || null,
    parallel: str(h.parallel) || null,
    cardNumber: str(h.cardNumber) || null,
    isAuto: typeof h.isAuto === "boolean" ? h.isAuto : null,
    product: str(h.product) || null,
  });
  if (str(clean.playerName)) h.playerName = str(clean.playerName);
  if (str(clean.cardNumber)) h.cardNumber = str(clean.cardNumber);
  if (str(clean.setName)) {
    const productFollowsSet = !str(h.product) || str(h.product) === str(h.setName);
    h.setName = str(clean.setName);
    if (productFollowsSet) h.product = h.setName;
  }
  // Only ever improve the parallel; an unrecognised one stays reviewable
  // rather than silently becoming base (same rule as the Browse path above).
  if (str(clean.parallel)) h.parallel = str(clean.parallel);

  try {
    // CF-ONE-IDENTITY-DERIVATION (D12-b, 2026-08-29): the derivation itself
    // -- number-by-player, never an empty number, the matcher asked with the
    // parallel + print run + player, the >= 0.9 bar -- lives in
    // identityFromFields, shared with the spreadsheet import so both run ONE
    // rule. What this function still owns is what to write back.
    const { resolveIdentityFromFields, clearsIdentityBar } = await import("./identityFromFields.js");
    const sport = (str(h.sport) || "baseball").toLowerCase();
    const year = typeof h.cardYear === "number" ? h.cardYear : null;
    const setName = str(h.setName) || str(h.product);
    const player = str(h.playerName);
    const parallel = str(h.parallel) || null;
    const isAuto = h.isAuto === true;
    const printRun = typeof h.printRun === "number" && h.printRun > 0 ? h.printRun : null;

    const derived = await resolveIdentityFromFields({
      sport,
      year,
      setName: setName || null,
      player: player || null,
      cardNumber: str(h.cardNumber) || null,
      parallel,
      isAuto,
      printRun,
      // CF-THE-USER-SEED-EXEMPTION-WAS-NEVER-REACHED (Drew, 2026-08-25): the
      // user owns the physical card; that is the whole basis of the seed
      // exemption. A vendor source is turned away at the door.
      source: "ebay-user-purchase",
      // D28: the listing title the number was parsed OUT of. Without it the
      // guard cannot tell a card #9 from the "PSA 9" that produced Harrison's.
      title: str(h.ebayListingTitle) || null,
    });
    if (derived.cardNumberResolvedBy === "catalog-player-lookup" && derived.cardNumber) {
      h.cardNumber = derived.cardNumber;
      h.cardNumberResolvedBy = "catalog-player-lookup";
    } else if (derived.cardNumberCandidates.length > 1) {
      h.catalogCardNumberCandidates = derived.cardNumberCandidates;
    }

    // The matcher was never asked (empty number / year / set): the holding
    // stays for review and the checklist is requested.
    if (!derived.match) {
      h.catalogMatchConfidence = 0;
      h.catalogMatchedBy = "not-found";
      h.catalogMatchSlug = null;
      h.catalogMatchSkippedReason = derived.skippedReason;
      await requestSeedForMiss(h);
      return;
    }

    const match = derived.match;
    h.catalogMatchConfidence = match.confidence;
    h.catalogMatchedBy = match.matchedBy ?? null;
    h.catalogMatchSlug = match.slug ?? null;
    // Pin the identity only when the matcher is confident. Below that the
    // slug is a suggestion for the reviewer -- pinning it would send pricing
    // to the wrong card while still showing a value, which reads as correct.
    if (clearsIdentityBar(match)) {
      const now = new Date().toISOString();
      h.cardId = match.slug;
      h.hobbyiqCardId = match.slug;
      h.catalogVerifiedSlug = match.slug;
      h.catalogVerifiedSource = "hobbyiq-catalog";
      h.catalogVerifiedAt = now;
      if (match.matchedBy === "seeded") {
        // We just created the row; the catalog cannot vouch for it yet.
        h.catalogVerifiedReason = "seeded-from-user-purchase";
      } else {
        h.catalogVerified = true;
        h.catalogVerifiedReason = "catalog-match-at-import";
      }
      h.identitySource = "ebay-import-catalog-match";
    }
    if (!match.found) await requestSeedForMiss(h);
  } catch (err) {
    // Never block an import on the matcher — the holding still lands for
    // review, exactly as before.
    console.warn(JSON.stringify({
      event: "ebay_import_catalog_match_failed",
      source: "ebayAutoHolding.service",
      error: (err as Error)?.message ?? String(err),
    }));
  }

  // The title is rebuilt from the RESOLVED identity -- after the match, so it
  // carries the card number the catalog supplied and never drops the finish
  // or the /N. The listing title itself is kept on ebayListingTitle.
  const title = buildCardTitle(h);
  if (title) h.cardTitle = title;
}

// CF-EBAY-MISS-SEEDS-CHECKLIST (Drew, 2026-08-13: "we should get those
// checklists if we are missing them"). A miss on a card the user demonstrably
// owns is the strongest possible signal that a checklist is worth building —
// they paid for it. Deduped per release by checklistSeedQueue.
async function requestSeedForMiss(h: Record<string, unknown>): Promise<void> {
  try {
    const setNameForSeed = str(h.setName) || str(h.product);
    if (!setNameForSeed || typeof h.cardYear !== "number") return;
    const { requestChecklistSeed } = await import("../catalog/checklistSeedQueue.service.js");
    const { normalizeSetKey } = await import("./hobbyIqCardId.service.js");
    await requestChecklistSeed({
      sport: (str(h.sport) || "baseball").toLowerCase(),
      year: h.cardYear,
      setName: setNameForSeed,
      setKey: normalizeSetKey(setNameForSeed),
      reason: "ebay-import-unmatched",
      missingPlayer: str(h.playerName) || undefined,
      missingCardNumber: str(h.cardNumber) || undefined,
    });
  } catch { /* a seed request never blocks an import */ }
}

// ─── The sale ──────────────────────────────────────────────────────────────

/** The purchase record an imported holding was created from, if the doc
 *  still carries it. */
export function sourcePurchaseFor(
  doc: { purchases?: ReadonlyArray<unknown> } | null | undefined,
  holding: { sourcePurchaseId?: unknown } | Record<string, unknown> | null | undefined,
): PortfolioPurchaseEntry | null {
  const id = str(holding?.sourcePurchaseId);
  if (!id) return null;
  const hit = (doc?.purchases ?? []).find((p) => str((p as { id?: unknown })?.id) === id);
  return (hit as PortfolioPurchaseEntry | undefined) ?? null;
}

/**
 * How the price on a purchase-derived sale was arrived at (D38).
 *
 *   subtotal  the item price the seller charged -- what the market paid for
 *             the card. The only basis a comp pool wants.
 *   all-in    purchase.totalCost / holding.purchasePrice: item + shipping +
 *             tax, with no way left to separate them. The buyer's cost basis.
 *   none      no positive price was available at all.
 */
export type SalePriceBasis = "subtotal" | "all-in" | "none";

/**
 * CF-ONE-TRANSACTION-ONE-ROW (D9). The pool identity of a purchase's sale,
 * derived the same way by EVERY writer -- import, confirm, rematch. Three
 * writers had three keys (order id / item id / holding::) and two prices, so
 * one purchase became up to three pool rows.
 *
 *   key    the eBay order line item id -- one per transaction -- else the
 *          item id, else a holding-scoped stand-in.
 *   price  the SUBTOTAL: what the item sold for. Shipping, tax and fees are
 *          the buyer's cost basis (the holding keeps totalCost for P&L), not
 *          the market's price for the card. Every vendor feed in the pool
 *          reports the item price the same way.
 */
export function purchaseSaleIdentity(
  purchase: Pick<PortfolioPurchaseEntry, "ebayOrderId" | "ebayItemId" | "subtotal" | "totalCost"> | null | undefined,
  holding: { id?: unknown; ebayOrderId?: unknown; ebayItemId?: unknown; purchasePrice?: unknown; totalCostBasis?: unknown } | Record<string, unknown>,
): { sourceExternalId: string; price: number; priceBasis: SalePriceBasis } {
  const key = str(purchase?.ebayOrderId) || str(holding.ebayOrderId)
    || str(purchase?.ebayItemId) || str(holding.ebayItemId)
    || `holding::${str(holding.id)}`;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

  // CF-A-SUBTOTAL-NEVER-REGRESSES-TO-ALL-IN (D38, 2026-08-30). The price and
  // the DERIVATION of the price are returned together, because the pool row's
  // id does not depend on the price and the store's upsert is price-blind.
  // Any later writer that reaches this function without the purchase record
  // -- a confirm whose sourcePurchaseFor() finds nothing, a rematch on a doc
  // whose purchases array was trimmed -- lands on the SAME doc id and would
  // otherwise silently overwrite 295.95 (the market's price) with 301.43 (the
  // buyer's all-in basis). The basis travels with the price so the store can
  // refuse that specific regression; see keepsExistingPrice() there.
  const subtotal = num(purchase?.subtotal);
  if (subtotal) return { sourceExternalId: key, price: subtotal, priceBasis: "subtotal" };

  const totalCost = num(purchase?.totalCost)
    || num(holding.purchasePrice) || num(holding.totalCostBasis);
  // ALL-IN: shipping and tax are inside this number and cannot be removed --
  // the components are unknowable from here. It is a usable price when it is
  // the only one there is, and it is never an upgrade over a subtotal.
  return { sourceExternalId: key, price: totalCost, priceBasis: totalCost ? "all-in" : "none" };
}

// CF-A-REAL-SALE-IS-IN-THE-POOL-ONCE (Drew, 2026-08-29, checklist D7a):
// "these are real sales, so we need to treat them as such but ensure there
// aren't duplicates in the system." The eBay ids travel onto the holding, and
// the purchase is written to the pool NOW through the one writer, under the
// slug the holding was just pinned to. recordSoldComp dedupes on id and on
// content hash and returns the row's id; the holding links to it.
async function recordImportSale(
  holding: PortfolioHolding & Record<string, unknown>,
  purchase: PortfolioPurchaseEntry,
  doc: AutoHoldingDocShape,
): Promise<void> {
  const h = holding as Record<string, unknown>;
  if (purchase.ebayItemId) h.ebayItemId = purchase.ebayItemId;
  if (purchase.ebayOrderId) h.ebayOrderId = purchase.ebayOrderId;
  const slug = typeof h.cardId === "string" && h.cardId.startsWith("hiq:") ? h.cardId : null;
  const { sourceExternalId, price, priceBasis } = purchaseSaleIdentity(purchase, h);
  const soldAt = str(h.purchaseDate) || str(purchase.purchaseDate);
  if (!slug || price <= 0 || !soldAt || !str(h.playerName)) return;
  try {
    const { recordSoldComp } = await import("./soldCompsStore.service.js");
    const res = await recordSoldComp({
      cardId: slug,
      // D38: the holding was just pinned to this slug; hand it over as the
      // ruled identity so the store verifies it rather than recomputing one.
      pinnedHobbyIqCardId: slug,
      playerName: str(h.playerName),
      cardYear: typeof h.cardYear === "number" ? h.cardYear : null,
      setName: str(h.setName) || null,
      parallel: str(h.parallel) || null,
      cardNumber: str(h.cardNumber) || null,
      isAuto: h.isAuto === true,
      printRun: typeof h.printRun === "number" && h.printRun > 0 ? h.printRun : null,
      gradeCompany: str(h.gradeCompany) || null,
      gradeValue: typeof h.gradeValue === "number" ? h.gradeValue : null,
      sport: (str(h.sport) || "baseball").toLowerCase(),
      price,
      priceBasis,
      soldAt,
      source: "ebay-user-purchase",
      sourceExternalId,
      contributorUserId: ((doc as { userId?: string }).userId ?? null) as string | null,
      title: str(purchase.notes) || null,
      imageUrl: str(h.ebayImageUrl) || null,
      sellerHandle: null,
      verifiedByUser: false,
      confidence: Number(h.parseConfidence ?? 0.7),
    });
    if (res?.written) {
      h.soldCompId = res.id ?? null;
      h.soldCompDeduped = res.deduped === true;
      h.soldCompSlug = res.hobbyiqCardId ?? slug;
      if (res.hobbyiqCardId && res.hobbyiqCardId !== slug) {
        // The pool resolves through the same matcher with the same inputs, so
        // this cannot happen quietly: it means the two derivations diverged.
        console.warn(JSON.stringify({
          event: "ebay_import_sale_slug_disagrees",
          source: "ebayAutoHolding.service",
          holdingId: holding.id,
          holdingSlug: slug,
          poolSlug: res.hobbyiqCardId,
        }));
      }
    }
    console.log(JSON.stringify({
      event: "ebay_import_sale_recorded",
      source: "ebayAutoHolding.service",
      holdingId: holding.id,
      slug,
      sourceExternalId,
      price,
      written: res?.written ?? false,
      deduped: res?.deduped ?? false,
      reason: res?.reason ?? null,
    }));
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_import_sale_record_failed",
      source: "ebayAutoHolding.service",
      holdingId: holding.id,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

// ─── Holding construction ──────────────────────────────────────────────────

function buildHoldingFromParse(
  purchase: PortfolioPurchaseEntry,
  parsed: ParsedListingTitle,
): PortfolioHolding & Record<string, unknown> {
  // Per-item cost: split the full totalCost across the eBay Quantity. For
  // single-item transactions (most eBay purchases of individual cards),
  // quantity = 1 and this collapses to purchase.totalCost.
  //
  // We don't preserve tax/shipping breakdown on the holding — the source
  // purchase already carries those, and the auto-created holding's
  // totalCostBasis is the all-in per-unit cost for realized-P&L math.
  const perItemAllIn = purchase.totalCost;

  const gradeValue = parsed.grade ? extractGradeValue(parsed.grade) : undefined;

  // We build with `as any` for the ebay-auto specific fields since the
  // PortfolioHolding interface doesn't declare them yet — additive
  // schema, existing readers unaffected.
  const holding: PortfolioHolding & Record<string, unknown> = {
    id: randomUUID(),
    quantity: 1,
    purchasePrice: perItemAllIn,
    totalCostBasis: perItemAllIn,
    purchaseDate: purchase.purchaseDate,
    lastUpdated: new Date().toISOString(),
    notes: `Auto-imported from eBay purchase (confidence ${parsed.parseConfidence.toFixed(2)})`,
    // Vendor becomes purchaseSource so downstream "where did this come
    // from" reads work without a join.
    purchaseSource: `ebay:${purchase.vendor ?? "unknown"}`,
    // Additive fields NOT declared on the PortfolioHolding interface —
    // written via the Record<string, unknown> escape hatch so we don't
    // need a type migration to ship the ebay-auto marker set.
    addedAt: purchase.purchaseDate,
    // CF-EBAY-REVIEW-QUEUE (2026-07-12): auto-imports land in the review
    // queue, not live inventory. The user confirms each row (with any
    // corrections) via POST /erp/holdings/:id/confirm before it becomes
    // active. This is the trust boundary: parser + Browse are best-effort,
    // the user is ground truth. Corrections train the backend.
    cardStatus: "pending-review",
    source: "ebay-auto",
    sourcePurchaseId: purchase.id,
    parseConfidence: parsed.parseConfidence,
    needsReview: parsed.parseConfidence < NEEDS_REVIEW_MAX,
  };

  // Populate parsed fields when present. Every parsed field can legitimately
  // be absent — writer converts each to undefined so the response shape
  // stays additive.
  if (parsed.year !== null) holding.cardYear = parsed.year;
  if (parsed.playerName) holding.playerName = parsed.playerName;
  if (parsed.setName) {
    holding.setName = parsed.setName;
    holding.product = parsed.setName;   // dual-populate for downstream readers
  }
  if (parsed.parallel) holding.parallel = parsed.parallel;
  if (parsed.cardNumber) holding.cardNumber = parsed.cardNumber;
  if (parsed.gradeCompany) {
    holding.gradeCompany = parsed.gradeCompany;
    holding.gradingCompany = parsed.gradeCompany;   // legacy field alias
  }
  if (gradeValue !== undefined) holding.gradeValue = gradeValue;
  // CF-ONE-IMPORT-ONE-IDENTITY (D9): the print run the title states travels on
  // the holding, so every later re-derivation of its slug keeps the :num-N
  // segment (CF-ACCEPT-CARRIES-PRINTRUN). The listing title itself is kept
  // verbatim; cardTitle is rebuilt from the resolved identity afterwards.
  if (typeof parsed.printRun === "number" && parsed.printRun > 0) holding.printRun = parsed.printRun;
  if (purchase.notes) holding.ebayListingTitle = purchase.notes;
  const provisionalTitle = buildCardTitle(holding);
  if (provisionalTitle) holding.cardTitle = provisionalTitle;
  // CF-EBAY-AUTO-DETECTION (2026-07-12): isAuto is a declared field on
  // PortfolioHolding — populated when the parser flagged the title as
  // an autograph. Rookie signal preserved on notes (no dedicated boolean).
  if (parsed.isAuto) holding.isAuto = true;
  if (parsed.isRookie) {
    holding.notes = `${holding.notes} · rookie`;
  }

  return holding;
}

/**
 * CF-ONE-IMPORT-ONE-IDENTITY (D9). The card title is a rendering of the
 * holding's identity fields -- the finish, the card number and the print run
 * included -- never a rebuild that drops them. "2026 Bowman Chrome Refractor
 * Marconi German" was what this produced for a Gold Refractor /50.
 */
function buildCardTitle(fields: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof fields.cardYear === "number") parts.push(String(fields.cardYear));
  if (str(fields.setName)) parts.push(str(fields.setName));
  if (str(fields.parallel)) parts.push(str(fields.parallel));
  if (str(fields.playerName)) parts.push(str(fields.playerName));
  if (str(fields.cardNumber)) parts.push(`#${str(fields.cardNumber)}`);
  if (typeof fields.printRun === "number" && fields.printRun > 0) parts.push(`/${fields.printRun}`);
  if (fields.isAuto === true) parts.push("Auto");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractGradeValue(grade: string): number | undefined {
  const m = grade.match(/([\d.]+)$/);
  return m ? Number(m[1]) : undefined;
}

// ─── CF-EBAY-BROWSE-ENRICHMENT (2026-07-12) ────────────────────────────────
//
// Merge Browse API item detail data into a title-parsed holding. Browse data
// is AUTHORITATIVE for grader / grade / autograph flag / condition (structured
// item specifics beat title-string parsing). Aspects the parser couldn't get
// are backfilled here. Images + description are added for iOS render + future
// eBay-relisting flow.

const NORMALIZED_GRADER_MAP: Record<string, "PSA" | "BGS" | "SGC" | "CGC"> = {
  psa: "PSA",
  "professional sports authenticator (psa)": "PSA",
  "professional sports authenticator": "PSA",
  bgs: "BGS",
  "beckett grading services (bgs)": "BGS",
  "beckett grading services": "BGS",
  beckett: "BGS",
  sgc: "SGC",
  "sports guaranty company": "SGC",
  "sports guaranty co (sgc)": "SGC",
  cgc: "CGC",
  "certified guaranty company (cgc)": "CGC",
};

function normalizeGraderCompany(s: string | null): "PSA" | "BGS" | "SGC" | "CGC" | null {
  if (!s) return null;
  const lower = s.toLowerCase().trim();
  return NORMALIZED_GRADER_MAP[lower] ?? null;
}

function parseGradeValueLoose(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
}

export function applyBrowseEnrichment(
  holding: PortfolioHolding & Record<string, unknown>,
  details: EbayItemDetails,
): void {
  const aspects = details.aspects ?? {};

  // ── Grader + grade: authoritative from Browse if present ──────────
  const grader = normalizeGraderCompany(details.grader) ?? normalizeGraderCompany(aspects["Professional Grader"] ?? null);
  const graded = grader !== null || (details.condition ?? "").toLowerCase() === "graded";
  if (grader) {
    holding.gradeCompany = grader;
    holding.gradingCompany = grader;   // legacy alias
  }
  const gradeVal = parseGradeValueLoose(details.grade) ?? parseGradeValueLoose(aspects["Grade"] ?? null);
  if (gradeVal !== undefined) {
    holding.gradeValue = gradeVal;
  }
  // CF-CERT-CAPTURE (Drew, 2026-07-20). Promote the seller-typed
  // certification number into a structured holding field so re-listing
  // that same graded card doesn't force the user to type it in again.
  // eBay uses several field names for this depending on category —
  // check the common ones.
  const certRaw =
    aspects["Certification Number"] ??
    aspects["Cert Number"] ??
    aspects["Certification"] ??
    null;
  if (certRaw && typeof certRaw === "string") {
    const cert = certRaw.trim();
    if (cert.length > 0 && cert.length <= 32) {
      (holding as Record<string, unknown>).certNumber = cert;
    }
  }
  // If Browse says Ungraded explicitly, clear a title-parsed grade so we
  // don't lie about it. Title regex sometimes picks up spurious "PSA 10"
  // in seller marketing copy that isn't a real slab.
  if (!graded && details.condition && details.condition.toLowerCase().includes("ungraded")) {
    holding.gradeCompany = undefined;
    holding.gradingCompany = undefined;
    holding.gradeValue = undefined;
    (holding as Record<string, unknown>).certNumber = undefined;
  }

  // ── Autograph: Browse aspect authoritative ────────────────────────
  const autoAspect = aspects["Autographed"] ?? aspects["Autograph"];
  if (autoAspect !== undefined) {
    const yes = /^(y|yes|true)$/i.test(autoAspect);
    holding.isAuto = yes;
  }

  // ── Structured aspects: Browse is AUTHORITATIVE, not backfill ──────
  //
  // The title parser scrapes free-text ("2020 Panini Prizm Mookie Betts
  // #275") and gets things like "Baseball Owen Carey" or "Ernie Banks
  // Chicago Cubs" — team names, sport names, and vertical markers leak
  // into playerName because the title's word order is unpredictable.
  // Browse's structured Player aspect is what the SELLER typed into the
  // eBay item-specifics form: it's clean.
  //
  // Policy: when Browse has the structured field, override the title-
  // parsed value. Title parse is the FALLBACK, not the truth.
  //
  // Undecorated exception: cardNumber. Browse "Card Number" is often
  // just the base number (e.g., "14") when the parallel-specific code
  // ("BCP-14") is what the title carries — preserve title's when present.
  if (aspects["Player"]) holding.playerName = aspects["Player"];
  else if (aspects["Player/Athlete"]) holding.playerName = aspects["Player/Athlete"];
  if (aspects["Team"]) (holding as any).team = aspects["Team"];
  if (aspects["Sport"]) (holding as any).sport = aspects["Sport"];
  if (aspects["Season"]) {
    const y = Number(aspects["Season"]);
    if (Number.isFinite(y) && y >= 1900) holding.cardYear = y;
  }
  if (aspects["Set"]) {
    holding.setName = aspects["Set"];
    holding.product = aspects["Set"];
  }
  if (aspects["Manufacturer"]) {
    (holding as any).manufacturer = aspects["Manufacturer"];
  }
  // CF-ASPECT-IS-NOT-A-PARALLEL (Drew, 2026-08-18: "i am seeing a lot of
  // refractors turned into base cards ... the name itself is not matching
  // from ebay").
  //
  // eBay's Parallel/Variety aspect is SELLER-TYPED, and sellers routinely put
  // the PRODUCT there. This blindly overwrote the title parse — which had
  // already got it right on line ~353 — and the real parallel was discarded:
  //
  //   "2025 Bowman Chrome Refractor Max Williams"    aspect "Chrome"  (was Refractor)
  //   "2026 Topps Chrome Yellow Parallel K. Griffin" aspect "Chrome"  (was Yellow)
  //   "2026 Bowman Blue Blaine Bullard Logo Pattern" aspect "Chrome"  (was Blue)
  //   "2026 Bowman Sapphire Numbered Owen Carey"     aspect "Numbered"
  //
  // Downstream, holdingFieldNormalizer correctly rejects "Chrome" as not a
  // parallel and nulls it — and a null parallel renders as `base`. So a
  // Refractor arrives already amputated and gets priced against base comps.
  // Six of Drew's holdings were in this state.
  //
  // The aspect is still USEFUL — it is the only structured signal when a title
  // omits the parallel. So keep it, but only when it survives normalization as
  // a real parallel. If the normalizer would discard it, the title parse is
  // the better source and must not be clobbered.
  const rawAspectParallel = aspects["Parallel/Variety"];
  if (rawAspectParallel) {
    const { fields: probe } = normalizeHoldingFields({
      playerName: holding.playerName ?? null,
      cardYear: holding.cardYear ?? null,
      setName: holding.setName ?? null,
      parallel: rawAspectParallel,
      cardNumber: holding.cardNumber ?? null,
      isAuto: holding.isAuto ?? null,
      product: holding.product ?? null,
    });
    const survives = typeof probe.parallel === "string" && probe.parallel.trim() !== "";
    if (survives) {
      holding.parallel = probe.parallel as string;
    } else if (!holding.parallel) {
      // Nothing from the title either — leave it unset rather than storing a
      // product word that will silently become `base`.
      console.log(JSON.stringify({
        event: "ebay_aspect_parallel_rejected",
        source: "ebayAutoHolding",
        aspect: rawAspectParallel,
        title: holding.cardTitle ?? null,
        note: "aspect is not a parallel; kept title-parsed value",
      }));
    }
  }
  // CF-NORMALISE-FINAL-PARALLEL (2026-08-22). The block above normalises the
  // eBay ASPECT only. A title-parsed parallel never went through
  // holdingFieldNormalizer at all, so raw scraped strings reached Cosmos and
  // could never match a catalog row:
  //
  //   "ChromeProspectAutographsBlueRefractor"   "ChromeProspectAutographRefractor"
  //   "Chrome Prospects Mojo Black Refractor"   "[Base]"   "NONE"   "Logofractor"
  //   "Gold Prizm Missing Serial Number"
  //
  // One of them was baked into a slug:
  //   hiq:baseball:2025:draft:cpa-dc:chromeprospectautographgoldrefractor:auto
  //
  // holdingFieldNormalizer is THE cleaning standard; applying it to one branch
  // instead of to the value we actually store is the same scope error that
  // produced the Kurtz and Caglianone bugs. Normalise the FINAL value here.
  //
  // Note this can only IMPROVE or clear the parallel. If normalisation rejects
  // the string outright we keep it rather than silently dropping to base —
  // a wrong-but-present parallel is reviewable, an amputated one is invisible
  // (that amputation is exactly what PR #1141 fixed for the aspect path).
  if (typeof holding.parallel === "string" && holding.parallel.trim() !== "") {
    const before = holding.parallel;
    const { fields: cleaned } = normalizeHoldingFields({
      playerName: holding.playerName ?? null,
      cardYear: holding.cardYear ?? null,
      setName: holding.setName ?? null,
      parallel: before,
      cardNumber: holding.cardNumber ?? null,
      isAuto: holding.isAuto ?? null,
      product: holding.product ?? null,
    });
    const cleanedParallel = typeof cleaned.parallel === "string" ? cleaned.parallel.trim() : "";
    if (cleanedParallel !== "" && cleanedParallel !== before) {
      console.log(JSON.stringify({
        event: "ebay_final_parallel_normalised",
        source: "ebayAutoHolding",
        before,
        after: cleanedParallel,
        title: holding.cardTitle ?? null,
      }));
      holding.parallel = cleanedParallel;
    } else if (cleanedParallel === "") {
      console.log(JSON.stringify({
        event: "ebay_final_parallel_unrecognised",
        source: "ebayAutoHolding",
        parallel: before,
        title: holding.cardTitle ?? null,
        note: "normalizer did not recognise it; KEPT as-is so it stays reviewable rather than becoming base",
      }));
    }
  }

  if (aspects["Card Number"] && !holding.cardNumber) {
    holding.cardNumber = aspects["Card Number"];
  }

  // ── Images: primary + additionals into holding.photos[] ───────────
  const imageUrls = [details.images.primary, ...details.images.additional].filter(
    (u): u is string => !!u,
  );
  if (imageUrls.length > 0) {
    // Backend already treats `photos` as the canonical image list.
    (holding as any).photos = imageUrls;
    (holding as any).ebayImageUrl = imageUrls[0];
  }

  // ── Description + item specifics for iOS + eBay relisting flow ────
  if (details.shortDescription) {
    (holding as any).ebayShortDescription = details.shortDescription;
  }
  if (Object.keys(aspects).length > 0) {
    (holding as any).ebayItemAspects = aspects;
  }
  if (details.categoryPath) {
    (holding as any).ebayCategoryPath = details.categoryPath;
  }
  if (details.seller) {
    (holding as any).ebaySeller = details.seller;
  }

  // ── Bump the parse confidence + drop needs-review when Browse data ──
  // provided the grader/grade/aspects the title couldn't. Confidence 0.95
  // is the "eBay confirmed" tier — the browse data is structured, not
  // parsed — so iOS's needs-review prompt drops away.
  const gotStructuredData = Object.keys(aspects).length > 0 || grader !== null || gradeVal !== undefined;
  if (gotStructuredData) {
    const priorConf = (holding as any).parseConfidence as number | undefined;
    (holding as any).parseConfidence = Math.max(priorConf ?? 0, 0.95);
    (holding as any).needsReview = false;
    (holding as any).enrichedFromEbay = true;
  }

  holding.lastUpdated = new Date().toISOString();
}
