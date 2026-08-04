// CF-BUYERIQ-DEAL-SCANNER (Drew, 2026-08-03). Walks every BuyerIQ
// target (status='wanted') and checks live eBay listings against
// current FMV. When any listing lands below FMV × threshold, fire a
// push notification to the owner.
//
// Deduplication: sent notifications are tracked in a lightweight
// Cosmos container `buyeriq_deals_sent` keyed by (userId, targetId,
// listingId). Won't re-notify the same listing within the cooldown
// window (default 24h).
//
// eBay rate management: per-target Browse fetch is cached in
// ebayActiveListingsCache (12h TTL). This scanner reads the cache
// when fresh, hits Browse only when stale — same cache the iOS
// Active Listings tab already uses.
//
// Env:
//   BUYERIQ_DEAL_SCANNER_DISABLE            "true" to no-op
//   BUYERIQ_DEAL_THRESHOLD_PCT              0-1 (default 0.15 = 15% below FMV)
//   BUYERIQ_DEAL_COOLDOWN_HOURS             default 24 (no re-notify within window)
//   BUYERIQ_DEAL_MIN_FMV                    default 25 (skip cards < $25 FMV — too noisy)

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeCanonicalFmv } from "../compiq/canonicalFmv.service.js";
import { fetchCardActiveListings, type ActiveListing } from "../ebay/ebayListingSearch.service.js";
import { sendBuyerIqDealNotification } from "../notification.service.js";
import type { BuyerIqTarget } from "./buyeriqStore.service.js";

const DEAL_THRESHOLD_PCT = Math.max(0.02, Math.min(0.60, Number(process.env.BUYERIQ_DEAL_THRESHOLD_PCT ?? "0.15")));
const COOLDOWN_HOURS = Math.max(1, Number(process.env.BUYERIQ_DEAL_COOLDOWN_HOURS ?? "24"));
const MIN_FMV = Math.max(0, Number(process.env.BUYERIQ_DEAL_MIN_FMV ?? "25"));

// ── Sent-tracker container ────────────────────────────────────────────
interface DealSentDoc {
  id: string;                 // ${userId}::${targetId}::${listingId}
  userId: string;             // partition key
  targetId: string;
  listingId: string;
  fmvAtSend: number;
  listingPriceAtSend: number;
  dealPctAtSend: number;
  sentAt: string;
  ttl: number;                // Cosmos TTL — auto-expires with cooldown + 7 day pad
}

let _dealsSentContainer: Container | null = null;
async function getDealsSentContainer(): Promise<Container | null> {
  if (_dealsSentContainer) return _dealsSentContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const { container } = await db.containers.createIfNotExists({
      id: "buyeriq_deals_sent",
      partitionKey: { paths: ["/userId"] },
      defaultTtl: COOLDOWN_HOURS * 3600 + 7 * 86400,
    });
    _dealsSentContainer = container;
    return _dealsSentContainer;
  } catch { return null; }
}

async function alreadySentWithinCooldown(userId: string, targetId: string, listingId: string): Promise<boolean> {
  const cont = await getDealsSentContainer();
  if (!cont) return false;
  const id = `${userId}::${targetId}::${listingId}`;
  try {
    const { resource } = await cont.item(id, userId).read<DealSentDoc>();
    if (!resource) return false;
    const sentMs = Date.parse(resource.sentAt);
    if (!Number.isFinite(sentMs)) return false;
    return Date.now() - sentMs < COOLDOWN_HOURS * 3600 * 1000;
  } catch { return false; }
}

async function recordSent(userId: string, targetId: string, listingId: string, fmv: number, price: number, dealPct: number): Promise<void> {
  const cont = await getDealsSentContainer();
  if (!cont) return;
  const doc: DealSentDoc = {
    id: `${userId}::${targetId}::${listingId}`,
    userId, targetId, listingId,
    fmvAtSend: fmv,
    listingPriceAtSend: price,
    dealPctAtSend: dealPct,
    sentAt: new Date().toISOString(),
    ttl: COOLDOWN_HOURS * 3600 + 7 * 86400,
  };
  try { await cont.items.upsert(doc); } catch { /* soft */ }
}

// ── Target iteration ─────────────────────────────────────────────────
let _targetsContainer: Container | null = null;
async function getTargetsContainer(): Promise<Container | null> {
  if (_targetsContainer) return _targetsContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    _targetsContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("buyeriq_targets");
    return _targetsContainer;
  } catch { return null; }
}

async function listAllWantedTargets(): Promise<BuyerIqTarget[]> {
  const cont = await getTargetsContainer();
  if (!cont) return [];
  try {
    const { resources } = await cont.items
      .query<BuyerIqTarget>({
        query: "SELECT * FROM c WHERE c.docType = 'target' AND c.status = 'wanted'",
      }, { maxItemCount: 200 })
      .fetchAll();
    return resources || [];
  } catch { return []; }
}

// ── Deal detection per target ────────────────────────────────────────
export interface DealScannerSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  targetsScanned: number;
  targetsSkipped: number;
  listingsFetched: number;
  dealsFound: number;
  notificationsSent: number;
  notificationsSkippedDedup: number;
  notificationsFailed: number;
  errors: number;
}

function fmvOf(target: BuyerIqTarget) {
  // Reuse canonicalFmv rails. Build input from BuyerIQ target fields.
  return computeCanonicalFmv({
    cardId: target.hobbyiqCardId ?? `hiq:baseball:${target.cardYear ?? 2024}:${target.setName ?? "unknown"}:${target.cardNumber ?? "unknown"}:base:no-auto`,
    parallel: target.parallel ?? null,
    gradeCompany: target.gradeCompany ?? null,
    gradeValue: target.gradeValue ?? null,
    cardYear: target.cardYear ?? null,
    product: target.setName ?? null,
    player: target.playerName,
    cardNumber: target.cardNumber ?? null,
    isAuto: target.isAuto ?? null,
    freshCompute: false,
  });
}

function dealPct(listingPrice: number, fmv: number): number {
  if (!(fmv > 0) || !(listingPrice > 0)) return 0;
  return (fmv - listingPrice) / fmv;
}

function bestDealListing(listings: ActiveListing[], fmv: number, threshold: number): ActiveListing | null {
  let best: ActiveListing | null = null;
  let bestDealPct = threshold;
  for (const l of listings) {
    const d = dealPct(l.price, fmv);
    if (d > bestDealPct) {
      best = l;
      bestDealPct = d;
    }
  }
  return best;
}

export async function runBuyerIqDealScan(): Promise<DealScannerSummary> {
  const startedAt = new Date();
  const summary: DealScannerSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    targetsScanned: 0,
    targetsSkipped: 0,
    listingsFetched: 0,
    dealsFound: 0,
    notificationsSent: 0,
    notificationsSkippedDedup: 0,
    notificationsFailed: 0,
    errors: 0,
  };

  if (process.env.BUYERIQ_DEAL_SCANNER_DISABLE === "true") {
    console.log("[buyeriq.deal.scanner] disabled via env");
    return summary;
  }

  const targets = await listAllWantedTargets();
  console.log(`[buyeriq.deal.scanner] scanning ${targets.length} wanted targets (threshold=${DEAL_THRESHOLD_PCT * 100}% below FMV, min FMV $${MIN_FMV}, cooldown ${COOLDOWN_HOURS}h)`);

  for (const t of targets) {
    summary.targetsScanned++;
    if (!t.playerName) { summary.targetsSkipped++; continue; }
    try {
      // 1. FMV
      const fmvResult = await fmvOf(t);
      const fmv = fmvResult?.fmv ?? null;
      if (!fmv || fmv < MIN_FMV) {
        summary.targetsSkipped++;
        continue;
      }
      // 2. Active listings — reuse the ranked/filtered path iOS uses.
      const listingsResult = await fetchCardActiveListings({
        player: t.playerName,
        year: t.cardYear ?? undefined,
        set: t.setName ?? undefined,
        cardNumber: t.cardNumber ?? undefined,
        parallel: t.parallel ?? undefined,
        gradeCompany: t.gradeCompany ?? undefined,
        gradeValue: t.gradeValue ? String(t.gradeValue) : undefined,
      });
      const listings = listingsResult?.listings ?? [];
      summary.listingsFetched += listings.length;
      if (listings.length === 0) continue;
      // 3. Deal calc — best listing below threshold.
      // maxPrice trumps threshold when set (user's own cap wins).
      const effectiveThreshold = t.maxPrice && t.maxPrice > 0
        ? Math.max(DEAL_THRESHOLD_PCT, dealPct(t.maxPrice, fmv))
        : DEAL_THRESHOLD_PCT;
      const best = bestDealListing(listings, fmv, effectiveThreshold);
      if (!best) continue;
      summary.dealsFound++;
      // 4. Dedup
      if (await alreadySentWithinCooldown(t.userId, t.id, best.id)) {
        summary.notificationsSkippedDedup++;
        continue;
      }
      // 5. Send push
      const dealPctVal = dealPct(best.price, fmv);
      const title = `Deal on ${t.playerName}${t.gradeCompany ? ` ${t.gradeCompany} ${t.gradeValue ?? ""}` : ""}`;
      const body = `Listed at $${best.price.toFixed(2)} — ${(dealPctVal * 100).toFixed(0)}% below FMV of $${fmv.toFixed(0)}`;
      const push = await sendBuyerIqDealNotification(t.userId, {
        title, body,
        targetId: t.id,
        listingId: best.id,
        listingUrl: best.itemWebUrl,
        listingPrice: best.price,
        fmv,
        dealPct: dealPctVal,
      });
      if (push.sent > 0) {
        summary.notificationsSent++;
        await recordSent(t.userId, t.id, best.id, fmv, best.price, dealPctVal);
      } else {
        summary.notificationsFailed++;
      }
    } catch (err) {
      summary.errors++;
      console.warn(`[buyeriq.deal.scanner] target=${t.id} err: ${(err as Error)?.message ?? err}`);
    }
  }

  const finishedAt = new Date();
  summary.finishedAt = finishedAt.toISOString();
  summary.durationMs = finishedAt.getTime() - startedAt.getTime();
  console.log(JSON.stringify({ event: "buyeriq_deal_scan_summary", source: "buyerIqDealScanner.service", ...summary }));
  return summary;
}
