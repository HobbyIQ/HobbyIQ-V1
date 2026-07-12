// CF-EBAY-BROWSE-ENRICHMENT (2026-07-12, Drew — foundation for
// buy-side inventory enrichment + future eBay sold-comps).
//
// General-purpose Browse API client. Fetches ONE item's full detail
// (structured aspects, condition, images, seller, price) from either
// a legacy item id ("407015594876") or the modern v1 id
// ("v1|407015594876|0"). Both call paths return the same normalized
// shape so callers don't have to switch on which id form they have.
//
// Used by:
//   1. autoCreateHoldingForPurchase enrichment (buy-side, current)
//   2. Future sold-comp lookups by itemId (foundation)
//
// Uses the same OAuth token as GetMyeBayBuying — no new scope required.
// Verified live 2026-07-12 against Drew's justtheboysandcards account.
//
// Rate: eBay Browse tier is 5000 calls/day free. Enrichment fires
// concurrent-with-cap (via `enrichPurchasesConcurrent`) so the caller
// doesn't need to think about batching.

import { getAccessToken } from "./ebayAuth.service.js";

const BROWSE_API_BASE_PROD = "https://api.ebay.com/buy/browse/v1";
const BROWSE_API_BASE_SANDBOX = "https://api.sandbox.ebay.com/buy/browse/v1";

function browseApiBase(): string {
  return (process.env.EBAY_ENV ?? "sandbox") === "production"
    ? BROWSE_API_BASE_PROD
    : BROWSE_API_BASE_SANDBOX;
}

// ─── Return shape (normalized) ─────────────────────────────────────────────

export interface EbayItemDetails {
  /** v1 form ("v1|407015594876|0"). */
  itemId: string;
  /** Numeric legacy id extracted from v1 form. */
  legacyItemId: string;
  title: string;
  shortDescription: string | null;
  /** In USD by default; caller decodes currency if not USD. */
  price: { value: number; currency: string } | null;
  /** Free-text condition ("Graded", "Ungraded", "Used", etc.) */
  condition: string | null;
  /** Structured grader + grade if the seller filled in the conditionDescriptors
   *  block. When present, this is AUTHORITATIVE over any title-parsed grade. */
  grader: string | null;
  grade: string | null;
  /** Flat aspects map — the values users search on in eBay item specifics.
   *  Common keys: Sport, Player, Team, Season, Manufacturer, Set,
   *  Card Manufacturer, Autographed, Card Number, Parallel/Variety,
   *  Card Condition, Grade, Professional Grader, Type. Whatever the seller
   *  filled in. */
  aspects: Record<string, string>;
  images: {
    primary: string | null;
    additional: string[];
  };
  categoryPath: string | null;
  seller: { username: string; feedbackScore: number | null } | null;
  itemCreationDate: string | null;
  itemEndDate: string | null;
  /** ["FIXED_PRICE"], ["AUCTION"], etc. */
  buyingOptions: string[];
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch one item's details by legacy or v1 id. Returns null when the item
 * doesn't exist (e.g. seller ended listing beyond eBay's retention window).
 * Throws only on network / auth failures — 404 is silent-null.
 */
export async function fetchEbayItemDetails(
  userId: string,
  itemId: string,
): Promise<EbayItemDetails | null> {
  if (!userId || !itemId) return null;
  const token = await getAccessToken(userId);

  const url = itemId.startsWith("v1|")
    ? `${browseApiBase()}/item/${encodeURIComponent(itemId)}`
    : `${browseApiBase()}/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(itemId)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      Accept: "application/json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Browse API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return normalizeItemResponse(data);
}

/**
 * Concurrent batch enrichment — pass N itemIds, get back N (item | null)
 * results in the same order. Concurrency capped so we don't fan out
 * uncontrolled requests to eBay.
 *
 * Errors on individual items become nulls so a partial batch failure
 * doesn't take the caller down. Use case: batch-enrich a user's whole
 * purchase list on backfill.
 */
export async function fetchEbayItemDetailsBatch(
  userId: string,
  itemIds: string[],
  concurrency: number = 8,
): Promise<Array<EbayItemDetails | null>> {
  const results: Array<EbayItemDetails | null> = new Array(itemIds.length).fill(null);
  const cap = Math.max(1, Math.min(20, concurrency));
  const queue = itemIds.map((id, i) => ({ id, i }));
  const workers: Promise<void>[] = [];
  const runWorker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        results[item.i] = await fetchEbayItemDetails(userId, item.id);
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "ebay_browse_batch_error",
            source: "ebayItemDetails.service",
            userId,
            itemId: item.id,
            error: (err as Error)?.message ?? String(err),
          }),
        );
        results[item.i] = null;
      }
    }
  };
  for (let i = 0; i < cap; i++) workers.push(runWorker());
  await Promise.all(workers);
  return results;
}

// ─── Normalization ─────────────────────────────────────────────────────────

function normalizeItemResponse(data: any): EbayItemDetails {
  const v1Id: string = typeof data.itemId === "string" ? data.itemId : "";
  const legacyId = extractLegacyId(v1Id);

  // Aspects: eBay returns [{type, name, value}, ...]
  const aspects: Record<string, string> = {};
  if (Array.isArray(data.localizedAspects)) {
    for (const a of data.localizedAspects) {
      if (typeof a?.name === "string" && typeof a?.value === "string") {
        aspects[a.name] = a.value;
      }
    }
  }

  // Grader + grade from conditionDescriptors block
  let grader: string | null = null;
  let grade: string | null = null;
  if (Array.isArray(data.conditionDescriptors)) {
    for (const cd of data.conditionDescriptors) {
      const name = (cd?.name ?? "").toString();
      const val = firstValueOfConditionDescriptor(cd);
      if (!val) continue;
      if (/professional grader/i.test(name) || /grader/i.test(name)) grader = val;
      if (name.toLowerCase() === "grade") grade = val;
    }
  }
  // Aspect fallbacks for grader/grade (some sellers put them in localizedAspects
  // instead of the conditionDescriptors block).
  if (!grader && aspects["Professional Grader"]) grader = aspects["Professional Grader"];
  if (!grade && aspects["Grade"]) grade = aspects["Grade"];

  const priceValue = Number(data?.price?.value);
  const price =
    Number.isFinite(priceValue) && priceValue > 0
      ? { value: priceValue, currency: String(data?.price?.currency ?? "USD") }
      : null;

  const primaryImage = typeof data?.image?.imageUrl === "string" ? data.image.imageUrl : null;
  const additional = Array.isArray(data.additionalImages)
    ? data.additionalImages
        .map((im: any) => (typeof im?.imageUrl === "string" ? im.imageUrl : null))
        .filter((u: string | null): u is string => !!u)
    : [];

  const seller =
    data.seller && typeof data.seller.username === "string"
      ? {
          username: data.seller.username,
          feedbackScore:
            typeof data.seller.feedbackScore === "number" ? data.seller.feedbackScore : null,
        }
      : null;

  return {
    itemId: v1Id,
    legacyItemId: legacyId,
    title: typeof data.title === "string" ? data.title : "",
    shortDescription:
      typeof data.shortDescription === "string" ? data.shortDescription : null,
    price,
    condition: typeof data.condition === "string" ? data.condition : null,
    grader,
    grade,
    aspects,
    images: { primary: primaryImage, additional },
    categoryPath: typeof data.categoryPath === "string" ? data.categoryPath : null,
    seller,
    itemCreationDate:
      typeof data.itemCreationDate === "string" ? data.itemCreationDate : null,
    itemEndDate: typeof data.itemEndDate === "string" ? data.itemEndDate : null,
    buyingOptions: Array.isArray(data.buyingOptions)
      ? data.buyingOptions.filter((v: any) => typeof v === "string")
      : [],
  };
}

function extractLegacyId(v1Id: string): string {
  // "v1|407015594876|0" → "407015594876"
  const parts = v1Id.split("|");
  return parts.length >= 2 ? parts[1] : v1Id;
}

function firstValueOfConditionDescriptor(cd: any): string | null {
  const values = cd?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const first = values[0];
  return typeof first?.content === "string" ? first.content : null;
}
