/* Compare observedGradeCurve vs computeUnifiedPrice for the Ohtani PSA 9
 * holding — see WHY $2,482 vs $2,610. Check window, sample counts,
 * price range on each side. */
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");
  const sold = db.container("sold_comps");

  // Find Drew's 2018 Bowman Chrome Ohtani #1 PSA 9 holding
  const { resources: users } = await portfolio.items.query({
    query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)",
  }, { enableCrossPartitionQuery: true }).fetchAll();

  let cardId = null, hobbyiqCardId = null;
  for (const u of users) {
    for (const [hid, h] of Object.entries(u.holdings || {})) {
      const title = String(h.cardTitle || "").toLowerCase();
      const player = String(h.playerName || "").toLowerCase();
      const num = String(h.cardNumber || "");
      const yr = h.cardYear;
      if (yr === 2018 && (player.includes("ohtani") || title.includes("ohtani")) && (num === "1" || title.includes("#1"))) {
        console.log(`user=${u.userId} holding=${hid}`);
        console.log(`  cardId=${h.cardId}`);
        console.log(`  hobbyiqCardId=${h.hobbyiqCardId}`);
        console.log(`  parallel=${h.parallel} grade=${h.gradeCompany} ${h.gradeValue}`);
        console.log(`  fairMarketValue=${h.fairMarketValue}`);
        cardId = h.cardId;
        hobbyiqCardId = h.hobbyiqCardId;
        break;
      }
    }
    if (cardId) break;
  }
  if (!cardId) { console.log("Ohtani not found"); return; }

  // Query all PSA 9 sales in sold_comps for this cardId, various windows.
  console.log("\n=== ALL PSA 9 sales for cardId ===");
  const { resources: all } = await sold.items.query({
    query: "SELECT c.price, c.soldAt, c.parallel, c.contributorUserId, c.source, c.priceAnomaly FROM c WHERE c.cardId = @cid AND c.gradeCompany = 'PSA' AND c.gradeValue = 9 AND c.price > 0",
    parameters: [{ name: "@cid", value: cardId }],
  }, { partitionKey: cardId }).fetchAll();
  console.log(`  ${all.length} total PSA 9 sales`);

  const now = Date.now();
  for (const days of [30, 60, 90, 180, 365, 9999]) {
    const cutoff = now - days * 86400_000;
    const window = all.filter(r => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t >= cutoff;
    });
    const priced = window.filter(r => !r.priceAnomaly).map(r => Number(r.price)).sort((a, b) => a - b);
    const med = priced.length > 0 ? priced[Math.floor(priced.length / 2)] : null;

    // Weighted median (14d half-life) — same math as unifiedPricing
    const weighted = window.filter(r => !r.priceAnomaly).map(r => {
      const t = Date.parse(r.soldAt);
      const daysAgo = (now - t) / 86400_000;
      return { price: Number(r.price), w: Math.exp(-daysAgo / 14) };
    }).sort((a, b) => a.price - b.price);
    const tw = weighted.reduce((s, r) => s + r.w, 0);
    let wMed = null;
    if (tw > 0) {
      let cum = 0;
      for (const r of weighted) {
        cum += r.w;
        if (cum >= tw / 2) { wMed = r.price; break; }
      }
    }
    console.log(`  ${days === 9999 ? "ALL" : days + "d"}: n=${priced.length} median=$${med?.toFixed(0)} weightedMedian(14d)=$${wMed?.toFixed(0) ?? "-"}`);
  }

  // Non-anomaly count vs anomaly-flagged
  const anom = all.filter(r => r.priceAnomaly);
  console.log(`\n  Price-anomaly flagged: ${anom.length}`);

  // Contributor breakdown
  const drewContributed = all.filter(r => r.contributorUserId === "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4");
  console.log(`  Drew-contributed: ${drewContributed.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
