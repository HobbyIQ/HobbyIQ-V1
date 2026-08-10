// CF-MARKETPLACE-LISTINGS-STORE (Drew, 2026-08-10). Materialized index
// of user-storefront cards for the cross-storefront search feature.
// Populated by write hooks on portfolio holdings (showOnStorefront
// toggle) and by a one-time backfill.
//
// Container: marketplace_listings
// Partition key: /sellerId
// Doc id: "listing::{userId}::{holdingId}"
//
// Row lifecycle:
//   - Holding gets showOnStorefront:true + eligible seller → upsert
//   - Holding gets showOnStorefront:false → delete
//   - Holding fields change (grade, fmv, photos, identity) → upsert
//   - Seller loses eligibility (plan downgrade, unverify email) → cascade-delete
//     (Cascade handled by admin sweep, not per-write.)

import { CosmosClient, type Container } from "@azure/cosmos";

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  _container = db.container("marketplace_listings");
  return _container;
}

export interface SellerEligibility {
  userId: string;
  username: string | null;
  plan: string;
  publicShareEnabled: boolean;
  emailVerified: boolean;
}

export function isSellerEligible(s: SellerEligibility): boolean {
  if (!s.username) return false;
  if (!s.publicShareEnabled) return false;
  if (!s.emailVerified) return false;
  if (s.plan !== "pro_seller" && s.plan !== "investor") return false;
  return true;
}

// Extract the marketplace listing shape from a portfolio holding.
// Returns null if the holding lacks minimum identity/photos to list.
export function holdingToListing(
  seller: SellerEligibility,
  holding: Record<string, unknown>,
): Record<string, unknown> | null {
  const holdingId = String(holding.id ?? "");
  if (!holdingId) return null;
  if (holding.showOnStorefront !== true) return null;
  const photos = Array.isArray(holding.photos) ? (holding.photos as string[]) : [];
  const playerName = typeof holding.playerName === "string" ? holding.playerName : null;
  const cardTitle = typeof holding.cardTitle === "string" ? holding.cardTitle : null;
  const hasIdentity = !!playerName || !!cardTitle;
  const hasPhoto = photos.length > 0;
  if (!hasIdentity || !hasPhoto) return null;
  const year = typeof holding.cardYear === "number" ? holding.cardYear : null;
  const setName = typeof holding.setName === "string" ? holding.setName
                : typeof holding.product === "string" ? holding.product : null;
  const parallel = typeof holding.parallel === "string" ? holding.parallel : null;
  const cardNumber = typeof holding.cardNumber === "string" ? holding.cardNumber : null;
  const gradeCompany = typeof holding.gradeCompany === "string" ? holding.gradeCompany : null;
  const gradeValue = typeof holding.gradeValue === "number" ? holding.gradeValue : null;
  const isAuto = holding.isAuto === true;
  const printRun = typeof holding.printRun === "number" ? holding.printRun : null;
  const hobbyiqCardId = typeof holding.hobbyiqCardId === "string" ? holding.hobbyiqCardId : null;
  const fmv = typeof holding.fairMarketValue === "number" && holding.fairMarketValue > 0
    ? holding.fairMarketValue
    : typeof holding.estimatedValue === "number" && (holding.estimatedValue as number) > 0
      ? (holding.estimatedValue as number) : null;
  const derivedTitle = cardTitle ?? [year, setName, parallel, playerName].filter(Boolean).join(" ").trim();

  // Search tokens: player + set + card number + year + grade + parallel + isAuto flag
  const tokens = new Set<string>();
  if (playerName) playerName.toLowerCase().split(/\s+/).forEach((t) => t && tokens.add(t));
  if (setName) setName.toLowerCase().split(/\s+/).forEach((t) => t && tokens.add(t));
  if (parallel) parallel.toLowerCase().split(/\s+/).forEach((t) => t && tokens.add(t));
  if (cardNumber) {
    tokens.add(cardNumber.toLowerCase());
    cardNumber.toLowerCase().split(/[-\s]+/).forEach((t) => t && tokens.add(t));
  }
  if (year) tokens.add(String(year));
  if (gradeCompany) tokens.add(gradeCompany.toLowerCase());
  if (gradeValue != null) tokens.add(String(gradeValue));
  if (isAuto) tokens.add("auto");
  if (hobbyiqCardId) tokens.add(hobbyiqCardId);

  return {
    id: `listing::${seller.userId}::${holdingId}`,
    sellerId: seller.userId,
    sellerUsername: seller.username,
    sellerPlan: seller.plan,
    holdingId,
    hobbyiqCardId,
    cardTitle: derivedTitle,
    playerName,
    year,
    setName,
    parallel,
    cardNumber,
    gradeCompany,
    gradeValue,
    isAuto,
    printRun,
    fmv,
    imageUrl: photos[0] ?? null,
    photos,
    searchTokens: [...tokens],
    addedToStorefrontAt: typeof holding.storefrontAddedAt === "string" ? holding.storefrontAddedAt : new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Upsert a listing row for a holding if the seller is eligible and
 * the holding is opted-in. Silent no-op otherwise.
 */
export async function syncListingForHolding(
  seller: SellerEligibility,
  holding: Record<string, unknown>,
): Promise<{ action: "upserted" | "deleted" | "skipped"; reason?: string }> {
  const container = await getContainer();
  if (!container) return { action: "skipped", reason: "no-cosmos" };
  const holdingId = String(holding.id ?? "");
  if (!holdingId) return { action: "skipped", reason: "no-holding-id" };
  const listingId = `listing::${seller.userId}::${holdingId}`;

  const eligible = isSellerEligible(seller);
  const optedIn = holding.showOnStorefront === true;

  if (!eligible || !optedIn) {
    // Delete any stale listing (idempotent — no error if absent)
    try {
      await container.item(listingId, seller.userId).delete();
      return { action: "deleted", reason: eligible ? "not-opted-in" : "seller-ineligible" };
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 404) return { action: "skipped", reason: "already-absent" };
      // Log but don't throw — write hook must never fail the parent operation
      console.warn(JSON.stringify({
        event: "marketplace_listing_delete_error",
        source: "marketplaceListingsStore.service",
        listingId, error: (err as Error)?.message?.slice(0, 200),
      }));
      return { action: "skipped", reason: "delete-error" };
    }
  }

  const listing = holdingToListing(seller, holding);
  if (!listing) return { action: "skipped", reason: "missing-identity-or-photo" };
  try {
    await container.items.upsert(listing);
    return { action: "upserted" };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "marketplace_listing_upsert_error",
      source: "marketplaceListingsStore.service",
      listingId, error: (err as Error)?.message?.slice(0, 200),
    }));
    return { action: "skipped", reason: "upsert-error" };
  }
}

export interface MarketplaceSearchInput {
  q?: string;              // free-text tokens (space-separated)
  year?: number;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: number;
  isAuto?: boolean;
  priceMin?: number;
  priceMax?: number;
  sellerId?: string;
  limit?: number;
  offset?: number;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  sellerUsername: string | null;
  sellerPlan: string;
  holdingId: string;
  hobbyiqCardId: string | null;
  cardTitle: string;
  playerName: string | null;
  year: number | null;
  setName: string | null;
  parallel: string | null;
  cardNumber: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  isAuto: boolean;
  printRun: number | null;
  fmv: number | null;
  imageUrl: string | null;
  photos: string[];
  addedToStorefrontAt: string;
}

/**
 * Cross-partition search across marketplace listings. Returns raw
 * listings; caller (search route) can group by seller if desired.
 */
export async function searchListings(
  input: MarketplaceSearchInput,
): Promise<MarketplaceListing[]> {
  const container = await getContainer();
  if (!container) return [];
  const tokens = String(input.q ?? "").toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const params: Array<{ name: string; value: string | number | boolean }> = [];
  const clauses: string[] = [];
  tokens.forEach((t, i) => {
    const p = `@t${i}`;
    clauses.push(`ARRAY_CONTAINS(c.searchTokens, ${p})`);
    params.push({ name: p, value: t });
  });
  if (input.year !== undefined) {
    clauses.push("c.year = @year");
    params.push({ name: "@year", value: input.year });
  }
  if (input.parallel) {
    clauses.push("LOWER(c.parallel) = @par");
    params.push({ name: "@par", value: input.parallel.toLowerCase() });
  }
  if (input.gradeCompany) {
    clauses.push("c.gradeCompany = @gc");
    params.push({ name: "@gc", value: input.gradeCompany });
  }
  if (input.gradeValue !== undefined) {
    clauses.push("c.gradeValue = @gv");
    params.push({ name: "@gv", value: input.gradeValue });
  }
  if (input.isAuto === true) clauses.push("c.isAuto = true");
  if (input.isAuto === false) clauses.push("c.isAuto = false");
  if (input.priceMin !== undefined) {
    clauses.push("c.fmv >= @pmin");
    params.push({ name: "@pmin", value: input.priceMin });
  }
  if (input.priceMax !== undefined) {
    clauses.push("c.fmv <= @pmax");
    params.push({ name: "@pmax", value: input.priceMax });
  }
  if (input.sellerId) {
    clauses.push("c.sellerId = @sid");
    params.push({ name: "@sid", value: input.sellerId });
  }
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const query = `SELECT TOP ${limit} c.id, c.sellerId, c.sellerUsername, c.sellerPlan, c.holdingId, c.hobbyiqCardId, c.cardTitle, c.playerName, c.year, c.setName, c.parallel, c.cardNumber, c.gradeCompany, c.gradeValue, c.isAuto, c.printRun, c.fmv, c.imageUrl, c.photos, c.addedToStorefrontAt FROM c ${where}`;
  const { resources } = await container.items.query<MarketplaceListing>({ query, parameters: params }).fetchAll();
  return resources;
}

/**
 * Cascade-delete all listings for a seller (used when their
 * eligibility changes: plan downgrade, publicShareEnabled off,
 * email unverified, account deletion).
 */
export async function deleteAllListingsForSeller(sellerId: string): Promise<{ deleted: number }> {
  const container = await getContainer();
  if (!container) return { deleted: 0 };
  const { resources } = await container.items.query<{ id: string }>({
    query: "SELECT c.id FROM c WHERE c.sellerId = @sid",
    parameters: [{ name: "@sid", value: sellerId }],
  }).fetchAll();
  let deleted = 0;
  for (const r of resources) {
    try {
      await container.item(r.id, sellerId).delete();
      deleted++;
    } catch { /* skip */ }
  }
  return { deleted };
}
