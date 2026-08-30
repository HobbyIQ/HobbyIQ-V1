// CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, Drew 2026-08-30).
//
// "when we sync sold ebay data directly from the account for reconciliation
// and for processing, not sure it is working at all … and it needs to link to
// cards even if we didn't list from the app."
//
// It was not working. The hourly poll matched a sold line item to a holding
// ONLY by our own listing id (`findHoldingByEbayListingIdAcrossUsers`), so a
// card the user listed on eBay directly could never match. Measured at 07:46Z
// 2026-08-30, unchanged from the spec's 03:15Z reading: `users=8 orders=29
// matched=0 noMatch=29 fetchFail=2 cursorsAdvanced=0`, 5,849
// `ebay_poll_no_matching_holding` events in three days over 29 distinct
// listings, the same ones every hour, forever — because the cursor advanced
// only from MATCHED orders, and nothing ever matched. `lastPolledAt` is null
// on all eight connection docs: it has never advanced for anyone, ever.
//
// This module is the missing step. A sold line item carries a listing title,
// and a listing title is exactly what the eBay IMPORT already turns into a
// catalog identity. So this asks the same question through the same path
// (`parseListingTitle` -> `normalizeHoldingFields` -> `resolveIdentityFromFields`
// -> the catalog matcher), which means D28's card-number guard and D23's
// hyphen-insensitive number compare apply here without a second copy of
// either. It is pure with respect to storage: it resolves, it does not write.
//
// ONE THING IS DELIBERATELY DIFFERENT from the import. The matcher is asked as
// `ebay-title`, NOT as `ebay-user-sale`. `ebay-title` is in neither
// TRUSTED_SOURCES nor USER_SEED_ALLOWED_SOURCES in catalogMatcher, so a miss
// returns `not-found` instead of minting a row. That is Drew's guardrail
// stated in the type system rather than in a comment: an account sale that
// resolves to no catalog card PARKS with its best candidate for the user's
// confirm and joins the acquisition list. A sale never mints a card.

import {
  parseListingTitle,
  type ParsedListingTitle,
} from "../portfolioiq/ebayTitleParser.service.js";
import { applyBrowseEnrichment } from "../portfolioiq/ebayAutoHolding.service.js";
import { normalizeHoldingFields } from "../portfolioiq/holdingFieldNormalizer.service.js";
import {
  resolveIdentityFromFields,
  clearsIdentityBar,
  identityPinMinConfidence,
  type IdentityFromFields,
} from "../portfolioiq/identityFromFields.js";
import type { EbayItemDetails } from "./ebayItemDetails.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

/** What the poll knows about one sold order line before it resolves it. */
export interface EbaySoldLine {
  /** The listing title. The ONLY required input — everything else refines it. */
  title: string | null;
  /** Browse item specifics when the caller prefetched them. Authoritative over
   *  the title parse for player / set / grade / autograph, exactly as on the
   *  purchase side (`applyBrowseEnrichment`). */
  details?: EbayItemDetails | null;
}

export type EbaySaleResolution =
  /** >= the identity bar. The slug may be written as the sale's identity. */
  | "auto"
  /** The matcher answered below the bar. The slug is a CANDIDATE for the
   *  user's confirm, never an identity. */
  | "parked"
  /** No usable answer at all: no title, not a card, or the matcher was never
   *  asked (no number / year / set). */
  | "unresolvable";

export interface EbaySaleIdentity {
  resolution: EbaySaleResolution;
  /** The catalog slug. On "auto" it is the identity; on "parked" it is the
   *  proposal; on "unresolvable" it is null. */
  slug: string | null;
  confidence: number | null;
  matchedBy: string | null;
  /** Why nothing was resolvable. Null when the matcher was asked. */
  reason: EbaySaleUnresolvableReason | null;
  /** The cleaned fields the matcher was asked with — the poll writes these on
   *  the sale record so the user's confirm screen shows what we read. */
  fields: EbaySaleFields;
  /** The raw title parse, for the caller's own filters + telemetry. */
  parsed: ParsedListingTitle;
  /** The derivation's own answer, for callers that need the card-number
   *  provenance (`cardNumberResolvedBy`, the ambiguous candidates). */
  derived: IdentityFromFields | null;
}

export type EbaySaleUnresolvableReason =
  | "no-title"
  | "not-a-card"
  | "no-card-number"
  | "no-year"
  | "no-set"
  | "matcher-error";

export interface EbaySaleFields {
  sport: string;
  year: number | null;
  setName: string | null;
  player: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  printRun: number | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  imageUrl: string | null;
}

/** CF-CARDS-ONLY-FILTER, shared in spirit with ebayAutoHolding: a portfolio
 *  sale is a CARD. A sealed box, a break slot, a jersey or a toploader is a
 *  real sale of a real thing, and it is not a comp for any card. Same word
 *  lists as the purchase side — kept here rather than imported because the
 *  purchase side applies them to `purchase.notes` inside a larger decision. */
const SEALED_OR_BREAK_RE =
  /\bbreak\b|\brandom\s+(team|div|hit|slot|player)|\bteam\s+(spot|slot|break)|\bhobby\s+box|\bjumbo\s+box|\bmega\s+box|\bblaster|\bhanger\s+box|\bretail\s+box|\bpyt\b|\bpick\s+your\s+team|\bteam\s+random|\(b\d+\)|\bbox\s+break|\bcase\s+break|\bpersonal\s+break|\bhobby\s+case|\bfactory\s+sealed\s+box|\bwax\s+box|\bcello\s+pack|\bfat\s+pack|\bvalue\s+pack/i;
const MEMORABILIA_RE =
  /\b(hat|cap|jersey|jerseys|t\s?-?\s?shirt|hoodie|sweatshirt|sweater|pants|shorts|shoe|shoes|sneaker|sneakers|helmet|glove|gloves|bat|ball(?!\s+(rookie|card))|puck|photo\s+print|poster|banner|flag|mug|cup|coin|patch|pin\b|button|bobblehead|figure|figurine|statue|replica|ring|chain|necklace|pendant|watch|bag|backpack|wallet|mask|towel|blanket|pillow|magnet(?!ic)|sticker|decal|keychain|keyring|lanyard|autographed\s+(jersey|hat|cap|bat|ball|helmet|photo|poster|puck))\b/i;
const SUPPLY_RE =
  /\b(top\s?-?loader|toploader|penny\s+sleeve|penny\s+sleeves|team\s+bag|team\s+bags|semi\s?-?rigid|semirigid|magnetic\s+(holder|case)|one\s?-?touch|screwdown|screw\s+down|card\s+saver|card\s+savers|binder|album|storage\s+box|monster\s+box|card\s+sleeve|card\s+sleeves|ultra\s+pro|ultrapro|display\s+case|display\s+stand|graded\s+slab\s+case|grading\s+kit|deck\s+box)\b/i;

const str = (v: unknown): string => String(v ?? "").trim();

/** True when the title sells something that is not a single trading card. */
export function isNotACardTitle(title: string): boolean {
  return SEALED_OR_BREAK_RE.test(title) || MEMORABILIA_RE.test(title) || SUPPLY_RE.test(title);
}

/** Injection seam — the one catalog read this resolution performs. */
export interface EbaySaleIdentityDeps {
  resolveIdentityFromFields: typeof resolveIdentityFromFields;
}
const DEFAULT_DEPS: EbaySaleIdentityDeps = { resolveIdentityFromFields };

function emptyFields(): EbaySaleFields {
  return {
    sport: "baseball",
    year: null,
    setName: null,
    player: null,
    cardNumber: null,
    parallel: null,
    isAuto: false,
    printRun: null,
    gradeCompany: null,
    gradeValue: null,
    imageUrl: null,
  };
}

/**
 * Resolve one sold eBay line item to a catalog card.
 *
 * Never throws: a matcher failure is `unresolvable` with reason
 * `matcher-error`, because a poll that dies on one bad title stops advancing
 * its cursor for every other order in the batch — which is the failure mode
 * D26 exists to end.
 */
export async function resolveEbaySaleIdentity(
  line: EbaySoldLine,
  deps: EbaySaleIdentityDeps = DEFAULT_DEPS,
): Promise<EbaySaleIdentity> {
  const title = str(line.title);
  const parsed = parseListingTitle(title);
  const base = {
    slug: null,
    confidence: null,
    matchedBy: null,
    parsed,
    derived: null,
  } as const;

  if (!title) {
    return { ...base, resolution: "unresolvable", reason: "no-title", fields: emptyFields() };
  }
  if (!parsed.playerName || isNotACardTitle(title)) {
    return { ...base, resolution: "unresolvable", reason: "not-a-card", fields: emptyFields() };
  }

  // Build the same shape the import builds, so Browse item specifics enrich it
  // through the SAME function (`applyBrowseEnrichment`) rather than a second
  // aspect reader that would drift from it.
  const shape: Record<string, unknown> = {
    id: "ebay-account-sale",
    playerName: parsed.playerName,
    cardYear: parsed.year,
    setName: parsed.setName,
    product: parsed.setName,
    parallel: parsed.parallel,
    cardNumber: parsed.cardNumber,
    isAuto: parsed.isAuto,
    printRun: parsed.printRun ?? null,
    gradeCompany: parsed.gradeCompany,
    gradeValue: parsed.grade ? parseGradeValue(parsed.grade) : undefined,
    ebayListingTitle: title,
  };
  if (line.details) {
    try {
      applyBrowseEnrichment(shape as unknown as PortfolioHolding & Record<string, unknown>, line.details);
    } catch {
      // Enrichment is a refinement, never a gate. A malformed aspects map
      // leaves the title parse standing.
    }
  }

  // The one cleaning standard (holdingFieldNormalizer is THE standard), applied
  // to every field we are about to match on — not to one branch of them.
  const { fields: clean } = normalizeHoldingFields({
    playerName: str(shape.playerName) || null,
    cardYear: typeof shape.cardYear === "number" ? shape.cardYear : null,
    setName: str(shape.setName) || null,
    parallel: str(shape.parallel) || null,
    cardNumber: str(shape.cardNumber) || null,
    isAuto: typeof shape.isAuto === "boolean" ? shape.isAuto : null,
    product: str(shape.product) || null,
  });

  const fields: EbaySaleFields = {
    sport: (str(shape.sport) || "baseball").toLowerCase(),
    year: typeof clean.cardYear === "number" ? clean.cardYear : (typeof shape.cardYear === "number" ? shape.cardYear : null),
    setName: str(clean.setName) || str(shape.setName) || null,
    player: str(clean.playerName) || str(shape.playerName) || null,
    cardNumber: str(clean.cardNumber) || str(shape.cardNumber) || null,
    // Only ever improve the parallel; an unrecognised one stays as given
    // rather than silently becoming Base (feedback_slug_recompute_only_improve).
    parallel: str(clean.parallel) || str(shape.parallel) || null,
    isAuto: shape.isAuto === true || clean.isAuto === true,
    printRun: typeof shape.printRun === "number" && shape.printRun > 0 ? shape.printRun : null,
    gradeCompany: str(shape.gradeCompany) || null,
    gradeValue: typeof shape.gradeValue === "number" ? shape.gradeValue : null,
    imageUrl: line.details?.images?.primary ?? null,
  };

  let derived: IdentityFromFields;
  try {
    derived = await deps.resolveIdentityFromFields({
      sport: fields.sport,
      year: fields.year,
      setName: fields.setName,
      player: fields.player,
      cardNumber: fields.cardNumber,
      parallel: fields.parallel,
      isAuto: fields.isAuto,
      printRun: fields.printRun,
      // NEVER a seeding source. See the header: a sale does not mint a card.
      source: "ebay-title",
      // D28: the listing title the number was parsed OUT of. Without it
      // `judgeCardNumber` cannot tell a card #9 from the "PSA 9" that gave
      // Harrison's holding its number.
      title,
    });
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_account_sale_identity_failed",
      source: "ebayAccountSaleIdentity.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return { ...base, resolution: "unresolvable", reason: "matcher-error", fields };
  }

  // The card number the derivation actually used — the catalog's by-player
  // answer when the title never stated one, or the one D28's guard kept.
  if (derived.cardNumber) fields.cardNumber = derived.cardNumber;
  if (derived.parallelResolvedAs) fields.parallel = derived.parallelResolvedAs;

  if (!derived.match) {
    return {
      resolution: "unresolvable",
      slug: null,
      confidence: null,
      matchedBy: null,
      reason: derived.skippedReason ?? "matcher-error",
      fields,
      parsed,
      derived,
    };
  }

  const match = derived.match;
  const slug = match.slug ?? null;
  const confidence = typeof match.confidence === "number" ? match.confidence : null;
  const matchedBy = match.matchedBy ?? null;

  // The >= 0.9 bar every adoption site reads. Above it the slug is identity;
  // below it, it is a proposal — pinning a weak match would price the sale
  // against the wrong card while looking confirmed.
  if (clearsIdentityBar(match)) {
    return { resolution: "auto", slug, confidence, matchedBy, reason: null, fields, parsed, derived };
  }
  if (slug) {
    return { resolution: "parked", slug, confidence, matchedBy, reason: null, fields, parsed, derived };
  }
  return { resolution: "unresolvable", slug: null, confidence, matchedBy, reason: "matcher-error", fields, parsed, derived };
}

/** "PSA 10" / "BGS 9.5" -> 10 / 9.5. Undefined when there is no number, so a
 *  caller can tell "no grade stated" from "graded 0". */
function parseGradeValue(grade: string | null | undefined): number | undefined {
  const m = String(grade ?? "").match(/(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

export { identityPinMinConfidence };
