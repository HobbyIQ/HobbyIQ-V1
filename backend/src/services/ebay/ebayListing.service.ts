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
 *   EBAY_PAYMENT_POLICY_ID           — from seller account policies
 *   EBAY_RETURN_POLICY_ID            — from seller account policies
 *   EBAY_FULFILLMENT_POLICY_ID       — from seller account policies
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
  // Seller-side overrides (optional; falls back to env defaults)
  categoryId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  fulfillmentPolicyId?: string;
}

export interface EbayListingResult {
  success: boolean;
  offerId?: string;
  listingId?: string;
  listingUrl?: string;
  inventoryItemKey?: string;
  error?: string;
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

function policyIds(input: HoldingListingInput) {
  return {
    paymentPolicyId:     input.paymentPolicyId     ?? process.env.EBAY_PAYMENT_POLICY_ID ?? "",
    returnPolicyId:      input.returnPolicyId       ?? process.env.EBAY_RETURN_POLICY_ID ?? "",
    fulfillmentPolicyId: input.fulfillmentPolicyId  ?? process.env.EBAY_FULFILLMENT_POLICY_ID ?? "",
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
  const policies = policyIds(i);
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

/** Build a preview of the listing without calling eBay (for draft confirmation screen). */
export function buildListingPreview(input: HoldingListingInput): {
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
} {
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
  };
}

/** Fetch seller's business policies (payment, fulfillment, return) so the app can let user choose. */
export async function getSellerPolicies(userId: string): Promise<{
  paymentPolicies: Array<{ policyId: string; name: string }>;
  fulfillmentPolicies: Array<{ policyId: string; name: string }>;
  returnPolicies: Array<{ policyId: string; name: string }>;
}> {
  const [pay, ful, ret] = await Promise.all([
    ebayRequest<{ paymentPolicies?: Array<{ paymentPolicyId: string; name: string }> }>(
      userId, "GET", `/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`),
    ebayRequest<{ fulfillmentPolicies?: Array<{ fulfillmentPolicyId: string; name: string }> }>(
      userId, "GET", `/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`),
    ebayRequest<{ returnPolicies?: Array<{ returnPolicyId: string; name: string }> }>(
      userId, "GET", `/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`),
  ]);
  return {
    paymentPolicies:     (pay.paymentPolicies ?? []).map(p => ({ policyId: p.paymentPolicyId, name: p.name })),
    fulfillmentPolicies: (ful.fulfillmentPolicies ?? []).map(p => ({ policyId: p.fulfillmentPolicyId, name: p.name })),
    returnPolicies:      (ret.returnPolicies ?? []).map(p => ({ policyId: p.returnPolicyId, name: p.name })),
  };
}
