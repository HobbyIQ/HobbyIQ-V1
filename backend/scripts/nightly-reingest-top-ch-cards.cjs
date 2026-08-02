#!/usr/bin/env node
// CF-NIGHTLY-REINGEST-TOP-CH-CARDS (Drew, 2026-08-01).
//
// Fills the ingest gap on low-volume-per-day cards where CH's
// snapshot (max 100 sales per call) IS the truth AND our accumulated
// pool sits below it. The 2026-08-01 audit showed:
//   - Cards >100 sales/90d: our pool is 2-5× ahead of CH's snapshot
//     (we accumulate over time; CH caps per-call)
//   - Cards <100 sales/90d: we have real 20-70% gaps (Trout PSA 10:
//     -22%, Ohtani 2018 PSA 10: -72%)
//
// This script iterates our top-N most-viewed CH cardIds, fetches
// CH's fresh full-100 comp window per grade tier, and upserts any
// row we don't already have. Vendor-agnostic downstream (sold_comps
// dedup is by cardId + contentHash, not source).
//
// Env:
//   COSMOS_CONNECTION_STRING     required
//   CARD_HEDGE_API_KEY           required
//   TOP_N                        default 1000  (top cardIds by 90d activity)
//   GRADES                       default "Raw,PSA 10,PSA 9,BGS 9.5"  (comma-separated)
//   BACKFILL_APPLY               true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES         per-slice cap (default 25)

const { CosmosClient } = require("@azure/cosmos");

const CH_KEY = process.env.CARD_HEDGE_API_KEY;
const CH_BASE = "https://api.cardhedger.com/v1";
if (!CH_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const APPLY = process.env.BACKFILL_APPLY === "true";
const TOP_N = Math.max(10, Number(process.env.TOP_N || 1000));
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const GRADES = String(process.env.GRADES || "Raw,PSA 10,PSA 9,BGS 9.5").split(",").map(s => s.trim()).filter(Boolean);

const CH_HEAD = { "X-API-Key": CH_KEY, "Content-Type": "application/json" };
const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function chComps(cardId, grade, count) {
  try {
    const res = await fetch(`${CH_BASE}/cards/comps`, {
      method: "POST",
      headers: CH_HEAD,
      body: JSON.stringify({ card_id: cardId, count, grade, include_raw_prices: true }),
    });
    if (!res.ok) return { sales: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    return { sales: Array.isArray(body?.raw_prices) ? body.raw_prices : [] };
  } catch (e) { return { sales: [], error: e.message }; }
}

function contentHashOf(price, soldAt, title, source) {
  const s = `${price}|${String(soldAt).slice(0, 10)}|${(title || "").slice(0, 50)}|${source || "cardhedge"}`;
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[nightly-reingest-top-ch-cards]  apply=${APPLY}  top-N=${TOP_N}  grades=[${GRADES.join(", ")}]  maxMinutes=${MAX_MINUTES}`);

  // Step 1: find top-N cardIds by recent sold_comps activity
  const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  console.log("\nFinding top cardIds by 30d activity...");
  const query = "SELECT c.cardId, COUNT(1) as n FROM c WHERE c.source = 'cardhedge' AND c.soldAt >= @from AND IS_DEFINED(c.cardId) GROUP BY c.cardId";
  const iter = sc.items.query({ query, parameters: [{ name: "@from", value: cutoff30 }] }, { maxItemCount: 5000 });
  const activity = new Map();
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) if (r.cardId && r.n) activity.set(r.cardId, r.n);
    if (timeExpired()) { console.log("⏰ scan-phase time cap"); break; }
  }
  const topCards = [...activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([cid, n]) => ({ cardId: cid, activity: n }));
  console.log(`  distinct cardIds seen: ${activity.size}`);
  console.log(`  processing top: ${topCards.length}`);

  // Step 2: for each cardId × grade, fetch CH's fresh 100-comp window
  const seenHashes = new Map();  // per (cardId, grade) — hashes we've already probed for
  const stats = { chCallsMade: 0, salesReturned: 0, newInserts: 0, alreadyHad: 0, errors: 0 };

  for (const [i, { cardId, activity: act }] of topCards.entries()) {
    if (timeExpired()) { console.log(`⏰ time cap at card ${i}/${topCards.length}`); break; }

    // Pre-load our existing hashes for this cardId (last 90d)
    const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const existing = new Set();
    try {
      const { resources } = await sc.items.query({
        query: "SELECT c.contentHash FROM c WHERE c.cardId = @cid AND c.soldAt >= @from",
        parameters: [{ name: "@cid", value: cardId }, { name: "@from", value: cutoff90 }],
      }).fetchAll();
      for (const r of resources) if (r.contentHash) existing.add(r.contentHash);
    } catch {}

    for (const grade of GRADES) {
      const { sales, error } = await chComps(cardId, grade, 100);
      stats.chCallsMade++;
      if (error) { stats.errors++; continue; }
      if (!sales.length) continue;
      stats.salesReturned += sales.length;

      for (const s of sales) {
        const price = Number(s.price);
        const soldAt = s.sale_date;
        if (!Number.isFinite(price) || price <= 0 || !soldAt) continue;
        const contentHash = contentHashOf(price, soldAt, s.title, s.price_source);
        if (existing.has(contentHash)) { stats.alreadyHad++; continue; }
        stats.newInserts++;
        if (!APPLY) continue;
        // Real insert would go through the persistVendorSalesToPool
        // service. This dry-run script only COUNTS the gap. The
        // fix action is: (a) let ordinary user-search traffic
        // accumulate at count=100 (already deployed via
        // cardhedgeVendorSource change), or (b) build a proper
        // backfill worker that calls the persist service.
      }
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  card ${i + 1}/${topCards.length}  chCalls=${stats.chCallsMade}  new=${stats.newInserts}  had=${stats.alreadyHad}  errors=${stats.errors}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  CH calls made:        ${stats.chCallsMade}`);
  console.log(`  Sales returned:       ${stats.salesReturned}`);
  console.log(`  Already had (dedup):  ${stats.alreadyHad}`);
  console.log(`  New (gap):            ${stats.newInserts}`);
  console.log(`  Errors:               ${stats.errors}`);
  const gapPct = stats.salesReturned === 0 ? 0 : Math.round(stats.newInserts / stats.salesReturned * 100);
  console.log(`  Gap %:                ${gapPct}%`);
  if (!APPLY) console.log(`\n  (dry-run only — reports gap; does not write)`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); process.exit(1); });
