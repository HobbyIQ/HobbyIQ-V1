// CF-USER-EBAY-PURCHASE-BACKFILL (Drew, 2026-08-08). Scans every
// portfolio holding for purchaseSource matching /^ebay/i +
// purchasePrice + purchaseDate. For each qualifying holding, writes a
// sold_comps row via recordSoldComp so the historical eBay purchases
// (Add Card modal with eBay source) that missed the write flow now
// participate as real market data. Idempotent via
// sourceExternalId=`holding::<id>` dedup key.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 write comps (else dry-run count only)
//   USER_FILTER                optional userId — scope to one account
//   MAX_MINUTES                default 60
//   BATCH_SIZE                 default 500 portfolios per query page

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY       = process.env.APPLY === "true";
const USER_FILTER = process.env.USER_FILTER || null;
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 60));
const BATCH_SIZE  = Math.max(50, Number(process.env.BATCH_SIZE || 500));

function loadRecordSoldComp() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "soldCompsStore.service.js");
  if (!fs.existsSync(p)) throw new Error(`soldCompsStore helper not found at ${p} — run \`npm run build\` first`);
  return require(p).recordSoldComp;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const portfolio = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("portfolio");
  const recordSoldComp = APPLY ? loadRecordSoldComp() : null;

  console.log(`[user-ebay-backfill] apply=${APPLY} userFilter=${USER_FILTER || "*"} maxMin=${MAX_MINUTES} batch=${BATCH_SIZE}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Query all portfolio docs (or scoped to USER_FILTER)
  const params = [];
  let filter = "true";
  if (USER_FILTER) { filter = "c.userId = @u"; params.push({ name: "@u", value: USER_FILTER }); }
  const q = {
    query: `SELECT c.userId, c.holdings FROM c WHERE ${filter}`,
    parameters: params,
  };
  const iter = portfolio.items.query(q, { maxItemCount: BATCH_SIZE });

  let usersScanned = 0;
  let holdingsScanned = 0;
  let qualifying = 0;
  let written = 0;
  let errored = 0;
  const errSamples = [];

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn(`[backfill] time cap reached`); break; }
    const { resources } = await iter.fetchNext();
    for (const doc of resources) {
      usersScanned++;
      const rawHoldings = doc.holdings || {};
      const holdings = Array.isArray(rawHoldings) ? rawHoldings : Object.values(rawHoldings);
      for (const h of holdings) {
        holdingsScanned++;
        const src = String(h.purchaseSource ?? "").trim();
        if (!src || !/^ebay/i.test(src)) continue;
        const price = Number(h.purchasePrice ?? NaN);
        if (!Number.isFinite(price) || price <= 0) continue;
        const purchaseDate = String(h.purchaseDate ?? "").trim();
        if (!purchaseDate) continue;
        const cardId = String(h.cardId ?? "").trim();
        const playerName = String(h.playerName ?? "").trim();
        if (!cardId || !playerName) continue;
        qualifying++;

        if (!APPLY) {
          if (written < 8) console.log(`  [dry] ${doc.userId?.slice(0, 20)} · ${playerName} #${h.cardNumber || "?"} ${h.gradeCompany || "Raw"} ${h.gradeValue || ""} $${price} · ${src}`);
          written++;
          continue;
        }
        try {
          const soldAt = purchaseDate.includes("T") ? purchaseDate : `${purchaseDate}T00:00:00Z`;
          await recordSoldComp({
            cardId,
            playerName,
            cardYear: h.cardYear ?? null,
            setName: h.setName ?? null,
            parallel: h.parallel ?? null,
            cardNumber: h.cardNumber ?? null,
            isAuto: h.isAuto === true,
            gradeCompany: h.gradeCompany ?? null,
            gradeValue: h.gradeValue ?? null,
            price,
            soldAt,
            source: "ebay-user-purchase",
            sourceExternalId: h.ebayItemId ?? `holding::${h.id}`,
            contributorUserId: doc.userId,
            title: h.cardTitle ?? null,
            imageUrl: (Array.isArray(h.photos) ? h.photos[0] : h.photos) ?? null,
            sellerHandle: src.includes(":") ? src.split(":").slice(1).join(":").trim() || null : null,
            verifiedByUser: true,
            confidence: 1.0,
          });
          written++;
          if (written % 100 === 0) console.log(`  [progress] written=${written} qualifying=${qualifying} errored=${errored}`);
        } catch (err) {
          errored++;
          if (errSamples.length < 8) errSamples.push({ holdingId: h.id, error: err?.message?.slice(0, 100) });
        }
      }
    }
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("\n=== BACKFILL SUMMARY ===");
  console.log(`apply           : ${APPLY}`);
  console.log(`users scanned   : ${usersScanned}`);
  console.log(`holdings scanned: ${holdingsScanned}`);
  console.log(`qualifying      : ${qualifying}`);
  console.log(`written (or would-write in dry): ${written}`);
  console.log(`errored         : ${errored}`);
  console.log(`elapsed         : ${elapsed}s`);
  if (errSamples.length > 0) {
    console.log("\nError samples:");
    for (const e of errSamples) console.log(`  ${e.holdingId}: ${e.error}`);
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
