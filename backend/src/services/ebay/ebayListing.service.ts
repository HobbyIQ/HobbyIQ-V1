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
  description?: string;
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

export interface EbayListingResult {
  success: boolean;
  offerId?: string;
  listingId?: string;
  listingUrl?: string;
  inventoryItemKey?: string;
  error?: string;
  /** When publish fails because of a missing seller policy, names which one and why. */
  missingPolicy?: { policyType: SellerPolicyType; reason: MissingSellerPolicyReason };
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
// Title builder
// ---------------------------------------------------------------------------

function buildTitle(i: HoldingListingInput): string {
  const parts: string[] = [];

  if (i.cardYear)     parts.push(String(i.cardYear));
  if (i.brand)        parts.push(i.brand);
  if (i.product)      parts.push(i.product);
  if (i.playerName)   parts.push(i.playerName);
  if (i.cardNumber)   parts.push(`#${i.cardNumber}`);
  if (i.parallel)     parts.push(i.parallel);
  if (i.isRookie)     parts.push("RC");
  if (i.isAuto)       parts.push("AUTO");
  if (i.isPatch)      parts.push("PATCH");
  if (i.serialNumber) parts.push(`/${i.printRun ?? i.serialNumber}`);

  // Graded suffix
  if (i.gradingCompany && i.grade && i.gradingCompany.toLowerCase() !== "raw") {
    parts.push(`${i.gradingCompany} ${i.grade}`);
    if (i.certNumber) parts.push(`Cert #${i.certNumber}`);
  }

  // eBay titles are max 80 chars
  let title = parts.join(" ").trim();
  if (title.length > 80) title = title.substring(0, 77) + "...";
  return title;
}

// ---------------------------------------------------------------------------
// Item specifics builder
// ---------------------------------------------------------------------------

function buildItemAspects(i: HoldingListingInput): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};

  aspects["Sport"] = [i.sport ?? "Baseball"];
  if (i.playerName)   aspects["Player"] = [i.playerName];
  if (i.cardYear)     aspects["Year"] = [String(i.cardYear)];
  if (i.brand)        aspects["Manufacturer"] = [i.brand];
  if (i.setName)      aspects["Set"] = [i.setName];
  if (i.cardNumber)   aspects["Card Number"] = [i.cardNumber];
  if (i.parallel)     aspects["Parallel/Variety"] = [i.parallel];
  if (i.isRookie)     aspects["Rookie"] = ["Yes"];
  if (i.isAuto)       aspects["Autographed"] = ["Yes"];
  if (i.isPatch)      aspects["Features"] = ["Patch"];
  if (i.printRun)     aspects["Print Run"] = [String(i.printRun)];
  if (i.serialNumber) aspects["Serial Number"] = [i.serialNumber];
  if (i.variation)    aspects["Variation"] = [i.variation];

  const isGraded = i.gradingCompany && i.gradingCompany.toLowerCase() !== "raw" && i.grade;
  if (isGraded) {
    aspects["Grade"] = [`${i.gradingCompany} ${i.grade}`];
    aspects["Graded"] = ["Yes"];
    aspects["Professional Grader"] = [i.gradingCompany!];
    if (i.certNumber) aspects["Certification Number"] = [i.certNumber];
  } else {
    aspects["Graded"] = ["No"];
    if (i.conditionEstimate) aspects["Condition"] = [i.conditionEstimate];
  }

  return aspects;
}

// ---------------------------------------------------------------------------
// Condition mapping
// ---------------------------------------------------------------------------

function ebayConditionId(i: HoldingListingInput): { conditionId: string; conditionDescription?: string } {
  const isGraded = i.gradingCompany && i.gradingCompany.toLowerCase() !== "raw" && i.grade;
  if (isGraded) {
    // eBay condition "Graded" = 2750
    return { conditionId: "2750", conditionDescription: `${i.gradingCompany} ${i.grade}${i.certNumber ? ` — Cert #${i.certNumber}` : ""}` };
  }
  // Map raw condition
  const est = (i.conditionEstimate ?? "").toUpperCase();
  if      (est.includes("MT") || est.includes("MINT"))          return { conditionId: "3000" }; // Near Mint
  else if (est.includes("NM"))                                   return { conditionId: "3000" };
  else if (est.includes("EX"))                                   return { conditionId: "4000" }; // Very Good
  else if (est.includes("VG"))                                   return { conditionId: "4000" };
  else if (est.includes("GOOD") || est.includes("GD"))           return { conditionId: "5000" }; // Good
  else                                                           return { conditionId: "3000", conditionDescription: i.conditionNotes };
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

function buildImages(i: HoldingListingInput): Array<{ imageUrl: string }> {
  const imgs: Array<{ imageUrl: string }> = [];
  if (i.imageFrontUrl) imgs.push({ imageUrl: i.imageFrontUrl });
  if (i.imageBackUrl)  imgs.push({ imageUrl: i.imageBackUrl });
  return imgs;
}

// ---------------------------------------------------------------------------
// Core eBay API helpers
// ---------------------------------------------------------------------------

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
      Authorization:   `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Content-Language": "en-US",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return {} as T;

  const data = await res.json();
  if (!res.ok) {
    const msg = (data as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ?? JSON.stringify(data);
    throw new Error(`eBay API ${method} ${path} failed (${res.status}): ${msg}`);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Listing workflow
// ---------------------------------------------------------------------------

/** Step 1 — Create or replace an inventory item (the physical card). */
async function upsertInventoryItem(userId: string, key: string, i: HoldingListingInput): Promise<void> {
  const condition = ebayConditionId(i);

  const payload = {
    availability: {
      shipToLocationAvailability: { quantity: i.quantity },
    },
    condition: condition.conditionId,
    conditionDescription: condition.conditionDescription,
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
  const categoryId = i.categoryId ?? DEFAULT_CATEGORY;

  const offerPayload: Record<string, unknown> = {
    sku:           inventoryItemKey,
    marketplaceId: MARKETPLACE_ID,
    format:        "FIXED_PRICE",
    availableQuantity: i.quantity,
    categoryId,
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

  // Create new offer
  const result = await ebayRequest<{ offerId: string }>(userId, "POST", `/sell/inventory/v1/offer`, offerPayload);
  return result.offerId;
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
