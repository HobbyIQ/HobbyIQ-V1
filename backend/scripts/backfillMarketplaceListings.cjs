// CF-MARKETPLACE-BACKFILL (Drew, 2026-08-10).
// One-time + nightly refresh: rebuild the marketplace_listings container
// from every eligible seller's opted-in storefront cards.
//
// Rules mirror src/services/marketplace/marketplaceListingsStore.service.ts
// and src/routes/publicSeller.routes.ts so the materialized index stays
// aligned with what /u/:username actually renders:
//   1. Seller eligible: effectivePlan in [pro_seller, investor]
//                      AND publicShareEnabled === true
//                      AND emailVerification.verifiedAt present
//                      AND username present
//   2. Holding opted-in: showOnStorefront === true
//                      AND has at least one photo
//                      AND has playerName or cardTitle
//
// Behavior:
//   - Upsert every listing that survives both filters
//   - Delete any stale listing in the container that no longer qualifies
//     (seller lost eligibility, or holding toggled off / was deleted)
//   - Env DRY_RUN=true prints plan only; no writes
//   - Env FRESH=true cascades a full delete before rebuild (dangerous)
//
// Usage:
//   node backend/scripts/backfillMarketplaceListings.cjs
//   DRY_RUN=true node backend/scripts/backfillMarketplaceListings.cjs
//   FRESH=true node backend/scripts/backfillMarketplaceListings.cjs

const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
const DRY_RUN = String(process.env.DRY_RUN ?? "").toLowerCase() === "true";
const FRESH = String(process.env.FRESH ?? "").toLowerCase() === "true";
const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const USERS_CONTAINER = process.env.COSMOS_USERS_CONTAINER || "users";
const PORTFOLIO_CONTAINER = process.env.COSMOS_PORTFOLIO_CONTAINER || "portfolio";
const LISTINGS_CONTAINER = "marketplace_listings";

if (!CONN) {
  console.error("COSMOS_CONNECTION_STRING required");
  process.exit(1);
}

const PLAN_ALIASES = { "all-star": "pro_seller", pro: "collector" };
function normalizePlan(raw) {
  if (raw === "free" || raw === "collector" || raw === "investor" || raw === "pro_seller") return raw;
  if (PLAN_ALIASES[raw]) return PLAN_ALIASES[raw];
  return "free";
}
function effectivePlan(user) {
  const override = user.entitlementOverride;
  if (override && ["free", "collector", "investor", "pro_seller"].includes(override)) return override;
  return normalizePlan(user.plan);
}
function isEligibleSeller(user) {
  const plan = effectivePlan(user);
  if (plan !== "pro_seller" && plan !== "investor") return false;
  if (user.publicShareEnabled !== true) return false;
  if (!user.emailVerification || !user.emailVerification.verifiedAt) return false;
  const username = user.aliases && user.aliases[0] ? user.aliases[0] : user.usernameLower;
  if (!username) return false;
  return true;
}

function holdingToListing(seller, holding) {
  const holdingId = String(holding.id || "");
  if (!holdingId) return null;
  if (holding.showOnStorefront !== true) return null;
  const photos = Array.isArray(holding.photos) ? holding.photos : [];
  const playerName = typeof holding.playerName === "string" ? holding.playerName : null;
  const cardTitle = typeof holding.cardTitle === "string" ? holding.cardTitle : null;
  if (!playerName && !cardTitle) return null;
  if (photos.length === 0) return null;
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
    : typeof holding.estimatedValue === "number" && holding.estimatedValue > 0
      ? holding.estimatedValue : null;
  const derivedTitle = cardTitle || [year, setName, parallel, playerName].filter(Boolean).join(" ").trim();
  const tokens = new Set();
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
    imageUrl: photos[0] || null,
    photos,
    searchTokens: Array.from(tokens),
    addedToStorefrontAt: typeof holding.storefrontAddedAt === "string" ? holding.storefrontAddedAt : new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function fetchEligibleSellers(usersC) {
  console.log("[scan] querying eligible sellers (publicShareEnabled + verified email + investor/pro_seller)");
  const query = {
    query: `SELECT c.id, c.userId, c.email, c.plan, c.entitlementOverride, c.publicShareEnabled,
                   c.emailVerification, c.aliases, c.usernameLower
            FROM c
            WHERE c.docType = "user"
              AND c.publicShareEnabled = true`,
  };
  const { resources } = await usersC.items.query(query).fetchAll();
  const eligible = [];
  for (const u of resources) {
    if (!isEligibleSeller(u)) continue;
    const username = u.aliases && u.aliases[0] ? u.aliases[0] : u.usernameLower;
    eligible.push({
      userId: u.userId || u.id,
      username,
      plan: effectivePlan(u),
    });
  }
  return eligible;
}

async function loadPortfolio(portfolioC, userId) {
  try {
    const { resource } = await portfolioC.item(userId, userId).read();
    return resource;
  } catch (err) {
    if (err && err.code === 404) return null;
    console.warn(`[portfolio-read-error] ${userId}: ${err && err.message}`);
    return null;
  }
}

async function main() {
  const client = new CosmosClient(CONN);
  const db = client.database(DB_NAME);
  const usersC = db.container(USERS_CONTAINER);
  const portfolioC = db.container(PORTFOLIO_CONTAINER);
  const listingsC = db.container(LISTINGS_CONTAINER);

  const t0 = Date.now();

  if (FRESH && !DRY_RUN) {
    console.log("[FRESH] cascading full delete of marketplace_listings before rebuild");
    const { resources: all } = await listingsC.items.query({
      query: "SELECT c.id, c.sellerId FROM c",
    }).fetchAll();
    console.log(`[FRESH] deleting ${all.length} listings`);
    for (const r of all) {
      try { await listingsC.item(r.id, r.sellerId).delete(); } catch { /* skip */ }
    }
  }

  const sellers = await fetchEligibleSellers(usersC);
  console.log(`[scan] ${sellers.length} eligible sellers`);
  if (sellers.length === 0) {
    console.log("[done] nothing to backfill");
    return;
  }

  // Snapshot every existing listing so we can compute deletions
  const { resources: existing } = await listingsC.items.query({
    query: "SELECT c.id, c.sellerId FROM c",
  }).fetchAll();
  const existingKeys = new Set(existing.map((e) => `${e.sellerId}::${e.id}`));
  console.log(`[snapshot] ${existing.length} existing listings in container`);

  const plannedKeys = new Set();
  const plannedUpserts = [];
  let sellersWithCards = 0;
  let holdingsScanned = 0;
  let holdingsSkipped = 0;

  for (const seller of sellers) {
    const portfolio = await loadPortfolio(portfolioC, seller.userId);
    if (!portfolio || !portfolio.holdings) continue;
    const holdings = Object.values(portfolio.holdings);
    let cardsForSeller = 0;
    for (const h of holdings) {
      holdingsScanned++;
      const listing = holdingToListing(seller, h);
      if (!listing) { holdingsSkipped++; continue; }
      plannedKeys.add(`${listing.sellerId}::${listing.id}`);
      plannedUpserts.push(listing);
      cardsForSeller++;
    }
    if (cardsForSeller > 0) sellersWithCards++;
  }

  const toDelete = existing.filter((e) => !plannedKeys.has(`${e.sellerId}::${e.id}`));

  console.log("");
  console.log("[plan]");
  console.log(`  eligible sellers          : ${sellers.length}`);
  console.log(`  sellers with 1+ card      : ${sellersWithCards}`);
  console.log(`  holdings scanned          : ${holdingsScanned}`);
  console.log(`  holdings skipped          : ${holdingsSkipped} (opt-out, missing photo, or missing identity)`);
  console.log(`  upserts planned           : ${plannedUpserts.length}`);
  console.log(`  deletions planned (stale) : ${toDelete.length}`);
  console.log(`  existing listings         : ${existing.length}`);

  if (DRY_RUN) {
    console.log("");
    console.log("[DRY_RUN] no writes issued. Set DRY_RUN=false to apply.");
    if (plannedUpserts.length > 0) {
      console.log("");
      console.log("[sample upserts]");
      for (const l of plannedUpserts.slice(0, 5)) {
        console.log(`  ${l.sellerUsername} :: ${l.cardTitle.slice(0, 80)} (fmv=${l.fmv})`);
      }
    }
    return;
  }

  console.log("");
  console.log("[apply] writing…");
  let upserted = 0, upsertFailed = 0, deleted = 0, deleteFailed = 0;
  const BATCH_LOG = 100;
  for (const listing of plannedUpserts) {
    try {
      await listingsC.items.upsert(listing);
      upserted++;
      if (upserted % BATCH_LOG === 0) console.log(`  upserted ${upserted}/${plannedUpserts.length}`);
    } catch (err) {
      upsertFailed++;
      console.warn(`  upsert-fail ${listing.id}: ${err && err.message}`);
    }
  }
  for (const stale of toDelete) {
    try {
      await listingsC.item(stale.id, stale.sellerId).delete();
      deleted++;
      if (deleted % BATCH_LOG === 0) console.log(`  deleted ${deleted}/${toDelete.length}`);
    } catch (err) {
      const code = err && err.code;
      if (code === 404) { deleted++; continue; }
      deleteFailed++;
      console.warn(`  delete-fail ${stale.id}: ${err && err.message}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  console.log(`  upserted        : ${upserted}`);
  console.log(`  upsert-failed   : ${upsertFailed}`);
  console.log(`  deleted (stale) : ${deleted}`);
  console.log(`  delete-failed   : ${deleteFailed}`);
  console.log(`  elapsed         : ${elapsed}s`);
}

main().catch((e) => {
  console.error("[FATAL]", e && e.stack ? e.stack : e);
  process.exit(1);
});
