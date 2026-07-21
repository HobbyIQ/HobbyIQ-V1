/**
 * eBay Sell API listing service.
 *
 * Uses the eBay Inventory + Offer APIs (RESTful Sell APIs).
 * Sequence for a new listing:
 *   1. createOrReplaceInventoryItem   — sets the physical item details
 *   2. createOrUpdateOffer            — sets pricing, category, policies
 *   3. publishOffer                   — makes it live; returns listingId
 *
 * Required env vars (beyond those in ebayAuth.service.ts):
 *   EBAY_MARKETPLACE_ID              — default "EBAY_US"
 *   EBAY_SPORTS_CARDS_CATEGORY_ID    — default "261328" (Sports Trading Cards)
 *
 * Seller business policies (payment / return / fulfillment) are fetched
 * inline from the authenticated user's eBay account at preview/publish
 * time. There are NO env-var fallbacks — multi-user app means each user
 * lists under their own seller policies. See resolveSellerPolicies().
 */

import { getAccessToken, EBAY_BASE_API } from "./ebayAuth.service.js";

// ---------------------------------------------------------------------------
// Types matching the iOS PortfolioHolding fields the app will send
// ---------------------------------------------------------------------------

export interface HoldingListingInput {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  cardYear: number;
  brand: string;
  setName: string;
  product: string;
  sport?: string;
  cardNumber?: string;
  parallel?: string;
  serialNumber?: string;
  printRun?: number;
  isAuto: boolean;
  isPatch: boolean;
  isRookie: boolean;
  variation?: string;
  /** CF-EBAY-REVIEW-QUEUE (2026-07-12): Team surfaces on eBay Browse
   *  aspects for graded/raw cards. When present, we forward it as an
   *  item specific so relisted cards carry the same "Team" the buyer
   *  originally saw. Silent skip when empty. */
  team?: string;
  // Graded
  grade?: string;
  gradingCompany?: string;
  certNumber?: string;
  // Raw
  conditionNotes?: string;
  conditionEstimate?: string;
  // Listing params
  quantity: number;
  listingPrice: number;
  bestOfferEnabled: boolean;
  bestOfferMinPrice?: number;
  imageFrontUrl?: string;
  imageBackUrl?: string;
  /** CF-INVENTORY-PHOTOS-TO-LISTING (2026-07-05, Drew): the full photo
   *  array from the holding. When present, buildImages() merges these
   *  with imageFrontUrl/imageBackUrl (dedup + preserved order:
   *  front → back → remaining photos), respects the eBay
   *  MAX_LISTING_PHOTOS cap, and produces the multi-image gallery.
   *  Optional — the two-URL wire shape stays fully backward-compatible. */
  photos?: string[];
  description?: string;
  /** CF-EBAY-ASPECTS-MERGE (Drew, 2026-07-20). Pre-captured item aspects
   *  from the eBay Browse enrichment when the holding was first imported.
   *  Carries the required-by-eBay-category aspects (League, Type,
   *  Country/Region of Manufacture, Year Manufactured, etc.) that the
   *  base holding fields don't have. buildItemAspects merges these as
   *  the base and lets our computed fields (Player, Team, Set, Card
   *  Number, Parallel/Variety, Autographed) override where they overlap. */
  ebayItemAspects?: Record<string, string>;
  // Seller-side overrides (optional; if any one is provided, all three
  // must be provided — partial overrides are rejected by
  // resolveSellerPolicies. When none are provided, the user's eBay
  // account default policies are fetched inline.)
  categoryId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  fulfillmentPolicyId?: string;
}

export type SellerPolicyType = "payment" | "return" | "fulfillment";

export type MissingSellerPolicyReason =
  | "none_configured"
  | "no_default_among_multiple";

/**
 * Thrown when the authenticated user's eBay account does not yield a
 * usable policy id for a given type. iOS renders a specific message per
 * (policyType, reason) pair so the user can fix it in eBay Seller Hub.
 */
export class MissingSellerPolicyError extends Error {
  public readonly policyType: SellerPolicyType;
  public readonly reason: MissingSellerPolicyReason;
  constructor(policyType: SellerPolicyType, reason: MissingSellerPolicyReason) {
    super(
      reason === "none_configured"
        ? `User has no ${policyType} policy configured in their eBay seller account.`
        : `User has multiple ${policyType} policies but none is marked default in their eBay seller account.`
    );
    this.name = "MissingSellerPolicyError";
    this.policyType = policyType;
    this.reason = reason;
  }
}

/**
 * CF-EBAY-LOCATION (Drew, 2026-07-20). Thrown when the user has no
 * inventory location set up on their eBay seller account. Without one,
 * offer/publish fails with errorId 25002 "No <Item.Country> exists"
 * because the offer has no ship-from address to draw a country from.
 * iOS surfaces this as "add a shipping location in eBay Seller Hub".
 */
export class MissingSellerLocationError extends Error {
  constructor() {
    super("User has no inventory location configured in their eBay seller account.");
    this.name = "MissingSellerLocationError";
  }
}

export interface EbayListingResult {
  success: boolean;
  offerId?: string;
  listingId?: string;
  listingUrl?: string;
  inventoryItemKey?: string;
  error?: string;
  /** When publish fails because of a missing seller policy, names which one and why. */
  missingPolicy?: { policyType: SellerPolicyType; reason: MissingSellerPolicyReason };
  /** When publish fails because the user has no eBay inventory location configured. */
  missingLocation?: { reason: "none_configured" };
  /** CF-EBAY-ERROR-STRUCTURED (Drew, 2026-07-20). When eBay rejects the
   *  payload with a 400 validation error, this carries the specific
   *  field/aspect name eBay flagged, plus the errorId and the full
   *  eBay response for debugging. iOS Listing Review uses `ebayField`
   *  to highlight the offending section inline. */
  ebayField?: string | null;
  ebayErrorId?: number | null;
  ebayResponse?: unknown;
}

export interface EbayOfferStatus {
  offerId: string;
  status: string;
  listingId?: string;
  listingUrl?: string;
  price?: number;
  quantity?: number;
  categoryId?: string;
  marketplaceId?: string;
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const MARKETPLACE_ID   = process.env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
const DEFAULT_CATEGORY = process.env.EBAY_SPORTS_CARDS_CATEGORY_ID ?? "261328";

// ---------------------------------------------------------------------------
// Seller policy resolution (inline, per-user)
// ---------------------------------------------------------------------------

interface RawPolicyEntry {
  policyId: string;
  name: string;
  categoryTypes?: Array<{ name?: string; default?: boolean }>;
}

/**
 * Pick the policy id to use for a given type from the user's eBay
 * account, applying the four-state contract:
 *   - 0 policies → MissingSellerPolicyError("none_configured")
 *   - 1 policy   → use it
 *   - >1 with one marked default → use the default
 *   - >1 none default → MissingSellerPolicyError("no_default_among_multiple")
 */
function selectPolicyId(
  type: SellerPolicyType,
  policies: RawPolicyEntry[]
): string {
  if (policies.length === 0) {
    throw new MissingSellerPolicyError(type, "none_configured");
  }
  if (policies.length === 1) {
    return policies[0].policyId;
  }
  const defaults = policies.filter(p =>
    (p.categoryTypes ?? []).some(ct => ct.default === true)
  );
  if (defaults.length === 0) {
    throw new MissingSellerPolicyError(type, "no_default_among_multiple");
  }
  return defaults[0].policyId;
}

/**
 * Fetch the authenticated user's seller policies from eBay's Account API.
 * Returns the raw entries (with categoryTypes default flags) for selection
 * logic, plus the marketplace-id used.
 */
async function fetchSellerPoliciesRaw(userId: string): Promise<{
  payment: RawPolicyEntry[];
  fulfillment: RawPolicyEntry[];
  return: RawPolicyEntry[];
}> {
  const [pay, ful, ret] = await Promise.all([
    ebayRequest<{ paymentPolicies?: Array<{ paymentPolicyId: string; name: string; categoryTypes?: Array<{ name?: string; default?: boolean }> }> }>(
      userId, "GET", `/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`),
    ebayRequest<{ fulfillmentPolicies?: Array<{ fulfillmentPolicyId: string; name: string; categoryTypes?: Array<{ name?: string; default?: boolean }> }> }>(
      userId, "GET", `/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`),
    ebayRequest<{ returnPolicies?: Array<{ returnPolicyId: string; name: string; categoryTypes?: Array<{ name?: string; default?: boolean }> }> }>(
      userId, "GET", `/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`),
  ]);
  return {
    payment: (pay.paymentPolicies ?? []).map(p => ({
      policyId: p.paymentPolicyId, name: p.name, categoryTypes: p.categoryTypes,
    })),
    fulfillment: (ful.fulfillmentPolicies ?? []).map(p => ({
      policyId: p.fulfillmentPolicyId, name: p.name, categoryTypes: p.categoryTypes,
    })),
    return: (ret.returnPolicies ?? []).map(p => ({
      policyId: p.returnPolicyId, name: p.name, categoryTypes: p.categoryTypes,
    })),
  };
}

/**
 * Resolve the three policy ids to apply to an offer.
 * If the input provides ALL three explicit overrides, those are used as-is
 * (allows iOS UI to surface a chooser later in D.3/D.4). Otherwise fetches
 * the user's account policies and applies the four-state selection rule.
 * Throws MissingSellerPolicyError on any policy gap.
 */
export async function resolveSellerPolicies(
  userId: string,
  input: HoldingListingInput
): Promise<{ paymentPolicyId: string; returnPolicyId: string; fulfillmentPolicyId: string }> {
  if (input.paymentPolicyId && input.returnPolicyId && input.fulfillmentPolicyId) {
    return {
      paymentPolicyId:     input.paymentPolicyId,
      returnPolicyId:      input.returnPolicyId,
      fulfillmentPolicyId: input.fulfillmentPolicyId,
    };
  }
  const raw = await fetchSellerPoliciesRaw(userId);
  return {
    paymentPolicyId:     input.paymentPolicyId     ?? selectPolicyId("payment", raw.payment),
    returnPolicyId:      input.returnPolicyId      ?? selectPolicyId("return", raw.return),
    fulfillmentPolicyId: input.fulfillmentPolicyId ?? selectPolicyId("fulfillment", raw.fulfillment),
  };
}

// ---------------------------------------------------------------------------
// Inventory location resolution
// ---------------------------------------------------------------------------

/** Fetch the user's eBay inventory locations and return the first one's
 *  key. Publish requires this on the offer — without it, eBay's publish
 *  step throws errorId 25002 "No <Item.Country> exists" because the
 *  offer has no ship-from address to derive a country from.
 *
 *  If the user has more than one location we just pick the first for now;
 *  a future revision can honor a per-listing location override. Throws
 *  MissingSellerLocationError when the account has zero locations.
 */
async function resolveMerchantLocationKey(userId: string): Promise<string> {
  const resp = await ebayRequest<{
    locations?: Array<{ merchantLocationKey: string; name?: string }>;
    total?: number;
  }>(userId, "GET", "/sell/inventory/v1/location?limit=25");
  const locs = resp.locations ?? [];
  if (locs.length === 0) throw new MissingSellerLocationError();
  return locs[0].merchantLocationKey;
}

export interface InventoryLocationSummary {
  merchantLocationKey: string;
  name?: string;
  addressLine1?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
  country?: string;
}

export interface CreateInventoryLocationInput {
  name?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country?: string;
}

/** Public — list the user's eBay inventory locations. iOS renders these
 *  in the ship-from picker; returns an empty array when the user has
 *  none configured (rather than throwing) so the UI can show "add one". */
export async function listInventoryLocations(userId: string): Promise<InventoryLocationSummary[]> {
  const resp = await ebayRequest<{
    locations?: Array<{
      merchantLocationKey: string;
      name?: string;
      location?: { address?: {
        addressLine1?: string; city?: string; stateOrProvince?: string;
        postalCode?: string; country?: string;
      } };
    }>;
  }>(userId, "GET", "/sell/inventory/v1/location?limit=25");
  return (resp.locations ?? []).map(l => ({
    merchantLocationKey: l.merchantLocationKey,
    name: l.name,
    addressLine1: l.location?.address?.addressLine1,
    city: l.location?.address?.city,
    stateOrProvince: l.location?.address?.stateOrProvince,
    postalCode: l.location?.address?.postalCode,
    country: l.location?.address?.country,
  }));
}

/** Public — create (or upsert) an eBay inventory location under a
 *  stable per-user key. Idempotent by design: repeated calls with the
 *  same key update the same location instead of creating dupes. */
export async function createInventoryLocation(
  userId: string,
  input: CreateInventoryLocationInput,
): Promise<{ merchantLocationKey: string }> {
  // Stable key per user — eBay PUT to same key is an upsert. Sanitized
  // slug so the URL segment is safe.
  const key = `hobbyiq-primary-${userId}`.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  const payload = {
    location: {
      address: {
        addressLine1:  input.addressLine1,
        ...(input.addressLine2 ? { addressLine2: input.addressLine2 } : {}),
        city:            input.city,
        stateOrProvince: input.stateOrProvince,
        postalCode:      input.postalCode,
        country:         input.country ?? "US",
      },
    },
    name: input.name ?? "HobbyIQ Ship-From",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
  };
  await ebayRequest(userId, "POST", `/sell/inventory/v1/location/${encodeURIComponent(key)}`, payload);
  return { merchantLocationKey: key };
}

/** Diagnostic — fetch eBay's authoritative aspect metadata for a given
 *  category id. Used to discover the exact accepted enum values for
 *  aspects like Grade / Professional Grader when publish rejects with
 *  errorId 25064. Returns the raw eBay Taxonomy API response. */
export async function fetchCategoryAspects(userId: string, categoryId: string): Promise<unknown> {
  // First get the default category_tree_id for the marketplace
  const tree = await ebayRequest<{ categoryTreeId: string }>(
    userId, "GET",
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(MARKETPLACE_ID)}`,
  );
  return await ebayRequest(
    userId, "GET",
    `/commerce/taxonomy/v1/category_tree/${tree.categoryTreeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
  );
}

/** Diagnostic — fetch subtree of a category to find leaf categories. */
export async function fetchCategorySubtree(userId: string, categoryId: string): Promise<unknown> {
  const tree = await ebayRequest<{ categoryTreeId: string }>(
    userId, "GET",
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(MARKETPLACE_ID)}`,
  );
  return await ebayRequest(
    userId, "GET",
    `/commerce/taxonomy/v1/category_tree/${tree.categoryTreeId}/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`,
  );
}

/** Diagnostic — fetch valid condition IDs + names + descriptor rules
 *  for a category. Authoritative source for what `condition` strings
 *  the Sell API will accept for this category. */
export async function fetchItemConditionPolicies(userId: string, categoryId: string): Promise<unknown> {
  return await ebayRequest(
    userId, "GET",
    `/sell/metadata/v1/marketplace/${encodeURIComponent(MARKETPLACE_ID)}/get_item_condition_policies?filter=categoryIds:{${encodeURIComponent(categoryId)}}`,
  );
}

/** Diagnostic — ask eBay to suggest a category for a listing title. */
export async function fetchCategorySuggestion(userId: string, q: string): Promise<unknown> {
  const tree = await ebayRequest<{ categoryTreeId: string }>(
    userId, "GET",
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(MARKETPLACE_ID)}`,
  );
  return await ebayRequest(
    userId, "GET",
    `/commerce/taxonomy/v1/category_tree/${tree.categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(q)}`,
  );
}

// ---------------------------------------------------------------------------
// Title builder
// ---------------------------------------------------------------------------

// CF-EBAY-TITLE-HONOR-AND-FALLBACK (2026-06-17):
//
// Public buildTitle is now a two-stage resolver:
//   1. HONOR PATH: when input.cardTitle is non-empty after trim, return
//      it verbatim (capped at eBay's 80-char title limit). Lets iOS
//      ship a user-edited title without the server overwriting it.
//   2. FALLBACK PATH: when cardTitle is empty/absent, compose from the
//      structured fields using the canonical format:
//          [year] [set] [player] [parallel(+serial)] [Auto?]
//      with brand-vs-set dedup and parallel-vs-serial dedup so iOS
//      payloads with overlapping structured fields don't produce
//      doubled tokens.
//
// Other tokens that previously appeared in the title (cardNumber,
// RC, PATCH, graded company+grade, cert#) are no longer included.
// They remain in buildItemAspects() — eBay's structured search relies
// on the aspects, not the title, so the title can stay concise.
//
// Exported so the focused unit-test file can import and exercise both
// paths + the dedup helpers without going through buildListingPreview.
export function buildTitle(i: HoldingListingInput): string {
  // HONOR PATH — caller-supplied title wins when present.
  const provided = (i.cardTitle ?? "").trim();
  if (provided.length > 0) {
    return capTitleAt80(provided);
  }
  // FALLBACK PATH — compose from structured fields.
  return capTitleAt80(composeTitle(i));
}

function composeTitle(i: HoldingListingInput): string {
  const tokens: string[] = [];

  if (i.cardYear && i.cardYear > 0) tokens.push(String(i.cardYear));

  // CF-TITLE-YEAR-DEDUP (Drew, 2026-07-20). Strip a leading year token
  // from set/product before formatting — imported holdings often carry
  // setName="2017 Topps Archives Baseball" and cardYear=2017, which
  // otherwise concatenates to "2017 2017 Topps Archives Baseball".
  const stripYear = (s: string | undefined): string | undefined =>
    s?.replace(/^\d{4}\s+/, "");
  const set = formatSetWithBrandDedup(i.brand, stripYear(i.product) || stripYear(i.setName));
  if (set) tokens.push(set);

  if (i.playerName && i.playerName.trim().length > 0) tokens.push(i.playerName.trim());

  const parallel = formatParallelWithSerial(i.parallel, i.serialNumber, i.printRun);
  if (parallel) tokens.push(parallel);

  if (i.isAuto) tokens.push("Auto");

  // Filter purely empty tokens (defensive) + collapse to single spaces.
  return tokens
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * When the publication line already contains the brand name, return it
 * alone — avoids "Bowman Bowman Chrome" doubling that the iOS payload
 * pattern produces (brand="Bowman", product="Bowman Chrome"). Comparison
 * is case-insensitive substring; the brand is a whole word in every
 * cardsight publication line.
 */
function formatSetWithBrandDedup(brand: string | undefined, set: string | undefined): string {
  const setTrim = (set ?? "").trim();
  const brandTrim = (brand ?? "").trim();
  if (!setTrim && !brandTrim) return "";
  if (!setTrim) return brandTrim;
  if (!brandTrim) return setTrim;
  const lcSet = setTrim.toLowerCase();
  const lcBrand = brandTrim.toLowerCase();
  if (lcSet === lcBrand) return setTrim;
  if (lcSet.includes(lcBrand)) return setTrim;
  return `${brandTrim} ${setTrim}`;
}

/**
 * Parallel strings often already include the print run ("Blue X-Fractor
 * /150"), so when serialNumber/printRun are also sent we must not double
 * the /N suffix. Parallel wins when it already encodes a serial; serial
 * is only appended when parallel is bare. When there's no parallel at
 * all, a serial alone returns "/N" (matches the prior behavior for
 * print-run-only cards).
 */
function formatParallelWithSerial(
  parallel: string | undefined,
  serialNumber: string | undefined,
  printRun: number | undefined,
): string {
  const parallelTrim = (parallel ?? "").trim();
  const serialPart = printRun != null && Number.isFinite(printRun)
    ? String(printRun)
    : (serialNumber ?? "").trim();
  if (!parallelTrim) {
    return serialPart ? `/${serialPart}` : "";
  }
  if (!serialPart) return parallelTrim;
  if (/\/\d+/.test(parallelTrim)) return parallelTrim;
  return `${parallelTrim} /${serialPart}`;
}

/** eBay enforces 80 char max on listing titles. Truncate with ellipsis. */
function capTitleAt80(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.substring(0, 77) + "...";
}

// ---------------------------------------------------------------------------
// Item specifics builder
// ---------------------------------------------------------------------------

// CF-EBAY-ASPECTS-CATEGORY-META-ONLY (Drew, 2026-07-20). Whitelist of
// aspect keys we accept from holding.ebayItemAspects. These are the
// category-required META aspects (League, Type, Country/Region of
// Manufacture, Year Manufactured, Season, Language, etc.) that we
// can't compute from base holding fields — eBay's Sports Trading
// Cards category rejects listings without them.
//
// EXCLUDED: card-identity + condition + grade + autograph aspects.
// Those we compute authoritatively from the holding's own fields
// (playerName, gradeCompany, isAuto, etc.). If we pulled those from
// captured aspects, dirty enrichment data (e.g. Judge coin: Grade:10
// / Autograph Format: Hard Signed / Autographed: No — three-way
// contradiction from a mis-scraped different-card capture) would
// blow up eBay validation. The 2026-07-20 Judge listing bug was
// this exact pattern.
const CATEGORY_META_ASPECT_KEYS = new Set([
  "League",
  "Type",
  "Country/Region of Manufacture",
  "Country of Origin",
  "Country/Region of Origin",
  "Year Manufactured",
  "Season",
  "Language",
  "Card Size",
  "Vintage",
  "Original/Licensed Reprint",
  "Event/Tournament",
]);

function buildItemAspects(i: HoldingListingInput): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};

  // CF-EBAY-ASPECTS-MERGE (Drew, 2026-07-20). Base layer: only the
  // category-required META aspects from ebayItemAspects. Card-identity
  // and condition/grade/auto aspects are discarded so dirty enrichment
  // captures don't conflict with our computed authoritative fields.
  if (i.ebayItemAspects && typeof i.ebayItemAspects === "object") {
    for (const [k, v] of Object.entries(i.ebayItemAspects)) {
      if (!CATEGORY_META_ASPECT_KEYS.has(k)) continue;
      if (typeof v === "string" && v.trim().length > 0) {
        aspects[k] = [v.trim()];
      }
    }
  }

  aspects["Sport"] = [i.sport ?? "Baseball"];
  if (i.playerName)   aspects["Player"] = [i.playerName];
  if (i.team)         aspects["Team"] = [i.team];
  if (i.cardYear)     aspects["Year"] = [String(i.cardYear)];
  if (i.brand)        aspects["Manufacturer"] = [i.brand];
  if (i.setName)      aspects["Set"] = [i.setName];
  if (i.cardNumber)   aspects["Card Number"] = [i.cardNumber];
  if (i.parallel)     aspects["Parallel/Variety"] = [i.parallel];
  if (i.printRun)     aspects["Print Run"] = [String(i.printRun)];
  if (i.serialNumber) aspects["Serial Number"] = [i.serialNumber];
  if (i.variation)    aspects["Variation"] = [i.variation];

  // CF-EBAY-ASPECT-BOOLEAN-DEFAULTS (Drew, 2026-07-20). eBay's Sports
  // Trading Cards category demands Autographed / Rookie / Vintage as
  // Yes|No — not "absent when false". Prior code only emitted "Yes"
  // and left the aspect off when false; eBay silently rejected some
  // listings for the missing key. Always emit both sides.
  aspects["Autographed"] = [i.isAuto ? "Yes" : "No"];
  aspects["Rookie"] = [i.isRookie ? "Yes" : "No"];
  if (i.isPatch) aspects["Features"] = ["Patch"];
  if (!aspects["Vintage"]) aspects["Vintage"] = ["No"];   // set to "Yes" by capture when applicable

  // CF-EBAY-CONDITION-DESCRIPTORS (Drew, 2026-07-20). Grade / Professional
  // Grader / Card Condition / Certification Number all live in
  // inventory_item.conditionDescriptors — NOT product.aspects — per eBay
  // category 261328 spec. Keep the Graded aspect for consumer-facing
  // display but don't emit the others here.
  const isGraded = i.gradingCompany && i.gradingCompany.toLowerCase() !== "raw" && i.grade;
  aspects["Graded"] = [isGraded ? "Yes" : "No"];

  return aspects;
}

// ---------------------------------------------------------------------------
// Condition mapping
// ---------------------------------------------------------------------------

// CF-EBAY-CONDITION-ENUM (Drew, 2026-07-20). eBay's Inventory API v1
// takes a STRING ENUM in the `condition` field (LIKE_NEW, USED_EXCELLENT,
// etc.), NOT the legacy Trading API numeric conditionIds (3000/4000/etc.).
// Sending "4000" gets rejected upstream with `Could not serialize field
// [condition]` (errorId 2004). This mapping stays close to how sellers
// describe trading-card condition on eBay:
//   NM/Mint          → LIKE_NEW
//   Excellent/VG     → USED_EXCELLENT
//   Good             → USED_GOOD
//   Slabs (graded)   → USED_EXCELLENT + conditionDescription carrying grade
// The old function name is kept for call-site stability but the return
// field is now `condition` (enum), not `conditionId` (numeric).
// CF-EBAY-TRADING-CARDS-CONDITION (Drew, 2026-07-20). eBay Trading Cards
// category 261328 accepts ONLY two condition values on the Sell Inventory
// API (per spec Drew shared): "GRADED" (maps to conditionId 2750) or
// "UNGRADED" (maps to conditionId 4000). Generic Sell API strings like
// LIKE_NEW / USED_EXCELLENT are rejected with errorId 25060 "The Condition
// descriptor N is not valid for condition INVALID_CONDITION" — meaning
// eBay accepts the descriptors but can't reconcile the top-level condition.
function ebayConditionId(i: HoldingListingInput): { condition: string; conditionDescription?: string } {
  const isGraded = i.gradingCompany && i.gradingCompany.toLowerCase() !== "raw" && i.grade;
  if (isGraded) {
    return {
      condition: "GRADED",
      conditionDescription: `${i.gradingCompany} ${i.grade}${i.certNumber ? ` — Cert #${i.certNumber}` : ""}`,
    };
  }
  return { condition: "UNGRADED", conditionDescription: i.conditionNotes };
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

function buildDescription(i: HoldingListingInput): string {
  if (i.description) return i.description;

  const lines: string[] = [];
  lines.push(`<b>${buildTitle(i)}</b>`);
  lines.push(`<br/>`);
  if (i.isRookie) lines.push("✅ Rookie Card");
  if (i.isAuto)   lines.push("✅ Autographed");
  if (i.isPatch)  lines.push("✅ Patch");
  if (i.serialNumber) lines.push(`Serial: ${i.serialNumber}${i.printRun ? `/${i.printRun}` : ""}`);
  if (i.gradingCompany && i.gradingCompany.toLowerCase() !== "raw" && i.grade) {
    lines.push(`<br/>Professionally graded ${i.gradingCompany} ${i.grade}.`);
    if (i.certNumber) lines.push(`Cert #: ${i.certNumber}`);
  } else {
    if (i.conditionEstimate) lines.push(`<br/>Condition: ${i.conditionEstimate}`);
    if (i.conditionNotes)    lines.push(i.conditionNotes);
  }
  lines.push(`<br/><br/>Fast shipping — ships same or next business day.`);
  return lines.join("<br/>");
}

// ---------------------------------------------------------------------------
// Image list
// ---------------------------------------------------------------------------

/** eBay's per-listing image cap. eBay Business accounts get 24; the safe
 *  floor across all account tiers is 12. We cap here (server-side)
 *  regardless of what iOS sends. */
const MAX_LISTING_PHOTOS = 12;

/**
 * CF-INVENTORY-PHOTOS-TO-LISTING (2026-07-05, Drew): build the eBay
 * image list from a mix of explicit front/back URLs and the holding's
 * photos[] array. Order matters — eBay uses the first image as the
 * gallery thumbnail. Precedence:
 *
 *   1. imageFrontUrl  (explicit front — always first when provided)
 *   2. imageBackUrl   (explicit back — always second when provided)
 *   3. photos[]       (remaining holding photos, dedup'd against 1-2)
 *
 * Capped to MAX_LISTING_PHOTOS. Filters out non-HTTPS / empty entries.
 * Preserves the pre-CF two-URL behavior exactly when photos[] is absent.
 */
export function buildImages(i: HoldingListingInput): Array<{ imageUrl: string }> {
  const seen = new Set<string>();
  const out: Array<{ imageUrl: string }> = [];
  const push = (url: string | undefined | null) => {
    if (!url || typeof url !== "string") return;
    const trimmed = url.trim();
    if (!/^https:\/\//i.test(trimmed)) return; // eBay requires HTTPS
    if (seen.has(trimmed)) return;
    if (out.length >= MAX_LISTING_PHOTOS) return;
    seen.add(trimmed);
    out.push({ imageUrl: trimmed });
  };
  push(i.imageFrontUrl);
  push(i.imageBackUrl);
  if (Array.isArray(i.photos)) {
    for (const p of i.photos) push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core eBay API helpers
// ---------------------------------------------------------------------------

/** CF-EBAY-ERROR-STRUCTURED (Drew, 2026-07-20). Rich error type so
 *  callers (routes) can pull out the field name that eBay flagged and
 *  surface it to iOS for inline highlighting on the Listing Review
 *  screen. */
export class EbayApiError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly path: string;
  /** Parsed field name from eBay's errors[].parameters[]. Present when
   *  eBay's response includes a Name/Value parameter pair — often the
   *  aspect key that failed validation. */
  public readonly ebayField: string | null;
  /** eBay's own errorId (e.g. 25007 = "A user error has occurred") —
   *  useful for category-specific dispatch. */
  public readonly ebayErrorId: number | null;
  public readonly ebayResponse: unknown;
  public readonly requestBody: unknown;

  constructor(args: {
    status: number;
    method: string;
    path: string;
    message: string;
    ebayField: string | null;
    ebayErrorId: number | null;
    ebayResponse: unknown;
    requestBody: unknown;
  }) {
    super(args.message);
    this.name = "EbayApiError";
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.ebayField = args.ebayField;
    this.ebayErrorId = args.ebayErrorId;
    this.ebayResponse = args.ebayResponse;
    this.requestBody = args.requestBody;
  }
}

/** Extract the offending field name from eBay's error payload. eBay
 *  puts the parameter Name inside errors[].parameters[] on validation
 *  failures — the value tells us which aspect / field they rejected. */
function extractEbayField(data: unknown): string | null {
  const errors = (data as { errors?: Array<{ parameters?: Array<{ name?: string; value?: string }> }> })?.errors;
  if (!Array.isArray(errors)) return null;
  for (const e of errors) {
    if (Array.isArray(e.parameters)) {
      // Prefer a parameter explicitly named "aspectName" — the specific
      // aspect eBay didn't like. Fall through to any Name value.
      const named = e.parameters.find((p) => p.name === "aspectName" || p.name === "fieldName");
      if (named?.value) return String(named.value);
      const firstValue = e.parameters.find((p) => p.value)?.value;
      if (firstValue) return String(firstValue);
    }
  }
  return null;
}

async function ebayRequest<T = unknown>(
  userId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken(userId);
  const res = await fetch(`${EBAY_BASE_API}${path}`, {
    method,
    headers: {
      Authorization:              `Bearer ${token}`,
      "Content-Type":             "application/json",
      "Content-Language":         "en-US",
      // CF-EBAY-ACCEPT-LANGUAGE (Drew, 2026-07-20). Inventory API's PUT
      // /inventory_item rejects with errorId 25709 "Invalid value for
      // header Accept-Language" when it sees no explicit value —
      // Node's fetch was letting eBay infer one it didn't like. Send it
      // explicitly. Marketplace ID also required by several Inventory
      // endpoints; harmless on the others.
      "Accept-Language":          "en-US",
      "X-EBAY-C-MARKETPLACE-ID":  MARKETPLACE_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return {} as T;

  const data = await res.json();
  if (!res.ok) {
    const msg = (data as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ?? JSON.stringify(data);
    const ebayField = extractEbayField(data);
    const ebayErrorId = (data as { errors?: Array<{ errorId?: number }> })?.errors?.[0]?.errorId ?? null;
    // CF-EBAY-REQUEST-LOG (Drew, 2026-07-20). Log the full request +
    // response on every failure so we can diagnose eBay 400s without
    // needing to reproduce. Body redaction: authorization header
    // NEVER logged. Everything else visible in App Insights via KQL.
    console.error(JSON.stringify({
      event: "ebay_api_request_failed",
      source: "ebayListing.ebayRequest",
      status: res.status,
      method,
      path,
      ebayErrorId,
      ebayField,
      ebayMessage: msg,
      requestBody: body,
      ebayResponse: data,
    }));
    throw new EbayApiError({
      status: res.status,
      method,
      path,
      message: `eBay API ${method} ${path} failed (${res.status}): ${msg}`,
      ebayField,
      ebayErrorId,
      ebayResponse: data,
      requestBody: body,
    });
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Listing workflow
// ---------------------------------------------------------------------------

// CF-EBAY-CONDITION-DESCRIPTORS (Drew, 2026-07-20). eBay Trading Cards
// category 261328 requires condition-descriptors (NOT product.aspects)
// for Grade / Professional Grader / Card Condition. Descriptor IDs +
// value IDs are stable eBay enums per category-261328 spec.
const DESC_PROFESSIONAL_GRADER = "27501";
const DESC_GRADE               = "27502";
const DESC_CERT_NUMBER         = "27503";
const DESC_CARD_CONDITION      = "40001";

const GRADER_VALUE_ID: Record<string, string> = {
  "PSA":  "275010", "BCCG": "275011", "BVG": "275012", "BGS": "275013",
  "CSG":  "275014", "CGC":  "275015", "SGC": "275016", "KSA": "275017",
  "GMA":  "275018", "HGA":  "275019", "ISA": "2750110", "GSG": "2750112",
  "PGS":  "2750113", "MNT": "2750114", "TAG": "2750115", "RARE": "2750116",
  "RCG":  "2750117", "CGA": "2750120", "OTHER": "2750123",
};
const GRADE_VALUE_ID: Record<string, string> = {
  "10":  "275020", "9.5": "275021", "9":   "275022", "8.5": "275023",
  "8":   "275024", "7.5": "275025", "7":   "275026", "6.5": "275027",
  "6":   "275028", "5.5": "275029", "5":   "2750210", "4.5": "2750211",
  "4":   "2750212", "3.5": "2750213", "3":  "2750214", "2.5": "2750215",
  "2":   "2750216", "1.5": "2750217", "1":  "2750218",
};
const CARD_CONDITION_VALUE_ID: Record<string, string> = {
  "NEAR MINT OR BETTER": "400010",
  "EXCELLENT":           "400011",
  "VERY GOOD":           "400012",
  "POOR":                "400013",
};

function buildConditionDescriptors(i: HoldingListingInput): Array<{ name: string; values: string[] }> {
  const descriptors: Array<{ name: string; values: string[] }> = [];
  const isGraded = i.gradingCompany && i.gradingCompany.toLowerCase() !== "raw" && i.grade;
  if (isGraded) {
    const graderKey = GRADER_VALUE_ID[String(i.gradingCompany).toUpperCase()]
      ?? GRADER_VALUE_ID["OTHER"];
    const gradeKey = GRADE_VALUE_ID[String(i.grade).trim()];
    descriptors.push({ name: DESC_PROFESSIONAL_GRADER, values: [graderKey] });
    if (gradeKey) descriptors.push({ name: DESC_GRADE, values: [gradeKey] });
    if (i.certNumber) descriptors.push({ name: DESC_CERT_NUMBER, values: [i.certNumber.slice(0, 30)] });
  } else {
    const est = (i.conditionEstimate ?? "").trim().toUpperCase();
    const cardCondKey = CARD_CONDITION_VALUE_ID[est]
      ?? (/NEAR ?MINT|MINT|NM/.test(est) ? "400010"
        : /EXCELLENT|EX/.test(est) ? "400011"
        : /VERY ?GOOD|VG/.test(est) ? "400012"
        : /POOR|DAMAGED/.test(est) ? "400013"
        : "400010");
    descriptors.push({ name: DESC_CARD_CONDITION, values: [cardCondKey] });
  }
  return descriptors;
}

/** Step 1 — Create or replace an inventory item (the physical card). */
async function upsertInventoryItem(userId: string, key: string, i: HoldingListingInput): Promise<void> {
  const condition = ebayConditionId(i);

  const payload = {
    availability: {
      shipToLocationAvailability: { quantity: i.quantity },
    },
    condition: condition.condition,
    conditionDescription: condition.conditionDescription,
    // CF-EBAY-CONDITION-DESCRIPTORS (Drew, 2026-07-20). Trading Cards
    // category 261328 requires descriptors here (NOT in product.aspects)
    // for Grade / Grader / Card Condition. Publish otherwise rejects
    // with errorId 25064 "Grade/Grader is a required field" no matter
    // what aspect values are sent.
    conditionDescriptors: buildConditionDescriptors(i),
    product: {
      title:       buildTitle(i),
      description: buildDescription(i),
      aspects:     buildItemAspects(i),
      imageUrls:   buildImages(i).map(x => x.imageUrl),
    },
  };

  await ebayRequest(userId, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(key)}`, payload);
}

/** Step 2 — Create or update an offer for the item. Returns the offerId. */
async function upsertOffer(userId: string, inventoryItemKey: string, i: HoldingListingInput, existingOfferId?: string): Promise<string> {
  const policies = await resolveSellerPolicies(userId, i);
  const merchantLocationKey = await resolveMerchantLocationKey(userId);
  const categoryId = i.categoryId ?? DEFAULT_CATEGORY;

  const offerPayload: Record<string, unknown> = {
    sku:           inventoryItemKey,
    marketplaceId: MARKETPLACE_ID,
    format:        "FIXED_PRICE",
    availableQuantity: i.quantity,
    categoryId,
    merchantLocationKey,
    listingDescription: buildDescription(i),
    listingPolicies: {
      paymentPolicyId:     policies.paymentPolicyId,
      returnPolicyId:      policies.returnPolicyId,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
    },
    pricingSummary: {
      price: {
        currency: "USD",
        value:    i.listingPrice.toFixed(2),
      },
      ...(i.bestOfferEnabled ? {
        bestOfferEnabled: true,
        ...(i.bestOfferMinPrice != null ? {
          minimumBestOfferPrice: {
            currency: "USD",
            value:    i.bestOfferMinPrice.toFixed(2),
          },
        } : {}),
      } : {}),
    },
  };

  if (existingOfferId) {
    // Update existing offer
    await ebayRequest(userId, "PUT", `/sell/inventory/v1/offer/${existingOfferId}`, offerPayload);
    return existingOfferId;
  }

  // Create new offer. CF-OFFER-ALREADY-EXISTS (Drew, 2026-07-20). eBay
  // rejects POST /offer with errorId 25002 "Offer entity already exists"
  // when a previous partial attempt (e.g. died at publish) left an
  // orphaned offer for this SKU. The error carries the existing offerId
  // in parameters — recover by PUT-updating the orphan instead of
  // failing the whole listing on a retry.
  try {
    const result = await ebayRequest<{ offerId: string }>(userId, "POST", `/sell/inventory/v1/offer`, offerPayload);
    return result.offerId;
  } catch (err) {
    if (err instanceof EbayApiError && err.ebayErrorId === 25002) {
      const params = (err.ebayResponse as { errors?: Array<{ parameters?: Array<{ name?: string; value?: string }> }> })
        ?.errors?.[0]?.parameters ?? [];
      const orphanOfferId = params.find(p => p.name === "offerId")?.value;
      if (orphanOfferId && /Offer entity already exists/i.test(err.message)) {
        await ebayRequest(userId, "PUT", `/sell/inventory/v1/offer/${orphanOfferId}`, offerPayload);
        return orphanOfferId;
      }
    }
    throw err;
  }
}

/** Step 3 — Publish the offer to make the listing live. Returns listingId. */
async function publishOffer(userId: string, offerId: string): Promise<string> {
  const result = await ebayRequest<{ listingId: string }>(userId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, {});
  return result.listingId;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Full create-and-publish flow. */
export async function createListing(userId: string, input: HoldingListingInput): Promise<EbayListingResult> {
  try {
    // Inventory key is unique per holding; reusing across calls is safe (idempotent PUT)
    const inventoryItemKey = `hobbyiq-${input.holdingId}`;

    await upsertInventoryItem(userId, inventoryItemKey, input);
    const offerId   = await upsertOffer(userId, inventoryItemKey, input);
    const listingId = await publishOffer(userId, offerId);
    const isSandbox = EBAY_BASE_API.includes("sandbox");
    const listingUrl = isSandbox
      ? `https://www.sandbox.ebay.com/itm/${listingId}`
      : `https://www.ebay.com/itm/${listingId}`;

    return { success: true, offerId, listingId, listingUrl, inventoryItemKey };
  } catch (err) {
    if (err instanceof MissingSellerPolicyError) {
      return {
        success: false,
        error: err.message,
        missingPolicy: { policyType: err.policyType, reason: err.reason },
      };
    }
    if (err instanceof MissingSellerLocationError) {
      return {
        success: false,
        error: err.message,
        missingLocation: { reason: "none_configured" },
      };
    }
    if (err instanceof EbayApiError) {
      return {
        success: false,
        error: err.message,
        ebayField: err.ebayField,
        ebayErrorId: err.ebayErrorId,
        ebayResponse: err.ebayResponse,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/** Revise price / best-offer on an already-published offer. */
export async function reviseListing(
  userId: string,
  offerId: string,
  input: HoldingListingInput
): Promise<EbayListingResult> {
  try {
    const inventoryItemKey = `hobbyiq-${input.holdingId}`;
    await upsertInventoryItem(userId, inventoryItemKey, input);
    await upsertOffer(userId, inventoryItemKey, input, offerId);
    return { success: true, offerId, inventoryItemKey };
  } catch (err) {
    if (err instanceof MissingSellerPolicyError) {
      return {
        success: false,
        error: err.message,
        missingPolicy: { policyType: err.policyType, reason: err.reason },
      };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** End (delist) a published offer. */
export async function endListing(userId: string, offerId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ebayRequest(userId, "DELETE", `/sell/inventory/v1/offer/${offerId}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Get current offer status from eBay. */
export async function getOfferStatus(userId: string, offerId: string): Promise<EbayOfferStatus> {
  const data = await ebayRequest<{
    offerId: string;
    status: string;
    listing?: { listingId: string };
    pricingSummary?: { price?: { value?: string } };
    availableQuantity?: number;
    categoryId?: string;
    marketplaceId?: string;
  }>(userId, "GET", `/sell/inventory/v1/offer/${offerId}`);

  const listingId = data.listing?.listingId;
  const isSandbox = EBAY_BASE_API.includes("sandbox");
  return {
    offerId: data.offerId,
    status: data.status,
    listingId,
    listingUrl: listingId
      ? (isSandbox ? `https://www.sandbox.ebay.com/itm/${listingId}` : `https://www.ebay.com/itm/${listingId}`)
      : undefined,
    price: data.pricingSummary?.price?.value ? parseFloat(data.pricingSummary.price.value) : undefined,
    quantity: data.availableQuantity,
    categoryId: data.categoryId,
    marketplaceId: data.marketplaceId,
  };
}

/**
 * Build a preview of the listing without calling eBay's inventory APIs.
 * Now async because it inlines a seller-policy lookup so the iOS confirm
 * screen can show which payment/return/fulfillment policies will be used
 * — or surface a warning if the user's eBay account is missing one.
 * Policy-resolution failures are NEVER thrown from preview: the preview
 * always renders so the user sees their card; warnings carry the gap.
 */
export async function buildListingPreview(userId: string, input: HoldingListingInput): Promise<{
  title: string;
  description: string;
  aspects: Record<string, string[]>;
  condition: ReturnType<typeof ebayConditionId>;
  images: Array<{ imageUrl: string }>;
  price: number;
  bestOfferEnabled: boolean;
  quantity: number;
  categoryId: string;
  marketplaceId: string;
  policies?: { paymentPolicyId: string; returnPolicyId: string; fulfillmentPolicyId: string };
  missingPolicy?: { policyType: SellerPolicyType; reason: MissingSellerPolicyReason };
  warnings: string[];
}> {
  const warnings: string[] = [];
  let policies: { paymentPolicyId: string; returnPolicyId: string; fulfillmentPolicyId: string } | undefined;
  let missingPolicy: { policyType: SellerPolicyType; reason: MissingSellerPolicyReason } | undefined;

  try {
    policies = await resolveSellerPolicies(userId, input);
  } catch (err) {
    if (err instanceof MissingSellerPolicyError) {
      missingPolicy = { policyType: err.policyType, reason: err.reason };
      warnings.push(err.message);
    } else {
      warnings.push(`Could not fetch eBay seller policies: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    title:            buildTitle(input),
    description:      buildDescription(input),
    aspects:          buildItemAspects(input),
    condition:        ebayConditionId(input),
    images:           buildImages(input),
    price:            input.listingPrice,
    bestOfferEnabled: input.bestOfferEnabled,
    quantity:         input.quantity,
    categoryId:       input.categoryId ?? DEFAULT_CATEGORY,
    marketplaceId:    MARKETPLACE_ID,
    ...(policies ? { policies } : {}),
    ...(missingPolicy ? { missingPolicy } : {}),
    warnings,
  };
}

/**
 * Fetch seller's business policies (payment, fulfillment, return) so the
 * app can let the user choose. Each entry includes an `isDefault` flag
 * derived from eBay's `categoryTypes[].default` so iOS can mark the
 * default in a chooser UI.
 */
export async function getSellerPolicies(userId: string): Promise<{
  paymentPolicies: Array<{ policyId: string; name: string; isDefault: boolean }>;
  fulfillmentPolicies: Array<{ policyId: string; name: string; isDefault: boolean }>;
  returnPolicies: Array<{ policyId: string; name: string; isDefault: boolean }>;
}> {
  const raw = await fetchSellerPoliciesRaw(userId);
  const flag = (entries: RawPolicyEntry[]) => entries.map(p => ({
    policyId:  p.policyId,
    name:      p.name,
    isDefault: (p.categoryTypes ?? []).some(ct => ct.default === true),
  }));
  return {
    paymentPolicies:     flag(raw.payment),
    fulfillmentPolicies: flag(raw.fulfillment),
    returnPolicies:      flag(raw.return),
  };
}
